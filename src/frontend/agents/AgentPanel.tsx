import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation, type TabProps } from "@termix-ssh/plugin-sdk/frontend";
import {
  AddButton,
  Button,
  ListBadge,
  ListRow,
  PanelList,
  PanelSearch,
  PanelShell,
  Segmented,
  useIsMobile,
} from "@termix-ssh/plugin-sdk/ui";
import {
  AlertCircle,
  Bot,
  GitBranch,
  Loader2,
  Play,
  Square,
  X,
} from "lucide-react";
import { useAgentStream } from "./useAgentStream";
import { ReviewPane, SessionTitle } from "./SessionTools";
import { AgentComposer } from "./AgentComposer";
import { AgentTranscript } from "./AgentTranscript";
import { NewSessionForm, type NewSessionDraft } from "./NewSessionForm";
import { agentNames, statusTone } from "./agent-labels";
import { aiApp } from "../app-ref";
import { docsUrl } from "../docs";
import {
  AI_PROVIDERS_CHANGED_EVENT,
  AI_STATUS_CHANGED_EVENT,
  getAiProviders,
  type AiProvider,
} from "../ai-api";
import type { AgentEvent, AgentSession } from "../../backend/agents/types";

const blankDraft: NewSessionDraft = {
  agent: "pi",
  providerId: 0,
  model: "",
  cwd: "/tmp",
  executable: "",
};

function message(error: unknown): string {
  const e = error as {
    response?: { data?: { error?: string } };
    message?: string;
  };
  return e.response?.data?.error || e.message || "Agent request failed";
}

export function AgentPanel({ host, sshHost }: TabProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const target = host ?? sshHost;
  const hostId = Number(target?.id);
  const [providers, setProviders] = useState<AiProvider[]>([]),
    [sessions, setSessions] = useState<AgentSession[]>([]);
  const [draft, setDraft] = useState<NewSessionDraft>(blankDraft);
  const [active, setActive] = useState<AgentSession | null>(null),
    [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const composing = useRef(false);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");
  const loadProviders = useCallback(async () => {
    const list = (await getAiProviders()).filter((x) => x.enabled);
    setProviders(list);
    // Drop a choice whose provider was removed or turned off.
    setDraft((d) =>
      list.some((p) => p.id === d.providerId) ? d : { ...d, providerId: 0 },
    );
  }, []);
  // Loaded separately, so one failing never hides the other.
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      loadProviders(),
      aiApp()
        .api.get<{ sessions: AgentSession[] }>("/agents")
        .then((s) =>
          setSessions(s.data.sessions.filter((x) => x.hostId === hostId)),
        ),
    ]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }, [hostId, loadProviders]);
  useEffect(() => {
    void refresh().catch((e) => setError(message(e)));
  }, [refresh]);
  // The tab stays mounted, so pick up providers added in settings meanwhile.
  useEffect(() => {
    const reload = () => void loadProviders().catch(() => {});
    const events = [AI_PROVIDERS_CHANGED_EVENT, AI_STATUS_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, reload);
    return () => {
      for (const event of events) window.removeEventListener(event, reload);
    };
  }, [loadProviders]);
  const activeId = active?.id;
  const connection = useAgentStream(
    activeId,
    generation,
    (s) => {
      setActive((old) => (old?.id === s.id ? s : old));
      setEvents((old) =>
        [
          ...s.events,
          ...old.filter((e) => e.seq > (s.events.at(-1)?.seq ?? 0)),
        ].slice(-2000),
      );
    },
    (e) => {
      setEvents((old) =>
        old.some((x) => x.seq === e.seq) ? old : [...old, e].slice(-2000),
      );
      if (e.kind === "status")
        setActive((old) =>
          old ? { ...old, status: e.text as AgentSession["status"] } : old,
        );
      if (e.kind === "error") setError(e.text);
    },
  );
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function select(id: string) {
    await action(async () => {
      const r = await aiApp().api.get<AgentSession>(`/agents/${id}`);
      setActive(r.data);
      setEvents(r.data.events);
    });
  }
  async function input(body: unknown) {
    if (active) await aiApp().api.post(`/agents/${active.id}/input`, body);
  }
  function startNew(next: NewSessionDraft = blankDraft) {
    setDraft(next);
    setActive(null);
    setEvents([]);
    setReviewOpen(false);
    void refresh().catch((e) => setError(message(e)));
  }

  const visible = sessions.filter(
    (s) =>
      !!s.archived === (view === "archived") &&
      [s.title, s.model, s.cwd]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const archivedCount = sessions.filter((s) => s.archived).length;

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      onKeyDown={(e) => {
        if (
          e.key !== "Escape" ||
          e.defaultPrevented ||
          e.repeat ||
          e.nativeEvent.isComposing ||
          e.nativeEvent.keyCode === 229 ||
          composing.current ||
          busy ||
          active?.status !== "running"
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        void action(() => input({ type: "cancel" }));
      }}
    >
      <PanelShell
        icon={<Bot className="size-4" />}
        title={t("agents.title")}
        status={String(target?.name || target?.ip || "")}
        docs={docsUrl()}
        scroll={false}
      >
        <div
          className={`flex min-h-0 flex-1 ${isMobile ? "flex-col" : "flex-row"}`}
        >
          <aside
            className={`flex shrink-0 flex-col border-border ${isMobile ? "max-h-56 border-b" : "w-64 border-r"}`}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <PanelSearch
                fill
                value={search}
                onChange={setSearch}
                placeholder={t("agents.search")}
              />
              <AddButton
                compact
                label={t("agents.new")}
                onClick={() => startNew()}
              />
            </div>
            <div className="shrink-0 border-b border-border px-3 py-2">
              <Segmented
                className="w-full [&>button]:flex-1"
                value={view}
                onChange={(next) => setView(next as "active" | "archived")}
                options={[
                  {
                    value: "active",
                    label: t("agents.activeSessions"),
                    count: sessions.length - archivedCount,
                  },
                  {
                    value: "archived",
                    label: t("agents.archivedSessions"),
                    count: archivedCount,
                  },
                ]}
              />
            </div>
            <PanelList
              empty={
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t("agents.noSessions")}
                </p>
              }
            >
              {visible.map((s, i) => (
                <ListRow
                  key={s.id}
                  stripe={i}
                  tone={statusTone[s.status] ?? "muted"}
                  selected={active?.id === s.id}
                  title={s.title || `${agentNames[s.agent]} · ${s.model}`}
                  meta={<span className="font-mono">{s.cwd}</span>}
                  badges={
                    s.status === "running" || s.status === "starting" ? (
                      <Loader2 className="size-3 shrink-0 animate-spin text-accent-brand" />
                    ) : undefined
                  }
                  onClick={() => void select(s.id)}
                />
              ))}
            </PanelList>
          </aside>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {error && (
              <div className="flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="mt-px size-3.5 shrink-0" />
                <div
                  role="alert"
                  className="min-w-0 flex-1 whitespace-pre-wrap"
                >
                  {error}
                </div>
                <button
                  type="button"
                  aria-label={t("agents.dismiss")}
                  title={t("agents.dismiss")}
                  className="shrink-0 opacity-70 hover:opacity-100"
                  onClick={() => setError("")}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            {!active ? (
              <NewSessionForm
                hostId={hostId}
                providers={providers}
                draft={draft}
                onDraft={setDraft}
                busy={busy}
                setBusy={setBusy}
                onStart={() =>
                  void action(async () => {
                    const r = await aiApp().api.post<{ id: string }>(
                      "/agents",
                      {
                        hostId,
                        agent: draft.agent,
                        providerId: draft.providerId,
                        model: draft.model,
                        cwd: draft.cwd,
                        executable: draft.executable || undefined,
                      },
                    );
                    const s = await aiApp().api.get<AgentSession>(
                      `/agents/${r.data.id}`,
                    );
                    setActive(s.data);
                    setEvents(s.data.events);
                    await refresh();
                  })
                }
              />
            ) : (
              <>
                <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
                  <SessionTitle
                    key={`title-${active.id}`}
                    session={active}
                    busy={busy}
                    action={action}
                    onUpdated={async (s) => {
                      setActive(s);
                      await refresh();
                    }}
                  />
                  <ListBadge tone={statusTone[active.status] ?? "muted"}>
                    {t(`agents.status.${active.status}`)}
                  </ListBadge>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-pressed={reviewOpen}
                      className={
                        reviewOpen
                          ? "bg-accent-brand/10 text-accent-brand hover:bg-accent-brand/15 hover:text-accent-brand"
                          : "text-muted-foreground"
                      }
                      onClick={() => setReviewOpen((x) => !x)}
                    >
                      <GitBranch />
                      {t("agents.changes")}
                    </Button>
                    {active.status === "stopped" ||
                    active.status === "error" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || active.archived}
                        onClick={() =>
                          void action(async () => {
                            await aiApp().api.post(
                              `/agents/${active.id}/resume`,
                            );
                            setActive({ ...active, status: "starting" });
                            setGeneration((x) => x + 1);
                          })
                        }
                      >
                        <Play />
                        {t("agents.resume")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await aiApp().api.post(`/agents/${active.id}/stop`);
                            setActive({ ...active, status: "stopped" });
                            await refresh();
                          })
                        }
                      >
                        <Square />
                        {t("agents.stop")}
                      </Button>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
                  <span>{agentNames[active.agent]}</span>
                  <span aria-hidden className="h-3 w-px bg-border" />
                  <span className="truncate">{active.model}</span>
                  <span aria-hidden className="h-3 w-px bg-border" />
                  <span className="min-w-0 truncate font-mono">
                    {active.cwd}
                  </span>
                  {connection !== "connected" && (
                    <span
                      role="status"
                      className="ml-auto flex shrink-0 items-center gap-1.5 text-warning"
                    >
                      <Loader2 className="size-3 animate-spin" />
                      {t(`agents.${connection}`)}
                    </span>
                  )}
                </div>
                <div className="flex min-h-0 flex-1">
                  <div
                    className={`min-h-0 min-w-0 flex-1 flex-col ${reviewOpen && isMobile ? "hidden" : "flex"}`}
                  >
                    <AgentTranscript
                      key={`transcript-${active.id}`}
                      session={active}
                      events={events}
                      busy={busy}
                      action={action}
                      input={input}
                    />
                    <AgentComposer
                      key={`composer-${active.id}`}
                      session={active}
                      busy={busy}
                      action={action}
                      onComposition={(value) => {
                        composing.current = value;
                      }}
                      onUpdated={setActive}
                    />
                  </div>
                  {reviewOpen && (
                    <ReviewPane
                      key={`review-${active.id}`}
                      session={active}
                      busy={busy}
                      action={action}
                      onClose={() => setReviewOpen(false)}
                      onWorktree={(path) =>
                        startNew({
                          agent: active.agent,
                          providerId: active.providerId,
                          model: active.model,
                          cwd: path,
                          executable: active.executable,
                        })
                      }
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </PanelShell>
    </div>
  );
}
