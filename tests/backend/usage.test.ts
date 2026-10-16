import { afterEach, describe, expect, it } from "vitest";
import { summarizeUsage } from "../../src/backend/usage.js";
import type { UsageRow } from "../../src/backend/repository.js";
import { ALL_PERMISSIONS, startServer, type TestServer } from "./helpers";

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

const text = (content: string) => ({ choices: [{ delta: { content } }] });
const usage = (prompt: number, completion: number) => ({
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion },
});

interface ModelBody {
  messages: Array<{ role: string; content: string }>;
  stream_options?: unknown;
}

/** The endpoint's model list, as vLLM serves it. */
const MODELS = { data: [{ id: "glm-5.3-flash", max_model_len: 524288 }] };

/** A model that answers each call with the next reply, recording requests. */
function model(...replies: Response[]) {
  const bodies: ModelBody[] = [];
  const fetch = async (_url: string, init?: unknown) => {
    const body = (init as { body?: string }).body;
    if (!body) return new Response(JSON.stringify(MODELS), { status: 200 });
    bodies.push(JSON.parse(body));
    return replies[bodies.length - 1] ?? sse(text("ok"));
  };
  return { fetch, bodies };
}

async function addProvider(target: TestServer): Promise<number> {
  const created = await target.request("POST", "/providers", {
    body: {
      providerType: "openai_compatible",
      label: "GLM",
      baseUrl: "https://glm.example/v1",
      apiKey: "sk-test",
      defaultModel: "glm-5.3-flash",
      modelOverrides: { "glm-5.3-flash": { contextWindow: 128000 } },
    },
  });
  return created.body.provider.id;
}

const usageRows = (target: TestServer) =>
  target.db.sqlite
    .prepare("SELECT * FROM p_ai_usage ORDER BY id")
    .all() as Array<Record<string, unknown>>;

describe("usage recording", () => {
  it("counts every assistant call, as reported or estimated", async () => {
    const fake = model(
      sse(text("Hello."), usage(1200, 30)),
      sse(text("No usage from this one.")),
    );
    server = await startServer({ fetch: fake.fetch });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);

    const first = await server.request("POST", "/ops/chat", {
      body: { providerId, message: "hi" },
    });
    expect(String(first.body)).toContain('"type":"usage"');
    const conversationId = Number(
      String(first.body).match(/"conversationId":(\d+)/)?.[1],
    );
    await server.request("POST", "/ops/chat", {
      body: { providerId, conversationId, message: "again" },
    });

    expect(fake.bodies[0].stream_options).toEqual({ include_usage: true });
    const rows = usageRows(server);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      user_id: "user-1",
      provider_id: providerId,
      model: "glm-5.3-flash",
      conversation_id: conversationId,
      source: "assistant",
      prompt_tokens: 1200,
      completion_tokens: 30,
      estimated: 0,
    });
    expect(rows[1]).toMatchObject({ source: "assistant", estimated: 1 });
    expect(Number(rows[1].prompt_tokens)).toBeGreaterThan(0);

    const listed = await server.request("GET", "/ops/conversations");
    expect(listed.body.conversations[0]).toMatchObject({
      id: conversationId,
      targets: [],
      totalTokens:
        1230 +
        Number(rows[1].prompt_tokens) +
        Number(rows[1].completion_tokens),
    });
    const loaded = await server.request(
      "GET",
      `/ops/conversations/${conversationId}`,
    );
    expect(loaded.body.conversation.context).toEqual({
      promptTokens: Number(rows[1].prompt_tokens),
      estimated: true,
      contextWindow: 128000,
      contextSource: "override",
      reservedOutput: 8192,
    });
  });

  it("counts the terminal panel's calls as terminal", async () => {
    const fake = model(sse(text("Disk is fine."), usage(500, 20)));
    server = await startServer({ fetch: fake.fetch });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);

    await server.request("POST", "/chat/stream", {
      body: { providerId, message: "disk?" },
    });

    expect(usageRows(server)).toEqual([
      expect.objectContaining({ source: "terminal", prompt_tokens: 500 }),
    ]);
  });

  it("asks again without stream_options when the server refuses it", async () => {
    const fake = model(
      new Response(
        JSON.stringify({ error: { message: "Unknown field stream_options" } }),
        { status: 400 },
      ),
      sse(text("Fine.")),
    );
    server = await startServer({ fetch: fake.fetch });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);

    const reply = await server.request("POST", "/ops/chat", {
      body: { providerId, message: "hi" },
    });

    expect(String(reply.body)).toContain("Fine.");
    expect(fake.bodies).toHaveLength(2);
    expect(fake.bodies[1]).not.toHaveProperty("stream_options");
    expect(usageRows(server)[0]).toMatchObject({ estimated: 1 });
  });
});

describe("compaction on request", () => {
  it("stores a summary that a reload and the next message use", async () => {
    const fake = model(
      sse(text("Step one done.")),
      sse(text("Step two done.")),
      sse(text("Step three done.")),
      sse(text("- The user is restoring web-1."), usage(900, 40)),
      sse(text("Carrying on.")),
    );
    server = await startServer({ fetch: fake.fetch });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);
    let conversationId: number | undefined;
    for (const message of ["one", "two", "three"]) {
      const reply = await server.request("POST", "/ops/chat", {
        body: { providerId, conversationId, message },
      });
      conversationId ??= Number(
        String(reply.body).match(/"conversationId":(\d+)/)?.[1],
      );
    }

    const compacted = await server.request(
      "POST",
      `/ops/conversations/${conversationId}/compact`,
      { body: { providerId } },
    );
    expect(compacted.status).toBe(200);
    expect(compacted.body).toMatchObject({
      compacted: true,
      context: { estimated: true, contextWindow: 128000 },
    });
    expect(usageRows(server).at(-1)).toMatchObject({
      source: "compaction",
      prompt_tokens: 900,
    });

    const loaded = await server.request(
      "GET",
      `/ops/conversations/${conversationId}`,
    );
    expect(loaded.body.messages.at(-1)).toMatchObject({
      role: "summary",
      content: "- The user is restoring web-1.",
    });

    await server.request("POST", "/ops/chat", {
      body: { providerId, conversationId, message: "four" },
    });
    const sent = fake.bodies.at(-1)!.messages;
    expect(sent[1].content).toContain("The user is restoring web-1.");
    // The latest steps went in verbatim, the earliest only as the summary.
    expect(sent.map((message) => message.content)).not.toContain("one");
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "four" });
  });

  it("says when there is nothing to compact", async () => {
    const fake = model(sse(text("Hi.")));
    server = await startServer({ fetch: fake.fetch });
    await server.enableFor("user-1");
    const providerId = await addProvider(server);
    const reply = await server.request("POST", "/ops/chat", {
      body: { providerId, message: "hi" },
    });
    const id = Number(String(reply.body).match(/"conversationId":(\d+)/)?.[1]);

    const compacted = await server.request(
      "POST",
      `/ops/conversations/${id}/compact`,
      { body: { providerId } },
    );

    expect(compacted.body).toEqual({ compacted: false });
    expect(fake.bodies).toHaveLength(1);
  });
});

describe("usage summary route", () => {
  const seed = (target: TestServer) => {
    const insert = target.db.sqlite.prepare(
      "INSERT INTO p_ai_usage (user_id, provider_id, model, conversation_id, source, prompt_tokens, completion_tokens, estimated, created_at) VALUES (?, 1, ?, NULL, ?, ?, ?, ?, ?)",
    );
    const now = new Date().toISOString();
    insert.run("user-1", "glm-5.3-flash", "assistant", 100, 10, 0, now);
    insert.run("user-1", "gpt-5", "compaction", 50, 5, 1, now);
    insert.run("user-2", "gpt-5", "terminal", 1000, 100, 0, now);
  };

  it("shows a user their own usage", async () => {
    server = await startServer();
    await server.enableFor("user-1");
    seed(server);

    const mine = await server.request("GET", "/usage");

    expect(mine.status).toBe(200);
    expect(mine.body.scope).toBe("me");
    expect(mine.body.today).toMatchObject({
      totalTokens: 165,
      calls: 2,
      estimated: true,
    });
    expect(
      mine.body.byModel.map((row: { model: string }) => row.model),
    ).toEqual(["glm-5.3-flash", "gpt-5"]);
    expect(mine.body).not.toHaveProperty("byUser");
  });

  it("needs ai.usage.view_all for everyone's", async () => {
    server = await startServer();
    await server.enableFor("user-1");
    seed(server);

    expect((await server.request("GET", "/usage?scope=all")).status).toBe(403);
  });

  it("gives an admin everyone's, per user", async () => {
    server = await startServer({
      permissions: [...ALL_PERMISSIONS, "ai.usage.view_all"],
    });
    await server.enableFor("user-1");
    seed(server);

    const all = await server.request("GET", "/usage?scope=all");

    expect(all.status).toBe(200);
    expect(all.body.month.totalTokens).toBe(1265);
    expect(all.body.byUser).toEqual([
      expect.objectContaining({ userId: "user-2", totalTokens: 1100 }),
      expect.objectContaining({ userId: "user-1", totalTokens: 165 }),
    ]);
  });

  it("needs the assistant to be on", async () => {
    server = await startServer();
    expect((await server.request("GET", "/usage")).status).toBe(403);
  });
});

describe("summarizeUsage", () => {
  const row = (createdAt: string, tokens: number): UsageRow => ({
    userId: "u",
    model: "m",
    source: "assistant",
    promptTokens: tokens,
    completionTokens: 0,
    estimated: false,
    createdAt,
  });

  it("buckets by the viewer's own day and drops what is too old", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const summary = summarizeUsage(
      [
        // 01:00 on the 17th in UTC+8, still the 16th in UTC.
        row("2026-10-16T17:00:00Z", 5),
        row("2026-10-16T01:00:00Z", 7),
        row("2026-10-10T01:00:00Z", 11),
        row("2026-08-01T01:00:00Z", 13),
      ],
      { now, offsetMinutes: -480, byUser: false },
    );

    expect(summary.byDay).toHaveLength(30);
    expect(summary.byDay.at(-1)).toMatchObject({ day: "2026-10-16" });
    // 17:00Z is tomorrow in UTC+8, past the last day, so it is not counted.
    expect(summary.today.totalTokens).toBe(7);
    expect(summary.week.totalTokens).toBe(18);
    expect(summary.month.totalTokens).toBe(18);
  });
});
