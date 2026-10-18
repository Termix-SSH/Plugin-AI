import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChunk } from "../../../src/backend/providers/types.js";
import { createThinkSplitter } from "../../../src/backend/providers/think-tags.js";

const providerFetch = vi.fn();

const { openAiAdapter } =
  await import("../../../src/backend/providers/openai.js");
const { ollamaAdapter } =
  await import("../../../src/backend/providers/ollama.js");
const { geminiAdapter } =
  await import("../../../src/backend/providers/gemini.js");

function streamingResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }),
  );
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n`;

async function collect(iterable: AsyncIterable<ChatChunk>) {
  const chunks: ChatChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

const joined = (chunks: ChatChunk[], type: "text" | "reasoning") =>
  chunks
    .filter((chunk) => chunk.type === type)
    .map((chunk) => (chunk as { text: string }).text)
    .join("");

const REQUEST = {
  model: "glm-5.3-flash",
  system: "system",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
};

const COMPATIBLE = {
  fetch: providerFetch,
  providerType: "openai_compatible" as const,
  baseUrl: "https://glm.example/v1",
};

describe("openAiAdapter usage and reasoning", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps reasoning_content out of the answer and reads the final usage chunk", async () => {
    providerFetch.mockResolvedValue(
      streamingResponse([
        sse({ choices: [{ delta: { reasoning_content: "Check the " } }] }),
        sse({ choices: [{ delta: { reasoning_content: "hosts first." } }] }),
        sse({ choices: [{ delta: { content: "You have " } }] }),
        sse({ choices: [{ delta: { content: "2 hosts." } }] }),
        sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        sse({
          choices: [],
          usage: { prompt_tokens: 4210, completion_tokens: 57 },
        }),
        "data: [DONE]\n",
      ]),
    );

    const chunks = await collect(openAiAdapter.streamChat(COMPATIBLE, REQUEST));

    expect(joined(chunks, "reasoning")).toBe("Check the hosts first.");
    expect(joined(chunks, "text")).toBe("You have 2 hosts.");
    expect(chunks).toContainEqual({
      type: "usage",
      usage: { promptTokens: 4210, completionTokens: 57 },
    });
    const body = JSON.parse(providerFetch.mock.calls[0][1].body);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("reads usage a server puts on its last content chunk", async () => {
    providerFetch.mockResolvedValue(
      streamingResponse([
        sse({
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 1 },
        }),
      ]),
    );

    const chunks = await collect(openAiAdapter.streamChat(COMPATIBLE, REQUEST));

    expect(chunks).toContainEqual({
      type: "usage",
      usage: { promptTokens: 12, completionTokens: 1 },
    });
  });

  it("takes reasoning from a reasoning field and from think tags", async () => {
    providerFetch.mockResolvedValue(
      streamingResponse([
        sse({ choices: [{ delta: { reasoning: "via field. " } }] }),
        sse({ choices: [{ delta: { content: "<thi" } }] }),
        sse({ choices: [{ delta: { content: "nk>inline</th" } }] }),
        sse({ choices: [{ delta: { content: "ink>Answer." } }] }),
      ]),
    );

    const chunks = await collect(openAiAdapter.streamChat(COMPATIBLE, REQUEST));

    expect(joined(chunks, "reasoning")).toBe("via field. inline");
    expect(joined(chunks, "text")).toBe("Answer.");
    expect(chunks.some((chunk) => chunk.type === "usage")).toBe(false);
  });

  it("sends this run's reasoning back with its tool calls only", async () => {
    providerFetch.mockResolvedValue(streamingResponse([]));
    const call = { id: "c1", name: "list_hosts", arguments: {} };

    await collect(
      openAiAdapter.streamChat(COMPATIBLE, {
        ...REQUEST,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            reasoning: "old",
            toolCalls: [call],
          },
          { role: "tool", content: "{}", toolCallId: "c1" },
          {
            role: "assistant",
            content: "",
            reasoning: "new",
            reasoningState: [{ reasoning_content: "new" }],
            toolCalls: [{ ...call, id: "c2" }],
          },
          { role: "tool", content: "{}", toolCallId: "c2" },
        ],
      }),
    );

    const body = JSON.parse(providerFetch.mock.calls[0][1].body);
    const assistants = body.messages.filter(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistants[0]).not.toHaveProperty("reasoning_content");
    expect(assistants[1].reasoning_content).toBe("new");
  });
});

describe("think tag splitter", () => {
  it("holds back a partial tag and flushes the rest", () => {
    const think = createThinkSplitter();
    expect(think.push("a <")).toEqual([{ type: "text", text: "a " }]);
    expect(think.push("b")).toEqual([{ type: "text", text: "<b" }]);
    expect(think.push("<think>x")).toEqual([{ type: "reasoning", text: "x" }]);
    expect(think.push("</think")).toEqual([]);
    expect(think.flush()).toEqual([{ type: "reasoning", text: "</think" }]);
  });
});

describe("ollamaAdapter usage and reasoning", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads thinking and the eval counts", async () => {
    providerFetch.mockResolvedValue(
      streamingResponse([
        '{"message":{"thinking":"hmm"}}\n',
        '{"message":{"content":"<think>more</think>Hi"}}\n',
        '{"done":true,"prompt_eval_count":321,"eval_count":9}\n',
      ]),
    );

    const chunks = await collect(
      ollamaAdapter.streamChat(
        { fetch: providerFetch, providerType: "ollama" },
        REQUEST,
      ),
    );

    expect(joined(chunks, "reasoning")).toBe("hmmmore");
    expect(joined(chunks, "text")).toBe("Hi");
    expect(chunks).toContainEqual({
      type: "usage",
      usage: { promptTokens: 321, completionTokens: 9 },
    });
  });

  it("reports nothing when ollama leaves the counts out", async () => {
    providerFetch.mockResolvedValue(
      streamingResponse(['{"message":{"content":"Hi"}}\n', '{"done":true}\n']),
    );

    const chunks = await collect(
      ollamaAdapter.streamChat(
        { fetch: providerFetch, providerType: "ollama" },
        REQUEST,
      ),
    );

    expect(chunks.some((chunk) => chunk.type === "usage")).toBe(false);
  });
});

describe("geminiAdapter usage and reasoning", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps thought parts apart and reads usageMetadata", async () => {
    providerFetch.mockResolvedValue(
      streamingResponse([
        sse({
          candidates: [
            {
              content: { parts: [{ text: "Thinking it over", thought: true }] },
            },
          ],
          usageMetadata: { promptTokenCount: 50 },
        }),
        sse({
          candidates: [{ content: { parts: [{ text: "Answer" }] } }],
          usageMetadata: {
            promptTokenCount: 50,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 6,
          },
        }),
      ]),
    );

    const chunks = await collect(
      geminiAdapter.streamChat(
        { fetch: providerFetch, providerType: "gemini", apiKey: "k" },
        REQUEST,
      ),
    );

    expect(joined(chunks, "reasoning")).toBe("Thinking it over");
    expect(joined(chunks, "text")).toBe("Answer");
    expect(chunks).toContainEqual({
      type: "usage",
      usage: { promptTokens: 50, completionTokens: 10 },
    });
  });
});
