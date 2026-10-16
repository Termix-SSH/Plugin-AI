import type { ComponentType } from "react";
import { Bot, ServerCog, Sparkles } from "lucide-react";
import type {
  PanelProps,
  TabProps,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import type {
  TerminalSidePanelProps,
  TerminalSlotApi,
} from "./terminal/terminal-slot-types";
import { AgentPanel } from "./agents/AgentPanel";
import { AiPanel } from "./AiPanel";
import { OpsPanel } from "./ops/OpsPanel";
import { TerminalAiPanel } from "./terminal/TerminalAiPanel";
import { AiAssistantStep } from "./AiAssistantStep";
import { ProvidersSetting } from "./settings/ProvidersSetting";
import { AI_STATUS_CHANGED_EVENT, getAiStatus } from "./ai-api";
import { setAiApp } from "./app-ref";
import { AssistantOverlay, OPS_TAB_ID } from "./assistant/AssistantOverlay";
import { defaultCombo, installHotkey, TOGGLE_ACTION } from "./assistant/hotkey";
import { performClientAction } from "./assistant/shell";
import { assistant } from "./assistant/store";

/** The rail id the assistant registers under. */
const AI_RAIL_ID = "ai";
const ASSISTANT_ACTION = "ai.openWithContext";
const SIDE_PANEL_ID = "ai.assistant";

function AssistantPanel({ activeTabType }: PanelProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <AiPanel activeTab={activeTabType ?? null} />
    </div>
  );
}

function AssistantTab() {
  return <AiPanel />;
}

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
      permission: "ops.use",
    }),
    app.registerSlotContribution("shell.overlay", {
      actionId: TOGGLE_ACTION,
      titleKey: "assistant.title",
      kind: "component",
      component: AssistantOverlay as ComponentType<Record<string, unknown>>,
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
  assistant.onClientAction((action) => performClientAction(app, action));
  app.onDispose(() => {
    assistant.reset();
    setAiApp(null);
  });

  let globallyEnabled = false;
  let userEnabled = false;
  let agentsAllowed = false;
  let opsAllowed = false;
  void app.hasPermission("agents").then((allowed) => {
    if (disposed) return;
    agentsAllowed = allowed;
    applyStatus();
  });
  void app.hasPermission("ops.use").then((allowed) => {
    if (disposed) return;
    opsAllowed = allowed;
    applyStatus();
  });
  const surface: (() => void)[] = [];

  const clearSurface = () => {
    while (surface.length > 0) surface.pop()!();
  };

  // What the assistant shows depends on the admin switch and the user's own
  // choice, so it is re-registered whenever either changes.
  const applyStatus = () => {
    clearSurface();

    surface.push(
      app.registerRailItem({
        id: AI_RAIL_ID,
        icon: Sparkles,
        titleKey: "nav.ai",
        promotable: true,
        rightDockable: true,
        after: "macros",
        order: 40,
        // Off for everyone: not even a Navigation toggle.
        hidden: !globallyEnabled,
      }),
    );

    if (!globallyEnabled) {
      app.tabs.closeTab(AI_RAIL_ID);
      return;
    }

    surface.push(
      app.registerTab(AI_RAIL_ID, AssistantTab as ComponentType<TabProps>, {
        icon: Sparkles,
        titleKey: "nav.ai",
        singleton: true,
        hostless: true,
        panelFrame: true,
      }),
    );

    surface.push(
      app.registerTab("ai-agents", AgentPanel, {
        icon: Bot,
        titleKey: "agents.title",
        requiresHost: true,
        persistent: true,
      }),
    );
    if (opsAllowed) {
      surface.push(
        app.registerRailItem({
          id: OPS_TAB_ID,
          icon: ServerCog,
          titleKey: "ops.title",
          kind: "tab",
          permission: "ops.use",
          after: AI_RAIL_ID,
          order: 41,
        }),
      );
      surface.push(
        app.registerTab(OPS_TAB_ID, OpsPanel, {
          icon: ServerCog,
          titleKey: "ops.title",
          singleton: true,
          hostless: true,
        }),
      );
      surface.push(...registerAssistant(app));
    }

    surface.push(
      app.registerHostAction({
        id: "ai-agents",
        titleKey: "agents.title",
        icon: Bot,
        kind: "open",
        order: 35,
        tabType: "ai-agents",
        when: (host) => userEnabled && agentsAllowed && !!host.enableSsh,
      }),
    );

    // The per-host switch is this plugin's host setting.
    const offeredOnHost = (context: Record<string, unknown>) =>
      userEnabled &&
      (
        context.host as
          | { pluginSettings?: { ai?: { enableAiAssistant?: boolean } } }
          | undefined
      )?.pluginSettings?.ai?.enableAiAssistant === true;

    surface.push(
      app.registerSlotContribution("terminal.toolbar", {
        actionId: ASSISTANT_ACTION,
        titleKey: "ai.assistant",
        icon: Bot,
        kind: "button",
        when: offeredOnHost,
      }),
    );
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

  app.registerPanel(AI_RAIL_ID, AssistantPanel);

  // Opens the docked assistant on the terminal it was clicked from, seeded
  // with what is on screen.
  app.registerAction(
    ASSISTANT_ACTION,
    (terminal: TerminalSlotApi) =>
      terminal?.openSidePanel(SIDE_PANEL_ID, {
        context: terminal.getBufferText(),
      }),
    { permission: "services.use" },
  );

  app.registerSettingsComponent("providers", ProvidersSetting);

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
