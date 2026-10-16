import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("../../src/frontend/ai-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAiStatus: vi.fn(async () => ({ globallyEnabled: true, enabled: true })),
}));
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

const declared = (views?: Array<{ id: string }>) =>
  (views ?? []).map((view) => view.id).sort();

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
  assistant.reset();
});

describe(`${manifest.id} activate`, () => {
  it("activates and registers only views its manifest declares", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    const contributes = manifest.contributes as unknown as Record<
      string,
      Array<{ id: string }> | undefined
    >;
    const tabs = declared(contributes.tabs);
    // A rail panel may reuse one of the plugin's tab ids.
    const panels = [...declared(contributes.panels), ...tabs];
    const cards = declared(contributes.dashboardCards);
    for (const id of rendered.registered.tabs()) expect(tabs).toContain(id);
    for (const id of rendered.registered.panels()) expect(panels).toContain(id);
    for (const id of rendered.registered.dashboardCards()) {
      expect(cards).toContain(id);
    }
  });

  it("removes everything it registered on deactivate", async () => {
    const app = await renderWithApp(plugin, { manifest, locales });
    await app.deactivate();
    expect(app.registered.tabs()).toEqual([]);
    expect(app.registered.panels()).toEqual([]);
    expect(app.registered.railItems()).toEqual([]);
    expect(app.registered.hostActions()).toEqual([]);
    expect(app.registered.hostEditorSections()).toEqual([]);
    expect(app.registered.dashboardCards()).toEqual([]);
    expect(app.registered.settingsComponents()).toEqual([]);
    expect(app.registered.actions()).toEqual([]);
  });

  it("registers the providers list as its custom settings field", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.settingsComponents()).toEqual(["providers"]);
  });

  it("adds the assistant tab once AI is on for the user", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    await waitFor(() =>
      expect(rendered!.registered.tabs()).toEqual(["ai", "ai-agents"]),
    );
  });

  it("adds Cluster Ops only for users with its permission", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["ai.ops.use"],
    });
    await waitFor(() =>
      expect([...rendered!.registered.tabs()].sort()).toEqual([
        "ai",
        "ai-agents",
        "ai-ops",
      ]),
    );
    expect(
      rendered.registered.railItems().find((item) => item.id === "ai-ops"),
    ).toMatchObject({ permission: "ai.ops.use" });
  });

  it("shows the floating assistant only to users with ai.ops.use", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    await waitFor(() => expect(rendered!.registered.tabs()).toContain("ai"));
    expect(rendered.registered.slot("shell.overlay")).toEqual([]);
    expect(rendered.registered.keybindingActions()).toEqual([]);
    await rendered.deactivate();

    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["ai.ops.use"],
    });
    await waitFor(() =>
      expect(rendered!.registered.slot("shell.overlay")).toEqual([
        "ai.toggleAssistant",
      ]),
    );
    expect(rendered.registered.keybindingActions()).toEqual([
      "ai.toggleAssistant",
    ]);
    expect(rendered.registered.keybindingDefaults()).toEqual([
      "ai.toggleAssistant",
    ]);

    Element.prototype.scrollTo = vi.fn();
    const overlay = rendered.renderSlot("shell.overlay");
    const ball = await within(overlay).findByRole("button", {
      name: "Toggle the AI assistant",
    });
    fireEvent.pointerDown(ball, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(ball, { clientX: 10, clientY: 10 });
    expect(assistant.get().open).toBe(true);
    expect(
      await within(overlay).findByRole("dialog", { name: "Termix assistant" }),
    ).toBeTruthy();
    // The ball steps aside while the panel is open.
    expect(
      within(overlay).queryByRole("button", {
        name: "Toggle the AI assistant",
      }),
    ).toBeNull();

    // The default key toggles it too, and the ball comes back.
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", ctrlKey: true }),
    );
    expect(assistant.get().open).toBe(false);
    expect(
      await within(overlay).findByRole("button", {
        name: "Toggle the AI assistant",
      }),
    ).toBeTruthy();
  });

  it("moves the panel by its header and resizes it from an edge", async () => {
    localStorage.clear();
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["ai.ops.use"],
    });
    await waitFor(() =>
      expect(rendered!.registered.slot("shell.overlay")).toHaveLength(1),
    );
    Element.prototype.scrollTo = vi.fn();
    const overlay = rendered.renderSlot("shell.overlay");
    assistant.setOpen(true);
    const dialog = await within(overlay).findByRole("dialog", {
      name: "Termix assistant",
    });
    const start = { left: dialog.style.left, top: dialog.style.top };
    const px = (value: string) => Number.parseFloat(value);

    const header = within(overlay).getByTestId("assistant-header");
    fireEvent.pointerDown(header, { clientX: 300, clientY: 300 });
    fireEvent.pointerMove(header, { clientX: 260, clientY: 250 });
    fireEvent.pointerUp(header, { clientX: 260, clientY: 250 });
    expect(px(dialog.style.left)).toBe(px(start.left) - 40);
    expect(px(dialog.style.top)).toBe(px(start.top) - 50);

    const corner = dialog.querySelector('[data-edge="se"]')!;
    const width = px(dialog.style.width);
    fireEvent.pointerDown(corner, { clientX: 500, clientY: 500 });
    fireEvent.pointerMove(corner, { clientX: 470, clientY: 520 });
    fireEvent.pointerUp(corner, { clientX: 470, clientY: 520 });
    expect(px(dialog.style.width)).toBe(Math.max(width - 30, 320));

    const saved = Object.keys(localStorage).find((key) =>
      key.startsWith("termix-ai:assistant-panel:"),
    );
    expect(JSON.parse(localStorage.getItem(saved!)!)).toMatchObject({
      x: px(dialog.style.left),
      width: px(dialog.style.width),
    });
    assistant.setOpen(false);
  });
});
