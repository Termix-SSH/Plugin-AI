import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createAiGate } from "../gating.js";
import { ANNOTATE_SETTINGS, type AnnotationService } from "./annotate.js";
import { registerAnnotationRoutes } from "./annotate-routes.js";
import { parseCidr } from "./net.js";
import type { AssetRecord, AssetRepository, EdgeRecord } from "./repository.js";
import {
  DEFAULT_TIME,
  parseTime,
  SETTINGS,
  type AssetService,
} from "./service.js";
import { ZONE_KINDS, type ZoneKind } from "./zones.js";

/**
 * The asset inventory, under /plugin-api/ai/assets behind ai.assets.view and
 * the AI gate. Zones, pinning, collecting, annotating and the settings need
 * ai.assets.manage.
 */

const BUILTIN_ZONES: ZoneKind[] = ["internal", "external", "cloud", "overlay"];

function parseId(raw: unknown): number | null {
  const id = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

/** What the table shows of an asset: counts instead of the facts. */
function listItem(asset: AssetRecord) {
  const { facts, ...rest } = asset;
  const connections = Array.isArray(facts?.connections)
    ? (facts.connections as Array<{ direction?: string }>)
    : [];
  const os = facts?.os as { pretty?: string } | undefined;
  return {
    ...rest,
    os: os?.pretty ?? null,
    counts: {
      listening: count(facts?.listening),
      outbound: connections.filter((entry) => entry.direction === "out").length,
      services: count(facts?.services),
      containers: count(facts?.containers),
    },
  };
}

function matches(asset: AssetRecord, query: string): boolean {
  const needle = query.toLowerCase();
  return [asset.name, asset.key, ...asset.ips].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

/** A zone rule from a request body, or the reason it is not one. */
function parseZoneBody(
  body: Record<string, unknown>,
  partial: boolean,
): { value: Record<string, unknown> } | { error: string } {
  const value: Record<string, unknown> = {};
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) return { error: "name is required" };
    value.name = name;
  }
  if (body.kind !== undefined || !partial) {
    if (!ZONE_KINDS.includes(body.kind as ZoneKind)) {
      return { error: `kind must be one of ${ZONE_KINDS.join(", ")}` };
    }
    value.kind = body.kind;
  }
  if (body.cidr !== undefined || !partial) {
    const cidr = typeof body.cidr === "string" ? body.cidr.trim() : "";
    if (!parseCidr(cidr) || !cidr.includes("/")) {
      return { error: "cidr must look like 10.0.0.0/8" };
    }
    value.cidr = cidr;
  }
  if (body.priority !== undefined || !partial) {
    const priority = Number(body.priority ?? 0);
    if (!Number.isInteger(priority) || Math.abs(priority) > 1000) {
      return { error: "priority must be a whole number from -1000 to 1000" };
    }
    value.priority = priority;
  }
  return { value };
}

export function registerAssetRoutes(
  router: Router,
  ctx: PluginContext,
  repo: AssetRepository,
  service: AssetService,
  annotation: AnnotationService,
): void {
  const gate = createAiGate(ctx.settings, () => ctx.currentActor());
  router.use(
    "/assets",
    ctx.rbac.require("assets.view") as never,
    gate as never,
  );
  const manage = ctx.rbac.require("assets.manage") as never;
  const actor = () => ctx.currentActor() as string;
  // Before /assets/:id, which would take "graph" for an id.
  registerAnnotationRoutes(router, repo, service, annotation, manage, actor);

  /**
   * @openapi
   * /plugin-api/ai/assets:
   *   get:
   *     summary: The asset inventory
   *     description: >
   *       Hosts, Proxmox guests, containers and external addresses, with
   *       their zone and counts of what was collected. Removed assets are
   *       left out unless includeRemoved is set.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: query
   *         name: zone
   *         schema:
   *           type: string
   *       - in: query
   *         name: kind
   *         schema:
   *           type: string
   *           enum: [host, guest, container, external]
   *       - in: query
   *         name: q
   *         description: Matches name, key or an address.
   *         schema:
   *           type: string
   *       - in: query
   *         name: includeRemoved
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: The assets.
   *       403:
   *         description: Missing ai.assets.view, or the assistant is off.
   */
  router.get("/assets", async (req: Request, res: Response) => {
    const text = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const q = text(req.query.q);
    const assets = await repo.listAssets({
      zone: text(req.query.zone),
      kind: text(req.query.kind),
      includeRemoved: ["1", "true"].includes(String(req.query.includeRemoved)),
    });
    res.json({
      assets: assets.filter((asset) => !q || matches(asset, q)).map(listItem),
    });
  });

  /**
   * @openapi
   * /plugin-api/ai/assets/edges:
   *   get:
   *     summary: Relations between assets
   *     description: >
   *       runs_on and connects_to edges with their evidence. An edge whose
   *       lastSeen is older than its source's last collection was not seen
   *       again and is stale.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: query
   *         name: type
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The edges.
   */
  router.get("/assets/edges", async (req: Request, res: Response) => {
    const type = typeof req.query.type === "string" ? req.query.type : "";
    res.json({ edges: await repo.listEdges({ type: type || undefined }) });
  });

  /**
   * @openapi
   * /plugin-api/ai/assets/zones:
   *   get:
   *     summary: CIDR zone rules and the built-in zones
   *     tags:
   *       - AI
   *     responses:
   *       200:
   *         description: The rules, and the built-in zone names.
   *   post:
   *     summary: Add a CIDR zone rule
   *     description: >
   *       Rules come before the built-in ones. The most specific prefix
   *       wins, then the higher priority. Every asset not pinned is zoned
   *       again.
   *     tags:
   *       - AI
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name, kind, cidr]
   *             properties:
   *               name:
   *                 type: string
   *               kind:
   *                 type: string
   *                 enum: [internal, dmz, external, cloud, overlay]
   *               cidr:
   *                 type: string
   *               priority:
   *                 type: integer
   *     responses:
   *       201:
   *         description: The rule.
   *       400:
   *         description: Invalid field.
   *       403:
   *         description: Missing ai.assets.manage.
   */
  router.get("/assets/zones", async (_req: Request, res: Response) => {
    res.json({ zones: await repo.listZones(), builtin: BUILTIN_ZONES });
  });

  router.post("/assets/zones", manage, async (req: Request, res: Response) => {
    const parsed = parseZoneBody(req.body ?? {}, false);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const zone = await repo.createZone({
      ...(parsed.value as {
        name: string;
        kind: ZoneKind;
        cidr: string;
        priority: number;
      }),
      createdBy: actor(),
    });
    await service.reclassify();
    res.status(201).json({ zone });
  });

  /**
   * @openapi
   * /plugin-api/ai/assets/zones/{id}:
   *   put:
   *     summary: Change a CIDR zone rule
   *     description: Fields left out keep their value.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The rule.
   *       400:
   *         description: Invalid field.
   *       404:
   *         description: No such rule.
   *   delete:
   *     summary: Remove a CIDR zone rule
   *     tags:
   *       - AI
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       204:
   *         description: Removed.
   *       404:
   *         description: No such rule.
   */
  router.put(
    "/assets/zones/:id",
    manage,
    async (req: Request, res: Response) => {
      const id = parseId(req.params.id);
      if (!id || !(await repo.findZone(id))) return res.sendStatus(404);
      const parsed = parseZoneBody(req.body ?? {}, true);
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }
      const zone = await repo.updateZone(id, parsed.value);
      await service.reclassify();
      res.json({ zone });
    },
  );

  router.delete(
    "/assets/zones/:id",
    manage,
    async (req: Request, res: Response) => {
      const id = parseId(req.params.id);
      if (!id || !(await repo.deleteZone(id))) return res.sendStatus(404);
      await service.reclassify();
      res.sendStatus(204);
    },
  );

  /**
   * @openapi
   * /plugin-api/ai/assets/collect:
   *   post:
   *     summary: Collect now
   *     description: >
   *       Runs over every host the collector can connect to, or queues
   *       behind the run in progress. With no collector set yet, the caller
   *       becomes it.
   *     tags:
   *       - AI
   *     responses:
   *       202:
   *         description: started or queued.
   *       403:
   *         description: Missing ai.assets.manage.
   */
  router.post("/assets/collect", manage, async (_req, res: Response) => {
    const collector = await service.adoptCollector(actor());
    const status = service.requestFull("manual");
    res.status(202).json({ status, collectorIsMe: collector === actor() });
  });

  /**
   * @openapi
   * /plugin-api/ai/assets/runs:
   *   get:
   *     summary: Recent collection runs
   *     description: Newest first, with per-host errors and whether one is running.
   *     tags:
   *       - AI
   *     responses:
   *       200:
   *         description: The runs.
   */
  router.get("/assets/runs", async (_req, res: Response) => {
    res.json({ runs: await repo.listRuns(20), running: service.running() });
  });

  const readSettings = async () => {
    const collector = await service.collector();
    const time = await ctx.settings.get<string>(SETTINGS.time);
    return {
      dailyEnabled: (await ctx.settings.get<boolean>(SETTINGS.daily)) !== false,
      dailyTime: parseTime(time) ? String(time) : DEFAULT_TIME,
      collectorSet: !!collector,
      collectorIsMe: collector === actor(),
      annotateAfterCollect:
        (await ctx.settings.get<boolean>(ANNOTATE_SETTINGS.afterCollect)) !==
        false,
      annotateProviderId:
        parseId(await ctx.settings.get(ANNOTATE_SETTINGS.provider)) ?? null,
      annotateModel:
        (await ctx.settings.get<string>(ANNOTATE_SETTINGS.model)) || null,
      annotateProviders: await annotation.providers(),
    };
  };

  /**
   * @openapi
   * /plugin-api/ai/assets/settings:
   *   get:
   *     summary: The daily collection and who collects
   *     tags:
   *       - AI
   *     responses:
   *       200:
   *         description: The settings.
   *   put:
   *     summary: Change the daily collection, the annotation, or collect as yourself
   *     description: >
   *       dailyTime is HH:MM in UTC. collector "me" makes the caller the
   *       collector, so collection reaches the hosts they can connect to;
   *       nobody can name another user. annotateProviderId is one of the
   *       collector's providers, null for the one their auto-ops tasks use;
   *       annotateModel null for that provider's default model.
   *     tags:
   *       - AI
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               dailyEnabled:
   *                 type: boolean
   *               dailyTime:
   *                 type: string
   *               collector:
   *                 type: string
   *                 enum: [me]
   *               annotateAfterCollect:
   *                 type: boolean
   *               annotateProviderId:
   *                 type: integer
   *                 nullable: true
   *               annotateModel:
   *                 type: string
   *                 nullable: true
   *     responses:
   *       200:
   *         description: The settings.
   *       400:
   *         description: Invalid field.
   *       403:
   *         description: Missing ai.assets.manage.
   */
  router.get("/assets/settings", async (_req, res: Response) => {
    res.json({ settings: await readSettings() });
  });

  router.put(
    "/assets/settings",
    manage,
    async (req: Request, res: Response) => {
      const body = req.body ?? {};
      if (
        body.dailyEnabled !== undefined &&
        typeof body.dailyEnabled !== "boolean"
      ) {
        return res
          .status(400)
          .json({ error: "dailyEnabled must be a boolean" });
      }
      if (body.dailyTime !== undefined && !parseTime(body.dailyTime)) {
        return res.status(400).json({ error: "dailyTime must be HH:MM" });
      }
      if (body.collector !== undefined && body.collector !== "me") {
        return res.status(400).json({ error: 'collector can only be "me"' });
      }
      if (
        body.annotateAfterCollect !== undefined &&
        typeof body.annotateAfterCollect !== "boolean"
      ) {
        return res
          .status(400)
          .json({ error: "annotateAfterCollect must be a boolean" });
      }
      if (
        body.annotateProviderId !== undefined &&
        body.annotateProviderId !== null &&
        !(await annotation.providers()).some(
          (provider) => provider.id === body.annotateProviderId,
        )
      ) {
        return res.status(400).json({
          error: "annotateProviderId must be one of the collector's providers",
        });
      }
      if (
        body.annotateModel !== undefined &&
        body.annotateModel !== null &&
        (typeof body.annotateModel !== "string" ||
          body.annotateModel.length > 200)
      ) {
        return res.status(400).json({ error: "annotateModel must be text" });
      }
      if (body.dailyEnabled !== undefined) {
        await ctx.settings.set(SETTINGS.daily, body.dailyEnabled);
      }
      if (body.dailyTime !== undefined) {
        await ctx.settings.set(SETTINGS.time, String(body.dailyTime).trim());
      }
      if (body.collector === "me") {
        await ctx.settings.set(SETTINGS.collector, actor());
      }
      if (body.annotateAfterCollect !== undefined) {
        await ctx.settings.set(
          ANNOTATE_SETTINGS.afterCollect,
          body.annotateAfterCollect,
        );
      }
      if (body.annotateProviderId !== undefined) {
        await ctx.settings.set(
          ANNOTATE_SETTINGS.provider,
          body.annotateProviderId ?? 0,
        );
      }
      if (body.annotateModel !== undefined) {
        await ctx.settings.set(
          ANNOTATE_SETTINGS.model,
          (body.annotateModel ?? "").trim(),
        );
      }
      res.json({ settings: await readSettings() });
    },
  );

  /**
   * @openapi
   * /plugin-api/ai/assets/{id}:
   *   get:
   *     summary: One asset with its facts and edges
   *     description: >
   *       facts is the parsed collection, by section. outgoing and incoming
   *       are its edges, each with the asset at the other end.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The asset.
   *       404:
   *         description: No such asset.
   */
  router.get("/assets/:id", async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    const asset = id ? await repo.findAsset(id) : null;
    if (!asset) return res.sendStatus(404);
    const edges = await repo.listEdges({ assetId: asset.id });
    const others = await repo.findByIds([
      ...new Set(edges.flatMap((edge) => [edge.fromAsset, edge.toAsset])),
    ]);
    const peer = (otherId: number) => {
      const other = others.find((entry) => entry.id === otherId);
      return other
        ? { id: other.id, key: other.key, kind: other.kind, name: other.name }
        : null;
    };
    const withPeer = (edge: EdgeRecord, otherId: number) => ({
      ...edge,
      peer: peer(otherId),
    });
    res.json({
      asset,
      outgoing: edges
        .filter((edge) => edge.fromAsset === asset.id)
        .map((edge) => withPeer(edge, edge.toAsset)),
      incoming: edges
        .filter((edge) => edge.toAsset === asset.id)
        .map((edge) => withPeer(edge, edge.fromAsset)),
    });
  });

  /**
   * @openapi
   * /plugin-api/ai/assets/{id}/zone:
   *   put:
   *     summary: Pin an asset's zone, or hand it back to the rules
   *     description: >
   *       A pinned zone is kept by every later collection. zone null unpins
   *       it; the rules decide again at once.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               zone:
   *                 type: string
   *                 nullable: true
   *     responses:
   *       200:
   *         description: The asset.
   *       400:
   *         description: Not a known zone.
   *       404:
   *         description: No such asset.
   */
  router.put(
    "/assets/:id/zone",
    manage,
    async (req: Request, res: Response) => {
      const id = parseId(req.params.id);
      const asset = id ? await repo.findAsset(id) : null;
      if (!asset) return res.sendStatus(404);
      const zone = req.body?.zone;
      if (zone !== null) {
        const known: string[] = [
          ...ZONE_KINDS,
          ...(await repo.listZones()).map((rule) => rule.name),
        ];
        if (typeof zone !== "string" || !known.includes(zone)) {
          return res.status(400).json({ error: "Not a known zone" });
        }
      }
      await repo.pinZone(asset.id, zone);
      if (zone === null) await service.reclassify();
      res.json({ asset: await repo.findAsset(asset.id) });
    },
  );
}
