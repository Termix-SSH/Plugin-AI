import type { CliRunInput } from "../repository.js";
import { readService, SERVICE } from "../services.js";
import {
  objectSchema,
  str,
  num,
  type AiTool,
  type ToolContext,
} from "../tools/types.js";
import { checkCliArgs, redactCliArgs, runCli, type CliTarget } from "./cli.js";
import { timeoutFor, type OpsSession } from "./tools.js";

/**
 * The assistant's tools beyond the shell: the Termix CLI, choosing targets,
 * and asking the browser to open a view. Built per request like the ops
 * tools, over the same session, so set_targets changes what run_command may
 * reach in the same run.
 */

/** Something the browser should do, sent as a client_action frame. */
export type ClientAction =
  | { kind: "open_host_terminal"; hostId: number }
  | { kind: "open_tab"; type: string; hostId?: number }
  | { kind: "open_settings"; page?: string; anchor?: string }
  | { kind: "open_view"; id: string };

export interface AssistantSession extends OpsSession {
  /**
   * Whether the user holds ai.ops.use. Without it the session has no shell
   * on hosts: no target tools, and the CLI refuses its exec commands.
   */
  hostShell: boolean;
  /** Null when the request carried no session token to run the CLI with. */
  cli: CliTarget | null;
  /** Saves the conversation's new targets and tells the browser. */
  saveTargets: (hostIds: number[]) => Promise<void>;
  clientAction: (action: ClientAction) => void;
  recordCliRun: (run: CliRunInput) => Promise<void>;
}

const CLI_TIMEOUT_SEC = 120;
/**
 * JSON is only useful whole, so the CLI gets more room than a host, and all
 * of a large window's summary budget: a hosts list cut in the middle leaves
 * the model guessing ids.
 */
const CLI_OUTPUT_LIMIT = 16000;

function termixDescription(hostShell: boolean): string {
  return [
    "Run the Termix CLI as the current user to read or change anything in Termix. Output is JSON.",
    'Pass the words after `termix` as args, e.g. ["hosts", "list"] or ["alerts", "list", "--unread"].',
    `Command groups: hosts, credentials, snippets, fleets, alerts, plugins, sessions, api-keys, docker, files, users, audit-logs, status, version, whoami, ${hostShell ? "exec, " : ""}api.`,
    'Find hosts with ["hosts", "list"] (filters: --folder, --tag) and ["hosts", "get", "<id>"]; core routes are not REST-style, e.g. hosts are /host/db/host, not /hosts.',
    'When unsure, call it with ["<group>", "--help"] first. For anything without a command use ["api", "<METHOD>", "<path>", "--data", "<json>"], e.g. ["api", "GET", "/plugin-api/<id>/..."].',
    "Not available: ssh, login, logout, tunnel start, hosts export, api-keys create, export routes, and anything that reads or writes files on the Termix server's own disk.",
    hostShell
      ? "Use run_command for shell work on hosts."
      : "This user may not run shell commands on hosts, so exec, fleets exec, snippets run and execute routes are refused too.",
  ].join(" ");
}

function cliFailure(result: Awaited<ReturnType<typeof runCli>>) {
  if (result.error) return result.error;
  if (result.timedOut) return "Timed out";
  if (result.aborted) return "Stopped by the user";
  if (result.exitCode !== 0) return `Exited with code ${result.exitCode}`;
  return undefined;
}

/** What the termix tool needs: the assistant's session, or a task's. */
export type CliSession = Pick<
  AssistantSession,
  "hostShell" | "signal" | "recordCliRun" | "auditDetails" | "limits"
>;

export function termixTool(session: CliSession, cli: CliTarget): AiTool {
  return {
    name: "termix",
    description: termixDescription(session.hostShell),
    category: "ops",
    parameters: objectSchema(
      {
        args: {
          type: "array",
          items: { type: "string" },
          description:
            "The CLI arguments, one word per item. No shell quoting.",
        },
        timeoutSec: num(
          `Seconds before the CLI is stopped (default ${CLI_TIMEOUT_SEC})`,
        ),
      },
      ["args"],
    ),
    handler: async (raw, context) => {
      if (!Array.isArray(raw.args)) {
        return { error: "args must be a list of strings" };
      }
      const args = raw.args.map(String);
      const problem = checkCliArgs(args, session.hostShell);
      if (problem) return { error: problem };
      const result = await runCli(cli, args, {
        timeoutMs: timeoutFor(raw.timeoutSec, CLI_TIMEOUT_SEC) * 1000,
        outputLimit: Math.max(
          CLI_OUTPUT_LIMIT,
          session.limits.summaryBudget ?? 0,
        ),
        signal: session.signal,
      });
      const failure = cliFailure(result);
      const redacted = redactCliArgs(args);

      await context.deps.audit
        .record({
          action: "ai_cli_command",
          resourceType: "termix",
          details: JSON.stringify({
            args: redacted,
            exitCode: result.exitCode,
            ...session.auditDetails,
          }),
          success: !failure,
          errorMessage: failure,
        })
        .catch(() => undefined);
      await session.recordCliRun({
        conversationId: context.conversationId,
        userId: context.userId,
        args: JSON.stringify(redacted),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        output: result.error ?? result.output,
      });

      return {
        exitCode: result.exitCode,
        ...(failure ? { error: failure } : {}),
        output: result.output,
      };
    },
  };
}

const ids = (raw: unknown): number[] =>
  Array.isArray(raw)
    ? raw.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];

const names = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
    : [];

const FOLDER_SEPARATOR = " / ";

/**
 * The hosts the given ids, fleets, folders and tags name, among those the
 * user can see. A folder takes every folder under it too.
 */
async function resolveTargets(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<{ hostIds: number[]; notFound: string[] }> {
  const hosts = await context.deps.hosts.list();
  const visible = new Set(hosts.map((host) => host.id));
  const picked = new Set<number>();
  const notFound: string[] = [];

  for (const id of ids(args.hostIds)) {
    if (visible.has(id)) picked.add(id);
    else notFound.push(`host ${id}`);
  }

  for (const folder of names(args.folders)) {
    const inside = hosts.filter((host) => {
      const own = (host.folder ?? "").trim().toLowerCase();
      return own === folder || own.startsWith(folder + FOLDER_SEPARATOR);
    });
    if (!inside.length) notFound.push(`folder ${folder}`);
    for (const host of inside) picked.add(host.id);
  }

  for (const tag of names(args.tags)) {
    const tagged = hosts.filter((host) =>
      (host.tags ?? "")
        .split(",")
        .some((entry) => entry.trim().toLowerCase() === tag),
    );
    if (!tagged.length) notFound.push(`tag ${tag}`);
    for (const host of tagged) picked.add(host.id);
  }

  for (const fleetId of ids(args.fleetIds)) {
    const members = await readService(
      context.deps.services,
      SERVICE.fleets,
      (fleets) => fleets.members(fleetId),
    );
    if (!members) notFound.push(`fleet ${fleetId}`);
    for (const host of members ?? []) {
      if (visible.has(host.id)) picked.add(host.id);
    }
  }

  return { hostIds: [...picked], notFound };
}

function setTargetsTool(session: AssistantSession): AiTool {
  const list = (description: string, type: string) => ({
    type: "array",
    items: { type },
    description,
  });
  return {
    name: "set_targets",
    description:
      "Replace the hosts run_command and get_host_facts may use with the union of the given hosts, fleets, folders and tags. Find ids with termix (hosts list, fleets list). An empty call clears the targets. The user sees the new targets.",
    category: "ops",
    parameters: objectSchema({
      hostIds: list("Host ids", "number"),
      fleetIds: list("Fleet ids; their member hosts are added", "number"),
      folders: list(
        'Folder paths like "prod" or "prod / web"; hosts in subfolders count',
        "string",
      ),
      tags: list("Host tags", "string"),
    }),
    handler: async (args, context) => {
      const { hostIds, notFound } = await resolveTargets(args, context);
      session.targets = hostIds;
      await session.saveTargets(hostIds);
      return {
        targets: hostIds.length,
        hostIds,
        ...(notFound.length ? { notFound } : {}),
      };
    },
  };
}

async function hostVisible(context: ToolContext, hostId: number) {
  const hosts = await context.deps.hosts.list();
  return hosts.some((host) => host.id === hostId);
}

const REQUESTED = { status: "requested" };

function uiTools(session: AssistantSession): AiTool[] {
  return [
    {
      name: "open_host_terminal",
      description: "Open an SSH terminal tab on a host for the user.",
      category: "ops",
      parameters: objectSchema({ hostId: num("Host id") }, ["hostId"]),
      handler: async (args, context) => {
        const hostId = Number(args.hostId);
        if (!(await hostVisible(context, hostId))) {
          return { error: `Host ${args.hostId} not found` };
        }
        session.clientAction({ kind: "open_host_terminal", hostId });
        return REQUESTED;
      },
    },
    {
      name: "open_tab",
      description: [
        "Open a tab for the user. Needs a hostId: terminal, files, docker, tunnel, host-metrics, tmux_monitor, rdp, vnc, telnet.",
        "Without a host: dashboard, host-manager, plugins, alerts, automations, fleet-inventory, network_graph, homepage, local-terminal, ai.",
        "Tabs from a plugin that is not installed do not open.",
      ].join(" "),
      category: "ops",
      parameters: objectSchema(
        {
          type: str("The tab type"),
          hostId: num("Host id, for a host tab"),
        },
        ["type"],
      ),
      handler: async (args, context) => {
        const type = typeof args.type === "string" ? args.type.trim() : "";
        if (!type) return { error: "type is required" };
        if (args.hostId === undefined) {
          session.clientAction({ kind: "open_tab", type });
          return REQUESTED;
        }
        const hostId = Number(args.hostId);
        if (!(await hostVisible(context, hostId))) {
          return { error: `Host ${args.hostId} not found` };
        }
        session.clientAction({ kind: "open_tab", type, hostId });
        return REQUESTED;
      },
    },
    {
      name: "open_settings",
      description:
        "Open Settings for the user. Pages: account, security, api-keys, data, interface, appearance, keybindings, plugin:<plugin id> (a plugin's settings, e.g. plugin:ai); admins also have admin-general, updates, admin-users, admin-sessions, admin-roles, admin-host-defaults, admin-branding, admin-database, admin-ssl, admin-api-keys, admin-audit-log.",
      category: "ops",
      parameters: objectSchema({
        page: str("The page id; account when left out"),
        anchor: str("An element id on that page to scroll to"),
      }),
      handler: async (args) => {
        const text = (value: unknown) =>
          typeof value === "string" && value.trim() ? value.trim() : undefined;
        session.clientAction({
          kind: "open_settings",
          page: text(args.page),
          anchor: text(args.anchor),
        });
        return REQUESTED;
      },
    },
    {
      name: "open_plugin_view",
      description:
        "Open a sidebar view for the user: hosts, credentials, quick-connect, connections, or a plugin's: snippets, fleets, workspaces, history, macros, ssh-tools, port-forwarding.",
      category: "ops",
      parameters: objectSchema({ id: str("The view id") }, ["id"]),
      handler: async (args) => {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id) return { error: "id is required" };
        session.clientAction({ kind: "open_view", id });
        return REQUESTED;
      },
    },
  ];
}

export function createAssistantTools(session: AssistantSession): AiTool[] {
  return [
    ...(session.cli ? [termixTool(session, session.cli)] : []),
    ...(session.hostShell ? [setTargetsTool(session)] : []),
    ...uiTools(session),
  ];
}
