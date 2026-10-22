import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "./helpers";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("ai routes", () => {
  it("reports status without the gate, and blocks everything else while off", async () => {
    server = await startServer();

    const status = await server.request("GET", "/status");
    expect(status.status).toBe(200);
    expect(status.body).toEqual({
      globallyEnabled: false,
      enabled: false,
      allowReadOnlyCommands: false,
    });

    expect((await server.request("GET", "/providers")).status).toBe(403);
  });

  it("lets a user opt in only while the server allows it", async () => {
    server = await startServer();

    const refused = await server.request("PUT", "/opt-in", {
      body: { enabled: true },
    });
    expect(refused.status).toBe(403);

    await server.mock.ctx.settings.set("globallyEnabled", true);
    const accepted = await server.request("PUT", "/opt-in", {
      body: { enabled: true },
    });
    expect(accepted.status).toBe(200);
    expect(await server.mock.ctx.settings.getUser("user-1", "enabled")).toBe(
      true,
    );
  });

  it("keeps a provider's key in ctx.secrets, never in the row or the response", async () => {
    server = await startServer();
    await server.enableFor("user-1");

    const created = await server.request("POST", "/providers", {
      body: {
        providerType: "openai",
        label: "Work",
        apiKey: "sk-secret-value",
        defaultModel: "gpt-5",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.provider.apiKeyPrefix).toBe("sk-sec");
    expect(JSON.stringify(created.body)).not.toContain("sk-secret-value");

    const id = created.body.provider.id;
    expect(server.mock.secretStore.get(`user-1:provider:${id}`)).toBe(
      "sk-secret-value",
    );
    const row = server.db.sqlite
      .prepare("SELECT * FROM p_ai_providers WHERE id = ?")
      .get(id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain("sk-secret-value");

    const list = await server.request("GET", "/providers");
    expect(list.body.providers).toHaveLength(1);

    // Another user sees none of it.
    await server.enableFor("user-2");
    const other = await server.request("GET", "/providers", { user: "user-2" });
    expect(other.body.providers).toEqual([]);

    const removed = await server.request("DELETE", `/providers/${id}`);
    expect(removed.status).toBe(200);
    expect(server.mock.secretStore.has(`user-1:provider:${id}`)).toBe(false);
  });

  it("validates a new provider", async () => {
    server = await startServer();
    await server.enableFor("user-1");

    const unknown = await server.request("POST", "/providers", {
      body: { providerType: "nope", label: "x" },
    });
    expect(unknown.status).toBe(400);

    const noKey = await server.request("POST", "/providers", {
      body: { providerType: "anthropic", label: "x" },
    });
    expect(noKey.status).toBe(400);
  });

  it("rejects and applies proposals only once, for their owner", async () => {
    server = await startServer();
    await server.enableFor("user-1");

    server.db.sqlite
      .prepare(
        "INSERT INTO p_ai_conversations (id, user_id, title) VALUES (1, 'user-1', 't')",
      )
      .run();
    server.db.sqlite
      .prepare(
        `INSERT INTO p_ai_proposals (id, conversation_id, user_id, kind, payload)
         VALUES (1, 1, 'user-1', 'propose_create_host', '{"name":"db","ip":"10.0.0.2"}'),
                (2, 1, 'user-1', 'propose_delete_host', '{"hostId":1}')`,
      )
      .run();

    // Not theirs.
    await server.enableFor("user-2");
    expect(
      (await server.request("POST", "/proposals/1/reject", { user: "user-2" }))
        .status,
    ).toBe(404);

    const rejected = await server.request("POST", "/proposals/2/reject");
    expect(rejected.status).toBe(200);
    expect((await server.request("POST", "/proposals/2/reject")).status).toBe(
      404,
    );

    const conversation = await server.request("GET", "/conversations/1");
    expect(conversation.status).toBe(200);
    expect(
      conversation.body.proposals.map((p: { id: number }) => p.id),
    ).toEqual([2, 1]);

    const deleted = await server.request("DELETE", "/conversations/1");
    expect(deleted.status).toBe(200);
    const left = server.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM p_ai_proposals")
      .get() as { n: number };
    expect(left.n).toBe(0);
  });

  it.each([
    ["GET", "/providers", "ai.use"],
    ["POST", "/providers", "ai.manage_providers"],
    ["PATCH", "/providers/1", "ai.manage_providers"],
    ["DELETE", "/providers/1", "ai.manage_providers"],
    ["POST", "/probe-models", "ai.manage_providers"],
    ["GET", "/providers/1/models", "ai.use"],
    ["GET", "/conversations", "ai.use"],
    ["GET", "/conversations/1", "ai.use"],
    ["DELETE", "/conversations/1", "ai.use"],
    ["POST", "/chat/stream", "ai.use"],
    ["POST", "/proposals/1/apply", "ai.apply_proposals"],
    ["POST", "/proposals/1/mark-run-in-terminal", "ai.apply_proposals"],
    ["POST", "/proposals/1/reject", "ai.use"],
    ["PUT", "/opt-in", "ai.use"],
  ])("%s %s answers 403 without %s", async (method, path, permission) => {
    server = await startServer({
      permissions: [
        "ai.use",
        "ai.manage_providers",
        "ai.apply_proposals",
      ].filter((entry) => entry !== permission),
    });
    await server.enableFor("user-1");
    const response = await server.request(method, path, { body: {} });
    expect(response.status).toBe(403);
  });
});

describe("per-provider advanced settings", () => {
  const provider = {
    providerType: "openai",
    label: "Work",
    apiKey: "sk-test",
  };

  it("returns persisted settings, replaces them on PATCH, and clears them", async () => {
    server = await startServer();
    await server.enableFor("user-1");

    const advanced = {
      endpoint: "responses",
      reasoningEffort: "high",
      reasoningSummary: "detailed",
      verbosity: "low",
      maxOutputTokens: 8192,
      temperature: 0.5,
    };
    const created = await server.request("POST", "/providers", {
      body: { ...provider, advanced },
    });
    expect(created.status).toBe(201);
    expect(created.body.provider.advanced).toEqual(advanced);
    const id = created.body.provider.id;

    const list = await server.request("GET", "/providers");
    expect(list.status).toBe(200);
    expect(list.body.providers[0].advanced).toEqual(advanced);

    const replacement = { endpoint: "chat", temperature: 0 };
    const patched = await server.request("PATCH", `/providers/${id}`, {
      body: { advanced: replacement },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.provider.advanced).toEqual(replacement);

    const unchanged = await server.request("PATCH", `/providers/${id}`, {
      body: { label: "Renamed" },
    });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body.provider.advanced).toEqual(replacement);

    for (const advanced of [null, {}]) {
      const cleared = await server.request("PATCH", `/providers/${id}`, {
        body: { advanced },
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.provider.advanced).toEqual({});
      const row = server.db.sqlite
        .prepare("SELECT advanced FROM p_ai_providers WHERE id = ?")
        .get(id) as { advanced: string | null };
      expect(row.advanced).toBeNull();
      if (advanced === null) {
        await server.request("PATCH", `/providers/${id}`, {
          body: { advanced: replacement },
        });
      }
    }
    const clearedList = await server.request("GET", "/providers");
    expect(clearedList.body.providers[0].advanced).toEqual({});
  });

  it("defaults omitted, null and empty settings to an empty object", async () => {
    server = await startServer();
    await server.enableFor("user-1");

    for (const [index, advanced] of [undefined, null, {}].entries()) {
      const created = await server.request("POST", "/providers", {
        body: { ...provider, label: `Work ${index}`, advanced },
      });
      expect(created.status).toBe(201);
      expect(created.body.provider.advanced).toEqual({});
      const row = server.db.sqlite
        .prepare("SELECT advanced FROM p_ai_providers WHERE id = ?")
        .get(created.body.provider.id) as { advanced: string | null };
      expect(row.advanced).toBeNull();
    }
  });

  it.each(["POST", "PATCH"])(
    "%s omits null and empty fields while keeping explicit defaults and zero",
    async (method) => {
      server = await startServer();
      await server.enableFor("user-1");
      let path = "/providers";
      if (method === "PATCH") {
        const created = await server.request("POST", path, {
          body: { ...provider, advanced: { reasoningEffort: "high" } },
        });
        path += `/${created.body.provider.id}`;
      }

      for (const empty of [null, ""]) {
        const response = await server.request(method, path, {
          body: {
            ...provider,
            label: `Work ${empty === null ? "null" : "empty"}`,
            advanced: {
              endpoint: empty,
              reasoningEffort: empty,
              reasoningSummary: empty,
              verbosity: empty,
              maxOutputTokens: empty,
              temperature: empty,
            },
          },
        });
        expect(response.status).toBe(method === "POST" ? 201 : 200);
        expect(response.body.provider.advanced).toEqual({});
      }
      const response = await server.request(method, path, {
        body: {
          ...provider,
          advanced: { endpoint: "auto", temperature: 0 },
        },
      });
      expect(response.status).toBe(method === "POST" ? 201 : 200);
      expect(response.body.provider.advanced).toEqual({
        endpoint: "auto",
        temperature: 0,
      });
    },
  );

  it("accepts every enum value and numeric boundary", async () => {
    server = await startServer();
    await server.enableFor("user-1");
    const created = await server.request("POST", "/providers", {
      body: provider,
    });
    const path = `/providers/${created.body.provider.id}`;

    for (const [field, values] of Object.entries({
      endpoint: ["auto", "responses", "chat"],
      reasoningEffort: [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
      reasoningSummary: ["auto", "concise", "detailed", "off"],
      verbosity: ["low", "medium", "high"],
      maxOutputTokens: [1, 1000000],
      temperature: [0, 2],
    })) {
      for (const value of values) {
        const advanced = { [field]: value };
        const response = await server.request("PATCH", path, {
          body: { advanced },
        });
        expect(response.status, JSON.stringify(advanced)).toBe(200);
        expect(response.body.provider.advanced).toEqual(advanced);
      }
    }
  });

  it.each(["POST", "PATCH"])(
    "%s rejects invalid advanced settings and unknown keys",
    async (method) => {
      server = await startServer();
      await server.enableFor("user-1");
      let path = "/providers";
      if (method === "PATCH") {
        const created = await server.request("POST", path, {
          body: provider,
        });
        path += `/${created.body.provider.id}`;
      }

      for (const advanced of [
        "responses",
        "",
        1,
        true,
        [],
        ["responses"],
        { endpoint: "invalid" },
        { endpoint: 1 },
        { reasoningEffort: "invalid" },
        { reasoningEffort: false },
        { reasoningSummary: "invalid" },
        { reasoningSummary: [] },
        { verbosity: "invalid" },
        { verbosity: {} },
        { maxOutputTokens: 0 },
        { maxOutputTokens: -1 },
        { maxOutputTokens: 1000001 },
        { maxOutputTokens: 1.5 },
        { maxOutputTokens: "100" },
        { maxOutputTokens: true },
        { temperature: -0.1 },
        { temperature: 2.1 },
        { temperature: "1" },
        { temperature: false },
        { unknown: "value" },
        { endpoint: "auto", unknown: null },
      ]) {
        const response = await server.request(method, path, {
          body: { ...provider, advanced },
        });
        expect(response.status, JSON.stringify(advanced)).toBe(400);
      }
    },
  );

  it("reads malformed and non-object stored JSON as empty settings", async () => {
    server = await startServer();
    await server.enableFor("user-1");
    const created = await server.request("POST", "/providers", {
      body: provider,
    });
    const id = created.body.provider.id;

    for (const stored of ["{", "[]", '"responses"', "1", "null"]) {
      server.db.sqlite
        .prepare("UPDATE p_ai_providers SET advanced = ? WHERE id = ?")
        .run(stored, id);
      const list = await server.request("GET", "/providers");
      expect(list.status).toBe(200);
      expect(list.body.providers[0].advanced).toEqual({});
    }
  });
});

describe("chat stream", () => {
  it("offers the model only the tools whose plugins are running", async () => {
    const bodies: Array<{ tools?: Array<{ function?: { name: string } }> }> =
      [];
    const encoder = new TextEncoder();
    server = await startServer({
      services: { "snippets.access": { list: async () => [] } },
      fetch: async (_url, init) => {
        bodies.push(JSON.parse((init as { body: string }).body));
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    await server.enableFor("user-1");

    const created = await server.request("POST", "/providers", {
      body: {
        providerType: "openai",
        // The mock speaks Chat Completions; official OpenAI uses the Responses API.
        baseUrl: "https://llm.example/v1",
        label: "Work",
        apiKey: "sk-test",
        defaultModel: "gpt-5",
      },
    });

    const reply = await server.request("POST", "/chat/stream", {
      body: { providerId: created.body.provider.id, message: "hello" },
    });
    expect(reply.status).toBe(200);
    expect(String(reply.body)).toContain('"type":"done"');

    const offered = (bodies[0].tools ?? []).map((tool) => tool.function?.name);
    expect(offered).toContain("list_hosts");
    expect(offered).toContain("list_snippets");
    expect(offered).not.toContain("list_fleets");
    expect(offered).not.toContain("list_homepage_items");
    expect(offered).not.toContain("propose_create_automation");
  });
});
