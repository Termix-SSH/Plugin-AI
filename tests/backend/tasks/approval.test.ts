import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "../helpers";
import { fakeSshClient, type FakePlan } from "../ops/fake-ssh";
import { shellQuote } from "../../../src/backend/ops/exec.js";
import { eventually, insertTask, OPS_PERMISSIONS, taskRows } from "./fixtures";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const PLAN = [
  {
    hostId: 1,
    commands: ["apt-get clean", "journalctl --vacuum-time=7d"],
    rationale: "Caches",
    risk: "Low",
    rollback: "None",
    verify: ["df -hP /"],
  },
  {
    hostId: 2,
    commands: ["docker builder prune -f"],
    rationale: "Build cache",
    risk: "Low",
    rollback: "None",
    verify: ["docker system df"],
  },
];

async function start(
  permissions: string[],
  plan: (command: string) => FakePlan = () => ({ stdout: "ok\n" }),
) {
  const ssh = fakeSshClient(plan);
  server = await startServer({
    permissions,
    sshClient: ssh.client,
    extraHosts: [{ id: 2, name: "db-1" }],
  });
  await server.enableFor("user-1");
  await server.enableFor("user-2");
  const id = insertTask(server, {
    plan: JSON.stringify(PLAN),
    host_ids: "[1,2]",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    report: "## Verdict\nDisk is full",
  });
  return { server, ssh, id };
}

/** The commands that ran, unwrapped from the watchdog, in order. */
const ran = (ssh: ReturnType<typeof fakeSshClient>) =>
  ssh.channels.map((channel) => {
    const all = [
      "true",
      ...PLAN.flatMap((host) => [...host.commands, ...host.verify]),
    ];
    return all.find((command) =>
      channel.command.endsWith(` ${shellQuote(command)}`),
    );
  });

const statusOf = (target: TestServer, id: number) =>
  taskRows(target).find((row) => row.id === id)?.status;

describe("approving a plan", () => {
  it("runs it verbatim, per host in order, then verifies and reports", async () => {
    const { server, ssh, id } = await start(OPS_PERMISSIONS);
    const reply = await server.request("POST", `/tasks/${id}/approve`);
    expect(reply.status).toBe(202);
    await eventually(() => statusOf(server, id) === "done");

    expect(ran(ssh)).toEqual([
      "true",
      "apt-get clean",
      "journalctl --vacuum-time=7d",
      "df -hP /",
      "true",
      "docker builder prune -f",
      "docker system df",
    ]);
    const row = taskRows(server)[0];
    expect(row).toMatchObject({ decided_by: "user-1", severity: "info" });
    expect(String(row.report)).toContain("Disk is full");
    expect(String(row.report)).toContain("## Actions taken");
    const plan = JSON.parse(String(row.plan));
    expect(plan[0].results).toHaveLength(3);

    const audits = server.mock.audits
      .filter((entry) => entry.action === "ai_ops_command")
      .map((entry) => JSON.parse(String(entry.details)));
    expect(audits).toHaveLength(5);
    expect(audits.map((entry) => entry.phase)).toEqual([
      "execute",
      "execute",
      "verify",
      "execute",
      "verify",
    ]);
    expect(audits[0]).toMatchObject({
      command: "apt-get clean",
      source: "task",
      taskRunId: id,
      phase: "execute",
    });
    expect(server.mock.notifications.at(-1)?.notification).toMatchObject({
      category: "ai.task_executed",
      audience: { userId: "user-1" },
    });
  });

  it("stops a host at its first failure and skips its verify", async () => {
    const { server, ssh, id } = await start(OPS_PERMISSIONS, (command) =>
      command.includes("apt-get clean")
        ? { code: 1, stderr: "E: denied" }
        : { stdout: "ok" },
    );
    await server.request("POST", `/tasks/${id}/approve`);
    await eventually(() => statusOf(server, id) === "failed");
    expect(ran(ssh)).toEqual([
      "true",
      "apt-get clean",
      "true",
      "docker builder prune -f",
      "docker system df",
    ]);
    expect(taskRows(server)[0].severity).toBe("warning");
  });

  it("does not run on a host that cannot be reached", async () => {
    // The first host's probe fails, the second's does not.
    let probes = 0;
    const { server, ssh, id } = await start(OPS_PERMISSIONS, (command) =>
      command.endsWith(` ${shellQuote("true")}`) && probes++ === 0
        ? { code: 255 }
        : { stdout: "ok" },
    );
    await server.request("POST", `/tasks/${id}/approve`);
    await eventually(() => statusOf(server, id) === "failed");
    expect(ran(ssh)).not.toContain("apt-get clean");
    expect(ran(ssh)).toContain("docker builder prune -f");
  });

  it("lets the owner decide without ai.ops.use", async () => {
    const { server, id } = await start(["ai.use"]);
    const reply = await server.request("POST", `/tasks/${id}/reject`);
    expect(reply.status).toBe(200);
    expect(statusOf(server, id)).toBe("rejected");
  });

  it("lets a holder of ai.ops.use decide on someone else's plan", async () => {
    const { server, id } = await start(OPS_PERMISSIONS);
    const reply = await server.request("POST", `/tasks/${id}/approve`, {
      user: "user-2",
    });
    expect(reply.status).toBe(202);
    await eventually(() => statusOf(server, id) === "done");
    expect(taskRows(server)[0].decided_by).toBe("user-2");
  });

  it("refuses anyone else", async () => {
    const { server, ssh, id } = await start(["ai.use"]);
    for (const action of ["approve", "reject"]) {
      const reply = await server.request("POST", `/tasks/${id}/${action}`, {
        user: "user-2",
      });
      expect(reply.status).toBe(404);
    }
    expect(
      (await server.request("GET", `/tasks/${id}`, { user: "user-2" })).status,
    ).toBe(404);
    expect(statusOf(server, id)).toBe("proposed");
    expect(ssh.channels).toHaveLength(0);
  });

  it("decides once", async () => {
    const { server, id } = await start(OPS_PERMISSIONS);
    await server.request("POST", `/tasks/${id}/reject`);
    const again = await server.request("POST", `/tasks/${id}/approve`);
    expect(again.status).toBe(409);
  });

  it("refuses an expired plan and expires it", async () => {
    const { server, ssh } = await start(OPS_PERMISSIONS);
    const old = insertTask(server, {
      plan: JSON.stringify(PLAN),
      expires_at: new Date(Date.now() - 1000).toISOString(),
      automation_id: 8,
    });
    const reply = await server.request("POST", `/tasks/${old}/approve`);
    expect(reply.status).toBe(409);
    expect(statusOf(server, old)).toBe("expired");
    expect(ssh.channels).toHaveLength(0);
  });

  it("refuses a plan that reaches past the task's hosts", async () => {
    const { server, ssh } = await start(OPS_PERMISSIONS);
    const stale = insertTask(server, {
      plan: JSON.stringify(PLAN),
      host_ids: "[1]",
      automation_id: 9,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const reply = await server.request("POST", `/tasks/${stale}/approve`);
    expect(reply.status).toBe(409);
    expect(ssh.channels).toHaveLength(0);
  });

  it("expires plans on the timer", async () => {
    const { server, id } = await start(OPS_PERMISSIONS);
    const old = insertTask(server, {
      plan: JSON.stringify(PLAN),
      expires_at: new Date(Date.now() - 1000).toISOString(),
      automation_id: 8,
    });
    await server.mock.runScheduled();
    await eventually(() => statusOf(server, old) === "expired");
    expect(statusOf(server, id)).toBe("proposed");
  });

  it("refuses to run while paused, and the kill switch stops a running plan", async () => {
    const { server, id } = await start(OPS_PERMISSIONS, (command) =>
      command.includes("apt-get clean") ? { hang: true } : { stdout: "ok" },
    );
    await server.mock.ctx.settings.set("autoOpsPaused", true);
    expect((await server.request("POST", `/tasks/${id}/approve`)).status).toBe(
      409,
    );

    await server.mock.ctx.settings.set("autoOpsPaused", false);
    await server.request("POST", `/tasks/${id}/approve`);
    await eventually(() => statusOf(server, id) === "executing");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await server.mock.ctx.settings.set("autoOpsPaused", true);
    await eventually(() => statusOf(server, id) === "failed");
    expect(String(taskRows(server)[0].summary)).toMatch(/stopped/);
  });

  it("lists tasks for their owner and approvals for ai.ops.use", async () => {
    const { server, id } = await start(OPS_PERMISSIONS);
    const mine = await server.request("GET", "/tasks");
    expect(mine.body.tasks.map((task: { id: number }) => task.id)).toEqual([
      id,
    ]);
    const other = await server.request("GET", "/tasks", { user: "user-2" });
    expect(other.body.tasks).toEqual([]);
    expect(other.body.approvals.map((task: { id: number }) => task.id)).toEqual(
      [id],
    );
    const detail = await server.request("GET", `/tasks/${id}`);
    expect(detail.body.task).toMatchObject({
      canDecide: true,
      hostNames: { 1: "web-1", 2: "db-1" },
    });
  });
});
