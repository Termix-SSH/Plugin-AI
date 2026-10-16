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

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../src/frontend/app-ref", () => ({
  aiApp: () => ({
    fetch: mocks.fetch,
    tabs: { getLayout: () => null },
    confirm: async () => true,
  }),
}));
vi.mock("../../src/frontend/ai-api", () => ({
  AI_PROVIDERS_CHANGED_EVENT: "termix-ai:providers-changed",
  getAiStatus: async () => ({ globallyEnabled: true, enabled: true }),
  setAiOptIn: async () => {},
  getAiProviders: async () => [{ id: 5, label: "Work", enabled: true }],
  getOpsFleets: async () => ({ available: false, fleets: [] }),
  listAssistantConversations: async () => [],
  getAssistantConversation: async () => ({}),
  deleteAssistantConversation: async () => {},
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
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
