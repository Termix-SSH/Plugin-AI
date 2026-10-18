import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getConversation: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../../src/frontend/app-ref", () => ({
  aiApp: () => ({
    fetch: mocks.fetch,
    tabs: { getLayout: () => null },
    confirm: async () => true,
    hasPermission: async () => false,
  }),
}));
vi.mock("../../src/frontend/ai-api", () => ({
  AI_PROVIDERS_CHANGED_EVENT: "termix-ai:providers-changed",
  CONTEXT_SOURCE_KEYS: {},
  getAiStatus: async () => ({ globallyEnabled: true, enabled: true }),
  setAiOptIn: async () => {},
  getAiProviders: async () => [{ id: 5, label: "Work", enabled: true }],
  getOpsFleets: async () => ({ available: false, fleets: [] }),
  listAssistantConversations: async () => [],
  getAssistantConversation: mocks.getConversation,
  deleteAssistantConversation: async () => {},
  compactAssistantConversation: async () => ({ compacted: false }),
  stopAssistantConversation: mocks.stop,
  getAiUsage: async () => null,
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
  useCurrentUser: () => ({ userId: "user-1" }),
  useHosts: () => ({ loaded: true, hosts: [] }),
}));
vi.mock("../../src/frontend/AiMessage", () => ({
  AiMessage: ({ content }: { content: string }) => <p>{content}</p>,
}));
import { AssistantOverlay } from "../../src/frontend/assistant/AssistantOverlay";
import { assistant } from "../../src/frontend/assistant/store";

const conversation = (running: boolean) => ({
  id: 7,
  title: "deploy",
  targets: [],
  totalTokens: 0,
  running,
  context: null,
});
const asked = { id: 1, role: "user", content: "deploy web", toolCalls: null };

/** A stream the test feeds frame by frame, like a run in progress. */
function liveStream() {
  const encoder = new TextEncoder();
  let push: (event: unknown) => void = () => {};
  let end: () => void = () => {};
  const response = new Response(
    new ReadableStream({
      start(controller) {
        push = (event) =>
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        end = () => controller.close();
      },
    }),
  );
  return { response, push: (e: unknown) => push(e), end: () => end() };
}

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  assistant.reset();
  vi.clearAllMocks();
});

/** A reload with conversation 7 left open, and its run still going on. */
async function reloadIntoRun() {
  localStorage.setItem("termix-ai:assistant-conversation:user-1", "7");
  mocks.getConversation.mockResolvedValueOnce({
    conversation: conversation(true),
    // A step stored mid-run; the replay brings it, so it is not shown twice.
    messages: [
      asked,
      { id: 2, role: "assistant", content: "Checking.", toolCalls: null },
    ],
  });
  const stream = liveStream();
  mocks.fetch.mockResolvedValue(stream.response);
  render(<AssistantOverlay />);
  await waitFor(() =>
    expect(mocks.fetch).toHaveBeenCalledWith(
      "ops/conversations/7/stream",
      expect.anything(),
    ),
  );
  act(() => {
    stream.push({ type: "conversation", conversationId: 7 });
    stream.push({ type: "token", text: "Checking." });
  });
  return stream;
}

it("joins a run still going on after a reload and shows its progress", async () => {
  const stream = await reloadIntoRun();

  await waitFor(() => expect(assistant.get().streaming).toBe(true));
  act(() => assistant.setOpen(true));
  expect(await screen.findByText("deploy web")).toBeTruthy();
  expect(screen.getAllByText("Checking.")).toHaveLength(1);

  act(() => stream.push({ type: "token", text: " Deployed." }));
  expect(await screen.findByText("Checking. Deployed.")).toBeTruthy();

  // Once over, the stored record replaces what was streamed.
  mocks.getConversation.mockResolvedValueOnce({
    conversation: conversation(false),
    messages: [
      asked,
      { id: 2, role: "assistant", content: "All deployed.", toolCalls: null },
    ],
  });
  act(() => {
    stream.push({ type: "done" });
    stream.end();
  });
  expect(await screen.findByText("All deployed.")).toBeTruthy();
  expect(assistant.get().streaming).toBe(false);
});

it("asks the server to stop, and keeps watching until the run ends", async () => {
  const stream = await reloadIntoRun();
  mocks.stop.mockResolvedValue(undefined);
  act(() => assistant.setOpen(true));

  fireEvent.click(await screen.findByRole("button", { name: "ai.stop" }));
  expect(mocks.stop).toHaveBeenCalledWith(7);
  expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(false);
  expect(assistant.get().streaming).toBe(true);

  mocks.getConversation.mockResolvedValue({
    conversation: conversation(false),
    messages: [asked],
  });
  act(() => stream.end());
  await waitFor(() => expect(assistant.get().streaming).toBe(false));
});

it("remembers the open conversation for the next reload", async () => {
  mocks.fetch.mockResolvedValue(
    new Response(
      `data: ${JSON.stringify({ type: "conversation", conversationId: 12 })}\n\n`,
    ),
  );
  render(<AssistantOverlay />);
  assistant.setProvider(5);
  await act(() => assistant.send("hi", null));
  expect(localStorage.getItem("termix-ai:assistant-conversation:user-1")).toBe(
    "12",
  );
  act(() => assistant.newConversation());
  expect(
    localStorage.getItem("termix-ai:assistant-conversation:user-1"),
  ).toBeNull();
});
