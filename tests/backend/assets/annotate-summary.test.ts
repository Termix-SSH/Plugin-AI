import { describe, expect, it } from "vitest";
import {
  buildUnits,
  fingerprint,
} from "../../../src/backend/assets/annotate-summary";
import { assetRecord, edgeRecord } from "./records";

function inventory(overrides: { uptime?: number; count?: number } = {}) {
  const web = assetRecord("host:1", {
    hostId: 1,
    name: "web-1",
    multiZone: true,
    facts: {
      os: { pretty: "Ubuntu 24.04.4 LTS" },
      hostname: "web-1",
      uptimeSec: overrides.uptime ?? 1000,
      listening: [
        { proto: "tcp", address: "0.0.0.0", port: 443, process: "nginx" },
        {
          proto: "tcp",
          address: "127.0.0.1",
          port: 6379,
          process: "redis-server",
        },
        { proto: "tcp", address: "::", port: 443, process: "nginx" },
      ],
      services: [
        { name: "nginx.service", description: "A high performance web server" },
        { name: "cron.service", description: "Regular background program" },
        { name: "systemd-journald.service", description: "Journal Service" },
        { name: "docker.service", description: "Docker" },
      ],
      containers: [],
      kubernetes: ["k3s"],
      connections: [
        {
          direction: "out",
          peer: "10.0.0.2",
          port: 5432,
          processes: ["app"],
          count: overrides.count ?? 3,
        },
      ],
      interfaces: [{ name: "eth0", addrs: ["10.0.0.1/24"] }],
    },
  });
  const db = assetRecord("host:2", { hostId: 2, name: "db-1", facts: {} });
  const app = assetRecord("container:1/app", {
    hostId: 1,
    name: "app",
    facts: {
      container: {
        id: "abc",
        name: "app",
        image: "shop/api:1.4",
        state: "running",
        status: `Up ${overrides.uptime ?? 1000} seconds`,
        ports: "0.0.0.0:8080->80/tcp",
        networks: ["bridge"],
      },
    },
  });
  const outside = assetRecord("external:93.184.216.34", { kind: "external" });
  const edges = [
    edgeRecord(web, db, "connects_to", {
      detail: {
        ports: [5432],
        processes: ["app"],
        count: overrides.count ?? 3,
        peers: ["10.0.0.2"],
      },
    }),
    edgeRecord(web, outside, "connects_to", {
      detail: {
        ports: [443],
        processes: ["curl"],
        count: 1,
        peers: ["93.184.216.34"],
      },
    }),
    edgeRecord(app, web, "runs_on"),
    edgeRecord(web, db, "depends_on", { source: "ai" }),
  ];
  const meta = new Map([[1, { folder: "Shop", tags: "prod, web" }]]);
  return { assets: [web, db, app, outside], edges, meta, web, db, app };
}

describe("asset summaries", () => {
  it("put a host and its containers in one unit, and never send external assets", () => {
    const { assets, edges, meta } = inventory();
    const units = buildUnits(assets, edges, meta);
    expect(units.map((unit) => unit.key)).toEqual(["host:1", "host:2"]);
    expect(units[0].members.map((m) => m.asset.key)).toEqual([
      "host:1",
      "container:1/app",
    ]);
    expect(
      units.flatMap((u) => u.members).some((m) => m.asset.kind === "external"),
    ).toBe(false);
  });

  it("are compact facts with no secrets, noise or addresses outside", () => {
    const { assets, edges, meta } = inventory();
    const [web] = buildUnits(assets, edges, meta);
    expect(web.members[0].text).toBe(
      [
        "[host:1] web-1 (host)",
        "  zone: internal (multi-zone)",
        "  termix: folder=Shop tags=prod,web",
        "  os: Ubuntu 24.04.4 LTS",
        "  listening: tcp/443 nginx; tcp/6379 redis-server (local only)",
        "  services: docker, nginx",
        "  kubernetes: k3s",
        "  outbound: db-1 [host:2] tcp/5432 (app)",
        "  outbound external: 1 addresses on tcp/443",
      ].join("\n"),
    );
    expect(web.members[1].text).toBe(
      [
        "[container:1/app] app (container)",
        "  zone: internal",
        "  image: shop/api:1.4",
        "  state: running",
        "  ports: 0.0.0.0:8080->80/tcp",
      ].join("\n"),
    );
    expect(web.text).not.toContain("93.184.216.34");
    expect(web.text).not.toContain("depends_on");
    expect(web.text).not.toContain("Up ");
  });

  it("keep the same fingerprint while only counters and uptime move", () => {
    const first = inventory();
    const second = inventory({ uptime: 99_999, count: 42 });
    const prints = (data: ReturnType<typeof inventory>) =>
      buildUnits(data.assets, data.edges, data.meta).flatMap((unit) =>
        unit.members.map((member) => member.fingerprint),
      );
    expect(prints(second)).toEqual(prints(first));
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
  });

  it("cap long lists", () => {
    const host = assetRecord("host:9", {
      hostId: 9,
      facts: {
        listening: Array.from({ length: 60 }, (_, i) => ({
          proto: "tcp",
          address: "0.0.0.0",
          port: 10_000 + i,
          process: "svc",
        })),
      },
    });
    const [unit] = buildUnits([host], [], new Map());
    expect(unit.text).toContain("+20 more");
  });

  it("list a Proxmox node's guests on the node", () => {
    const node = assetRecord("host:3", { hostId: 3, name: "pve1", facts: {} });
    const guest = assetRecord("guest:pve1/201", {
      hostId: 3,
      name: "backup",
      facts: {
        guest: {
          vmid: 201,
          node: "pve1",
          name: "backup",
          type: "lxc",
          status: "running",
        },
      },
    });
    const vm = assetRecord("host:7", { hostId: 7, name: "k3s-1", facts: {} });
    const edges = [
      edgeRecord(guest, node, "runs_on"),
      edgeRecord(vm, node, "runs_on"),
    ];
    const units = buildUnits([node, guest, vm], edges, new Map());
    const pve = units.find((unit) => unit.key === "host:3")!;
    expect(pve.members.map((m) => m.asset.key)).toEqual([
      "host:3",
      "guest:pve1/201",
    ]);
    expect(pve.text).toContain(
      "proxmox node, guests: backup [guest:pve1/201]; k3s-1 [host:7]",
    );
    expect(pve.text).toContain("proxmox lxc 201 on node pve1, running");
    expect(units.find((unit) => unit.key === "host:7")!.text).toContain(
      "runs on: pve1 [host:3]",
    );
  });
});
