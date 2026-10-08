import { useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  cn,
  GroupHeading,
  Input,
  ListBadge,
  ListRowAction,
  useIsMobile,
} from "@termix-ssh/plugin-sdk/ui";
import {
  Archive,
  ArchiveRestore,
  Check,
  GitBranch,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
import { aiApp } from "../app-ref";
import { agentNames } from "./agent-labels";
import type { AgentSession } from "../../backend/agents/types";
import type { SessionActions } from "./AgentComposer";

/** The session name, renamed in place, with the archive toggle beside it. */
export function SessionTitle({
  session: s,
  busy,
  action,
  onUpdated,
}: SessionActions) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title ?? "");
  async function patch(body: unknown) {
    onUpdated(
      (await aiApp().api.patch<AgentSession>(`/agents/${s.id}`, body)).data,
    );
  }
  const save = () =>
    void action(async () => {
      await patch({ title });
      setEditing(false);
    });

  if (editing)
    return (
      <form
        className="flex min-w-0 items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input
          autoFocus
          className="h-7 w-56"
          aria-label={t("agents.sessionName")}
          placeholder={t("agents.sessionName")}
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setTitle(s.title ?? "");
            setEditing(false);
          }}
        />
        <ListRowAction label={t("agents.save")} tone="brand" type="submit">
          <Check />
        </ListRowAction>
        <ListRowAction
          label={t("agents.cancel")}
          onClick={() => {
            setTitle(s.title ?? "");
            setEditing(false);
          }}
        >
          <X />
        </ListRowAction>
      </form>
    );

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="truncate text-sm font-semibold tracking-tight">
        {s.title || `${agentNames[s.agent]} · ${s.model}`}
      </span>
      <ListRowAction
        label={t("agents.rename")}
        disabled={busy}
        onClick={() => setEditing(true)}
      >
        <Pencil />
      </ListRowAction>
      <ListRowAction
        label={t(s.archived ? "agents.restore" : "agents.archive")}
        disabled={busy}
        onClick={() => void action(() => patch({ archived: !s.archived }))}
      >
        {s.archived ? <ArchiveRestore /> : <Archive />}
      </ListRowAction>
    </div>
  );
}

function diffLineClass(line: string): string | undefined {
  if (line.startsWith("+++") || line.startsWith("---"))
    return "text-muted-foreground";
  if (line.startsWith("+")) return "bg-green-500/10 text-green-500";
  if (line.startsWith("-")) return "bg-destructive/10 text-destructive";
  if (line.startsWith("@@")) return "text-accent-brand";
  return undefined;
}

/** Git status, diffs and worktrees for the session's directory. */
export function ReviewPane({
  session: s,
  busy,
  action,
  onClose,
  onWorktree,
}: Omit<SessionActions, "onUpdated"> & {
  onClose: () => void;
  onWorktree: (path: string) => void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [file, setFile] = useState(""),
    [branch, setBranch] = useState("");
  const [result, setResult] = useState(""),
    [worktree, setWorktree] = useState("");
  const [files, setFiles] = useState<{ status: string; path: string }[]>([]);
  async function inspect(operation: string, path = file) {
    const r = await aiApp().api.post<{
      status?: string;
      files?: { status: string; path: string }[];
      diff?: string;
      branch?: string;
      path?: string;
    }>(`/agents/${s.id}/workspace`, { operation, path, branch });
    if (r.data.files) setFiles(r.data.files);
    setResult(
      [r.data.branch, r.data.status, r.data.diff, r.data.path]
        .filter(Boolean)
        .join("\n") || t("agents.clean"),
    );
    if (r.data.path) setWorktree(r.data.path);
  }

  return (
    <aside
      className={`flex min-w-0 shrink-0 flex-col border-border ${isMobile ? "w-full" : "w-96 border-l"}`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <GitBranch className="size-3.5 text-accent-brand" />
        <span className="flex-1 truncate text-xs font-semibold">
          {t("agents.review")}
        </span>
        <ListRowAction
          label={t("agents.gitStatus")}
          disabled={busy}
          onClick={() => void action(() => inspect("status"))}
        >
          <RefreshCw />
        </ListRowAction>
        <ListRowAction label={t("agents.close")} onClick={onClose}>
          <X />
        </ListRowAction>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 thin-scrollbar">
        <section className="space-y-2">
          <GroupHeading title={t("agents.changedFiles")} count={files.length} />
          {files.length > 0 ? (
            <div className="border border-border">
              {files.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setFile(f.path);
                    void action(() => inspect("diff", f.path));
                  }}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/50",
                    i > 0 && "border-t border-border/40",
                    file === f.path && "bg-accent-brand/10",
                  )}
                >
                  <ListBadge>{f.status}</ListBadge>
                  <span className="min-w-0 truncate font-mono text-[11px]">
                    {f.path}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => void action(() => inspect("status"))}
            >
              <RefreshCw />
              {t("agents.gitStatus")}
            </Button>
          )}
          <div className="flex gap-1.5">
            <Input
              className="font-mono"
              aria-label={t("agents.diffFile")}
              placeholder={t("agents.diffFile")}
              value={file}
              onChange={(e) => setFile(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={busy || !file}
              onClick={() => void action(() => inspect("diff"))}
            >
              {t("agents.diff")}
            </Button>
          </div>
        </section>

        {result && (
          <pre className="max-h-[50vh] overflow-auto border border-border bg-muted/20 py-1.5 font-mono text-[11px] leading-relaxed thin-scrollbar">
            {result.split("\n").map((line, i) => (
              <div key={i} className={cn("px-2", diffLineClass(line))}>
                {line || " "}
              </div>
            ))}
          </pre>
        )}

        <section className="space-y-2">
          <GroupHeading title={t("agents.worktree")} />
          <div className="flex gap-1.5">
            <Input
              className="font-mono"
              aria-label={t("agents.branch")}
              placeholder={t("agents.branch")}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={busy || !branch}
              onClick={() => void action(() => inspect("worktree"))}
            >
              {t("agents.createWorktree")}
            </Button>
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t("agents.worktreeHint")}
          </p>
          {worktree && (
            <Button
              size="sm"
              variant="outline"
              className="w-full border-accent-brand/40 text-accent-brand hover:bg-accent-brand/10 hover:text-accent-brand dark:border-accent-brand/40 dark:bg-transparent dark:hover:bg-accent-brand/10"
              onClick={() => onWorktree(worktree)}
            >
              {t("agents.useWorktree")}
            </Button>
          )}
        </section>
      </div>
    </aside>
  );
}
