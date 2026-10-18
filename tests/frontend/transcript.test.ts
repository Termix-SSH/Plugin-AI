import { describe, expect, it } from "vitest";
import {
  applyStreamEvent,
  assistantTimeline,
  buildTimeline,
  finishedRunEntries,
  storedHistory,
  userEntry,
  type AssistantEntry,
  type StreamEvent,
} from "../../src/frontend/transcript";

describe("finishedRunEntries", () => {
  it("keeps the run's tool steps ahead of its reply", () => {
    const entries = finishedRunEntries(
      2,
      [{ id: "tool-0", name: "list_hosts", arguments: {}, result: [] }],
      "done",
    );
    expect(entries).toEqual([
      {
        kind: "tool",
        tool: {
          id: "run-2-tool-0",
          name: "list_hosts",
          arguments: {},
          result: [],
        },
      },
      { kind: "message", role: "assistant", content: "done" },
    ]);
  });

  it("adds no empty reply", () => {
    expect(finishedRunEntries(0, [], "")).toEqual([]);
  });
});

describe("buildTimeline", () => {
  it("keeps past steps when a new run starts", () => {
    const history = [
      userEntry("check"),
      ...finishedRunEntries(
        0,
        [{ id: "tool-0", name: "list_hosts", arguments: {} }],
        "",
      ),
      userEntry("continue"),
    ];
    const timeline = buildTimeline(
      history,
      {
        tools: [{ id: "tool-0", name: "get_host", arguments: {} }],
        assistantText: "hi",
      },
      [],
    );

    expect(timeline.map((item) => item.kind)).toEqual([
      "message",
      "tool",
      "message",
      "tool",
      "message",
    ]);
    const tools = timeline.filter((item) => item.kind === "tool");
    expect(tools.map((item) => item.live)).toEqual([false, true]);
    expect(new Set(timeline.map((item) => item.key)).size).toBe(
      timeline.length,
    );
  });
});

describe("applyStreamEvent", () => {
  const play = (...events: StreamEvent[]) => {
    let id = 0;
    return events.reduce<AssistantEntry[]>(
      (entries, event) => applyStreamEvent(entries, event, () => `t${id++}`),
      [],
    );
  };

  it("keeps text, thinking and tools in the order they streamed", () => {
    const entries = play(
      { type: "reasoning", text: "first " },
      { type: "reasoning", text: "thought" },
      { type: "token", text: "Let me " },
      { type: "token", text: "look." },
      { type: "tool_call", name: "list_hosts", arguments: {} },
      { type: "tool_result", name: "list_hosts", result: [1] },
      { type: "reasoning", text: "now answer" },
      { type: "token", text: "One host." },
      { type: "compacted" },
      { type: "token", text: "More." },
    );

    expect(entries).toEqual([
      { kind: "thinking", content: "first thought" },
      { kind: "message", role: "assistant", content: "Let me look." },
      {
        kind: "tool",
        tool: { id: "t0", name: "list_hosts", arguments: {}, result: [1] },
      },
      { kind: "thinking", content: "now answer" },
      { kind: "message", role: "assistant", content: "One host." },
      { kind: "compacted" },
      { kind: "message", role: "assistant", content: "More." },
    ]);
  });

  it("gives a result to its own call when several are open", () => {
    const entries = play(
      { type: "tool_call", name: "list_hosts" },
      { type: "token", text: "between" },
      { type: "tool_call", name: "get_host" },
      { type: "tool_result", name: "list_hosts", result: "a" },
    );
    expect(entries[0]).toMatchObject({ tool: { id: "t0", result: "a" } });
    expect(entries[2]).toMatchObject({ tool: { id: "t1" } });
    expect("result" in (entries[2] as { tool: object }).tool).toBe(false);
  });
});

describe("storedHistory", () => {
  it("puts thinking before its text and marks compaction", () => {
    const entries = storedHistory([
      { id: 1, role: "user", content: "hi", toolCalls: null },
      {
        id: 2,
        role: "assistant",
        content: "Checking.",
        reasoning: "plan",
        toolCalls: JSON.stringify([{ id: "c1", name: "list_hosts" }]),
      },
      {
        id: 3,
        role: "tool",
        content: "[]",
        toolCalls: JSON.stringify([{ id: "c1", name: "list_hosts" }]),
      },
      {
        id: 4,
        role: "summary",
        content: "summary",
        toolCalls: '{"keep":1}',
      },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "message",
      "thinking",
      "message",
      "tool",
      "compacted",
    ]);
    const timeline = assistantTimeline(entries, [
      { kind: "message", role: "assistant", content: "live" },
    ]);
    expect(timeline.at(-1)).toMatchObject({ key: "live-0", content: "live" });
    expect(timeline[3]).toMatchObject({ kind: "tool", live: false });
  });
});
