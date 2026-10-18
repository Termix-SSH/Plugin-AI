import { compactEntries, evidenceFingerprint, rulePriority } from "./derive.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  exposureChanges,
  exposureEntries,
  exposureObservations,
} from "../tables.js";
import type { Entry, Observation } from "./types.js";
export interface Change {
  id: string;
  ownerId: string;
  hostId: number;
  at: string;
  noticeStatus: string;
  batchId?: string;
  kind: "baseline" | "added" | "changed" | "removed" | "coverage";
  before: Entry | null;
  after: Entry | null;
  observationId: string;
}
export interface StoredObservation extends Observation {
  id: string;
  hostId: number;
  ownerId: string;
  at: string;
  batchId?: string;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = any;
export type ExposureRepository = Awaited<
  ReturnType<typeof createExposureRepository>
>;
export async function createExposureRepository(ctx: Pick<PluginContext, "db">) {
  const db = ctx.db;
  const observations: any = await db.define(exposureObservations);
  const entries: any = await db.define(exposureEntries);
  const changes: any = await db.define(exposureChanges);
  let pending = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const work = pending.then(fn);
    pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
  async function transaction(ops: Array<(tx: Client) => any>) {
    const client = await db.client<Client>();
    if (db.dialect === "sqlite")
      client.transaction((tx: Client) => {
        for (const op of ops) op(tx).run();
      });
    else
      await client.transaction(async (tx: Client) => {
        for (const op of ops) await op(tx);
      });
    await db.persist();
  }
  async function listEntries(): Promise<Entry[]> {
    return compactEntries(
      (await (await db.client<Client>()).select().from(entries)).map((r: any) =>
        JSON.parse(r.payload),
      ),
    );
  }
  async function listObservations(): Promise<StoredObservation[]> {
    return (await (await db.client<Client>()).select().from(observations)).map(
      (r: any) => ({
        ...JSON.parse(r.payload),
        id: r.id,
        hostId: r.hostId,
        ownerId: r.ownerId,
        at: r.at,
      }),
    );
  }
  async function listChanges(): Promise<Change[]> {
    return (await (await db.client<Client>()).select().from(changes)).map(
      (r: any) => ({
        ...JSON.parse(r.payload),
        id: r.id,
        hostId: r.hostId,
        ownerId: r.ownerId,
        at: r.at,
        noticeStatus: r.noticeStatus,
      }),
    );
  }
  return {
    listEntries,
    listObservations,
    listChanges,
    apply(observation: StoredObservation, incoming: Entry[]): Promise<void> {
      return serial(async () => {
        const client = await db.client<Client>();
        const where = (table: any) =>
          and(
            eq(table.hostId, observation.hostId),
            eq(table.ownerId, observation.ownerId),
            eq(table.source, observation.source),
          );
        const old = compactEntries(
          (await client.select().from(entries).where(where(entries))).map(
            (r: any) => JSON.parse(r.payload),
          ),
        );
        const prior = (
          await client
            .select()
            .from(observations)
            .where(where(observations))
            .orderBy(desc(observations.at))
            .limit(1)
        )[0];
        const previous: StoredObservation | undefined = prior
          ? JSON.parse(prior.payload)
          : undefined;
        const before = new Map(old.map((e) => [e.key, e]));
        const updated: Entry[] = [];
        const events: Array<{
          kind: Change["kind"];
          before: Entry | null;
          after: Entry | null;
        }> = [];
        for (const entry of compactEntries(incoming)) {
          const existing = before.get(entry.key);
          entry.firstSeen = existing?.firstSeen ?? entry.firstSeen;
          if (existing && !observation.complete) {
            const seen = new Set(
              (entry.bindings ?? [entry.endpoint]).map((ep) =>
                JSON.stringify(ep),
              ),
            );
            const missing = (existing.bindings ?? [existing.endpoint]).filter(
              (ep) => !seen.has(JSON.stringify(ep)),
            );
            if (missing.length) {
              entry.bindings = [
                ...(entry.bindings ?? [entry.endpoint]),
                ...missing,
              ];
              entry.staleAt = observation.at;
              entry.observationIds = [
                ...new Set([
                  ...(entry.observationIds ?? [entry.observationId]),
                  ...(existing.observationIds ?? [existing.observationId]),
                ]),
              ];
              entry.fingerprint = evidenceFingerprint(entry);
            }
          }
          if (existing?.prioritySource === "user") {
            entry.priority = existing.priority;
            entry.prioritySource = "user";
          }
          updated.push(entry);
          before.delete(entry.key);
          if (!existing || existing.resolvedAt)
            events.push({
              kind: previous ? "added" : "baseline",
              before: existing ?? null,
              after: entry,
            });
          else if (existing.fingerprint !== entry.fingerprint)
            events.push({ kind: "changed", before: existing, after: entry });
        }
        for (const existing of before.values()) {
          if (existing.resolvedAt) {
            updated.push(existing);
            continue;
          }
          const after = {
            ...existing,
            staleAt: observation.complete ? null : observation.at,
            resolvedAt: observation.complete ? observation.at : null,
          };
          updated.push(after);
          if (observation.complete)
            events.push({ kind: "removed", before: existing, after });
        }
        if (
          (!previous ||
            previous.status !== observation.status ||
            previous.complete !== observation.complete) &&
          !observation.complete
        )
          events.push({ kind: "coverage", before: null, after: null });
        const ops: Array<(tx: Client) => any> = [
          (tx) =>
            tx.insert(observations).values({
              id: observation.id,
              hostId: observation.hostId,
              ownerId: observation.ownerId,
              source: observation.source,
              at: observation.at,
              payload: JSON.stringify(observation),
            }),
        ];
        ops.push((tx) => tx.delete(entries).where(where(entries)));
        for (const entry of updated) {
          ops.push((tx) =>
            tx.insert(entries).values({
              key: entry.key,
              hostId: entry.sourceHostId,
              ownerId: entry.ownerId,
              source: entry.source,
              payload: JSON.stringify(entry),
            }),
          );
        }
        const notices = events.filter((e) => e.kind !== "baseline");
        if (events.some((e) => e.kind === "baseline"))
          notices.push({ kind: "baseline", before: null, after: null });
        for (const event of notices)
          ops.push((tx) =>
            tx.insert(changes).values({
              id: randomUUID(),
              hostId: observation.hostId,
              ownerId: observation.ownerId,
              at: observation.at,
              noticeStatus: "pending",
              payload: JSON.stringify({
                ...event,
                observationId: observation.id,
                batchId: observation.batchId ?? observation.id,
              }),
            }),
          );
        await transaction(ops);
      });
    },
    override(key: string, priority: Entry["priority"] | null): Promise<void> {
      return serial(async () => {
        const entry = (await listEntries()).find((e) => e.key === key);
        if (!entry) return;
        entry.prioritySource = priority ? "user" : "rule";
        entry.priority = priority ?? rulePriority(entry);
        const raw = await (await db.client<Client>()).select().from(entries);
        const keys = new Set([key, ...(entry.memberKeys ?? [])]);
        await transaction(
          raw
            .filter((row: any) => keys.has(row.key))
            .map(
              (row: any) => (tx: Client) =>
                tx
                  .update(entries)
                  .set({
                    payload: JSON.stringify({
                      ...JSON.parse(row.payload),
                      prioritySource: entry.prioritySource,
                      priority: entry.priority,
                    }),
                  })
                  .where(eq(entries.key, row.key)),
            ),
        );
      });
    },
    async noticeMany(ids: string[], status: "sent" | "withheld") {
      await serial(() =>
        transaction(
          ids.map(
            (id) => (tx) =>
              tx
                .update(changes)
                .set({ noticeStatus: status })
                .where(eq(changes.id, id)),
          ),
        ),
      );
    },
    async notice(id: string, status: "sent" | "withheld") {
      await (
        await db.client<Client>()
      )
        .update(changes)
        .set({ noticeStatus: status })
        .where(eq(changes.id, id));
      await db.persist();
    },
    async prune(at = Date.now(), days = 90) {
      await serial(async () => {
        const cutoff = new Date(at - days * 86400000).toISOString();
        const current = await listEntries(),
          history = await listChanges();
        const keep = new Set(
          current.flatMap((e) => e.observationIds ?? [e.observationId]),
        );
        for (const c of history.filter(
          (c) => c.at >= cutoff || c.noticeStatus === "pending",
        )) {
          keep.add(c.observationId);
          for (const entry of [c.before, c.after])
            for (const id of entry?.observationIds ??
              (entry ? [entry.observationId] : []))
              keep.add(id);
        }
        const latest = new Map<string, StoredObservation>();
        const all = await listObservations();
        for (const o of all) {
          const key = `${o.ownerId}:${o.hostId}:${o.source}`;
          if (!latest.has(key) || latest.get(key)!.at < o.at)
            latest.set(key, o);
        }
        for (const o of latest.values()) keep.add(o.id);
        const ops: Array<(tx: Client) => any> = [];
        for (const o of all)
          if (o.at < cutoff && !keep.has(o.id))
            ops.push((tx) =>
              tx.delete(observations).where(eq(observations.id, o.id)),
            );
        for (const c of history)
          if (c.at < cutoff && c.noticeStatus !== "pending")
            ops.push((tx) => tx.delete(changes).where(eq(changes.id, c.id)));
        if (ops.length) await transaction(ops);
      });
    },
  };
}
