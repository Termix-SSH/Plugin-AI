import { estimateMessage, headTail } from "./context-window.js";
import type { ChatMessage } from "./providers/types.js";

/**
 * Summarising the earlier part of a conversation once it no longer fits.
 *
 * The summary replaces everything before a cut, as one user message. The cut
 * only ever falls before a user or assistant message, so an assistant's tool
 * calls always keep their results, and the latest user message is kept word
 * for word even when the cut falls after it.
 */

export const SUMMARY_PREFIX =
  "[Summary of the earlier conversation, compacted to save context]\n";

export const SUMMARY_SYSTEM = [
  "You compress the earlier part of a conversation between a user and the Termix assistant, which manages servers, hosts and settings with tools.",
  "Write a summary the assistant can continue from without the original messages. Keep:",
  "- what the user asked for and any constraints or preferences they gave,",
  "- facts that were found: host names and ids, settings, values, command output that matters, errors,",
  "- what has been done or changed so far, and what is still left to do.",
  "Be concise and concrete, use short bullet points, keep ids and exact values, and do not invent anything.",
].join("\n");

/** How much of each tool result the summariser sees, in characters. */
const TOOL_RESULT_FOR_SUMMARY = 2_000;

export function isSummary(message: ChatMessage): boolean {
  return message.role === "user" && message.content.startsWith(SUMMARY_PREFIX);
}

export function summaryMessage(summary: string): ChatMessage {
  return { role: "user", content: `${SUMMARY_PREFIX}${summary.trim()}` };
}

/**
 * Where the verbatim tail starts: whole steps from the end while they fit in
 * `budget` tokens, always at least the last one.
 */
export function findCut(messages: ChatMessage[], budget: number): number {
  let cut = messages.length;
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    used += estimateMessage(messages[i]);
    // A tool result belongs to the assistant turn before it.
    if (messages[i].role === "tool") continue;
    if (used > budget && cut < messages.length) break;
    cut = i;
  }
  return cut;
}

function latestUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user" && !isSummary(messages[i])) return i;
  }
  return -1;
}

/**
 * The history once `summary` stands in for everything before `messages`
 * minus its last `keep`.
 */
export function applySummary(
  messages: ChatMessage[],
  summary: string,
  keep: number,
): ChatMessage[] {
  const cut = Math.max(0, messages.length - keep);
  const user = latestUserIndex(messages);
  return [
    summaryMessage(summary),
    ...(user !== -1 && user < cut ? [messages[user]] : []),
    ...messages.slice(cut),
  ];
}

function renderMessage(message: ChatMessage): string {
  if (isSummary(message)) {
    return `Earlier summary:\n${message.content.slice(SUMMARY_PREFIX.length)}`;
  }
  if (message.role === "tool") {
    const result = headTail(
      message.content,
      TOOL_RESULT_FOR_SUMMARY / 2,
      TOOL_RESULT_FOR_SUMMARY / 2,
    );
    return `Result of ${message.toolName ?? "tool"}: ${result}`;
  }
  const calls = (message.toolCalls ?? []).map(
    (call) =>
      `Assistant called ${call.name} with ${JSON.stringify(call.arguments)}`,
  );
  const speaker = message.role === "user" ? "User" : "Assistant";
  return [message.content ? `${speaker}: ${message.content}` : "", ...calls]
    .filter(Boolean)
    .join("\n");
}

/**
 * The part to summarise, as plain text, at most about `limit` characters.
 * What the user said and an earlier summary always go in; when the rest does
 * not fit, the oldest of the assistant's steps are left out first.
 */
export function renderTranscript(
  messages: ChatMessage[],
  limit: number,
): string {
  const lines = messages.map((message) => ({
    text: renderMessage(message),
    kept: message.role === "user",
  }));
  let size = lines.reduce((sum, line) => sum + line.text.length + 2, 0);
  let omitted = 0;
  for (const line of lines) {
    if (size <= limit) break;
    if (line.kept || !line.text) continue;
    size -= line.text.length + 2;
    line.text = "";
    omitted += 1;
  }
  const text = lines
    .map((line) => line.text)
    .filter(Boolean)
    .join("\n\n");
  return omitted ? `[${omitted} earlier steps left out]\n\n${text}` : text;
}
