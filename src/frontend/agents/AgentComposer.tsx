import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  GroupHeading,
  ListRowAction,
  PROMPT_BUTTON,
  PROMPT_PRIMARY_BUTTON,
  Textarea,
  useIsMobile,
} from "@termix-ssh/plugin-sdk/ui";
import {
  Check,
  ListPlus,
  Paperclip,
  Pause,
  Pencil,
  Play,
  SendHorizontal,
  Square,
  Trash2,
} from "lucide-react";
import type { AgentSession } from "../../backend/agents/types";
import { aiApp } from "../app-ref";
import {
  AttachmentButtons,
  AttachmentChips,
  useAttachments,
} from "./Attachments";

export interface SessionActions {
  session: AgentSession;
  busy: boolean;
  action: (fn: () => Promise<void>) => Promise<void>;
  onUpdated: (s: AgentSession) => void;
}
export function AgentComposer({
  session: s,
  busy,
  action,
  onUpdated,
  onComposition,
}: SessionActions & { onComposition: (value: boolean) => void }) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [text, setText] = useState(s.draft ?? "");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const composing = useRef(false);
  const draft = useRef({ text, changed: false });
  const draftWrites = useRef(Promise.resolve());
  const persistDraft = useCallback(() => {
    if (!draft.current.changed) return;
    const value = draft.current.text;
    draft.current.changed = false;
    draftWrites.current = draftWrites.current
      .catch(() => undefined)
      .then(async () => {
        await aiApp().api.patch(`/agents/${s.id}`, { draft: value });
      });
    return draftWrites.current;
  }, [s.id]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void persistDraft()?.catch(() => {
        draft.current.changed = true;
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [text, persistDraft]);
  useEffect(
    () => () => {
      void persistDraft()?.catch(() => undefined);
    },
    [persistDraft],
  );
  function change(value: string) {
    draft.current = { text: value, changed: true };
    setText(value);
  }
  async function refresh() {
    onUpdated((await aiApp().api.get<AgentSession>(`/agents/${s.id}`)).data);
  }
  async function queue(body: unknown) {
    await aiApp().api.post(`/agents/${s.id}/queue`, body);
    await refresh();
  }
  const attachmentProps = {
    session: s,
    busy,
    action,
    onUpdated,
    selected: attachmentIds,
    onSelected: setAttachmentIds,
  };
  const { upload } = useAttachments(attachmentProps);
  const running = s.status === "running";
  const queued = running || !!s.queue?.length;
  const canSend =
    !busy &&
    !s.archived &&
    ["ready", "running"].includes(s.status) &&
    (!!text.trim() || !!attachmentIds.length);
  return (
    <div className="shrink-0 border-t border-border">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-3">
        {!!s.queue?.length && (
          <section
            aria-label={t("agents.queue")}
            className="flex max-h-48 flex-col gap-1.5 overflow-y-auto thin-scrollbar"
          >
            <GroupHeading
              title={t("agents.queue")}
              count={s.queue.length}
              action={
                <button
                  type="button"
                  className={PROMPT_BUTTON}
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      queue({
                        operation: s.queuePaused ? "continue" : "pause",
                      }),
                    )
                  }
                >
                  {s.queuePaused ? (
                    <Play className="size-3" />
                  ) : (
                    <Pause className="size-3" />
                  )}
                  {t(
                    s.queuePaused
                      ? "agents.continueQueue"
                      : "agents.pauseQueue",
                  )}
                </button>
              }
            />
            {s.queue.map((p) => (
              <div
                key={p.id}
                className="flex items-start gap-2 border border-border bg-muted/20 px-2.5 py-1.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  {editing === p.id ? (
                    <Textarea
                      aria-label={t("agents.editQueued")}
                      className="min-h-[56px] text-xs"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                    />
                  ) : (
                    <p className="whitespace-pre-wrap break-words">{p.text}</p>
                  )}
                  {!!p.attachmentIds.length && (
                    <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                      <Paperclip className="size-3 shrink-0" />
                      {p.attachmentIds
                        .map(
                          (id) => s.attachments?.find((a) => a.id === id)?.name,
                        )
                        .join(", ")}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  <ListRowAction
                    label={t(
                      editing === p.id ? "agents.save" : "agents.editQueued",
                    )}
                    tone={editing === p.id ? "brand" : "default"}
                    disabled={busy}
                    onClick={() => {
                      if (editing !== p.id) {
                        setEditing(p.id);
                        setEditText(p.text);
                        return;
                      }
                      void action(async () => {
                        await queue({
                          operation: "update",
                          id: p.id,
                          text: editText,
                          attachmentIds: p.attachmentIds,
                        });
                        setEditing(null);
                      });
                    }}
                  >
                    {editing === p.id ? <Check /> : <Pencil />}
                  </ListRowAction>
                  <ListRowAction
                    label={t("agents.remove")}
                    tone="destructive"
                    disabled={busy}
                    onClick={() =>
                      void action(() =>
                        queue({ operation: "remove", id: p.id }),
                      )
                    }
                  >
                    <Trash2 />
                  </ListRowAction>
                </div>
              </div>
            ))}
          </section>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSend) return;
            void action(async () => {
              if (queued)
                await queue({ operation: "add", text, attachmentIds });
              else {
                await aiApp().api.post(`/agents/${s.id}/input`, {
                  type: "prompt",
                  text,
                  attachmentIds,
                });
                await refresh();
              }
              change("");
              setAttachmentIds([]);
              await persistDraft();
            });
          }}
        >
          <div
            className="flex flex-col border border-input transition-colors focus-within:border-ring dark:bg-input/30"
            onPaste={(e) => {
              const image = Array.from(e.clipboardData.items)
                .find((i) => i.type.startsWith("image/"))
                ?.getAsFile();
              if (!image || busy) return;
              e.preventDefault();
              void action(() => upload(image));
            }}
          >
            <AttachmentChips {...attachmentProps} />
            <Textarea
              aria-label={t("agents.prompt")}
              placeholder={t("agents.prompt")}
              className="min-h-[72px] resize-none border-0 bg-transparent text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
              value={text}
              onChange={(e) => change(e.target.value)}
              rows={3}
              onCompositionStart={() => {
                composing.current = true;
                onComposition(true);
              }}
              onCompositionEnd={() => {
                composing.current = false;
                onComposition(false);
              }}
              onKeyDown={(e) => {
                if (
                  e.key !== "Enter" ||
                  e.shiftKey ||
                  e.ctrlKey ||
                  e.altKey ||
                  e.metaKey ||
                  e.nativeEvent.isComposing ||
                  e.nativeEvent.keyCode === 229 ||
                  composing.current
                )
                  return;
                e.preventDefault();
                if (!e.repeat) e.currentTarget.form?.requestSubmit();
              }}
            />
            <div className="flex items-center gap-2 border-t border-border/60 px-1 py-1">
              <AttachmentButtons {...attachmentProps} />
              {!isMobile && (
                <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/80">
                  {t("agents.shortcuts")}
                </span>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {running && (
                  <button
                    type="button"
                    className={PROMPT_BUTTON}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await aiApp().api.post(`/agents/${s.id}/input`, {
                          type: "cancel",
                        });
                        await refresh();
                      })
                    }
                  >
                    <Square className="size-3" />
                    {t("agents.interrupt")}
                  </button>
                )}
                <button
                  type="submit"
                  className={PROMPT_PRIMARY_BUTTON}
                  disabled={!canSend}
                >
                  {queued ? (
                    <ListPlus className="size-3.5" />
                  ) : (
                    <SendHorizontal className="size-3.5" />
                  )}
                  {t(queued ? "agents.enqueue" : "agents.send")}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
