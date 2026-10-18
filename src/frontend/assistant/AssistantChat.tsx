import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useHosts, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  ListRow,
  PanelList,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@termix-ssh/plugin-sdk/ui";
import {
  ChartColumn,
  FoldVertical,
  History,
  Loader2,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { AiMessage } from "../AiMessage";
import { AiThinking } from "../AiThinking";
import { AiToolCall } from "../AiToolCall";
import { useReportLanguage } from "../autoops/report-language";
import { aiApp } from "../app-ref";
import { assistantTimeline } from "../transcript";
import { CONTEXT_SOURCE_KEYS } from "../ai-api";
import { formatTokens } from "../usage/format";
import { UsageView } from "../usage/UsageView";
import { activeMentionQuery } from "../mention-query";
import { OPS_RUN_TOOLS, OpsRunCard } from "../ops/OpsRunCard";
import {
  mentionTargets,
  targetChips,
  targetGroups,
  toTargetHosts,
  type TargetChip,
} from "../ops/targets";
import { shortcutLabel } from "./hotkey";
import { currentPage, performClientAction } from "./shell";
import { assistant, useAssistant } from "./store";

/**
 * The assistant's conversation, history and composer, shared by the floating
 * panel and the AI tab. Everything lives in the store, so both show the same
 * run. Targets only appear for a user with a shell on hosts.
 */

function Transcript() {
  const { t } = useTranslation();
  const state = useAssistant();
  const scrollRef = useRef<HTMLDivElement>(null);
  const timeline = assistantTimeline(state.history, state.live);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [state.live, state.history.length]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
    >
      {timeline.length === 0 && !state.streaming && (
        <EmptyState
          icon={Sparkles}
          title={t("assistant.emptyTitle")}
          hint={`${t(
            state.hostShell
              ? "assistant.emptyHint"
              : "assistant.emptyHintBasic",
          )} ${t("assistant.shortcutHint", { shortcut: shortcutLabel() })}`}
        />
      )}
      {timeline.map((item, index) => {
        if (item.kind === "message") {
          return (
            <AiMessage key={item.key} role={item.role} content={item.content} />
          );
        }
        if (item.kind === "thinking") {
          return (
            <AiThinking
              key={item.key}
              content={item.content}
              active={
                item.live && state.streaming && index === timeline.length - 1
              }
            />
          );
        }
        if (item.kind === "compacted") {
          return (
            <div
              key={item.key}
              role="note"
              className="flex items-center gap-2 text-[11px] text-muted-foreground"
            >
              <span className="h-px flex-1 bg-border" />
              <FoldVertical size={11} />
              {t("assistant.compacted")}
              <span className="h-px flex-1 bg-border" />
            </div>
          );
        }
        const streaming = item.live && state.streaming;
        return OPS_RUN_TOOLS.has(item.tool.name) ? (
          <OpsRunCard key={item.key} tool={item.tool} streaming={streaming} />
        ) : (
          <AiToolCall key={item.key} tool={item.tool} streaming={streaming} />
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
  );
}

function Conversations({ onPicked }: { onPicked: () => void }) {
  const { t } = useTranslation();
  const state = useAssistant();

  async function remove(id: number) {
    const confirmed = await aiApp().confirm({
      title: t("assistant.deleteConfirm"),
    });
    if (confirmed) await assistant.deleteConversation(id);
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <PanelList
        empty={
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t("assistant.noConversations")}
          </p>
        }
      >
        {state.conversations.map((conversation) => (
          <ListRow
            key={conversation.id}
            title={conversation.title || t("assistant.untitled")}
            meta={[
              new Date(conversation.updatedAt).toLocaleString(),
              conversation.totalTokens
                ? t("assistant.conversationTokens", {
                    tokens: formatTokens(conversation.totalTokens),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            selected={conversation.id === state.conversationId}
            onClick={() => {
              void assistant.openConversation(conversation.id);
              onPicked();
            }}
            actions={
              <Button
                size="icon"
                variant="ghost"
                className="size-6"
                aria-label={t("assistant.deleteConversation")}
                onClick={(event) => {
                  event.stopPropagation();
                  void remove(conversation.id);
                }}
              >
                <Trash2 size={12} />
              </Button>
            }
          />
        ))}
      </PanelList>
    </div>
  );
}

function Chip({ chip, onRemove }: { chip: TargetChip; onRemove: () => void }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex max-w-48 items-center gap-1 border border-border bg-muted/50 px-1.5 py-0.5 text-[11px]">
      <span className="text-muted-foreground">
        {t(`assistant.kind.${chip.kind}`)}
      </span>
      <span className="truncate">{chip.label}</span>
      {chip.kind !== "host" && (
        <span className="text-muted-foreground">{chip.hostIds.length}</span>
      )}
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground"
        aria-label={t("assistant.removeTarget", { name: chip.label })}
        onClick={onRemove}
      >
        <X size={10} />
      </button>
    </span>
  );
}

function Composer() {
  const { t } = useTranslation();
  const state = useAssistant();
  const { hosts: allHosts } = useHosts();
  const hosts = useMemo(() => toTargetHosts(allHosts), [allHosts]);
  const groups = useMemo(
    () => targetGroups(hosts, state.fleets),
    [hosts, state.fleets],
  );
  const selected = useMemo(() => new Set(state.targets), [state.targets]);
  const chips = targetChips(selected, hosts, groups);

  const [input, setInput] = useState("");
  const [mention, setMention] = useState<{
    query: string;
    start: number;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const matches =
    mention && state.hostShell
      ? mentionTargets(hosts, groups, mention.query)
      : [];

  const updateMention = (value: string, caret: number) => {
    setMention(activeMentionQuery(value, caret));
    setMentionIndex(0);
  };

  /** Adds the chip's hosts and drops the "@partial" it was picked from. */
  const pick = (chip: TargetChip) => {
    if (!mention) return;
    const end = mention.start + 1 + mention.query.length;
    setInput(input.slice(0, mention.start) + input.slice(end));
    setMention(null);
    assistant.setTargets([...new Set([...state.targets, ...chip.hostIds])]);
  };

  const remove = (chip: TargetChip) =>
    assistant.setTargets(
      state.targets.filter((id) => !chip.hostIds.includes(id)),
    );

  const canSend =
    Boolean(input.trim()) && Boolean(state.providerId) && !state.streaming;
  const placeholder = t(
    state.hostShell
      ? "assistant.inputPlaceholder"
      : "assistant.inputPlaceholderBasic",
  );

  function send() {
    if (!canSend) return;
    const message = input;
    setInput("");
    setMention(null);
    void assistant.send(message, currentPage(aiApp(), allHosts));
  }

  return (
    <div className="relative shrink-0 border-t border-border p-3">
      {state.hostShell && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1">
          {chips.length ? (
            chips.map((chip) => (
              <Chip key={chip.key} chip={chip} onRemove={() => remove(chip)} />
            ))
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {t("assistant.noTargets")}
            </span>
          )}
        </div>
      )}
      {matches.length > 0 && (
        <ul
          role="listbox"
          className="absolute bottom-full left-3 right-3 z-10 max-h-56 overflow-y-auto border border-border bg-background text-xs"
        >
          {matches.map((chip, index) => (
            <li
              key={chip.key}
              role="option"
              aria-selected={index === mentionIndex}
              className={`flex cursor-pointer items-center gap-2 px-2 py-1 ${
                index === mentionIndex ? "bg-muted" : ""
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(chip);
              }}
            >
              <span className="w-12 shrink-0 text-muted-foreground">
                {t(`assistant.kind.${chip.kind}`)}
              </span>
              <span className="min-w-0 flex-1 truncate">{chip.label}</span>
              <span className="text-[10px] text-muted-foreground">
                {t("ops.hostCount", { count: chip.hostIds.length })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Textarea
        aria-label={placeholder}
        className="min-h-[64px] resize-none rounded-none text-sm"
        value={input}
        placeholder={placeholder}
        disabled={!state.providerId}
        onChange={(event) => {
          setInput(event.target.value);
          updateMention(
            event.target.value,
            event.target.selectionStart ?? event.target.value.length,
          );
        }}
        onKeyDown={(event) => {
          if (matches.length > 0) {
            const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
            if (step) {
              event.preventDefault();
              setMentionIndex(
                (i) => (i + step + matches.length) % matches.length,
              );
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              pick(matches[mentionIndex]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setMention(null);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
          {!state.hostShell
            ? t("assistant.sendHintBasic")
            : state.targets.length
              ? t("ops.sendHint", { count: state.targets.length })
              : t("assistant.sendHint")}
        </p>
        {state.streaming ? (
          <Button size="sm" variant="outline" onClick={assistant.stop}>
            <Square size={14} />
            {t("ai.stop")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="border-accent-brand/40 text-accent-brand hover:bg-accent-brand/10 hover:text-accent-brand"
            disabled={!canSend}
            onClick={send}
          >
            <Send size={14} />
            {t("ai.send")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** How full the model's context is, after the latest call. */
function ContextMeter() {
  const { t } = useTranslation();
  const { context } = useAssistant();
  if (!context?.contextWindow) return null;
  const share = context.promptTokens / context.contextWindow;
  const tone =
    share >= 0.8
      ? "text-destructive"
      : share >= 0.6
        ? "text-amber-500"
        : "text-muted-foreground";
  // A window nobody reported or set is a guess, and says so.
  const source = context.contextSource ?? "guess";
  const guessed = source === "guess" || source === "default";
  const label = `${context.estimated ? "~" : ""}${formatTokens(
    context.promptTokens,
  )} / ${guessed ? "~" : ""}${formatTokens(context.contextWindow)}`;
  const description = [
    t("assistant.contextMeter", {
      used: context.promptTokens.toLocaleString(),
      window: context.contextWindow.toLocaleString(),
    }),
    t("assistant.contextMeterSource", {
      source: t(CONTEXT_SOURCE_KEYS[source]),
    }),
    context.reservedOutput
      ? t("assistant.contextMeterReserved", {
          tokens: context.reservedOutput.toLocaleString(),
        })
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={`shrink-0 px-1 text-[11px] tabular-nums ${tone}`}
      title={description}
      aria-label={description}
    >
      {label}
    </span>
  );
}

type Pane = "chat" | "history" | "usage";

/** `actions` are the hosting view's own buttons, at the end of the header. */
export function AssistantChat({ actions }: { actions?: ReactNode }) {
  const { t } = useTranslation();
  useReportLanguage();
  const state = useAssistant();
  const [pane, setPane] = useState<Pane>("chat");
  const showHistory = pane === "history";
  const toggle = (next: Pane) =>
    setPane((current) => (current === next ? "chat" : next));

  async function compact() {
    const compacted = await assistant.compact();
    if (!compacted && !assistant.get().error) {
      toast(t("assistant.nothingToCompact"));
    }
  }

  useEffect(() => {
    void assistant.ensureReady();
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {state.providers.length > 0 ? (
          <Select
            value={state.providerId ? String(state.providerId) : undefined}
            onValueChange={(value) => assistant.setProvider(Number(value))}
          >
            <SelectTrigger className="h-7 w-44 min-w-0 rounded-none text-xs">
              <SelectValue placeholder={t("ai.selectProvider")} />
            </SelectTrigger>
            <SelectContent>
              {state.providers.map((provider) => (
                <SelectItem key={provider.id} value={String(provider.id)}>
                  {provider.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            title={t("ai.noProvidersConfigured")}
            onClick={() =>
              performClientAction(aiApp(), {
                kind: "open_settings",
                page: "plugin:ai",
              })
            }
          >
            <Plus size={14} />
            {t("ai.addProvider")}
          </Button>
        )}
        <span className="ml-auto" />
        <ContextMeter />
        <Button
          size="sm"
          variant={pane === "usage" ? "secondary" : "ghost"}
          className="h-7 shrink-0 gap-1 px-1.5 text-[11px] tabular-nums"
          aria-label={t("assistant.usage")}
          title={t("assistant.todayTitle")}
          aria-pressed={pane === "usage"}
          onClick={() => toggle("usage")}
        >
          <ChartColumn size={13} />
          {state.todayTokens !== null &&
            t("assistant.todayTokens", {
              tokens: formatTokens(state.todayTokens),
            })}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("assistant.compact")}
          title={t("assistant.compact")}
          disabled={
            state.streaming || state.compacting || !state.conversationId
          }
          onClick={() => void compact()}
        >
          {state.compacting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <FoldVertical size={14} />
          )}
        </Button>
        <Button
          size="icon"
          variant={showHistory ? "secondary" : "ghost"}
          className="size-7"
          aria-label={t("assistant.history")}
          title={t("assistant.history")}
          aria-pressed={showHistory}
          disabled={state.streaming}
          onClick={() => {
            if (!showHistory) void assistant.loadConversations();
            toggle("history");
          }}
        >
          <History size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("ops.newConversation")}
          title={t("ops.newConversation")}
          disabled={
            state.streaming || (!state.history.length && !state.conversationId)
          }
          onClick={() => {
            assistant.newConversation();
            setPane("chat");
          }}
        >
          <Plus size={14} />
        </Button>
        {actions}
      </div>
      {pane === "history" ? (
        <Conversations onPicked={() => setPane("chat")} />
      ) : pane === "usage" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <UsageView />
        </div>
      ) : (
        <>
          <Transcript />
          <Composer />
        </>
      )}
    </div>
  );
}
