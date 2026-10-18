import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginProcess } from "@termix-ssh/plugin-sdk/backend";
import { getErrorMessage } from "../errors.js";
import { redact, redactString, REDACTED } from "../redaction.js";
import { createCapture, truncateMiddle, type ExecOutcome } from "./exec.js";

/**
 * The Termix CLI as an assistant tool. The published @termix-ssh/cli bundle
 * ships inside the plugin and runs as a child of the server's own Node, with
 * no shell, against core's local port, signed in as the user who sent the
 * message. Its config dir is a fresh temp folder, so it never reads or
 * writes a stored login.
 */

/** Where `npm run build` copies the CLI's bundle, next to backend.js. */
const CLI_FILE = "vendor/termix-cli.mjs";

/**
 * Core's HTTP server. It always listens here, in the same process and
 * container as this plugin, and serves every route nginx proxies.
 */
export const CORE_URL = "http://127.0.0.1:30001";

export function bundledCliPath(): string {
  return fileURLToPath(new URL(`./${CLI_FILE}`, import.meta.url));
}

/** The caller's session token, as core's auth middleware reads it. */
export function requestToken(req: {
  headers: Record<string, unknown>;
  cookies?: Record<string, unknown>;
}): string | null {
  const cookie = req.cookies?.jwt;
  if (typeof cookie === "string" && cookie) return cookie;
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

const RUN_COMMAND_HINT =
  "Use run_command for shell work on a host, or termix exec <hostId> <command>.";

/** Subcommands that need a terminal, stay running or log the CLI in. */
const BLOCKED: Record<string, { all?: true; sub?: string[]; why: string }> = {
  ssh: { all: true, why: `opens an interactive terminal. ${RUN_COMMAND_HINT}` },
  login: { all: true, why: "is not needed: you are already signed in." },
  logout: { all: true, why: "is not needed: you are already signed in." },
  tunnel: {
    sub: ["start"],
    why: "keeps a tunnel running in the foreground. Start tunnels from the Tunnels tab.",
  },
  files: {
    sub: ["get", "put"],
    why: "copies files to or from the Termix server's own disk. Use files cat, or run_command on the host.",
  },
  hosts: {
    sub: ["import", "export"],
    why: "reads a file on the Termix server's own disk, or prints decrypted credentials. Use hosts list and hosts get.",
  },
  "api-keys": {
    sub: ["create"],
    why: "prints a new key's token, which would leave Termix in the conversation. Create API keys in Settings.",
  },
};

/**
 * Subcommands that run a shell command on a host. Only users holding
 * ai.ops.use may have the assistant run them.
 */
const HOST_SHELL: Record<string, { all?: true; sub?: string[] }> = {
  exec: { all: true },
  fleets: { sub: ["exec"] },
  snippets: { sub: ["run"] },
};

/** The routes those subcommands call, so termix api cannot reach them either. */
const HOST_SHELL_PATH = /\/(execute|exec)(\/|\?|$)/i;

const HOST_SHELL_REFUSED =
  "You may not run commands on hosts: that needs the ai.ops.use permission, which an admin can grant.";

/**
 * Routes that return decrypted credentials, tokens or user data, which would
 * be sent to the model provider: exports, a credential by id (credentials get
 * prints it without the secrets), a host's password, a shared host's resolved
 * auth, the session token and the sync feed. The CLI takes paths with or
 * without the leading slash.
 */
const SECRET_PATH =
  /(^|\/)(export|password|local-connection-auth|me\/token|sync\/v2\/changes)([/?]|$)|(^|\/)credentials\/(?!folders\b)[^/?]+\/?(\?|$)/i;

/** Set by the tool itself, or reach the Termix server's own disk. */
function blockedFlag(arg: string): string | null {
  const name = arg.split("=")[0];
  if (["--url", "--api-key", "--insecure"].includes(name)) {
    return `${name} is set by the tool: the CLI already talks to this Termix as you.`;
  }
  if (
    name === "--output" ||
    name === "--password-stdin" ||
    /^--[\w-]*-file$/.test(name)
  ) {
    return `${name} reads or writes the Termix server's own disk. Pass the content inline instead.`;
  }
  return null;
}

/**
 * Why `args` may not run, or null when they may. Help always may. Without
 * `hostShell`, anything that runs a shell command on a host is refused too.
 */
export function checkCliArgs(
  args: string[],
  hostShell: boolean,
): string | null {
  if (!args.length) return 'args is empty. Try ["--help"].';

  for (const arg of args) {
    const problem = blockedFlag(arg);
    if (problem) return problem;
  }

  const [group, sub] = args.filter((arg) => !arg.startsWith("-"));
  const help =
    group === "help" || args.includes("--help") || args.includes("-h");
  if (group === "api" && !help && args.some((arg) => SECRET_PATH.test(arg))) {
    return "termix api cannot call routes that return secrets (exports, a credential by id, passwords, tokens, the sync feed). Use credentials get or hosts get instead.";
  }
  if (help) return null;
  const matches = (rule?: { all?: true; sub?: string[] }) =>
    Boolean(rule && (rule.all || (sub && rule.sub?.includes(sub))));
  const rule = BLOCKED[group];
  if (matches(rule)) {
    return `termix ${rule.all ? group : `${group} ${sub}`} ${rule.why}`;
  }
  if (hostShell) return null;
  const shellApi =
    group === "api" && args.some((arg) => HOST_SHELL_PATH.test(arg));
  return matches(HOST_SHELL[group]) || shellApi ? HOST_SHELL_REFUSED : null;
}

/**
 * The subcommands that only read, for work nobody watches. The command
 * words must come first, before any flag, so no flag can take one of them
 * as its value and leave the CLI running a different command.
 */
const READ_ONLY = new Map<string, true | string[]>([
  ["status", true],
  ["version", true],
  ["whoami", true],
  ["audit-logs", true],
  ["hosts", ["list", "get"]],
  ["credentials", ["list", "get"]],
  ["fleets", ["list", "members"]],
  ["snippets", ["list"]],
  ["alerts", ["list"]],
  ["sessions", ["list"]],
  ["users", ["list"]],
  ["api-keys", ["list"]],
  ["plugins", ["list"]],
  ["tunnel", ["list", "show"]],
  ["docker", ["ps"]],
]);

/** The read-only commands, for a tool description. */
export const READ_ONLY_CLI_SUMMARY = [
  ...[...READ_ONLY].map(([group, subs]) =>
    subs === true ? group : subs.map((sub) => `${group} ${sub}`).join(", "),
  ),
  "api GET <path>",
].join(", ");

/**
 * Why `args` are not a read-only command, or null when they are. Help is
 * read-only. checkCliArgs still applies on top.
 */
export function checkReadOnlyCliArgs(args: string[]): string | null {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    return null;
  }
  const [group = "", sub = ""] = args;
  const rule = READ_ONLY.get(group);
  if (group === "api") {
    return sub.toUpperCase() === "GET"
      ? null
      : "termix api may only send GET requests here";
  }
  if (rule === true || rule?.includes(sub)) return null;
  return `termix ${[group, sub].filter(Boolean).join(" ")} is not a read-only command. Read-only commands are: ${READ_ONLY_CLI_SUMMARY}`;
}

const SECRET_FLAG = /^--[\w-]*(password|passphrase|secret|token|key)$/i;
const DATA_FLAG = new Set(["-d", "--data"]);

/** A request body with its secret fields masked, or the text masked. */
function redactData(value: string): string {
  try {
    return JSON.stringify(redact(JSON.parse(value)));
  } catch {
    return redactString(value);
  }
}

/** Args as they may be stored: secret flag values and bodies masked. */
export function redactCliArgs(args: string[]): string[] {
  const out: string[] = [];
  let mask: ((value: string) => string) | null = null;
  for (const arg of args) {
    if (mask) {
      out.push(mask(arg));
      mask = null;
      continue;
    }
    const [name, ...rest] = arg.split("=");
    const masker = SECRET_FLAG.test(name)
      ? () => REDACTED
      : DATA_FLAG.has(name)
        ? redactData
        : null;
    if (masker && rest.length) out.push(`${name}=${masker(rest.join("="))}`);
    else out.push(redactString(arg));
    if (masker && !rest.length) mask = masker;
  }
  return out;
}

export interface CliLimits {
  timeoutMs: number;
  outputLimit: number;
  signal: AbortSignal;
}

/** Above this much stdout, output is cut while it streams instead of parsed. */
const MAX_PARSED_STDOUT = 4_000_000;

/** JSON on one line, so a listing fits far more rows in the same limit. */
export function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

/**
 * Keeps stdout whole up to MAX_PARSED_STDOUT so JSON can be compacted before
 * it is cut; past that it falls back to a streaming head and tail.
 */
function collectStdout(limit: number) {
  let raw = "";
  let streamed: ReturnType<typeof createCapture> | null = null;
  return {
    push(chunk: string) {
      if (streamed) return streamed.push(chunk);
      if (raw.length + chunk.length <= MAX_PARSED_STDOUT) {
        raw += chunk;
        return;
      }
      streamed = createCapture(limit);
      streamed.push(raw + chunk);
      raw = "";
    },
    text(): string {
      return streamed
        ? streamed.text()
        : truncateMiddle(compactJson(raw.trim()), limit);
    },
  };
}

function joinOutput(stdout: string, stderr: string): string {
  return stderr ? `${stdout}${stdout ? "\n" : ""}${stderr}` : stdout;
}

export interface CliTarget {
  run: PluginProcess["run"];
  cliPath: string;
  url: string;
  /**
   * The session token to sign in with, asked for on every run so a task can
   * mint a short-lived one each time. Only ever passed in the CLI's env.
   */
  token: () => Promise<string>;
}

/**
 * Runs the CLI once. JSON output is forced, color is off, and HOME and the
 * config dirs point at a temp folder removed afterwards.
 */
export async function runCli(
  target: CliTarget,
  args: string[],
  limits: CliLimits,
): Promise<ExecOutcome> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  if (limits.signal.aborted) {
    return { exitCode: null, output: "", durationMs: 0, aborted: true };
  }

  const home = await mkdtemp(path.join(os.tmpdir(), "termix-ai-cli-"));
  try {
    const token = await target.token();
    const child = await target.run(
      process.execPath,
      [target.cliPath, "--json", "--no-color", ...args],
      {
        cwd: home,
        env: {
          TERMIX_URL: target.url,
          TERMIX_TOKEN: token,
          NO_COLOR: "1",
          TERM: "dumb",
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: home,
          APPDATA: home,
          LOCALAPPDATA: home,
        },
      },
    );

    const stdout = collectStdout(limits.outputLimit);
    const stderr = createCapture(limits.outputLimit);
    child.onStdout((chunk) => stdout.push(chunk));
    child.onStderr((chunk) => stderr.push(chunk));

    let stopped: "timedOut" | "aborted" | null = null;
    const stop = (reason: "timedOut" | "aborted") => {
      stopped ??= reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("timedOut"), limits.timeoutMs);
    const onAbort = () => stop("aborted");
    limits.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const { code } = await child.exited;
      return {
        exitCode: stopped ? null : code,
        output: joinOutput(stdout.text(), stderr.text()),
        durationMs: elapsed(),
        ...(stopped ? { [stopped]: true } : {}),
      };
    } finally {
      clearTimeout(timer);
      limits.signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    return {
      exitCode: null,
      output: "",
      durationMs: elapsed(),
      error: getErrorMessage(error, "The Termix CLI could not be started"),
    };
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}
