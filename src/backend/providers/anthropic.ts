import Anthropic from "@anthropic-ai/sdk";
import { firstCount } from "./http.js";
import type {
  ChatChunk,
  ChatRequest,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig,
} from "./types.js";
import { AiProviderError } from "./types.js";

/**
 * Model ids offered in the picker. Users can type any other id; this is a
 * convenience list, not a restriction.
 */
const ANTHROPIC_MODELS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
];

/** Output tokens asked for on every call. */
const MAX_TOKENS = 16000;

/**
 * A prompt cache breakpoint: the request up to here is cached for a few
 * minutes, so the next call of a long run reads it back instead of paying
 * for it again.
 */
const EPHEMERAL = { type: "ephemeral" } as const;

function createClient(config: ProviderConfig): Anthropic {
  if (!config.apiKey) {
    throw new AiProviderError("This provider needs an API key");
  }
  return new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl?.trim() ? { baseURL: config.baseUrl.trim() } : {}),
    // Routes the SDK's HTTP through the shared egress guard.
    fetch: config.fetch as unknown as typeof fetch,
  });
}

function toAnthropicMessages(request: ChatRequest): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  for (const message of request.messages) {
    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "",
            content: message.content,
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      // The run's signed thinking goes back first, or the API refuses the
      // tool results that follow.
      const content: Anthropic.ContentBlockParam[] = [
        ...((message.reasoningState ?? []) as Anthropic.ContentBlockParam[]),
      ];
      if (message.content)
        content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      messages.push({ role: "assistant", content });
      continue;
    }

    if (message.role === "system") continue;
    messages.push({ role: message.role, content: message.content });
  }

  return messages;
}

/**
 * The newest message gets a cache breakpoint: the history only grows, so
 * everything up to it is the next call's prefix.
 */
function withCacheBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const last = messages.at(-1);
  if (!last) return messages;
  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : [...last.content];
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: EPHEMERAL,
  } as Anthropic.ContentBlockParam;
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

/**
 * The SDK throws its own typed errors rather than going through assertOk, so
 * they are translated here to match what every other provider reports.
 */
function translateSdkError(error: unknown): never {
  const status =
    typeof (error as { status?: unknown })?.status === "number"
      ? (error as { status: number }).status
      : undefined;
  const detail = error instanceof Error ? error.message : String(error);

  if (status === 429) {
    throw new AiProviderError(
      `Anthropic rate limit reached. Wait a moment and try again, or check your plan's quota. (${detail})`,
      429,
    );
  }
  if (status === 401 || status === 403) {
    throw new AiProviderError(
      `Anthropic rejected the API key. Check that it is correct and still active. (${detail})`,
      status,
    );
  }
  throw new AiProviderError(
    status ? `Anthropic request failed (${status}): ${detail}` : detail,
    status,
  );
}

export const anthropicAdapter: ProviderAdapter = {
  async *streamChat(
    config: ProviderConfig,
    request: ChatRequest,
  ): AsyncIterable<ChatChunk> {
    const client = createClient(config);

    const stream = client.messages.stream(
      {
        model: request.model,
        max_tokens: Math.min(request.maxTokens ?? MAX_TOKENS, MAX_TOKENS),
        // Tools, then the system prompt, then the history: each breakpoint
        // caches everything before it.
        system: [
          { type: "text", text: request.system, cache_control: EPHEMERAL },
        ],
        messages: withCacheBreakpoint(toAnthropicMessages(request)),
        thinking: { type: "adaptive" },
        ...(request.tools.length
          ? {
              tools: request.tools.map((tool, index, all) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters as Anthropic.Tool.InputSchema,
                ...(index === all.length - 1
                  ? { cache_control: EPHEMERAL }
                  : {}),
              })),
            }
          : {}),
      },
      // A request option, not a body field: the API rejects unknown fields.
      request.signal ? { signal: request.signal } : undefined,
    );

    let final: Anthropic.Message;
    try {
      for await (const event of stream) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        } else if (
          event.delta.type === "thinking_delta" &&
          event.delta.thinking
        ) {
          yield { type: "reasoning", text: event.delta.thinking };
        }
      }
      final = await stream.finalMessage();
    } catch (error) {
      translateSdkError(error);
    }

    for (const block of final.content) {
      if (block.type === "tool_use") {
        yield {
          type: "tool_call",
          call: {
            id: block.id,
            name: block.name,
            arguments: (block.input ?? {}) as Record<string, unknown>,
          },
        };
      }
    }

    const thinking = final.content.filter(
      (block) =>
        block.type === "thinking" || block.type === "redacted_thinking",
    );
    if (thinking.length) yield { type: "reasoning_state", blocks: thinking };

    // Cached input is still input the context window holds.
    const usage = final.usage;
    yield {
      type: "usage",
      usage: {
        promptTokens:
          (usage?.input_tokens ?? 0) +
          (usage?.cache_read_input_tokens ?? 0) +
          (usage?.cache_creation_input_tokens ?? 0),
        completionTokens: usage?.output_tokens ?? 0,
      },
    };

    yield { type: "done", stopReason: final.stop_reason ?? undefined };
  },

  async listModels(): Promise<string[]> {
    return [...ANTHROPIC_MODELS];
  },

  /** Null limits, or a proxy without the models API, fall back to the table. */
  async describeModel(
    config: ProviderConfig,
    model: string,
  ): Promise<ModelInfo> {
    const info = await createClient(config).models.retrieve(model, null, {
      maxRetries: 0,
    });
    return {
      contextWindow: firstCount(info.max_input_tokens),
      maxOutputTokens: firstCount(info.max_tokens),
    };
  },

  maxTokens: MAX_TOKENS,
  // Compacting rewrites the history and so loses the cache; wait longer.
  compactAt: 0.85,
};
