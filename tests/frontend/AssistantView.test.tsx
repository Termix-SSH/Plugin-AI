import type { TabProps } from "@termix-ssh/plugin-sdk/frontend";
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
  compact: vi.fn(),
  savePreferences: vi.fn(),
  openSingletonTab: vi.fn(),
  hasPermission: vi.fn(),
}));
vi.mock("../../src/frontend/autoops/api", async (original) => ({
  ...(await original<object>()),
  savePreferences: mocks.savePreferences,
}));
vi.mock("../../src/frontend/app-ref", () => ({
  aiApp: () => ({
    fetch: mocks.fetch,
    tabs: { getLayout: () => null, openSingletonTab: mocks.openSingletonTab },
    confirm: async () => true,
    hasPermission: mocks.hasPermission,
  }),
}));
vi.mock("../../src/frontend/ai-api", () => ({
  AI_PROVIDERS_CHANGED_EVENT: "termix-ai:providers-changed",
  CONTEXT_SOURCE_KEYS: {
    override: "ai.contextSourceOverride",
    provider: "ai.contextSourceProvider",
    guess: "ai.contextSourceGuess",
    default: "ai.contextSourceDefault",
  },
  getAiStatus: async () => ({ globallyEnabled: true, enabled: true }),
  setAiOptIn: async () => {},
  getAiProviders: async () => [{ id: 5, label: "Work", enabled: true }],
  getOpsFleets: async () => ({ available: false, fleets: [] }),
  listAssistantConversations: async () => [],
  getAssistantConversation: mocks.getConversation,
  deleteAssistantConversation: async () => {},
  compactAssistantConversation: mocks.compact,
  getAiUsage: async () => {
    const totals = {
      promptTokens: 800,
      completionTokens: 200,
      totalTokens: 1000,
      calls: 2,
      estimated: false,
    };
    return {
      scope: "me",
      today: totals,
      week: totals,
      month: totals,
      byDay: [{ day: "2026-10-16", ...totals }],
      byModel: [{ model: "glm-5.3-flash", ...totals }],
      bySource: [{ source: "assistant", ...totals }],
    };
  },
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ t: (key: string) => key, language: "zh_CN" }),
  useHosts: () => ({
    loaded: true,
    hosts: [
      { id: "1", name: "web-1", ip: "10.0.0.1", port: 22, tags: ["prod"] },
      { id: "2", name: "web-2", ip: "10.0.0.2", port: 22 },
    ],
  }),
}));
vi.mock("../../src/frontend/AiMessage", () => ({
  AiMessage: ({ content }: { content: string }) => <p>{content}</p>,
}));
import { AssistantView } from "../../src/frontend/assistant/AssistantView";
import { assistant } from "../../src/frontend/assistant/store";

const frames = (...events: unknown[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  mocks.fetch.mockResolvedValue(frames({ type: "done" }));
  mocks.savePreferences.mockResolvedValue({});
  mocks.hasPermission.mockResolvedValue(false);
  assistant.setHostShell(true);
});
afterEach(() => {
  cleanup();
  assistant.reset();
  vi.clearAllMocks();
});

async function ready(placeholder = "assistant.inputPlaceholder") {
  render(<AssistantView {...({} as TabProps)} />);
  const input = screen.getByRole("textbox", { name: placeholder });
  await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));
  return input;
}

it("sends the selected hosts and the page with every message", async () => {
  const input = await ready();
  fireEvent.click(screen.getByRole("checkbox", { name: "web-2" }));
  fireEvent.change(input, { target: { value: "check disk space" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  const [path, init] = mocks.fetch.mock.calls[0];
  expect(path).toBe("ops/chat");
  expect(JSON.parse(init.body)).toMatchObject({
    providerId: 5,
    message: "check disk space",
    hostIds: [2],
  });
  expect(await screen.findByText("check disk space")).toBeTruthy();
});

it("offers the asset inventory to a holder of ai.assets.view", async () => {
  await ready();
  expect(screen.queryByText("assets.title")).toBeNull();
  cleanup();
  mocks.hasPermission.mockImplementation(
    async (permission: string) => permission === "assets.view",
  );
  await ready();
  expect(await screen.findByText("assets.title")).toBeTruthy();
});

it("saves the interface language for reports when the assistant opens", async () => {
  await ready();
  expect(mocks.savePreferences).toHaveBeenCalledWith({ language: "zh_CN" });
});

it("adds targets from an @-mention and removes them from their chip", async () => {
  const input = await ready();
  fireEvent.change(input, {
    target: { value: "restart @pro", selectionStart: 12 },
  });
  const option = await screen.findByRole("option", { name: /prod/ });
  fireEvent.mouseDown(option);

  expect(assistant.get().targets).toEqual([1]);
  expect((input as HTMLTextAreaElement).value).toBe("restart ");
  const remove = screen.getByRole("button", {
    name: "assistant.removeTarget",
  });
  fireEvent.click(remove);
  expect(assistant.get().targets).toEqual([]);
});

it("follows the targets the assistant sets and hands over client actions", async () => {
  const actions: unknown[] = [];
  assistant.onClientAction((action) => actions.push(action));
  mocks.fetch.mockResolvedValue(
    frames(
      { type: "conversation", conversationId: 8 },
      { type: "tool_call", name: "set_targets", arguments: { tags: ["prod"] } },
      { type: "targets", hostIds: [1, 2] },
      { type: "tool_result", name: "set_targets", result: { targets: 2 } },
      { type: "client_action", action: { kind: "open_view", id: "hosts" } },
      { type: "token", text: "Done." },
      { type: "done" },
    ),
  );
  const input = await ready();
  fireEvent.change(input, { target: { value: "target prod" } });
  fireEvent.keyDown(input, { key: "Enter" });

  expect(await screen.findByText("Done.")).toBeTruthy();
  expect(assistant.get()).toMatchObject({ conversationId: 8, targets: [1, 2] });
  expect(actions).toEqual([{ kind: "open_view", id: "hosts" }]);
  expect(
    (screen.getByRole("checkbox", { name: "web-1" }) as HTMLButtonElement)
      .dataset.state,
  ).toBe("checked");
});

it("keeps a run going when the view closes, and shows it again", async () => {
  let push: (event: unknown) => void = () => {};
  let end: () => void = () => {};
  mocks.fetch.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          push = (event) =>
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          end = () => controller.close();
        },
      }),
    ),
  );
  const input = await ready();
  fireEvent.change(input, { target: { value: "slow job" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(assistant.get().streaming).toBe(true));

  cleanup();
  act(() => push({ type: "token", text: "Finished while away." }));
  act(() => end());
  await waitFor(() => expect(assistant.get().streaming).toBe(false));

  render(<AssistantView {...({} as TabProps)} />);
  expect(await screen.findByText("Finished while away.")).toBeTruthy();
  expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(false);
});

it("leaves out targets for a user without a shell on hosts", async () => {
  assistant.setHostShell(false);
  assistant.setTargets([1]);
  const input = await ready("assistant.inputPlaceholderBasic");
  expect(screen.queryByRole("checkbox", { name: "web-1" })).toBeNull();
  expect(screen.queryByText("assistant.noTargets")).toBeNull();

  fireEvent.change(input, { target: { value: "@pro", selectionStart: 4 } });
  expect(screen.queryByRole("option")).toBeNull();
  fireEvent.change(input, { target: { value: "list my hosts" } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).not.toHaveProperty(
    "hostIds",
  );
});

/** True when `a` comes before `b` in the document. */
const before = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

it("shows a run in the order it streamed, its thinking kept apart", async () => {
  mocks.fetch.mockResolvedValue(
    frames(
      { type: "conversation", conversationId: 3 },
      { type: "reasoning", text: "The user wants " },
      { type: "reasoning", text: "their hosts." },
      { type: "token", text: "Let me check." },
      { type: "tool_call", name: "list_hosts", arguments: {} },
      { type: "tool_result", name: "list_hosts", result: { hosts: 2 } },
      {
        type: "usage",
        usage: { promptTokens: 42000, completionTokens: 100, estimated: false },
        contextWindow: 128000,
        contextSource: "provider",
        reservedOutput: 8192,
      },
      { type: "token", text: "You have two hosts." },
      { type: "done" },
    ),
  );
  const input = await ready();
  fireEvent.change(input, { target: { value: "how many hosts" } });
  fireEvent.keyDown(input, { key: "Enter" });

  const answer = await screen.findByText("You have two hosts.");
  await waitFor(() => expect(assistant.get().streaming).toBe(false));
  const thinking = screen.getByRole("button", { name: "assistant.thinking" });
  const first = screen.getByText("Let me check.");
  const tool = screen.getByText("Reading hosts");
  expect(before(thinking, first)).toBe(true);
  expect(before(first, tool)).toBe(true);
  expect(before(tool, answer)).toBe(true);

  // Thinking is collapsed and never part of the answer text.
  expect(screen.queryByText("The user wants their hosts.")).toBeNull();
  fireEvent.click(thinking);
  expect(screen.getByText("The user wants their hosts.")).toBeTruthy();

  const meter = screen.getByText("42k / 128k");
  // Where the window came from, and what is kept for the reply.
  expect(meter.getAttribute("title")).toBe(
    "assistant.contextMeter assistant.contextMeterSource assistant.contextMeterReserved",
  );
  // Today's total sits next to the meter.
  expect(
    screen.getByRole("button", { name: "assistant.usage" }).textContent,
  ).toContain("assistant.todayTokens");
});

it("marks where the context was compacted during a run", async () => {
  mocks.fetch.mockResolvedValue(
    frames(
      { type: "token", text: "Working." },
      { type: "compacted" },
      { type: "token", text: "Still working." },
      { type: "done" },
    ),
  );
  const input = await ready();
  fireEvent.change(input, { target: { value: "restore hosts" } });
  fireEvent.keyDown(input, { key: "Enter" });

  const after = await screen.findByText("Still working.");
  const note = screen.getByRole("note");
  expect(note.textContent).toContain("assistant.compacted");
  expect(before(screen.getByText("Working."), note)).toBe(true);
  expect(before(note, after)).toBe(true);
});

it("reloads a conversation in the order it happened", async () => {
  mocks.getConversation.mockResolvedValue({
    conversation: {
      id: 9,
      title: "Restore",
      targets: [],
      totalTokens: 5000,
      context: {
        promptTokens: 9000,
        contextWindow: 128000,
        estimated: true,
        contextSource: "override",
      },
    },
    messages: [
      { id: 1, role: "user", content: "restore web-1", toolCalls: null },
      {
        id: 2,
        role: "assistant",
        content: "Looking it up.",
        reasoning: "Need the host first.",
        toolCalls: JSON.stringify([
          { id: "c1", name: "list_hosts", arguments: {} },
        ]),
      },
      {
        id: 3,
        role: "tool",
        content: "{}",
        toolCalls: JSON.stringify([{ id: "c1", name: "list_hosts" }]),
      },
      {
        id: 4,
        role: "summary",
        content: "The user is restoring web-1.",
        toolCalls: JSON.stringify({ keep: 2 }),
      },
      { id: 5, role: "assistant", content: "Restored.", toolCalls: null },
    ],
  });
  await ready();
  await act(() => assistant.openConversation(9));

  const thinking = screen.getByRole("button", { name: "assistant.thinking" });
  const text = screen.getByText("Looking it up.");
  const tool = screen.getByText("Reading hosts");
  const note = screen.getByRole("note");
  const last = screen.getByText("Restored.");
  expect(before(screen.getByText("restore web-1"), thinking)).toBe(true);
  expect(before(thinking, text)).toBe(true);
  expect(before(text, tool)).toBe(true);
  expect(before(tool, note)).toBe(true);
  expect(before(note, last)).toBe(true);
  expect(screen.queryByText("The user is restoring web-1.")).toBeNull();
  expect(screen.getByText("~9k / 128k")).toBeTruthy();
});

it("compacts the open conversation from the header", async () => {
  mocks.getConversation.mockResolvedValue({
    conversation: { id: 4, title: "x", targets: [], context: null },
    messages: [],
  });
  mocks.compact.mockResolvedValue({
    compacted: true,
    context: {
      promptTokens: 5000,
      contextWindow: 128000,
      estimated: true,
      contextSource: "guess",
    },
  });
  await ready();
  await act(() => assistant.openConversation(4));

  fireEvent.click(screen.getByRole("button", { name: "assistant.compact" }));

  await waitFor(() => expect(mocks.compact).toHaveBeenCalledWith(4, 5));
  // A guessed window is marked as one.
  expect(await screen.findByText("~5k / ~128k")).toBeTruthy();
});

it("opens the usage view from the header", async () => {
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "assistant.usage" }));
  expect(await screen.findByText("usage.today")).toBeTruthy();
  expect(screen.getByText("glm-5.3-flash")).toBeTruthy();
});

it("switches to Auto-ops for a user with a shell on hosts only", async () => {
  await ready();
  fireEvent.click(screen.getByText("autoOps.viewAutoOps"));
  expect(await screen.findByText("autoOps.sections.approvals")).toBeTruthy();
  cleanup();

  assistant.setHostShell(false);
  render(<AssistantView {...({} as TabProps)} />);
  expect(screen.queryByText("autoOps.viewAutoOps")).toBeNull();
});

it("opens the floating panel from the AI tab", async () => {
  await ready();
  expect(assistant.get().open).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: /assistant.openFloating/ }),
  );
  expect(assistant.get().open).toBe(true);
});

it("opens the provider settings from the provider list", async () => {
  await ready();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  fireEvent.keyDown(
    await screen.findByRole("option", { name: "ai.manageModels" }),
    { key: "Enter" },
  );
  expect(mocks.openSingletonTab).toHaveBeenCalledWith("settings", {
    data: expect.objectContaining({
      section: "plugin:ai",
      reveal: "ai-providers",
    }),
  });
  expect(assistant.get().providerId).toBe(5);
});
