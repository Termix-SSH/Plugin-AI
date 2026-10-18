import { existsSync } from "node:fs";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { userTokenIssuer } from "../core-api.js";
import { planContext } from "../context-window.js";
import { runAgent, type ModelUsage } from "../engine.js";
import { getErrorMessage } from "../errors.js";
import { readPrivateAllowlist } from "../gating.js";
import { toStoredMessage, toStoredSummary } from "../history.js";
import { contextPlanFor, type ModelInfoCache } from "../model-info.js";
import { bundledCliPath, CORE_URL, type CliTarget } from "../ops/cli.js";
import { readOpsLimits } from "../ops/routes.js";
import { summaryBudgetFor } from "../ops/tools.js";
import { createProviderFetch } from "../providers/http.js";
import type { ProviderConfig } from "../providers/types.js";
import type { AiProviderWithSecret, AiRepository } from "../repository.js";
import type { ToolDeps } from "../tools/types.js";
import { languageName, reportText } from "./language.js";
import { APPROVAL_TTL_MS, type TaskLimits } from "./limits.js";
import { notifyOwner } from "./notify.js";
import { buildTaskSystemPrompt, taskUserMessage } from "./prompt.js";
import type { TaskRepository, TaskRunRecord } from "./repository.js";
import {
  CLI_TOKEN_TTL_SEC,
  createTaskTools,
  type TaskToolSession,
} from "./tools.js";
import type {
  AiTaskInput,
  AiTaskResult,
  Severity,
  TaskPhase,
  TaskStatus,
} from "./types.js";

/**
 * The headless run behind ai.tasks: the assistant's agent loop with the
 * task tools, no step limit, compaction on, every call counted as "task".
 * It stops on its own report, the budget, the deadline, the kill switch or
 * the caller's signal, and always leaves a report behind.
 */

export type StopReason =
  "done" | "budgetRun" | "budgetDaily" | "deadline" | "paused" | "aborted";

/** Stops whatever runs a task: an investigation or an approved plan. */
export type RunningTasks = Map<number, (reason: StopReason) => void>;

export interface TaskRunnerDeps {
  ctx: PluginContext;
  repository: AiRepository;
  tasks: TaskRepository;
  modelInfo: ModelInfoCache;
  toolDeps: ToolDeps;
  running: RunningTasks;
}

/** The longest a run keeps investigating before it must report. */
const WRAP_UP_MS = 60_000;
/** The share of a token budget after which the run must report. */
const WRAP_UP_BUDGET = 0.85;
const SUMMARY_LIMIT = 300;

const STOP_KEYS = {
  budgetRun: "stoppedBudgetRun",
  budgetDaily: "stoppedBudgetDaily",
  deadline: "stoppedDeadline",
  paused: "stoppedPaused",
  aborted: "stoppedAborted",
} as const;

export function resultVars(
  status: string,
  severity: Severity,
  summary: string,
  taskRunId: number | null,
): Record<string, string> {
  return {
    "ai.status": status,
    "ai.severity": severity,
    "ai.summary": summary,
    "ai.taskRunId": taskRunId === null ? "" : String(taskRunId),
  };
}

export function taskResult(
  status: AiTaskResult["status"],
  taskRunId: number | null,
  summary: string,
  severity: Severity,
): AiTaskResult {
  return {
    status,
    taskRunId,
    summary,
    severity,
    vars: resultVars(status, severity, summary, taskRunId),
  };
}

export async function providerConfig(
  ctx: Pick<PluginContext, "fetch" | "settings">,
  provider: AiProviderWithSecret,
): Promise<ProviderConfig> {
  return {
    providerType: provider.providerType as ProviderConfig["providerType"],
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    fetch: createProviderFetch(
      ctx.fetch,
      await readPrivateAllowlist(ctx.settings),
    ),
  };
}

/**
 * The owner's chosen provider and model, else their first enabled provider
 * with a default model. Must run as the owner, for the key.
 */
export async function resolveProvider(
  repository: AiRepository,
  userId: string,
  preferred: { providerId: number | null; model: string | null },
): Promise<{ provider: AiProviderWithSecret; model: string } | null> {
  const candidates = (await repository.listProviders(userId)).filter(
    (provider) => provider.enabled,
  );
  const ordered = [
    ...candidates.filter((provider) => provider.id === preferred.providerId),
    ...candidates.filter((provider) => provider.id !== preferred.providerId),
  ];
  for (const candidate of ordered) {
    const model =
      (candidate.id === preferred.providerId && preferred.model) ||
      candidate.defaultModel;
    if (!model) continue;
    const provider = await repository.findProviderWithSecret(
      candidate.id,
      userId,
    );
    if (provider) return { provider, model };
  }
  return null;
}

/** A report the server writes: why it stopped, and what was found. */
export function stoppedReport(
  language: string,
  reason: string,
  partial: string,
): string {
  return [
    `## ${reportText(language, "verdict")}`,
    reason,
    "",
    `## ${reportText(language, "evidence")}`,
    partial.trim() || reportText(language, "nothingFound"),
    "",
    `## ${reportText(language, "actionsTaken")}`,
    reportText(language, "noChanges"),
    "",
    `## ${reportText(language, "recommendations")}`,
    reportText(language, "openConversation"),
  ].join("\n");
}

function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((entry) => entry.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "";
  return line.length > SUMMARY_LIMIT
    ? `${line.slice(0, SUMMARY_LIMIT - 1)}…`
    : line;
}

/**
 * The Termix CLI as the task's owner, on a core that can mint them a token
 * (Termix 26.10.2+), else null. Every call gets its own short-lived token,
 * passed only in the CLI's environment and never stored.
 */
export function ownerCli(
  ctx: PluginContext,
  userId: string,
  taskRunId: number,
): CliTarget | null {
  const issue = userTokenIssuer(ctx);
  const cliPath = bundledCliPath();
  if (!issue || !existsSync(cliPath)) return null;
  return {
    run: ctx.process.run,
    cliPath,
    url: CORE_URL,
    token: async () =>
      (
        await issue(userId, {
          purpose: `auto-ops task ${taskRunId}`,
          ttlSeconds: CLI_TOKEN_TTL_SEC,
        })
      ).token,
  };
}

export interface RunTaskOptions {
  input: AiTaskInput;
  userId: string;
  limits: TaskLimits;
  /** Tokens the owner already used today. */
  usedToday: number;
  language: string;
  provider: AiProviderWithSecret;
  model: string;
}

/** Runs one task to its report. The caller has already applied the guards. */
export async function runTask(
  deps: TaskRunnerDeps,
  options: RunTaskOptions,
): Promise<AiTaskResult> {
  const { ctx, repository, tasks } = deps;
  const { input, userId, limits, language, provider, model } = options;
  const autonomy = input.dryRun ? "report" : input.autonomy;

  const allHosts = await ctx.hosts.list();
  const names = new Map(
    allHosts.map((host) => [host.id, host.name || host.ip]),
  );
  const allowed: number[] = [];
  const refused: number[] = [];
  for (const hostId of input.hostIds) {
    const access = await ctx.hosts.checkAccess(hostId, "connect");
    (access.hasAccess ? allowed : refused).push(hostId);
  }

  const conversation = await repository.createConversation({
    userId,
    title: input.title.slice(0, 120),
    providerId: provider.id,
    model,
    mode: "task",
    targets: allowed,
  });
  const task = await tasks.createRun({
    userId,
    automationId: input.automationId,
    automationRunId: input.automationRunId ?? null,
    presetId: input.presetId ?? null,
    title: input.title,
    autonomy,
    hostIds: input.hostIds,
    trigger: { ...input.trigger },
    dryRun: input.dryRun,
    status: "running",
    conversationId: conversation.id,
  });

  if (!allowed.length) {
    const summary = reportText(language, "noHosts");
    await tasks.updateRun(task.id, {
      status: "failed",
      severity: "warning",
      summary,
      report: stoppedReport(language, summary, ""),
      finishedAt: new Date().toISOString(),
    });
    await notifyOwner(ctx, task, "failed", summary, "warning", language);
    return taskResult("failed", task.id, summary, "warning");
  }

  const controller = new AbortController();
  let stopReason: StopReason | null = null;
  const stop = (reason: StopReason) => {
    stopReason ??= reason;
    controller.abort();
  };
  deps.running.set(task.id, stop);
  const onCallerAbort = () => stop("aborted");
  if (input.signal?.aborted) stop("aborted");
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const remaining = Math.max(0, input.deadlineAt - Date.now());
  const deadlineTimer = setTimeout(() => stop("deadline"), remaining);
  const wrapUpAt = input.deadlineAt - Math.min(WRAP_UP_MS, remaining * 0.2);

  let promptTokens = 0;
  let completionTokens = 0;
  const used = () => promptTokens + completionTokens;
  const onUsage = async (usage: ModelUsage) => {
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    await tasks.addTokens(task.id, usage.promptTokens, usage.completionTokens);
    await repository.recordUsage({
      userId,
      providerId: provider.id,
      model,
      conversationId: conversation.id,
      ...usage,
    });
    if (used() >= limits.runTokens) stop("budgetRun");
    else if (options.usedToday + used() >= limits.dailyTokens) {
      stop("budgetDaily");
    }
  };

  const opsLimits = await readOpsLimits(ctx.settings);
  const cli = ownerCli(ctx, userId, task.id);
  const session: TaskToolSession = {
    targets: allowed,
    limits: opsLimits,
    signal: controller.signal,
    facts: new Map(),
    onHostResult: () => undefined,
    recordRuns: (runs) => repository.recordOpsRuns(runs),
    auditDetails: {
      source: "task",
      taskRunId: task.id,
      phase: "investigate" satisfies TaskPhase,
    },
    autonomy,
    plan: null,
    report: null,
    onReport: () => stop("done"),
    cli,
    recordCliRun: (run) => repository.recordCliRun(run),
    secondsLeft: () => (wrapUpAt - Date.now()) / 1000,
    wrapUp: () => {
      if (Date.now() >= wrapUpAt) return "Time is nearly up.";
      if (
        used() >= limits.runTokens * WRAP_UP_BUDGET ||
        options.usedToday + used() >= limits.dailyTokens * WRAP_UP_BUDGET
      ) {
        return "The token budget is nearly used up.";
      }
      return null;
    },
  };

  const prompt = {
    title: input.title,
    runbook: input.runbook,
    autonomy,
    trigger: input.trigger,
    hosts: allowed.map((id) => ({ id, name: names.get(id) ?? `#${id}` })),
    refused,
    language: languageName(language),
    cli: cli !== null,
    deadline: new Date(wrapUpAt).toISOString(),
  };
  const opening = taskUserMessage(prompt);
  await repository.appendMessage({
    conversationId: conversation.id,
    role: "user",
    content: opening,
  });

  let lastText = "";
  let lastError: string | null = null;
  try {
    const config = await providerConfig(ctx, provider);
    const plan = await contextPlanFor(
      deps.modelInfo,
      provider,
      config,
      model,
    ).catch(() => planContext({ model, overrides: {}, info: {}, adapter: {} }));
    // Set in place: the termix tool holds a copy of the session.
    opsLimits.summaryBudget = summaryBudgetFor(plan.contextWindow);
    for await (const event of runAgent({
      config,
      model,
      system: buildTaskSystemPrompt(prompt),
      history: [{ role: "user", content: opening }],
      context: {
        userId,
        conversationId: conversation.id,
        allowReadOnlyCommands: false,
        deps: deps.toolDeps,
      },
      tools: createTaskTools(session),
      signal: controller.signal,
      contextWindow: plan.contextWindow,
      contextBudget: plan.budget,
      compactAt: plan.compactAt,
      onUsage,
      source: "task",
    })) {
      if (event.type === "message") {
        if (event.message.role === "assistant" && event.message.content) {
          lastText = event.message.content;
        }
        await repository.appendMessage({
          conversationId: conversation.id,
          ...toStoredMessage(event.message),
        });
      } else if (event.type === "compacted") {
        await repository.appendMessage({
          conversationId: conversation.id,
          ...toStoredSummary(event.summary, event.keep),
        });
      } else if (event.type === "error") {
        lastError = event.message;
      }
    }
  } catch (error) {
    lastError = getErrorMessage(error, "The task failed");
  } finally {
    clearTimeout(deadlineTimer);
    input.signal?.removeEventListener("abort", onCallerAbort);
    deps.running.delete(task.id);
  }

  const outcome = settle(session, stopReason, lastError, lastText, language, {
    tokens: stopReason === "budgetRun" ? limits.runTokens : limits.dailyTokens,
  });
  const finishedAt = new Date().toISOString();
  const status: TaskStatus = outcome.status;
  await tasks.updateRun(task.id, {
    status,
    severity: outcome.severity,
    summary: outcome.summary,
    report: outcome.report,
    plan: session.plan,
    expiresAt:
      status === "proposed"
        ? new Date(Date.now() + APPROVAL_TTL_MS).toISOString()
        : null,
    finishedAt,
  });
  await repository.appendMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: outcome.report,
  });
  await repository.touchConversation(conversation.id);
  await notifyOwner(
    ctx,
    task,
    status === "proposed"
      ? "proposed"
      : status === "failed"
        ? "failed"
        : "reported",
    outcome.summary,
    outcome.severity,
    language,
  );
  return taskResult(
    status === "proposed"
      ? "proposed"
      : status === "failed"
        ? "failed"
        : "reported",
    task.id,
    outcome.summary,
    outcome.severity,
  );
}

interface Outcome {
  status: "reported" | "proposed" | "failed";
  severity: Severity;
  summary: string;
  report: string;
}

/** What a run that ended comes to, whatever ended it. */
function settle(
  session: TaskToolSession,
  stopReason: StopReason | null,
  lastError: string | null,
  lastText: string,
  language: string,
  values: Record<string, number>,
): Outcome {
  if (session.report) {
    return {
      status:
        session.autonomy === "propose" && session.plan
          ? "proposed"
          : "reported",
      ...session.report,
    };
  }
  if (stopReason && stopReason !== "done") {
    const summary = reportText(language, STOP_KEYS[stopReason], values);
    return {
      status: "failed",
      severity: "warning",
      summary,
      report: stoppedReport(language, summary, lastText),
    };
  }
  if (lastError) {
    const summary = reportText(language, "providerFailed", {
      error: lastError,
    });
    return {
      status: "failed",
      severity: "warning",
      summary,
      report: stoppedReport(language, summary, lastText),
    };
  }
  // The model answered in prose instead of submit_report: keep its answer.
  return {
    status: "reported",
    severity: "warning",
    summary: firstLine(lastText) || reportText(language, "nothingFound"),
    report:
      lastText.trim() ||
      stoppedReport(language, reportText(language, "nothingFound"), ""),
  };
}

export type { TaskRunRecord };
