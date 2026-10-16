import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChunk } from "../../../src/backend/providers/types.js";

const sdk = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { stream: sdk.stream };
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
});
