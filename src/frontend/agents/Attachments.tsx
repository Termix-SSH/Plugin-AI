import { useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  ListRowAction,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PROMPT_PRIMARY_BUTTON,
} from "@termix-ssh/plugin-sdk/ui";
import { FileSymlink, History, Paperclip, X } from "lucide-react";
import { aiApp } from "../app-ref";
import type { AgentAttachment, AgentSession } from "../../backend/agents/types";
import type { SessionActions } from "./AgentComposer";

export const MAX_ATTACHMENTS = 4;

type AttachmentProps = SessionActions & {
  selected: string[];
  onSelected: (ids: string[]) => void;
};

export function useAttachments({
  session: s,
  onUpdated,
  selected,
  onSelected,
}: AttachmentProps) {
  const { t } = useTranslation();
  async function attach(body: unknown) {
    const result = await aiApp().api.post<AgentAttachment>(
      `/agents/${s.id}/workspace`,
      body,
    );
    onSelected([...selected, result.data.id]);
    onUpdated((await aiApp().api.get<AgentSession>(`/agents/${s.id}`)).data);
  }
  async function upload(file: File) {
    if (selected.length >= MAX_ATTACHMENTS || file.size > 1024 * 1024)
      throw Error(t("agents.attachmentLimit"));
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    await attach({ operation: "upload", name: file.name, data });
  }
  return { attach, upload };
}

/** Upload, attach a host file, or reuse an earlier attachment. */
export function AttachmentButtons(props: AttachmentProps) {
  const { session: s, busy, action, selected, onSelected } = props;
  const { t } = useTranslation();
  const { attach, upload } = useAttachments(props);
  const fileInput = useRef<HTMLInputElement>(null);
  const [path, setPath] = useState("");
  const [pathOpen, setPathOpen] = useState(false);
  const full = selected.length >= MAX_ATTACHMENTS;
  const reusable = (s.attachments ?? []).filter(
    (a) => !selected.includes(a.id),
  );
  return (
    <div className="flex items-center">
      <input
        ref={fileInput}
        className="hidden"
        type="file"
        aria-label={t("agents.upload")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void action(() => upload(file));
          e.target.value = "";
        }}
      />
      <ListRowAction
        label={t("agents.upload")}
        disabled={busy || full}
        className="size-7"
        onClick={() => fileInput.current?.click()}
      >
        <Paperclip />
      </ListRowAction>
      <Popover open={pathOpen} onOpenChange={setPathOpen}>
        <PopoverTrigger asChild>
          <ListRowAction
            label={t("agents.attach")}
            disabled={busy || full}
            className="size-7"
          >
            <FileSymlink />
          </ListRowAction>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-2">
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (!path) return;
              void action(async () => {
                await attach({ operation: "reference", path });
                setPath("");
                setPathOpen(false);
              });
            }}
          >
            <Input
              autoFocus
              className="font-mono"
              aria-label={t("agents.remoteFile")}
              placeholder={t("agents.remoteFile")}
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
            <button
              type="submit"
              className={`${PROMPT_PRIMARY_BUTTON} h-8 shrink-0`}
              disabled={busy || !path}
            >
              {t("agents.attachShort")}
            </button>
          </form>
        </PopoverContent>
      </Popover>
      {reusable.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ListRowAction
              label={t("agents.attachments")}
              disabled={busy || full}
              className="size-7"
            >
              <History />
            </ListRowAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-80">
            {reusable.map((a) => (
              <DropdownMenuItem
                key={a.id}
                className="text-xs"
                onSelect={() => onSelected([...selected, a.id])}
              >
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {formatSize(a.size)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function AttachmentChips({
  session: s,
  selected,
  onSelected,
}: Pick<AttachmentProps, "session" | "selected" | "onSelected">) {
  const { t } = useTranslation();
  if (!selected.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2">
      {selected.map((id) => {
        const a = s.attachments?.find((x) => x.id === id);
        return (
          <span
            key={id}
            className="inline-flex max-w-60 items-center gap-1.5 border border-border bg-muted/40 py-0.5 pl-1.5 pr-0.5 text-[11px]"
          >
            <Paperclip className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{a?.name ?? id}</span>
            <button
              type="button"
              aria-label={t("agents.remove")}
              title={t("agents.remove")}
              className="flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
              onClick={() => onSelected(selected.filter((x) => x !== id))}
            >
              <X className="size-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
