import { describe, expect, it } from "vitest";
import {
  canonicalSystem,
  publishedPorts,
  validateSubmission,
} from "../../../src/backend/assets/annotate-tool";
import { assetRecord, edgeRecord } from "./records";

function scope() {
  const web = assetRecord("host:1", { hostId: 1, name: "web-1" });
  const db = assetRecord("host:2", { hostId: 2, name: "db-1" });
  const node = assetRecord("host:3", { hostId: 3, name: "pve1" });
  const api = assetRecord("container:2/api", {
    hostId: 2,
    facts: { container: { ports: "0.0.0.0:8080->80/tcp, :::8080->80/tcp" } },
  });
  const outside = assetRecord("external:93.184.216.34", { kind: "external" });
  const edges = [
    edgeRecord(web, db, "connects_to", { detail: { ports: [5432, 8080] } }),
    edgeRecord(api, db, "runs_on"),
    edgeRecord(db, node, "runs_on"),
    edgeRecord(db, node, "connects_to", { detail: { ports: [8006] } }),
    edgeRecord(web, outside, "connects_to", { detail: { ports: [443] } }),
  ];
  const all = [web, db, node, api, outside];
  return {
    web,
    db,
    api,
    node,
    value: {
      batch: new Set(["host:1", "host:2", "container:2/api"]),
      known: new Map(all.map((asset) => [asset.key, asset])),
      edges,
    },
  };
}

const note = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  role: "Web front end",
  importance: "high",
  importanceReason: "Every customer request goes through it.",
  system: "shop",
  ...overrides,
});

describe("submit_annotations checks", () => {
  it("accepts well-formed annotations of the batch", () => {
    const { value } = scope();
    const result = validateSubmission(
      { annotations: [note("host:1"), note("host:2", { system: "" })] },
      value,
    );
    expect(result.errors).toEqual([]);
    expect(result.annotations.get("host:1")).toEqual({
      role: "Web front end",
      importance: "high",
      importanceReason: "Every customer request goes through it.",
      system: "shop",
    });
    expect(result.annotations.get("host:2")?.system).toBeNull();
  });

  it("rejects unknown keys, keys outside the batch, bad importance and no role", () => {
    const { value } = scope();
    const result = validateSubmission(
      {
        annotations: [
          note("host:99"),
          note("host:3"),
          note("host:1", { importance: "huge" }),
          note("host:2", { role: " " }),
          "nonsense",
        ],
      },
      value,
    );
    expect(result.annotations.size).toBe(0);
    expect(result.errors).toEqual([
      "host:99: not an asset of this batch",
      "host:3: not an asset of this batch",
      "host:1: importance must be one of critical, high, medium, low",
      "host:2: role is required",
      "an annotation must be an object",
    ]);
  });

  it("accepts depends_on that cites an observed fact", () => {
    const { value, web, db, api, node } = scope();
    const result = validateSubmission(
      {
        annotations: [],
        depends_on: [
          {
            from: "host:1",
            to: "host:2",
            evidence: {
              type: "connects_to",
              port: 5432,
              fact: "outbound db-1 tcp/5432",
            },
          },
          {
            from: "host:1",
            to: "container:2/api",
            evidence: {
              type: "port_mapping",
              port: 8080,
              fact: "api publishes 8080",
            },
          },
          {
            from: "host:2",
            to: "host:3",
            evidence: { type: "runs_on", fact: "runs on pve1" },
          },
          {
            from: "container:2/api",
            to: "host:3",
            evidence: {
              type: "connects_to",
              port: 8006,
              fact: "its host talks to pve1",
            },
          },
        ],
      },
      value,
    );
    expect(result.errors).toEqual([]);
    expect(
      result.dependsOn.map((entry) => [
        entry.from.id,
        entry.to.id,
        entry.evidence,
      ]),
    ).toEqual([
      [web.id, db.id, "connects_to 5432: outbound db-1 tcp/5432"],
      [web.id, api.id, "port_mapping 8080: api publishes 8080"],
      [db.id, node.id, "runs_on: runs on pve1"],
      [api.id, node.id, "connects_to 8006: its host talks to pve1"],
    ]);
  });

  it("rejects depends_on without valid evidence or with unknown keys", () => {
    const { value } = scope();
    const dep = (from: string, to: string, evidence: unknown) => ({
      from,
      to,
      evidence,
    });
    const result = validateSubmission(
      {
        annotations: [],
        depends_on: [
          dep("host:1", "host:2", undefined),
          dep("host:1", "host:2", { type: "hunch", fact: "looks like it" }),
          dep("host:1", "host:2", { type: "connects_to", fact: "" }),
          dep("host:1", "host:2", {
            type: "connects_to",
            port: 22,
            fact: "ssh",
          }),
          dep("host:2", "host:1", { type: "connects_to", fact: "reverse" }),
          dep("host:1", "container:2/api", {
            type: "port_mapping",
            port: 9000,
            fact: "x",
          }),
          dep("host:1", "host:3", { type: "runs_on", fact: "x" }),
          dep("host:1", "host:42", { type: "connects_to", fact: "x" }),
          dep("host:1", "external:93.184.216.34", {
            type: "connects_to",
            port: 443,
            fact: "x",
          }),
          dep("host:3", "host:2", { type: "connects_to", fact: "x" }),
          dep("host:1", "host:1", { type: "connects_to", fact: "x" }),
        ],
      },
      value,
    );
    expect(result.dependsOn).toEqual([]);
    expect(result.errors).toHaveLength(11);
    expect(result.errors).toEqual([
      expect.stringContaining("evidence needs a type"),
      expect.stringContaining("evidence needs a type"),
      expect.stringContaining("evidence needs a type"),
      "depends_on host:1 -> host:2: no such connects_to was observed",
      "depends_on host:2 -> host:1: no such connects_to was observed",
      "depends_on host:1 -> container:2/api: container:2/api publishes no port 9000",
      "depends_on host:1 -> host:3: no runs_on between them was observed",
      "depends_on host:1 -> host:42: unknown key",
      "depends_on host:1 -> external:93.184.216.34: unknown key",
      "depends_on host:3 -> host:2: from must be an asset of this batch",
      "depends_on host:1 -> host:1: an asset cannot depend on itself",
    ]);
  });

  it("reads a container's published host ports", () => {
    const { api } = scope();
    expect(publishedPorts(api)).toEqual([8080, 8080]);
  });
});

describe("system names", () => {
  it("reuse the inventory's spelling", () => {
    const known = ["OpenXDR", "Shop-Lite"];
    expect(canonicalSystem("openxdr", known)).toBe("OpenXDR");
    expect(canonicalSystem("shop lite", known)).toBe("Shop-Lite");
    expect(canonicalSystem("Shop_Lite", known)).toBe("Shop-Lite");
    expect(canonicalSystem("Sentry", known)).toBe("Sentry");
  });
});
