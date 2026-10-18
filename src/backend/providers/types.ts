/**
 * The shape every provider adapter normalizes to. Adding a provider means
 * translating its wire format into these events; nothing downstream (the
 * engine, the tool dispatcher, the SSE route) knows which vendor is in use.
 */

export type AiProviderType =
  "ollama" | "anthropic" | "openai" | "gemini" | "openai_compatible";

const AI_PROVIDER_TYPES: AiProviderType[] = [
  "ollama",
  "anthropic",
  "openai",
  "gemini",
  "openai_compatible",
];

export function isAiProviderType(value: unknown): value is AiProviderType {
  return (
    typeof value === "string" && (AI_PROVIDER_TYPES as string[]).includes(value)
  );
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** Set on tool turns, matching the id of the call being answered. */
  toolCallId?: string;
  toolName?: string;
  /** What the model thought before answering, shown apart from the answer. */
  reasoning?: string;
  /**
   * Provider state for the reasoning that must be echoed back within the same
   * run: Anthropic rejects a tool result whose turn lost its signed thinking
   * blocks. Never stored, so it only lives as long as the run.
   */
  reasoningState?: unknown[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Opaque provider state that has to be echoed back verbatim on the next
   * turn. Gemini 2.5+ rejects a follow-up whose functionCall parts have lost
   * their thoughtSignature, so this rides along rather than being dropped.
   */
  providerSignature?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** The window the conversation is sized for; Ollama loads the model with it. */
  contextWindow?: number;
  /** The most tokens the reply may hold, thinking included. */
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Tokens one model call used, as the provider reported them. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export type ChatChunk =
  | { type: "text"; text: string }
  /** Thinking, kept apart from the answer. */
  | { type: "reasoning"; text: string }
  /** Opaque reasoning blocks to echo back on the next call of the run. */
  | { type: "reasoning_state"; blocks: unknown[] }
  | { type: "usage"; usage: TokenUsage }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; stopReason?: string }
  | { type: "error"; message: string };

/**
 * How an adapter reaches its provider. Always the egress-checked fetch from
 * http.ts, never the global one.
 */
export type ProviderFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface ProviderConfig {
  providerType: AiProviderType;
  baseUrl?: string | null;
  apiKey?: string | null;
  fetch: ProviderFetch;
}

/** What a provider says about one of its models; what it leaves out is unknown. */
export interface ModelInfo {
  /** Tokens one request may hold as served, e.g. vLLM's max_model_len. */
  contextWindow?: number;
  /**
   * The most the model can take at all, when that is more than it is served
   * with: Ollama's trained context length against its num_ctx.
   */
  contextLimit?: number;
  maxOutputTokens?: number;
}

export interface ProviderAdapter {
  /** Streams a single assistant turn. Tool execution happens in the engine. */
  streamChat(
    config: ProviderConfig,
    request: ChatRequest,
  ): AsyncIterable<ChatChunk>;
  /** Model ids to offer in the picker, best effort. */
  listModels(config: ProviderConfig): Promise<string[]>;
  /** The model's limits as the provider reports them, best effort. */
  describeModel(config: ProviderConfig, model: string): Promise<ModelInfo>;
  /** Output tokens the adapter asks for on every call, when it sets a limit. */
  maxTokens?: number;
  /** The share of the budget a prompt may take before compaction, if not 80%. */
  compactAt?: number;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}
