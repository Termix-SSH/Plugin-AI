import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginProcess } from "@termix-ssh/plugin-sdk/backend";
import { getErrorMessage } from "../errors.js";
import { redact, redactString, REDACTED } from "../redaction.js";
import { createCapture, type ExecOutcome } from "./exec.js";

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
    sub: ["import"],
    why: "reads a file on the Termix server's own disk. Use hosts create.",
  },
};

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

/** Why `args` may not run, or null when they may. Help always may. */
export function checkCliArgs(args: string[]): string | null {
  if (!args.length) return 'args is empty. Try ["--help"].';

  for (const arg of args) {
    const problem = blockedFlag(arg);
    if (problem) return problem;
  }

  const [group, sub] = args.filter((arg) => !arg.startsWith("-"));
  const help =
    group === "help" || args.includes("--help") || args.includes("-h");
  const rule = group && !help ? BLOCKED[group] : undefined;
  if (rule && (rule.all || (sub && rule.sub?.includes(sub)))) {
    return `termix ${rule.all ? group : `${group} ${sub}`} ${rule.why}`;
  }
  return null;
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

export interface CliTarget {
  run: PluginProcess["run"];
  cliPath: string;
  url: string;
  token: string;
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
    const child = await target.run(
      process.execPath,
      [target.cliPath, "--json", "--no-color", ...args],
      {
        cwd: home,
        env: {
          TERMIX_URL: target.url,
          TERMIX_TOKEN: target.token,
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

    const output = createCapture(limits.outputLimit);
    child.onStdout((chunk) => output.push(chunk));
    child.onStderr((chunk) => output.push(chunk));

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
        output: output.text(),
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
