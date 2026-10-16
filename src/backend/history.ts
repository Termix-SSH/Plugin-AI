import { applySummary } from "./compaction.js";
import type { ChatMessage, ToolCall } from "./providers/types.js";

export interface StoredMessage {
  role: string;
  content: string;
  toolCalls: string | null;
  reasoning?: string | null;
}

/**
 * A compaction is stored as a "summary" row, its content the summary and its
 * toolCalls how many of the messages before it stay verbatim.
 */
export function toStoredSummary(summary: string, keep: number): StoredMessage {
  return {
    role: "summary",
    content: summary,
    toolCalls: JSON.stringify({ keep }),
  };
}

function summaryKeep(raw: string | null): number {
  try {
    const keep = Number(JSON.parse(raw ?? "{}").keep);
    return Number.isInteger(keep) && keep >= 0 ? keep : 0;
  } catch {
    return 0;
  }
}

const INTERRUPTED_RESULT = JSON.stringify({
  error: "No result: the reply was interrupted before this tool finished.",
});

function parseCalls(raw: string | null): ToolCall[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A tool row keeps the call it answers in toolCalls, as a one-item list. */
export function toStoredMessage(message: ChatMessage): StoredMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      toolCalls: JSON.stringify([
        { id: message.toolCallId, name: message.toolName },
      ]),
    };
  }
  return {
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls?.length
      ? JSON.stringify(message.toolCalls)
      : null,
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
  };
}

/**
 * Rebuilds what the provider sees from the stored rows.
 *
 * Every provider rejects an assistant turn whose tool calls have no results,
 * which is what a run cut off mid-way leaves behind, so any missing result is
 * filled in as interrupted. Tool rows that answer nothing are dropped. A
 * summary row replaces what came before it, as it did when it was made.
 */
export function toChatHistory(rows: StoredMessage[]): ChatMessage[] {
  let history: ChatMessage[] = [];
  let open: ToolCall[] = [];

  const closeOpen = () => {
    for (const call of open) {
      history.push({
        role: "tool",
        content: INTERRUPTED_RESULT,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
    open = [];
  };

  for (const row of rows) {
    if (row.role === "tool") {
      const answered = parseCalls(row.toolCalls)[0];
      const index = open.findIndex((call) => call.id === answered?.id);
      if (index === -1) continue;
      const [call] = open.splice(index, 1);
      history.push({
        role: "tool",
        content: row.content,
        toolCallId: call.id,
        toolName: call.name,
      });
      continue;
    }

    closeOpen();

    if (row.role === "summary") {
      history = applySummary(history, row.content, summaryKeep(row.toolCalls));
    } else if (row.role === "assistant") {
      const calls = parseCalls(row.toolCalls);
      history.push({
        role: "assistant",
        content: row.content,
        ...(calls.length ? { toolCalls: calls } : {}),
      });
      open = [...calls];
    } else if (row.role === "user") {
      history.push({ role: "user", content: row.content });
    }
  }

  closeOpen();
  return history;
}
