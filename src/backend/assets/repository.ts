import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { assetEdges, assetRuns, assets, zones } from "../tables.js";
import type { AssetKind, EdgeType } from "./derive.js";
import type { ZoneKind, ZoneRule } from "./zones.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Tables come from ctx.db.define, which the SDK hands back untyped.
type Table = any;
type Drizzle = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ZoneSource = "rule" | "user" | "ai";
export type RunTrigger = "schedule" | "manual" | "host_event";

export interface AssetRecord {
  id: number;
  key: string;
  kind: AssetKind;
  hostId: number | null;
  name: string;
  ips: string[];
  zone: string | null;
  zoneSource: ZoneSource | null;
  multiZone: boolean;
  facts: Record<string, unknown> | null;
  collectedAt: string | null;
  removedAt: string | null;
  role: string | null;
  roleSource: string | null;
  importance: string | null;
  importanceSource: string | null;
  importanceReason: string | null;
  system: string | null;
  systemSource: string | null;
  annotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EdgeRecord {
  id: number;
  fromAsset: number;
  toAsset: number;
  type: EdgeType;
  detail: Record<string, unknown> | null;
  evidence: string | null;
  source: "collector" | "ai" | "user";
  firstSeen: string;
  lastSeen: string;
}

export interface RunRecord {
  id: number;
  trigger: RunTrigger;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "done" | "failed";
  hostsTotal: number;
  hostsOk: number;
  hostsFailed: number;
  errorSummary: Record<string, string> | null;
}

export interface ZoneRecord extends ZoneRule {
  id: number;
  createdBy: string;
  createdAt: string;
}

/** What a collection writes to an asset. Zone is left alone when pinned. */
export interface AssetWrite {
  key: string;
  kind: AssetKind;
  hostId: number | null;
  name: string;
  ips: string[];
  zone: string | null;
  multiZone: boolean;
  facts?: Record<string, unknown> | null;
  collectedAt?: string;
}

const now = () => new Date().toISOString();

function parse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toAsset(row: Record<string, any>): AssetRecord {
  return {
    ...(row as AssetRecord),
    ips: parse<string[]>(row.ips, []),
    facts: parse<Record<string, unknown> | null>(row.facts, null),
    multiZone: !!row.multiZone,
  };
}

function toEdge(row: Record<string, any>): EdgeRecord {
  return {
    ...(row as EdgeRecord),
    detail: parse<Record<string, unknown> | null>(row.detail, null),
  };
}

function toRun(row: Record<string, any>): RunRecord {
  return {
    ...(row as RunRecord),
    errorSummary: parse<Record<string, string> | null>(row.errorSummary, null),
  };
}

export type AssetRepository = Awaited<ReturnType<typeof createAssetRepository>>;

export async function createAssetRepository(ctx: Pick<PluginContext, "db">) {
  const { db } = ctx;
  const assetTable: Table = await db.define(assets);
  const edgeTable: Table = await db.define(assetEdges);
  const runTable: Table = await db.define(assetRuns);
  const zoneTable: Table = await db.define(zones);
  const client = () => db.client<Drizzle>();

  /** Inserts one row and returns its id. MySQL has no RETURNING. */
  async function insertId(
    table: Table,
    values: Record<string, unknown>,
  ): Promise<number> {
    const drizzle = await client();
    if (db.dialect === "mysql") {
      const result = await drizzle.insert(table).values(values);
      const header = Array.isArray(result) ? result[0] : result;
      return Number(header?.insertId);
    }
    const rows = await drizzle
      .insert(table)
      .values(values)
      .returning({ id: table.id });
    return rows[0].id as number;
  }

  const repo = {
    async listAssets(
      filters: { zone?: string; kind?: string; includeRemoved?: boolean } = {},
    ): Promise<AssetRecord[]> {
      const where = [
        filters.zone ? eq(assetTable.zone, filters.zone) : undefined,
        filters.kind ? eq(assetTable.kind, filters.kind) : undefined,
        filters.includeRemoved ? undefined : isNull(assetTable.removedAt),
      ].filter(Boolean);
      const rows = await (
        await client()
      )
        .select()
        .from(assetTable)
        .where(where.length ? and(...where) : undefined)
        .orderBy(assetTable.kind, assetTable.name);
      return rows.map(toAsset);
    },

    async findAsset(id: number): Promise<AssetRecord | null> {
      const rows = await (
        await client()
      )
        .select()
        .from(assetTable)
        .where(eq(assetTable.id, id))
        .limit(1);
      return rows[0] ? toAsset(rows[0]) : null;
    },

    async findByKey(key: string): Promise<AssetRecord | null> {
      const rows = await (
        await client()
      )
        .select()
        .from(assetTable)
        .where(eq(assetTable.key, key))
        .limit(1);
      return rows[0] ? toAsset(rows[0]) : null;
    },

    async findByIds(ids: number[]): Promise<AssetRecord[]> {
      if (!ids.length) return [];
      const rows = await (
        await client()
      )
        .select()
        .from(assetTable)
        .where(inArray(assetTable.id, ids));
      return rows.map(toAsset);
    },

    /**
     * Inserts or updates by key and returns the id. Seeing an asset again
     * clears removedAt; a zone the user pinned and the annotations are
     * never touched here.
     */
    async upsertAsset(write: AssetWrite): Promise<number> {
      const at = now();
      const existing = await repo.findByKey(write.key);
      const values: Record<string, unknown> = {
        kind: write.kind,
        hostId: write.hostId,
        name: write.name,
        ips: JSON.stringify(write.ips),
        multiZone: write.multiZone,
        removedAt: null,
        updatedAt: at,
      };
      if (write.facts !== undefined) values.facts = JSON.stringify(write.facts);
      if (write.collectedAt) values.collectedAt = write.collectedAt;
      if (existing?.zoneSource !== "user") {
        values.zone = write.zone;
        values.zoneSource = write.zone ? "rule" : null;
      }
      if (existing) {
        await (
          await client()
        )
          .update(assetTable)
          .set(values)
          .where(eq(assetTable.id, existing.id));
        return existing.id;
      }
      return insertId(assetTable, { ...values, key: write.key, createdAt: at });
    },

    /** Re-zones an asset after the rules changed, unless it is pinned. */
    async setRuleZone(
      id: number,
      zone: string | null,
      multiZone: boolean,
    ): Promise<void> {
      await (
        await client()
      )
        .update(assetTable)
        .set({ zone, zoneSource: zone ? "rule" : null, multiZone })
        .where(
          and(
            eq(assetTable.id, id),
            or(
              isNull(assetTable.zoneSource),
              eq(assetTable.zoneSource, "rule"),
            ),
          ),
        );
    },

    /** Pins a zone, or with null hands it back to the rules. */
    async pinZone(id: number, zone: string | null): Promise<void> {
      await (
        await client()
      )
        .update(assetTable)
        .set({ zone, zoneSource: zone ? "user" : null, updatedAt: now() })
        .where(eq(assetTable.id, id));
      await db.persist();
    },

    async markRemoved(ids: number[]): Promise<void> {
      if (!ids.length) return;
      await (
        await client()
      )
        .update(assetTable)
        .set({ removedAt: now() })
        .where(and(inArray(assetTable.id, ids), isNull(assetTable.removedAt)));
    },

    /** A deleted Termix host, and the containers it reported. */
    async removeHost(hostId: number): Promise<void> {
      await (
        await client()
      )
        .update(assetTable)
        .set({ removedAt: now() })
        .where(
          and(
            eq(assetTable.hostId, hostId),
            inArray(assetTable.kind, ["host", "container"]),
            isNull(assetTable.removedAt),
          ),
        );
      await db.persist();
    },

    // --- edges ---

    async upsertEdge(edge: {
      fromAsset: number;
      toAsset: number;
      type: EdgeType;
      detail: Record<string, unknown>;
      evidence: string;
    }): Promise<void> {
      const at = now();
      const match = and(
        eq(edgeTable.fromAsset, edge.fromAsset),
        eq(edgeTable.toAsset, edge.toAsset),
        eq(edgeTable.type, edge.type),
      );
      const values = {
        detail: JSON.stringify(edge.detail),
        evidence: edge.evidence.slice(0, 500),
        lastSeen: at,
      };
      const drizzle = await client();
      const existing = await drizzle
        .select({ id: edgeTable.id })
        .from(edgeTable)
        .where(match)
        .limit(1);
      if (existing[0]) {
        await drizzle.update(edgeTable).set(values).where(match);
        return;
      }
      await insertId(edgeTable, {
        ...values,
        fromAsset: edge.fromAsset,
        toAsset: edge.toAsset,
        type: edge.type,
        source: "collector",
        firstSeen: at,
      });
    },

    /** Edges touching an asset, or all of them. */
    async listEdges(
      filters: { assetId?: number; type?: string } = {},
    ): Promise<EdgeRecord[]> {
      const where = [
        filters.assetId
          ? or(
              eq(edgeTable.fromAsset, filters.assetId),
              eq(edgeTable.toAsset, filters.assetId),
            )
          : undefined,
        filters.type ? eq(edgeTable.type, filters.type) : undefined,
      ].filter(Boolean);
      const rows = await (
        await client()
      )
        .select()
        .from(edgeTable)
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(edgeTable.lastSeen));
      return rows.map(toEdge);
    },

    // --- runs ---

    async startRun(trigger: RunTrigger, hostsTotal: number): Promise<number> {
      const id = await insertId(runTable, {
        trigger,
        startedAt: now(),
        status: "running",
        hostsTotal,
      });
      await db.persist();
      return id;
    },

    async finishRun(
      id: number,
      result: {
        status: "done" | "failed";
        hostsOk: number;
        hostsFailed: number;
        errors: Record<string, string>;
      },
    ): Promise<void> {
      await (
        await client()
      )
        .update(runTable)
        .set({
          status: result.status,
          hostsOk: result.hostsOk,
          hostsFailed: result.hostsFailed,
          errorSummary: Object.keys(result.errors).length
            ? JSON.stringify(result.errors)
            : null,
          finishedAt: now(),
        })
        .where(eq(runTable.id, id));
      await db.persist();
    },

    async listRuns(limit = 20): Promise<RunRecord[]> {
      const rows = await (
        await client()
      )
        .select()
        .from(runTable)
        .orderBy(desc(runTable.id))
        .limit(limit);
      return rows.map(toRun);
    },

    async hasRunSince(trigger: RunTrigger, since: string): Promise<boolean> {
      const rows = await (
        await client()
      )
        .select({ id: runTable.id })
        .from(runTable)
        .where(
          and(eq(runTable.trigger, trigger), gte(runTable.startedAt, since)),
        )
        .limit(1);
      return rows.length > 0;
    },

    /** Runs a restart cut off. */
    async failInterrupted(): Promise<void> {
      await (
        await client()
      )
        .update(runTable)
        .set({ status: "failed", finishedAt: now() })
        .where(eq(runTable.status, "running"));
      await db.persist();
    },

    // --- zones ---

    async listZones(): Promise<ZoneRecord[]> {
      return (await client())
        .select()
        .from(zoneTable)
        .orderBy(zoneTable.name, zoneTable.id);
    },

    async findZone(id: number): Promise<ZoneRecord | null> {
      const rows = await (
        await client()
      )
        .select()
        .from(zoneTable)
        .where(eq(zoneTable.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async createZone(
      zone: ZoneRule & { createdBy: string },
    ): Promise<ZoneRecord> {
      const id = await insertId(zoneTable, { ...zone, createdAt: now() });
      await db.persist();
      return (await repo.findZone(id))!;
    },

    async updateZone(
      id: number,
      changes: Partial<{
        name: string;
        kind: ZoneKind;
        cidr: string;
        priority: number;
      }>,
    ): Promise<ZoneRecord | null> {
      await (
        await client()
      )
        .update(zoneTable)
        .set(changes)
        .where(eq(zoneTable.id, id));
      await db.persist();
      return repo.findZone(id);
    },

    async deleteZone(id: number): Promise<boolean> {
      if (!(await repo.findZone(id))) return false;
      await (await client()).delete(zoneTable).where(eq(zoneTable.id, id));
      await db.persist();
      return true;
    },

    persist: () => db.persist(),
  };

  return repo;
}
