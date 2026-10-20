import { describe, expect, it } from "vitest";
import {
  buildIpIndex,
  deriveConnections,
  deriveWorkloads,
  EXTERNAL_CAP,
  hostDraft,
  nameIndex,
  type CollectedHost,
} from "../../../src/backend/assets/derive";
import {
  parseSections,
  type HostFacts,
} from "../../../src/backend/assets/parsers";
import { splitSections } from "../../../src/backend/assets/script";
import { FULL_HOST, pveHost } from "./fixtures";

const facts = (output: string): HostFacts =>
  parseSections(splitSections(output).sections);

const web: CollectedHost = {
  hostId: 1,
  name: "web-1",
  address: "10.0.0.1",
  facts: facts(FULL_HOST),
};

const pve: CollectedHost = {
  hostId: 3,
  name: "Proxmox One",
  address: "pve1.lan",
  facts: facts(pveHost("10.0.0.3")),
};

describe("host assets", () => {
  it("lead with the Termix address and leave bridges out", () => {
    const draft = hostDraft(web);
    expect(draft).toMatchObject({ key: "host:1", kind: "host", hostId: 1 });
    expect(draft.ips).toEqual([
      "10.0.0.1",
      "100.79.120.126",
      "fd7a:115c:a1e0::4e37:787e",
    ]);
  });

  it("keep a NAT or forwarded Termix address out of the host's own", () => {
    // In real use two hosts behind one public address both took its zone.
    const natted = { ...web, address: "203.0.113.7" };
    const draft = hostDraft(natted);
    expect(draft.ips).not.toContain("203.0.113.7");
    expect(draft.ips[0]).toBe("10.0.0.1");
    expect(draft.facts).toMatchObject({ reachedVia: "203.0.113.7" });
    expect(hostDraft(web).facts).not.toHaveProperty("reachedVia");
  });

  it("skip a DNS name as an address", () => {
    expect(hostDraft(pve).ips).toEqual(["10.0.0.3"]);
  });
});

describe("Proxmox guests", () => {
  const known = [
    { key: "host:3", names: ["Proxmox One", "pve1"] },
    { key: "host:7", names: ["k3s-master-1", "master"] },
  ];

  it("match a Termix host by name and link it to its node", () => {
    const { assets, edges } = deriveWorkloads([pve], known);
    expect(assets.map((asset) => asset.key)).toEqual(["guest:pve1/201"]);
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: "host:7",
        to: "host:3",
        type: "runs_on",
        detail: { vmid: 115, type: "qemu", node: "pve1" },
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ from: "guest:pve1/201", to: "host:3" }),
    );
  });

  it("match by collected hostname too, ignoring case", () => {
    const { assets } = deriveWorkloads(
      [pve],
      [
        { key: "host:3", names: ["Proxmox One", "pve1"] },
        { key: "host:8", names: ["dns", "DNS-Secondary"] },
      ],
    );
    expect(assets.map((asset) => asset.key)).toEqual(["guest:pve1/115"]);
  });

  it("do not match a name two hosts share", () => {
    const index = nameIndex([
      { key: "host:7", names: ["k3s-master-1"] },
      { key: "host:9", names: ["K3S-MASTER-1"] },
    ]);
    expect(index.get("k3s-master-1")).toBeNull();
    const { assets } = deriveWorkloads(
      [pve],
      [
        { key: "host:3", names: ["pve1"] },
        { key: "host:7", names: ["k3s-master-1"] },
        { key: "host:9", names: ["k3s-master-1"] },
      ],
    );
    expect(assets.map((asset) => asset.key)).toContain("guest:pve1/115");
  });

  it("are kept without an edge when their node is not a Termix host", () => {
    const { assets, edges } = deriveWorkloads([pve], []);
    expect(assets).toHaveLength(2);
    expect(edges).toEqual([]);
  });

  it("are listed once when every node of a cluster reports them", () => {
    const pve2 = { ...pve, hostId: 4 };
    const { assets } = deriveWorkloads([pve, pve2], known);
    expect(assets.filter((asset) => asset.kind === "guest")).toHaveLength(1);
    expect(assets[0].hostId).toBe(3);
  });
});

describe("containers", () => {
  it("run on the host that reported them", () => {
    const { assets, edges } = deriveWorkloads([web], []);
    expect(assets.map((asset) => asset.key)).toEqual([
      "container:1/app-db",
      "container:1/grafana",
    ]);
    expect(edges[0]).toMatchObject({
      from: "container:1/app-db",
      to: "host:1",
      type: "runs_on",
    });
  });
});

describe("connections", () => {
  const index = buildIpIndex([
    { key: "host:1", kind: "host", ips: ["10.0.0.1"] },
    { key: "host:2", kind: "host", ips: ["10.0.0.2"] },
  ]);

  it("link to a known asset with ports, processes and a count", () => {
    const { edges } = deriveConnections(web, index);
    expect(edges).toContainEqual(
      expect.objectContaining({
        from: "host:1",
        to: "host:2",
        type: "connects_to",
        detail: {
          ports: [5432],
          processes: ["app"],
          count: 2,
          peers: ["10.0.0.2"],
        },
      }),
    );
  });

  it("make an external asset for an address outside the inventory", () => {
    const { edges, externals } = deriveConnections(web, index);
    expect(externals).toEqual(["93.184.216.34", "100.100.103.88"]);
    expect(
      edges.find((edge) => edge.to === "external:93.184.216.34"),
    ).toMatchObject({
      detail: { ports: [443], count: 2 },
    });
  });

  it("ignore inbound clients, bridges, loopback and ephemeral peer ports", () => {
    const targets = deriveConnections(web, index).edges.map((edge) => edge.to);
    expect(targets).not.toContain("external:10.0.0.9");
    expect(targets).not.toContain("external:203.0.113.50");
    expect(targets).not.toContain("external:172.17.0.2");
    expect(targets).not.toContain("external:198.51.100.7");
    expect(targets.some((key) => key.includes("127.0.0.1"))).toBe(false);
  });

  it("skip an address two assets claim", () => {
    const ambiguous = buildIpIndex([
      { key: "host:2", kind: "host", ips: ["10.0.0.2"] },
      { key: "host:5", kind: "host", ips: ["10.0.0.2"] },
    ]);
    const targets = deriveConnections(web, ambiguous).edges.map((e) => e.to);
    expect(targets).not.toContain("host:2");
    expect(targets).not.toContain("external:10.0.0.2");
  });

  it("prefer a host over the external asset an address once was", () => {
    const later = buildIpIndex([
      { key: "external:10.0.0.2", kind: "external", ips: ["10.0.0.2"] },
      { key: "host:2", kind: "host", ips: ["10.0.0.2"] },
    ]);
    expect(later.get("10.0.0.2")).toBe("host:2");
  });

  it("keep only the busiest external peers per host", () => {
    const connections = Array.from({ length: EXTERNAL_CAP + 10 }, (_, i) => ({
      direction: "out" as const,
      peer: `198.51.100.${i + 1}`,
      port: 443,
      processes: [],
      count: i + 1,
    }));
    const busy: CollectedHost = { ...web, facts: { connections } };
    const { edges, externals } = deriveConnections(busy, new Map());
    expect(externals).toHaveLength(EXTERNAL_CAP);
    expect(edges).toHaveLength(EXTERNAL_CAP);
    expect(externals[0]).toBe(`198.51.100.${EXTERNAL_CAP + 10}`);
    expect(externals).not.toContain("198.51.100.1");
  });
});
