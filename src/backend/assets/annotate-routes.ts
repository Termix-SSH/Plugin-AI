import type { Request, Response, Router } from "express";
import type { AnnotationService } from "./annotate.js";
import { GRAPH_EDGE_TYPES, graphPayload } from "./graph.js";
import { impactOf } from "./impact.js";
import {
  ANNOTATION_FIELDS,
  IMPORTANCES,
  type AnnotationField,
  type AnnotationWrite,
  type AssetRepository,
  type Importance,
} from "./repository.js";
import type { AssetService } from "./service.js";

/**
 * Annotations, impact and the graph, mounted by registerAssetRoutes behind
 * its ai.assets.view and AI gate. Editing, unlocking and annotating need
 * ai.assets.manage, passed in as `manage`.
 */

function parseId(raw: unknown): number | null {
  const id = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const LIMITS = { role: 160, importanceReason: 300, system: 120 };

/** A user's annotation from a request body, or why it is not one. */
export function parseAnnotationBody(
  body: Record<string, unknown>,
): { value: AnnotationWrite } | { error: string } {
  const value: AnnotationWrite = {};
  const optionalText = (key: keyof typeof LIMITS) => {
    const raw = body[key];
    if (raw === undefined) return undefined;
    if (raw !== null && typeof raw !== "string") return false;
    const text = String(raw ?? "").trim();
    return text.length > LIMITS[key] ? false : text || null;
  };
  for (const key of ["role", "system"] as const) {
    const text = optionalText(key);
    if (text === false) {
      return {
        error: `${key} must be text of at most ${LIMITS[key]} characters`,
      };
    }
    if (text !== undefined) value[key] = text;
  }
  if (body.importance !== undefined) {
    if (
      body.importance !== null &&
      !IMPORTANCES.includes(body.importance as Importance)
    ) {
      return { error: `importance must be one of ${IMPORTANCES.join(", ")}` };
    }
    const reason = optionalText("importanceReason");
    if (reason === false) {
      return {
        error: "importanceReason must be text of at most 300 characters",
      };
    }
    value.importance = body.importance as Importance | null;
    value.importanceReason = reason ?? null;
  }
  if (!Object.keys(value).length) {
    return { error: "Give role, importance or system" };
  }
  return { value };
}

const flag = (value: unknown) => ["1", "true"].includes(String(value));

export function registerAnnotationRoutes(
  router: Router,
  repo: AssetRepository,
  service: AssetService,
  annotation: AnnotationService,
  manage: never,
  actor: () => string,
): void {
  /**
   * @openapi
   * /plugin-api/ai/assets/graph:
   *   get:
   *     summary: The inventory as nodes and edges for the graph view
   *     description: >
   *       Live assets with their zone and annotations, and edges of the
   *       asked types between them. Containers are folded into their host
   *       (counted on it) unless containers is set; external addresses are
   *       left out unless external is set.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: query
   *         name: types
   *         description: Comma-separated edge types; all three by default.
   *         schema:
   *           type: string
   *           example: runs_on,depends_on,connects_to
   *       - in: query
   *         name: containers
   *         schema:
   *           type: boolean
   *       - in: query
   *         name: external
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: nodes and edges.
   */
  router.get("/assets/graph", async (req: Request, res: Response) => {
    const asked =
      typeof req.query.types === "string" && req.query.types.trim()
        ? req.query.types.split(",").map((type) => type.trim())
        : GRAPH_EDGE_TYPES;
    res.json(
      graphPayload(await repo.listAssets(), await repo.listEdges(), {
        types: asked.filter((type) => GRAPH_EDGE_TYPES.includes(type)),
        containers: flag(req.query.containers),
        external: flag(req.query.external),
      }),
    );
  });

  /**
   * @openapi
   * /plugin-api/ai/assets/annotate:
   *   post:
   *     summary: Annotate now
   *     description: >
   *       Runs the AI annotation as the collector, over the assets that
   *       changed since their last annotation and their neighbours, or over
   *       every asset with all. Queues behind a run in progress. With no
   *       collector set yet, the caller becomes it.
   *     tags:
   *       - AI
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               all:
   *                 type: boolean
   *     responses:
   *       202:
   *         description: started or queued.
   *       403:
   *         description: Missing ai.assets.manage.
   */
  router.post(
    "/assets/annotate",
    manage,
    async (req: Request, res: Response) => {
      await service.adoptCollector(actor());
      const status = annotation.request("manual", req.body?.all === true);
      res.status(202).json({ status });
    },
  );

  /**
   * @openapi
   * /plugin-api/ai/assets/annotation-runs:
   *   get:
   *     summary: Recent annotation runs
   *     description: >
   *       Newest first, with assets annotated, errors and the tokens each
   *       run took, and whether one is running.
   *     tags:
   *       - AI
   *     responses:
   *       200:
   *         description: The runs.
   */
  router.get("/assets/annotation-runs", async (_req, res: Response) => {
    res.json({
      runs: await repo.listRuns(20, "annotate"),
      running: annotation.running(),
    });
  });

  /**
   * @openapi
   * /plugin-api/ai/assets/{id}/impact:
   *   get:
   *     summary: What else fails when this asset does
   *     description: >
   *       Everything that runs on it or depends on it, transitively
   *       (direct and transitive), and as a weaker class what only connects
   *       to one of those. Each with the chain of edges down to this asset,
   *       and counts by importance. At most 6 hops and 300 assets per class;
   *       truncated says when that cut something off.
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
   *         description: The impact.
   *       404:
   *         description: No such asset.
   */
  router.get("/assets/:id/impact", async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    const asset = id ? await repo.findAsset(id) : null;
    if (!asset) return res.sendStatus(404);
    res.json({
      asset: { id: asset.id, key: asset.key, name: asset.name },
      ...impactOf(asset.id, await repo.listAssets(), await repo.listEdges()),
    });
  });

  /**
   * @openapi
   * /plugin-api/ai/assets/{id}/annotation:
   *   put:
   *     summary: Set an asset's role, importance or system yourself
   *     description: >
   *       Each field given is locked: annotation runs leave it alone until
   *       it is unlocked. importanceReason goes with importance.
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
   *               role:
   *                 type: string
   *                 nullable: true
   *               importance:
   *                 type: string
   *                 nullable: true
   *                 enum: [critical, high, medium, low]
   *               importanceReason:
   *                 type: string
   *                 nullable: true
   *               system:
   *                 type: string
   *                 nullable: true
   *     responses:
   *       200:
   *         description: The asset.
   *       400:
   *         description: Invalid field.
   *       403:
   *         description: Missing ai.assets.manage.
   *       404:
   *         description: No such asset.
   */
  router.put(
    "/assets/:id/annotation",
    manage,
    async (req: Request, res: Response) => {
      const id = parseId(req.params.id);
      const asset = id ? await repo.findAsset(id) : null;
      if (!asset) return res.sendStatus(404);
      const parsed = parseAnnotationBody(req.body ?? {});
      if ("error" in parsed) {
        return res.status(400).json({ error: parsed.error });
      }
      await repo.setUserAnnotation(asset.id, parsed.value);
      res.json({ asset: await repo.findAsset(asset.id) });
    },
  );

  /**
   * @openapi
   * /plugin-api/ai/assets/{id}/annotation/{field}:
   *   delete:
   *     summary: Unlock a field for the annotation
   *     description: >
   *       The field keeps its value until the next annotation run, which
   *       picks the asset up and fills it.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: field
   *         required: true
   *         schema:
   *           type: string
   *           enum: [role, importance, system]
   *     responses:
   *       200:
   *         description: The asset.
   *       400:
   *         description: Not a field.
   *       404:
   *         description: No such asset.
   */
  router.delete(
    "/assets/:id/annotation/:field",
    manage,
    async (req: Request, res: Response) => {
      const id = parseId(req.params.id);
      const asset = id ? await repo.findAsset(id) : null;
      if (!asset) return res.sendStatus(404);
      const field = String(req.params.field) as AnnotationField;
      if (!ANNOTATION_FIELDS.includes(field)) {
        return res.status(400).json({
          error: `field must be one of ${ANNOTATION_FIELDS.join(", ")}`,
        });
      }
      await repo.unlockAnnotation(asset.id, field);
      res.json({ asset: await repo.findAsset(asset.id) });
    },
  );
}
