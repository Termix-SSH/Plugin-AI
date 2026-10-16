import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useHosts,
  useTranslation,
  type TabProps,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  PanelShell,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useIsMobile,
} from "@termix-ssh/plugin-sdk/ui";
import { Loader2, Plus, Send, ServerCog, Square } from "lucide-react";
import {
  AI_PROVIDERS_CHANGED_EVENT,
  getAiProviders,
  getAiStatus,
  getOpsFleets,
  setAiOptIn,
  type AiProvider,
  type OpsFleet,
} from "../ai-api";
import { AiMessage } from "../AiMessage";
import { AiToolCall } from "../AiToolCall";
import { docsUrl } from "../docs";
import {
  buildTimeline,
  finishedRunEntries,
  userEntry,
  type HistoryEntry,
} from "../transcript";
import { useAiStream, type ToolActivity } from "../use-ai-stream";
import { OPS_RUN_TOOLS, OpsRunCard } from "./OpsRunCard";
import { TargetSelector } from "./TargetSelector";
import { fleetGroups, toTargetHosts } from "./targets";

/**
 * Cluster Ops: pick hosts on the left, tell the assistant what to do on the
 * right. Every message carries the current selection, which becomes the
 * conversation's targets on the server.
 */
export function OpsPanel(_props: TabProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { state, send, stop, reset } = useAiStream();
  const { hosts: allHosts } = useHosts();
  const hosts = useMemo(() => toTargetHosts(allHosts), [allHosts]);

  const [fleets, setFleets] = useState<OpsFleet[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [providerId, setProviderId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const runCountRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadProviders = useCallback(async () => {
    const list = await getAiProviders().catch(() => []);
    setProviders(list);
    setProviderId((current) =>
      current && list.some((entry) => entry.id === current)
        ? current
        : (list[0]?.id ?? null),
    );
  }, []);

  useEffect(() => {
    void (async () => {
      // Opening the tab is consent, as in the assistant panel; every route
      // sits behind the user's own opt-in.
      const status = await getAiStatus().catch(() => null);
      if (status?.globallyEnabled && !status.enabled) {
        await setAiOptIn(true).catch(() => undefined);
      }
      await loadProviders();
      const result = await getOpsFleets().catch(() => null);
      setFleets(result?.available ? result.fleets : null);
    })();
    const reload = () => void loadProviders();
    window.addEventListener(AI_PROVIDERS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(AI_PROVIDERS_CHANGED_EVENT, reload);
  }, [loadProviders]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [state.assistantText, state.tools, history.length]);

  const keepRun = useCallback(
    (_conversationId: number | null, reply: string, tools: ToolActivity[]) => {
      const runId = runCountRef.current++;
      setHistory((prev) => [
        ...prev,
        ...finishedRunEntries(runId, tools, reply),
      ]);
    },
    [],
  );

  const canSend =
    Boolean(input.trim()) &&
    Boolean(providerId) &&
    selected.size > 0 &&
    !state.streaming;

  async function handleSend() {
    const message = input.trim();
    if (!canSend || !providerId) return;
    setInput("");
    setHistory((prev) => [...prev, userEntry(message)]);
    await send({
      message,
      providerId,
      conversationId: state.conversationId,
      endpoint: "ops/chat",
      extra: { hostIds: [...selected] },
      onComplete: keepRun,
    });
  }

  function newConversation() {
    stop();
    reset();
    setHistory([]);
  }

  const timeline = buildTimeline(history, state, []);

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
            onChange={setSelected}
            className={
              isMobile ? "max-h-64 border-b" : "w-64 shrink-0 border-r"
            }
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              {providers.length > 0 ? (
                <Select
                  value={providerId ? String(providerId) : undefined}
                  onValueChange={(value) => setProviderId(Number(value))}
                >
                  <SelectTrigger className="h-7 w-56 min-w-0 rounded-none text-xs">
                    <SelectValue placeholder={t("ai.selectProvider")} />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((provider) => (
                      <SelectItem key={provider.id} value={String(provider.id)}>
                        {provider.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t("ai.noProvidersConfigured")}
                </span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={!history.length && !state.conversationId}
                onClick={newConversation}
              >
                <Plus size={14} />
                {t("ops.newConversation")}
              </Button>
            </div>

            <div
              ref={scrollRef}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
            >
              {timeline.length === 0 && !state.streaming && (
                <EmptyState
                  icon={ServerCog}
                  title={t("ops.emptyTitle")}
                  hint={t("ops.emptyHint")}
                />
              )}
              {timeline.map((item) => {
                if (item.kind === "message") {
                  return (
                    <AiMessage
                      key={item.key}
                      role={item.role}
                      content={item.content}
                    />
                  );
                }
                if (item.kind !== "tool") return null;
                const streaming = item.live && state.streaming;
                return OPS_RUN_TOOLS.has(item.tool.name) ? (
                  <OpsRunCard
                    key={item.key}
                    tool={item.tool}
                    streaming={streaming}
                  />
                ) : (
                  <AiToolCall
                    key={item.key}
                    tool={item.tool}
                    streaming={streaming}
                  />
                );
              })}
              {state.streaming && (
                <div
                  role="status"
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <Loader2 className="size-3.5 animate-spin text-accent-brand" />
                  {t("agents.working")}
                </div>
              )}
              {state.error && (
                <div className="rounded-none border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {state.error}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-border p-3">
              <Textarea
                aria-label={t("ops.inputPlaceholder")}
                className="min-h-[64px] resize-none rounded-none text-sm"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={t("ops.inputPlaceholder")}
                disabled={!providerId}
              />
              <div className="mt-1.5 flex items-center gap-2">
                <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
                  {selected.size
                    ? t("ops.sendHint", { count: selected.size })
                    : t("ops.noTargets")}
                </p>
                {state.streaming ? (
                  <Button size="sm" variant="outline" onClick={stop}>
                    <Square size={14} />
                    {t("ai.stop")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-accent-brand/40 text-accent-brand hover:bg-accent-brand/10 hover:text-accent-brand"
                    disabled={!canSend}
                    onClick={() => void handleSend()}
                  >
                    <Send size={14} />
                    {t("ai.send")}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </PanelShell>
    </div>
  );
}
