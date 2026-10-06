import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const aiApi = vi.hoisted(() => ({
  getAiStatus: vi.fn(),
  setAiOptIn: vi.fn(async () => {}),
}));
vi.mock("../../src/frontend/ai-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...aiApi,
}));
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;
let rendered: RenderedPluginApp | null = null;

beforeEach(() => {
  aiApi.getAiStatus.mockResolvedValue({ globallyEnabled: true, enabled: true });
  aiApi.setAiOptIn.mockClear();
});

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

async function mount() {
  rendered = await renderWithApp(plugin, { manifest, locales });
  await waitFor(() =>
    expect(rendered!.registered.onboardingSteps()).toEqual(["assistant"]),
  );
  return rendered;
}

describe("AI onboarding step", () => {
  it("is registered while AI is on for the server", async () => {
    await mount();
  });

  it("leaves AI off on a first run unless the user turns it on", async () => {
    const app = await mount();
    app.renderOnboardingStep("assistant", { mode: "full" });
    await waitFor(() => expect(aiApi.setAiOptIn).toHaveBeenCalledWith(false));
  });

  it("keeps what the user chose before when setup runs again", async () => {
    const app = await mount();
    app.renderOnboardingStep("assistant", { mode: "rerun" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(aiApi.setAiOptIn).not.toHaveBeenCalled();
  });
});
