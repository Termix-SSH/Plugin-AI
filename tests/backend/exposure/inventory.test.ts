import { describe, expect, it } from "vitest";
import {
  compactEntries,
  deriveEntries,
  internetRelevant,
  linkPaths,
} from "../../../src/backend/exposure/derive.js";
import type { Candidate, Entry } from "../../../src/backend/exposure/types.js";
import { host, listener, observation } from "./fixtures.js";
const at = new Date().toISOString();
const gateway = host(2, "10.0.0.2");
gateway.facts!.interfaces = [
  { name: "eth0", addrs: ["10.0.0.2/24", "172.17.0.1/16", "127.0.0.1/8"] },
];
function entries(
  source: Entry["source"],
  records: Candidate[],
  h = host(1, "10.0.0.1"),
) {
  return deriveEntries(
    { ...observation(records, true, at), source },
    {
      host: h,
      assets: [host(1, "10.0.0.1"), gateway, host(3, "10.0.0.3")],
      ownerId: "user-1",
      observationId: `${source}-${h.hostId}`,
      at,
    },
  );
}
const nat = () =>
  entries("uci", [
    {
      ...listener(443),
      kind: "mapping",
      constraints: ["source-zone:wan"],
      backend: { address: "10.0.0.2", port: 443, protocol: "tcp" },
    },
  ])[0];
function proxies(count = 2) {
  return entries(
    "caddy",
    Array.from({ length: count }, (_, i) => ({
      ...listener(443),
      objectKey: `route-${i}`,
      kind: "proxy",
      hostname: `route-${i}.example`,
      path: "/",
      backend: { address: "10.0.0.3", port: 8080 + i, protocol: "tcp" },
    })),
    gateway,
  );
}
describe("reviewable exposure inventory", () => {
  it("keeps one rule with multiple bindings and a stable key across interface changes", () => {
    const a = proxies(76);
    expect(a).toHaveLength(76);
    expect(a[0].bindings).toHaveLength(3);
    const altered = structuredClone(gateway);
    (altered.facts!.interfaces as { addrs: string[] }[])[0].addrs.push(
      "10.0.0.20/24",
    );
    const next = deriveEntries(
      {
        ...observation([
          {
            ...listener(443),
            objectKey: "route-0",
            kind: "proxy",
            hostname: "route-0.example",
            path: "/",
            backend: { address: "10.0.0.3", port: 8080, protocol: "tcp" },
          },
        ]),
        source: "caddy",
      },
      {
        host: altered,
        assets: [altered],
        ownerId: "user-1",
        observationId: "new",
        at,
      },
    );
    expect(next[0].key).toBe(a[0].key);
    expect(next[0].bindings).toHaveLength(4);
  });
  it("compacts legacy expansion without merging separate owners, ports or manual priorities", () => {
    const row = proxies(1)[0];
    const old = row.bindings!.map((ep, i) => ({
      ...row,
      key: `legacy-${i}`,
      bindings: undefined,
      memberKeys: undefined,
      endpoint: ep,
      prioritySource: i === 1 ? ("user" as const) : ("rule" as const),
      priority: i === 1 ? ("low" as const) : ("high" as const),
    }));
    const compact = compactEntries(old);
    expect(compact).toHaveLength(1);
    expect(compact[0]).toMatchObject({
      key: row.key,
      priority: "low",
      prioritySource: "user",
    });
    expect(compact[0].memberKeys).toEqual(["legacy-0", "legacy-1", "legacy-2"]);
    expect(
      compactEntries([...old, { ...old[0], ownerId: "another-user" }]),
    ).toHaveLength(2);
  });
  it("ranks a WAN remapped database and public DNS high, but internal listeners low", () => {
    const wan = entries("uci", [
      {
        ...listener(55432),
        kind: "mapping",
        constraints: ["source-zone:wan"],
        backend: { address: "10.0.0.3", port: 5432, protocol: "tcp" },
      },
    ])[0];
    expect(wan).toMatchObject({
      binding: "public",
      priority: "high",
      verification: "not_tested",
    });
    expect(wan.priorityReasons).toContain("sensitive-service:5432");
    expect(internetRelevant(wan)).toBe(true);
    const internal = entries("listen", [listener(5432)])[0];
    expect(internal.priority).toBe("low");
    expect(internetRelevant(internal)).toBe(false);
    expect(
      entries("listen", [listener(53)], host(1, "8.8.8.8"))[0].priority,
    ).toBe("high");
    expect(
      entries("uci", [
        { ...listener(5432), constraints: ["source-zone:lan"] },
      ])[0].binding,
    ).not.toBe("public");
  });
  it("branches NAT into named Caddy routes and keeps all downstream access requirements", () => {
    const root = nat(),
      routes = proxies();
    const back = entries(
      "listen",
      [listener(8080), listener(8081)],
      host(3, "10.0.0.3"),
    );
    const result = linkPaths([root, ...routes, ...back])[0];
    expect(result.pathStatus).toBe("branched");
    expect(result.paths).toHaveLength(2);
    expect(
      result.paths!.every(
        (p) => p.status === "complete" && p.hops.length === 3,
      ),
    ).toBe(true);
    expect(result.paths!.map((p) => p.hops[1].hostname).sort()).toEqual([
      "route-0.example",
      "route-1.example",
    ]);
    expect(result.requiredHostIds.sort()).toEqual([1, 2, 3]);
  });
  it("treats multiple upstreams on one route as conditional alternatives", () => {
    const routes = proxies().map((r) => ({ ...r, hostname: "shared.example" }));
    const result = linkPaths([nat(), ...routes])[0];
    expect(result.pathStatus).toBe("branched");
    expect(result.paths).toHaveLength(2);
  });
  it("does not multiply another ambiguous route selection into invented request paths", () => {
    const outer = proxies().map((r) => ({
      ...r,
      backend: { address: "10.0.0.3", port: 8080, protocol: "tcp" as const },
    }));
    const inner = entries(
      "nginx",
      [0, 1].map((i) => ({
        ...listener(8080),
        objectKey: `inner-${i}`,
        kind: "proxy",
        hostname: `inner-${i}.example`,
        backend: { address: "10.0.0.4", port: 80, protocol: "tcp" },
      })),
      host(3, "10.0.0.3"),
    );
    const result = linkPaths([nat(), ...outer, ...inner])[0];
    expect(result.paths).toHaveLength(2);
    expect(
      result.paths!.every((p) => p.status === "partial" && p.hops.length === 2),
    ).toBe(true);
    expect(result.paths![0].hops[1].constraints).toContain(
      "downstream-route-selection-unverified",
    );
  });
  it("keeps hidden candidates in permission requirements even beyond the branch cap", () => {
    const routes = proxies(130);
    routes[129].requiredHostIds.push(999);
    const result = linkPaths([nat(), ...routes])[0];
    expect(result.paths).toHaveLength(128);
    expect(result.pathsTruncated).toBe(true);
    expect(result.requiredHostIds).toContain(999);
  });
  it("does not link stale proxies or pick one host from an overlapping address", () => {
    const route = proxies(1)[0];
    expect(
      linkPaths([nat(), { ...route, staleAt: at }])[0].paths![0].hops,
    ).toHaveLength(1);
    const ambiguous = {
      ...route,
      key: "another",
      sourceHostId: 4,
      requiredHostIds: [4],
    };
    expect(linkPaths([nat(), route, ambiguous])[0].pathStatus).toBe(
      "conflicting",
    );
  });
});

import { explanationEvidence } from "../../../src/backend/exposure/explain.js";
it("bounds model evidence while explicitly accounting for omitted branches", () => {
  const root = linkPaths([nat(), ...proxies(130)])[0];
  const evidence = explanationEvidence(root),
    payload = JSON.parse(evidence);
  expect(evidence.length).toBeLessThanOrEqual(20000);
  expect(payload.paths.length + payload.omittedPathCount).toBe(128);
  expect(payload.omittedPathCount).toBeGreaterThan(0);
  expect(payload.pathsTruncated).toBe(true);
});
