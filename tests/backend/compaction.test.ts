import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatChunk,
  ChatMessage,
} from "../../src/backend/providers/types.js";
import {
  applySummary,
  findCut,
  isSummary,
  renderTranscript,
  SUMMARY_PREFIX,
  SUMMARY_SYSTEM,
} from "../../src/backend/compaction.js";
import {
  capToolResult,
  defaultContextWindow,
  estimateRequest,
  shrinkOldToolResults,
  TOOL_RESULT_LIMIT,
} from "../../src/backend/context-window.js";
import {
  toChatHistory,
  toStoredSummary,
  type StoredMessage,
} from "../../src/backend/history.js";

const streamChat = vi.fn();
const handler = vi.fn();

vi.mock("../../src/backend/providers/registry.js", () => ({
  getAdapter: () => ({ streamChat, listModels: async () => [] }),
}));

const { runAgent } = await import("../../src/backend/engine.js");
const { toolDefinitions } = await import("../../src/backend/tools/catalog.js");

function chunks(...values: ChatChunk[]) {
  return (async function* () {
    for (const value of values) yield value;
  })();
}

const BASE = {
  config: { providerType: "ollama" as const, fetch: vi.fn() },
  model: "test",
  system: "system",
  context: {
    userId: "user-1",
    conversationId: 1,
    allowReadOnlyCommands: false,
    deps: {} as never,
  },
  tools: [
    {
      name: "list_hosts",
      description: "List hosts",
      category: "read" as const,
      parameters: { type: "object", properties: {} },
      handler,
    },
  ],
};

async function run(options: Record<string, unknown>) {
  const events: any[] = [];
  for await (const event of runAgent({ ...BASE, history: [], ...options })) {
    events.push(event);
  }
  return events;
}

/** A user message, then `steps` tool calls each with a large result. */
function longRun(steps: number, size: number): ChatMessage[] {
  const history: ChatMessage[] = [{ role: "user", content: "restore hosts" }];
  for (let i = 0; i < steps; i += 1) {
    history.push(
      {
        role: "assistant",
        content: `step ${i}`,
        toolCalls: [{ id: `c${i}`, name: "list_hosts", arguments: { i } }],
      },
      {
        role: "tool",
        content: `${i}:${"x".repeat(size)}`,
        toolCallId: `c${i}`,
        toolName: "list_hosts",
      },
    );
  }
  return history;
}

/** Every tool message answers a call made earlier in the same list. */
function pairsIntact(messages: ChatMessage[]): boolean {
  const open = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) open.add(call.id);
    if (message.role === "tool" && !open.delete(message.toolCallId!)) {
      return false;
    }
  }
  return true;
}

beforeEach(() => vi.clearAllMocks());

describe("tool results fed back to the model", () => {
  it("caps a single large result to its head and tail", async () => {
    handler.mockResolvedValue({ data: `start${"y".repeat(20_000)}end` });
    streamChat
      .mockReturnValueOnce(
        chunks({
          type: "tool_call",
          call: { id: "c1", name: "list_hosts", arguments: {} },
        }),
      )
      .mockReturnValueOnce(chunks({ type: "text", text: "ok" }));

    const events = await run({});

    const stored = events.find(
      (e) => e.type === "message" && e.message.role === "tool",
    ).message.content as string;
    expect(stored.length).toBeLessThan(TOOL_RESULT_LIMIT + 50);
    expect(stored).toMatch(/^\{"data":"start/);
    expect(stored).toMatch(/end"\}$/);
    expect(stored).toContain("[trimmed");
    // The browser still gets the whole result to show.
    const shown = events.find((e) => e.type === "tool_result").result.data;
    expect(shown.length).toBe(20_008);
  });

  it("caps an oversized result already in the history", () => {
    expect(capToolResult("z".repeat(18_000)).length).toBeLessThan(12_050);
    expect(capToolResult("short")).toBe("short");
  });
});

describe("usage", () => {
  it("reports what the provider counted", async () => {
    const onUsage = vi.fn();
    streamChat.mockReturnValueOnce(
      chunks(
        { type: "text", text: "hi" },
        { type: "usage", usage: { promptTokens: 900, completionTokens: 3 } },
      ),
    );

    const events = await run({ onUsage, contextWindow: 128_000 });

    expect(onUsage).toHaveBeenCalledWith({
      source: "assistant",
      promptTokens: 900,
      completionTokens: 3,
      estimated: false,
    });
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      usage: { promptTokens: 900 },
      contextWindow: 128_000,
    });
  });

  it("estimates what the provider did not count", async () => {
    const onUsage = vi.fn();
    streamChat.mockReturnValueOnce(
      chunks({ type: "text", text: "x".repeat(400) }),
    );

    await run({
      onUsage,
      source: "terminal",
      history: [{ role: "user", content: "y".repeat(4000) }],
    });

    const usage = onUsage.mock.calls[0][0];
    expect(usage).toMatchObject({ source: "terminal", estimated: true });
    expect(usage.promptTokens).toBeGreaterThanOrEqual(1000);
    expect(usage.completionTokens).toBe(100);
  });

  it("keeps a failing counter from failing the run", async () => {
    streamChat.mockReturnValueOnce(chunks({ type: "text", text: "hi" }));
    const events = await run({
      onUsage: () => Promise.reject(new Error("db down")),
    });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});

describe("reasoning", () => {
  it("keeps thinking apart and echoes its state back only within the run", async () => {
    handler.mockResolvedValue({ ok: true });
    streamChat
      .mockReturnValueOnce(
        chunks(
          { type: "reasoning", text: "need hosts" },
          { type: "reasoning_state", blocks: [{ signed: true }] },
          {
            type: "tool_call",
            call: { id: "c1", name: "list_hosts", arguments: {} },
          },
        ),
      )
      .mockReturnValueOnce(chunks({ type: "text", text: "two" }));

    const events = await run({});

    expect(events[0]).toEqual({ type: "reasoning", text: "need hosts" });
    const stored = events.find((e) => e.type === "message").message;
    expect(stored).toMatchObject({ reasoning: "need hosts", content: "" });
    expect(stored).not.toHaveProperty("reasoningState");
    const sent = streamChat.mock.calls[1][1].messages[0];
    expect(sent.reasoningState).toEqual([{ signed: true }]);
  });
});

describe("automatic compaction", () => {
  it("shrinks old tool results first and keeps the last few whole", async () => {
    streamChat.mockReturnValueOnce(chunks({ type: "text", text: "done" }));
    const history = longRun(6, 3000);

    const events = await run({ history, contextWindow: 5000 });

    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "compacted")).toBe(false);
    const sent: ChatMessage[] = streamChat.mock.calls[0][1].messages;
    const tools = sent.filter((m) => m.role === "tool");
    expect(tools.slice(0, 2).every((m) => m.content.includes("[trimmed"))).toBe(
      true,
    );
    expect(tools.slice(2).every((m) => !m.content.includes("[trimmed"))).toBe(
      true,
    );
  });

  it("summarises the earlier part when shrinking is not enough", async () => {
    const onUsage = vi.fn();
    streamChat
      .mockReturnValueOnce(
        chunks(
          { type: "text", text: "- restoring hosts, 6 steps done" },
          { type: "usage", usage: { promptTokens: 1500, completionTokens: 9 } },
        ),
      )
      .mockReturnValueOnce(chunks({ type: "text", text: "carrying on" }));
    const history = [
      ...longRun(6, 3000),
      { role: "user" as const, content: "and web-2 too" },
    ];

    const events = await run({ history, contextWindow: 2000, onUsage });

    const summaryCall = streamChat.mock.calls[0][1];
    expect(summaryCall.system).toBe(SUMMARY_SYSTEM);
    expect(summaryCall.tools).toEqual([]);
    expect(summaryCall.messages[0].content).toContain("restore hosts");

    const compacted = events.find((e) => e.type === "compacted");
    expect(compacted).toMatchObject({
      summary: "- restoring hosts, 6 steps done",
    });

    const sent: ChatMessage[] = streamChat.mock.calls[1][1].messages;
    expect(isSummary(sent[0])).toBe(true);
    expect(sent.at(-1)).toEqual({ role: "user", content: "and web-2 too" });
    expect(pairsIntact(sent)).toBe(true);
    expect(sent.length).toBe(compacted.keep + 1);

    expect(onUsage.mock.calls.map(([usage]) => usage.source)).toEqual([
      "compaction",
      "assistant",
    ]);
  });

  it("keeps the latest user message when the cut falls after it", async () => {
    handler.mockImplementation(async () => ({ data: "z".repeat(3000) }));
    let turn = 0;
    streamChat.mockImplementation((_config, request) => {
      if (request.system === SUMMARY_SYSTEM) {
        return chunks({ type: "text", text: "summary so far" });
      }
      turn += 1;
      return turn < 8
        ? chunks({
            type: "tool_call",
            call: { id: `t${turn}`, name: "list_hosts", arguments: { turn } },
          })
        : chunks({ type: "text", text: "finished" });
    });

    const events = await run({
      history: [{ role: "user", content: "restore every host" }],
      contextWindow: 3000,
    });

    expect(events.some((e) => e.type === "compacted")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const last: ChatMessage[] = streamChat.mock.calls.at(-1)![1].messages;
    expect(isSummary(last[0])).toBe(true);
    expect(last[1]).toEqual({ role: "user", content: "restore every host" });
    expect(pairsIntact(last)).toBe(true);
  });

  it("carries on with the history as it was when the summary fails", async () => {
    streamChat
      .mockReturnValueOnce(chunks({ type: "error", message: "busy" }))
      .mockReturnValueOnce(chunks({ type: "text", text: "ok" }));

    const events = await run({
      history: [...longRun(6, 3000), { role: "user", content: "next" }],
      contextWindow: 2000,
    });

    expect(events.some((e) => e.type === "compacted")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});

describe("compaction budget", () => {
  const trimmed = (call: number) =>
    (streamChat.mock.calls[call][1].messages as ChatMessage[]).some((message) =>
      message.content.includes("[trimmed"),
    );

  beforeEach(() => {
    streamChat.mockReset();
    streamChat.mockImplementation(() => chunks({ type: "text", text: "ok" }));
  });

  it("compacts against what is left after the reply, not the whole window", async () => {
    const history = longRun(6, 3000);

    await run({ history, contextWindow: 100_000 });
    await run({ history, contextWindow: 100_000, contextBudget: 5000 });

    expect(trimmed(0)).toBe(false);
    expect(trimmed(1)).toBe(true);
    // The provider is still told the whole window.
    expect(streamChat.mock.calls[1][1].contextWindow).toBe(100_000);
  });

  it("starts at the adapter's share of the budget", async () => {
    const history = longRun(6, 3000);
    const size = estimateRequest({
      system: BASE.system,
      messages: history,
      tools: toolDefinitions(BASE.tools),
    });
    // The prompt takes 83% of this budget.
    const contextBudget = Math.ceil(size / 0.83);

    await run({ history, contextWindow: 100_000, contextBudget });
    await run({
      history,
      contextWindow: 100_000,
      contextBudget,
      compactAt: 0.85,
    });

    expect(trimmed(0)).toBe(true);
    expect(trimmed(1)).toBe(false);
  });

  it("leaves the history alone when compaction is off", async () => {
    const events = await run({
      history: longRun(6, 3000),
      contextWindow: 2000,
      compact: false,
    });

    expect(trimmed(0)).toBe(false);
    expect(events.some((e) => e.type === "compacted")).toBe(false);
    expect(streamChat.mock.calls[0][1].contextWindow).toBe(2000);
  });
});

describe("cutting and reloading", () => {
  it("never cuts between a tool call and its result", () => {
    const history = longRun(5, 400);
    for (let budget = 0; budget < 2000; budget += 37) {
      const cut = findCut(history, budget);
      expect(history[cut]?.role ?? "end").not.toBe("tool");
    }
  });

  it("rebuilds a compacted history the same way on reload", () => {
    const live = longRun(3, 10);
    live.push({ role: "user", content: "next" });
    const rows: StoredMessage[] = live.map((message) => ({
      role: message.role,
      content: message.content,
      toolCalls: message.toolCalls
        ? JSON.stringify(message.toolCalls)
        : message.role === "tool"
          ? JSON.stringify([{ id: message.toolCallId, name: message.toolName }])
          : null,
    }));
    rows.push(toStoredSummary("the summary", 3));
    rows.push({ role: "assistant", content: "after", toolCalls: null });

    const history = toChatHistory(rows);

    expect(history).toEqual([
      ...applySummary(live, "the summary", 3),
      { role: "assistant", content: "after" },
    ]);
    expect(history[0].content).toBe(`${SUMMARY_PREFIX}the summary`);
    expect(pairsIntact(history)).toBe(true);
  });

  it("gives the summariser every user message when steps must be left out", () => {
    const history = [
      ...longRun(6, 3000),
      { role: "user" as const, content: "and web-2" },
    ];
    const text = renderTranscript(history, 3000);
    expect(text).toContain("User: restore hosts");
    expect(text).toContain("User: and web-2");
    expect(text).toMatch(/^\[\d+ earlier steps left out\]/);
    expect(text.length).toBeLessThan(3500);
  });

  it("shrinks nothing within the last few results", () => {
    const history = longRun(3, 2000);
    expect(shrinkOldToolResults(history)).toEqual(history);
  });
});

describe("context windows", () => {
  it("knows the common model families and falls back to 128k", () => {
    expect(defaultContextWindow("claude-opus-5")).toBe(200_000);
    expect(defaultContextWindow("gemini-2.5-pro")).toBe(1_000_000);
    expect(defaultContextWindow("gpt-4o-mini")).toBe(128_000);
    expect(defaultContextWindow("something-new")).toBe(128_000);
    expect(defaultContextWindow(null)).toBe(128_000);
  });
});
