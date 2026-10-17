import { afterEach, describe, expect, it } from "vitest";
import { fakeSshClient } from "../ops/fake-ssh";
import { startServer, type TestServer } from "../helpers";
import { FULL_HOST } from "./fixtures";

const VIEW = ["ai.use", "ai.assets.view"];
const MANAGE = [...VIEW, "ai.assets.manage"];

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(permissions = MANAGE) {
  server = await startServer({
    permissions,
    sshClient: fakeSshClient(() => ({ stdout: FULL_HOST })).client,
    extraHosts: [{ id: 2, name: "db-1" }],
  });
  await server.enableFor("user-1");
  return server;
}

/** Starts a collection and waits for it to finish. */
async function collect(s: TestServer) {
  const started = await s.request("POST", "/assets/collect");
  expect(started.status).toBe(202);
  for (let i = 0; i < 100; i++) {
    const runs = await s.request("GET", "/assets/runs");
    if (!runs.body.running && runs.body.runs.length) return runs.body.runs[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("collection did not finish");
}

describe("asset routes", () => {
  it("need ai.assets.view and the assistant turned on", async () => {
    const s = await start(["ai.use"]);
    expect((await s.request("GET", "/assets")).status).toBe(403);
    await s.close();

    server = await startServer({ permissions: MANAGE });
    expect((await server.request("GET", "/assets")).status).toBe(403);
  });

  it("leave changes to ai.assets.manage", async () => {
    const s = await start(VIEW);
    expect((await s.request("GET", "/assets")).status).toBe(200);
    expect((await s.request("GET", "/assets/zones")).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", "/assets/collect", undefined],
      ["POST", "/assets/zones", { name: "x", kind: "dmz", cidr: "10.0.0.0/8" }],
      ["PUT", "/assets/zones/1", { name: "y" }],
      ["DELETE", "/assets/zones/1", undefined],
      ["PUT", "/assets/1/zone", { zone: "dmz" }],
      ["PUT", "/assets/settings", { dailyEnabled: false }],
      ["POST", "/assets/annotate", { all: true }],
      ["PUT", "/assets/1/annotation", { role: "x" }],
      ["DELETE", "/assets/1/annotation/role", undefined],
    ] as const) {
      expect((await s.request(method, path, { body })).status).toBe(403);
    }
  });

  it("collect as the first manager to ask, and list what was found", async () => {
    const s = await start();
    const started = await s.request("POST", "/assets/collect");
    expect(started.body).toEqual({ status: "started", collectorIsMe: true });
    const run = await collect(s);
    expect(run).toMatchObject({ status: "done", hostsTotal: 2, hostsOk: 2 });

    const list = await s.request("GET", "/assets");
    const web = list.body.assets.find(
      (a: { key: string }) => a.key === "host:1",
    );
    expect(web).toMatchObject({
      name: "web-1",
      zone: "internal",
      multiZone: true,
      os: "Ubuntu 24.04.4 LTS",
      counts: { listening: 7, outbound: 5, services: 5, containers: 2 },
    });
    expect(web.facts).toBeUndefined();

    const kinds = await s.request("GET", "/assets?kind=container");
    expect(kinds.body.assets.map((a: { kind: string }) => a.kind)).toEqual([
      "container",
      "container",
      "container",
      "container",
    ]);
    const search = await s.request("GET", "/assets?q=93.184");
    expect(search.body.assets.map((a: { key: string }) => a.key)).toEqual([
      "external:93.184.216.34",
    ]);
    const zone = await s.request("GET", "/assets?zone=external");
    expect(
      zone.body.assets.every((a: { zone: string }) => a.zone === "external"),
    ).toBe(true);

    const detail = await s.request("GET", `/assets/${web.id}`);
    expect(detail.body.asset.facts.hostname).toBe("web-1");
    expect(detail.body.outgoing).toContainEqual(
      expect.objectContaining({
        type: "connects_to",
        peer: expect.objectContaining({ key: "external:93.184.216.34" }),
      }),
    );
    expect(detail.body.incoming).toContainEqual(
      expect.objectContaining({
        type: "runs_on",
        peer: expect.objectContaining({ key: "container:1/app-db" }),
      }),
    );
    expect((await s.request("GET", "/assets/9999")).status).toBe(404);

    const edges = await s.request("GET", "/assets/edges?type=runs_on");
    expect(edges.body.edges.length).toBeGreaterThan(0);
    expect(
      edges.body.edges.every(
        (edge: { type: string }) => edge.type === "runs_on",
      ),
    ).toBe(true);
  });

  it("show removed assets only when asked", async () => {
    const s = await start();
    await collect(s);
    s.mock.ctx.events.emit("host.deleted", { hostId: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const keys = async (path: string) =>
      (await s.request("GET", path)).body.assets.map(
        (a: { key: string }) => a.key,
      );
    expect(await keys("/assets")).not.toContain("host:2");
    expect(await keys("/assets?includeRemoved=1")).toContain("host:2");
  });

  it("manage zone rules and re-zone at once", async () => {
    const s = await start();
    await collect(s);

    const bad = await s.request("POST", "/assets/zones", {
      body: { name: "dc", kind: "lan", cidr: "10.0.0.0/24" },
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await s.request("POST", "/assets/zones", {
          body: { name: "dc", kind: "internal", cidr: "10.0.0.300/24" },
        })
      ).status,
    ).toBe(400);

    const created = await s.request("POST", "/assets/zones", {
      body: { name: "dc", kind: "internal", cidr: "10.0.0.0/24", priority: 5 },
    });
    expect(created.status).toBe(201);
    expect(created.body.zone).toMatchObject({
      name: "dc",
      createdBy: "user-1",
    });
    const zones = await s.request("GET", "/assets/zones");
    expect(zones.body.builtin).toContain("overlay");
    expect(
      (await s.request("GET", "/assets?zone=dc")).body.assets.map(
        (a: { key: string }) => a.key,
      ),
    ).toContain("host:1");

    const id = created.body.zone.id;
    const updated = await s.request("PUT", `/assets/zones/${id}`, {
      body: { kind: "dmz" },
    });
    expect(updated.body.zone).toMatchObject({ name: "dc", kind: "dmz" });
    expect(
      (await s.request("PUT", "/assets/zones/999", { body: {} })).status,
    ).toBe(404);

    expect((await s.request("DELETE", `/assets/zones/${id}`)).status).toBe(204);
    expect((await s.request("DELETE", `/assets/zones/${id}`)).status).toBe(404);
    expect((await s.request("GET", "/assets?zone=dc")).body.assets).toEqual([]);
  });

  it("pin and unpin an asset's zone", async () => {
    const s = await start();
    await collect(s);
    const web = (await s.request("GET", "/assets?q=web-1")).body.assets[0];

    expect(
      (
        await s.request("PUT", `/assets/${web.id}/zone`, {
          body: { zone: "mars" },
        })
      ).status,
    ).toBe(400);
    const pinned = await s.request("PUT", `/assets/${web.id}/zone`, {
      body: { zone: "dmz" },
    });
    expect(pinned.body.asset).toMatchObject({
      zone: "dmz",
      zoneSource: "user",
    });

    await collect(s);
    expect((await s.request("GET", `/assets/${web.id}`)).body.asset.zone).toBe(
      "dmz",
    );

    const unpinned = await s.request("PUT", `/assets/${web.id}/zone`, {
      body: { zone: null },
    });
    expect(unpinned.body.asset).toMatchObject({
      zone: "internal",
      zoneSource: "rule",
    });
  });

  it("read and change the schedule and the collector", async () => {
    const s = await start();
    const initial = await s.request("GET", "/assets/settings");
    expect(initial.body.settings).toEqual({
      dailyEnabled: true,
      dailyTime: "03:00",
      collectorSet: false,
      collectorIsMe: false,
      annotateAfterCollect: true,
      annotateProviderId: null,
      annotateModel: null,
      annotateProviders: [],
    });
    for (const body of [
      { dailyTime: "25:00" },
      { dailyEnabled: "yes" },
      { collector: "user-2" },
    ]) {
      expect(
        (await s.request("PUT", "/assets/settings", { body })).status,
      ).toBe(400);
    }
    const saved = await s.request("PUT", "/assets/settings", {
      body: { dailyEnabled: false, dailyTime: "04:15", collector: "me" },
    });
    expect(saved.body.settings).toMatchObject({
      dailyEnabled: false,
      dailyTime: "04:15",
      collectorSet: true,
      collectorIsMe: true,
    });
    await s.enableFor("user-2");
    const other = await s.request("GET", "/assets/settings", {
      user: "user-2",
    });
    expect(other.body.settings.collectorIsMe).toBe(false);
  });

  it("keep the first collector when another manager collects", async () => {
    const s = await start();
    await collect(s);
    await s.enableFor("user-2");
    const second = await s.request("POST", "/assets/collect", {
      user: "user-2",
    });
    expect(second.body.collectorIsMe).toBe(false);
  });

  it("let a manager set, lock and unlock annotations", async () => {
    const s = await start();
    await collect(s);
    const web = (await s.request("GET", "/assets?q=web-1")).body.assets[0];
    const path = `/assets/${web.id}/annotation`;

    for (const body of [
      {},
      { importance: "huge" },
      { role: 42 },
      { system: "x".repeat(121) },
    ]) {
      expect((await s.request("PUT", path, { body })).status).toBe(400);
    }
    expect(
      (
        await s.request("PUT", "/assets/9999/annotation", {
          body: { role: "x" },
        })
      ).status,
    ).toBe(404);

    const saved = await s.request("PUT", path, {
      body: {
        role: " Shop front end ",
        importance: "high",
        importanceReason: "Customers reach the shop through it.",
        system: "shop",
      },
    });
    expect(saved.body.asset).toMatchObject({
      role: "Shop front end",
      roleSource: "user",
      importance: "high",
      importanceSource: "user",
      importanceReason: "Customers reach the shop through it.",
      system: "shop",
      systemSource: "user",
    });
    const listed = (await s.request("GET", "/assets?q=web-1")).body.assets[0];
    expect(listed).toMatchObject({
      role: "Shop front end",
      roleSource: "user",
    });

    expect((await s.request("DELETE", `${path}/owner`)).status).toBe(400);
    const unlocked = await s.request("DELETE", `${path}/importance`);
    expect(unlocked.body.asset).toMatchObject({
      importance: "high",
      importanceSource: null,
      roleSource: "user",
    });
  });

  it("start an annotation and list annotation runs apart from collections", async () => {
    const s = await start();
    await collect(s);
    const started = await s.request("POST", "/assets/annotate", {
      body: { all: true },
    });
    expect(started.status).toBe(202);
    expect(["started", "queued"]).toContain(started.body.status);
    for (let i = 0; i < 100; i++) {
      const runs = await s.request("GET", "/assets/annotation-runs");
      if (!runs.body.running && runs.body.runs.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const runs = await s.request("GET", "/assets/annotation-runs");
    // No provider here: the runs fail and say why.
    expect(runs.body.runs[0]).toMatchObject({
      kind: "annotate",
      status: "failed",
    });
    expect(
      (await s.request("GET", "/assets/runs")).body.runs.every(
        (run: { kind: string }) => run.kind === "collect",
      ),
    ).toBe(true);
  });

  it("serve the graph and impact to viewers", async () => {
    const s = await start(VIEW);
    expect((await s.request("GET", "/assets/graph")).body).toEqual({
      nodes: [],
      edges: [],
    });
    await s.close();

    const m = await start();
    await collect(m);
    const graph = await m.request("GET", "/assets/graph");
    expect(graph.status).toBe(200);
    const keys = graph.body.nodes.map((node: { key: string }) => node.key);
    expect(keys).toContain("host:1");
    expect(keys.some((key: string) => key.startsWith("container:"))).toBe(
      false,
    );
    expect(keys.some((key: string) => key.startsWith("external:"))).toBe(false);
    const web = graph.body.nodes.find(
      (n: { key: string }) => n.key === "host:1",
    );
    expect(web.containers).toBeGreaterThan(0);

    const expanded = await m.request(
      "GET",
      "/assets/graph?containers=1&external=1&types=runs_on",
    );
    const expandedKeys = expanded.body.nodes.map((n: { key: string }) => n.key);
    expect(expandedKeys).toContain("container:1/app-db");
    expect(expandedKeys).toContain("external:93.184.216.34");
    expect(
      expanded.body.edges.every((e: { type: string }) => e.type === "runs_on"),
    ).toBe(true);

    const impact = await m.request("GET", `/assets/${web.id}/impact`);
    expect(impact.status).toBe(200);
    expect(impact.body.asset).toMatchObject({ key: "host:1" });
    expect(
      impact.body.direct.map(
        (item: { asset: { key: string } }) => item.asset.key,
      ),
    ).toContain("container:1/app-db");
    expect(impact.body.counts.strong.unknown).toBeGreaterThan(0);
    expect((await m.request("GET", "/assets/9999/impact")).status).toBe(404);
  });
});
