import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChunk } from "../../../src/backend/providers/types.js";

const sdk = vi.hoisted(() => ({ stream: vi.fn(), retrieve: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: sdk.stream };
    models = { retrieve: sdk.retrieve };
  },
}));

const { anthropicAdapter } =
  await import("../../../src/backend/providers/anthropic.js");

const THINKING = { type: "thinking", thinking: "plan", signature: "sig" };

/** A stream of these events whose final message is `final`. */
function fakeStream(events: unknown[], final: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    finalMessage: async () => final,
  };
}

async function collect(iterable: AsyncIterable<ChatChunk>) {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

const CONFIG = {
  fetch: vi.fn(),
  providerType: "anthropic" as const,
  apiKey: "sk-ant",
};

describe("anthropicAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("streams thinking apart from text and reports usage with cached input", async () => {
    sdk.stream.mockReturnValue(
      fakeStream(
        [
          {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "plan" },
          },
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hello" },
          },
        ],
        {
          content: [
            THINKING,
            { type: "text", text: "Hello" },
            { type: "tool_use", id: "t1", name: "list_hosts", input: {} },
          ],
          stop_reason: "tool_use",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 0,
            output_tokens: 20,
          },
        },
      ),
    );

    const chunks = await collect(
      anthropicAdapter.streamChat(CONFIG, {
        model: "claude-opus-5",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }),
    );

    expect(chunks).toEqual([
      { type: "reasoning", text: "plan" },
      { type: "text", text: "Hello" },
      {
        type: "tool_call",
        call: { id: "t1", name: "list_hosts", arguments: {} },
      },
      { type: "reasoning_state", blocks: [THINKING] },
      { type: "usage", usage: { promptTokens: 1000, completionTokens: 20 } },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  it("puts the run's signed thinking back before its tool use", async () => {
    sdk.stream.mockReturnValue(
      fakeStream([], { content: [], stop_reason: "end_turn", usage: {} }),
    );

    await collect(
      anthropicAdapter.streamChat(CONFIG, {
        model: "claude-opus-5",
        system: "s",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            reasoningState: [THINKING],
            toolCalls: [{ id: "t1", name: "list_hosts", arguments: {} }],
          },
          { role: "tool", content: "{}", toolCallId: "t1" },
        ],
        tools: [],
      }),
    );

    const sent = sdk.stream.mock.calls[0][0].messages;
    expect(sent[1].content[0]).toEqual(THINKING);
    expect(sent[1].content[1]).toMatchObject({ type: "tool_use", id: "t1" });
  });

  it("marks tools, the system prompt and the newest message for caching", async () => {
    sdk.stream.mockReturnValue(
      fakeStream([], { content: [], stop_reason: "end_turn", usage: {} }),
    );
    const tool = (name: string) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    });

    await collect(
      anthropicAdapter.streamChat(CONFIG, {
        model: "claude-opus-5",
        system: "You are the assistant.",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "t1", name: "list_hosts", arguments: {} }],
          },
          { role: "tool", content: "{}", toolCallId: "t1" },
        ],
        tools: [tool("list_hosts"), tool("get_host")],
      }),
    );

    const request = sdk.stream.mock.calls[0][0];
    const ephemeral = { type: "ephemeral" };
    expect(request.system).toEqual([
      {
        type: "text",
        text: "You are the assistant.",
        cache_control: ephemeral,
      },
    ]);
    expect(request.tools[0]).not.toHaveProperty("cache_control");
    expect(request.tools[1].cache_control).toEqual(ephemeral);
    expect(request.messages[0].content).toBe("hi");
    expect(request.messages[1].content.at(-1)).not.toHaveProperty(
      "cache_control",
    );
    expect(request.messages[2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "{}",
        cache_control: ephemeral,
      },
    ]);
  });

  it("turns a plain newest message into a cached text block", async () => {
    sdk.stream.mockReturnValue(
      fakeStream([], { content: [], stop_reason: "end_turn", usage: {} }),
    );
    await collect(
      anthropicAdapter.streamChat(CONFIG, {
        model: "claude-opus-5",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }),
    );
    const request = sdk.stream.mock.calls[0][0];
    expect(request.messages[0].content).toEqual([
      { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
    ]);
    expect(request).not.toHaveProperty("tools");
  });

  it("passes the abort signal as a request option, not in the body", async () => {
    sdk.stream.mockReturnValue(
      fakeStream([], { content: [], stop_reason: "end_turn", usage: {} }),
    );
    const controller = new AbortController();
    await collect(
      anthropicAdapter.streamChat(CONFIG, {
        model: "claude-opus-5",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: controller.signal,
      }),
    );
    const [body, options] = sdk.stream.mock.calls[0];
    expect(body).not.toHaveProperty("signal");
    expect(options).toEqual({ signal: controller.signal });
  });

  it("reads the window from the models API, with nothing when it has none", async () => {
    sdk.retrieve.mockResolvedValueOnce({
      id: "claude-opus-5",
      max_input_tokens: 1000000,
      max_tokens: 128000,
    });
    expect(
      await anthropicAdapter.describeModel(CONFIG, "claude-opus-5"),
    ).toEqual({ contextWindow: 1000000, maxOutputTokens: 128000 });

    sdk.retrieve.mockResolvedValueOnce({
      id: "claude-x",
      max_input_tokens: null,
      max_tokens: null,
    });
    expect(await anthropicAdapter.describeModel(CONFIG, "claude-x")).toEqual({
      contextWindow: undefined,
      maxOutputTokens: undefined,
    });
    expect(anthropicAdapter).toMatchObject({
      maxTokens: 16000,
      compactAt: 0.85,
    });
  });
});
