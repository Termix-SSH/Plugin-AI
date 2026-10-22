import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChunk } from "../../../src/backend/providers/types.js";
import { AiProviderError } from "../../../src/backend/providers/types.js";

const providerFetch = vi.fn();

const { openAiAdapter } =
  await import("../../../src/backend/providers/openai.js");
const { resetResponsesMemory, usesResponsesApi } =
  await import("../../../src/backend/providers/openai-responses.js");

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

const REQUEST = {
  model: "gpt-5",
  system: "system",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
};

const OPENAI = {
  fetch: providerFetch,
  providerType: "openai" as const,
};

const COMPATIBLE = {
  fetch: providerFetch,
  providerType: "openai_compatible" as const,
  baseUrl: "https://proxy.example/v1",
};

const RUN_TOOL = {
  name: "run",
  description: "Run a command",
  parameters: {
    type: "object",
    properties: { cmd: { type: "string" } },
    required: ["cmd"],
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  resetResponsesMemory();
});

describe("usesResponsesApi", () => {
  it.each([
    { label: "OpenAI without a base URL", config: OPENAI, expected: true },
    {
      label: "OpenAI at api.openai.com",
      config: { ...OPENAI, baseUrl: "https://api.openai.com/v1" },
      expected: true,
    },
    {
      label: "OpenAI at a regional hostname",
      config: { ...OPENAI, baseUrl: "https://eu.api.openai.com/v1" },
      expected: true,
    },
    {
      label: "OpenAI at a lookalike hostname",
      config: { ...OPENAI, baseUrl: "https://notapi.openai.com/v1" },
      expected: false,
    },
    {
      label: "OpenAI at a proxy",
      config: { ...OPENAI, baseUrl: "https://proxy.example/v1" },
      expected: false,
    },
    {
      label: "a compatible provider at api.openai.com",
      config: { ...COMPATIBLE, baseUrl: "https://api.openai.com/v1" },
      expected: false,
    },
    {
      label: "an invalid URL",
      config: { ...OPENAI, baseUrl: "not a URL" },
      expected: false,
    },
  ])("routes $label", ({ config, expected }) => {
    expect(usesResponsesApi(config)).toBe(expected);
    expect(providerFetch).not.toHaveBeenCalled();
  });
});

describe("openAiAdapter Responses requests", () => {
  it("maps the system, token limit and tools without setting reasoning effort", async () => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([
        sse({ type: "response.completed" }),
        "data: [DONE]\n",
      ]),
    );

    const chunks = await collect(
      openAiAdapter.streamChat(
        { ...OPENAI, apiKey: "test-key" },
        { ...REQUEST, maxTokens: 512, tools: [RUN_TOOL] },
      ),
    );

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        },
      }),
    );
    const body = JSON.parse(providerFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      model: REQUEST.model,
      instructions: REQUEST.system,
      input: REQUEST.messages,
      store: false,
      stream: true,
      reasoning: { summary: "auto" },
      max_output_tokens: 512,
      tools: [{ type: "function", ...RUN_TOOL, strict: false }],
    });
    expect(body.reasoning).not.toHaveProperty("effort");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(chunks).toEqual([{ type: "done", stopReason: "stop" }]);
  });
});

describe("openAiAdapter Responses streaming", () => {
  it("yields text deltas, completed usage and a stop reason", async () => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([
        sse({ type: "response.output_text.delta", delta: "Hello " }),
        sse({ type: "response.output_text.delta", delta: "world." }),
        sse({
          type: "response.completed",
          response: { usage: { input_tokens: 42, output_tokens: 7 } },
        }),
        "data: [DONE]\n",
      ]),
    );

    const chunks = await collect(openAiAdapter.streamChat(OPENAI, REQUEST));

    const body = JSON.parse(providerFetch.mock.calls[0][1].body);
    expect(body.input).toEqual(REQUEST.messages);
    expect(body.stream).toBe(true);
    expect(chunks).toEqual([
      { type: "text", text: "Hello " },
      { type: "text", text: "world." },
      { type: "usage", usage: { promptTokens: 42, completionTokens: 7 } },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("separates nonempty reasoning deltas across items and summaries", async () => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([
        sse({
          type: "response.reasoning_summary_part.added",
          item_id: "rs_1",
          summary_index: 0,
        }),
        sse({
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_1",
          summary_index: 0,
          delta: "Check ",
        }),
        sse({
          type: "response.reasoning_summary_part.added",
          item_id: "rs_1",
          summary_index: 1,
        }),
        sse({
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_1",
          summary_index: 1,
          delta: "",
        }),
        sse({
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_1",
          summary_index: 0,
          delta: "the host.",
        }),
        sse({
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_1",
          summary_index: 1,
          delta: "Then answer.",
        }),
        sse({
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_2",
          summary_index: 0,
          delta: "Confirm",
        }),
        sse({
          type: "response.reasoning_text.delta",
          item_id: "rs_2",
          summary_index: 0,
          delta: " the result.",
        }),
        sse({ type: "response.completed" }),
      ]),
    );

    const chunks = await collect(openAiAdapter.streamChat(OPENAI, REQUEST));

    const body = JSON.parse(providerFetch.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ summary: "auto" });
    expect(chunks).toEqual([
      { type: "reasoning", text: "Check " },
      { type: "reasoning", text: "the host." },
      { type: "reasoning", text: "\n\n" },
      { type: "reasoning", text: "Then answer." },
      { type: "reasoning", text: "\n\n" },
      { type: "reasoning", text: "Confirm" },
      { type: "reasoning", text: " the result." },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("yields refusal deltas as text", async () => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([
        sse({ type: "response.refusal.delta", delta: "I cannot " }),
        sse({ type: "response.refusal.delta", delta: "help with that." }),
        sse({ type: "response.completed" }),
      ]),
    );

    expect(await collect(openAiAdapter.streamChat(OPENAI, REQUEST))).toEqual([
      { type: "text", text: "I cannot " },
      { type: "text", text: "help with that." },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it.each([
    {
      label: "valid",
      arguments: '{"cmd":"uptime"}',
      expected: { cmd: "uptime" },
    },
    { label: "malformed", arguments: "{broken", expected: {} },
  ])(
    "parses $label function call arguments from output_item.done",
    async (call) => {
      providerFetch.mockResolvedValueOnce(
        streamingResponse([
          sse({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_1",
              name: "run",
              arguments: call.arguments,
            },
          }),
          sse({ type: "response.completed" }),
        ]),
      );

      const chunks = await collect(
        openAiAdapter.streamChat(OPENAI, { ...REQUEST, tools: [RUN_TOOL] }),
      );

      const body = JSON.parse(providerFetch.mock.calls[0][1].body);
      expect(body.tools).toEqual([
        { type: "function", ...RUN_TOOL, strict: false },
      ]);
      expect(chunks).toEqual([
        {
          type: "tool_call",
          call: { id: "call_1", name: "run", arguments: call.expected },
        },
        { type: "done", stopReason: "tool_calls" },
      ]);
    },
  );

  it("uses the incomplete details as the stop reason", async () => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([
        sse({
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        }),
      ]),
    );

    const chunks = await collect(
      openAiAdapter.streamChat(OPENAI, { ...REQUEST, maxTokens: 16 }),
    );

    const body = JSON.parse(providerFetch.mock.calls[0][1].body);
    expect(body.max_output_tokens).toBe(16);
    expect(chunks).toEqual([{ type: "done", stopReason: "max_output_tokens" }]);
  });

  it("round trips streamed reasoning and tool calls without stored item ids", async () => {
    const reasoningItem = {
      id: "rs_1",
      type: "reasoning",
      status: "completed",
      summary: [],
      encrypted_content: "enc",
    };
    const toolCall = {
      id: "call_1",
      name: "run",
      arguments: { cmd: "uptime" },
    };
    providerFetch
      .mockResolvedValueOnce(
        streamingResponse([
          sse({ type: "response.output_text.delta", delta: "Checking" }),
          sse({ type: "response.output_item.done", item: reasoningItem }),
          sse({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: toolCall.id,
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments),
            },
          }),
          sse({ type: "response.completed" }),
        ]),
      )
      .mockResolvedValueOnce(
        streamingResponse([
          sse({ type: "response.output_text.delta", delta: "Up 3 days." }),
          sse({ type: "response.completed" }),
        ]),
      );

    const first = await collect(
      openAiAdapter.streamChat(OPENAI, { ...REQUEST, tools: [RUN_TOOL] }),
    );
    expect(first).toEqual([
      { type: "text", text: "Checking" },
      { type: "tool_call", call: toolCall },
      { type: "reasoning_state", blocks: [reasoningItem] },
      { type: "done", stopReason: "tool_calls" },
    ]);

    const second = await collect(
      openAiAdapter.streamChat(OPENAI, {
        ...REQUEST,
        tools: [RUN_TOOL],
        messages: [
          ...REQUEST.messages,
          {
            role: "assistant",
            content: first
              .flatMap((chunk) => (chunk.type === "text" ? [chunk.text] : []))
              .join(""),
            toolCalls: first.flatMap((chunk) =>
              chunk.type === "tool_call" ? [chunk.call] : [],
            ),
            reasoningState: first.flatMap((chunk) =>
              chunk.type === "reasoning_state" ? chunk.blocks : [],
            ),
          },
          { role: "tool", toolCallId: "call_1", content: "up 3 days" },
        ],
      }),
    );

    expect(providerFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(providerFetch.mock.calls[0][1].body);
    expect(firstBody.input).toEqual(REQUEST.messages);
    const secondBody = JSON.parse(providerFetch.mock.calls[1][1].body);
    expect(secondBody.input).toEqual([
      { role: "user", content: "hi" },
      { type: "reasoning", summary: [], encrypted_content: "enc" },
      { role: "assistant", content: "Checking" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "run",
        arguments: '{"cmd":"uptime"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "up 3 days" },
    ]);
    expect(second).toEqual([
      { type: "text", text: "Up 3 days." },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it("omits reasoning without encrypted content from the next request", async () => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([sse({ type: "response.completed" })]),
    );

    await collect(
      openAiAdapter.streamChat(OPENAI, {
        ...REQUEST,
        messages: [
          ...REQUEST.messages,
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call_1", name: "run", arguments: { cmd: "uptime" } },
            ],
            reasoningState: [
              {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "Check uptime." }],
              },
            ],
          },
          { role: "tool", toolCallId: "call_1", content: "up 3 days" },
        ],
      }),
    );

    expect(JSON.parse(providerFetch.mock.calls[0][1].body).input).toEqual([
      ...REQUEST.messages,
      {
        type: "function_call",
        call_id: "call_1",
        name: "run",
        arguments: '{"cmd":"uptime"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "up 3 days" },
    ]);
  });
});

describe("openAiAdapter Responses retries and errors", () => {
  it.each([
    {
      model: "gpt-5",
      message:
        "Your organization must be verified to generate reasoning summaries.",
    },
    { model: "gpt-4.1", message: "Encrypted content is not supported" },
    { model: "gpt-4.1", message: "reasoning.summary is not supported" },
  ])(
    "remembers the reasoning fallback for $model after $message",
    async ({ model, message }) => {
      providerFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message } }), { status: 400 }),
        )
        .mockResolvedValueOnce(
          streamingResponse([
            sse({ type: "response.output_text.delta", delta: "ok" }),
            sse({ type: "response.completed" }),
          ]),
        )
        .mockResolvedValueOnce(
          streamingResponse([sse({ type: "response.completed" })]),
        );

      const request = { ...REQUEST, model };
      const chunks = await collect(openAiAdapter.streamChat(OPENAI, request));
      await collect(openAiAdapter.streamChat(OPENAI, request));

      expect(providerFetch).toHaveBeenCalledTimes(3);
      expect(providerFetch.mock.calls.map(([url]) => url)).toEqual([
        "https://api.openai.com/v1/responses",
        "https://api.openai.com/v1/responses",
        "https://api.openai.com/v1/responses",
      ]);
      const initial = JSON.parse(providerFetch.mock.calls[0][1].body);
      const retry = JSON.parse(providerFetch.mock.calls[1][1].body);
      expect(initial.reasoning).toEqual({ summary: "auto" });
      const { reasoning, ...withoutReasoning } = initial;
      expect(retry).toEqual(withoutReasoning);
      expect(retry).not.toHaveProperty("reasoning");
      expect(JSON.parse(providerFetch.mock.calls[2][1].body)).toEqual(retry);
      expect(chunks).toEqual([
        { type: "text", text: "ok" },
        { type: "done", stopReason: "stop" },
      ]);
    },
  );

  it("warns once when reasoning summaries are refused and remembers the fallback", async () => {
    const warn = vi.fn();
    const config = { ...OPENAI, log: { warn } };
    const detail = "reasoning.summary is not supported for this model";
    providerFetch
      .mockResolvedValueOnce(new Response(detail, { status: 400 }))
      .mockResolvedValueOnce(
        streamingResponse([sse({ type: "response.completed" })]),
      )
      .mockResolvedValueOnce(
        streamingResponse([sse({ type: "response.completed" })]),
      );

    await collect(openAiAdapter.streamChat(config, REQUEST));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `OpenAI refused reasoning summaries for ${REQUEST.model}, continuing without them (no Thinking block): ${detail}`,
    );

    await collect(openAiAdapter.streamChat(config, REQUEST));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(
      providerFetch.mock.calls.map(
        ([, options]) => JSON.parse(options.body).reasoning,
      ),
    ).toEqual([{ summary: "auto" }, undefined, undefined]);
  });

  it("keeps reasoning fallback memory separate by base URL and model", async () => {
    providerFetch
      .mockResolvedValueOnce(
        new Response("reasoning is unsupported", { status: 400 }),
      )
      .mockImplementation(async () =>
        streamingResponse([sse({ type: "response.completed" })]),
      );

    await collect(openAiAdapter.streamChat(OPENAI, REQUEST));
    await collect(
      openAiAdapter.streamChat(OPENAI, { ...REQUEST, model: "gpt-4.1" }),
    );
    await collect(
      openAiAdapter.streamChat(
        { ...OPENAI, baseUrl: "https://eu.api.openai.com/v1" },
        REQUEST,
      ),
    );
    await collect(openAiAdapter.streamChat(OPENAI, REQUEST));

    expect(providerFetch).toHaveBeenCalledTimes(5);
    expect(
      providerFetch.mock.calls.map(
        ([, options]) => JSON.parse(options.body).reasoning,
      ),
    ).toEqual([
      { summary: "auto" },
      undefined,
      { summary: "auto" },
      { summary: "auto" },
      undefined,
    ]);
  });

  it("throws an unrelated 400 without retrying", async () => {
    providerFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "Invalid model" } }), {
        status: 400,
      }),
    );

    const result = collect(openAiAdapter.streamChat(OPENAI, REQUEST));

    await expect(result).rejects.toBeInstanceOf(AiProviderError);
    await expect(result).rejects.toMatchObject({
      status: 400,
      message: "OpenAI request failed (400): Invalid model",
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(providerFetch.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ summary: "auto" });
  });

  it.each([404, 405, 422, 500])(
    "throws a Responses %i without falling back",
    async (status) => {
      providerFetch.mockResolvedValueOnce(
        new Response("reasoning unavailable", { status }),
      );

      const result = collect(openAiAdapter.streamChat(OPENAI, REQUEST));

      await expect(result).rejects.toBeInstanceOf(AiProviderError);
      await expect(result).rejects.toMatchObject({
        status,
        message: `OpenAI request failed (${status}): reasoning unavailable`,
      });
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(providerFetch.mock.calls[0][0]).toBe(
        "https://api.openai.com/v1/responses",
      );
      const body = JSON.parse(providerFetch.mock.calls[0][1].body);
      expect(body.input).toEqual(REQUEST.messages);
    },
  );

  it("retries a rejected reasoning option only once", async () => {
    providerFetch.mockImplementation(
      async () => new Response("reasoning unavailable", { status: 400 }),
    );

    await expect(
      collect(openAiAdapter.streamChat(OPENAI, REQUEST)),
    ).rejects.toMatchObject({
      status: 400,
      message: "OpenAI request failed (400): reasoning unavailable",
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(providerFetch.mock.calls[1][1].body)).not.toHaveProperty(
      "reasoning",
    );
  });

  it.each([
    { label: "EOF", ending: [] },
    { label: "[DONE]", ending: ["data: [DONE]\n"] },
  ])("rejects $label before a terminal response event", async ({ ending }) => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([
        sse({ type: "response.output_text.delta", delta: "partial" }),
        ...ending,
      ]),
    );

    const result = collect(openAiAdapter.streamChat(OPENAI, REQUEST));

    await expect(result).rejects.toBeInstanceOf(AiProviderError);
    await expect(result).rejects.toThrow(
      "OpenAI closed the stream before the response finished.",
    );
  });

  it.each([
    {
      type: "response.failed",
      response: { error: { message: "Generation failed" } },
      expected: "Generation failed",
    },
    { type: "error", message: "Stream failed", expected: "Stream failed" },
  ])(
    "rejects a $type event with its message",
    async ({ expected, ...frame }) => {
      providerFetch.mockResolvedValueOnce(streamingResponse([sse(frame)]));

      await expect(
        collect(openAiAdapter.streamChat(OPENAI, REQUEST)),
      ).rejects.toThrow(`OpenAI request failed: ${expected}`);

      expect(providerFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(providerFetch.mock.calls[0][1].body);
      expect(body.input).toEqual(REQUEST.messages);
    },
  );
});

describe("openAiAdapter compatible chat requests", () => {
  it("uses chat completions for a compatible provider at the OpenAI base URL", async () => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([
        sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
        "data: [DONE]\n",
      ]),
    );

    const chunks = await collect(
      openAiAdapter.streamChat(
        { ...COMPATIBLE, baseUrl: "https://api.openai.com/v1" },
        { ...REQUEST, maxTokens: 64 },
      ),
    );

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch.mock.calls[0][0]).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    const body = JSON.parse(providerFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      model: REQUEST.model,
      messages: [
        { role: "system", content: REQUEST.system },
        ...REQUEST.messages,
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
    });
    expect(chunks).toEqual([
      { type: "text", text: "ok" },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it.each([
    {
      label: "includes the first reasoning-state block",
      reasoningState: [
        {
          id: "rs_1",
          type: "reasoning",
          status: "completed",
          summary: [],
          encrypted_content: "enc",
        },
      ],
      expected: {
        id: "rs_1",
        type: "reasoning",
        status: "completed",
        summary: [],
        encrypted_content: "enc",
      },
    },
    {
      label: "includes compatible reasoning content",
      reasoningState: [{ reasoning_content: "x" }],
      expected: { reasoning_content: "x" },
    },
  ])(
    "$label in assistant chat messages",
    async ({ reasoningState, expected }) => {
      providerFetch.mockResolvedValueOnce(
        streamingResponse([
          sse({
            choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
          }),
        ]),
      );

      const chunks = await collect(
        openAiAdapter.streamChat(COMPATIBLE, {
          ...REQUEST,
          messages: [
            ...REQUEST.messages,
            {
              role: "assistant",
              content: "Checking",
              toolCalls: [
                { id: "call_1", name: "run", arguments: { cmd: "uptime" } },
              ],
              reasoningState,
            },
            { role: "tool", toolCallId: "call_1", content: "up 3 days" },
          ],
        }),
      );

      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(providerFetch.mock.calls[0][0]).toBe(
        "https://proxy.example/v1/chat/completions",
      );
      const body = JSON.parse(providerFetch.mock.calls[0][1].body);
      expect(body.messages).toEqual([
        { role: "system", content: REQUEST.system },
        ...REQUEST.messages,
        {
          role: "assistant",
          content: "Checking",
          ...expected,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "run", arguments: '{"cmd":"uptime"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "up 3 days" },
      ]);
      expect(chunks).toEqual([
        { type: "text", text: "done" },
        { type: "done", stopReason: "stop" },
      ]);
    },
  );
});

const RESPONSES_BODY = {
  model: REQUEST.model,
  instructions: REQUEST.system,
  input: REQUEST.messages,
  stream: true,
  store: false,
};

describe("OpenAI advanced Responses routing", () => {
  it.each([
    {
      label: "OpenAI forced to Responses at a proxy",
      config: {
        ...OPENAI,
        baseUrl: "https://proxy.example/v1",
        advanced: { endpoint: "responses" as const },
      },
      expected: true,
    },
    {
      label: "a compatible provider forced to Responses",
      config: {
        ...COMPATIBLE,
        advanced: { endpoint: "responses" as const },
      },
      expected: true,
    },
    {
      label: "OpenAI forced to chat at the official URL",
      config: {
        ...OPENAI,
        baseUrl: "https://api.openai.com/v1",
        advanced: { endpoint: "chat" as const },
      },
      expected: false,
    },
    {
      label: "a compatible provider forced to chat",
      config: {
        ...COMPATIBLE,
        advanced: { endpoint: "chat" as const },
      },
      expected: false,
    },
    {
      label: "OpenAI using auto at the official URL",
      config: { ...OPENAI, advanced: { endpoint: "auto" as const } },
      expected: true,
    },
    {
      label: "OpenAI using auto at a proxy",
      config: {
        ...OPENAI,
        baseUrl: COMPATIBLE.baseUrl,
        advanced: { endpoint: "auto" as const },
      },
      expected: false,
    },
    {
      label: "a compatible provider using auto at the official URL",
      config: {
        ...COMPATIBLE,
        baseUrl: "https://api.openai.com/v1",
        advanced: { endpoint: "auto" as const },
      },
      expected: false,
    },
  ])("routes $label", ({ config, expected }) => {
    expect(usesResponsesApi(config)).toBe(expected);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([OPENAI, COMPATIBLE])(
    "posts to Responses when $providerType overrides its proxy endpoint",
    async (config) => {
      providerFetch.mockResolvedValueOnce(
        streamingResponse([sse({ type: "response.completed" })]),
      );

      await collect(
        openAiAdapter.streamChat(
          {
            ...config,
            baseUrl: "https://proxy.example/v1",
            advanced: { endpoint: "responses" },
          },
          REQUEST,
        ),
      );

      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(providerFetch.mock.calls[0][0]).toBe(
        "https://proxy.example/v1/responses",
      );
      expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
        ...RESPONSES_BODY,
        reasoning: { summary: "auto" },
      });
    },
  );

  it("posts to chat when OpenAI overrides the official Responses endpoint", async () => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([
        sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n",
      ]),
    );

    await collect(
      openAiAdapter.streamChat(
        {
          ...OPENAI,
          baseUrl: "https://api.openai.com/v1",
          advanced: { endpoint: "chat" },
        },
        REQUEST,
      ),
    );

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch.mock.calls[0][0]).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
      model: REQUEST.model,
      messages: [
        { role: "system", content: REQUEST.system },
        ...REQUEST.messages,
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
  });
});

describe("OpenAI advanced Responses requests", () => {
  it("maps every advanced field and lets effort none use temperature", async () => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([sse({ type: "response.completed" })]),
    );

    await collect(
      openAiAdapter.streamChat(
        {
          ...OPENAI,
          advanced: {
            endpoint: "responses",
            reasoningEffort: "none",
            reasoningSummary: "detailed",
            verbosity: "high",
            maxOutputTokens: 1024,
            temperature: 0.25,
          },
        },
        { ...REQUEST, maxTokens: 64, tools: [RUN_TOOL] },
      ),
    );

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
      ...RESPONSES_BODY,
      reasoning: { effort: "none", summary: "detailed" },
      text: { verbosity: "high" },
      max_output_tokens: 64,
      temperature: 0.25,
      tools: [{ type: "function", ...RUN_TOOL, strict: false }],
    });
  });

  it.each([undefined, {}])(
    "keeps the legacy body with advanced settings %j",
    async (advanced) => {
      providerFetch.mockResolvedValueOnce(
        streamingResponse([sse({ type: "response.completed" })]),
      );

      await collect(
        openAiAdapter.streamChat(
          { ...OPENAI, advanced },
          { ...REQUEST, maxTokens: 512 },
        ),
      );

      expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
        ...RESPONSES_BODY,
        reasoning: { summary: "auto" },
        max_output_tokens: 512,
      });
    },
  );

  it.each([
    { effort: undefined, expected: RESPONSES_BODY },
    {
      effort: "high" as const,
      expected: { ...RESPONSES_BODY, reasoning: { effort: "high" } },
    },
  ])("disables summaries with effort $effort", async ({ effort, expected }) => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([sse({ type: "response.completed" })]),
    );

    await collect(
      openAiAdapter.streamChat(
        {
          ...OPENAI,
          advanced: { reasoningSummary: "off", reasoningEffort: effort },
        },
        REQUEST,
      ),
    );

    expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual(expected);
  });

  it.each([undefined, "none" as const, "high" as const])(
    "sends temperature only when effort %s allows it and warns once when skipped",
    async (reasoningEffort) => {
      const warn = vi.fn();
      providerFetch.mockResolvedValueOnce(
        streamingResponse([sse({ type: "response.completed" })]),
      );

      await collect(
        openAiAdapter.streamChat(
          {
            ...OPENAI,
            log: { warn },
            advanced: { reasoningEffort, temperature: 0 },
          },
          REQUEST,
        ),
      );

      expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
        ...RESPONSES_BODY,
        reasoning: {
          ...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {}),
          summary: "auto",
        },
        ...(reasoningEffort === "high" ? {} : { temperature: 0 }),
      });
      if (reasoningEffort === "high") {
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          `OpenAI skipped temperature for ${REQUEST.model} because reasoning effort is high; temperature requires reasoning effort none.`,
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      label: "uses a zero user limit below the request cap",
      maxOutputTokens: 0,
      maxTokens: 512,
      expected: 0,
    },
    {
      label: "uses a user limit below the request cap",
      maxOutputTokens: 128,
      maxTokens: 512,
      expected: 128,
    },
    {
      label: "caps a user limit above the request cap",
      maxOutputTokens: 1024,
      maxTokens: 512,
      expected: 512,
    },
    {
      label: "uses a user limit when the request cap is absent",
      maxOutputTokens: 1024,
      maxTokens: undefined,
      expected: 1024,
    },
  ])("$label", async ({ maxOutputTokens, maxTokens, expected }) => {
    providerFetch.mockResolvedValueOnce(
      streamingResponse([sse({ type: "response.completed" })]),
    );

    await collect(
      openAiAdapter.streamChat(
        { ...OPENAI, advanced: { maxOutputTokens } },
        maxTokens === undefined ? REQUEST : { ...REQUEST, maxTokens },
      ),
    );

    expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
      ...RESPONSES_BODY,
      reasoning: { summary: "auto" },
      max_output_tokens: expected,
    });
  });
});

describe("OpenAI advanced Responses retries", () => {
  it("preserves effort when summaries are refused and remembered", async () => {
    const warn = vi.fn();
    const detail = "reasoning.summary is unsupported";
    const config = {
      ...OPENAI,
      log: { warn },
      advanced: {
        reasoningEffort: "high" as const,
        reasoningSummary: "concise" as const,
        verbosity: "low" as const,
      },
    };
    providerFetch
      .mockResolvedValueOnce(new Response(detail, { status: 400 }))
      .mockImplementation(async () =>
        streamingResponse([sse({ type: "response.completed" })]),
      );

    await collect(openAiAdapter.streamChat(config, REQUEST));
    await collect(openAiAdapter.streamChat(config, REQUEST));

    const withoutSummary = {
      ...RESPONSES_BODY,
      reasoning: { effort: "high" },
      text: { verbosity: "low" },
    };
    expect(providerFetch).toHaveBeenCalledTimes(3);
    expect(
      providerFetch.mock.calls.map(([, options]) => JSON.parse(options.body)),
    ).toEqual([
      {
        ...withoutSummary,
        reasoning: { effort: "high", summary: "concise" },
      },
      withoutSummary,
      withoutSummary,
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `OpenAI refused reasoning summaries for ${REQUEST.model}, continuing without them (no Thinking block): ${detail}`,
    );
  });

  it("surfaces rejected reasoning effort when summaries are off", async () => {
    const warn = vi.fn();
    providerFetch.mockResolvedValueOnce(
      new Response("reasoning.effort is unsupported", { status: 400 }),
    );

    await expect(
      collect(
        openAiAdapter.streamChat(
          {
            ...OPENAI,
            log: { warn },
            advanced: { reasoningEffort: "high", reasoningSummary: "off" },
          },
          REQUEST,
        ),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: "OpenAI request failed (400): reasoning.effort is unsupported",
    });

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
      ...RESPONSES_BODY,
      reasoning: { effort: "high" },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("surfaces rejected reasoning effort without retrying or remembering a summary fallback", async () => {
    const warn = vi.fn();
    const detail = "reasoning.effort 'xhigh' is not supported";
    const config = {
      ...OPENAI,
      log: { warn },
      advanced: { reasoningEffort: "xhigh" as const },
    };
    providerFetch
      .mockResolvedValueOnce(new Response(detail, { status: 400 }))
      .mockResolvedValueOnce(
        streamingResponse([sse({ type: "response.completed" })]),
      );

    const result = collect(openAiAdapter.streamChat(config, REQUEST));

    await expect(result).rejects.toBeInstanceOf(AiProviderError);
    await expect(result).rejects.toMatchObject({
      status: 400,
      message: `OpenAI request failed (400): ${detail}`,
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();

    await collect(openAiAdapter.streamChat(config, REQUEST));

    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(providerFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses",
    ]);
    const expected = {
      ...RESPONSES_BODY,
      reasoning: { effort: "xhigh", summary: "auto" },
    };
    expect(
      providerFetch.mock.calls.map(([, options]) => JSON.parse(options.body)),
    ).toEqual([expected, expected]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([400, 422])(
    "retries a temperature %i once without changing other fields",
    async (status) => {
      const warn = vi.fn();
      const detail = "temperature is not supported";
      providerFetch
        .mockResolvedValueOnce(new Response(detail, { status }))
        .mockResolvedValueOnce(
          streamingResponse([sse({ type: "response.completed" })]),
        );

      await collect(
        openAiAdapter.streamChat(
          {
            ...OPENAI,
            log: { warn },
            advanced: {
              reasoningEffort: "none",
              reasoningSummary: "detailed",
              verbosity: "medium",
              maxOutputTokens: 256,
              temperature: 0.5,
            },
          },
          REQUEST,
        ),
      );

      const withoutTemperature = {
        ...RESPONSES_BODY,
        reasoning: { effort: "none", summary: "detailed" },
        text: { verbosity: "medium" },
        max_output_tokens: 256,
      };
      expect(providerFetch).toHaveBeenCalledTimes(2);
      expect(
        providerFetch.mock.calls.map(([, options]) => JSON.parse(options.body)),
      ).toEqual([
        { ...withoutTemperature, temperature: 0.5 },
        withoutTemperature,
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        `OpenAI refused temperature for ${REQUEST.model}, continuing without it: ${detail}`,
      );
    },
  );

  it.each([400, 422])(
    "surfaces a second temperature %i mentioning reasoning without retrying again",
    async (status) => {
      const warn = vi.fn();
      const config = {
        ...OPENAI,
        log: { warn },
        advanced: { temperature: 0.5 },
      };
      const detail = "temperature is unsupported with reasoning models";
      providerFetch.mockImplementation(
        async () => new Response(detail, { status }),
      );

      await expect(
        collect(openAiAdapter.streamChat(config, REQUEST)),
      ).rejects.toMatchObject({
        status,
        message: `OpenAI request failed (${status}): ${detail}`,
      });

      expect(providerFetch).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(providerFetch.mock.calls[1][1].body)).toEqual({
        ...RESPONSES_BODY,
        reasoning: { summary: "auto" },
      });

      providerFetch.mockResolvedValueOnce(
        streamingResponse([sse({ type: "response.completed" })]),
      );
      await collect(openAiAdapter.streamChat(config, REQUEST));

      expect(providerFetch).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(providerFetch.mock.calls[2][1].body)).toEqual({
        ...RESPONSES_BODY,
        reasoning: { summary: "auto" },
        temperature: 0.5,
      });
    },
  );

  it.each(["summary", "temperature"])(
    "handles both fallbacks when %s is refused first",
    async (first) => {
      const warn = vi.fn();
      const summaryFailure = () =>
        new Response("reasoning.summary is unsupported", { status: 400 });
      const temperatureFailure = () =>
        new Response("temperature is unsupported", { status: 422 });
      providerFetch
        .mockResolvedValueOnce(
          first === "summary" ? summaryFailure() : temperatureFailure(),
        )
        .mockResolvedValueOnce(
          first === "summary" ? temperatureFailure() : summaryFailure(),
        )
        .mockResolvedValueOnce(
          streamingResponse([sse({ type: "response.completed" })]),
        );

      await collect(
        openAiAdapter.streamChat(
          {
            ...OPENAI,
            log: { warn },
            advanced: { reasoningEffort: "none", temperature: 0.5 },
          },
          REQUEST,
        ),
      );

      const initial = {
        ...RESPONSES_BODY,
        reasoning: { effort: "none", summary: "auto" },
        temperature: 0.5,
      };
      expect(providerFetch).toHaveBeenCalledTimes(3);
      expect(
        providerFetch.mock.calls.map(([, options]) => JSON.parse(options.body)),
      ).toEqual([
        initial,
        first === "summary"
          ? {
              ...RESPONSES_BODY,
              reasoning: { effort: "none" },
              temperature: 0.5,
            }
          : { ...RESPONSES_BODY, reasoning: initial.reasoning },
        { ...RESPONSES_BODY, reasoning: { effort: "none" } },
      ]);
      expect(warn).toHaveBeenCalledTimes(2);
    },
  );
});
