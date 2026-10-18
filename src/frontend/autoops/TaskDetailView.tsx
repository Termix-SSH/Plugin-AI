import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, InlineView, ListBadge } from "@termix-ssh/plugin-sdk/ui";
import { ShieldCheck } from "lucide-react";
import { AiMessage } from "../AiMessage";
import { formatTokens } from "../usage/format";
import {
  apiMessage,
  approveTask,
  getTask,
  rejectTask,
  type PlanHost,
  type TaskDetail,
} from "./api";
import { SeverityBadge, StatusBadge } from "./badges";

/** How often a task that is still moving is read again. */
const POLL_MS = 2000;
const MOVING = new Set(["running", "approved", "executing"]);

function CommandList({
  title,
  commands,
}: {
  title: string;
  commands: string[];
}) {
  if (!commands.length) return null;
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">
        {title}
      </div>
      <ol className="list-decimal space-y-0.5 pl-5">
        {commands.map((command, index) => (
          <li key={index}>
            <code className="font-mono text-xs break-all">{command}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** One host's part of a plan, with its results once it ran. */
function PlanHostCard({ host, name }: { host: PlanHost; name: string }) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={name}
      className="space-y-2 border border-border p-3 text-xs"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {name}
        {host.error && <ListBadge tone="destructive">{host.error}</ListBadge>}
      </div>
      <CommandList
        title={t("autoOps.plan.commands")}
        commands={host.commands}
      />
      <p>
        <span className="text-muted-foreground">
          {t("autoOps.plan.rationale")}:{" "}
        </span>
        {host.rationale}
      </p>
      <p>
        <span className="text-muted-foreground">
          {t("autoOps.plan.risk")}:{" "}
        </span>
        {host.risk}
      </p>
      <p>
        <span className="text-muted-foreground">
          {t("autoOps.plan.rollback")}:{" "}
        </span>
        {host.rollback}
      </p>
      <CommandList title={t("autoOps.plan.verify")} commands={host.verify} />
      {!!host.results?.length && (
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-muted-foreground">
            {t("autoOps.plan.progress")}
          </div>
          {host.results.map((result, index) => (
            <div key={index} className="flex items-start gap-2">
              <ListBadge tone={result.error ? "destructive" : "success"}>
                {result.error ?? `exit ${result.exitCode}`}
              </ListBadge>
              <code className="font-mono break-all">{result.command}</code>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One task: its report, and for an L1 task the plan with approve and reject,
 * then the plan's progress while it runs.
 */
export function TaskDetailView({
  taskId,
  onClose,
  onOpenConversation,
  onChanged,
}: {
  taskId: number;
  onClose: () => void;
  onOpenConversation: (conversationId: number) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTask(await getTask(taskId));
    } catch (err) {
      setError(apiMessage(err, t("autoOps.loadFailed")));
    }
  }, [taskId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!task || !MOVING.has(task.status)) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [task, load]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await (approve ? approveTask(taskId) : rejectTask(taskId));
      await load();
      onChanged();
    } catch (err) {
      setError(apiMessage(err, t("autoOps.decideFailed")));
    } finally {
      setBusy(false);
    }
  };

  const hostName = (id: number) => task?.hostNames[String(id)] ?? `#${id}`;

  return (
    <InlineView
      open
      onOpenChange={(open) => !open && onClose()}
      title={task?.title ?? t("autoOps.task")}
      icon={<ShieldCheck className="size-4" />}
      status={
        task && (
          <span className="flex items-center gap-1">
            <StatusBadge status={task.status} />
            <SeverityBadge severity={task.severity} />
          </span>
        )
      }
      actions={
        task?.conversationId && task.mine ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenConversation(task.conversationId!)}
          >
            {t("autoOps.openConversation")}
          </Button>
        ) : null
      }
    >
      <div className="space-y-4 p-4 text-sm">
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {task && (
          <>
            {task.trigger.summary && (
              <p className="text-xs text-muted-foreground">
                {t("autoOps.trigger")}: {task.trigger.summary}
              </p>
            )}
            {task.summary && <p>{task.summary}</p>}
            {!!task.totalTokens && (
              <p className="text-xs text-muted-foreground">
                {t("autoOps.tokenUsage", {
                  total: formatTokens(task.totalTokens),
                  prompt: formatTokens(task.promptTokens),
                  completion: formatTokens(task.completionTokens),
                })}
              </p>
            )}
            {task.plan && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("autoOps.plan.title")}
                </h3>
                {task.plan.map((host) => (
                  <PlanHostCard
                    key={host.hostId}
                    host={host}
                    name={hostName(host.hostId)}
                  />
                ))}
                {task.status === "proposed" && task.canDecide && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void decide(true)}
                    >
                      {t("autoOps.approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void decide(false)}
                    >
                      {t("autoOps.reject")}
                    </Button>
                    {task.expiresAt && (
                      <span className="text-[11px] text-muted-foreground">
                        {t("autoOps.expires", {
                          time: new Date(task.expiresAt).toLocaleString(),
                        })}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
            {task.report && (
              <div className="border-t border-border pt-3">
                <AiMessage role="assistant" content={task.report} />
              </div>
            )}
          </>
        )}
      </div>
    </InlineView>
  );
}
