import { resolveAiAccess } from "../gating.js";
import { ownerLanguage, reportText } from "./language.js";
import { readPreferences, readTaskLimits, startOfUtcDay } from "./limits.js";
import {
  resolveProvider,
  runTask,
  taskResult,
  type TaskRunnerDeps,
} from "./runner.js";
import {
  OPEN_STATUSES,
  type AiTaskInput,
  type AiTaskResult,
  type AiTasksV1,
} from "./types.js";

/**
 * The ai.tasks service, version 1. Automations calls it as the automation's
 * owner, so every check here is about that user: their ai.ops.use, their
 * opt-in, their host access, their budget. The guards run in order: kill
 * switch, an open task for the same hosts, the hourly rate, the daily
 * budget. A skipped call is recorded, so it shows in the task list.
 */

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RUN_MS = 300_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The input with its types checked, or why it cannot run. */
export function parseTaskInput(
  raw: unknown,
): { input: AiTaskInput } | { error: string } {
  if (!isObject(raw)) return { error: "The task input is missing" };
  const automationId = Number(raw.automationId);
  if (!Number.isInteger(automationId) || automationId <= 0) {
    return { error: "automationId must be an automation id" };
  }
  const runbook = typeof raw.runbook === "string" ? raw.runbook.trim() : "";
  if (!runbook) return { error: "runbook is required" };
  if (raw.autonomy !== "report" && raw.autonomy !== "propose") {
    return { error: "autonomy must be report or propose" };
  }
  const hostIds = Array.isArray(raw.hostIds)
    ? [...new Set(raw.hostIds.map(Number))]
    : [];
  if (
    !hostIds.length ||
    hostIds.some((id) => !Number.isInteger(id) || id <= 0)
  ) {
    return { error: "hostIds must list at least one host id" };
  }
  const trigger = isObject(raw.trigger) ? raw.trigger : {};
  const triggerHost = Number(trigger.hostId);
  const vars = isObject(trigger.vars)
    ? Object.fromEntries(
        Object.entries(trigger.vars).map(([key, value]) => [
          key,
          String(value),
        ]),
      )
    : {};
  const deadlineAt = Number(raw.deadlineAt);
  const runId = Number(raw.automationRunId);
  return {
    input: {
      automationId,
      automationRunId: Number.isInteger(runId) ? runId : 0,
      presetId:
        typeof raw.presetId === "string" && raw.presetId
          ? raw.presetId.slice(0, 64)
          : undefined,
      title:
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim().slice(0, 200)
          : "AI task",
      runbook,
      autonomy: raw.autonomy,
      hostIds,
      trigger: {
        kind: typeof trigger.kind === "string" ? trigger.kind : "manual",
        ...(Number.isInteger(triggerHost) && triggerHost > 0
          ? { hostId: triggerHost }
          : {}),
        summary: typeof trigger.summary === "string" ? trigger.summary : "",
        vars,
      },
      dryRun: raw.dryRun === true,
      deadlineAt:
        Number.isFinite(deadlineAt) && deadlineAt > Date.now()
          ? deadlineAt
          : Date.now() + DEFAULT_RUN_MS,
      signal: raw.signal instanceof AbortSignal ? raw.signal : undefined,
    },
  };
}

/** The hosts a task is about: the trigger's host, else all its targets. */
export function dedupeKeys(input: {
  hostIds: number[];
  trigger: { hostId?: unknown };
}): number[] {
  const host = Number(input.trigger.hostId);
  return Number.isInteger(host) && host > 0 ? [host] : input.hostIds;
}

export interface TaskService {
  service: AiTasksV1;
  /** The kill switch: stops every running task and plan. */
  stopAll: () => void;
  /** Moves proposed plans past their time to expired. */
  expireStale: () => Promise<number>;
}

export function createTaskService(deps: TaskRunnerDeps): TaskService {
  const { ctx, tasks } = deps;
  // Claimed synchronously on entry, so two triggers at once cannot both
  // pass the open-task check before either has a row.
  const inFlight = new Map<number, Set<number>[]>();

  const claim = (automationId: number, keys: number[]) => {
    const claims = inFlight.get(automationId) ?? [];
    if (claims.some((held) => keys.some((key) => held.has(key)))) return null;
    const mine = new Set(keys);
    claims.push(mine);
    inFlight.set(automationId, claims);
    return () => {
      const left = (inFlight.get(automationId) ?? []).filter(
        (held) => held !== mine,
      );
      if (left.length) inFlight.set(automationId, left);
      else inFlight.delete(automationId);
    };
  };

  const run = async (raw: AiTaskInput): Promise<AiTaskResult> => {
    const userId = ctx.currentActor();
    if (!userId) throw new Error("ai.tasks.run needs an actor");
    const parsed = parseTaskInput(raw);
    if ("error" in parsed) {
      return taskResult("failed", null, parsed.error, "warning");
    }
    const { input } = parsed;
    const preferred = await readPreferences(ctx.settings, userId);
    const language = await ownerLanguage(ctx, userId);

    if (!(await ctx.rbac.has("ops.use"))) {
      return taskResult(
        "failed",
        null,
        reportText(language, "needsOpsUse"),
        "warning",
      );
    }
    if (!(await resolveAiAccess(ctx.settings, userId)).enabled) {
      return taskResult(
        "failed",
        null,
        reportText(language, "assistantOff"),
        "warning",
      );
    }

    const record = async (
      status: "skipped" | "failed",
      summary: string,
    ): Promise<AiTaskResult> => {
      const row = await tasks.createRun({
        userId,
        automationId: input.automationId,
        automationRunId: input.automationRunId,
        presetId: input.presetId ?? null,
        title: input.title,
        autonomy: input.autonomy,
        hostIds: input.hostIds,
        trigger: { ...input.trigger },
        dryRun: input.dryRun,
        status,
        summary,
        severity: "info",
        finishedAt: new Date().toISOString(),
      });
      return taskResult(status, row.id, summary, "info");
    };

    const limits = await readTaskLimits(ctx.settings);
    if (limits.paused) {
      return record("skipped", reportText(language, "skippedPaused"));
    }

    const keys = dedupeKeys(input);
    const release = claim(input.automationId, keys);
    if (!release) {
      return record("skipped", reportText(language, "skippedDuplicate"));
    }
    try {
      const open = await tasks.openRuns(input.automationId, OPEN_STATUSES);
      if (
        open.some((row) => dedupeKeys(row).some((key) => keys.includes(key)))
      ) {
        return record("skipped", reportText(language, "skippedDuplicate"));
      }
      const recent = await tasks.countRecent(
        input.automationId,
        new Date(Date.now() - HOUR_MS).toISOString(),
      );
      if (recent >= limits.runsPerHour) {
        return record(
          "skipped",
          reportText(language, "skippedRate", { count: limits.runsPerHour }),
        );
      }
      const usedToday = (
        await deps.repository.usageSince(startOfUtcDay(Date.now()), userId)
      ).reduce((sum, row) => sum + row.promptTokens + row.completionTokens, 0);
      if (usedToday >= limits.dailyTokens) {
        return record(
          "skipped",
          reportText(language, "stoppedBudgetDaily", {
            tokens: limits.dailyTokens,
          }),
        );
      }
      const chosen = await resolveProvider(deps.repository, userId, preferred);
      if (!chosen) {
        return record("failed", reportText(language, "noProvider"));
      }
      return await runTask(deps, {
        input,
        userId,
        limits,
        usedToday,
        language,
        provider: chosen.provider,
        model: chosen.model,
      });
    } finally {
      release();
    }
  };

  return {
    service: { run },
    stopAll: () => {
      for (const stop of [...deps.running.values()]) stop("paused");
    },
    expireStale: async () => {
      const now = new Date().toISOString();
      let expired = 0;
      for (const row of await tasks.expiredProposals(now)) {
        const moved = await tasks.transition(row.id, ["proposed"], {
          status: "expired",
          finishedAt: now,
        });
        if (moved) expired += 1;
      }
      return expired;
    },
  };
}
