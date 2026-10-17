import { afterEach, describe, expect, it } from "vitest";
import { manifest, startServer, type TestServer } from "../helpers";
import { fakeSshClient } from "../ops/fake-ssh";
import {
  eventually,
  hangingModel,
  insertTask,
  OPS_PERMISSIONS,
  prepare,
  REPORT,
  runTask,
  scriptedModel,
  sse,
  submit,
  taskInput,
  taskRows,
  text,
  toolCall,
  type ModelBody,
} from "./fixtures";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(
  model: { fetch: (url: string, init?: unknown) => Promise<Response> },
  options: {
    permissions?: string[];
    ssh?: ReturnType<typeof fakeSshClient>;
  } = {},
) {
  const ssh = options.ssh ?? fakeSshClient(() => ({ stdout: "ok\n" }));
  server = await startServer({
    permissions: options.permissions ?? OPS_PERMISSIONS,
    fetch: model.fetch,
    sshClient: ssh.client,
    extraHosts: [{ id: 2, name: "db-1" }],
  });
  await prepare(server);
  return { server, ssh };
}

const toolNames = (body: { tools?: Array<{ function: { name: string } }> }) =>
  (body.tools ?? []).map((tool) => tool.function.name).sort();

describe("ai.tasks service", () => {
  it("is declared as ai.tasks 1.0.0 behind ai.ops.use", () => {
    expect(
      (manifest as unknown as { provides: unknown[] }).provides,
    ).toContainEqual({
      service: "ai.tasks",
      version: "1.0.0",
      permission: "ai.ops.use",
    });
  });

  it("runs an L0 task to a report, as the owner, and records everything", async () => {
    const model = scriptedModel(
      ["run_command", { command: "df -hP" }],
      submit("warning", "Disk is filling up."),
    );
    const { server, ssh } = await start(model);

    const result = await runTask(server, taskInput());
    expect(result).toMatchObject({
      status: "reported",
      severity: "warning",
      summary: "Disk is filling up.",
    });
    expect(result.vars).toEqual({
      "ai.status": "reported",
      "ai.severity": "warning",
      "ai.summary": "Disk is filling up.",
      "ai.taskRunId": String(result.taskRunId),
    });

    // The model was offered only the read-only tools and the report.
    expect(toolNames(model.bodies[0])).toEqual([
      "get_host_facts",
      "list_targets",
      "run_command",
      "submit_report",
    ]);
    expect(model.bodies[0].messages[0].content).toContain("Check the disks.");
    expect(ssh.channels.some((c) => c.command.includes("df -hP"))).toBe(true);

    const [row] = taskRows(server);
    expect(row).toMatchObject({
      status: "reported",
      severity: "warning",
      report: REPORT,
      user_id: "user-1",
      automation_id: 7,
    });
    expect(Number(row.prompt_tokens)).toBeGreaterThan(0);
    const conversation = server.db.sqlite
      .prepare("SELECT * FROM p_ai_conversations WHERE id = ?")
      .get(row.conversation_id) as Record<string, unknown>;
    expect(conversation).toMatchObject({ mode: "task", targets: "[1]" });
    const sources = server.db.sqlite
      .prepare("SELECT DISTINCT source FROM p_ai_usage")
      .all() as Array<{ source: string }>;
    expect(sources.map((entry) => entry.source)).toEqual(["task"]);

    const audit = server.mock.audits.find(
      (entry) => entry.action === "ai_ops_command",
    );
    expect(JSON.parse(String(audit?.details))).toMatchObject({
      command: "df -hP",
      source: "task",
      taskRunId: result.taskRunId,
      phase: "investigate",
    });
    expect(server.mock.notifications).toContainEqual(
      expect.objectContaining({
        notification: expect.objectContaining({
          title: "AI report: Disk check",
          audience: { userId: "user-1" },
          link: { tab: "ai" },
          category: "ai.task_reported",
        }),
      }),
    );

    // The conversation opens in the assistant, to read and continue.
    const opened = await server.request(
      "GET",
      `/ops/conversations/${row.conversation_id}`,
    );
    expect(opened.status).toBe(200);
  });

  it("adds every model call of the run to its row, compaction included", async () => {
    const turns: Array<[string, Record<string, unknown>]> = [
      ["run_command", { command: "uptime" }],
      ["run_command", { command: "uptime" }],
      ["run_command", { command: "uptime" }],
      submit(),
    ];
    const bodies: ModelBody[] = [];
    const counted = { prompt: 0, completion: 0 };
    let turn = 0;
    // Reported like a real provider: about four characters a token.
    const usage = (raw: string, completion: number) => {
      const prompt = Math.ceil(raw.length / 4);
      counted.prompt += prompt;
      counted.completion += completion;
      return {
        choices: [],
        usage: { prompt_tokens: prompt, completion_tokens: completion },
      };
    };
    const fetch = async (_url: string, init?: unknown) => {
      const raw = (init as { body?: string } | undefined)?.body;
      if (!raw) return new Response("{}", { status: 404 });
      const body = JSON.parse(raw) as ModelBody;
      bodies.push(body);
      // The summariser is the one call offered no tools.
      if (!body.tools?.length) {
        return sse(text("Earlier: uptime was fine."), usage(raw, 30));
      }
      const next = turns[turn++] ?? submit();
      return sse(toolCall(...next), usage(raw, 50));
    };
    const ssh = fakeSshClient(() => ({ stdout: `${"load ".repeat(1500)}\n` }));
    const { server } = await start({ fetch }, { ssh });
    const patched = await server.request("PATCH", "/providers/1", {
      body: { modelOverrides: { "gpt-5": { contextWindow: 4096 } } },
    });
    expect(patched.status).toBe(200);

    const result = await runTask(server, taskInput());
    expect(result.status).toBe("reported");
    const summaries = bodies.filter((body) => !body.tools?.length).length;
    expect(summaries).toBeGreaterThan(0);
    const [row] = taskRows(server);
    expect(row.prompt_tokens).toBe(counted.prompt);
    expect(row.completion_tokens).toBe(counted.completion);
    const recorded = server.db.sqlite
      .prepare(
        "SELECT SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion FROM p_ai_usage WHERE conversation_id = ?",
      )
      .get(row.conversation_id) as { prompt: number; completion: number };
    expect(recorded).toEqual({
      prompt: row.prompt_tokens,
      completion: row.completion_tokens,
    });

    const listed = await server.request("GET", "/tasks");
    expect(listed.body.tasks[0]).toMatchObject({
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      totalTokens: Number(row.prompt_tokens) + Number(row.completion_tokens),
    });
  });

  it("keeps the tokens of a run that was cut off", async () => {
    const { server } = await start(hangingModel());
    await runTask(server, taskInput({ deadlineAt: Date.now() + 300 }));
    const [row] = taskRows(server);
    expect(row.status).toBe("failed");
    expect(Number(row.prompt_tokens)).toBeGreaterThan(0);
  });

  it("refuses commands that are not read-only, whatever the model asks", async () => {
    const model = scriptedModel(
      ["run_command", { command: "rm -rf /var/log" }],
      ["run_command", { command: "journalctl --vacuum-time=1d" }],
      submit(),
    );
    const { server, ssh } = await start(model);
    await runTask(server, taskInput());

    expect(ssh.channels).toHaveLength(0);
    const refusals = model.bodies[2].messages.filter(
      (message) => message.role === "tool",
    );
    expect(refusals.map((message) => message.content).join()).toMatch(
      /Refused.*Refused/s,
    );
  });

  it("writes the report in the owner's language", async () => {
    const model = scriptedModel(submit());
    const { server } = await start(model);
    await server.request("PUT", "/tasks/preferences", {
      body: { language: "zh_CN" },
    });
    await runTask(server, taskInput());
    expect(model.bodies[0].messages[0].content).toContain("Simplified Chinese");
    expect(server.mock.notifications.at(-1)?.notification.title).toBe(
      "AI 报告：Disk check",
    );
  });

  it("proposes a plan at L1 and leaves it waiting for approval", async () => {
    const plan = {
      summary: "Clean caches",
      hosts: [
        {
          hostId: 1,
          commands: ["apt-get clean", "journalctl --vacuum-time=7d"],
          rationale: "Caches use 4G",
          risk: "Low",
          rollback: "None needed",
          verify: ["df -hP /"],
        },
      ],
    };
    const model = scriptedModel(["propose_plan", plan], submit("warning"));
    const { server, ssh } = await start(model);

    const result = await runTask(server, taskInput({ autonomy: "propose" }));
    expect(result.status).toBe("proposed");
    expect(toolNames(model.bodies[0])).toContain("propose_plan");
    // Proposing runs nothing.
    expect(ssh.channels).toHaveLength(0);
    const [row] = taskRows(server);
    expect(row.status).toBe("proposed");
    expect(JSON.parse(String(row.plan))[0]).toMatchObject({
      hostId: 1,
      commands: ["apt-get clean", "journalctl --vacuum-time=7d"],
      verify: ["df -hP /"],
    });
    const expires = Date.parse(String(row.expires_at)) - Date.now();
    expect(expires).toBeGreaterThan(23 * 3600_000);
    expect(server.mock.notifications.at(-1)?.notification).toMatchObject({
      category: "ai.task_proposed",
      title: "AI plan awaiting approval: Disk check",
    });
  });

  it("forces a dry run to report, without propose_plan or notifications", async () => {
    const model = scriptedModel(submit());
    const { server } = await start(model);
    const result = await runTask(
      server,
      taskInput({ autonomy: "propose", dryRun: true }),
    );
    expect(result.status).toBe("reported");
    expect(toolNames(model.bodies[0])).not.toContain("propose_plan");
    expect(server.mock.notifications).toHaveLength(0);
  });

  it("refuses without ai.ops.use and needs an actor", async () => {
    const { server } = await start(scriptedModel(), {
      permissions: ["ai.use", "ai.manage_providers"],
    });
    const result = await runTask(server, taskInput());
    expect(result).toMatchObject({ status: "failed", taskRunId: null });
    expect(result.summary).toMatch(/ai\.ops\.use/);
    const service = server.mock.services.get("ai.tasks") as {
      run: (input: unknown) => Promise<unknown>;
    };
    server.mock.setActor(undefined);
    await expect(service.run(taskInput())).rejects.toThrow(/actor/);
  });

  it("fails clearly when the owner has no provider", async () => {
    server = await startServer({ permissions: OPS_PERMISSIONS });
    await server.enableFor("user-1");
    const result = await runTask(server, taskInput());
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/no AI provider/);
    expect(taskRows(server)[0].status).toBe("failed");
  });

  it("drops hosts the owner cannot reach and fails when none are left", async () => {
    const model = scriptedModel(submit());
    const { server } = await start(model);
    const result = await runTask(server, taskInput({ hostIds: [99] }));
    expect(result.status).toBe("failed");
    expect(model.bodies).toHaveLength(0);
  });
});

describe("ai.tasks guardrails", () => {
  it("skips while auto-ops is paused", async () => {
    const model = scriptedModel(submit());
    const { server } = await start(model);
    await server.mock.ctx.settings.set("autoOpsPaused", true);
    const result = await runTask(server, taskInput());
    expect(result.status).toBe("skipped");
    expect(result.summary).toMatch(/paused/);
    expect(model.bodies).toHaveLength(0);
    expect(taskRows(server)[0].status).toBe("skipped");
  });

  it("skips while a task for the same automation and host is open", async () => {
    const model = scriptedModel(submit());
    const { server } = await start(model);
    insertTask(server, { status: "proposed" });
    const result = await runTask(server, taskInput());
    expect(result.status).toBe("skipped");
    expect(result.summary).toMatch(/still running or waiting/);

    // Another host of the same automation is not a duplicate.
    const other = await runTask(
      server,
      taskInput({
        hostIds: [2],
        trigger: { kind: "metric_threshold", hostId: 2, summary: "", vars: {} },
      }),
    );
    expect(other.status).toBe("reported");
  });

  it("skips a second trigger that arrives while the first is still running", async () => {
    const model = hangingModel();
    const { server } = await start(model);
    const first = runTask(server, taskInput({ deadlineAt: Date.now() + 2000 }));
    await eventually(() => model.calls() > 0);
    const second = await runTask(server, taskInput());
    expect(second.status).toBe("skipped");
    await server.mock.ctx.settings.set("autoOpsPaused", true);
    await first;
  });

  it("limits each automation's runs per hour", async () => {
    const model = scriptedModel(submit(), submit());
    const { server } = await start(model);
    await server.mock.ctx.settings.set("autoOpsRunsPerHour", 1);
    insertTask(server, { status: "reported", host_ids: "[2]" });
    const result = await runTask(server, taskInput());
    expect(result.status).toBe("skipped");
    expect(result.summary).toMatch(/1 AI tasks in the last hour/);
  });

  it("skips once the owner's daily budget is used up", async () => {
    const model = scriptedModel(submit());
    const { server } = await start(model);
    await server.mock.ctx.settings.set("autoOpsDailyTokens", 1000);
    server.db.sqlite
      .prepare(
        "INSERT INTO p_ai_usage (user_id, model, source, prompt_tokens, completion_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("user-1", "gpt-5", "assistant", 900, 200, new Date().toISOString());
    const result = await runTask(server, taskInput());
    expect(result.status).toBe("skipped");
    expect(result.summary).toMatch(/daily budget/);
  });

  it("stops a run that goes over its token budget and still reports", async () => {
    const model = scriptedModel(
      ["run_command", { command: "uptime" }],
      ["run_command", { command: "uptime" }],
      submit(),
    );
    const { server } = await start(model);
    await server.mock.ctx.settings.set("autoOpsRunTokens", 50);
    const result = await runTask(server, taskInput());
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/budget of 50 tokens/);
    expect(model.bodies).toHaveLength(1);
    expect(String(taskRows(server)[0].report)).toContain("## Verdict");
  });

  it("stops at the deadline", async () => {
    const { server } = await start(hangingModel());
    const result = await runTask(
      server,
      taskInput({ deadlineAt: Date.now() + 300 }),
    );
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/time limit/);
  });

  it("stops when the caller aborts", async () => {
    const { server } = await start(hangingModel());
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runTask(
      server,
      taskInput({ signal: controller.signal }),
    );
    expect(result.summary).toMatch(/cancelled/);
  });

  it("the kill switch stops a running task", async () => {
    const model = hangingModel();
    const { server } = await start(model);
    const pending = runTask(server, taskInput());
    await eventually(() => model.calls() > 0);
    await server.mock.ctx.settings.set("autoOpsPaused", true);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/paused AI auto-ops/);
  });

  it("marks runs a restart cut off as failed", async () => {
    const { server } = await start(scriptedModel());
    insertTask(server, { status: "running" });
    insertTask(server, { status: "proposed" });
    const { createTaskRepository } =
      await import("../../../src/backend/tasks/repository.js");
    const tasks = await createTaskRepository(server.mock.ctx);
    expect(await tasks.failInterrupted()).toBe(1);
    expect(taskRows(server).map((row) => row.status)).toEqual([
      "failed",
      "proposed",
    ]);
  });
});
