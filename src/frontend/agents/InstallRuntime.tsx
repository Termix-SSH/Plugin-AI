import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button } from "@termix-ssh/plugin-sdk/ui";
import { Download, Network } from "lucide-react";
import { aiApp } from "../app-ref";
import type { AgentKind } from "../../backend/agents/types";

export function InstallRuntime({
  hostId,
  agent,
  busy,
  setBusy,
}: {
  hostId: number;
  agent: AgentKind;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [log, setLog] = useState("");
  const [result, setResult] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function install(operation: "install" | "forwarding") {
    const failed =
      operation === "install"
        ? "agents.installFailed"
        : "agents.forwardingFailed";
    setBusy(true);
    setLog("");
    setResult("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await aiApp().fetch(`agents/${operation}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId, agent }),
        signal: controller.signal,
      });
      if (!response.ok) throw Error((await response.json()).error || t(failed));
      if (!response.body) throw Error(t(failed));
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        completed = false;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let n: number;
        while ((n = buffer.indexOf("\n")) >= 0) {
          const event = JSON.parse(buffer.slice(0, n));
          buffer = buffer.slice(n + 1);
          if (event.log) setLog((old) => (old + event.log).slice(-64000));
          if (event.done) {
            completed = true;
            if (!event.success) throw Error(event.error || t(failed));
            setResult(
              t(
                operation === "install"
                  ? "agents.installSucceeded"
                  : "agents.forwardingSucceeded",
              ),
            );
          }
        }
      }
      if (!completed) throw Error(t(failed));
    } catch (error) {
      if (!controller.signal.aborted)
        setResult(error instanceof Error ? error.message : t(failed));
    } finally {
      request.current = null;
      setBusy(false);
    }
  }
  const rows = [
    {
      operation: "install" as const,
      icon: <Download className="size-3.5" />,
      label: t("agents.installRuntime"),
      hint: t("agents.installSource"),
    },
    {
      operation: "forwarding" as const,
      icon: <Network className="size-3.5" />,
      label: t("agents.enableForwarding"),
      hint: t("agents.forwardingScope"),
    },
  ];
  return (
    <div className="border border-border">
      {rows.map((row, i) => (
        <div
          key={row.operation}
          className={`flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-2.5 ${i > 0 ? "border-t border-border" : ""}`}
        >
          <p className="min-w-60 flex-1 text-[11px] leading-snug text-muted-foreground">
            {row.hint}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={busy}
            onClick={() => void install(row.operation)}
          >
            {row.icon}
            {row.label}
          </Button>
        </div>
      ))}
      {result && (
        <p
          role="status"
          className="border-t border-border bg-muted/20 px-3 py-2 text-xs"
        >
          {result}
        </p>
      )}
      {log && (
        <pre
          aria-label={t("agents.installLog")}
          className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-border bg-muted/20 px-3 py-2 font-mono text-[11px] thin-scrollbar"
        >
          {log}
        </pre>
      )}
    </div>
  );
}
