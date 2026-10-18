import type { AiProposal } from "./ai-api";
import {
  withProgress,
  withResult,
  type HostProgress,
  type StreamState,
  type ToolActivity,
} from "./use-ai-stream";

/** A finished part of the conversation, kept after the stream resets. */
export type HistoryEntry =
  | { kind: "message"; role: "user" | "assistant"; content: string }
  | { kind: "tool"; tool: ToolActivity };

/** One entry in the rendered conversation, in the order it happened. */
export type TimelineItem =
  | {
      kind: "message";
      key: string;
      role: "user" | "assistant";
      content: string;
    }
  /** live is false for a past run's step, which can never still be running. */
  | { kind: "tool"; key: string; tool: ToolActivity; live: boolean }
  | { kind: "proposal"; key: string; proposal: AiProposal };

export function userEntry(content: string): HistoryEntry {
  return { kind: "message", role: "user", content };
}

/**
 * What a finished run leaves in the transcript: its tool steps, then its
 * reply. Tool ids are only unique within one run, so they get a run prefix.
 */
export function finishedRunEntries(
  runId: number,
  tools: ToolActivity[],
  reply: string,
): HistoryEntry[] {
  const entries: HistoryEntry[] = tools.map((tool) => ({
    kind: "tool",
    tool: { ...tool, id: `run-${runId}-${tool.id}` },
  }));
  if (reply)
    entries.push({ kind: "message", role: "assistant", content: reply });
  return entries;
}

/** Past runs, then the run in progress, then its proposals. */
export function buildTimeline(
  history: HistoryEntry[],
  state: Pick<StreamState, "tools" | "assistantText">,
  proposals: AiProposal[],
): TimelineItem[] {
  const timeline: TimelineItem[] = history.map((entry, index) =>
    entry.kind === "tool"
      ? { kind: "tool", key: entry.tool.id, tool: entry.tool, live: false }
      : {
          kind: "message",
          key: `history-${index}`,
          role: entry.role,
          content: entry.content,
        },
  );

  for (const tool of state.tools) {
    timeline.push({ kind: "tool", key: tool.id, tool, live: true });
  }

  if (state.assistantText) {
    timeline.push({
      kind: "message",
      key: "streaming",
      role: "assistant",
      content: state.assistantText,
    });
  }

  for (const proposal of proposals) {
    timeline.push({
      kind: "proposal",
      key: `proposal-${proposal.id}`,
      proposal,
    });
  }

  return timeline;
}

interface StoredRow {
  id: number;
  role: string;
  content: string;
  toolCalls: string | null;
  reasoning?: string | null;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Per-host rows for a run card, from a run_command or get_host_facts result. */
function progressFrom(result: unknown): HostProgress[] | undefined {
  const hosts = (result as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(hosts)) return undefined;
  return hosts.map((host) => ({
    hostId: host.id,
    name: host.name,
    exitCode: host.exitCode ?? (host.error ? null : 0),
    output: host.output ?? host.facts ?? "",
    error: host.output || host.facts ? undefined : host.error,
    durationMs: 0,
    cached: host.facts !== undefined,
  }));
}

/**
 * The assistant's transcript adds what the terminal panel does not show: the
 * model's thinking, kept apart from its answer, and where the conversation
 * was compacted.
 */
export type AssistantEntry =
  HistoryEntry | { kind: "thinking"; content: string } | { kind: "compacted" };

export type AssistantItem =
  | Exclude<TimelineItem, { kind: "proposal" }>
  | { kind: "thinking"; key: string; content: string; live: boolean }
  | { kind: "compacted"; key: string };

/** A stream frame the transcript reacts to. */
export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; arguments?: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "tool_progress"; name: string; host: HostProgress }
  | { type: "compacted" };

/**
 * Adds one frame to a run's entries, in the order it arrived: text and
 * thinking extend the entry before them when it is of the same kind, and
 * start a new one after a tool call, so the run reads text, tool, text, tool.
 */
export function applyStreamEvent(
  entries: AssistantEntry[],
  event: StreamEvent,
  toolId: () => string,
): AssistantEntry[] {
  const last = entries.at(-1);
  const before = entries.slice(0, -1);

  switch (event.type) {
    case "token":
      return last?.kind === "message" && last.role === "assistant"
        ? [...before, { ...last, content: last.content + event.text }]
        : [
            ...entries,
            { kind: "message", role: "assistant", content: event.text },
          ];
    case "reasoning":
      return last?.kind === "thinking"
        ? [...before, { ...last, content: last.content + event.text }]
        : [...entries, { kind: "thinking", content: event.text }];
    case "tool_call":
      return [
        ...entries,
        {
          kind: "tool",
          tool: {
            id: toolId(),
            name: event.name,
            arguments: event.arguments ?? {},
          },
        },
      ];
    case "tool_result":
    case "tool_progress": {
      const tools = entries.flatMap((entry) =>
        entry.kind === "tool" ? [entry.tool] : [],
      );
      const updated =
        event.type === "tool_result"
          ? withResult(tools, event.name, event.result)
          : withProgress(tools, event.name, event.host);
      let index = 0;
      return entries.map((entry) =>
        entry.kind === "tool" ? { ...entry, tool: updated[index++] } : entry,
      );
    }
    case "compacted":
      return [...entries, { kind: "compacted" }];
  }
}

/** Past entries, then the run in progress, whose tools may still be running. */
export function assistantTimeline(
  history: AssistantEntry[],
  live: AssistantEntry[],
): AssistantItem[] {
  const item = (
    entry: AssistantEntry,
    key: string,
    isLive: boolean,
  ): AssistantItem => {
    switch (entry.kind) {
      case "tool":
        return {
          kind: "tool",
          key: entry.tool.id,
          tool: entry.tool,
          live: isLive,
        };
      case "thinking":
        return { kind: "thinking", key, content: entry.content, live: isLive };
      case "compacted":
        return { kind: "compacted", key };
      default:
        return {
          kind: "message",
          key,
          role: entry.role,
          content: entry.content,
        };
    }
  };
  return [
    ...history.map((entry, index) => item(entry, `history-${index}`, false)),
    ...live.map((entry, index) => item(entry, `live-${index}`, true)),
  ];
}

/**
 * A stored conversation as the transcript shows it, in the order it
 * happened: what the user said, then for each assistant turn its thinking,
 * its text and its tool calls with their results, and where it was compacted.
 */
export function storedHistory(rows: StoredRow[]): AssistantEntry[] {
  const entries: AssistantEntry[] = [];
  const open = new Map<string, number>();

  for (const row of rows) {
    const calls = parseJson(row.toolCalls);
    const list = Array.isArray(calls)
      ? (calls as Array<{ id: string; name: string; arguments?: unknown }>)
      : [];

    if (row.role === "tool") {
      const index = open.get(list[0]?.id);
      if (index === undefined) continue;
      const entry = entries[index] as Extract<HistoryEntry, { kind: "tool" }>;
      const result = parseJson(row.content);
      const progress = progressFrom(result);
      entries[index] = {
        kind: "tool",
        tool: { ...entry.tool, result, ...(progress ? { progress } : {}) },
      };
      continue;
    }

    if (row.role === "summary") {
      entries.push({ kind: "compacted" });
      continue;
    }
    if (row.reasoning) {
      entries.push({ kind: "thinking", content: row.reasoning });
    }
    if (row.content) {
      entries.push({
        kind: "message",
        role: row.role === "user" ? "user" : "assistant",
        content: row.content,
      });
    }
    for (const call of list) {
      open.set(call.id, entries.length);
      entries.push({
        kind: "tool",
        tool: {
          id: `stored-${row.id}-${call.id}`,
          name: call.name,
          arguments: (call.arguments as Record<string, unknown>) ?? {},
        },
      });
    }
  }
  return entries;
}
