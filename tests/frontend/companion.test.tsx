import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

vi.mock("../../src/frontend/ai-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAiStatus: vi.fn(async () => ({ globallyEnabled: true, enabled: true })),
}));
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import { assistant } from "../../src/frontend/assistant/store";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  assistant.reset();
});

describe("assistant beside a terminal", () => {
  it("uses the panel bar on cores that have it", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["ai.use"],
    });
    await waitFor(() =>
      expect(rendered!.registered.actions()).toContain("ai.togglePanel"),
    );
    expect(rendered.registered.slot("tab.menu")).toEqual(["ai.togglePanel"]);
    expect(rendered.registered.slot("terminal.sidePanel")).toEqual([]);
  });

  it("keeps the floating panel on cores without the panel bar", async () => {
    const slots: string[] = [];
    const withoutCompanions = {
      activate(app: TermixApp) {
        const proxy = new Proxy(app, {
          get(target, key, receiver) {
            if (key === "registerCompanion") return undefined;
            if (key === "registerSlotContribution") {
              return (slot: string, contribution: unknown) => {
                slots.push(slot);
                return target.registerSlotContribution(
                  slot,
                  contribution as never,
                );
              };
            }
            return Reflect.get(target, key, receiver);
          },
        });
        plugin.activate(proxy);
      },
    };
    rendered = await renderWithApp(withoutCompanions, {
      manifest,
      locales,
      permissions: ["ai.use"],
    });
    await waitFor(() => expect(slots).toContain("terminal.sidePanel"));
    expect(slots).not.toContain("tab.menu");
  });
});
