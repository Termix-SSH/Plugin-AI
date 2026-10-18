import { deriveEntries } from "../../../src/backend/exposure/derive.js";
import * as execOps from "../../../src/backend/ops/exec.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, type TestServer } from "../helpers.js";
import { createExposureRepository } from "../../../src/backend/exposure/repository.js";
import { createExposureService } from "../../../src/backend/exposure/service.js";
import { derived, host, listener, observation } from "./fixtures.js";
let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});
async function setup(
  permissions = ["ai.use", "ai.assets.view", "ai.assets.manage"],
) {
  server = await startServer({
    permissions,
    extraHosts: [
      { id: 2, name: "gateway" },
      { id: 3, name: "backend" },
    ],
  });
  await server.enableFor("user-1");
  const repo = await createExposureRepository({ db: server.db.database });
  const o = observation(
    [
      {
        ...listener(443),
        kind: "mapping",
        backend: { address: "10.0.0.2", port: 80, protocol: "tcp" },
      },
    ],
    true,
    new Date().toISOString(),
  );
  await repo.apply(o, derived(o, [host(), host(2, "10.0.0.2")]));
  return { s: server, repo, o };
}
describe("exposure authorization and durable notification", () => {
  it("persists OpenWrt results even when secure Python projection is unavailable", async () => {
    const { s, repo } = await setup();
    const section = (name: string, code: number, output = "") =>
      `\n__TERMIX_EXPOSURE__ ${name}\n${output}\n__TERMIX_EXPOSURE__ status ${code}\n`;
    const exec = vi
      .spyOn(execOps, "execOnHost")
      .mockImplementation(async () => ({
        exitCode: 0,
        output: [
          section("listen", 127),
          section("docker", 127),
          section("nft", 127),
          section("iptables", 127),
          section(
            "uci",
            0,
            "firewall.web=redirect\nfirewall.web.src_dport='443'\nfirewall.web.dest_ip='10.0.0.2'\nfirewall.web.dest_port='8443'\nfirewall.web.proto='tcp'\n__TERMIX_UCI_STATUS_0",
          ),
          // No python3: no second session, its sources are unsupported.
          section("python", 1),
        ].join(""),
        durationMs: 1,
      }));
    const service = createExposureService(s.mock.ctx, repo, {
      listAssets: async () => [host()],
    } as never);
    try {
      await service.collect(
        [
          {
            hostId: 1,
            name: "gateway",
            address: "10.0.0.1",
            facts: {} as never,
            complete: true,
          },
        ],
        "user-1",
      );
      const rows = (await repo.listEntries()).filter((e) => e.source === "uci");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ staleAt: null, backend: { port: 8443 } });
      // One SSH session per host, not one per source.
      expect(exec).toHaveBeenCalledTimes(1);
      expect(
        (await repo.listObservations()).find((o) => o.source === "nginx")
          ?.status,
      ).toBe("unsupported");
    } finally {
      service.close();
      exec.mockRestore();
    }
  });
  it("requires the inventory permission", async () => {
    const { s } = await setup(["ai.use"]);
    expect((await s.request("GET", "/assets/exposure")).status).toBe(403);
  });
  it("filters cross-host entries and historical changes when a target permission is revoked", async () => {
    const { s, repo, o } = await setup();
    const update = observation(
      [{ ...o.records[0], tls: "configured" }],
      true,
      new Date(Date.now() + 1).toISOString(),
    );
    await repo.apply(update, derived(update, [host(), host(2, "10.0.0.2")]));
    let response = await s.request("GET", "/assets/exposure");
    expect(response.body.entries).toHaveLength(1);
    const key = response.body.entries[0].key;
    s.mock.ctx.hosts.checkAccess = async (id) => ({
      hasAccess: id === 1,
      isOwner: id === 1,
      isShared: false,
    });
    response = await s.request("GET", "/assets/exposure");
    expect(response.body.entries).toEqual([]);
    expect(response.body.total).toBe(0);
    expect(JSON.stringify(response.body)).not.toContain("10.0.0.2");
    expect(response.body.changes.every((c: any) => !c.after && !c.before)).toBe(
      true,
    );
    expect(
      (
        await s.request("PUT", `/assets/exposure/${key}/priority`, {
          body: { priority: "low" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await s.request("POST", `/assets/exposure/${key}/explain`)).status,
    ).toBe(404);
  });
  it("filters an entire branched path and its counts after downstream access is revoked", async () => {
    const { s, repo } = await setup();
    const h = host(2, "10.0.0.2"),
      backend = host(3, "10.0.0.3");
    const o = {
      ...observation(
        [0, 1].map((i) => ({
          ...listener(80),
          objectKey: `route-${i}`,
          kind: "proxy" as const,
          hostname: `route-${i}.example`,
          backend: {
            address: "10.0.0.3",
            port: 5432,
            protocol: "tcp" as const,
          },
        })),
        true,
        new Date().toISOString(),
      ),
      source: "caddy" as const,
      hostId: 2,
    };
    await repo.apply(
      o,
      deriveEntries(o, {
        host: h,
        assets: [h, backend],
        ownerId: "user-1",
        observationId: o.id,
        at: o.at,
      }),
    );
    let response = await s.request("GET", "/assets/exposure");
    expect(response.body.entries[0].paths).toHaveLength(2);
    const key = response.body.entries[0].key;
    s.mock.ctx.hosts.checkAccess = async (id) => ({
      hasAccess: id !== 3,
      isOwner: id !== 3,
      isShared: false,
    });
    response = await s.request("GET", "/assets/exposure");
    expect(response.body.entries).toEqual([]);
    expect(response.body.summary.internet).toBe(0);
    expect(JSON.stringify(response.body)).not.toMatch(
      /route-0.example|10.0.0.3/,
    );
    expect(
      (await s.request("POST", `/assets/exposure/${key}/explain`)).status,
    ).toBe(404);
    expect(
      (
        await s.request("PUT", `/assets/exposure/${key}/priority`, {
          body: { priority: "low" },
        })
      ).status,
    ).toBe(404);
  });
  it("defaults to internet candidates and keeps internal evidence searchable in the all view", async () => {
    const { s, repo } = await setup();
    const h = host(1, "10.0.0.1"),
      o = {
        ...observation([listener(5353)], true, new Date().toISOString()),
        source: "docker" as const,
      };
    await repo.apply(
      o,
      deriveEntries(o, {
        host: h,
        assets: [h],
        ownerId: o.ownerId,
        observationId: o.id,
        at: o.at,
      }),
    );
    expect((await s.request("GET", "/assets/exposure")).body.total).toBe(1);
    const all = await s.request("GET", "/assets/exposure?scope=all");
    expect(all.body.total).toBe(2);
    expect(all.body.summary).toMatchObject({ internet: 1, all: 2 });
    const found = await s.request(
      "GET",
      "/assets/exposure?scope=all&q=10.0.0.1",
    );
    expect(found.body.entries).toHaveLength(1);
    expect(found.body.entries[0].priority).toBe("low");
  });
  it("does not grant override permission to viewers", async () => {
    const { s, repo } = await setup(["ai.use", "ai.assets.view"]);
    const entry = (await repo.listEntries())[0];
    expect(
      (
        await s.request("PUT", `/assets/exposure/${entry.key}/priority`, {
          body: { priority: "low" },
        })
      ).status,
    ).toBe(403);
  });
  it("persists owner-visible priority decisions and validates the value", async () => {
    const { s, repo } = await setup();
    const e = (await repo.listEntries())[0];
    expect(
      (
        await s.request("PUT", `/assets/exposure/${e.key}/priority`, {
          body: { priority: "made-up" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await s.request("PUT", `/assets/exposure/${e.key}/priority`, {
          body: { priority: "low" },
        })
      ).status,
    ).toBe(200);
    expect((await repo.listEntries())[0].prioritySource).toBe("user");
  });
  it("paginates after authorization and filters", async () => {
    const { s, repo } = await setup();
    const o = observation(
      [listener(80), listener(443), listener(22)],
      true,
      new Date(Date.now() + 1).toISOString(),
    );
    await repo.apply(o, derived(o));
    const page = await s.request("GET", "/assets/exposure?limit=1&offset=1");
    expect(page.body.entries).toHaveLength(1);
    expect(page.body.total).toBe(3);
    const filtered = await s.request("GET", "/assets/exposure?priority=high");
    expect(filtered.body.entries.every((e: any) => e.priority === "high")).toBe(
      true,
    );
  });
  it("retries a batch with the same dedupe key, then stops sending it", async () => {
    const { s, repo } = await setup();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    s.mock.ctx.notify.send = send;
    const service = createExposureService(s.mock.ctx, repo, {
      listAssets: async () => [],
    } as never);
    await service.notify();
    expect((await repo.listChanges())[0].noticeStatus).toBe("pending");
    await service.notify();
    await service.notify();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].dedupeKey).toBe(
      send.mock.calls[1][0].dedupeKey,
    );
    expect((await repo.listChanges())[0].noticeStatus).toBe("sent");
    service.close();
  });
  it("withholds notification when source access is revoked", async () => {
    const { s, repo } = await setup();
    const send = vi.fn();
    s.mock.ctx.notify.send = send;
    s.mock.ctx.hosts.checkAccess = async () => ({
      hasAccess: false,
      isOwner: false,
      isShared: false,
    });
    const service = createExposureService(s.mock.ctx, repo, {
      listAssets: async () => [],
    } as never);
    await service.notify();
    expect(send).not.toHaveBeenCalled();
    expect((await repo.listChanges())[0].noticeStatus).toBe("withheld");
    service.close();
  });
});
