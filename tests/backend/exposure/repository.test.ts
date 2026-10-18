import { afterEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@termix-ssh/plugin-sdk/testing";
import { pluginDir } from "../helpers.js";
import { createExposureRepository } from "../../../src/backend/exposure/repository.js";
import { derived, host, listener, observation } from "./fixtures.js";
let db: TestDb;
afterEach(() => db?.close());
async function setup() {
  db = await createTestDb(pluginDir);
  return createExposureRepository({ db: db.database });
}
describe("durable exposure state", () => {
  it("creates a baseline, remains quiet on identical facts and detects disappearance only on complete collection", async () => {
    const r = await setup(),
      a = observation();
    await r.apply(a, derived(a));
    expect((await r.listChanges()).map((c) => c.kind)).toEqual(["baseline"]);
    const b = observation(undefined, true, "2026-01-02T00:00:00.000Z");
    await r.apply(b, derived(b));
    expect(await r.listChanges()).toHaveLength(1);
    const c = observation([], false, "2026-01-03T00:00:00.000Z");
    await r.apply(c, []);
    expect((await r.listEntries())[0]).toMatchObject({
      resolvedAt: null,
      staleAt: c.at,
    });
    expect((await r.listChanges()).map((c) => c.kind)).not.toContain("removed");
    const d = observation([], true, "2026-01-04T00:00:00.000Z");
    await r.apply(d, []);
    expect((await r.listEntries())[0].resolvedAt).toBe(d.at);
    expect((await r.listChanges()).map((c) => c.kind)).toContain("removed");
  });
  it("normalizes legacy expanded rows atomically without false add/remove notices or lost overrides", async () => {
    const r = await setup(),
      o = observation();
    const h = host();
    h.facts!.interfaces = [
      { name: "eth0", addrs: ["8.8.8.8/24", "10.0.0.1/24"] },
    ];
    const current = derived(o, [h])[0];
    await r.apply(o, [current]);
    const sql = db.sqlite;
    sql.exec("DELETE FROM p_ai_exposure_entries");
    for (const [i, ep] of current.bindings!.entries()) {
      const legacy = {
        ...current,
        key: `legacy-${i}`,
        bindings: undefined,
        memberKeys: undefined,
        endpoint: ep,
      };
      sql
        .prepare(
          "INSERT INTO p_ai_exposure_entries (key,host_id,owner_id,source,payload) VALUES (?,?,?,?,?)",
        )
        .run(legacy.key, 1, o.ownerId, o.source, JSON.stringify(legacy));
    }
    expect(await r.listEntries()).toHaveLength(1);
    await r.override(current.key, "low");
    expect(
      sql.prepare("SELECT count(*) AS n FROM p_ai_exposure_entries").get(),
    ).toEqual({ n: 2 });
    const next = observation(undefined, true, "2026-01-02T00:00:00.000Z");
    await r.apply(next, derived(next, [h]));
    expect(
      sql.prepare("SELECT count(*) AS n FROM p_ai_exposure_entries").get(),
    ).toEqual({ n: 1 });
    expect((await r.listEntries())[0]).toMatchObject({
      priority: "low",
      prioritySource: "user",
      firstSeen: o.at,
    });
    expect((await r.listChanges()).map((c) => c.kind)).toEqual(["baseline"]);
    expect(await r.listObservations()).toHaveLength(2);
  });
  it("retains unconfirmed bindings and their evidence during a partial refresh", async () => {
    const r = await setup(),
      first = observation();
    const h = host();
    h.facts!.interfaces = [
      { name: "eth0", addrs: ["8.8.8.8/24", "10.0.0.1/24"] },
    ];
    await r.apply(first, derived(first, [h]));
    h.facts!.interfaces = [{ name: "eth0", addrs: ["10.0.0.1/24"] }];
    const partial = {
      ...observation(undefined, true, "2026-01-02T00:00:00.000Z"),
      complete: false,
    };
    await r.apply(partial, derived(partial, [h]));
    const row = (await r.listEntries())[0];
    expect(row.bindings).toHaveLength(2);
    expect(row.staleAt).toBe(partial.at);
    expect(row.observationIds).toEqual(
      expect.arrayContaining([first.id, partial.id]),
    );
    expect((await r.listChanges()).map((c) => c.kind)).not.toContain("removed");
    await r.prune(Date.parse("2026-10-18"));
    expect(await r.listObservations()).toHaveLength(2);
  });
  it("preserves human priorities and records property changes without changing identity", async () => {
    const r = await setup(),
      a = observation();
    await r.apply(a, derived(a));
    const key = (await r.listEntries())[0].key;
    await r.override(key, "low");
    const b = observation(
      [
        {
          ...listener(),
          restricted: "configured",
          constraints: ["source:10.0.0.0/8"],
        },
      ],
      true,
      "2026-01-02T00:00:00.000Z",
    );
    await r.apply(b, derived(b));
    expect((await r.listEntries())[0]).toMatchObject({
      key,
      priority: "low",
      prioritySource: "user",
    });
    expect((await r.listChanges()).map((c) => c.kind)).toEqual([
      "baseline",
      "changed",
    ]);
    await r.override(key, null);
    expect((await r.listEntries())[0].priority).toBe("high");
  });
  it("rolls back observations, entries and changes together", async () => {
    const r = await setup(),
      a = observation();
    await r.apply(a, derived(a));
    const b = observation([listener(443)]);
    b.id = a.id;
    await expect(r.apply(b, derived(b))).rejects.toThrow();
    expect(await r.listObservations()).toHaveLength(1);
    expect(await r.listEntries()).toHaveLength(1);
    expect(await r.listChanges()).toHaveLength(1);
  });
  it("rolls back when an outbox write fails after the entry was changed", async () => {
    const r = await setup(),
      a = observation();
    await r.apply(a, derived(a));
    db.sqlite.exec(
      "CREATE TRIGGER reject_exposure_change BEFORE INSERT ON p_ai_exposure_changes BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END",
    );
    const b = observation([listener(443)], true, "2026-01-02T00:00:00.000Z");
    await expect(r.apply(b, derived(b))).rejects.toThrow("outbox unavailable");
    expect(await r.listObservations()).toHaveLength(1);
    expect((await r.listEntries())[0].endpoint.port).toBe(22);
  });
  it("retains pending notifications and evidence referenced by entries during pruning", async () => {
    const r = await setup(),
      a = observation();
    await r.apply(a, derived(a));
    await r.prune(Date.parse("2026-10-18"));
    expect(await r.listObservations()).toHaveLength(1);
    expect(await r.listChanges()).toHaveLength(1);
  });
  it("does not infer disappearance from a different collector or source", async () => {
    const r = await setup(),
      a = observation();
    await r.apply(a, derived(a));
    const b = observation([]);
    b.ownerId = "user-2";
    await r.apply(b, []);
    expect((await r.listEntries())[0].resolvedAt).toBeNull();
  });
});
