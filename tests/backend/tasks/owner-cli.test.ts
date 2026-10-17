import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginProcess } from "@termix-ssh/plugin-sdk/backend";
import { startServer, type TestServer } from "../helpers";
import { fakeSshClient } from "../ops/fake-ssh";
import { writeFakeCli } from "../ops/fake-cli";
import {
  OPS_PERMISSIONS,
  prepare,
  runTask,
  scriptedModel,
  submit,
  taskInput,
  taskRows,
} from "./fixtures";

const fakeCli = vi.hoisted(() => ({ path: "" }));
vi.mock("../../../src/backend/ops/cli.js", async (original) => ({
  ...(await original<object>()),
  bundledCliPath: () => fakeCli.path,
}));
fakeCli.path = writeFakeCli();

const TOKEN = "minted-session-token-1234567890";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

/**
 * ctx.process.run that remembers each env it was given and runs a CLI that
 * prints a fixed listing, the way the real one never echoes its token.
 */
function recordingRun() {
  const envs: Array<Record<string, string>> = [];
  const run: PluginProcess["run"] = async (_file, _args, options) => {
    envs.push({ ...(options?.env ?? {}) });
    const child = spawn(
      process.execPath,
      ["-e", 'process.stdout.write(\'{"count":1,"hosts":[{"id":1}]}\')'],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    return {
      pid: child.pid,
      onStdout: (listener) => void child.stdout.on("data", listener),
      onStderr: (listener) => void child.stderr.on("data", listener),
      exited: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
      kill: (signal = "SIGTERM") => void child.kill(signal),
    };
  };
  return { run, envs };
}

interface NewerCtx {
  auth: { issueUserToken?: unknown };
  users?: { getLocale: (userId: string) => Promise<string | null> };
}

async function start(
  model: ReturnType<typeof scriptedModel>,
  core: {
    issue?: boolean;
    locale?: (userId: string) => Promise<string | null>;
  } = {},
) {
  const { run, envs } = recordingRun();
  await server?.close();
  server = await startServer({
    permissions: OPS_PERMISSIONS,
    fetch: model.fetch,
    sshClient: fakeSshClient(() => ({ stdout: "ok\n" })).client,
    process: { run },
  });
  await prepare(server);
  const ctx = server.mock.ctx as unknown as NewerCtx;
  const issue = vi.fn(async () => ({
    token: TOKEN,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  }));
  if (core.issue) ctx.auth.issueUserToken = issue;
  if (core.locale) ctx.users = { getLocale: core.locale };
  return { server, issue, envs };
}

const toolNames = (model: ReturnType<typeof scriptedModel>) =>
  (model.bodies[0].tools ?? []).map((tool) => tool.function.name);

function toolResults(server: TestServer): string[] {
  const rows = server.db.sqlite
    .prepare("SELECT content FROM p_ai_messages WHERE role = 'tool'")
    .all() as Array<{ content: string }>;
  return rows.map((row) => row.content);
}

/** Every row of every plugin table, and what core was told, as text. */
function everythingStored(server: TestServer): string {
  const tables = server.db.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'p_ai_%'",
    )
    .all() as Array<{ name: string }>;
  const rows = tables.map(({ name }) =>
    server.db.sqlite.prepare(`SELECT * FROM ${name}`).all(),
  );
  return JSON.stringify({
    rows,
    audits: server.mock.audits,
    notifications: server.mock.notifications,
  });
}

describe("the Termix CLI in tasks", () => {
  it("is absent on a core that cannot mint a user token", async () => {
    const model = scriptedModel(submit());
    const { server } = await start(model);
    expect((await runTask(server, taskInput())).status).toBe("reported");
    expect(toolNames(model)).not.toContain("termix");
    expect(model.bodies[0].messages[0].content).not.toContain("termix");
  });

  it("reads Termix as the owner with a short-lived token per call, never stored", async () => {
    const model = scriptedModel(
      ["termix", { args: ["hosts", "list"] }],
      ["termix", { args: ["alerts", "list"] }],
      submit(),
    );
    const { server, issue, envs } = await start(model, { issue: true });

    const result = await runTask(server, taskInput());
    expect(result.status).toBe("reported");
    expect(toolNames(model)).toContain("termix");
    expect(model.bodies[0].messages[0].content).toContain(
      "read-only CLI commands",
    );

    expect(issue).toHaveBeenCalledTimes(2);
    for (const call of issue.mock.calls as unknown as unknown[][]) {
      expect(call).toEqual([
        "user-1",
        { purpose: `auto-ops task ${result.taskRunId}`, ttlSeconds: 300 },
      ]);
    }
    expect(envs.map((env) => env.TERMIX_TOKEN)).toEqual([TOKEN, TOKEN]);

    const runs = server.db.sqlite
      .prepare("SELECT args, exit_code FROM p_ai_cli_runs ORDER BY id")
      .all();
    expect(runs).toEqual([
      { args: '["hosts","list"]', exit_code: 0 },
      { args: '["alerts","list"]', exit_code: 0 },
    ]);
    const audit = server.mock.audits.find(
      (entry) => entry.action === "ai_cli_command",
    );
    expect(JSON.parse(String(audit?.details))).toMatchObject({
      args: ["hosts", "list"],
      source: "task",
      taskRunId: result.taskRunId,
      phase: "investigate",
    });

    expect(everythingStored(server)).not.toContain(TOKEN);
  });

  it("refuses CLI commands that change Termix, without minting a token", async () => {
    const model = scriptedModel(
      ["termix", { args: ["hosts", "delete", "1"] }],
      ["termix", { args: ["api", "DELETE", "/host/db/host/1"] }],
      submit(),
    );
    const { server, issue, envs } = await start(model, { issue: true });
    await runTask(server, taskInput({ autonomy: "propose" }));

    const refusals = toolResults(server).filter((content) =>
      content.includes("Refused"),
    );
    expect(refusals).toHaveLength(2);
    expect(issue).not.toHaveBeenCalled();
    expect(envs).toEqual([]);
  });
});

describe("the report language", () => {
  async function promptFor(
    core: { locale?: (userId: string) => Promise<string | null> },
    saved?: string,
  ) {
    const model = scriptedModel(submit());
    const { server } = await start(model, core);
    if (saved) {
      await server.request("PUT", "/tasks/preferences", {
        body: { language: saved },
      });
    }
    await runTask(server, taskInput());
    expect(taskRows(server)).toHaveLength(1);
    return model.bodies[0].messages[0].content;
  }

  it("is the owner's Termix language when core can tell", async () => {
    const locale = vi.fn(async () => "zh_CN");
    expect(await promptFor({ locale }, "zh_TW")).toContain(
      "in Simplified Chinese",
    );
    expect(locale).toHaveBeenCalledWith("user-1");
  });

  it("falls back to the language the AI tab saved", async () => {
    expect(await promptFor({ locale: async () => null }, "zh_TW")).toContain(
      "in Traditional Chinese",
    );
    expect(await promptFor({}, "zh_TW")).toContain("in Traditional Chinese");
  });

  it("falls back to English when neither says, or core refuses", async () => {
    const refused = async () => {
      throw new Error('Plugin "ai" lacks capability "users:read"');
    };
    expect(await promptFor({ locale: refused })).toContain("in English");
    expect(await promptFor({})).toContain("in English");
  });
});
