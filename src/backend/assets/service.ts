import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { getErrorMessage } from "../errors.js";
import { isAiGloballyEnabled } from "../gating.js";
import { execOnHost, mapLimit } from "../ops/exec.js";
import { readOpsLimits } from "../ops/routes.js";
import { parseSections } from "./parsers.js";
import { persistOutcomes, reclassifyAll, type HostOutcome } from "./persist.js";
import type { AssetRepository, RunTrigger } from "./repository.js";
import { collectionScript, splitSections } from "./script.js";

/**
 * Runs collections one at a time.
 *
 * Collection runs as one user, the collector, through ctx.asUser, so it
 * reaches exactly the hosts that user can connect to. The collector is a
 * plugin setting; while it is unset, the first holder of ai.assets.manage
 * who starts a collection becomes it. Automatic runs (the daily one, host
 * events) need a collector who still holds ai.assets.manage, and the admin
 * switch for the AI plugin on.
 *
 * Whatever arrives during a run waits: a full run asked for is done next,
 * and host events are gathered into one run for those hosts, or folded into
 * the full run when one is due anyway.
 */

export const SETTINGS = {
  daily: "assetsDailyCollect",
  time: "assetsCollectTime",
  collector: "assetsCollector",
} as const;

export const DEFAULT_TIME = "03:00";
/** Characters of script output kept per host; facts are cut after parsing. */
const OUTPUT_LIMIT = 4_000_000;

export function parseTime(
  raw: unknown,
): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(raw ?? "").trim());
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

/** Today's slot in UTC for a "HH:MM" setting. */
export function dailySlot(time: unknown, at: number): Date {
  const { hour, minute } = parseTime(time) ?? parseTime(DEFAULT_TIME)!;
  const slot = new Date(at);
  slot.setUTCHours(hour, minute, 0, 0);
  return slot;
}

export type AssetService = ReturnType<typeof createAssetService>;

export function createAssetService(
  ctx: PluginContext,
  repo: AssetRepository,
  hooks: {
    afterCollect?: (outcomes: HostOutcome[], userId: string) => Promise<void>;
  } = {},
) {
  let pendingFull: RunTrigger | null = null;
  const pendingHosts = new Set<number>();
  const pendingRemovals = new Set<number>();
  let active: Promise<void> | null = null;
  const controller = new AbortController();

  const collector = async (): Promise<string | null> => {
    const value = await ctx.settings.get<string>(SETTINGS.collector);
    return typeof value === "string" && value ? value : null;
  };

  async function collectOne(
    host: { id: number; name: string | null; ip: string },
    limits: Awaited<ReturnType<typeof readOpsLimits>>,
  ): Promise<HostOutcome> {
    const outcome: HostOutcome = {
      hostId: host.id,
      name: host.name || host.ip,
      address: host.ip,
    };
    const access = await ctx.hosts.checkAccess(host.id, "connect");
    if (!access.hasAccess) return { ...outcome, error: "No access" };
    const result = await execOnHost(ctx, host.id, collectionScript(), {
      timeoutMs: limits.timeoutSec * 1000,
      outputLimit: OUTPUT_LIMIT,
      signal: controller.signal,
    });
    if (result.error) return { ...outcome, error: result.error };
    if (result.timedOut) {
      return { ...outcome, error: `Timed out after ${limits.timeoutSec}s` };
    }
    const { sections, complete } = splitSections(result.output);
    if (!Object.keys(sections).length) {
      const firstLine = result.output.trim().split("\n")[0] ?? "";
      return {
        ...outcome,
        error: `No output (exit ${result.exitCode})${firstLine ? `: ${firstLine.slice(0, 200)}` : ""}`,
      };
    }
    return { ...outcome, facts: parseSections(sections), complete };
  }

  /** One run, over every host the collector sees or just `hostIds`. */
  async function collect(
    trigger: RunTrigger,
    hostIds: number[] | null,
  ): Promise<void> {
    const userId = await collector();
    if (!userId) return;
    if (!(await ctx.rbac.hasFor(userId, "assets.manage"))) {
      const runId = await repo.startRun(trigger, 0);
      await repo.finishRun(runId, {
        status: "failed",
        hostsOk: 0,
        hostsFailed: 0,
        errors: { collector: "The collector no longer holds ai.assets.manage" },
      });
      return;
    }
    const limits = await readOpsLimits(ctx.settings);
    const visible = await ctx.asUser(userId, () => ctx.hosts.list());
    const hosts = hostIds
      ? visible.filter((host) => hostIds.includes(host.id))
      : visible;
    // A host event for a host the collector cannot see: nothing to do.
    if (hostIds && !hosts.length) return;

    const runId = await repo.startRun(trigger, hosts.length);
    try {
      const outcomes = (
        await ctx.asUser(userId, () =>
          mapLimit(hosts, limits.concurrency, controller.signal, (host) =>
            collectOne(host, limits),
          ),
        )
      ).filter((outcome): outcome is HostOutcome => outcome !== undefined);
      await persistOutcomes(repo, outcomes);
      const errors = Object.fromEntries(
        outcomes
          .filter((outcome) => outcome.error)
          .map((outcome) => [String(outcome.hostId), outcome.error!]),
      );
      const failed = Object.keys(errors).length;
      await repo.finishRun(runId, {
        status: "done",
        hostsOk: outcomes.length - failed,
        hostsFailed: failed,
        errors,
      });
      await ctx.audit
        .record({
          action: "ai_assets_collect",
          details: JSON.stringify({ trigger, hosts: hosts.length, failed }),
          success: true,
        })
        .catch(() => undefined);
      await hooks.afterCollect?.(outcomes, userId);
    } catch (error) {
      ctx.log.warn(`Asset collection failed: ${error}`);
      await repo.finishRun(runId, {
        status: "failed",
        hostsOk: 0,
        hostsFailed: hosts.length,
        errors: { run: getErrorMessage(error, "Collection failed") },
      });
    }
  }

  const hasPending = () =>
    !!pendingFull || pendingHosts.size > 0 || pendingRemovals.size > 0;

  async function drain(): Promise<void> {
    while (hasPending() && !controller.signal.aborted) {
      const removals = [...pendingRemovals];
      pendingRemovals.clear();
      for (const hostId of removals) await repo.removeHost(hostId);

      const full = pendingFull;
      const hosts = [...pendingHosts];
      pendingFull = null;
      pendingHosts.clear();
      if (full) await collect(full, null);
      else if (hosts.length) await collect("host_event", hosts);
    }
  }

  function kick(): void {
    if (active) return;
    active = drain()
      .catch((error) => ctx.log.warn(`Asset collection failed: ${error}`))
      .finally(() => {
        active = null;
        if (hasPending() && !controller.signal.aborted) kick();
      });
  }

  const service = {
    running: () => active !== null,

    /** Starts a full run, or queues one behind the run in progress. */
    requestFull(trigger: RunTrigger): "started" | "queued" {
      const queued = active !== null;
      pendingFull ??= trigger;
      kick();
      return queued ? "queued" : "started";
    },

    requestHost(hostId: number): void {
      pendingRemovals.delete(hostId);
      pendingHosts.add(hostId);
      kick();
    },

    hostRemoved(hostId: number): void {
      pendingHosts.delete(hostId);
      pendingRemovals.add(hostId);
      kick();
    },

    collector,

    /** Who collects, set by the first manager to start a collection. */
    async adoptCollector(userId: string): Promise<string> {
      const current = await collector();
      if (current) return current;
      await ctx.settings.set(SETTINGS.collector, userId);
      return userId;
    },

    /** Automatic runs only happen with the plugin on and a collector set. */
    async automaticAllowed(): Promise<boolean> {
      return (await isAiGloballyEnabled(ctx.settings)) && !!(await collector());
    },

    /** Called every minute: the daily run once its time has come. */
    async tick(at = Date.now()): Promise<void> {
      if ((await ctx.settings.get<boolean>(SETTINGS.daily)) === false) return;
      if (!(await service.automaticAllowed())) return;
      const slot = dailySlot(await ctx.settings.get(SETTINGS.time), at);
      if (at < slot.getTime()) return;
      if (active || pendingFull) return;
      if (await repo.hasRunSince("schedule", slot.toISOString())) return;
      service.requestFull("schedule");
    },

    reclassify: () => reclassifyAll(repo),

    /** Resolves once nothing is running or queued. For tests and shutdown. */
    async idle(): Promise<void> {
      while (active) await active;
    },

    close(): void {
      controller.abort();
    },
  };
  return service;
}

/**
 * Host events from core. host.created is newer than the others: listening
 * to a topic nobody publishes is harmless, and a core without it just leaves
 * new hosts to the next full run.
 */
export function subscribeHostEvents(
  ctx: PluginContext,
  service: AssetService,
): void {
  const hostId = (payload: unknown) => {
    const id = Number((payload as { hostId?: unknown } | null)?.hostId);
    return Number.isInteger(id) && id > 0 ? id : null;
  };
  const onChange = (payload: unknown) => {
    const id = hostId(payload);
    if (id === null) return;
    void service
      .automaticAllowed()
      .then((allowed) => allowed && service.requestHost(id));
  };
  const subscriptions: Array<[string, (payload: unknown) => void]> = [
    ["host.created", onChange],
    ["host.updated", onChange],
    [
      "host.deleted",
      (payload) => {
        const id = hostId(payload);
        if (id !== null) service.hostRemoved(id);
      },
    ],
  ];
  for (const [topic, listener] of subscriptions) {
    try {
      ctx.disposables.add(ctx.events.on(topic, listener));
    } catch (error) {
      ctx.log.warn(`Not listening to ${topic}: ${error}`);
    }
  }
}
