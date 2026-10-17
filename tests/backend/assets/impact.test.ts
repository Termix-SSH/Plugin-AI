import { describe, expect, it } from "vitest";
import { graphPayload } from "../../../src/backend/assets/graph";
import { impactOf } from "../../../src/backend/assets/impact";
import { assetRecord, edgeRecord } from "./records";

/**
 * pve2 runs master-2 and worker-1; worker-1 runs a dns container; the app
 * depends on dns; monitor only connects to worker-1. db-1 is unrelated.
 */
function cluster() {
  const pve = assetRecord("host:1", { name: "pve2", importance: "critical" });
  const master = assetRecord("host:2", {
    name: "master-2",
    importance: "critical",
  });
  const worker = assetRecord("guest:pve2/101", {
    name: "worker-1",
    importance: "high",
  });
  const dns = assetRecord("container:3/dns", {
    name: "dns",
    importance: "high",
  });
  const app = assetRecord("host:4", { name: "app", importance: "medium" });
  const monitor = assetRecord("host:5", { name: "monitor" });
  const db = assetRecord("host:6", { name: "db-1" });
  const gone = assetRecord("host:7", { name: "gone", removedAt: "2026-10-01" });
  const outside = assetRecord("external:1.1.1.1", { kind: "external" });
  const edges = [
    edgeRecord(master, pve, "runs_on"),
    edgeRecord(worker, pve, "runs_on"),
    edgeRecord(dns, worker, "runs_on"),
    edgeRecord(app, dns, "depends_on", { source: "ai" }),
    edgeRecord(monitor, worker, "connects_to", { detail: { ports: [9100] } }),
    edgeRecord(gone, pve, "runs_on"),
    edgeRecord(db, outside, "connects_to"),
  ];
  return {
    assets: [pve, master, worker, dns, app, monitor, db, gone, outside],
    edges,
    pve,
    master,
    worker,
    dns,
    app,
    monitor,
  };
}

const names = (items: Array<{ asset: { name: string } }>) =>
  items.map((item) => item.asset.name);

describe("impact", () => {
  it("follows a Proxmox node to its guests, their containers and what depends on them", () => {
    const c = cluster();
    const impact = impactOf(c.pve.id, c.assets, c.edges);
    expect(names(impact.direct)).toEqual(["master-2", "worker-1"]);
    expect(names(impact.transitive)).toEqual(["dns", "app"]);
    expect(names(impact.weak)).toEqual(["monitor"]);
    expect(impact.truncated).toBe(false);

    const app = impact.transitive.find((item) => item.asset.name === "app")!;
    expect(app.depth).toBe(3);
    expect(app.path.map((step) => [step.from, step.to, step.type])).toEqual([
      [c.app.id, c.dns.id, "depends_on"],
      [c.dns.id, c.worker.id, "runs_on"],
      [c.worker.id, c.pve.id, "runs_on"],
    ]);
    expect(impact.counts.strong).toEqual({
      critical: 1,
      high: 2,
      medium: 1,
      low: 0,
      unknown: 0,
    });
    expect(impact.counts.weak.unknown).toBe(1);
  });

  it("counts depends_on from a leaf, and nothing for an asset nobody needs", () => {
    const c = cluster();
    expect(names(impactOf(c.dns.id, c.assets, c.edges).direct)).toEqual([
      "app",
    ]);
    const none = impactOf(c.app.id, c.assets, c.edges);
    expect([...none.direct, ...none.transitive, ...none.weak]).toEqual([]);
  });

  it("stops at the depth and size caps and says so", () => {
    const c = cluster();
    const shallow = impactOf(c.pve.id, c.assets, c.edges, {
      depth: 1,
      size: 300,
    });
    expect(names(shallow.direct)).toEqual(["master-2", "worker-1"]);
    expect(shallow.transitive).toEqual([]);
    expect(shallow.truncated).toBe(true);

    const small = impactOf(c.pve.id, c.assets, c.edges, { depth: 6, size: 1 });
    expect(small.direct).toHaveLength(1);
    expect(small.truncated).toBe(true);
  });
});

describe("graph payload", () => {
  it("folds containers into their host and leaves externals out by default", () => {
    const c = cluster();
    const graph = graphPayload(c.assets, c.edges, {
      types: ["runs_on", "depends_on", "connects_to"],
      containers: false,
      external: false,
    });
    expect(graph.nodes.map((node) => node.name).sort()).toEqual(
      ["app", "db-1", "master-2", "monitor", "pve2", "worker-1"].sort(),
    );
    expect(
      graph.nodes.find((node) => node.name === "worker-1")?.containers,
    ).toBe(1);
    // app's depends_on moved from the dns container to worker-1.
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        from: c.app.id,
        to: c.worker.id,
        type: "depends_on",
      }),
    );
    expect(graph.edges.some((edge) => edge.from === edge.to)).toBe(false);
  });

  it("expands containers, adds externals and filters edge types on request", () => {
    const c = cluster();
    const graph = graphPayload(c.assets, c.edges, {
      types: ["runs_on"],
      containers: true,
      external: true,
    });
    expect(graph.nodes.map((node) => node.name)).toContain("dns");
    expect(graph.nodes.map((node) => node.key)).toContain("external:1.1.1.1");
    expect(graph.edges.every((edge) => edge.type === "runs_on")).toBe(true);
  });
});
