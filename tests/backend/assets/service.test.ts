import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import {
  createAssetRepository,
  type AssetRepository,
} from "../../../src/backend/assets/repository";
import {
  createAssetService,
  dailySlot,
  subscribeHostEvents,
  type AssetService,
} from "../../../src/backend/assets/service";
import { fakeSshClient, type FakePlan } from "../ops/fake-ssh";
import { manifest, pluginDir } from "../helpers";
import {
  BARE_HOST,
  FULL_HOST,
  pveHost,
  scriptOutput,
  DOCKER_PS,
} from "./fixtures";

const HOSTS = [
  { id: 1, name: "web-1", ip: "10.0.0.1" },
  { id: 2, name: "db-1", ip: "10.0.0.2" },
  { id: 3, name: "pve1", ip: "10.0.0.3" },
  { id: 4, name: "broken", ip: "10.0.0.4" },
  { id: 7, name: "k3s-master-1", ip: "10.0.0.7" },
];

interface Setup {
  db: TestDb;
  mock: MockPluginContext;
  repo: AssetRepository;
  service: AssetService;
  outputs: Map<number, FakePlan>;
  connected: number[];
}

let current: Setup | null = null;

afterEach(() => {
  current?.service.close();
  current?.db.close();
  current = null;
});

async function setup(
  options: { settings?: Record<string, unknown>; permissions?: string[] } = {},
): Promise<Setup> {
  const db = await createTestDb(pluginDir);
  db.sqlite
    .prepare("INSERT INTO users (id, username) VALUES ('user-1', 'u')")
    .run();
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => express.Router(),
    permissions: options.permissions ?? ["ai.assets.view", "ai.assets.manage"],
    settings: {
      globallyEnabled: true,
      assetsCollector: "user-1",
      ...options.settings,
    },
    hosts: HOSTS.map((host) => ({
      ...host,
      userId: "user-1",
      port: 22,
      username: "root",
      tags: null,
      folder: null,
      authType: "password",
    })),
  });
  // One scripted client per host; host 4 has none and fails to connect.
  const outputs = new Map<number, FakePlan>([
    [1, { stdout: FULL_HOST }],
    [2, { stdout: BARE_HOST }],
    [3, { stdout: pveHost("10.0.0.3") }],
    [7, { stdout: BARE_HOST }],
  ]);
  const connected: number[] = [];
  const ctx = {
    ...mock.ctx,
    ssh: {
      ...mock.ctx.ssh,
      withConnection: async (
        hostId: number,
        _options: unknown,
        fn: (client: unknown) => Promise<unknown>,
      ) => {
        const plan = outputs.get(hostId);
        if (!plan) throw new Error("connect ECONNREFUSED 10.0.0.4:22");
        connected.push(hostId);
        return fn(fakeSshClient(() => plan).client);
      },
    },
  } as unknown as PluginContext;
  const repo = await createAssetRepository(ctx);
  const service = createAssetService(ctx, repo);
  subscribeHostEvents(ctx, service);
  current = { db, mock, repo, service, outputs, connected };
  return current;
}

async function collect(setup: Setup) {
  setup.service.requestFull("manual");
  await setup.service.idle();
}

const byKey = async (repo: AssetRepository, key: string) =>
  (await repo.findByKey(key))!;

describe("asset collection", () => {
  it("collects every host, records the failing one and parses what is there", async () => {
    const s = await setup();
    await collect(s);

    const [run] = await s.repo.listRuns();
    expect(run).toMatchObject({
      trigger: "manual",
      status: "done",
      hostsTotal: 5,
      hostsOk: 4,
      hostsFailed: 1,
    });
    expect(run.errorSummary?.["4"]).toContain("ECONNREFUSED");

    const web = await byKey(s.repo, "host:1");
    expect(web).toMatchObject({
      kind: "host",
      name: "web-1",
      zone: "internal",
      zoneSource: "rule",
      multiZone: true,
      ips: ["10.0.0.1", "100.79.120.126", "fd7a:115c:a1e0::4e37:787e"],
    });
    expect(web.collectedAt).toBeTruthy();
    expect((web.facts as { hostname: string }).hostname).toBe("web-1");

    // The broken host is still in the inventory, by its Termix address.
    expect(await byKey(s.repo, "host:4")).toMatchObject({
      ips: ["10.0.0.4"],
      zone: "internal",
      facts: null,
      collectedAt: null,
    });

    // The bare host has none of the optional tools and is fine.
    const bare = await byKey(s.repo, "host:2");
    expect(bare.facts).toMatchObject({ hostname: "edge", containers: [] });
  });

  it("derives containers, guests and edges", async () => {
    const s = await setup();
    await collect(s);

    const container = await byKey(s.repo, "container:1/app-db");
    expect(container).toMatchObject({
      kind: "container",
      hostId: 1,
      zone: "internal",
    });
    // k3s-master-1 is a Termix host, so only the LXC is a guest of its own.
    expect(await s.repo.findByKey("guest:pve1/115")).toBeNull();
    expect(await byKey(s.repo, "guest:pve1/201")).toMatchObject({
      kind: "guest",
      zone: "internal",
    });
    const external = await byKey(s.repo, "external:93.184.216.34");
    expect(external).toMatchObject({ kind: "external", zone: "external" });

    const ids = new Map<string, number>();
    for (const asset of await s.repo.listAssets()) ids.set(asset.key, asset.id);
    const edges = await s.repo.listEdges();
    const find = (from: string, to: string, type: string) =>
      edges.find(
        (edge) =>
          edge.type === type &&
          edge.fromAsset === ids.get(from) &&
          edge.toAsset === ids.get(to),
      );
    const has = (from: string, to: string, type: string) =>
      !!find(from, to, type);
    expect(has("host:1", "host:2", "connects_to")).toBe(true);
    expect(has("host:1", "external:93.184.216.34", "connects_to")).toBe(true);
    expect(has("container:1/app-db", "host:1", "runs_on")).toBe(true);
    expect(has("host:7", "host:3", "runs_on")).toBe(true);
    expect(has("guest:pve1/201", "host:3", "runs_on")).toBe(true);

    const db = find("host:1", "host:2", "connects_to")!;
    expect(db).toMatchObject({
      source: "collector",
      detail: { ports: [5432], processes: ["app"], count: 2 },
    });
    expect(db.evidence).toContain("10.0.0.2:5432");
  });

  it("marks what disappeared as removed and leaves its edges stale", async () => {
    const s = await setup();
    await collect(s);
    const grafana = await byKey(s.repo, "container:1/grafana");
    const before = (await s.repo.listEdges({ assetId: grafana.id }))[0];

    s.outputs.set(1, {
      stdout: scriptOutput({
        hostname: "web-1",
        docker: DOCKER_PS.split("\n")[0],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await collect(s);

    expect((await byKey(s.repo, "container:1/grafana")).removedAt).toBeTruthy();
    expect((await byKey(s.repo, "container:1/app-db")).removedAt).toBeNull();
    // Not deleted, just not seen again.
    const after = (await s.repo.listEdges({ assetId: grafana.id }))[0];
    expect(after.lastSeen).toBe(before.lastSeen);
    const appDb = await byKey(s.repo, "container:1/app-db");
    const seen = (await s.repo.listEdges({ assetId: appDb.id }))[0];
    expect(seen.lastSeen > before.lastSeen).toBe(true);
  });

  it("keeps a zone the user pinned", async () => {
    const s = await setup();
    await collect(s);
    const web = await byKey(s.repo, "host:1");
    await s.repo.pinZone(web.id, "dmz");
    await collect(s);
    expect(await byKey(s.repo, "host:1")).toMatchObject({
      zone: "dmz",
      zoneSource: "user",
    });
  });

  it("re-zones assets when the rules change", async () => {
    const s = await setup();
    await collect(s);
    await s.repo.createZone({
      name: "dc",
      kind: "internal",
      cidr: "10.0.0.0/24",
      priority: 0,
      createdBy: "user-1",
    });
    await s.service.reclassify();
    expect((await byKey(s.repo, "host:2")).zone).toBe("dc");
    // A container follows its host.
    expect((await byKey(s.repo, "container:1/app-db")).zone).toBe("dc");
  });
});

describe("triggers", () => {
  it("queues a host event behind the run in progress", async () => {
    const s = await setup();
    s.outputs.set(1, { stdout: FULL_HOST, delayMs: 30 });
    s.service.requestFull("manual");
    expect(s.service.running()).toBe(true);
    s.mock.ctx.events.emit("host.updated", { hostId: 2, userId: "user-1" });
    expect(s.service.requestFull("manual")).toBe("queued");
    await s.service.idle();
    // The event is folded into the full run that was queued anyway.
    const runs = await s.repo.listRuns();
    expect(runs.map((run) => run.trigger)).toEqual(["manual", "manual"]);
  });

  it("collects just the host an event names", async () => {
    const s = await setup();
    s.mock.ctx.events.emit("host.updated", { hostId: 2, userId: "user-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.service.idle();
    const [run] = await s.repo.listRuns();
    expect(run).toMatchObject({
      trigger: "host_event",
      hostsTotal: 1,
      hostsOk: 1,
    });
    expect(s.connected).toEqual([2]);
  });

  it("listens for host.created when core sends it", async () => {
    const s = await setup();
    s.mock.ctx.events.emit("host.created", { hostId: 7 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.service.idle();
    expect(s.connected).toEqual([7]);
  });

  it("marks a deleted host and its containers removed", async () => {
    const s = await setup();
    await collect(s);
    s.mock.ctx.events.emit("host.deleted", { hostId: 1, userId: "user-1" });
    await s.service.idle();
    expect((await byKey(s.repo, "host:1")).removedAt).toBeTruthy();
    expect((await byKey(s.repo, "container:1/app-db")).removedAt).toBeTruthy();
    expect((await byKey(s.repo, "host:2")).removedAt).toBeNull();
    expect(await s.repo.listAssets()).not.toContainEqual(
      expect.objectContaining({ key: "host:1" }),
    );
  });

  it("does nothing automatic without a collector or with the plugin off", async () => {
    const s = await setup({ settings: { assetsCollector: "" } });
    s.mock.ctx.events.emit("host.updated", { hostId: 2 });
    await s.service.tick(Date.parse("2026-10-17T12:00:00Z"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await s.service.idle();
    expect(await s.repo.listRuns()).toEqual([]);

    const off = await setup({ settings: { globallyEnabled: false } });
    await off.service.tick(Date.parse("2026-10-17T12:00:00Z"));
    await off.service.idle();
    expect(await off.repo.listRuns()).toEqual([]);
  });

  it("runs the daily collection once its time has come, once", async () => {
    const s = await setup({ settings: { assetsCollectTime: "04:30" } });
    await s.service.tick(Date.parse("2026-10-17T04:00:00Z"));
    await s.service.idle();
    expect(await s.repo.listRuns()).toEqual([]);

    await s.service.tick(Date.parse("2026-10-17T05:00:00Z"));
    await s.service.idle();
    await s.service.tick(Date.parse("2026-10-17T05:01:00Z"));
    await s.service.idle();
    const runs = await s.repo.listRuns();
    expect(runs.filter((run) => run.trigger === "schedule")).toHaveLength(1);
  });

  it("skips the daily collection when it is turned off", async () => {
    const s = await setup({ settings: { assetsDailyCollect: false } });
    await s.service.tick(Date.now());
    await s.service.idle();
    expect(await s.repo.listRuns()).toEqual([]);
  });

  it("records a failed run when the collector lost the permission", async () => {
    const s = await setup({ permissions: ["ai.assets.view"] });
    await collect(s);
    const [run] = await s.repo.listRuns();
    expect(run.status).toBe("failed");
    expect(run.errorSummary?.collector).toContain("ai.assets.manage");
    expect(s.connected).toEqual([]);
  });

  it("puts the daily slot at the configured UTC time", () => {
    expect(
      dailySlot("04:30", Date.parse("2026-10-17T12:00:00Z")).toISOString(),
    ).toBe("2026-10-17T04:30:00.000Z");
    expect(
      dailySlot("bogus", Date.parse("2026-10-17T12:00:00Z")).toISOString(),
    ).toBe("2026-10-17T03:00:00.000Z");
  });
});
