import type { ComponentType } from "react";
import { Bot, Sparkles } from "lucide-react";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import type {
  TerminalSidePanelProps,
  TerminalSlotApi,
} from "./terminal/terminal-slot-types";
import { AgentPanel } from "./agents/AgentPanel";
import { TerminalAiPanel } from "./terminal/TerminalAiPanel";
import {
  AiCompanion,
  setPendingContext,
  useAiCompanionDefaults,
} from "./terminal/AiCompanion";
import { AiAssistantStep } from "./AiAssistantStep";
import { ProvidersSetting } from "./settings/ProvidersSetting";
import { UsageSetting } from "./settings/UsageSetting";
import { UsageCard } from "./usage/UsageCard";
import { AI_STATUS_CHANGED_EVENT, getAiStatus } from "./ai-api";
import { setAiApp } from "./app-ref";
import {
  AI_TAB_ID,
  AssistantDockSpacer,
  AssistantOverlay,
} from "./assistant/AssistantOverlay";
import { AssistantView } from "./assistant/AssistantView";
import { defaultCombo, installHotkey, TOGGLE_ACTION } from "./assistant/hotkey";
import { performClientAction } from "./assistant/shell";
import { assistant } from "./assistant/store";

const ASSISTANT_ACTION = "ai.openWithContext";
const PANEL_TOGGLE_ACTION = "ai.togglePanel";
const SIDE_PANEL_ID = "ai.assistant";
const USAGE_CARD_ID = "ai-usage";
const COMPANION_ID = "assistant";

/** The assistant beside a terminal, in its "terminal.sidePanel" slot. */
function TerminalSidePanel({
  host,
  hostId,
  hostLabel,
  panelProps,
  onClose,
  onRunInTerminal,
}: TerminalSidePanelProps) {
  if (!hostId) return null;
  return (
    <TerminalAiPanel
      hostLabel={hostLabel}
      hostId={hostId}
      activeTab={`terminal:${host?.name || host?.ip || ""}`}
      initialContext={
        typeof panelProps.context === "string" ? panelProps.context : ""
      }
      onClose={onClose}
      onRunInTerminal={onRunInTerminal}
    />
  );
}

const toggleAssistant = () => assistant.toggle();

/**
 * The floating assistant, for users who may use it: the ball and panel in
 * the shell's overlay slot, gated on the toggle action's permission, and the
 * key that opens it.
 */
function registerAssistant(app: TermixApp): (() => void)[] {
  return [
    app.registerAction(TOGGLE_ACTION, toggleAssistant, {
      permission: "use",
    }),
    app.registerSlotContribution("shell.overlay", {
      actionId: TOGGLE_ACTION,
      titleKey: "assistant.title",
      kind: "component",
      component: AssistantOverlay as ComponentType<Record<string, unknown>>,
    }),
    app.registerSlotContribution("shell.rightEdge", {
      actionId: TOGGLE_ACTION,
      titleKey: "assistant.title",
      kind: "component",
      component: AssistantDockSpacer as ComponentType<Record<string, unknown>>,
    }),
    app.registerKeybindingAction({
      id: TOGGLE_ACTION,
      titleKey: "assistant.toggle",
      scope: "global",
      run: toggleAssistant,
    }),
    app.registerKeybindingDefault({
      id: TOGGLE_ACTION,
      combo: defaultCombo(),
      descriptionKey: "assistant.toggle",
    }),
    installHotkey(toggleAssistant),
  ];
}

export function activate(app: TermixApp): void {
  setAiApp(app);
  // Cores before 26.10.3 have no panels beside tabs.
  const companions = typeof app.registerCompanion === "function";
  assistant.onClientAction((action) => performClientAction(app, action));
  app.onDispose(() => {
    assistant.reset();
    setAiApp(null);
  });

  let globallyEnabled = false;
  let userEnabled = false;
  let agentsAllowed = false;
  let assistantAllowed = false;
  void app.hasPermission("use").then((allowed) => {
    if (disposed) return;
    assistantAllowed = allowed;
    applyStatus();
  });
  void app.hasPermission("agents").then((allowed) => {
    if (disposed) return;
    agentsAllowed = allowed;
    applyStatus();
  });
  // A shell on hosts is extra; everything else the assistant does is
  // bounded by the user's own permissions.
  void app.hasPermission("ops.use").then((allowed) => {
    if (!disposed) assistant.setHostShell(allowed);
  });
  const surface: (() => void)[] = [];

  const clearSurface = () => {
    while (surface.length > 0) surface.pop()!();
  };

  // What the assistant shows depends on the admin switch and the user's own
  // choice, so it is re-registered whenever either changes.
  // The per-host switch is this plugin's host setting.
  const hostSwitchOn = (host: unknown) =>
    (host as { pluginSettings?: { ai?: { enableAiAssistant?: boolean } } })
      ?.pluginSettings?.ai?.enableAiAssistant === true;

  const applyStatus = () => {
    clearSurface();

    surface.push(
      app.registerRailItem({
        id: AI_TAB_ID,
        icon: Sparkles,
        titleKey: "nav.ai",
        kind: "tab",
        permission: "use",
        after: "macros",
        order: 40,
        // Off for everyone: not even a Navigation toggle.
        hidden: !globallyEnabled,
      }),
    );

    if (!globallyEnabled) {
      app.tabs.closeTab(AI_TAB_ID);
      return;
    }

    // The AI tab is the assistant's full view; the floating panel shares
    // its conversations.
    surface.push(
      app.registerTab(AI_TAB_ID, AssistantView, {
        icon: Sparkles,
        titleKey: "nav.ai",
        singleton: true,
        hostless: true,
      }),
    );
    if (assistantAllowed) surface.push(...registerAssistant(app));
    // Usage is behind the user's own opt-in, like every other AI route.
    if (assistantAllowed && userEnabled) {
      surface.push(
        app.registerDashboardCard({
          id: USAGE_CARD_ID,
          titleKey: "usage.cardTitle",
          defaultPanel: "side",
          component: UsageCard,
        }),
      );
    }

    surface.push(
      app.registerTab("ai-agents", AgentPanel, {
        icon: Bot,
        titleKey: "agents.title",
        requiresHost: true,
        persistent: true,
      }),
    );

    surface.push(
      app.registerHostAction({
        id: "ai-agents",
        titleKey: "agents.title",
        icon: Bot,
        kind: "open",
        order: 35,
        tabType: "ai-agents",
        when: (host) =>
          userEnabled &&
          agentsAllowed &&
          !!host.enableSsh &&
          hostSwitchOn(host),
      }),
    );

    const offeredOnHost = (context: Record<string, unknown>) =>
      userEnabled && hostSwitchOn(context.host);

    surface.push(
      app.registerSlotContribution("terminal.toolbar", {
        actionId: ASSISTANT_ACTION,
        titleKey: "ai.assistant",
        icon: Bot,
        kind: "button",
        when: offeredOnHost,
      }),
    );
    if (companions) {
      // Cores with panels beside tabs show the assistant there.
      const panelOn = (host: unknown) =>
        userEnabled &&
        hostSwitchOn(host) &&
        (host as { pluginSettings?: { ai?: { showPanel?: boolean } } })
          ?.pluginSettings?.ai?.showPanel !== false;
      surface.push(
        app.registerCompanion(COMPANION_ID, AiCompanion, {
          icon: Bot,
          titleKey: "ai.assistant",
          order: 90,
          tabTypes: ["terminal"],
          when: (_tab, host) => !!host?.enableSsh && panelOn(host),
          useDefaults: useAiCompanionDefaults,
        }),
        app.registerAction(PANEL_TOGGLE_ACTION, ((
          _handle: unknown,
          tab: unknown,
        ) => app.toggleCompanion(tab as never, COMPANION_ID)) as never),
        app.registerSlotContribution("tab.menu", {
          actionId: PANEL_TOGGLE_ACTION,
          titleKey: "companion.toggle",
          icon: Bot,
          kind: "button",
          order: 12,
          when: (context) => {
            const tab = context.tab as {
              type?: string;
              host?: unknown;
              hostConfig?: unknown;
            } | null;
            return (
              tab?.type === "terminal" && panelOn(tab.host ?? tab.hostConfig)
            );
          },
        }),
      );
    } else {
      surface.push(
        app.registerSlotContribution("terminal.sidePanel", {
          actionId: SIDE_PANEL_ID,
          titleKey: "ai.assistant",
          icon: Bot,
          kind: "component",
          component: TerminalSidePanel as unknown as ComponentType<
            Record<string, unknown>
          >,
          when: offeredOnHost,
        }),
      );
    }
    surface.push(
      app.registerOnboardingStep({
        id: "assistant",
        titleKey: "onboarding.aiTitle",
        icon: Sparkles,
        component: AiAssistantStep,
        section: "setup",
      }),
    );
  };

  const refresh = () => {
    getAiStatus()
      .then((status) => {
        globallyEnabled = status.globallyEnabled;
        userEnabled = status.globallyEnabled && status.enabled;
      })
      .catch(() => {
        globallyEnabled = false;
        userEnabled = false;
      })
      .finally(() => {
        if (!disposed) applyStatus();
      });
  };

  let disposed = false;
  app.onDispose(() => {
    disposed = true;
    clearSurface();
  });

  // Opens the docked assistant on the terminal it was clicked from, seeded
  // with what is on screen.
  app.registerAction(
    ASSISTANT_ACTION,
    (terminal: TerminalSlotApi) => {
      const context = terminal?.getBufferText() ?? "";
      const tabKey = terminal?.getShareTarget?.()?.tabInstanceId;
      if (companions && tabKey) {
        setPendingContext(tabKey, context);
        app.toggleCompanion(
          { id: tabKey, instanceId: tabKey, type: "terminal", label: "" },
          COMPANION_ID,
        );
        return;
      }
      terminal?.openSidePanel(SIDE_PANEL_ID, { context });
    },
    { permission: "services.use" },
  );

  app.registerSettingsComponent("providers", ProvidersSetting);
  app.registerSettingsComponent("usage", UsageSetting);

  applyStatus();
  refresh();
  // The admin switch and the user's own choice are settings, saved from
  // the settings screen.
  app.onSettingsChanged(() => refresh());
  const events = [AI_STATUS_CHANGED_EVENT, "termix:plugins-changed"];
  for (const event of events) window.addEventListener(event, refresh);
  app.onDispose(() => {
    for (const event of events) window.removeEventListener(event, refresh);
  });
}
