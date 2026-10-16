import type { ChatMessage } from "./providers/types.js";

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

export function defaultContextWindow(model: string | null | undefined) {
  const match = KNOWN_WINDOWS.find(([pattern]) => pattern.test(model ?? ""));
  return match ? match[1] : DEFAULT_CONTEXT_WINDOW;
}

/** The provider's own setting when it has one, else the model's family. */
export function contextWindowFor(
  provider: { contextWindow?: number | null },
  model: string,
): number {
  return provider.contextWindow && provider.contextWindow > 0
    ? provider.contextWindow
    : defaultContextWindow(model);
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
