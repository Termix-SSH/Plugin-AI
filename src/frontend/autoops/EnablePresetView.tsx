import { useMemo, useState } from "react";
import { useHosts, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  Field,
  FormFooter,
  InlineView,
  NumberField,
  Segmented,
  SelectField,
  SwitchRow,
  TextField,
  Textarea,
} from "@termix-ssh/plugin-sdk/ui";
import { Sparkles } from "lucide-react";
import { useAssistant } from "../assistant/store";
import { TargetSelector } from "../ops/TargetSelector";
import { fleetGroups, toTargetHosts } from "../ops/targets";
import {
  apiMessage,
  enablePreset,
  savePreset,
  type Autonomy,
  type EnableInput,
  type HostSelector,
  type Preset,
} from "./api";

type TargetMode = "all" | "trigger" | "hosts";

const HOST_TRIGGERS = new Set([
  "metric_threshold",
  "host_status",
  "health_check",
  "docker_event",
  "container_event",
]);
const DAILY_CRON = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;

/** "0 9 * * *" as "09:00", or null for any other schedule. */
export function cronToTime(cron: unknown): string | null {
  const match = typeof cron === "string" ? DAILY_CRON.exec(cron) : null;
  if (!match) return null;
  return `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`;
}

export function timeToCron(time: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match || +match[1] > 23 || +match[2] > 59) return null;
  return `${+match[2]} ${+match[1]} * * *`;
}

/** A preset's name as the user reads it. */
export function usePresetTitle() {
  const { t } = useTranslation();
  return (preset: Preset) =>
    preset.name ?? t(`autoOps.presets.${preset.id}.title`);
}

/**
 * Confirms a preset before it becomes an automation: targets, threshold or
 * time, autonomy, time limit and runbook. It can also be saved as a preset.
 */
export function EnablePresetView({
  preset,
  onClose,
  onEnabled,
}: {
  preset: Preset;
  onClose: () => void;
  onEnabled: () => void;
}) {
  const { t } = useTranslation();
  const presetTitle = usePresetTitle();
  const { hosts: allHosts } = useHosts();
  const { fleets } = useAssistant();
  const hosts = useMemo(() => toTargetHosts(allHosts), [allHosts]);

  const trigger = preset.trigger;
  const hostScoped = HOST_TRIGGERS.has(trigger.kind);
  const [name, setName] = useState(presetTitle(preset));
  const [mode, setMode] = useState<TargetMode>(
    preset.hostSelector.kind === "trigger" && hostScoped
      ? "trigger"
      : preset.hostSelector.kind === "hosts"
        ? "hosts"
        : "all",
  );
  const [selected, setSelected] = useState<Set<number>>(
    new Set(
      preset.hostSelector.kind === "hosts" ? preset.hostSelector.hostIds : [],
    ),
  );
  const [threshold, setThreshold] = useState(Number(trigger.value ?? 85));
  const [forSeconds, setForSeconds] = useState(Number(trigger.forSeconds ?? 0));
  const [time, setTime] = useState(cronToTime(trigger.cron) ?? "");
  const [cron, setCron] = useState(String(trigger.cron ?? ""));
  const [autonomy, setAutonomy] = useState<Autonomy>(preset.autonomy);
  const [maxRunSeconds, setMaxRunSeconds] = useState(preset.maxRunSeconds);
  const [runbook, setRunbook] = useState(preset.runbook);
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const build = (): EnableInput | null => {
    const hostSelector: HostSelector =
      mode === "hosts"
        ? { kind: "hosts", hostIds: [...selected] }
        : { kind: mode };
    if (mode === "hosts" && !selected.size) {
      setError(t("autoOps.enable.noHosts"));
      return null;
    }
    let nextTrigger: Record<string, unknown> = { ...trigger };
    if (trigger.kind === "metric_threshold") {
      nextTrigger = { ...nextTrigger, value: threshold, forSeconds };
    } else if (trigger.kind === "schedule") {
      const nextCron =
        cronToTime(trigger.cron) !== null ? timeToCron(time) : cron;
      if (!nextCron) {
        setError(t("autoOps.enable.badTime"));
        return null;
      }
      nextTrigger = {
        ...nextTrigger,
        cron: nextCron,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    }
    return {
      // The server names the automation "AI · <title>".
      title: name.trim() || presetTitle(preset),
      trigger: nextTrigger,
      hostSelector,
      autonomy,
      runbook,
      maxRunSeconds,
    };
  };

  const enable = async () => {
    const input = build();
    if (!input) return;
    setSaving(true);
    setError(null);
    try {
      await enablePreset(preset.id, input);
      onEnabled();
    } catch (err) {
      setError(apiMessage(err, t("autoOps.enable.failed")));
    } finally {
      setSaving(false);
    }
  };

  const saveAsPreset = async () => {
    const input = build();
    if (!input) return;
    setError(null);
    try {
      const { title, ...config } = input;
      await savePreset({ name: title, shared, config });
      setSaved(true);
    } catch (err) {
      setError(apiMessage(err, t("autoOps.enable.saveFailed")));
    }
  };

  const targetOptions = [
    { value: "all" as const, label: t("autoOps.enable.targetAll") },
    ...(hostScoped
      ? [
          {
            value: "trigger" as const,
            label: t("autoOps.enable.targetTrigger"),
          },
        ]
      : []),
    { value: "hosts" as const, label: t("autoOps.enable.targetHosts") },
  ];

  return (
    <InlineView
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("autoOps.enable.title", { name: presetTitle(preset) })}
      icon={<Sparkles className="size-4" />}
      footer={
        <FormFooter
          onCancel={onClose}
          onSave={() => void enable()}
          saveLabel={t("autoOps.enable.submit")}
          saving={saving}
          status={
            error ? <span className="text-destructive">{error}</span> : null
          }
          extra={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void saveAsPreset()}
            >
              {saved
                ? t("autoOps.enable.savedPreset")
                : t("autoOps.enable.saveAsPreset")}
            </Button>
          }
        />
      }
    >
      <div className="space-y-4 p-4">
        <TextField
          label={t("autoOps.enable.name")}
          value={name}
          onChange={setName}
        />
        <SelectField
          label={t("autoOps.enable.targets")}
          value={mode}
          onChange={(next) => setMode(next as TargetMode)}
          options={targetOptions}
        />
        {mode === "hosts" && (
          <TargetSelector
            hosts={hosts}
            fleets={fleets ? fleetGroups(fleets, hosts) : null}
            selected={selected}
            onChange={setSelected}
            className="h-64 border"
          />
        )}
        {trigger.kind === "metric_threshold" && (
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label={t("autoOps.enable.threshold")}
              value={threshold}
              onChange={setThreshold}
              min={1}
              max={100}
            />
            <NumberField
              label={t("autoOps.enable.forSeconds")}
              value={forSeconds}
              onChange={setForSeconds}
              min={0}
              max={86400}
            />
          </div>
        )}
        {trigger.kind === "schedule" &&
          (cronToTime(trigger.cron) !== null ? (
            <TextField
              label={t("autoOps.enable.time")}
              value={time}
              onChange={setTime}
              placeholder="09:00"
            />
          ) : (
            <TextField
              label={t("autoOps.enable.cron")}
              value={cron}
              onChange={setCron}
              mono
            />
          ))}
        <Field label={t("autoOps.enable.autonomy")}>
          <Segmented
            value={autonomy}
            onChange={(next) => setAutonomy(next as Autonomy)}
            options={[
              { value: "report", label: t("autoOps.autonomy.report") },
              { value: "propose", label: t("autoOps.autonomy.propose") },
            ]}
          />
        </Field>
        <NumberField
          label={t("autoOps.enable.maxRunSeconds")}
          value={maxRunSeconds}
          onChange={setMaxRunSeconds}
          min={60}
          max={3600}
        />
        <Field
          label={t("autoOps.enable.runbook")}
          hint={t("autoOps.enable.runbookHint")}
        >
          <Textarea
            aria-label={t("autoOps.enable.runbook")}
            value={runbook}
            onChange={(event) => setRunbook(event.target.value)}
            rows={10}
            className="font-mono text-xs"
          />
        </Field>
        <SwitchRow
          label={t("autoOps.enable.shared")}
          description={t("autoOps.enable.sharedHint")}
          checked={shared}
          onChange={setShared}
        />
      </div>
    </InlineView>
  );
}
