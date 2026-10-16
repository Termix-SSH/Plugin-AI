import { afterEach, describe, expect, it, vi } from "vitest";

const keybindings = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  getCustomKeybindings: async () => keybindings.list,
}));
import type {
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { installHotkey } from "../../src/frontend/assistant/hotkey";
import {
  currentPage,
  performClientAction,
} from "../../src/frontend/assistant/shell";
import { storedHistory } from "../../src/frontend/transcript";

const HOSTS = [
  { id: "3", name: "web-1", ip: "10.0.0.3", port: 22, syncId: "s-3" },
  { id: "4", name: "db-1", ip: "10.0.0.4", port: 22 },
] as PluginHostRecord[];

function fakeApp(layout: unknown = null) {
  const tabs = {
    getLayout: vi.fn(() => layout),
    openTab: vi.fn(),
    openSingletonTab: vi.fn(),
    connectHost: vi.fn(),
    openRailView: vi.fn(),
  };
  const app = {
    tabs,
    getHost: (id: string | number) =>
      HOSTS.find((host) => host.id === String(id)),
  } as unknown as Pick<TermixApp, "tabs" | "getHost">;
  return { app, tabs };
}

describe("client actions", () => {
  it("open what the assistant asked for through the SDK", () => {
    const { app, tabs } = fakeApp();
    vi.spyOn(Date, "now").mockReturnValue(42);

    performClientAction(app, { kind: "open_host_terminal", hostId: 3 });
    performClientAction(app, { kind: "open_tab", type: "docker", hostId: 4 });
    performClientAction(app, { kind: "open_tab", type: "alerts" });
    performClientAction(app, {
      kind: "open_settings",
      page: "keybindings",
      anchor: "toggle",
    });
    performClientAction(app, { kind: "open_settings" });
    performClientAction(app, { kind: "open_view", id: "snippets" });
    // A host the shell does not know opens nothing.
    performClientAction(app, { kind: "open_host_terminal", hostId: 99 });

    expect(tabs.connectHost).toHaveBeenCalledTimes(1);
    expect(tabs.connectHost).toHaveBeenCalledWith(HOSTS[0], "terminal");
    expect(tabs.openTab).toHaveBeenCalledWith(HOSTS[1], "docker");
    expect(tabs.openSingletonTab.mock.calls).toEqual([
      ["alerts"],
      [
        "settings",
        { data: { section: "keybindings", reveal: "toggle", revealAt: 42 } },
      ],
      ["settings", { data: { section: "account", revealAt: 42 } }],
    ]);
    expect(tabs.openRailView).toHaveBeenCalledWith("snippets");
  });
});

describe("page context", () => {
  it("names the active tab and its host", () => {
    const { app } = fakeApp({
      version: 2,
      activeSlotId: "b",
      tabs: [
        { slotId: "a", type: "files", label: "db-1", hostNameSnapshot: "db-1" },
        { slotId: "b", type: "terminal", label: "web-1", hostSyncId: "s-3" },
      ],
    });
    expect(currentPage(app, HOSTS)).toEqual({
      tabType: "terminal",
      tabTitle: "web-1",
      hostId: 3,
      hostName: "web-1",
    });
  });

  it("is empty when the layout has no active tab", () => {
    expect(currentPage(fakeApp(null).app, HOSTS)).toBeNull();
    expect(
      currentPage(
        fakeApp({ version: 2, tabs: [], activeSlotId: null }).app,
        HOSTS,
      ),
    ).toBeNull();
  });
});

describe("hotkey", () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    keybindings.list = [];
  });

  const press = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ...init }));

  it("toggles on Ctrl+J or Cmd+J and nothing else", async () => {
    const toggle = vi.fn();
    dispose = installHotkey(toggle);
    await Promise.resolve();
    press({ ctrlKey: true });
    press({ metaKey: true });
    press({ ctrlKey: true, shiftKey: true });
    press({});
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it("stands down once the user rebinds it", async () => {
    keybindings.list = [{ overridesDefaultId: "ai.toggleAssistant" }];
    const toggle = vi.fn();
    dispose = installHotkey(toggle);
    await new Promise((resolve) => setTimeout(resolve, 0));
    press({ ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });
});

describe("stored conversations", () => {
  it("rebuild messages, tool calls, results and per-host rows", () => {
    const history = storedHistory([
      { id: 1, role: "user", content: "uptime", toolCalls: null },
      {
        id: 2,
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([
          { id: "c1", name: "run_command", arguments: { command: "uptime" } },
        ]),
      },
      {
        id: 3,
        role: "tool",
        content: JSON.stringify({
          command: "uptime",
          hosts: [
            { id: 3, name: "web-1", exitCode: 0, output: "up" },
            {
              id: 4,
              name: "db-1",
              exitCode: null,
              error: "Timed out",
              output: "",
            },
          ],
        }),
        toolCalls: JSON.stringify([{ id: "c1", name: "run_command" }]),
      },
      { id: 4, role: "assistant", content: "All up.", toolCalls: null },
    ]);

    expect(history.map((entry) => entry.kind)).toEqual([
      "message",
      "tool",
      "message",
    ]);
    const tool = history[1] as Extract<
      (typeof history)[number],
      { kind: "tool" }
    >;
    expect(tool.tool).toMatchObject({
      id: "stored-2-c1",
      name: "run_command",
      arguments: { command: "uptime" },
    });
    expect(tool.tool.progress).toEqual([
      expect.objectContaining({ hostId: 3, exitCode: 0, output: "up" }),
      expect.objectContaining({
        hostId: 4,
        exitCode: null,
        error: "Timed out",
      }),
    ]);
  });
});
