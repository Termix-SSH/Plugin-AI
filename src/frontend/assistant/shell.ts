import type {
  PluginHostRecord,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import type { ClientAction, PageContext } from "./store";

/**
 * The assistant's two touch points with the shell: what the user is looking
 * at, and opening what the assistant asks for.
 */

interface LayoutTab {
  slotId?: string;
  type?: string;
  label?: string;
  hostSyncId?: string | null;
  hostNameSnapshot?: string | null;
}

/**
 * The active tab, from app.tabs.getLayout(). The layout is opaque in the
 * SDK's types and leaves out tabs a layout never saves (dashboard,
 * settings), so anything missing just means no page context.
 */
export function currentPage(
  app: Pick<TermixApp, "tabs">,
  hosts: PluginHostRecord[],
): PageContext | null {
  const layout = app.tabs.getLayout() as {
    tabs?: LayoutTab[];
    activeSlotId?: string | null;
  } | null;
  const tab = layout?.tabs?.find(
    (entry) => entry.slotId === layout.activeSlotId,
  );
  if (!tab?.type) return null;

  const host =
    (tab.hostSyncId &&
      hosts.find((entry) => entry.syncId === tab.hostSyncId)) ||
    (tab.hostNameSnapshot &&
      hosts.find((entry) => entry.name === tab.hostNameSnapshot)) ||
    null;
  return {
    tabType: tab.type,
    tabTitle: tab.label || undefined,
    ...(host
      ? { hostId: Number(host.id), hostName: host.name || host.ip }
      : {}),
  };
}

/** Opens what a client_action frame asks for, through the SDK's shell calls. */
export function performClientAction(
  app: Pick<TermixApp, "tabs" | "getHost">,
  action: ClientAction,
): void {
  switch (action.kind) {
    case "open_host_terminal": {
      const host = app.getHost(action.hostId);
      if (host) app.tabs.connectHost(host, "terminal");
      return;
    }
    case "open_tab": {
      if (action.hostId === undefined) {
        app.tabs.openSingletonTab(action.type);
        return;
      }
      const host = app.getHost(action.hostId);
      if (host) app.tabs.openTab(host, action.type);
      return;
    }
    case "open_settings":
      app.tabs.openSingletonTab("settings", {
        data: {
          section: action.page ?? "account",
          ...(action.anchor ? { reveal: action.anchor } : {}),
          revealAt: Date.now(),
        },
      });
      return;
    case "open_view":
      app.tabs.openRailView(action.id);
      return;
  }
}
