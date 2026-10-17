import { useEffect, useMemo, useState } from "react";
import {
  useHosts,
  useTranslation,
  type TabProps,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  PanelShell,
  Segmented,
  useIsMobile,
} from "@termix-ssh/plugin-sdk/ui";
import { PanelRight, Sparkles } from "lucide-react";
import { aiApp } from "../app-ref";
import { AssetsView } from "../assets/AssetsView";
import { AutoOpsView } from "../autoops/AutoOpsView";
import { docsUrl } from "../docs";
import { TargetSelector } from "../ops/TargetSelector";
import { fleetGroups, toTargetHosts } from "../ops/targets";
import { AssistantChat } from "./AssistantChat";
import { shortcutLabel } from "./hotkey";
import { assistant, useAssistant } from "./store";

/**
 * The AI tab: the assistant full screen. The same conversation as the
 * floating panel, so a run started in one shows in the other. A user with a
 * shell on hosts also gets the target picker on the left, and Auto-ops:
 * presets, the tasks automations ran and plans waiting for approval. A
 * holder of ai.assets.view also gets the asset inventory.
 */

type View = "assistant" | "autoOps" | "assets";

const DOCS: Record<View, string> = {
  assistant: "assistant",
  autoOps: "auto-ops",
  assets: "assets",
};

function useAssetsAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let live = true;
    aiApp()
      .hasPermission("assets.view")
      .then((value) => live && setAllowed(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return allowed;
}

export function AssistantView(_props: TabProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { targets, fleets, hostShell } = useAssistant();
  const { hosts: allHosts } = useHosts();
  const hosts = useMemo(() => toTargetHosts(allHosts), [allHosts]);
  const selected = useMemo(() => new Set(targets), [targets]);
  const [view, setView] = useState<View>("assistant");
  const assetsAllowed = useAssetsAllowed();
  const views: Array<{ value: View; label: string }> = [
    { value: "assistant", label: t("autoOps.viewAssistant") },
    ...(hostShell
      ? [{ value: "autoOps" as const, label: t("autoOps.viewAutoOps") }]
      : []),
    ...(assetsAllowed
      ? [{ value: "assets" as const, label: t("assets.title") }]
      : []),
  ];
  const shown = views.some((entry) => entry.value === view)
    ? view
    : "assistant";

  useEffect(() => {
    void assistant.ensureReady();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <PanelShell
        icon={<Sparkles className="size-4" />}
        title={t("assistant.title")}
        docs={docsUrl(DOCS[shown])}
        scroll={false}
        actions={
          <div className="flex items-center gap-2">
            {views.length > 1 && (
              <Segmented
                value={shown}
                onChange={(next) => setView(next)}
                options={views}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5 text-xs"
              title={t("assistant.openFloatingHint", {
                shortcut: shortcutLabel(),
              })}
              onClick={() => assistant.setOpen(true)}
            >
              <PanelRight className="size-3.5" />
              {t("assistant.openFloating")}
              {!isMobile && (
                <kbd className="font-mono text-[10px] text-muted-foreground">
                  {shortcutLabel()}
                </kbd>
              )}
            </Button>
          </div>
        }
      >
        {shown === "assets" ? (
          <AssetsView />
        ) : shown === "autoOps" ? (
          <AutoOpsView
            onOpenConversation={(id) => {
              setView("assistant");
              void assistant.openConversation(id);
            }}
          />
        ) : (
          <div
            className={`flex min-h-0 flex-1 ${isMobile ? "flex-col" : "flex-row"}`}
          >
            {hostShell && (
              <TargetSelector
                hosts={hosts}
                fleets={fleets ? fleetGroups(fleets, hosts) : null}
                selected={selected}
                onChange={(next) => assistant.setTargets([...next])}
                className={
                  isMobile ? "max-h-64 border-b" : "w-64 shrink-0 border-r"
                }
              />
            )}
            <AssistantChat />
          </div>
        )}
      </PanelShell>
    </div>
  );
}
