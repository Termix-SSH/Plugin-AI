import { and, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { presetLinks, taskPresets, taskRuns } from "../tables.js";
import type { Autonomy, PlanHost, Severity, TaskStatus } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Tables come from ctx.db.define, which the SDK hands back untyped.
type Table = any;
type Drizzle = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface TaskRunRecord {
  id: number;
  userId: string;
  automationId: number;
  automationRunId: number | null;
  presetId: string | null;
  title: string;
  autonomy: Autonomy;
  hostIds: number[];
  trigger: Record<string, unknown>;
  dryRun: boolean;
  status: TaskStatus;
  severity: Severity | null;
  summary: string | null;
  report: string | null;
  plan: PlanHost[] | null;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  conversationId: number | null;
  promptTokens: number;
  completionTokens: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface TaskRunInput {
  userId: string;
  automationId: number;
  automationRunId: number | null;
  presetId: string | null;
  title: string;
  autonomy: Autonomy;
  hostIds: number[];
  trigger: Record<string, unknown>;
  dryRun: boolean;
  status: TaskStatus;
  summary?: string | null;
  severity?: Severity | null;
  conversationId?: number | null;
  finishedAt?: string | null;
}

export type TaskRunUpdate = Partial<
  Pick<
    TaskRunRecord,
    | "status"
    | "severity"
    | "summary"
    | "report"
    | "plan"
    | "decidedBy"
    | "decidedAt"
    | "expiresAt"
    | "finishedAt"
  >
>;

export interface PresetLinkRecord {
  id: number;
  userId: string;
  presetId: string;
  presetVersion: number;
  automationId: number;
}

export interface CustomPresetRecord {
  id: number;
  userId: string;
  name: string;
  description: string | null;
  shared: boolean;
  config: Record<string, unknown>;
  createdAt: string;
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

function toRun(row: Record<string, any>): TaskRunRecord {
  return {
    ...(row as TaskRunRecord),
    hostIds: parse<number[]>(row.hostIds, []),
    trigger: parse<Record<string, unknown>>(row.trigger, {}),
    plan: parse<PlanHost[] | null>(row.plan, null),
    dryRun: !!row.dryRun,
  };
}

function toPreset(row: Record<string, any>): CustomPresetRecord {
  return {
    ...(row as CustomPresetRecord),
    shared: !!row.shared,
    config: parse<Record<string, unknown>>(row.config, {}),
  };
}

export type TaskRepository = Awaited<ReturnType<typeof createTaskRepository>>;

/** Auto-ops rows: task runs, preset links and saved presets. */
export async function createTaskRepository(ctx: Pick<PluginContext, "db">) {
  const { db } = ctx;
  const runs: Table = await db.define(taskRuns);
  const links: Table = await db.define(presetLinks);
  const presets: Table = await db.define(taskPresets);
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
    async createRun(input: TaskRunInput): Promise<TaskRunRecord> {
      const id = await insertId(runs, {
        ...input,
        hostIds: JSON.stringify(input.hostIds),
        trigger: JSON.stringify(input.trigger),
        createdAt: now(),
      });
      await db.persist();
      const created = await repo.findRun(id);
      if (!created) throw new Error("Task run could not be read back");
      return created;
    },

    async findRun(id: number): Promise<TaskRunRecord | null> {
      const rows = await (
        await client()
      )
        .select()
        .from(runs)
        .where(eq(runs.id, id))
        .limit(1);
      return rows[0] ? toRun(rows[0]) : null;
    },

    /**
     * Adds one model call's tokens to a run as it is counted, so a run that
     * is cut off still shows what it used.
     */
    async addTokens(
      id: number,
      promptTokens: number,
      completionTokens: number,
    ): Promise<void> {
      const count = (value: number) =>
        Math.max(0, Math.round(Number(value) || 0));
      await (
        await client()
      )
        .update(runs)
        .set({
          promptTokens: sql`coalesce(${runs.promptTokens}, 0) + ${count(promptTokens)}`,
          completionTokens: sql`coalesce(${runs.completionTokens}, 0) + ${count(completionTokens)}`,
        })
        .where(eq(runs.id, id));
      await db.persist({ lazy: true });
    },

    async updateRun(id: number, changes: TaskRunUpdate): Promise<void> {
      const values: Record<string, unknown> = { ...changes };
      if (changes.plan !== undefined) {
        values.plan = changes.plan ? JSON.stringify(changes.plan) : null;
      }
      await (await client()).update(runs).set(values).where(eq(runs.id, id));
      await db.persist();
    },

    /**
     * Moves a run only from one of `from`, so two approvers or an approval
     * racing the expiry timer cannot both win. False when it had moved on.
     */
    async transition(
      id: number,
      from: TaskStatus[],
      changes: TaskRunUpdate & { status: TaskStatus },
    ): Promise<boolean> {
      const current = await repo.findRun(id);
      if (!current || !from.includes(current.status)) return false;
      await (
        await client()
      )
        .update(runs)
        .set(changes)
        .where(and(eq(runs.id, id), inArray(runs.status, from)));
      await db.persist();
      const after = await repo.findRun(id);
      return after?.status === changes.status;
    },

    /** The newest runs a user owns, or with null everyone's. */
    async listRuns(
      userId: string | null,
      options: { statuses?: TaskStatus[]; limit?: number } = {},
    ): Promise<TaskRunRecord[]> {
      const filters = [
        userId ? eq(runs.userId, userId) : undefined,
        options.statuses ? inArray(runs.status, options.statuses) : undefined,
      ].filter(Boolean);
      const rows = await (
        await client()
      )
        .select()
        .from(runs)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(runs.id))
        .limit(options.limit ?? 100);
      return rows.map(toRun);
    },

    /** An automation's runs that are still open. */
    async openRuns(
      automationId: number,
      statuses: TaskStatus[],
    ): Promise<TaskRunRecord[]> {
      const rows = await (
        await client()
      )
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.automationId, automationId),
            inArray(runs.status, statuses),
          ),
        );
      return rows.map(toRun);
    },

    /** Runs an automation started since `since`, skipped ones left out. */
    async countRecent(automationId: number, since: string): Promise<number> {
      const rows = await (
        await client()
      )
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.automationId, automationId),
            gte(runs.createdAt, since),
            ne(runs.status, "skipped"),
          ),
        );
      return rows.length;
    },

    /** Proposed plans whose time ran out. */
    async expiredProposals(at: string): Promise<TaskRunRecord[]> {
      const rows = await (
        await client()
      )
        .select()
        .from(runs)
        .where(and(eq(runs.status, "proposed"), lt(runs.expiresAt, at)));
      return rows.map(toRun);
    },

    /** Runs a restart cut off: nothing is working on them any more. */
    async failInterrupted(): Promise<number> {
      const stale = await (
        await client()
      )
        .select({ id: runs.id })
        .from(runs)
        .where(inArray(runs.status, ["running", "approved", "executing"]));
      if (!stale.length) return 0;
      await (
        await client()
      )
        .update(runs)
        .set({
          status: "failed",
          summary: "Interrupted by a server restart.",
          finishedAt: now(),
        })
        .where(
          inArray(
            runs.id,
            stale.map((row: { id: number }) => row.id),
          ),
        );
      await db.persist();
      return stale.length;
    },

    // --- preset links ---

    async linkPreset(input: Omit<PresetLinkRecord, "id">): Promise<void> {
      await insertId(links, { ...input, createdAt: now() });
      await db.persist();
    },

    async presetLinks(userId: string): Promise<PresetLinkRecord[]> {
      return (await client())
        .select()
        .from(links)
        .where(eq(links.userId, userId))
        .orderBy(desc(links.id));
    },

    async unlinkPreset(id: number): Promise<void> {
      await (await client()).delete(links).where(eq(links.id, id));
      await db.persist();
    },

    // --- saved presets ---

    /** A user's own presets and everyone's shared ones. */
    async listPresets(userId: string): Promise<CustomPresetRecord[]> {
      const rows = await (
        await client()
      )
        .select()
        .from(presets)
        .where(or(eq(presets.userId, userId), eq(presets.shared, true)))
        .orderBy(presets.name);
      return rows.map(toPreset);
    },

    async findPreset(id: number): Promise<CustomPresetRecord | null> {
      const rows = await (
        await client()
      )
        .select()
        .from(presets)
        .where(eq(presets.id, id))
        .limit(1);
      return rows[0] ? toPreset(rows[0]) : null;
    },

    async createPreset(input: {
      userId: string;
      name: string;
      description: string | null;
      shared: boolean;
      config: Record<string, unknown>;
    }): Promise<CustomPresetRecord> {
      const id = await insertId(presets, {
        ...input,
        config: JSON.stringify(input.config),
        createdAt: now(),
      });
      await db.persist();
      const created = await repo.findPreset(id);
      if (!created) throw new Error("Preset could not be read back");
      return created;
    },

    async deletePreset(id: number, userId: string): Promise<boolean> {
      const existing = await repo.findPreset(id);
      if (!existing || existing.userId !== userId) return false;
      await (await client()).delete(presets).where(eq(presets.id, id));
      await db.persist();
      return true;
    },
  };

  return repo;
}
