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
 * presets, the tasks automations ran and plans waiting for approval.
 */
export function AssistantView(_props: TabProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { targets, fleets, hostShell } = useAssistant();
  const { hosts: allHosts } = useHosts();
  const hosts = useMemo(() => toTargetHosts(allHosts), [allHosts]);
  const selected = useMemo(() => new Set(targets), [targets]);
  const [view, setView] = useState<"assistant" | "autoOps">("assistant");

  useEffect(() => {
    void assistant.ensureReady();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <PanelShell
        icon={<Sparkles className="size-4" />}
        title={t("assistant.title")}
        docs={docsUrl(view === "autoOps" ? "auto-ops" : "assistant")}
        scroll={false}
        actions={
          <div className="flex items-center gap-2">
            {hostShell && (
              <Segmented
                value={view}
                onChange={(next) => setView(next as typeof view)}
                options={[
                  { value: "assistant", label: t("autoOps.viewAssistant") },
                  { value: "autoOps", label: t("autoOps.viewAutoOps") },
                ]}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
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
        {view === "autoOps" && hostShell ? (
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
