import { useEffect, useState } from "react";
import {
  useSettings,
  type CompanionDefaults,
  type CompanionProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { TerminalAiPanel } from "./TerminalAiPanel";

// Screen text the toolbar button hands a panel before it opens, by tab.
const pending = new Map<string, string>();
const listeners = new Set<() => void>();

/** Leaves terminal output for the panel of the tab with this key. */
export function setPendingContext(tabKey: string, text: string): void {
  pending.set(tabKey, text);
  for (const listener of listeners) listener();
}

/** Clears handed over context, for tests. */
export function resetPendingContext(): void {
  pending.clear();
}

/** Starting state of the panel, from the user's settings. */
export function useAiCompanionDefaults(): CompanionDefaults {
  const { values } = useSettings("user");
  const side = values.companionSide;
  return {
    open: values.companionAutoOpen === true,
    side: side === "left" || side === "bottom" ? side : "right",
    size: typeof values.companionSize === "number" ? values.companionSize : 400,
    edgeButton: values.companionEdgeButton !== false,
  };
}

/** The assistant beside a terminal, for that terminal's host. */
export function AiCompanion({
  tab,
  host,
  getHandle,
  isVisible,
  close,
}: CompanionProps) {
  const tabKey = tab.instanceId ?? tab.id;
  const [context, setContext] = useState("");

  useEffect(() => {
    const take = () => {
      const text = pending.get(tabKey);
      if (text === undefined) return;
      pending.delete(tabKey);
      setContext(text);
    };
    take();
    listeners.add(take);
    return () => {
      listeners.delete(take);
    };
  }, [tabKey, isVisible]);

  if (!host) return null;
  return (
    <TerminalAiPanel
      embedded
      hostLabel={host.name || host.ip}
      hostId={Number(host.id)}
      activeTab={`terminal:${host.name || host.ip || ""}`}
      initialContext={context}
      onClose={close}
      onRunInTerminal={(command) => {
        const handle = getHandle() as {
          sendInput?: (data: string) => void;
        } | null;
        handle?.sendInput?.(`${command}\r`);
      }}
    />
  );
}
