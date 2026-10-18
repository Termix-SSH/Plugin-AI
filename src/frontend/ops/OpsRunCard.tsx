import { useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { ListBadge } from "@termix-ssh/plugin-sdk/ui";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  SquareTerminal,
} from "lucide-react";
import type { HostProgress, ToolActivity } from "../use-ai-stream";

/** The tools whose calls render as a per-host card. */
export const OPS_RUN_TOOLS = new Set(["run_command", "get_host_facts"]);

export function hostFailed(host: HostProgress): boolean {
  return Boolean(
    host.error || host.timedOut || host.aborted || host.exitCode !== 0,
  );
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim()) ?? "";
}

function HostRow({ host }: { host: HostProgress }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const failed = hostFailed(host);
  const output = host.error ?? host.output;

  const status = host.timedOut
    ? t("ops.timedOut")
    : host.aborted
      ? t("ops.stopped")
      : host.exitCode === null
        ? t("ops.notRun")
        : t("ops.exitCode", { code: host.exitCode });

  return (
    <li className="border-t border-border">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="w-28 shrink-0 truncate font-medium">{host.name}</span>
        <ListBadge tone={failed ? "destructive" : "success"}>
          {status}
        </ListBadge>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {host.cached
            ? t("ops.cached")
            : t("ops.duration", {
                seconds: (host.durationMs / 1000).toFixed(1),
              })}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
          {firstLine(output)}
        </span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-background px-2 py-1.5 font-mono">
          {output || t("ops.noOutput")}
        </pre>
      )}
    </li>
  );
}

/**
 * A run_command or get_host_facts call: what ran, on how many hosts, how it
 * went, and each host as it finishes. A row opens to the captured output.
 */
export function OpsRunCard({
  tool,
  streaming = false,
}: {
  tool: ToolActivity;
  streaming?: boolean;
}) {
  const { t } = useTranslation();
  const hosts = tool.progress ?? [];
  const pending = !("result" in tool) && streaming;
  const failed = hosts.filter(hostFailed).length;
  const requested = Array.isArray(tool.arguments.hostIds)
    ? tool.arguments.hostIds.length
    : hosts.length;
  const command =
    typeof tool.arguments.command === "string" ? tool.arguments.command : null;
  // A call refused before anything ran, like a host outside the targets.
  const refused = (tool.result as { error?: unknown } | undefined)?.error;

  return (
    <div className="rounded-none border border-border bg-muted/50 text-xs">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        {pending ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <SquareTerminal size={12} />
        )}
        <span className="font-medium">
          {tool.name === "run_command"
            ? t("ops.runCommand")
            : t("ops.hostFacts")}
        </span>
        <span className="text-muted-foreground">
          {t("ops.hostCount", { count: requested })}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <ListBadge tone="success">
            {t("ops.succeeded", { count: hosts.length - failed })}
          </ListBadge>
          {failed > 0 && (
            <ListBadge tone="destructive">
              {t("ops.failed", { count: failed })}
            </ListBadge>
          )}
        </span>
      </div>
      {command && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-border px-2 py-1.5 font-mono">
          {command}
        </pre>
      )}
      {typeof refused === "string" && (
        <p className="border-t border-border px-2 py-1.5 text-destructive">
          {refused}
        </p>
      )}
      {hosts.length > 0 && (
        <ul>
          {hosts.map((host) => (
            <HostRow key={host.hostId} host={host} />
          ))}
        </ul>
      )}
    </div>
  );
}
