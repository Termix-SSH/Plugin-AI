import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { AiRepository } from "../repository.js";
import { execOnHost, truncateMiddle, type ExecOutcome } from "../ops/exec.js";
import type { OpsLimits } from "../ops/tools.js";
import type { ToolDeps } from "../tools/types.js";
import { reportText } from "./language.js";
import { notifyOwner } from "./notify.js";
import type { TaskRepository, TaskRunRecord } from "./repository.js";
import type { RunningTasks, StopReason } from "./runner.js";
import type { PlanHost, Severity, StepResult } from "./types.js";

/**
 * Runs an approved plan: per host in plan order, each command verbatim in
 * order, stopping that host at its first failure, then its verify commands.
 * No model is involved; the report is written from the results. It runs as
 * the task's owner, so host access is the owner's.
 */

/** A quick command first, so an unreachable host is caught before any change. */
const PROBE_COMMAND = "true";
const PROBE_TIMEOUT_MS = 15_000;
/** Output kept per command in the report. */
const REPORT_OUTPUT = 600;

export interface ExecuteDeps {
  ctx: Pick<PluginContext, "hosts" | "notify" | "log" | "audit">;
  toolDeps: ToolDeps;
  repository: AiRepository;
  tasks: TaskRepository;
  running: RunningTasks;
}

function failure(outcome: ExecOutcome): string | undefined {
  if (outcome.error) return outcome.error;
  if (outcome.timedOut) return "Timed out";
  if (outcome.aborted) return "Stopped";
  if (outcome.exitCode !== 0) return `Exited with code ${outcome.exitCode}`;
  return undefined;
}

export async function executePlan(
  deps: ExecuteDeps,
  task: TaskRunRecord,
  limits: OpsLimits,
  language: string,
): Promise<void> {
  const { ctx, tasks } = deps;
  const plan: PlanHost[] = (task.plan ?? []).map((host) => ({
    ...host,
    results: [],
    error: undefined,
  }));
  const controller = new AbortController();
  let stopReason: StopReason | null = null;
  deps.running.set(task.id, (reason) => {
    stopReason ??= reason;
    controller.abort();
  });
  const names = new Map(
    (await ctx.hosts.list()).map((host) => [host.id, host.name || host.ip]),
  );

  const run = async (
    host: PlanHost,
    command: string,
    phase: StepResult["phase"],
    timeoutMs: number,
  ): Promise<StepResult> => {
    const outcome = await execOnHost(deps.toolDeps, host.hostId, command, {
      timeoutMs,
      outputLimit: limits.outputLimit,
      signal: controller.signal,
    });
    const error = failure(outcome);
    await ctx.audit
      .record({
        action: "ai_ops_command",
        resourceType: "host",
        resourceId: String(host.hostId),
        resourceName: names.get(host.hostId) ?? `#${host.hostId}`,
        details: JSON.stringify({
          command,
          exitCode: outcome.exitCode,
          source: "task",
          taskRunId: task.id,
          phase,
        }),
        success: !error,
        errorMessage: error,
      })
      .catch(() => undefined);
    if (task.conversationId) {
      await deps.repository.recordOpsRuns([
        {
          conversationId: task.conversationId,
          userId: task.userId,
          hostId: host.hostId,
          command,
          exitCode: outcome.exitCode,
          durationMs: outcome.durationMs,
          output: outcome.error ?? outcome.output,
        },
      ]);
    }
    return {
      command,
      phase,
      exitCode: outcome.exitCode,
      output: outcome.output,
      durationMs: outcome.durationMs,
      ...(error ? { error } : {}),
    };
  };

  const save = () => tasks.updateRun(task.id, { plan });

  try {
    for (const host of plan) {
      if (controller.signal.aborted) {
        host.error = reportText(language, "hostNotRun");
        continue;
      }
      const access = await ctx.hosts.checkAccess(host.hostId, "connect");
      if (!access.hasAccess) {
        host.error = reportText(language, "hostNoAccess");
        await save();
        continue;
      }
      const probe = await execOnHost(
        deps.toolDeps,
        host.hostId,
        PROBE_COMMAND,
        {
          timeoutMs: PROBE_TIMEOUT_MS,
          outputLimit: 200,
          signal: controller.signal,
        },
      );
      if (failure(probe)) {
        host.error = reportText(language, "hostUnreachable");
        await save();
        continue;
      }
      let failed = false;
      for (const command of host.commands) {
        const result = await run(
          host,
          command,
          "execute",
          limits.timeoutSec * 1000,
        );
        host.results!.push(result);
        await save();
        if (result.error) {
          failed = true;
          host.error = reportText(language, "hostStopped");
          break;
        }
      }
      if (failed) continue;
      for (const command of host.verify) {
        host.results!.push(
          await run(host, command, "verify", limits.timeoutSec * 1000),
        );
        await save();
      }
    }
  } finally {
    deps.running.delete(task.id);
  }

  const ok = plan.every(
    (host) => !host.error && host.results!.every((result) => !result.error),
  );
  const severity: Severity = ok ? "info" : "warning";
  const summary = stopReason
    ? reportText(language, "executionStopped")
    : reportText(language, ok ? "executionDone" : "executionFailed", {
        count: plan.length,
      });
  const report = executionReport(language, task, plan, names, summary, ok);
  await tasks.updateRun(task.id, {
    status: ok ? "done" : "failed",
    severity,
    summary,
    report: `${task.report ?? ""}\n\n---\n\n${report}`.trim(),
    plan,
    finishedAt: new Date().toISOString(),
  });
  if (task.conversationId) {
    await deps.repository.appendMessage({
      conversationId: task.conversationId,
      role: "assistant",
      content: report,
    });
    await deps.repository.touchConversation(task.conversationId);
  }
  await notifyOwner(ctx, task, "executed", summary, severity, language);
}

/** The executed plan's report, in the owner's language. */
export function executionReport(
  language: string,
  task: Pick<TaskRunRecord, "decidedBy">,
  plan: PlanHost[],
  names: Map<number, string>,
  summary: string,
  ok: boolean,
): string {
  const lines = [
    `## ${reportText(language, "verdict")}`,
    summary,
    "",
    `## ${reportText(language, "evidence")}`,
  ];
  for (const host of plan) {
    lines.push("", `### ${names.get(host.hostId) ?? `#${host.hostId}`}`);
    if (host.error) lines.push(host.error);
    for (const result of host.results ?? []) {
      const status = result.error ?? `exit ${result.exitCode}`;
      const label = result.phase === "verify" ? "verify" : "run";
      lines.push(`- ${label} \`${result.command}\`: ${status}`);
      const output = result.output.trim();
      if (output) {
        lines.push("", "```", truncateMiddle(output, REPORT_OUTPUT), "```");
      }
    }
  }
  lines.push(
    "",
    `## ${reportText(language, "actionsTaken")}`,
    reportText(language, "approvedBy", { user: task.decidedBy ?? "" }),
    "",
    `## ${reportText(language, "recommendations")}`,
    ok
      ? reportText(language, "noFurtherAction")
      : reportText(language, "openConversation"),
  );
  return lines.join("\n");
}
