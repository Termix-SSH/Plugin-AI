import type { OpsRunInput } from "../repository.js";
import { toHostSummary } from "../tools/host-summary.js";
import {
  num,
  objectSchema,
  str,
  type AiTool,
  type ToolContext,
} from "../tools/types.js";
import {
  execOnHost,
  mapLimit,
  truncateMiddle,
  type ExecOutcome,
} from "./exec.js";

/**
 * The Cluster Ops tools. Unlike the chat catalog these are built per request,
 * closed over the conversation's targets, the admin's limits and the request's
 * abort signal, so a tool can never reach past what the user selected.
 */

export interface OpsLimits {
  concurrency: number;
  timeoutSec: number;
  /** Characters of output kept per host. */
  outputLimit: number;
  /**
   * Characters handed back to the model across every host of one call.
   * Defaults to a size that suits small windows: see summaryBudgetFor.
   */
  summaryBudget?: number;
}

export const MAX_TIMEOUT_SEC = 600;

/** One host's result, streamed to the UI as soon as it finishes. */
export interface HostResult extends ExecOutcome {
  hostId: number;
  name: string;
  /** Facts served from the conversation's cache, nothing ran. */
  cached?: boolean;
}

export interface OpsSession {
  /** The conversation's target host ids. */
  targets: number[];
  limits: OpsLimits;
  signal: AbortSignal;
  /** Host facts already probed in this conversation. */
  facts: Map<number, string>;
  onHostResult: (tool: string, command: string, result: HostResult) => void;
  recordRuns: (runs: OpsRunInput[]) => Promise<void>;
  /** Added to every command's audit line, e.g. the task that ran it. */
  auditDetails?: Record<string, unknown>;
}

const FACTS_COMMAND = [
  "uname -a",
  "echo '--- os-release'",
  "cat /etc/os-release 2>/dev/null",
  "echo '--- nproc'",
  "nproc",
  "echo '--- free -m'",
  "free -m",
  "echo '--- uptime'",
  "uptime",
].join("; ");

const FACTS_TIMEOUT_SEC = 30;

/** Output handed back to the model across every host of one call. */
const SUMMARY_BUDGET = 24000;
const MIN_SUMMARY_PER_HOST = 200;

/**
 * The output budget for a model with `contextWindow` tokens: about 5% of the
 * window at four characters a token, so a fleet-wide call on a large window
 * is not cut to a few hundred characters a host.
 */
export function summaryBudgetFor(contextWindow: number): number {
  return Math.min(Math.max(Math.floor(contextWindow * 0.2), 8000), 160000);
}

// A plain array keeps the schema inside what every provider accepts; "all"
// is still understood when a model sends it.
const hostIdsSchema = {
  type: "array",
  items: { type: "number" },
  description:
    'Host ids from list_targets. Leave it out, or pass "all", for every target of this conversation.',
};

function resolveScope(
  raw: unknown,
  targets: number[],
): { hostIds: number[] } | { error: string } {
  if (!targets.length) {
    return { error: "No target hosts yet. Call set_targets first." };
  }
  if (raw === undefined || raw === "all") return { hostIds: targets };
  if (!Array.isArray(raw) || !raw.length) {
    return { error: 'hostIds must be "all" or a list of host ids' };
  }
  const hostIds = [...new Set(raw.map(Number))];
  const outside = hostIds.filter((hostId) => !targets.includes(hostId));
  if (outside.length) {
    return {
      error: `Not a target of this conversation: ${outside.join(", ")}. Call list_targets for the hosts you may use.`,
    };
  }
  return { hostIds };
}

export function timeoutFor(raw: unknown, fallback: number): number {
  const seconds = Number(raw);
  const chosen = Number.isFinite(seconds) && seconds > 0 ? seconds : fallback;
  return Math.min(Math.max(chosen, 1), MAX_TIMEOUT_SEC);
}

async function hostNames(context: ToolContext): Promise<Map<number, string>> {
  const hosts = await context.deps.hosts.list();
  return new Map(hosts.map((host) => [host.id, host.name || host.ip]));
}

function describeFailure(result: ExecOutcome): string | undefined {
  if (result.error) return result.error;
  if (result.timedOut) return "Timed out";
  if (result.aborted) return "Stopped by the user";
  if (result.exitCode !== 0) return `Exited with code ${result.exitCode}`;
  return undefined;
}

/**
 * Runs `command` on every host in parallel, up to the concurrency limit.
 * Each host is checked for connect access first, reported to the UI and the
 * audit log as it finishes, and the whole batch is recorded at the end.
 */
async function fanOut(
  session: OpsSession,
  context: ToolContext,
  tool: string,
  command: string,
  hostIds: number[],
  timeoutSec: number,
  names: Map<number, string>,
): Promise<HostResult[]> {
  const limits = {
    timeoutMs: timeoutSec * 1000,
    outputLimit: session.limits.outputLimit,
    signal: session.signal,
  };

  const runOne = async (hostId: number): Promise<HostResult> => {
    const name = names.get(hostId) ?? `#${hostId}`;
    const access = await context.deps.hosts.checkAccess(hostId, "connect");
    const outcome: ExecOutcome = access.hasAccess
      ? await execOnHost(context.deps, hostId, command, limits)
      : { exitCode: null, output: "", durationMs: 0, error: "Host not found" };
    const result = { hostId, name, ...outcome };

    session.onHostResult(tool, command, result);
    const failure = describeFailure(result);
    await context.deps.audit
      .record({
        action: "ai_ops_command",
        resourceType: "host",
        resourceId: String(hostId),
        resourceName: name,
        details: JSON.stringify({
          command,
          exitCode: result.exitCode,
          ...session.auditDetails,
        }),
        success: !failure,
        errorMessage: failure,
      })
      .catch(() => undefined);
    return result;
  };

  const results = (
    await mapLimit(hostIds, session.limits.concurrency, session.signal, runOne)
  ).filter((result): result is HostResult => result !== undefined);

  await session.recordRuns(
    results.map((result) => ({
      conversationId: context.conversationId,
      userId: context.userId,
      hostId: result.hostId,
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: result.error ?? result.output,
    })),
  );
  return results;
}

/**
 * Output as the model gets it. Already cut to the per-host limit, it is cut
 * further only when many hosts share the budget.
 */
function forModel(output: string, hostCount: number, limits: OpsLimits) {
  const budget = limits.summaryBudget ?? SUMMARY_BUDGET;
  const share = Math.floor(budget / Math.max(hostCount, 1));
  if (share >= limits.outputLimit) return output;
  return truncateMiddle(output, Math.max(share, MIN_SUMMARY_PER_HOST));
}

function summarize(
  command: string,
  results: HostResult[],
  requested: number,
  limits: OpsLimits,
) {
  const succeeded = results.filter((result) => !describeFailure(result));
  return {
    command,
    succeeded: succeeded.length,
    failed: results.length - succeeded.length,
    ...(results.length < requested
      ? { notStarted: requested - results.length }
      : {}),
    hosts: results.map((result) => ({
      id: result.hostId,
      name: result.name,
      exitCode: result.exitCode,
      ...(describeFailure(result) ? { error: describeFailure(result) } : {}),
      output: forModel(result.output, results.length, limits),
    })),
  };
}

export function createOpsTools(session: OpsSession): AiTool[] {
  return [
    {
      name: "list_targets",
      description:
        "List the hosts selected for this conversation: id, name, address, port, user, folder, tags and facts if already probed. The only hosts you may run commands on.",
      category: "ops",
      parameters: objectSchema({}),
      handler: async (_args, context) => {
        const targets = new Set(session.targets);
        const hosts = await context.deps.hosts.list();
        return {
          hosts: hosts
            .filter((host) => targets.has(host.id))
            .map((host) => ({
              ...toHostSummary(host),
              facts: session.facts.get(host.id) ?? null,
            })),
        };
      },
    },
    {
      name: "run_command",
      description:
        "Run one non-interactive shell command on several target hosts in parallel over SSH and get each host's exit code and output. Prefer one command that answers the question on every host over one call per host.",
      category: "ops",
      parameters: objectSchema(
        {
          hostIds: hostIdsSchema,
          command: str(
            "The shell command. It runs without a terminal, so nothing may wait for input.",
          ),
          timeoutSec: num(
            `Seconds before the command is stopped (default set by the admin, at most ${MAX_TIMEOUT_SEC})`,
          ),
        },
        ["command"],
      ),
      handler: async (args, context) => {
        const command =
          typeof args.command === "string" ? args.command.trim() : "";
        if (!command) return { error: "command is required" };
        const scope = resolveScope(args.hostIds, session.targets);
        if ("error" in scope) return scope;

        const results = await fanOut(
          session,
          context,
          "run_command",
          command,
          scope.hostIds,
          timeoutFor(args.timeoutSec, session.limits.timeoutSec),
          await hostNames(context),
        );
        return summarize(
          command,
          results,
          scope.hostIds.length,
          session.limits,
        );
      },
    },
    {
      name: "get_host_facts",
      description:
        "Get the OS, kernel, CPU count, memory and uptime of target hosts. Probed once per host and remembered for the rest of the conversation.",
      category: "ops",
      parameters: objectSchema({ hostIds: hostIdsSchema }),
      handler: async (args, context) => {
        const scope = resolveScope(args.hostIds, session.targets);
        if ("error" in scope) return scope;
        const names = await hostNames(context);

        const missing: number[] = [];
        for (const hostId of scope.hostIds) {
          const facts = session.facts.get(hostId);
          if (facts === undefined) {
            missing.push(hostId);
            continue;
          }
          session.onHostResult("get_host_facts", FACTS_COMMAND, {
            hostId,
            name: names.get(hostId) ?? `#${hostId}`,
            exitCode: 0,
            output: facts,
            durationMs: 0,
            cached: true,
          });
        }

        const probed = await fanOut(
          session,
          context,
          "get_host_facts",
          FACTS_COMMAND,
          missing,
          FACTS_TIMEOUT_SEC,
          names,
        );
        const failures = new Map<number, string>();
        for (const result of probed) {
          const failure = describeFailure(result);
          if (failure) failures.set(result.hostId, failure);
          else session.facts.set(result.hostId, result.output);
        }

        return {
          hosts: scope.hostIds.map((hostId) => {
            const facts = session.facts.get(hostId);
            return {
              id: hostId,
              name: names.get(hostId) ?? `#${hostId}`,
              ...(facts !== undefined
                ? {
                    facts: forModel(
                      facts,
                      scope.hostIds.length,
                      session.limits,
                    ),
                  }
                : { error: failures.get(hostId) ?? "Not probed" }),
            };
          }),
        };
      },
    },
  ];
}
