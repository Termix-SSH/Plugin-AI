import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChunk } from "../../src/backend/providers/types.js";

const streamChat = vi.fn();
const handler = vi.fn();

vi.mock("../../src/backend/providers/registry.js", () => ({
  getAdapter: () => ({ streamChat, listModels: async () => [] }),
}));

const { MAX_REPLY_TOKENS, REPEAT_LIMIT, runAgent } =
  await import("../../src/backend/engine.js");

function chunks(...values: ChatChunk[]) {
  return (async function* () {
    for (const value of values) yield value;
  })();
}

const BASE = {
  config: { providerType: "ollama" as const, fetch: vi.fn() },
  model: "test",
  system: "system",
  context: {
    userId: "user-1",
    conversationId: 1,
    allowReadOnlyCommands: false,
    deps: {} as never,
  },
  // Only what was offered can run, so this is the whole catalog here.
  tools: [
    {
      name: "list_hosts",
      description: "List hosts",
      category: "read" as const,
      parameters: { type: "object", properties: {} },
      handler,
    },
  ],
};

async function collect(history: any[] = []) {
  const events: any[] = [];
  for await (const event of runAgent({ ...BASE, history })) {
    events.push(event);
  }
  return events;
}

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams text and finishes when no tools are called", async () => {
    streamChat.mockReturnValueOnce(
      chunks({ type: "text", text: "hello" }, { type: "done" }),
    );

    const events = await collect();

    expect(events.filter((e) => e.type === "token")).toHaveLength(1);
    expect(events.at(-1).type).toBe("done");
  });

  it("caps every reply, so a looping model cannot stream forever", async () => {
    // In real use one call streamed 1.9 MB over 40 minutes.
    streamChat.mockReturnValueOnce(chunks({ type: "done" }));
    await collect();
    expect(streamChat.mock.calls[0][1].maxTokens).toBe(MAX_REPLY_TOKENS);

    streamChat.mockReturnValueOnce(chunks({ type: "done" }));
    for await (const _ of runAgent({
      ...BASE,
      history: [],
      maxReplyTokens: 2048,
    })) {
      // drain
    }
    expect(streamChat.mock.calls[1][1].maxTokens).toBe(2048);
  });

  it("runs a known tool and feeds the result back", async () => {
    handler.mockResolvedValue({ hosts: [{ id: 1, name: "web-1" }] });
    streamChat
      .mockReturnValueOnce(
        chunks(
          {
            type: "tool_call",
            call: { id: "c1", name: "list_hosts", arguments: {} },
          },
          { type: "done" },
        ),
      )
      .mockReturnValueOnce(
        chunks({ type: "text", text: "ok" }, { type: "done" }),
      );

    const events = await collect();

    expect(handler).toHaveBeenCalledOnce();
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(streamChat).toHaveBeenCalledTimes(2);
  });

  it("refuses a tool that is not in the catalog", async () => {
    streamChat
      .mockReturnValueOnce(
        chunks(
          {
            type: "tool_call",
            call: { id: "c1", name: "read_credentials", arguments: {} },
          },
          { type: "done" },
        ),
      )
      .mockReturnValueOnce(
        chunks({ type: "text", text: "ok" }, { type: "done" }),
      );

    const events = await collect();

    // A model can emit any name it likes; only the catalog decides what runs.
    expect(handler).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === "tool_result");
    expect(JSON.stringify(result.result)).toContain("Unknown tool");
  });

  it("surfaces a handler failure without ending the run", async () => {
    handler.mockRejectedValue(new Error("database is down"));
    streamChat
      .mockReturnValueOnce(
        chunks(
          {
            type: "tool_call",
            call: { id: "c1", name: "list_hosts", arguments: {} },
          },
          { type: "done" },
        ),
      )
      .mockReturnValueOnce(
        chunks({ type: "text", text: "ok" }, { type: "done" }),
      );

    const events = await collect();

    const result = events.find((e) => e.type === "tool_result");
    expect(JSON.stringify(result.result)).toContain("database is down");
    expect(events.at(-1).type).toBe("done");
  });

  it("closes the tool call when a tool returns a proposal", async () => {
    // Without a matching tool_result the call rendered as permanently
    // running, even though the work was done and awaiting the user.
    handler.mockResolvedValue({
      __proposal: true,
      kind: "propose_create_host",
      summary: "Add host web-1",
      payload: {},
    });
    streamChat
      .mockReturnValueOnce(
        chunks(
          {
            type: "tool_call",
            call: { id: "c1", name: "list_hosts", arguments: {} },
          },
          { type: "done" },
        ),
      )
      .mockReturnValueOnce(
        chunks({ type: "text", text: "ok" }, { type: "done" }),
      );

    const events = await collect();

    const callIndex = events.findIndex((e) => e.type === "tool_call");
    const resultIndex = events.findIndex((e) => e.type === "tool_result");
    const proposalIndex = events.findIndex((e) => e.type === "proposal");

    expect(resultIndex).toBeGreaterThan(callIndex);
    expect(proposalIndex).toBeGreaterThan(resultIndex);
    expect(events[resultIndex]).toMatchObject({
      name: "list_hosts",
      result: { status: "awaiting_user_approval" },
    });
  });

  it("reports a provider failure as an error and stops", async () => {
    streamChat.mockImplementationOnce(() => {
      throw new Error("provider unreachable");
    });

    const events = await collect();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: "provider unreachable",
    });
  });

  it("has no step limit while the model makes progress", async () => {
    let count = 0;
    handler.mockImplementation(async () => ({ seen: count++ }));
    let turn = 0;
    streamChat.mockImplementation(() =>
      turn++ < 30
        ? chunks(
            {
              type: "tool_call",
              call: { id: `c${turn}`, name: "list_hosts", arguments: {} },
            },
            { type: "done" },
          )
        : chunks({ type: "text", text: "all done" }, { type: "done" }),
    );

    const events = await collect();

    expect(streamChat).toHaveBeenCalledTimes(31);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("stops a loop that repeats the same call with the same result", async () => {
    handler.mockResolvedValue({ ok: true });
    streamChat.mockImplementation(() =>
      chunks(
        {
          type: "tool_call",
          call: { id: "c", name: "list_hosts", arguments: { tag: "prod" } },
        },
        { type: "done" },
      ),
    );

    const events = await collect();

    expect(streamChat).toHaveBeenCalledTimes(REPEAT_LIMIT);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.at(-1).message).toContain("list_hosts");
    expect(events.at(-1).message).toContain("same arguments");
  });

  it("does not count a repeat broken by different arguments", async () => {
    handler.mockResolvedValue({ ok: true });
    let turn = 0;
    streamChat.mockImplementation(() =>
      turn++ < 8
        ? chunks(
            {
              type: "tool_call",
              call: {
                id: `c${turn}`,
                name: "list_hosts",
                arguments: { page: turn % 2 },
              },
            },
            { type: "done" },
          )
        : chunks({ type: "text", text: "ok" }, { type: "done" }),
    );

    const events = await collect();

    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("takes the turn limit from the caller", async () => {
    let count = 0;
    handler.mockImplementation(async () => ({ seen: count++ }));
    streamChat.mockImplementation(() =>
      chunks(
        {
          type: "tool_call",
          call: { id: "c", name: "list_hosts", arguments: {} },
        },
        { type: "done" },
      ),
    );

    const events: Array<{ type: string; message?: unknown }> = [];
    for await (const event of runAgent({
      ...BASE,
      history: [],
      maxTurns: 8,
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "The assistant used too many steps without finishing.",
    });
    expect(streamChat).toHaveBeenCalledTimes(8);
  });

  it("emits every message it adds so the caller can store the run", async () => {
    handler.mockResolvedValue({ hosts: [] });
    streamChat
      .mockReturnValueOnce(
        chunks(
          { type: "text", text: "Looking" },
          {
            type: "tool_call",
            call: { id: "c1", name: "list_hosts", arguments: {} },
          },
          { type: "done" },
        ),
      )
      .mockReturnValueOnce(
        chunks({ type: "text", text: "none" }, { type: "done" }),
      );

    const stored = (await collect())
      .filter((e) => e.type === "message")
      .map((e) => e.message);

    expect(stored).toEqual([
      {
        role: "assistant",
        content: "Looking",
        toolCalls: [{ id: "c1", name: "list_hosts", arguments: {} }],
      },
      {
        role: "tool",
        content: JSON.stringify({ hosts: [] }),
        toolCallId: "c1",
        toolName: "list_hosts",
      },
      { role: "assistant", content: "none" },
    ]);
  });

  it("explains a stream the provider cut off", async () => {
    streamChat.mockReturnValueOnce(
      (async function* () {
        yield { type: "text", text: "par" } as ChatChunk;
        throw Object.assign(new TypeError("terminated"), {
          cause: Object.assign(new Error("Body Timeout Error"), {
            code: "UND_ERR_BODY_TIMEOUT",
          }),
        });
      })(),
    );

    const events = await collect();
    expect(events.at(-1).type).toBe("error");
    expect(events.at(-1).message).toMatch(/stopped sending data/);
  });

  it("stays quiet when the user stopped it", async () => {
    const controller = new AbortController();
    streamChat.mockReturnValueOnce(
      (async function* () {
        yield { type: "text", text: "" } as ChatChunk;
        controller.abort();
        throw new Error("This operation was aborted");
      })(),
    );

    const events: any[] = [];
    for await (const event of runAgent({
      ...BASE,
      history: [],
      signal: controller.signal,
    })) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
