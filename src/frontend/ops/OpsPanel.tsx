import { useEffect, useMemo } from "react";
import {
  useHosts,
  useTranslation,
  type TabProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { PanelShell, useIsMobile } from "@termix-ssh/plugin-sdk/ui";
import { ServerCog } from "lucide-react";
import { AssistantChat } from "../assistant/AssistantChat";
import { assistant, useAssistant } from "../assistant/store";
import { docsUrl } from "../docs";
import { TargetSelector } from "./TargetSelector";
import { fleetGroups, toTargetHosts } from "./targets";

/**
 * Cluster Ops: the assistant full screen, with the target picker on the
 * left. The same conversation as the floating panel, so a run started in
 * one shows in the other.
 */
export function OpsPanel(_props: TabProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { targets, fleets } = useAssistant();
  const { hosts: allHosts } = useHosts();
  const hosts = useMemo(() => toTargetHosts(allHosts), [allHosts]);
  const selected = useMemo(() => new Set(targets), [targets]);

  useEffect(() => {
    void assistant.ensureReady();
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <PanelShell
        icon={<ServerCog className="size-4" />}
        title={t("ops.title")}
        docs={docsUrl("cluster-ops")}
        scroll={false}
      >
        <div
          className={`flex min-h-0 flex-1 ${isMobile ? "flex-col" : "flex-row"}`}
        >
          <TargetSelector
            hosts={hosts}
            fleets={fleets ? fleetGroups(fleets, hosts) : null}
            selected={selected}
            onChange={(next) => assistant.setTargets([...next])}
            className={
              isMobile ? "max-h-64 border-b" : "w-64 shrink-0 border-r"
            }
          />
          <AssistantChat />
        </div>
      </PanelShell>
    </div>
  );
}
