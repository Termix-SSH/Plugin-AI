import { describe, expect, it } from "vitest";
import {
  deriveEntries,
  bindCurrentHosts,
  linkPaths,
} from "../../../src/backend/exposure/derive.js";
import { derived, host, listener, observation } from "./fixtures.js";
describe("configuration evidence derivation", () => {
  it("binds wildcards to observed interfaces without claiming internet reachability", () => {
    const v4 = host();
    v4.facts!.interfaces = [
      { name: "eth0", addrs: ["8.8.8.8/24", "2001:4860::1/64"] },
    ];
    const o = observation([
      listener(),
      {
        ...listener(),
        objectKey: "v6",
        endpoint: { address: "::", port: 22, protocol: "tcp" },
      },
    ]);
    const rows = derived(o, [v4]);
    expect(rows.flatMap((e) => e.bindings!.map((b) => b.address))).toEqual([
      "8.8.8.8",
      "2001:4860::1",
    ]);
    expect(rows.every((e) => e.verification === "not_tested")).toBe(true);
  });
  it("does not substitute the Termix reachedVia address when interfaces are missing", () => {
    const h = host();
    h.facts = { reachedVia: "8.8.4.4" };
    expect(derived(observation(), [h])[0].endpoint.address).toBe("0.0.0.0");
  });
  it("retains distinct published ports and ambiguous backends", () => {
    const a = host(1, "8.8.8.8"),
      b = host(2, "10.0.0.2"),
      c = host(3, "10.0.0.2");
    const o = observation([
      {
        ...listener(443),
        kind: "mapping",
        backend: { address: "10.0.0.2", port: 80, protocol: "tcp" },
      },
      listener(8443),
    ]);
    const rows = derived(o, [a, b, c]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(rows[0].requiredHostIds).toEqual([1, 2, 3]);
  });
  it("follows only exact explicit mappings and retains hop constraints", () => {
    const o = observation([
      {
        ...listener(443),
        kind: "mapping",
        backend: { address: "10.0.0.2", port: 80, protocol: "tcp" },
        constraints: ["source:192.0.2.1/32"],
      },
    ]);
    const front = derived(o, [host(), host(2, "10.0.0.2")])[0];
    const back = deriveEntries(observation([listener(80)]), {
      host: host(2, "10.0.0.2"),
      assets: [host(), host(2, "10.0.0.2")],
      ownerId: "user-1",
      observationId: "b",
      at: o.at,
    })[0];
    const path = linkPaths([front, back])[0];
    expect(path.hops).toHaveLength(2);
    expect(path.pathStatus).toBe("complete");
    expect(path.requiredHostIds).toEqual([1, 2]);
    expect(path.hops[0].constraints).toEqual(["source:192.0.2.1/32"]);
    expect(linkPaths([{ ...front, staleAt: o.at }, back])[0].hops).toHaveLength(
      1,
    );
    back.staleAt = o.at;
    expect(linkPaths([front, back])[0].pathStatus).toBe("partial");
  });
  it("does not invent paths from assets, dependencies or unresolved names", () => {
    const e = derived(
      observation([
        {
          ...listener(443),
          kind: "proxy",
          backend: {
            address: "unresolved.internal",
            port: 80,
            protocol: "tcp",
          },
        },
      ]),
    )[0];
    expect(linkPaths([e])[0].hops).toHaveLength(1);
  });
  it("never links one host's loopback backend to another host", () => {
    const o = observation([
      {
        ...listener(443),
        kind: "proxy",
        backend: { address: "127.0.0.1", port: 80, protocol: "tcp" },
      },
    ]);
    const front = derived(o)[0];
    const back = deriveEntries(
      observation([
        {
          ...listener(80),
          endpoint: { address: "127.0.0.1", port: 80, protocol: "tcp" },
        },
      ]),
      {
        host: host(2),
        assets: [host(2)],
        ownerId: "user-1",
        observationId: "b",
        at: o.at,
      },
    )[0];
    expect(linkPaths([front, back])[0].hops).toHaveLength(1);
  });
  it("rechecks historic backend identities against newly discovered hosts", () => {
    const entry = derived(
      observation([
        {
          ...listener(),
          backend: { address: "10.0.0.2", port: 80, protocol: "tcp" },
        },
      ]),
    )[0];
    expect(entry.requiredHostIds).toEqual([1]);
    expect(
      bindCurrentHosts([entry], [host(2, "10.0.0.2")])[0].requiredHostIds,
    ).toEqual([1, 2]);
  });
  it("stops loops and limits path length", () => {
    const a = derived(
      observation([
        {
          ...listener(80),
          kind: "mapping",
          backend: { address: "8.8.8.8", port: 80, protocol: "tcp" },
        },
      ]),
    )[0];
    expect(linkPaths([a])[0].pathStatus).toBe("conflicting");
  });
});
