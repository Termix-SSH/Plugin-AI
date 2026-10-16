import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDb } from "@termix-ssh/plugin-sdk/testing";
import { findUnownedTableWrites } from "@termix-ssh/plugin-sdk/ddl";
import { pluginDir, startServer, type TestServer } from "./helpers";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

/** A vLLM endpoint: a model list with max_model_len, and a short reply. */
function vllm() {
  const listed: string[] = [];
  const fetch = async (url: string, init?: unknown) => {
    if (!(init as { body?: string }).body) {
      listed.push(url);
      return new Response(
        JSON.stringify({
          data: [
            { id: "glm-5.3-flash", max_model_len: 524288 },
            { id: "glm-small", max_model_len: 32768 },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    );
  };
  return { fetch, listed };
}

async function addProvider(target: TestServer, body: object = {}) {
  return target.request("POST", "/providers", {
    body: {
      providerType: "openai_compatible",
      label: "GLM",
      baseUrl: "https://glm.example/v1",
      apiKey: "sk-test",
      defaultModel: "glm-5.3-flash",
      ...body,
    },
  });
}

describe("per-model overrides", () => {
  it("stores, replaces and clears overrides per model", async () => {
    server = await startServer({ fetch: vllm().fetch });
    await server.enableFor("user-1");

    const created = await addProvider(server, {
      modelOverrides: { "glm-5.3-flash": { contextWindow: 200000 } },
    });
    expect(created.status).toBe(201);
    expect(created.body.provider.modelOverrides).toEqual({
      "glm-5.3-flash": { contextWindow: 200000 },
    });
    expect(created.body.provider).not.toHaveProperty("contextWindow");
    const id = created.body.provider.id;

    const patched = await server.request("PATCH", `/providers/${id}`, {
      body: {
        modelOverrides: {
          "glm-5.3-flash": { contextWindow: null },
          "glm-small": { contextWindow: 16384 },
        },
      },
    });
    expect(patched.body.provider.modelOverrides).toEqual({
      "glm-small": { contextWindow: 16384 },
    });
    const row = server.db.sqlite
      .prepare("SELECT model_overrides FROM p_ai_providers WHERE id = ?")
      .get(id) as { model_overrides: string };
    expect(JSON.parse(row.model_overrides)).toEqual({
      "glm-small": { contextWindow: 16384 },
    });

    const cleared = await server.request("PATCH", `/providers/${id}`, {
      body: { modelOverrides: null },
    });
    expect(cleared.body.provider.modelOverrides).toEqual({});

    for (const modelOverrides of [
      { m: { contextWindow: 10 } },
      { m: { contextWindow: "lots" } },
      ["m"],
    ]) {
      const bad = await server.request("PATCH", `/providers/${id}`, {
        body: { modelOverrides },
      });
      expect(bad.status).toBe(400);
    }
  });
});

describe("GET /providers/:id/context", () => {
  it("reports each model's window with its source, cached until refreshed", async () => {
    const endpoint = vllm();
    server = await startServer({ fetch: endpoint.fetch });
    await server.enableFor("user-1");
    const created = await addProvider(server, {
      modelOverrides: { "glm-small": { contextWindow: 65536 } },
    });
    const id = created.body.provider.id;

    const first = await server.request(
      "GET",
      `/providers/${id}/context?models=unlisted-model`,
    );
    expect(first.status).toBe(200);
    expect(first.body.models).toEqual([
      {
        model: "glm-5.3-flash",
        contextWindow: 524288,
        source: "provider",
        reservedOutput: 8192,
        reportedWindow: 524288,
        override: null,
      },
      {
        model: "unlisted-model",
        contextWindow: 128000,
        source: "default",
        reservedOutput: 8192,
        reportedWindow: null,
        override: null,
      },
      // Held to what the server was started with.
      {
        model: "glm-small",
        contextWindow: 32768,
        source: "override",
        reservedOutput: 8192,
        reportedWindow: 32768,
        override: 65536,
      },
    ]);
    const asked = endpoint.listed.length;
    expect(asked).toBe(3);

    await server.request("GET", `/providers/${id}/context`);
    expect(endpoint.listed.length).toBe(asked);

    await server.request("GET", `/providers/${id}/context?refresh=1`);
    expect(endpoint.listed.length).toBe(asked + 2);

    // Editing the provider forgets what it said, too.
    await server.request("PATCH", `/providers/${id}`, {
      body: { label: "GLM prod" },
    });
    await server.request("GET", `/providers/${id}/context`);
    expect(endpoint.listed.length).toBe(asked + 4);
  });

  it("sizes the assistant's run by the provider's window", async () => {
    server = await startServer({ fetch: vllm().fetch });
    await server.enableFor("user-1");
    const created = await addProvider(server);

    const reply = await server.request("POST", "/ops/chat", {
      body: { providerId: created.body.provider.id, message: "hi" },
    });
    const usage = String(reply.body)
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .find((frame) => frame.type === "usage");
    expect(usage).toMatchObject({
      contextWindow: 524288,
      contextSource: "provider",
      reservedOutput: 8192,
    });
  });
});

describe("0008 model_overrides migration", () => {
  it("moves a provider-level window onto the default model", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-migrations-"));
    const sqliteDir = path.join(dir, "migrations", "sqlite");
    fs.mkdirSync(sqliteDir, { recursive: true });
    fs.copyFileSync(
      path.join(pluginDir, "manifest.json"),
      path.join(dir, "manifest.json"),
    );
    const source = path.join(pluginDir, "migrations", "sqlite");
    const files = fs.readdirSync(source).sort();
    for (const file of files.filter((name) => name < "0008")) {
      fs.copyFileSync(path.join(source, file), path.join(sqliteDir, file));
    }

    const db = await createTestDb(dir);
    try {
      db.sqlite.exec(`
        INSERT INTO users (id, username) VALUES ('u1', 'u1');
        INSERT INTO p_ai_providers (id, user_id, provider_type, label, default_model, context_window)
          VALUES (1, 'u1', 'ollama', 'With window', 'qwen3:32b', 32768),
                 (2, 'u1', 'ollama', 'Without', 'llama3', NULL);
      `);
      for (const file of files.filter((name) => name >= "0008")) {
        fs.copyFileSync(path.join(source, file), path.join(sqliteDir, file));
      }
      await db.migrate();

      const rows = db.sqlite
        .prepare(
          "SELECT id, model_overrides, context_window FROM p_ai_providers ORDER BY id",
        )
        .all() as Array<Record<string, unknown>>;
      expect(JSON.parse(String(rows[0].model_overrides))).toEqual({
        "qwen3:32b": { contextWindow: 32768 },
      });
      expect(rows[0].context_window).toBeNull();
      expect(rows[1]).toMatchObject({
        model_overrides: null,
        context_window: null,
      });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes only the plugin's own table in every dialect", () => {
    for (const dialect of ["sqlite", "postgres", "mysql"]) {
      const sql = fs.readFileSync(
        path.join(pluginDir, "migrations", dialect, "0008_model_overrides.sql"),
        "utf8",
      );
      expect(sql).toContain("model_overrides");
      expect(findUnownedTableWrites("ai", sql)).toEqual([]);
    }
  });
});
