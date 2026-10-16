import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("../../src/frontend/app-ref", () => ({
  aiApp: () => ({ fetch }),
}));
import {
  useAiStream,
  type ToolActivity,
} from "../../src/frontend/use-ai-stream";

afterEach(() => {
  cleanup();
  fetch.mockReset();
});

const frames = (...events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );

it("posts to the given route and attaches each host's progress to its call", async () => {
  fetch.mockResolvedValue(
    frames(
      { type: "conversation", conversationId: 4 },
      { type: "tool_call", name: "run_command", arguments: { command: "id" } },
      {
        type: "tool_progress",
        name: "run_command",
        host: { hostId: 1, name: "a", exitCode: 0, output: "", durationMs: 1 },
      },
      {
        type: "tool_progress",
        name: "run_command",
        host: { hostId: 2, name: "b", exitCode: 1, output: "", durationMs: 1 },
      },
      { type: "tool_result", name: "run_command", result: { succeeded: 1 } },
      { type: "done" },
    ),
  );
  const { result } = renderHook(() => useAiStream());
  let kept: ToolActivity[] = [];

  await act(() =>
    result.current.send({
      message: "who am i",
      providerId: 1,
      endpoint: "ops/chat",
      extra: { hostIds: [1, 2] },
      onComplete: (_id, _reply, tools) => {
        kept = tools;
      },
    }),
  );

  expect(fetch.mock.calls[0][0]).toBe("ops/chat");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
    message: "who am i",
    hostIds: [1, 2],
  });
  expect(kept).toHaveLength(1);
  expect(kept[0].progress?.map((host) => host.name)).toEqual(["a", "b"]);
  expect(kept[0].result).toEqual({ succeeded: 1 });
  expect(result.current.state.conversationId).toBe(4);
});
