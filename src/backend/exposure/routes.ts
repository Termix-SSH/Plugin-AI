import type { AssetRecord } from "../assets/repository.js";
import type { Entry } from "./types.js";
import type { Router, Request, Response } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createAiGate, resolveAiAccess } from "../gating.js";
import {
  ageEntries,
  bindCurrentHosts,
  fingerprint,
  internetRelevant,
  entryIdentity,
  linkPaths,
} from "./derive.js";
import { canSee, visibleHosts } from "./service.js";
import type { ExposureRepository } from "./repository.js";
export function registerExposureRoutes(
  router: Router,
  ctx: PluginContext,
  repo: ExposureRepository,
  explain?: (entry: Entry, signal: AbortSignal) => Promise<string>,
  inventory: () => Promise<AssetRecord[]> = async () => [],
) {
  const currentEntries = async () =>
    linkPaths(
      ageEntries(bindCurrentHosts(await repo.listEntries(), await inventory())),
    );
  router.use(
    "/assets/exposure",
    ctx.rbac.require("assets.view") as never,
    createAiGate(ctx.settings, () => ctx.currentActor()),
  );
  router.get("/assets/exposure", async (req: Request, res: Response) => {
    const hosts = await visibleHosts(ctx);
    const linked = await currentEntries();
    const entries = linked.filter((e) => canSee(e, hosts));
    const latest = new Map<
      string,
      {
        hostId: number;
        source: string;
        at: string;
        status: string;
        complete: boolean;
        issues: Array<{ objectKey: string; reason: string }>;
      }
    >();
    for (const o of await repo.listObservations()) {
      if (!hosts.has(o.hostId)) continue;
      const key = `${o.hostId}:${o.source}:${o.ownerId}`;
      if (!latest.has(key) || latest.get(key)!.at < o.at)
        latest.set(key, {
          hostId: o.hostId,
          source: o.source,
          at: o.at,
          status: o.status,
          complete: o.complete,
          issues: o.issues ?? [],
        });
    }
    const assets = await inventory();
    const changes = (await repo.listChanges())
      .map((change) => ({
        ...change,
        before: change.before
          ? bindCurrentHosts([change.before], assets)[0]
          : null,
        after: change.after
          ? bindCurrentHosts([change.after], assets)[0]
          : null,
      }))
      .filter(
        (c) =>
          hosts.has(c.hostId) &&
          (!c.before || canSee(c.before, hosts)) &&
          (!c.after || canSee(c.after, hosts)) &&
          (!c.after ||
            !linked.some(
              (e) => e.key === entryIdentity(c.after!) && !canSee(e, hosts),
            )),
      )
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 200);
    const query = String(req.query.q ?? "")
      .slice(0, 250)
      .toLowerCase();
    const filtered = entries.filter(
      (e) =>
        (req.query.scope === "all" ||
          (req.query.scope === "unknown"
            ? e.binding === "unknown"
            : internetRelevant(e))) &&
        (!req.query.priority || e.priority === req.query.priority) &&
        (!req.query.zone || e.zone === req.query.zone) &&
        (!req.query.source || e.source === req.query.source) &&
        (req.query.state === "all" ||
          (req.query.state === "stale"
            ? !!e.staleAt && !e.resolvedAt
            : req.query.state === "resolved"
              ? !!e.resolvedAt
              : !e.resolvedAt)) &&
        JSON.stringify([
          e.endpoint,
          e.bindings,
          e.backend,
          e.hostname,
          e.path,
          e.sourceHostId,
          e.paths,
        ])
          .toLowerCase()
          .includes(query),
    );
    const rank = { high: 0, medium: 1, low: 2 };
    filtered.sort(
      (a, b) =>
        rank[a.priority] - rank[b.priority] ||
        a.sourceHostId - b.sourceHostId ||
        a.key.localeCompare(b.key),
    );
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const limit = Math.min(
      200,
      Math.max(1, Math.floor(Number(req.query.limit) || 100)),
    );
    res.json({
      entries: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      summary: {
        all: entries.filter((e) => !e.resolvedAt).length,
        internet: entries.filter((e) => !e.resolvedAt && internetRelevant(e))
          .length,
        unknown: entries.filter((e) => !e.resolvedAt && e.binding === "unknown")
          .length,
      },
      zones: [
        ...new Set(entries.flatMap((e) => (e.zone ? [e.zone] : []))),
      ].sort(),
      coverage: [...latest.values()],
      changes,
    });
  });
  router.post(
    "/assets/exposure/:key/explain",
    ctx.rbac.require("assets.manage") as never,
    async (req: Request, res: Response) => {
      const hosts = await visibleHosts(ctx);
      const entry = (await currentEntries()).find(
        (e) => e.key === req.params.key && canSee(e, hosts),
      );
      if (!entry) {
        res.status(404).json({ error: "Entry not found" });
        return;
      }
      if (!explain) {
        res.status(503).json({ error: "Explanation unavailable" });
        return;
      }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      res.on("close", cancel);
      try {
        const text = await explain(entry, controller.signal);
        const current = (await currentEntries()).find(
          (e) => e.key === entry.key,
        );
        const stillVisible = await visibleHosts(ctx);
        if (
          !(await resolveAiAccess(ctx.settings, ctx.currentActor())).enabled ||
          !(await ctx.rbac.has("assets.view")) ||
          !(await ctx.rbac.has("assets.manage")) ||
          !current ||
          !canSee(current, stillVisible) ||
          !canSee(entry, stillVisible)
        ) {
          res.status(404).json({ error: "Entry no longer available" });
          return;
        }
        if (
          fingerprint([current.hops, current.paths, current.bindings]) !==
            fingerprint([entry.hops, entry.paths, entry.bindings]) ||
          current.fingerprint !== entry.fingerprint ||
          current.staleAt !== entry.staleAt ||
          current.resolvedAt !== entry.resolvedAt ||
          current.pathStatus !== entry.pathStatus
        ) {
          res
            .status(409)
            .json({ error: "Evidence changed; request a new explanation" });
          return;
        }
        res.json({
          text,
          verification: "not_tested",
          source: "ai",
          observationId: entry.observationId,
        });
      } catch {
        if (!res.destroyed)
          res.status(503).json({ error: "Explanation failed or unavailable" });
      } finally {
        res.off("close", cancel);
      }
    },
  );
  router.put(
    "/assets/exposure/:key/priority",
    ctx.rbac.require("assets.manage") as never,
    async (req: Request, res: Response) => {
      const hosts = await visibleHosts(ctx);
      const entry = (await currentEntries()).find(
        (e) => e.key === req.params.key && canSee(e, hosts),
      );
      if (!entry) {
        res.status(404).json({ error: "Entry not found" });
        return;
      }
      const priority = req.body?.priority;
      if (priority !== null && !["high", "medium", "low"].includes(priority)) {
        res.status(400).json({ error: "Invalid priority" });
        return;
      }
      await ctx.audit.record({
        action: "ai_exposure_priority",
        resourceType: "exposure",
        resourceId: entry.key,
        details: JSON.stringify({ priority }),
        success: true,
      });
      await repo.override(entry.key, priority);
      res.json({ ok: true });
    },
  );
}
