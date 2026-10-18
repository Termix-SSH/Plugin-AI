import { describe, expect, it, vi } from "vitest";
import {
  createOpsTools,
  summaryBudgetFor,
  type HostResult,
  type OpsSession,
} from "../../../src/backend/ops/tools.js";
import type { OpsRunInput } from "../../../src/backend/repository.js";
import type { ToolContext } from "../../../src/backend/tools/types.js";
import { fakeSshClient, type FakePlan } from "./fake-ssh";

const HOSTS = [1, 2, 3, 4, 5].map((id) => ({
  id,
  userId: "user-1",
  name: `web-${id}`,
  ip: `10.0.0.${id}`,
  port: 22,
  username: "root",
  tags: "prod",
  folder: null,
  authType: "password",
}));

function setup(
  options: {
    targets?: number[];
    concurrency?: number;
    outputLimit?: number;
    summaryBudget?: number;
    plan?: (command: string, hostId: number) => FakePlan;
    denied?: number[];
  } = {},
) {
  const clients = new Map<number, ReturnType<typeof fakeSshClient>>();
  let running = 0;
  let peak = 0;
  const withConnection = vi.fn(
    async (
      hostId: number,
      _options: unknown,
      fn: (client: unknown) => Promise<unknown>,
    ) => {
      const ssh = fakeSshClient((command) =>
        (options.plan ?? (() => ({ stdout: "ok", delayMs: 5 })))(
          command,
          hostId,
        ),
      );
      clients.set(hostId, ssh);
      running += 1;
      peak = Math.max(peak, running);
      try {
        return await fn(ssh.client);
      } finally {
        running -= 1;
      }
    },
  );
  const record = vi.fn(async () => {});
  const recordRuns = vi.fn(async (_runs: OpsRunInput[]) => {});
  const progress: HostResult[] = [];
  const abort = new AbortController();

  const session: OpsSession = {
    targets: options.targets ?? [1, 2, 3, 4, 5],
    limits: {
      concurrency: options.concurrency ?? 8,
      timeoutSec: 120,
      outputLimit: options.outputLimit ?? 4000,
      summaryBudget: options.summaryBudget,
    },
    signal: abort.signal,
    facts: new Map(),
    onHostResult: (_tool, _command, result) => progress.push(result),
    recordRuns,
  };
  const context = {
    userId: "user-1",
    conversationId: 7,
    allowReadOnlyCommands: false,
    deps: {
      hosts: {
        list: vi.fn(async () => HOSTS),
        checkAccess: vi.fn(async (hostId: number) => ({
          hasAccess: !(options.denied ?? []).includes(hostId),
        })),
      },
      ssh: { withConnection },
      audit: { record },
    },
  } as unknown as ToolContext;

  const tools = new Map(
    createOpsTools(session).map((tool) => [tool.name, tool]),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools.get(name)!.handler(args, context) as Promise<any>;

  return {
    call,
    session,
    abort,
    progress,
    recordRuns,
    record,
    withConnection,
    clients,
    peak: () => peak,
  };
}

describe("run_command", () => {
  it("fans out to every target within the concurrency limit", async () => {
    const ops = setup({ concurrency: 2 });
    const result = await ops.call("run_command", {
      hostIds: "all",
      command: "uptime",
    });

    expect(ops.peak()).toBe(2);
    expect(ops.withConnection).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({
      command: "uptime",
      succeeded: 5,
      failed: 0,
    });
    expect(result.hosts.map((host: { name: string }) => host.name)).toEqual([
      "web-1",
      "web-2",
      "web-3",
      "web-4",
      "web-5",
    ]);
    // One progress event per host, as each finishes.
    expect(ops.progress.map((host) => host.hostId).sort()).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("reports each host's exit code and truncated output", async () => {
    const ops = setup({
      outputLimit: 10,
      plan: (_command, hostId) =>
        hostId === 2
          ? { stderr: "no unit", code: 4 }
          : { stdout: "a".repeat(30) + "TAIL" },
    });
    const result = await ops.call("run_command", {
      hostIds: [1, 2],
      command: "systemctl status nginx",
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.hosts[0]).toMatchObject({ id: 1, exitCode: 0 });
    expect(result.hosts[0].output).toBe(
      "aaaaa\n... 24 characters cut ...\naTAIL",
    );
    expect(result.hosts[1]).toMatchObject({
      id: 2,
      exitCode: 4,
      error: "Exited with code 4",
      output: "no unit",
    });
  });

  it("shares the summary budget between hosts", async () => {
    const plan = () => ({ stdout: "x".repeat(3000) });
    const small = await setup({ plan }).call("run_command", {
      hostIds: [1, 2, 3, 4, 5],
      command: "df -h",
    });
    expect(small.hosts[0].output).toBe("x".repeat(3000));

    const tight = await setup({ plan, summaryBudget: 5000 }).call(
      "run_command",
      { hostIds: [1, 2, 3, 4, 5], command: "df -h" },
    );
    expect(tight.hosts[0].output.length).toBeLessThan(1100);
  });

  it("sizes the summary budget from the context window", () => {
    expect(summaryBudgetFor(8192)).toBe(8000);
    expect(summaryBudgetFor(128000)).toBe(25600);
    expect(summaryBudgetFor(524288)).toBe(104857);
    expect(summaryBudgetFor(2_000_000)).toBe(160000);
  });

  it("records every run and audits each host", async () => {
    const ops = setup({ plan: () => ({ stdout: "done", code: 0 }) });
    await ops.call("run_command", { hostIds: [1, 3], command: "uptime" });

    expect(ops.recordRuns).toHaveBeenCalledTimes(1);
    const runs = ops.recordRuns.mock.calls[0][0];
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      conversationId: 7,
      userId: "user-1",
      hostId: 1,
      command: "uptime",
      exitCode: 0,
      output: "done",
    });
    expect(ops.record).toHaveBeenCalledTimes(2);
    expect(ops.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai_ops_command",
        resourceId: "3",
        success: true,
      }),
    );
  });

  it("rejects hosts outside the conversation's targets without running anything", async () => {
    const ops = setup({ targets: [1, 2] });
    const result = await ops.call("run_command", {
      hostIds: [2, 5],
      command: "reboot",
    });

    expect(result.error).toContain("5");
    expect(ops.withConnection).not.toHaveBeenCalled();
    expect(ops.recordRuns).not.toHaveBeenCalled();
  });

  it("checks connect access per host", async () => {
    const ops = setup({ denied: [2] });
    const result = await ops.call("run_command", {
      hostIds: [1, 2],
      command: "uptime",
    });

    expect(ops.withConnection).toHaveBeenCalledTimes(1);
    expect(result.hosts[1]).toMatchObject({ id: 2, error: "Host not found" });
  });

  it("stops a command at its timeout", async () => {
    vi.useFakeTimers();
    try {
      const ops = setup({ plan: () => ({ hang: true }) });
      const running = ops.call("run_command", {
        hostIds: [1],
        command: "sleep 999",
        timeoutSec: 5,
      });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await running;

      expect(result.hosts[0]).toMatchObject({
        exitCode: null,
        error: "Timed out",
      });
      expect(ops.clients.get(1)!.channels[0].closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps a requested timeout at 600 seconds", async () => {
    vi.useFakeTimers();
    try {
      const ops = setup({ plan: () => ({ hang: true }) });
      const running = ops.call("run_command", {
        hostIds: [1],
        command: "sleep 9999",
        timeoutSec: 9999,
      });
      await vi.advanceTimersByTimeAsync(599_000);
      expect(ops.progress).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await running).hosts[0].error).toBe("Timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes running commands and starts no more once aborted", async () => {
    const ops = setup({ concurrency: 2, plan: () => ({ hang: true }) });
    const running = ops.call("run_command", {
      hostIds: "all",
      command: "tail -f /var/log/syslog",
    });
    await vi.waitFor(() => expect(ops.clients.size).toBe(2));
    ops.abort.abort();
    const result = await running;

    expect(ops.withConnection).toHaveBeenCalledTimes(2);
    expect(result.notStarted).toBe(3);
    for (const ssh of ops.clients.values()) {
      expect(ssh.channels[0].closed).toBe(true);
    }
    // The two that did start are still recorded.
    expect(ops.recordRuns.mock.calls[0][0]).toHaveLength(2);
  });
});

describe("get_host_facts", () => {
  it("probes each host once per conversation", async () => {
    const ops = setup({ plan: () => ({ stdout: "Linux web 6.1" }) });
    const first = await ops.call("get_host_facts", { hostIds: [1, 2] });
    expect(first.hosts[0]).toMatchObject({ id: 1, facts: "Linux web 6.1" });
    expect(ops.withConnection).toHaveBeenCalledTimes(2);

    const second = await ops.call("get_host_facts", { hostIds: [1, 2, 3] });
    expect(second.hosts).toHaveLength(3);
    expect(ops.withConnection).toHaveBeenCalledTimes(3);
    expect(ops.progress.filter((host) => host.cached)).toHaveLength(2);

    const targets = await ops.call("list_targets", {});
    expect(targets.hosts[0]).toMatchObject({
      id: 1,
      name: "web-1",
      facts: "Linux web 6.1",
    });
    expect(targets.hosts[4].facts).toBeNull();
  });
});

describe("list_targets", () => {
  it("lists only the conversation's targets", async () => {
    const ops = setup({ targets: [2, 4] });
    const result = await ops.call("list_targets", {});
    expect(result.hosts.map((host: { id: number }) => host.id)).toEqual([2, 4]);
    expect(result.hosts[0]).toMatchObject({
      name: "web-2",
      ip: "10.0.0.2",
      tags: ["prod"],
    });
  });
});
