import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_PERMISSIONS, startServer, type TestServer } from "../helpers";
import { fakeSshClient } from "./fake-ssh";
import { spawnRun, writeFakeCli } from "./fake-cli";

const fakeCli = vi.hoisted(() => ({ path: "" }));
vi.mock("../../../src/backend/ops/cli.js", async (original) => ({
  ...(await original<object>()),
  bundledCliPath: () => fakeCli.path,
}));
fakeCli.path = writeFakeCli();

const OPS_PERMISSIONS = [...ALL_PERMISSIONS, "ai.ops.use"];

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const encoder = new TextEncoder();

function sse(...frames: unknown[]) {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${body.join("")}data: [DONE]\n\n`));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

const toolCall = (name: string, args: Record<string, unknown>) => ({
  choices: [
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: `call-${name}`,
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    },
  ],
});

const text = (content: string) => ({ choices: [{ delta: { content } }] });

interface ModelBody {
  messages: Array<{ role: string; content: string }>;
  tools?: Array<{ function: { name: string } }>;
}

/** A model that makes these calls in order, one per turn, then answers. */
function scriptedModel(...calls: Array<[string, Record<string, unknown>]>) {
  const bodies: ModelBody[] = [];
  const fetch = async (_url: string, init?: unknown) => {
    const body = JSON.parse((init as { body: string }).body);
    bodies.push(body);
    const next = calls[bodies.length - 1];
    return next ? sse(toolCall(...next)) : sse(text("Done."));
  };
  return { fetch, bodies };
}

const framesOf = (body: unknown) =>
  String(body)
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)));

async function addProvider(target: TestServer): Promise<number> {
  const created = await target.request("POST", "/providers", {
    body: {
      providerType: "openai",
      // The mock speaks Chat Completions; official OpenAI uses the Responses API.
      baseUrl: "https://llm.example/v1",
      label: "Work",
      apiKey: "sk-test",
      defaultModel: "gpt-5",
    },
  });
  return created.body.provider.id;
}

describe("assistant routes", () => {
  it("lets the model set targets, then run on them, and tells the browser", async () => {
    const model = scriptedModel(
      ["set_targets", { tags: ["prod"] }],
      ["run_command", { command: "uptime" }],
      ["open_tab", { type: "terminal", hostId: 1 }],
    );
    const ssh = fakeSshClient(() => ({ stdout: "up\n" }));
    server = await startServer({
      permissions: OPS_PERMISSIONS,
      fetch: model.fetch,
      sshClient: ssh.client,
    });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);

    // No targets to start with is fine now.
    const reply = await server.request("POST", "/ops/chat", {
      body: { providerId, message: "uptime on prod, then open it" },
    });
    expect(reply.status).toBe(200);
    const frames = framesOf(reply.body);
    expect(frames).toContainEqual({ type: "targets", hostIds: [1] });
    expect(frames).toContainEqual({
      type: "client_action",
      action: { kind: "open_tab", type: "terminal", hostId: 1 },
    });
    expect(
      frames.find((frame) => frame.type === "tool_progress"),
    ).toMatchObject({ host: { hostId: 1, exitCode: 0 } });

    const conversation = server.db.sqlite
      .prepare("SELECT * FROM p_ai_conversations")
      .get() as Record<string, unknown>;
    expect(conversation).toMatchObject({ mode: "ops", targets: "[1]" });

    // An empty list clears the targets; run_command then has nothing.
    await server.request("POST", "/ops/chat", {
      body: {
        providerId,
        conversationId: conversation.id,
        message: "again",
        hostIds: [],
      },
    });
    const cleared = server.db.sqlite
      .prepare("SELECT targets FROM p_ai_conversations")
      .get() as { targets: string };
    expect(cleared.targets).toBe("[]");
  });

  it("names the page and the targets in the system prompt", async () => {
    const model = scriptedModel();
    server = await startServer({
      permissions: OPS_PERMISSIONS,
      fetch: model.fetch,
    });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);

    await server.request("POST", "/ops/chat", {
      body: {
        providerId,
        message: "what is this?",
        hostIds: [1],
        page: {
          tabType: "terminal",
          tabTitle: "web-1",
          hostId: 1,
          hostName: "web-1",
          extra: "ignored",
        },
      },
    });
    const system = model.bodies[0].messages[0].content;
    expect(system).toContain("1 target host is selected");
    expect(system).toContain(
      'currently looking at the terminal tab "web-1" for host web-1 (id 1)',
    );
  });

  it("runs the bundled CLI as the caller and records the call", async () => {
    const model = scriptedModel([
      "termix",
      { args: ["hosts", "list", "--password", "pw"] },
    ]);
    server = await startServer({
      permissions: OPS_PERMISSIONS,
      fetch: model.fetch,
      process: { run: spawnRun },
    });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);

    const reply = await server.request("POST", "/ops/chat", {
      body: { providerId, message: "list my hosts" },
      headers: { authorization: "Bearer user-jwt" },
    });
    expect(model.bodies[0].tools?.map((tool) => tool.function.name)).toContain(
      "termix",
    );
    const result = framesOf(reply.body).find(
      (frame) => frame.type === "tool_result" && frame.name === "termix",
    );
    expect(result.result.exitCode).toBe(0);
    const seen = JSON.parse(result.result.output);
    expect(seen.env).toMatchObject({
      TERMIX_URL: "http://127.0.0.1:30001",
      TERMIX_TOKEN: "user-jwt",
    });
    expect(seen.argv.slice(1, 4)).toEqual([
      fakeCli.path,
      "--json",
      "--no-color",
    ]);

    const runs = server.db.sqlite
      .prepare("SELECT * FROM p_ai_cli_runs")
      .all() as Array<Record<string, unknown>>;
    expect(runs).toEqual([
      expect.objectContaining({
        user_id: "user-1",
        args: '["hosts","list","--password","[redacted]"]',
        exit_code: 0,
      }),
    ]);
    expect(server.mock.audits).toContainEqual(
      expect.objectContaining({ action: "ai_cli_command", success: true }),
    );
  });

  it("does not offer the CLI without a session token", async () => {
    const model = scriptedModel();
    server = await startServer({
      permissions: OPS_PERMISSIONS,
      fetch: model.fetch,
    });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);
    await server.request("POST", "/ops/chat", {
      body: { providerId, message: "hi" },
    });
    const names = model.bodies[0].tools?.map((tool) => tool.function.name);
    expect(names).toContain("set_targets");
    expect(names).not.toContain("termix");
    expect(model.bodies[0].messages[0].content).not.toContain("termix tool");
  });

  it("gives a user without ai.ops.use the assistant but no shell on hosts", async () => {
    const model = scriptedModel();
    server = await startServer({
      permissions: ALL_PERMISSIONS,
      fetch: model.fetch,
      process: { run: spawnRun },
    });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);

    const reply = await server.request("POST", "/ops/chat", {
      body: { providerId, message: "hi", hostIds: [] },
      headers: { authorization: "Bearer user-jwt" },
    });
    expect(reply.status).toBe(200);
    const names = model.bodies[0].tools?.map((tool) => tool.function.name);
    expect(names).toEqual(
      expect.arrayContaining(["termix", "open_tab", "open_settings"]),
    );
    for (const name of [
      "run_command",
      "get_host_facts",
      "list_targets",
      "set_targets",
    ]) {
      expect(names).not.toContain(name);
    }
    const system = model.bodies[0].messages[0].content;
    expect(system).not.toContain("run_command");
    expect(system).not.toContain("target host");
    expect(system).toContain("cannot run shell commands on hosts");
  });

  it("lists, loads and deletes the assistant's conversations only", async () => {
    const model = scriptedModel();
    server = await startServer({
      permissions: OPS_PERMISSIONS,
      fetch: model.fetch,
    });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);
    await server.request("POST", "/ops/chat", {
      body: { providerId, message: "first", hostIds: [1] },
    });
    await server.request("POST", "/chat/stream", {
      body: { providerId, message: "plain chat" },
    });

    const listed = await server.request("GET", "/ops/conversations");
    expect(listed.body.conversations).toEqual([
      expect.objectContaining({ title: "first" }),
    ]);
    const id = listed.body.conversations[0].id;

    const loaded = await server.request("GET", `/ops/conversations/${id}`);
    expect(loaded.body.conversation).toMatchObject({ id, targets: [1] });
    expect(
      loaded.body.messages.map((message: { role: string }) => message.role),
    ).toEqual(["user", "assistant"]);

    await server.enableFor("user-2");
    const chatId = id + 1;
    expect(
      (await server.request("GET", `/ops/conversations/${chatId}`)).status,
    ).toBe(404);
    expect(
      (
        await server.request("GET", `/ops/conversations/${id}`, {
          user: "user-2",
        })
      ).status,
    ).toBe(404);

    expect(
      (await server.request("DELETE", `/ops/conversations/${id}`)).status,
    ).toBe(200);
    expect(
      (await server.request("GET", "/ops/conversations")).body.conversations,
    ).toEqual([]);
  });
});
