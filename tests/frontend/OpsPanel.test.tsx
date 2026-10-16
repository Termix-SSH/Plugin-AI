import type { TabProps } from "@termix-ssh/plugin-sdk/frontend";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../src/frontend/app-ref", () => ({
  aiApp: () => ({ fetch: mocks.fetch }),
}));
vi.mock("../../src/frontend/ai-api", () => ({
  AI_PROVIDERS_CHANGED_EVENT: "termix-ai:providers-changed",
  getAiStatus: async () => ({ globallyEnabled: true, enabled: true }),
  setAiOptIn: async () => {},
  getAiProviders: async () => [{ id: 5, label: "Work", enabled: true }],
  getOpsFleets: async () => ({ available: false, fleets: [] }),
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
  useHosts: () => ({
    loaded: true,
    hosts: [
      { id: "1", name: "web-1", ip: "10.0.0.1", port: 22 },
      { id: "2", name: "web-2", ip: "10.0.0.2", port: 22 },
    ],
  }),
}));
vi.mock("../../src/frontend/AiMessage", () => ({
  AiMessage: ({ content }: { content: string }) => <p>{content}</p>,
}));
import { OpsPanel } from "../../src/frontend/ops/OpsPanel";

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  mocks.fetch.mockResolvedValue(
    new Response('data: {"type":"done"}\n\n', { status: 200 }),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("sends the selected hosts with every message", async () => {
  render(<OpsPanel {...({} as TabProps)} />);
  const input = screen.getByRole("textbox", { name: "ops.inputPlaceholder" });
  await waitFor(() => expect(input.hasAttribute("disabled")).toBe(false));

  fireEvent.change(input, { target: { value: "check disk space" } });
  // Nothing to run on yet.
  expect(screen.getByText("ai.send").closest("button")!.disabled).toBe(true);

  fireEvent.click(screen.getByRole("checkbox", { name: "web-2" }));
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
