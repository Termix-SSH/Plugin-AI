import type {
  ChatMessage,
  ModelInfo,
  ProviderAdapter,
} from "./providers/types.js";

/**
 * How much of a model's context a conversation takes, and the cheap ways of
 * making it take less. Providers report real token counts after a call; before
 * one, and for a provider that reports nothing, the count is estimated from
 * the characters at about four per token.
 */

/** The largest tool result fed back to the model, in characters. */
export const TOOL_RESULT_LIMIT = 12_000;

/** Tool results this recent are never shrunk, however full the context is. */
export const KEEP_TOOL_RESULTS = 4;

/** What an older tool result shrinks to, in characters. */
const SHRUNK_HEAD = 600;
const SHRUNK_TAIL = 300;

/** The window for a model nobody told us about. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** First match wins, so the more specific prefixes come first. */
const KNOWN_WINDOWS: Array<[RegExp, number]> = [
  [/claude/i, 200_000],
  [/gpt-4\.1/i, 1_000_000],
  // OpenAI's model pages: the chat snapshots hold 128k, the small 5.4 and
  // cyber models 400k, GPT-5.4 and later and every GPT-6 1.05M.
  [/gpt-5(\.\d+)?-chat/i, 128_000],
  [/gpt-5\.4-(mini|nano)|gpt-5\.6-cyber/i, 400_000],
  [/gpt-5\.([4-9]|\d{2,})|gpt-6/i, 1_050_000],
  [/gpt-5/i, 400_000],
  [/gpt-4o|gpt-4-turbo/i, 128_000],
  [/\bo[134](-|$)/i, 200_000],
  [/gemini-(1\.5|2|3)/i, 1_000_000],
  [/glm-4\.[67]|glm-5/i, 200_000],
  [/glm/i, 128_000],
  [/deepseek/i, 128_000],
  [/qwen3/i, 128_000],
  [/qwen2\.5|mistral|mixtral/i, 32_768],
  [/llama-?3\.[123]/i, 128_000],
  [/phi-?4/i, 16_384],
  [/gemma-?2/i, 8_192],
  [/gemma-?3/i, 128_000],
];

/** The window the model's family usually has, or null for a stranger. */
export function knownContextWindow(model: string | null | undefined) {
  const match = KNOWN_WINDOWS.find(([pattern]) => pattern.test(model ?? ""));
  return match ? match[1] : null;
}

export function defaultContextWindow(model: string | null | undefined) {
  return knownContextWindow(model) ?? DEFAULT_CONTEXT_WINDOW;
}

/** Compaction starts once the prompt would take this share of the budget. */
export const COMPACT_AT = 0.8;

/** Kept free for the reply when neither provider nor adapter says how much. */
export const DEFAULT_RESERVED_OUTPUT = 8_192;

/** The reply never takes more than this share of the window. */
const MAX_RESERVED_SHARE = 0.25;

/** Kept free besides the reply, for estimates that come in short. */
const SAFETY_MARGIN = 0.02;

/** Where a window came from, best first. */
export type WindowSource = "override" | "provider" | "guess" | "default";

/** Per-model settings of a provider, keyed by model id. */
export type ModelOverrides = Record<string, { contextWindow?: number }>;

export interface ContextPlan {
  contextWindow: number;
  source: WindowSource;
  /** Tokens kept free for the reply. */
  reservedOutput: number;
  /** What a prompt may take: the window less the reply and a margin. */
  budget: number;
  /** The share of the budget a prompt reaches before compaction. */
  compactAt: number;
}

/**
 * The window a conversation is sized for: the user's override, else what
 * the provider reports, else the model family's, else 128k. An override is
 * still held to what the model can take at all.
 */
export function planContext(input: {
  model: string;
  overrides: ModelOverrides;
  info: ModelInfo;
  adapter: Pick<ProviderAdapter, "maxTokens" | "compactAt">;
}): ContextPlan {
  const { info, adapter } = input;
  const override = input.overrides[input.model]?.contextWindow;
  const limit = info.contextLimit ?? info.contextWindow ?? Infinity;
  const candidates: Array<[number | null | undefined, WindowSource]> = [
    [override && Math.min(override, limit), "override"],
    [info.contextWindow, "provider"],
    [knownContextWindow(input.model), "guess"],
    [DEFAULT_CONTEXT_WINDOW, "default"],
  ];
  const [contextWindow, source] = candidates.find(([tokens]) => tokens) as [
    number,
    WindowSource,
  ];
  // The reply can be no longer than either side allows.
  const asked = [info.maxOutputTokens, adapter.maxTokens].filter(
    (tokens): tokens is number => !!tokens,
  );
  const reservedOutput = Math.min(
    asked.length ? Math.min(...asked) : DEFAULT_RESERVED_OUTPUT,
    Math.floor(contextWindow * MAX_RESERVED_SHARE),
  );
  return {
    contextWindow,
    source,
    reservedOutput,
    budget: Math.floor(
      contextWindow - reservedOutput - contextWindow * SAFETY_MARGIN,
    ),
    compactAt: adapter.compactAt ?? COMPACT_AT,
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessage(message: ChatMessage): number {
  // A few tokens of framing per message, whatever the provider.
  return (
    4 +
    estimateTokens(message.content) +
    (message.toolCalls?.length
      ? estimateTokens(JSON.stringify(message.toolCalls))
      : 0)
  );
}

export function estimateRequest(request: {
  system: string;
  messages: ChatMessage[];
  tools: unknown[];
}): number {
  return (
    estimateTokens(request.system) +
    estimateTokens(JSON.stringify(request.tools)) +
    request.messages.reduce((sum, message) => sum + estimateMessage(message), 0)
  );
}

/** The start and end of `text`, with how much was cut from between them. */
export function headTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n[trimmed ${cut} chars]\n${text.slice(-tail)}`;
}

/** A tool result no larger than TOOL_RESULT_LIMIT. */
export function capToolResult(content: string): string {
  const half = TOOL_RESULT_LIMIT / 2;
  return headTail(content, half, half);
}

/**
 * The first step of making room: every tool result but the last few cut down
 * to its head and tail. A new list; the messages themselves are not touched.
 */
export function shrinkOldToolResults(
  messages: ChatMessage[],
  keep = KEEP_TOOL_RESULTS,
): ChatMessage[] {
  let seen = 0;
  const shrunk = [...messages];
  for (let i = shrunk.length - 1; i >= 0; i -= 1) {
    if (shrunk[i].role !== "tool") continue;
    seen += 1;
    if (seen <= keep) continue;
    const content = headTail(shrunk[i].content, SHRUNK_HEAD, SHRUNK_TAIL);
    if (content !== shrunk[i].content) shrunk[i] = { ...shrunk[i], content };
  }
  return shrunk;
}
