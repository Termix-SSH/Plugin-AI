import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  cn,
  Input,
  PROMPT_BUTTON,
  PROMPT_PRIMARY_BUTTON,
} from "@termix-ssh/plugin-sdk/ui";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronRight,
  Loader2,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { AiMessage } from "../AiMessage";
import type { AgentEvent, AgentSession } from "../../backend/agents/types";

function ToolEvent({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const firstLine = text.split("\n", 1)[0];
  return (
    <div className="border border-border bg-muted/20 text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <Wrench className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">{t("agents.tool")}</span>
        <span className="min-w-0 truncate font-mono text-[11px] opacity-70">
          {firstLine}
        </span>
      </button>
      {open && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border px-2.5 py-2 font-mono text-[11px] thin-scrollbar">
          {text}
        </pre>
      )}
    </div>
  );
}

function PermissionEvent({
  event,
  answered,
  busy,
  onAnswer,
}: {
  event: AgentEvent;
  answered: boolean;
  busy: boolean;
  onAnswer: (allow: boolean, value: string) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  return (
    <div
      className={cn(
        "border text-xs",
        answered
          ? "border-border bg-muted/20"
          : "border-warning/40 bg-warning/5",
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 border-b px-3 py-2 font-semibold",
          answered
            ? "border-border text-muted-foreground"
            : "border-warning/30 text-warning",
        )}
      >
        {answered ? (
          <Check className="size-3.5" />
        ) : (
          <ShieldAlert className="size-3.5" />
        )}
        {t("agents.approval")}
      </div>
      <div className="space-y-2.5 p-3">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-foreground thin-scrollbar">
          {event.text}
        </pre>
        {!answered && (
          <>
            {event.choices?.length ? (
              <div
                role="radiogroup"
                aria-label={t("agents.answer")}
                className="flex flex-wrap gap-1.5"
              >
                {event.choices.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={value === c}
                    onClick={() => setValue(c)}
                    className={cn(
                      "border px-2.5 py-1 text-xs transition-colors",
                      value === c
                        ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>
            ) : (
              <Input
                placeholder={t("agents.answer")}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                className={PROMPT_PRIMARY_BUTTON}
                disabled={busy}
                onClick={() => onAnswer(true, value)}
              >
                {t("agents.allow")}
              </button>
              <button
                type="button"
                className={PROMPT_BUTTON}
                disabled={busy}
                onClick={() => onAnswer(false, value)}
              >
                {t("agents.deny")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function AgentTranscript({
  session,
  events,
  busy,
  action,
  input,
}: {
  session: AgentSession;
  events: AgentEvent[];
  busy: boolean;
  action: (fn: () => Promise<void>) => Promise<void>;
  input: (body: unknown) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [events]);

  const transcript: AgentEvent[] = [];
  for (const e of events) {
    const last = transcript.at(-1);
    if (e.kind === "text" && last?.kind === "text") last.text += e.text;
    else if (e.kind !== "state") transcript.push({ ...e });
  }
  // A permission that is still unanswered means the agent waits on the user.
  const awaitingAnswer = transcript.some(
    (e) =>
      e.kind === "permission" && !!e.requestId && !answered.has(e.requestId),
  );
  const working =
    (session.status === "running" || session.status === "starting") &&
    !awaitingAnswer;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
        {transcript.length === 0 && !working && (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Bot className="size-5 text-muted-foreground/40" />
            <span className="text-xs text-muted-foreground">
              {t("agents.emptyTranscript")}
            </span>
          </div>
        )}
        {transcript.map((e) => (
          <div key={e.seq}>
            {e.kind === "user" ? (
              <div className="border-l-2 border-accent-brand/60 bg-muted/30 px-3 py-2 text-sm whitespace-pre-wrap break-words">
                {e.text}
              </div>
            ) : e.kind === "text" ? (
              <AiMessage role="assistant" content={e.text} />
            ) : e.kind === "permission" ? (
              <PermissionEvent
                event={e}
                busy={busy}
                answered={answered.has(e.requestId!)}
                onAnswer={(allow, value) =>
                  void action(async () => {
                    await input({
                      type: "answer",
                      requestId: e.requestId,
                      allow,
                      value: value || undefined,
                    });
                    setAnswered((a) => new Set([...a, e.requestId!]));
                  })
                }
              />
            ) : e.kind === "tool" ? (
              <ToolEvent text={e.text} />
            ) : e.kind === "error" ? (
              <div className="flex items-start gap-2 text-xs text-destructive">
                <AlertCircle className="mt-px size-3.5 shrink-0" />
                <span className="whitespace-pre-wrap break-words">
                  {e.text}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-border/60" />
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                  {e.kind === "status" ? t(`agents.status.${e.text}`) : e.text}
                </span>
                <div className="h-px flex-1 bg-border/60" />
              </div>
            )}
          </div>
        ))}
        {working && (
          <div
            role="status"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <Loader2 className="size-3.5 animate-spin text-accent-brand" />
            {t(
              session.status === "starting"
                ? "agents.startingIndicator"
                : "agents.working",
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>
    </div>
  );
}
