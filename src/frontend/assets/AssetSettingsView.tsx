import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  GroupHeading,
  InlineView,
  ListRow,
  ListRowAction,
  NumberField,
  PanelList,
  SelectField,
  SwitchRow,
  TextField,
} from "@termix-ssh/plugin-sdk/ui";
import { Settings2, Trash2 } from "lucide-react";
import { apiMessage } from "../autoops/api";
import {
  annotateNow,
  deleteZone,
  getSettings,
  saveSettings,
  saveZone,
  type AssetSettings,
  type ZoneKind,
  type ZoneRule,
} from "./api";

const KINDS: ZoneKind[] = ["internal", "dmz", "external", "cloud", "overlay"];

type Draft = Omit<ZoneRule, "id"> & { id?: number };
const EMPTY: Draft = { name: "", kind: "internal", cidr: "", priority: 0 };

/** The daily collection and who collects. */
function ScheduleSection() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AssetSettings | null>(null);
  const [time, setTime] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSettings()
      .then((value) => {
        setSettings(value);
        setTime(value.dailyTime);
        setModel(value.annotateModel ?? "");
      })
      .catch((err) => setError(apiMessage(err, t("assets.loadFailed"))));
  }, [t]);

  const save = async (changes: Parameters<typeof saveSettings>[0]) => {
    try {
      const next = await saveSettings(changes);
      setSettings(next);
      setTime(next.dailyTime);
      setModel(next.annotateModel ?? "");
      setError(null);
    } catch (err) {
      setError(apiMessage(err, t("assets.saveFailed")));
    }
  };

  if (!settings) return null;
  const collector = settings.collectorIsMe
    ? t("assets.collectorMe")
    : settings.collectorSet
      ? t("assets.collectorOther")
      : t("assets.collectorNone");
  return (
    <section className="space-y-2">
      <GroupHeading title={t("assets.scheduleTitle")} />
      <SwitchRow
        label={t("assets.daily")}
        description={t("assets.dailyHint")}
        checked={settings.dailyEnabled}
        onChange={(dailyEnabled) => void save({ dailyEnabled })}
      />
      <div className="flex items-end gap-2">
        <TextField
          label={t("assets.time")}
          value={time}
          onChange={setTime}
          placeholder="03:00"
          mono
          className="w-32"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={time === settings.dailyTime}
          onClick={() => void save({ dailyTime: time })}
        >
          {t("assets.save")}
        </Button>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span>{t("assets.collector", { collector })}</span>
        {!settings.collectorIsMe && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void save({ collector: "me" })}
          >
            {t("assets.collectAsMe")}
          </Button>
        )}
      </div>
      <GroupHeading title={t("assets.annotationTitle")} />
      <SwitchRow
        label={t("assets.annotateAfterCollect")}
        description={t("assets.annotateAfterCollectHint")}
        checked={settings.annotateAfterCollect}
        onChange={(annotateAfterCollect) => void save({ annotateAfterCollect })}
      />
      <SelectField
        label={t("assets.annotateProvider")}
        value={String(settings.annotateProviderId ?? "")}
        onChange={(value) =>
          void save({ annotateProviderId: value ? Number(value) : null })
        }
        options={[
          { value: "", label: t("assets.annotateProviderDefault") },
          ...settings.annotateProviders.map((provider) => ({
            value: String(provider.id),
            label: provider.label,
          })),
        ]}
      />
      <div className="flex items-end gap-2">
        <TextField
          label={t("assets.annotateModel")}
          value={model}
          onChange={setModel}
          placeholder={
            settings.annotateProviders.find(
              (provider) => provider.id === settings.annotateProviderId,
            )?.defaultModel ?? t("assets.annotateModelDefault")
          }
          mono
          className="flex-1"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={model === (settings.annotateModel ?? "")}
          onClick={() => void save({ annotateModel: model.trim() || null })}
        >
          {t("assets.save")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("assets.annotationHint")}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          void annotateNow(true)
            .then(() => setError(null))
            .catch((err) =>
              setError(apiMessage(err, t("assets.annotateFailed"))),
            )
        }
      >
        {t("assets.annotateAll")}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

/** Zone rules and the schedule, for holders of ai.assets.manage. */
export function AssetSettingsView({
  rules,
  onClose,
  onChanged,
}: {
  rules: ZoneRule[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
        setError(null);
        onChanged();
      } catch (err) {
        setError(apiMessage(err, t("assets.saveFailed")));
      }
    },
    [onChanged, t],
  );

  return (
    <InlineView
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("assets.settingsTitle")}
      icon={<Settings2 className="size-4" />}
    >
      <div className="space-y-5 p-3">
        <ScheduleSection />
        <section className="space-y-2">
          <GroupHeading title={t("assets.zonesTitle")} count={rules.length} />
          <p className="text-xs text-muted-foreground">
            {t("assets.zonesHint")}
          </p>
          <PanelList>
            {rules.map((rule) => (
              <ListRow
                key={rule.id}
                title={rule.name}
                meta={`${rule.cidr} · ${t(`assets.zone.${rule.kind}`)} · ${t("assets.priority")} ${rule.priority}`}
                onClick={() => setDraft(rule)}
                actions={
                  <ListRowAction
                    label={t("assets.deleteZone")}
                    tone="destructive"
                    onClick={() => void run(() => deleteZone(rule.id))}
                  >
                    <Trash2 className="size-3.5" />
                  </ListRowAction>
                }
              />
            ))}
          </PanelList>
          <div className="grid grid-cols-2 gap-2">
            <TextField
              label={t("assets.zoneName")}
              value={draft.name}
              placeholder={t("assets.zoneNameExample")}
              onChange={(name) => setDraft({ ...draft, name })}
            />
            <SelectField
              label={t("assets.zoneKind")}
              value={draft.kind}
              onChange={(kind) => setDraft({ ...draft, kind })}
              options={KINDS.map((kind) => ({
                value: kind,
                label: t(`assets.zone.${kind}`),
              }))}
            />
            <TextField
              label={t("assets.cidr")}
              value={draft.cidr}
              placeholder="10.1.1.0/24"
              mono
              onChange={(cidr) => setDraft({ ...draft, cidr })}
            />
            <NumberField
              label={t("assets.priority")}
              value={draft.priority}
              min={-1000}
              max={1000}
              onChange={(priority) => setDraft({ ...draft, priority })}
            />
          </div>
          <div className="flex justify-end gap-2">
            {draft.id && (
              <Button size="sm" variant="ghost" onClick={() => setDraft(EMPTY)}>
                {t("assets.cancelEdit")}
              </Button>
            )}
            <Button
              size="sm"
              disabled={!draft.name.trim() || !draft.cidr.trim()}
              onClick={() =>
                void run(async () => {
                  await saveZone(draft);
                  setDraft(EMPTY);
                })
              }
            >
              {draft.id ? t("assets.save") : t("assets.addZone")}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </section>
      </div>
    </InlineView>
  );
}
