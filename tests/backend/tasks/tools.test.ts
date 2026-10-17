import { describe, expect, it, vi } from "vitest";
import type { CliTarget } from "../../../src/backend/ops/cli.js";
import {
  createTaskTools,
  parsePlan,
  type TaskToolSession,
} from "../../../src/backend/tasks/tools.js";
import type { ToolContext } from "../../../src/backend/tools/types.js";
import { REPORT } from "./fixtures";
import { spawnRun, writeFakeCli } from "../ops/fake-cli";

function session(overrides: Partial<TaskToolSession> = {}): TaskToolSession {
  return {
    targets: [1, 2],
    limits: { concurrency: 4, timeoutSec: 120, outputLimit: 4000 },
    signal: new AbortController().signal,
    facts: new Map(),
    onHostResult: () => undefined,
    recordRuns: async () => undefined,
    autonomy: "propose",
    wrapUp: () => null,
    secondsLeft: () => 600,
    plan: null,
    report: null,
    onReport: () => undefined,
    cli: null,
    recordCliRun: async () => undefined,
    ...overrides,
  };
}

const context = {
  userId: "user-1",
  conversationId: 1,
  allowReadOnlyCommands: false,
  deps: { audit: { record: async () => undefined } },
} as unknown as ToolContext;

const cliPath = writeFakeCli();
const cli = (run: CliTarget["run"] = spawnRun): CliTarget => ({
  run,
  cliPath,
  url: "http://127.0.0.1:30001",
  token: async () => "task-token",
});

const tool = (tools: ReturnType<typeof createTaskTools>, name: string) =>
  tools.find((entry) => entry.name === name)!;

const host = {
  hostId: 1,
  commands: ["docker image prune -f"],
  rationale: "2G of dangling images",
  risk: "Low",
  rollback: "Images are pulled again when needed",
  verify: ["docker system df"],
};

describe("task tools", () => {
  it("offers propose_plan only at L1", () => {
    const names = (autonomy: "report" | "propose") =>
      createTaskTools(session({ autonomy })).map((entry) => entry.name);
    expect(names("report")).not.toContain("propose_plan");
    expect(names("propose")).toContain("propose_plan");
    expect(names("report")).not.toContain("termix");
  });

  it("refuses commands off the read-only allowlist before reaching a host", async () => {
    const tools = createTaskTools(session());
    for (const command of [
      "docker image prune -f",
      "rm -rf /tmp",
      "apt-get clean",
      "find /var/log -name '*.gz' -delete",
    ]) {
      const result = (await tool(tools, "run_command").handler(
        { command },
        context,
      )) as { error?: string };
      expect(result.error, command).toMatch(/^Refused/);
    }
  });

  it("makes the model report once time or budget is nearly gone", async () => {
    const tools = createTaskTools(
      session({ wrapUp: () => "Time is nearly up.", cli: cli() }),
    );
    for (const name of ["run_command", "get_host_facts", "termix"]) {
      const result = (await tool(tools, name).handler(
        { command: "uptime" },
        context,
      )) as { error?: string };
      expect(result.error).toBe("Time is nearly up. Call submit_report now.");
    }
  });

  it("records a valid plan and refuses a bad one", async () => {
    const state = session();
    const propose = tool(createTaskTools(state), "propose_plan");
    expect(
      await propose.handler({ summary: "x", hosts: [host] }, context),
    ).toMatchObject({ status: "recorded" });
    expect(state.plan).toEqual([host]);

    const bad = [
      { ...host, hostId: 9 },
      { ...host, commands: [] },
      { ...host, verify: ["rm -rf /"] },
      { ...host, rollback: "" },
    ];
    for (const entry of bad) {
      expect(parsePlan([entry], [1, 2])).toHaveProperty("error");
    }
    expect(parsePlan([host, host], [1, 2])).toHaveProperty("error");
  });

  it("takes a report only with the four sections, then ends the run", async () => {
    const onReport = vi.fn();
    const state = session({ onReport });
    const submit = tool(createTaskTools(state), "submit_report");
    expect(
      await submit.handler(
        { severity: "info", summary: "ok", report: "All fine" },
        context,
      ),
    ).toHaveProperty("error");
    expect(
      await submit.handler(
        { severity: "loud", summary: "ok", report: REPORT },
        context,
      ),
    ).toHaveProperty("error");
    expect(onReport).not.toHaveBeenCalled();
    await submit.handler(
      { severity: "critical", summary: "Disk full", report: REPORT },
      context,
    );
    expect(state.report).toEqual({
      severity: "critical",
      summary: "Disk full",
      report: REPORT,
    });
    expect(onReport).toHaveBeenCalledOnce();
  });

  it("offers termix only with a CLI, at either level", () => {
    const names = (autonomy: "report" | "propose") =>
      createTaskTools(session({ autonomy, cli: cli() })).map(
        (entry) => entry.name,
      );
    expect(names("report")).toContain("termix");
    expect(names("propose")).toContain("termix");
  });

  it("runs read-only CLI commands and refuses the rest before starting it", async () => {
    const run = vi.fn(spawnRun);
    const tools = createTaskTools(
      session({ autonomy: "report", cli: cli(run) }),
    );
    const termix = tool(tools, "termix");
    for (const args of [
      ["hosts", "delete", "1"],
      ["alerts", "dismiss", "3"],
      ["api", "POST", "/host/db/host"],
      ["exec", "1", "uptime"],
      ["hosts", "--folder", "list", "delete", "1"],
    ]) {
      const result = (await termix.handler({ args }, context)) as {
        error?: string;
      };
      expect(result.error, args.join(" ")).toMatch(/^Refused/);
    }
    // Read-only, but still held to the assistant's own blocks.
    const exported = (await termix.handler(
      { args: ["api", "GET", "/host/db/host/export"] },
      context,
    )) as { error?: string };
    expect(exported.error).toMatch(/return secrets/);
    expect(run).not.toHaveBeenCalled();

    const listed = (await termix.handler(
      { args: ["hosts", "list"] },
      context,
    )) as { exitCode: number; output: string };
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.output).argv.slice(-2)).toEqual(["hosts", "list"]);
    expect(run).toHaveBeenCalledOnce();
  });
});
