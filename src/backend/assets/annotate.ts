import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  estimateTokens,
  planContext,
  type ContextPlan,
} from "../context-window.js";
import { runAgent, type ModelUsage } from "../engine.js";
import { getErrorMessage } from "../errors.js";
import { isAiGloballyEnabled, resolveAiAccess } from "../gating.js";
import { contextPlanFor, type ModelInfoCache } from "../model-info.js";
import type { ProviderConfig } from "../providers/types.js";
import type { AiProviderWithSecret, AiRepository } from "../repository.js";
import { languageName, ownerLanguage, reportText } from "../tasks/language.js";
import { readPreferences } from "../tasks/limits.js";
import { providerConfig, resolveProvider } from "../tasks/runner.js";
import type { ToolDeps } from "../tools/types.js";
import {
  batchLimits,
  batchUnits,
  selectUnits,
  type Batch,
} from "./annotate-plan.js";
import { buildUnits, type HostMeta } from "./annotate-summary.js";
import {
  canonicalSystem,
  submitAnnotationsTool,
  validateSubmission,
} from "./annotate-tool.js";
import type { AssetRepository, RunTrigger } from "./repository.js";

/**
 * AI annotations: role, importance and system per asset, and depends_on
 * edges the facts show, written by one model call per batch of hosts.
 *
 * It runs as the collector, with their provider: the one an admin picked
 * for assets, else the one their auto-ops tasks use. One run at a time; a
 * request during one waits, and asking for everything wins over asking for
 * what changed. Each run is recorded with its tokens, every model call is
 * counted as "assets" usage, and a run stops at its token budget, when the
 * assistant is turned off or auto-ops is paused. What a stopped run already
 * wrote stays.
 */

export const ANNOTATE_SETTINGS = {
  afterCollect: "assetsAnnotateAfterCollect",
  provider: "assetsAnnotateProvider",
  model: "assetsAnnotateModel",
  runTokens: "assetsAnnotateRunTokens",
} as const;

export const DEFAULT_RUN_TOKENS = 200_000;
/** Model turns per batch: the call, and one more for what it left out. */
const TURNS_PER_BATCH = 2;

export interface AnnotationDeps {
  ctx: PluginContext;
  assets: AssetRepository;
  repository: AiRepository;
  modelInfo: ModelInfoCache;
  /** The collector, from the asset service. */
  collector: () => Promise<string | null>;
}

export function annotationSystemPrompt(language: string): string {
  return [
    "You annotate an infrastructure asset inventory from facts a read-only collector gathered.",
    "For every asset in the user message (a line starting with [key]) give:",
    '- role: what it does, a short phrase, e.g. "k3s control plane + etcd", "DNS (AdGuard)", "business MySQL (shop)".',
    "- importance: critical, high, medium or low, by blast radius: what stops working if it fails.",
    "- importanceReason: one sentence naming who or what depends on it.",
    "- system: the business system or product it belongs to, empty when it serves the infrastructure as a whole or you cannot tell.",
    "Give members of one cluster or pair the same importance: all control-plane nodes, both DNS servers, both nodes of an HA pair.",
    "Judge from the facts given only: listening ports, services, containers and images, connections, Proxmox and Kubernetes roles, names, folders and tags. Do not invent services.",
    "Containers are listed after the host they run on; annotate them too.",
    "Optionally suggest depends_on relations: from depends on to, from being an asset of this message. Each must cite an observed fact as evidence: an outbound connection of from (or its host) to to (connects_to, with the port), a container's published port that from connects to (port_mapping), or a runs_on relation. Suggestions without such a fact are rejected.",
    `Write role and importanceReason in ${language}. Keep keys, product and system names as they are.`,
    "Call submit_annotations once with an entry for every asset key.",
  ].join("\n");
}

/** At most this many known system names go into a batch's message. */
const KNOWN_SYSTEMS_MAX = 60;

/** The business systems the inventory already names, most used first. */
export function knownSystems(
  assets: Array<{ system: string | null }>,
): string[] {
  const counts = new Map<string, number>();
  for (const { system } of assets) {
    if (system) counts.set(system, (counts.get(system) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, KNOWN_SYSTEMS_MAX)
    .map(([name]) => name);
}

/** A batch's message, told which system names to reuse. */
export function withSystems(text: string, systems: string[]): string {
  if (!systems.length) return text;
  return `Systems already named in this inventory: ${systems.join(", ")}. Use the exact spelling when an asset belongs to one of them.\n\n${text}`;
}

export type AnnotationService = ReturnType<typeof createAnnotationService>;

export function createAnnotationService(deps: AnnotationDeps) {
  const { ctx, assets: repo } = deps;
  let pending: { trigger: RunTrigger; all: boolean } | null = null;
  let active: Promise<void> | null = null;
  let current: AbortController | null = null;
  let closed = false;

  const readRunTokens = async () => {
    const value = Number(
      await ctx.settings.get<number>(ANNOTATE_SETTINGS.runTokens),
    );
    return Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : DEFAULT_RUN_TOKENS;
  };

  /** The admin's pick for assets, else what the collector's tasks use. */
  async function chooseProvider(userId: string) {
    const providerId = Number(
      await ctx.settings.get(ANNOTATE_SETTINGS.provider),
    );
    const model = await ctx.settings.get<string>(ANNOTATE_SETTINGS.model);
    const preferred =
      Number.isInteger(providerId) && providerId > 0
        ? {
            providerId,
            model:
              typeof model === "string" && model.trim() ? model.trim() : null,
          }
        : await readPreferences(ctx.settings, userId);
    return resolveProvider(deps.repository, userId, preferred);
  }

  /** Why a run cannot start, or null. */
  async function refusal(userId: string | null): Promise<string | null> {
    if (!userId) return "No collector yet: collect once first";
    if (!(await isAiGloballyEnabled(ctx.settings))) {
      return "The AI assistant is turned off for the server";
    }
    if ((await ctx.settings.get<boolean>("autoOpsPaused")) === true) {
      return "AI auto-ops is paused";
    }
    if (!(await ctx.rbac.hasFor(userId, "assets.manage"))) {
      return "The collector no longer holds ai.assets.manage";
    }
    if (!(await resolveAiAccess(ctx.settings, userId)).enabled) {
      return "The collector has not turned on the AI assistant";
    }
    return null;
  }

  async function hostMeta(userId: string): Promise<Map<number, HostMeta>> {
    const hosts = await ctx.asUser(userId, () => ctx.hosts.list());
    return new Map(
      hosts.map((host) => [host.id, { folder: host.folder, tags: host.tags }]),
    );
  }

  async function notifyFailure(userId: string, runId: number, reason: string) {
    try {
      await ctx.notify.send({
        title: reportText(
          await ownerLanguage(ctx, userId),
          "noticeAssetsAnnotationFailed",
        ),
        body: reason,
        severity: "warning",
        category: "ai.assets_annotation_failed",
        audience: { userId },
        link: { tab: "ai" },
        dedupeKey: `ai-assets-annotate-${runId}`,
      });
    } catch (error) {
      ctx.log.warn(
        `Could not notify about asset annotation ${runId}: ${error}`,
      );
    }
  }

  interface RunState {
    userId: string;
    provider: AiProviderWithSecret;
    config: ProviderConfig;
    model: string;
    plan: ContextPlan;
    system: string;
    budget: number;
    tokens: number;
    stop: string | null;
    controller: AbortController;
  }

  /** The model calls for one batch; what it annotated, and any error. */
  async function annotateBatch(
    state: RunState,
    batch: Batch,
  ): Promise<{ annotated: number; error: string | null; missed: boolean }> {
    const live = await repo.listAssets();
    const edges = await repo.listEdges();
    const systems = knownSystems(live);
    const scope = {
      batch: new Set(batch.members.map((member) => member.asset.key)),
      known: new Map(live.map((asset) => [asset.key, asset])),
      edges: edges.filter((edge) => edge.source === "collector"),
    };
    const byKey = new Map(
      batch.members.map((member) => [member.asset.key, member]),
    );
    const done = new Set<string>();
    const keep = new Set<string>();
    const batchDone = new AbortController();
    const stopBatch = () => batchDone.abort();
    state.controller.signal.addEventListener("abort", stopBatch, {
      once: true,
    });

    let submissions = 0;
    const tool = submitAnnotationsTool(async (args) => {
      submissions += 1;
      const submission = validateSubmission(args, scope);
      for (const [key, write] of submission.annotations) {
        const member = byKey.get(key)!;
        if (write.system) {
          write.system = canonicalSystem(write.system, systems);
          if (!systems.includes(write.system)) systems.push(write.system);
        }
        await repo.annotate(member.asset.id, write, member.fingerprint);
        done.add(key);
      }
      for (const suggestion of submission.dependsOn) {
        await repo.upsertEdge({
          fromAsset: suggestion.from.id,
          toAsset: suggestion.to.id,
          type: "depends_on",
          detail: {},
          evidence: suggestion.evidence,
          source: "ai",
        });
        keep.add(`${suggestion.from.id}|${suggestion.to.id}`);
      }
      const missing = [...byKey.keys()].filter((key) => !done.has(key));
      // A rejected suggestion is not worth sending the batch again; a
      // missing annotation is, once.
      if (!missing.length || submissions >= TURNS_PER_BATCH) stopBatch();
      return {
        accepted: submission.annotations.size,
        dependsOnAccepted: submission.dependsOn.length,
        rejected: submission.errors,
        missing,
      };
    });

    let error: string | null = null;
    const onUsage = async (usage: ModelUsage) => {
      state.tokens += usage.promptTokens + usage.completionTokens;
      await deps.repository.recordUsage({
        userId: state.userId,
        providerId: state.provider.id,
        model: state.model,
        conversationId: null,
        ...usage,
      });
      if (state.tokens >= state.budget) {
        state.stop ??= `Stopped at the token budget of ${state.budget}`;
        state.controller.abort();
      }
    };
    try {
      for await (const event of runAgent({
        config: state.config,
        model: state.model,
        system: state.system,
        history: [{ role: "user", content: withSystems(batch.text, systems) }],
        context: {
          userId: state.userId,
          conversationId: 0,
          allowReadOnlyCommands: false,
          deps: {} as ToolDeps,
        },
        tools: [tool],
        signal: batchDone.signal,
        maxTurns: TURNS_PER_BATCH,
        contextWindow: state.plan.contextWindow,
        compact: false,
        onUsage,
        source: "assets",
      })) {
        if (event.type === "error" && !batchDone.signal.aborted) {
          error = event.message;
        }
      }
    } catch (err) {
      error = getErrorMessage(err, "The annotation failed");
    } finally {
      state.controller.signal.removeEventListener("abort", stopBatch);
    }
    // Only what this batch annotated in full forgets its old suggestions.
    await repo.pruneAiDependsOn(
      batch.members
        .filter((member) => done.has(member.asset.key))
        .map((member) => member.asset.id),
      keep,
    );
    await repo.persist();
    return { annotated: done.size, error, missed: done.size < byKey.size };
  }

  async function run(trigger: RunTrigger, all: boolean): Promise<void> {
    const userId = await deps.collector();
    const refused = await refusal(userId);
    if (refused) {
      const runId = await repo.startRun(trigger, 0, "annotate");
      await repo.finishRun(runId, {
        status: "failed",
        hostsOk: 0,
        hostsFailed: 0,
        errors: { run: refused },
      });
      return;
    }
    await ctx.asUser(userId!, () => annotate(userId!, trigger, all));
  }

  async function annotate(
    userId: string,
    trigger: RunTrigger,
    all: boolean,
  ): Promise<void> {
    const edges = await repo.listEdges();
    const units = buildUnits(
      await repo.listAssets(),
      edges,
      await hostMeta(userId),
    );
    const selected = selectUnits(units, edges, all);
    const total = selected.reduce((sum, unit) => sum + unit.members.length, 0);
    const runId = await repo.startRun(trigger, total, "annotate");
    const finish = async (
      status: "done" | "failed",
      ok: number,
      errors: Record<string, string>,
      tokens = 0,
    ) => {
      await repo.finishRun(runId, {
        status,
        hostsOk: ok,
        hostsFailed: total - ok,
        errors,
        tokens,
      });
      if (status === "failed") {
        await notifyFailure(userId, runId, Object.values(errors)[0] ?? "");
      }
    };
    if (!total) return finish("done", 0, {});

    const chosen = await chooseProvider(userId);
    if (!chosen) {
      return finish("failed", 0, {
        run: "No AI provider: the collector has no enabled provider with a model",
      });
    }
    const controller = new AbortController();
    current = controller;
    const language = languageName(await ownerLanguage(ctx, userId));
    const system = annotationSystemPrompt(language);
    const config = await providerConfig(ctx, chosen.provider);
    const plan = await contextPlanFor(
      deps.modelInfo,
      chosen.provider,
      config,
      chosen.model,
    ).catch(() =>
      planContext({
        model: chosen.model,
        overrides: {},
        info: {},
        adapter: {},
      }),
    );
    // The system prompt and the tool's schema come with every call.
    const overhead = estimateTokens(system) + 1_000;
    const batches = batchUnits(selected, batchLimits(plan, overhead));
    const state: RunState = {
      userId,
      provider: chosen.provider,
      config,
      model: chosen.model,
      plan,
      system,
      budget: await readRunTokens(),
      tokens: 0,
      stop: null,
      controller,
    };

    let ok = 0;
    const errors: Record<string, string> = {};
    try {
      for (const batch of batches) {
        if (controller.signal.aborted) break;
        const result = await annotateBatch(state, batch);
        ok += result.annotated;
        // A full run takes half an hour on a self-hosted model; without
        // this the run read 0 of 348 and 0 tokens until the very end.
        await repo.progressRun(runId, { hostsOk: ok, tokens: state.tokens });
        const first = batch.members[0].asset.key;
        if (result.error) {
          errors[first] = result.error;
          // A provider that fails one call will fail the next ones too.
          break;
        }
        if (result.missed && !controller.signal.aborted) {
          errors[first] = "The model left assets of this batch unannotated";
        }
      }
    } catch (error) {
      errors.run = getErrorMessage(error, "The annotation failed");
    } finally {
      current = null;
    }
    if (controller.signal.aborted) {
      errors.run = state.stop ?? String(controller.signal.reason ?? "Stopped");
    }
    const failed = controller.signal.aborted || Object.keys(errors).length > 0;
    await finish(failed ? "failed" : "done", ok, errors, state.tokens);
    await ctx.audit
      .record({
        action: "ai_assets_annotate",
        details: JSON.stringify({ trigger, all, assets: total, annotated: ok }),
        success: !failed,
      })
      .catch(() => undefined);
  }

  async function drain(): Promise<void> {
    while (pending && !closed) {
      const next = pending;
      pending = null;
      await run(next.trigger, next.all).catch((error) =>
        ctx.log.warn(`Asset annotation failed: ${error}`),
      );
    }
  }

  const service = {
    running: () => active !== null,

    /** Starts a run, or queues one behind the run in progress. */
    request(trigger: RunTrigger, all = false): "started" | "queued" {
      const queued = active !== null;
      pending = { trigger, all: all || !!pending?.all };
      if (!active) {
        active = drain().finally(() => {
          active = null;
        });
      }
      return queued ? "queued" : "started";
    },

    /** Called after a collection: annotate what changed, unless turned off. */
    async afterCollect(): Promise<void> {
      if (
        (await ctx.settings.get<boolean>(ANNOTATE_SETTINGS.afterCollect)) ===
        false
      ) {
        return;
      }
      service.request("collection");
    },

    /** The kill switch: stops the run in progress; queued ones still check. */
    stop(reason: string): void {
      if (!current) return;
      current.abort(reason);
    },

    /** The collector's enabled providers, for the settings picker. */
    async providers(): Promise<
      Array<{ id: number; label: string; defaultModel: string | null }>
    > {
      const userId = await deps.collector();
      if (!userId) return [];
      return (await deps.repository.listProviders(userId))
        .filter((provider) => provider.enabled)
        .map(({ id, label, defaultModel }) => ({ id, label, defaultModel }));
    },

    async idle(): Promise<void> {
      while (active) await active;
    },

    close(): void {
      closed = true;
      pending = null;
      current?.abort();
    },
  };
  return service;
}
