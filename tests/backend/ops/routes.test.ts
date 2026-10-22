import { afterEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, startServer, type TestServer } from "../helpers";
import { fakeSshClient } from "./fake-ssh";
import { wrapCommand } from "../../../src/backend/ops/exec.js";

const OPS_PERMISSIONS = [...ALL_PERMISSIONS, "ai.ops.use"];

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const encoder = new TextEncoder();

/** An OpenAI compatible stream of the given frames. */
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
            id: "call-1",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    },
  ],
});

const text = (content: string) => ({ choices: [{ delta: { content } }] });

/** The model asks for `command` on every target, then answers. */
function scriptedModel(command: string) {
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> =
    [];
  const fetch = async (_url: string, init?: unknown) => {
    const body = JSON.parse((init as { body: string }).body);
    bodies.push(body);
    return bodies.length % 2 === 1
      ? sse(toolCall("run_command", { hostIds: "all", command }))
      : sse(text("All good."));
  };
  return { fetch, bodies };
}

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

describe("ops routes", () => {
  it.each([
    ["GET", "/ops/fleets"],
    ["GET", "/ops/conversations"],
    ["POST", "/ops/chat"],
  ])("%s %s answers 403 without ai.use", async (method, path) => {
    server = await startServer({ permissions: ["ai.ops.use"] });
    await server.enableFor("user-1");
    expect((await server.request(method, path, { body: {} })).status).toBe(403);
  });

  it("refuses targets from a user without ai.ops.use", async () => {
    server = await startServer({ permissions: ALL_PERMISSIONS });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);

    const reply = await server.request("POST", "/ops/chat", {
      body: { providerId, message: "uptime please", hostIds: [1] },
    });
    expect(reply.status).toBe(403);
    expect(reply.body.error).toContain("ai.ops.use");
  });

  it("answers 403 while the assistant is off, even with the permissions", async () => {
    server = await startServer({ permissions: OPS_PERMISSIONS });
    expect((await server.request("GET", "/ops/fleets")).status).toBe(403);
  });

  it("refuses host ids that are not ids", async () => {
    server = await startServer({ permissions: OPS_PERMISSIONS });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);

    const invalid = await server.request("POST", "/ops/chat", {
      body: { providerId, message: "uptime please", hostIds: ["web-1"] },
    });
    expect(invalid.status).toBe(400);
  });

  it("runs the model's command on the targets, streams each host and records the run", async () => {
    const model = scriptedModel("uptime");
    const ssh = fakeSshClient(() => ({ stdout: " 12:00 up 3 days\n" }));
    server = await startServer({
      permissions: OPS_PERMISSIONS,
      fetch: model.fetch,
      sshClient: ssh.client,
    });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);

    const reply = await server.request("POST", "/ops/chat", {
      body: { providerId, message: "how long are they up?", hostIds: [1] },
    });
    expect(reply.status).toBe(200);
    const frames = String(reply.body)
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)));

    const progress = frames.find((frame) => frame.type === "tool_progress");
    expect(progress).toMatchObject({
      name: "run_command",
      command: "uptime",
      host: { hostId: 1, name: "web-1", exitCode: 0 },
    });
    expect(frames.at(-1).type).toBe("done");
    expect(ssh.channels.map((channel) => channel.command)).toEqual([
      wrapCommand("uptime"),
    ]);

    // The model got the per-host summary back.
    const toolMessage = model.bodies[1].messages.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toContain("up 3 days");

    const runs = server.db.sqlite
      .prepare("SELECT * FROM p_ai_ops_runs")
      .all() as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      user_id: "user-1",
      host_id: 1,
      command: "uptime",
      exit_code: 0,
      output: " 12:00 up 3 days\n",
    });

    const conversation = server.db.sqlite
      .prepare("SELECT * FROM p_ai_conversations")
      .get() as Record<string, unknown>;
    expect(conversation).toMatchObject({ mode: "ops", targets: "[1]" });

    // A follow-up without hostIds keeps the conversation's targets.
    const followUp = await server.request("POST", "/ops/chat", {
      body: {
        providerId,
        conversationId: conversation.id,
        message: "again",
      },
    });
    expect(followUp.status).toBe(200);
    expect(ssh.channels).toHaveLength(2);

    // The plain chat never continues an ops conversation.
    await server.request("POST", "/chat/stream", {
      body: { providerId, conversationId: conversation.id, message: "hi" },
    });
    const count = server.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM p_ai_conversations")
      .get() as { n: number };
    expect(count.n).toBe(2);
    const listed = await server.request("GET", "/conversations");
    expect(
      listed.body.conversations.map((entry: { mode: string }) => entry.mode),
    ).toEqual(["chat"]);

    // Deleting the conversation takes its runs with it.
    await server.request("DELETE", `/conversations/${conversation.id}`);
    const left = server.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM p_ai_ops_runs")
      .get() as { n: number };
    expect(left.n).toBe(0);
  });

  it("refuses to continue a conversation that is not an ops one", async () => {
    server = await startServer({ permissions: OPS_PERMISSIONS });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);
    server.db.sqlite
      .prepare(
        "INSERT INTO p_ai_conversations (id, user_id, title) VALUES (9, 'user-1', 'chat')",
      )
      .run();

    const reply = await server.request("POST", "/ops/chat", {
      body: { providerId, conversationId: 9, message: "x", hostIds: [1] },
    });
    expect(reply.status).toBe(404);
  });

  it("lists fleets with their members, or reports them unavailable", async () => {
    server = await startServer({ permissions: OPS_PERMISSIONS });
    await server.enableFor("user-1");
    expect((await server.request("GET", "/ops/fleets")).body).toEqual({
      available: false,
      fleets: [],
    });
    await server.close();

    server = await startServer({
      permissions: OPS_PERMISSIONS,
      services: {
        "fleets.access": {
          list: async () => [{ id: 3, name: "web", color: null }],
          members: async () => [{ id: 1, name: "web-1", ip: "10.0.0.1" }],
        },
      },
    });
    await server.enableFor("user-1");
    expect((await server.request("GET", "/ops/fleets")).body).toEqual({
      available: true,
      fleets: [{ id: 3, name: "web", hostIds: [1] }],
    });
  });
});
