import { useEffect, useMemo } from "react";
import {
  useHosts,
  useTranslation,
  type TabProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { PanelShell, useIsMobile } from "@termix-ssh/plugin-sdk/ui";
import { Sparkles } from "lucide-react";
import { docsUrl } from "../docs";
import { TargetSelector } from "../ops/TargetSelector";
import { fleetGroups, toTargetHosts } from "../ops/targets";
import { AssistantChat } from "./AssistantChat";
import { assistant, useAssistant } from "./store";

/**
 * The AI tab: the assistant full screen. The same conversation as the
 * floating panel, so a run started in one shows in the other. A user with a
 * shell on hosts also gets the target picker on the left.
 */
export function AssistantView(_props: TabProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { targets, fleets, hostShell } = useAssistant();
  const { hosts: allHosts } = useHosts();
  const hosts = useMemo(() => toTargetHosts(allHosts), [allHosts]);
  const selected = useMemo(() => new Set(targets), [targets]);

  useEffect(() => {
    void assistant.ensureReady();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <PanelShell
        icon={<Sparkles className="size-4" />}
        title={t("assistant.title")}
        docs={docsUrl("assistant")}
        scroll={false}
      >
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
      </PanelShell>
    </div>
  );
}
