import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatChunk,
  ProviderAdvanced,
} from "../../../src/backend/providers/types.js";

const providerFetch = vi.fn();

const { openAiAdapter } =
  await import("../../../src/backend/providers/openai.js");

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

const CONFIGS = [
  {
    providerType: "openai" as const,
    fetch: providerFetch,
    baseUrl: "https://proxy.example/v1",
    tokenField: "max_completion_tokens",
  },
  {
    providerType: "openai_compatible" as const,
    fetch: providerFetch,
    baseUrl: "https://proxy.example/v1",
    tokenField: "max_tokens",
  },
];

const BODY = {
  model: REQUEST.model,
  messages: [{ role: "system", content: REQUEST.system }, ...REQUEST.messages],
  stream: true,
  stream_options: { include_usage: true },
};

const RUN_TOOL = { name: "run", description: "Run a command", parameters: {} };
const TOOLS = [{ type: "function", function: RUN_TOOL }];

beforeEach(() => {
  vi.resetAllMocks();
});

describe.each(CONFIGS)(
  "openAiAdapter $providerType Chat requests",
  (config) => {
    it("maps all advanced fields within the request token limit", async () => {
      providerFetch.mockResolvedValueOnce(
        streamingResponse(["data: [DONE]\n"]),
      );

      await collect(
        openAiAdapter.streamChat(
          {
            ...config,
            advanced: {
              endpoint: "chat",
              reasoningEffort: "none",
              reasoningSummary: "detailed",
              verbosity: "high",
              maxOutputTokens: 2048,
              temperature: 0.5,
            },
          },
          { ...REQUEST, maxTokens: 512, tools: [RUN_TOOL] },
        ),
      );

      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(providerFetch.mock.calls[0][0]).toBe(
        "https://proxy.example/v1/chat/completions",
      );
      expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
        ...BODY,
        [config.tokenField]: 512,
        reasoning_effort: "none",
        verbosity: "high",
        temperature: 0.5,
        tools: TOOLS,
      });
    });

    it.each([undefined, {}, { endpoint: "auto" as const }])(
      "preserves the default body with advanced %j",
      async (advanced) => {
        providerFetch.mockResolvedValueOnce(
          streamingResponse(["data: [DONE]\n"]),
        );

        await collect(
          openAiAdapter.streamChat(
            { ...config, advanced },
            { ...REQUEST, maxTokens: 512, tools: [RUN_TOOL] },
          ),
        );

        expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
          ...BODY,
          [config.tokenField]: 512,
          tools: TOOLS,
        });
      },
    );

    it.each([undefined, 0])(
      "preserves the default body with request maxTokens %j",
      async (maxTokens) => {
        providerFetch.mockResolvedValueOnce(
          streamingResponse(["data: [DONE]\n"]),
        );

        await collect(
          openAiAdapter.streamChat(
            { ...config, advanced: {} },
            { ...REQUEST, maxTokens },
          ),
        );

        expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual(BODY);
      },
    );

    it.each([
      { maxOutputTokens: 256, maxTokens: 512, expected: 256 },
      { maxOutputTokens: 1024, maxTokens: 512, expected: 512 },
      { maxOutputTokens: 1024, maxTokens: undefined, expected: 1024 },
    ])(
      "sends maxOutputTokens $maxOutputTokens with request maxTokens $maxTokens as $expected",
      async ({ maxOutputTokens, maxTokens, expected }) => {
        providerFetch.mockResolvedValueOnce(
          streamingResponse(["data: [DONE]\n"]),
        );

        await collect(
          openAiAdapter.streamChat(
            { ...config, advanced: { maxOutputTokens } },
            maxTokens === undefined ? REQUEST : { ...REQUEST, maxTokens },
          ),
        );

        expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
          ...BODY,
          [config.tokenField]: expected,
        });
      },
    );

    it("ignores the Responses summary setting when it is off", async () => {
      providerFetch.mockResolvedValueOnce(
        streamingResponse(["data: [DONE]\n"]),
      );

      await collect(
        openAiAdapter.streamChat(
          { ...config, advanced: { reasoningSummary: "off" } },
          REQUEST,
        ),
      );

      expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual(BODY);
    });

    it.each<NonNullable<ProviderAdvanced["reasoningEffort"]>>([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])("sends the explicit effort %s", async (reasoningEffort) => {
      providerFetch.mockResolvedValueOnce(
        streamingResponse(["data: [DONE]\n"]),
      );

      await collect(
        openAiAdapter.streamChat(
          { ...config, advanced: { reasoningEffort } },
          REQUEST,
        ),
      );

      expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
        ...BODY,
        reasoning_effort: reasoningEffort,
      });
    });

    it("applies provider temperature handling with high effort across retries", async () => {
      const warn = vi.fn();
      providerFetch
        .mockResolvedValueOnce(
          new Response("stream_options unsupported", { status: 400 }),
        )
        .mockResolvedValueOnce(streamingResponse(["data: [DONE]\n"]));

      await collect(
        openAiAdapter.streamChat(
          {
            ...config,
            log: { warn },
            advanced: { reasoningEffort: "high", temperature: 0 },
          },
          REQUEST,
        ),
      );

      const { stream_options, ...withoutStreamOptions } = BODY;
      const temperature =
        config.providerType === "openai_compatible" ? { temperature: 0 } : {};
      expect(
        providerFetch.mock.calls.map(([, init]) => JSON.parse(init.body)),
      ).toEqual([
        { ...BODY, reasoning_effort: "high", ...temperature },
        { ...withoutStreamOptions, reasoning_effort: "high", ...temperature },
      ]);
      if (config.providerType === "openai") {
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          `OpenAI skipped temperature for ${REQUEST.model} because reasoning effort is high; temperature requires reasoning effort none.`,
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    });

    it.each<ProviderAdvanced>([
      { temperature: 0 },
      { temperature: 2 },
      { reasoningEffort: "none", temperature: 0.7 },
    ])("sends allowed temperature with %j", async (advanced) => {
      const warn = vi.fn();
      providerFetch.mockResolvedValueOnce(
        streamingResponse(["data: [DONE]\n"]),
      );

      await collect(
        openAiAdapter.streamChat(
          { ...config, log: { warn }, advanced },
          REQUEST,
        ),
      );

      expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
        ...BODY,
        ...(advanced.reasoningEffort
          ? { reasoning_effort: advanced.reasoningEffort }
          : {}),
        temperature: advanced.temperature,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([400, 422])(
      "retries a temperature rejection %i without changing other fields",
      async (status) => {
        const warn = vi.fn();
        const reasoningEffort =
          config.providerType === "openai" ? "none" : "high";
        const detail = "Temperature is not supported with reasoning models";
        providerFetch
          .mockResolvedValueOnce(new Response(detail, { status }))
          .mockResolvedValueOnce(streamingResponse(["data: [DONE]\n"]));

        await collect(
          openAiAdapter.streamChat(
            {
              ...config,
              log: { warn },
              advanced: {
                reasoningEffort,
                verbosity: "low",
                temperature: 0,
              },
            },
            { ...REQUEST, tools: [RUN_TOOL] },
          ),
        );

        const body = {
          ...BODY,
          reasoning_effort: reasoningEffort,
          verbosity: "low",
          tools: TOOLS,
        };
        expect(
          providerFetch.mock.calls.map(([, init]) => JSON.parse(init.body)),
        ).toEqual([{ ...body, temperature: 0 }, body]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          `OpenAI refused temperature for ${REQUEST.model}, continuing without it: ${detail}`,
        );
      },
    );

    it("retries a temperature rejection only once", async () => {
      const warn = vi.fn();
      providerFetch.mockImplementation(
        async () => new Response("temperature unsupported", { status: 400 }),
      );

      await expect(
        collect(
          openAiAdapter.streamChat(
            { ...config, log: { warn }, advanced: { temperature: 1 } },
            REQUEST,
          ),
        ),
      ).rejects.toMatchObject({
        status: 400,
        message: "OpenAI request failed (400): temperature unsupported",
      });

      expect(
        providerFetch.mock.calls.map(([, init]) => JSON.parse(init.body)),
      ).toEqual([{ ...BODY, temperature: 1 }, BODY]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it.each([400, 422, 500])(
      "surfaces temperature error %i when no retry applies",
      async (status) => {
        const warn = vi.fn();
        providerFetch.mockResolvedValueOnce(
          new Response("temperature unsupported", { status }),
        );

        await expect(
          collect(
            openAiAdapter.streamChat({ ...config, log: { warn } }, REQUEST),
          ),
        ).rejects.toMatchObject({
          status,
          message: `OpenAI request failed (${status}): temperature unsupported`,
        });

        expect(providerFetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual(BODY);
        expect(warn).not.toHaveBeenCalled();
      },
    );

    it.each(["none", "high"] as const)(
      "does not replace the user's %s effort for tools",
      async (reasoningEffort) => {
        const detail = "tools require reasoning_effort none";
        providerFetch.mockResolvedValueOnce(
          new Response(detail, { status: 400 }),
        );

        await expect(
          collect(
            openAiAdapter.streamChat(
              { ...config, advanced: { reasoningEffort } },
              { ...REQUEST, tools: [RUN_TOOL] },
            ),
          ),
        ).rejects.toMatchObject({
          status: 400,
          message: `OpenAI request failed (400): ${detail}`,
        });

        expect(providerFetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
          ...BODY,
          reasoning_effort: reasoningEffort,
          tools: TOOLS,
        });
      },
    );

    it.each([
      ["stream_options", "tools require reasoning_effort none", "temperature"],
      ["temperature", "stream_options", "tools require reasoning_effort none"],
      ["tools require reasoning_effort none", "temperature", "stream_options"],
    ])("allows all three fallbacks in order %j", async (...details) => {
      const warn = vi.fn();
      for (const detail of details) {
        providerFetch.mockResolvedValueOnce(
          new Response(detail, { status: 400 }),
        );
      }
      providerFetch.mockResolvedValueOnce(
        streamingResponse([
          sse({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          }),
        ]),
      );

      const chunks = await collect(
        openAiAdapter.streamChat(
          { ...config, log: { warn }, advanced: { temperature: 1 } },
          { ...REQUEST, tools: [RUN_TOOL] },
        ),
      );

      let body: Record<string, unknown> = {
        ...BODY,
        temperature: 1,
        tools: TOOLS,
      };
      const bodies = [body];
      for (const detail of details) {
        if (detail === "stream_options") {
          const { stream_options, ...rest } = body;
          body = rest;
        } else if (detail === "temperature") {
          const { temperature, ...rest } = body;
          body = rest;
        } else {
          body = { ...body, reasoning_effort: "none" };
        }
        bodies.push(body);
      }
      expect(
        providerFetch.mock.calls.map(([, init]) => JSON.parse(init.body)),
      ).toEqual(bodies);
      expect(chunks).toEqual([
        { type: "text", text: "ok" },
        { type: "done", stopReason: "stop" },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  },
);

it("sends temperature with high effort for a compatible provider without warning", async () => {
  const warn = vi.fn();
  providerFetch.mockResolvedValueOnce(streamingResponse(["data: [DONE]\n"]));

  await collect(
    openAiAdapter.streamChat(
      {
        ...CONFIGS[1],
        log: { warn },
        advanced: { reasoningEffort: "high", temperature: 0.7 },
      },
      REQUEST,
    ),
  );

  expect(providerFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual({
    ...BODY,
    reasoning_effort: "high",
    temperature: 0.7,
  });
  expect(warn).not.toHaveBeenCalled();
});

it("forces Chat Completions at the official OpenAI base", async () => {
  providerFetch.mockResolvedValueOnce(streamingResponse(["data: [DONE]\n"]));

  await collect(
    openAiAdapter.streamChat(
      {
        fetch: providerFetch,
        providerType: "openai",
        advanced: { endpoint: "chat" },
      },
      REQUEST,
    ),
  );

  expect(providerFetch).toHaveBeenCalledTimes(1);
  expect(providerFetch.mock.calls[0][0]).toBe(
    "https://api.openai.com/v1/chat/completions",
  );
  expect(JSON.parse(providerFetch.mock.calls[0][1].body)).toEqual(BODY);
});
