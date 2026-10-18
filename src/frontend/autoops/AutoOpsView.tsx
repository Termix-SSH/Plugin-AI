import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  ListBadge,
  ListRow,
  ListRowAction,
  PanelList,
  Segmented,
  SelectField,
  TextField,
} from "@termix-ssh/plugin-sdk/ui";
import { ShieldCheck, Trash2 } from "lucide-react";
import { useAssistant } from "../assistant/store";
import { formatTokens } from "../usage/format";
import {
  apiMessage,
  deletePreset,
  getPreferences,
  listPresets,
  listTasks,
  savePreferences,
  type Preset,
  type PresetList,
  type TaskItem,
  type TaskPreferences,
} from "./api";
import { SeverityBadge, StatusBadge } from "./badges";
import { EnablePresetView, usePresetTitle } from "./EnablePresetView";
import { useReportLanguage } from "./report-language";
import { TaskDetailView } from "./TaskDetailView";

type Section = "presets" | "tasks" | "approvals";

/** How often the lists are read again while the view is open. */
const REFRESH_MS = 15_000;
/** When the user last looked, to open on what is new since. */
export const SEEN_KEY = "termix-ai-autoops-seen";

function duration(task: TaskItem): string {
  if (!task.finishedAt) return "";
  const seconds = Math.max(
    0,
    Math.round(
      (Date.parse(task.finishedAt) - Date.parse(task.createdAt)) / 1000,
    ),
  );
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
}

/** The newest task finished or proposed since `seen`, if any. */
export function newestUnseen(tasks: TaskItem[], seen: number): TaskItem | null {
  return (
    tasks.find(
      (task) =>
        task.status !== "skipped" &&
        Date.parse(task.finishedAt ?? task.createdAt) > seen,
    ) ?? null
  );
}

function TaskRow({ task, onOpen }: { task: TaskItem; onOpen: () => void }) {
  const { t } = useTranslation();
  const meta = [
    new Date(task.createdAt).toLocaleString(),
    duration(task),
    task.totalTokens
      ? t("autoOps.tokens", { tokens: formatTokens(task.totalTokens) })
      : "",
    task.dryRun ? t("autoOps.dryRun") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ListRow
      title={task.title}
      onClick={onOpen}
      badges={
        <>
          <StatusBadge status={task.status} />
          <SeverityBadge severity={task.severity} />
        </>
      }
      meta={meta}
    >
      {task.summary && (
        <p className="truncate text-xs text-muted-foreground">{task.summary}</p>
      )}
    </ListRow>
  );
}

/** Which provider and model the user's tasks run on. */
function PreferencesRow() {
  const { t } = useTranslation();
  const { providers } = useAssistant();
  const [preferences, setPreferences] = useState<TaskPreferences | null>(null);

  useEffect(() => {
    getPreferences()
      .then(setPreferences)
      .catch(() => undefined);
  }, []);

  if (!preferences) return null;
  const save = (changes: Partial<TaskPreferences>) =>
    savePreferences(changes)
      .then(setPreferences)
      .catch(() => undefined);
  const options = [
    { value: "", label: t("autoOps.providerDefault") },
    ...providers.map((provider) => ({
      value: String(provider.id),
      label: provider.label,
    })),
  ];
  return (
    <div className="grid grid-cols-2 gap-3 border-b border-border p-3">
      <SelectField
        label={t("autoOps.provider")}
        value={preferences.providerId ? String(preferences.providerId) : ""}
        onChange={(value) =>
          void save({ providerId: value ? Number(value) : null })
        }
        options={options}
      />
      <TextField
        label={t("autoOps.model")}
        value={preferences.model ?? ""}
        placeholder={t("autoOps.modelDefault")}
        onChange={(value) => setPreferences({ ...preferences, model: value })}
      />
      <div className="col-span-2 flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void save({ model: preferences.model ?? null })}
        >
          {t("autoOps.saveModel")}
        </Button>
      </div>
    </div>
  );
}

function PresetRow({
  preset,
  available,
  onEnable,
  onDelete,
}: {
  preset: Preset;
  available: boolean;
  onEnable: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const title = usePresetTitle()(preset);
  const description =
    preset.description ??
    (preset.name ? "" : t(`autoOps.presets.${preset.id}.description`));
  return (
    <ListRow
      title={title}
      badges={
        <>
          <ListBadge tone="muted">
            {t(`autoOps.autonomy.${preset.autonomy}`)}
          </ListBadge>
          {preset.enabled.length > 0 && (
            <ListBadge tone="success">{t("autoOps.enabled")}</ListBadge>
          )}
          {preset.updateAvailable && (
            <ListBadge tone="warning">{t("autoOps.updateAvailable")}</ListBadge>
          )}
          {preset.shared && (
            <ListBadge tone="brand">{t("autoOps.shared")}</ListBadge>
          )}
          {!available && (
            <ListBadge tone="destructive">
              {t("autoOps.needsAutomations")}
            </ListBadge>
          )}
        </>
      }
      meta={preset.enabled.map((entry) => entry.name).join(", ")}
      actions={
        onDelete ? (
          <ListRowAction
            label={t("autoOps.deletePreset")}
            tone="destructive"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </ListRowAction>
        ) : undefined
      }
      trailing={
        <Button
          size="sm"
          variant="outline"
          disabled={!available}
          onClick={onEnable}
        >
          {preset.enabled.length
            ? t("autoOps.enableAgain")
            : t("autoOps.enable.submit")}
        </Button>
      }
    >
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </ListRow>
  );
}

/**
 * Auto-ops in the AI tab: presets to turn into automations, the tasks they
 * ran, and plans waiting for approval.
 */
export function AutoOpsView({
  onOpenConversation,
}: {
  onOpenConversation: (conversationId: number) => void;
}) {
  const { t } = useTranslation();
  useReportLanguage();
  const [section, setSection] = useState<Section>("tasks");
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [approvals, setApprovals] = useState<TaskItem[]>([]);
  const [presets, setPresets] = useState<PresetList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<number | null>(null);
  const [enabling, setEnabling] = useState<Preset | null>(null);
  const [first, setFirst] = useState(true);

  const loadTasks = useCallback(async () => {
    try {
      const next = await listTasks();
      setTasks(next.tasks);
      setApprovals(next.approvals);
      return next;
    } catch (err) {
      setError(apiMessage(err, t("autoOps.loadFailed")));
      return null;
    }
  }, [t]);

  const loadPresets = useCallback(async () => {
    try {
      setPresets(await listPresets());
    } catch (err) {
      setError(apiMessage(err, t("autoOps.loadFailed")));
    }
  }, [t]);

  useEffect(() => {
    void loadPresets();
    void loadTasks().then((next) => {
      if (!next || !first) return;
      setFirst(false);
      // Opened from a notification: straight to what is new.
      const seen = Number(localStorage.getItem(SEEN_KEY) ?? 0);
      const unseen = newestUnseen([...next.approvals, ...next.tasks], seen);
      if (unseen) setOpenTask(unseen.id);
      if (!next.tasks.length && !next.approvals.length) setSection("presets");
      else if (next.approvals.some((task) => task.status === "proposed")) {
        setSection("approvals");
      }
      localStorage.setItem(SEEN_KEY, String(Date.now()));
    });
    const timer = setInterval(() => void loadTasks(), REFRESH_MS);
    return () => clearInterval(timer);
    // Only on mount; first guards the jump.
  }, []);

  const pending = approvals.filter((task) => task.status === "proposed").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PreferencesRow />
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Segmented
          value={section}
          onChange={(next) => setSection(next as Section)}
          options={[
            { value: "tasks", label: t("autoOps.sections.tasks") },
            {
              value: "approvals",
              label: t("autoOps.sections.approvals"),
              count: pending || undefined,
            },
            { value: "presets", label: t("autoOps.sections.presets") },
          ]}
        />
      </div>
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {section === "tasks" && (
          <PanelList
            empty={
              <EmptyState
                icon={ShieldCheck}
                title={t("autoOps.noTasks")}
                hint={t("autoOps.noTasksHint")}
              />
            }
          >
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onOpen={() => setOpenTask(task.id)}
              />
            ))}
          </PanelList>
        )}
        {section === "approvals" && (
          <PanelList
            empty={
              <EmptyState icon={ShieldCheck} title={t("autoOps.noApprovals")} />
            }
          >
            {approvals.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onOpen={() => setOpenTask(task.id)}
              />
            ))}
          </PanelList>
        )}
        {section === "presets" && presets && (
          <PanelList>
            {[...presets.presets, ...presets.custom].map((preset) => (
              <PresetRow
                key={preset.id}
                preset={preset}
                available={presets.automationsAvailable}
                onEnable={() => setEnabling(preset)}
                onDelete={
                  preset.mine
                    ? () =>
                        void deletePreset(preset.id)
                          .then(loadPresets)
                          .catch(() => undefined)
                    : undefined
                }
              />
            ))}
          </PanelList>
        )}
      </div>
      {openTask !== null && (
        <TaskDetailView
          taskId={openTask}
          onClose={() => setOpenTask(null)}
          onOpenConversation={(id) => {
            setOpenTask(null);
            onOpenConversation(id);
          }}
          onChanged={() => void loadTasks()}
        />
      )}
      {enabling && (
        <EnablePresetView
          preset={enabling}
          onClose={() => setEnabling(null)}
          onEnabled={() => {
            setEnabling(null);
            void loadPresets();
          }}
        />
      )}
    </div>
  );
}
