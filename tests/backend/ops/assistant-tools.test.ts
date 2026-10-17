import { describe, expect, it, vi } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import {
  createAssistantTools,
  type AssistantSession,
  type ClientAction,
} from "../../../src/backend/ops/assistant-tools.js";
import type { CliTarget } from "../../../src/backend/ops/cli.js";
import type { CliRunInput } from "../../../src/backend/repository.js";
import type { ToolContext } from "../../../src/backend/tools/types.js";
import { spawnRun, writeFakeCli } from "./fake-cli";

const host = (id: number, folder: string | null, tags: string | null) => ({
  id,
  userId: "user-1",
  name: `h${id}`,
  ip: `10.0.0.${id}`,
  port: 22,
  username: "root",
  tags,
  folder,
  authType: "password",
});

const HOSTS = [
  host(1, "prod", "web"),
  host(2, "prod / db", "db"),
  host(3, "staging", "web,db"),
  host(4, null, null),
];

function setup(cli: CliTarget | null = null, hostShell = true) {
  const mock = createMockCtx({
    capabilities: ["hosts:read"],
    hosts: HOSTS,
    services: {
      "fleets.access": {
        list: async () => [{ id: 7, name: "edge", color: null }],
        members: async (id: number) =>
          id === 7 ? [{ id: 4, name: "h4", ip: "10.0.0.4" }] : [],
      },
    },
  });
  const actions: ClientAction[] = [];
  const saved: number[][] = [];
  const cliRuns: CliRunInput[] = [];
  const session: AssistantSession = {
    hostShell,
    targets: [1],
    limits: { concurrency: 4, timeoutSec: 30, outputLimit: 4000 },
    signal: new AbortController().signal,
    facts: new Map(),
    onHostResult: () => {},
    recordRuns: async () => {},
    cli,
    saveTargets: async (ids) => {
      saved.push(ids);
    },
    clientAction: (action) => actions.push(action),
    recordCliRun: async (run) => {
      cliRuns.push(run);
    },
  };
  const tools = new Map(
    createAssistantTools(session).map((tool) => [tool.name, tool]),
  );
  const context: ToolContext = {
    userId: "user-1",
    conversationId: 12,
    allowReadOnlyCommands: false,
    deps: mock.ctx as unknown as ToolContext["deps"],
  };
  const call = (name: string, args: Record<string, unknown>) =>
    tools.get(name)!.handler(args, context);
  return { mock, session, actions, saved, cliRuns, call, tools };
}

describe("set_targets", () => {
  it("unions hosts, fleets, folders with their subfolders, and tags", async () => {
    const { session, saved, call } = setup();
    const result = await call("set_targets", {
      hostIds: [3, 99],
      fleetIds: [7],
      folders: ["Prod"],
      tags: ["nope"],
    });

    expect(result).toEqual({
      targets: 4,
      hostIds: [3, 1, 2, 4],
      notFound: ["host 99", "tag nope"],
    });
    expect(session.targets).toEqual([3, 1, 2, 4]);
    expect(saved).toEqual([[3, 1, 2, 4]]);
  });

  it("matches tags in a comma list, and an empty call clears", async () => {
    const { session, call } = setup();
    expect(await call("set_targets", { tags: ["db"] })).toMatchObject({
      hostIds: [2, 3],
    });
    expect(await call("set_targets", {})).toEqual({ targets: 0, hostIds: [] });
    expect(session.targets).toEqual([]);
  });
});

describe("UI tools", () => {
  it("asks the browser to open views and tells the model it asked", async () => {
    const { actions, call } = setup();
    expect(await call("open_host_terminal", { hostId: 2 })).toEqual({
      status: "requested",
    });
    await call("open_tab", { type: "docker", hostId: 3 });
    await call("open_tab", { type: "alerts" });
    await call("open_settings", { page: "keybindings", anchor: " " });
    await call("open_plugin_view", { id: "snippets" });

    expect(actions).toEqual([
      { kind: "open_host_terminal", hostId: 2 },
      { kind: "open_tab", type: "docker", hostId: 3 },
      { kind: "open_tab", type: "alerts" },
      { kind: "open_settings", page: "keybindings", anchor: undefined },
      { kind: "open_view", id: "snippets" },
    ]);
  });

  it("refuses hosts the user cannot see", async () => {
    const { actions, call } = setup();
    expect(await call("open_host_terminal", { hostId: 99 })).toEqual({
      error: "Host 99 not found",
    });
    expect(await call("open_tab", { type: "files", hostId: 99 })).toEqual({
      error: "Host 99 not found",
    });
    expect(actions).toEqual([]);
  });
});

describe("termix", () => {
  const cliPath = writeFakeCli();

  it("runs the CLI, audits and records the call with secrets redacted", async () => {
    const { mock, cliRuns, call } = setup({
      run: spawnRun,
      cliPath,
      url: "http://127.0.0.1:30001",
      token: async () => "jwt-1",
    });
    const result = (await call("termix", {
      args: ["credentials", "create", "--password", "hunter2"],
    })) as { exitCode: number; output: string };

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output).env.TERMIX_TOKEN).toBe("jwt-1");
    const stored = '["credentials","create","--password","[redacted]"]';
    expect(cliRuns).toEqual([
      expect.objectContaining({
        conversationId: 12,
        userId: "user-1",
        args: stored,
        exitCode: 0,
      }),
    ]);
    expect(mock.audits).toContainEqual(
      expect.objectContaining({
        action: "ai_cli_command",
        success: true,
        details: `{"args":${stored},"exitCode":0}`,
      }),
    );
    expect(JSON.stringify(mock.audits)).not.toContain("hunter2");
  });

  it("reports a failed call as an error with its output", async () => {
    const { mock, call } = setup({
      run: spawnRun,
      cliPath,
      url: "u",
      token: async () => "t",
    });
    expect(await call("termix", { args: ["fail"] })).toMatchObject({
      exitCode: 3,
      error: "Exited with code 3",
      output: expect.stringContaining("boom"),
    });
    expect(mock.audits.at(-1)).toMatchObject({ success: false });
  });

  it("gives the CLI a large window's summary budget", async () => {
    const { session, call } = setup({
      run: spawnRun,
      cliPath,
      url: "u",
      token: async () => "t",
    });
    const long = "h".repeat(30000);
    const cut = (await call("termix", { args: [long] })) as { output: string };
    expect(cut.output.length).toBeLessThan(17000);

    session.limits.summaryBudget = 100000;
    const whole = (await call("termix", { args: [long] })) as {
      output: string;
    };
    expect(whole.output).toContain(long);
  });

  it("refuses blocked commands without starting anything", async () => {
    const run = vi.fn(spawnRun);
    const { cliRuns, call } = setup({
      run,
      cliPath,
      url: "u",
      token: async () => "t",
    });
    expect(await call("termix", { args: ["ssh", "1"] })).toEqual({
      error: expect.stringContaining("run_command"),
    });
    expect(await call("termix", { args: "hosts list" })).toEqual({
      error: "args must be a list of strings",
    });
    expect(run).not.toHaveBeenCalled();
    expect(cliRuns).toEqual([]);
  });

  it("refuses host commands to a user without a shell on hosts", async () => {
    const run = vi.fn(spawnRun);
    const { cliRuns, call, tools } = setup(
      { run, cliPath, url: "u", token: async () => "t" },
      false,
    );
    expect(tools.has("set_targets")).toBe(false);
    expect(tools.get("termix")!.description).not.toContain("run_command");
    for (const args of [
      ["exec", "1", "uptime"],
      ["fleets", "exec", "3", "uptime"],
      ["snippets", "run", "4", "--host", "1"],
    ]) {
      expect(await call("termix", { args })).toEqual({
        error: expect.stringContaining("ai.ops.use"),
      });
    }
    expect(run).not.toHaveBeenCalled();
    expect(cliRuns).toEqual([]);

    expect(await call("termix", { args: ["hosts", "list"] })).toMatchObject({
      exitCode: 0,
    });
  });

  it("is not offered when the request had no session to run as", () => {
    const { tools } = setup(null);
    expect(tools.has("termix")).toBe(false);
  });
});
