import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/frontend/app-ref", () => ({
  aiApp: () => ({ fetch: vi.fn(), hasPermission: async () => false }),
}));
vi.mock("../../src/frontend/ai-api", () => ({
  AI_PROVIDERS_CHANGED_EVENT: "termix-ai:providers-changed",
  getAiStatus: async () => ({ globallyEnabled: true, enabled: true }),
  setAiOptIn: async () => {},
  getAiProviders: async () => [
    { id: 5, label: "Work", enabled: true },
    { id: 6, label: "Home", enabled: true },
  ],
  getOpsFleets: async () => ({ available: false, fleets: [] }),
  listAssistantConversations: async () => [],
  getAiUsage: async () => null,
}));
import { assistant } from "../../src/frontend/assistant/store";

beforeEach(() => localStorage.clear());
afterEach(() => assistant.reset());

it("starts on the provider the user picked last", async () => {
  await assistant.ensureReady();
  expect(assistant.get().providerId).toBe(5);
  assistant.setProvider(6);

  assistant.reset();
  await assistant.ensureReady();
  expect(assistant.get().providerId).toBe(6);
});
