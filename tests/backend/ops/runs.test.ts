import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_PERMISSIONS, startServer, type TestServer } from "../helpers";

const OPS_PERMISSIONS = [...ALL_PERMISSIONS, "ai.ops.use"];

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const encoder = new TextEncoder();
const frame = (event: unknown) =>
  encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
const text = (content: string) => ({ choices: [{ delta: { content } }] });

const abortedBy = (signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

/**
 * A model that answers "Hel" at once and "lo." only once released, so a test
 * can act while the run is in progress. Like a real provider it stops when
 * its request is aborted.
 */
function heldModel() {
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const signals: AbortSignal[] = [];
  const fetch = async (url: string, init?: unknown) => {
    // Model lookups find nothing; only the chat itself is held.
    if (!url.endsWith("/chat/completions")) {
      return new Response("{}", { status: 404 });
    }
    const signal = (init as { signal?: AbortSignal }).signal;
    if (signal) signals.push(signal);
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(frame(text("Hel")));
          await Promise.race([released, abortedBy(signal)]);
          if (signal?.aborted) {
            return controller.error(new DOMException("Aborted", "AbortError"));
          }
          controller.enqueue(frame(text("lo.")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { status: 200 },
    );
  };
  return { fetch, release, signals };
}

interface Stream {
  frames: Array<{ type: string; [key: string]: unknown }>;
  /** Resolves once a frame of this type has arrived. */
  until: (type: string) => Promise<void>;
  /** Resolves when the server ends the stream. */
  ended: Promise<void>;
  close: () => void;
}

/** Reads an event stream frame by frame, so a test can hang up part way. */
async function openStream(
  target: TestServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<Stream> {
  const abort = new AbortController();
  const response = await fetch(`${target.url}${path}`, {
    method,
    signal: abort.signal,
    headers: {
      "x-test-user": "user-1",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  expect(response.status).toBe(200);
  const frames: Stream["frames"] = [];
  const waiting: Array<() => void> = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const ended = (async () => {
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (part.startsWith("data: ")) frames.push(JSON.parse(part.slice(6)));
        }
        for (const wake of waiting.splice(0)) wake();
      }
    } catch {
      // Hung up by the test.
    }
  })();
  const until = (type: string) =>
    vi.waitFor(() => expect(frames.map((f) => f.type)).toContain(type), {
      timeout: 3000,
    });
  return { frames, until, ended, close: () => abort.abort() };
}

async function setup(
  fetch: (url: string, init?: unknown) => Promise<Response>,
) {
  server = await startServer({ permissions: OPS_PERMISSIONS, fetch });
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
  return { target: server, providerId: created.body.provider.id as number };
}

const roles = (target: TestServer, id: number) =>
  (
    target.db.sqlite
      .prepare(
        "SELECT role FROM p_ai_messages WHERE conversation_id = ? ORDER BY id",
      )
      .all(id) as Array<{ role: string }>
  ).map((row) => row.role);

/** Starts a run and waits until the model has begun answering. */
async function startRun(target: TestServer, providerId: number) {
  const stream = await openStream(target, "POST", "/ops/chat", {
    providerId,
    message: "hello",
  });
  await stream.until("token");
  const id = stream.frames[0].conversationId as number;
  return { stream, id };
}

describe("assistant runs", () => {
  it("keeps running and stores its reply after the browser hangs up", async () => {
    const model = heldModel();
    const { target, providerId } = await setup(model.fetch);
    const { stream, id } = await startRun(target, providerId);

    stream.close();
    await stream.ended;
    // Give a hang-up the chance to abort the run, as it used to.
    await new Promise((resolve) => setTimeout(resolve, 50));
    model.release();
    await vi.waitFor(() =>
      expect(roles(target, id)).toEqual(["user", "assistant"]),
    );
    expect(model.signals[0].aborted).toBe(false);
    const stored = target.db.sqlite
      .prepare("SELECT content FROM p_ai_messages WHERE role = 'assistant'")
      .get() as { content: string };
    expect(stored.content).toBe("Hello.");
  });

  it("replays a run to a second browser, then streams it live", async () => {
    const model = heldModel();
    const { target, providerId } = await setup(model.fetch);
    const { stream, id } = await startRun(target, providerId);

    const listed = await target.request("GET", "/ops/conversations");
    expect(listed.body.conversations[0]).toMatchObject({ id, running: true });
    const loaded = await target.request("GET", `/ops/conversations/${id}`);
    expect(loaded.body.conversation.running).toBe(true);

    const second = await openStream(
      target,
      "GET",
      `/ops/conversations/${id}/stream`,
    );
    await second.until("token");
    expect(second.frames).toEqual([
      { type: "conversation", conversationId: id },
      { type: "token", text: "Hel" },
    ]);

    model.release();
    await second.ended;
    await stream.ended;
    const tokens = second.frames
      .filter((f) => f.type === "token")
      .map((f) => f.text);
    expect(tokens).toEqual(["Hel", "lo."]);
    expect(second.frames.at(-1)).toEqual({ type: "done" });

    const after = await target.request("GET", `/ops/conversations/${id}`);
    expect(after.body.conversation.running).toBe(false);
    const idle = await openStream(
      target,
      "GET",
      `/ops/conversations/${id}/stream`,
    );
    await idle.ended;
    expect(idle.frames).toEqual([{ type: "done" }]);
  });

  it("refuses a second message while a run is going", async () => {
    const model = heldModel();
    const { target, providerId } = await setup(model.fetch);
    const { stream, id } = await startRun(target, providerId);

    const again = await target.request("POST", "/ops/chat", {
      body: { providerId, conversationId: id, message: "and again" },
    });
    expect(again.status).toBe(409);

    model.release();
    await stream.ended;
    expect(roles(target, id)).toEqual(["user", "assistant"]);
  });

  it("stops a run only when asked, by its owner", async () => {
    const model = heldModel();
    const { target, providerId } = await setup(model.fetch);
    const { stream, id } = await startRun(target, providerId);

    await target.enableFor("user-2");
    const stranger = await target.request(
      "POST",
      `/ops/conversations/${id}/stop`,
      { user: "user-2" },
    );
    expect(stranger.status).toBe(404);
    expect(model.signals[0].aborted).toBe(false);

    const stopped = await target.request(
      "POST",
      `/ops/conversations/${id}/stop`,
    );
    expect(stopped.status).toBe(200);
    await stream.ended;
    expect(model.signals[0].aborted).toBe(true);
    expect(stream.frames.at(-1)).toEqual({ type: "done" });
    expect(roles(target, id)).toEqual(["user"]);
    const after = await target.request("GET", `/ops/conversations/${id}`);
    expect(after.body.conversation.running).toBe(false);
  });

  it("stops a run before deleting its conversation", async () => {
    const model = heldModel();
    const { target, providerId } = await setup(model.fetch);
    const { stream, id } = await startRun(target, providerId);

    const deleted = await target.request("DELETE", `/ops/conversations/${id}`);
    expect(deleted.status).toBe(200);
    expect(model.signals[0].aborted).toBe(true);
    await stream.ended;
    expect(roles(target, id)).toEqual([]);
  });

  it("stops every run when the plugin is deactivated", async () => {
    const model = heldModel();
    const { target, providerId } = await setup(model.fetch);
    const { stream } = await startRun(target, providerId);

    for (const dispose of target.mock.disposals) await dispose();
    await stream.ended;
    expect(model.signals[0].aborted).toBe(true);
  });
});
