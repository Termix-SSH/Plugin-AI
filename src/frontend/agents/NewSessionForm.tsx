import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Field,
  FieldPair,
  GroupHeading,
  Input,
  SelectField,
  TextField,
} from "@termix-ssh/plugin-sdk/ui";
import { Info, Play } from "lucide-react";
import { InstallRuntime } from "./InstallRuntime";
import type { AiProvider } from "../ai-api";
import { AGENTS, compatible, type AgentKind } from "../../backend/agents/types";
import { agentNames } from "./agent-labels";

export interface NewSessionDraft {
  agent: AgentKind;
  providerId: number;
  model: string;
  cwd: string;
  executable: string;
}

export function NewSessionForm({
  hostId,
  providers,
  draft,
  onDraft,
  busy,
  setBusy,
  onStart,
}: {
  hostId: number;
  providers: AiProvider[];
  draft: NewSessionDraft;
  onDraft: (draft: NewSessionDraft) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const usable = providers.filter((p) =>
    compatible(draft.agent, p.providerType),
  );
  const set = (patch: Partial<NewSessionDraft>) =>
    onDraft({ ...draft, ...patch });
  const providerHint =
    providers.length === 0
      ? t("agents.noProviders")
      : usable.length === 0
        ? t("agents.noCompatibleProvider", { agent: agentNames[draft.agent] })
        : undefined;
  const notes = [
    t("agents.requirements"),
    draft.agent === "codex" && t("agents.responsesRequired"),
    draft.agent === "pi" && t("agents.piPermissions"),
  ].filter(Boolean) as string[];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar">
      <form
        className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6"
        onSubmit={(e) => {
          e.preventDefault();
          onStart();
        }}
      >
        <div className="space-y-1">
          <h2 className="text-base font-bold tracking-tight">
            {t("agents.new")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("agents.description")}
          </p>
        </div>

        <GroupHeading title={t("agents.sessionSetup")} />
        <FieldPair>
          <SelectField
            label={t("agents.runtime")}
            value={draft.agent}
            onChange={(agent) =>
              set({ agent: agent as AgentKind, providerId: 0, model: "" })
            }
            options={AGENTS.map((a) => ({ value: a, label: agentNames[a] }))}
          />
          <SelectField
            label={t("agents.provider")}
            value={draft.providerId ? String(draft.providerId) : ""}
            placeholder={t("agents.chooseProvider")}
            hint={providerHint}
            disabled={usable.length === 0}
            onChange={(value) => {
              const id = Number(value);
              set({
                providerId: id,
                model: providers.find((p) => p.id === id)?.defaultModel ?? "",
              });
            }}
            options={usable.map((p) => ({
              value: String(p.id),
              label: p.label,
            }))}
          />
        </FieldPair>
        <TextField
          label={t("agents.model")}
          value={draft.model}
          onChange={(model) => set({ model })}
          mono
        />
        <FieldPair>
          <Field label={t("agents.directory")}>
            <Input
              required
              className="font-mono"
              value={draft.cwd}
              onChange={(e) => set({ cwd: e.target.value })}
            />
          </Field>
          <TextField
            label={t("agents.executable")}
            value={draft.executable}
            placeholder={draft.agent}
            onChange={(executable) => set({ executable })}
            mono
          />
        </FieldPair>

        <div className="flex flex-col gap-1.5 border border-border bg-muted/20 px-3 py-2.5">
          {notes.map((note) => (
            <p
              key={note}
              className="flex items-start gap-2 text-[11px] leading-snug text-muted-foreground"
            >
              <Info className="mt-px size-3 shrink-0" />
              {note}
            </p>
          ))}
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy || !draft.providerId || !draft.model}
            className="inline-flex h-8 items-center gap-1.5 border border-accent-brand/40 px-4 text-xs font-medium text-accent-brand transition-colors hover:bg-accent-brand/10 focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <Play className="size-3.5" />
            {t("agents.start")}
          </button>
        </div>

        <GroupHeading title={t("agents.hostSetup")} />
        <InstallRuntime
          hostId={hostId}
          agent={draft.agent}
          busy={busy}
          setBusy={setBusy}
        />
      </form>
    </div>
  );
}
