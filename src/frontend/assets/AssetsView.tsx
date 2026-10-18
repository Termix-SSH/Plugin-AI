import { ExposureView } from "../exposure/ExposureView";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  DataView,
  EmptyState,
  ListBadge,
  PanelSearch,
  Segmented,
  SelectField,
  type DataColumn,
} from "@termix-ssh/plugin-sdk/ui";
import { Network, RefreshCw, Settings2, Sparkles } from "lucide-react";
import { aiApp } from "../app-ref";
import { useZoneLabel, ZoneBadge } from "./ZoneBadge";
import { apiMessage } from "../autoops/api";
import { ImportanceBadge, SourceBadge } from "./AnnotationFields";
import { AssetDetailView } from "./AssetDetailView";
import { AssetSettingsView } from "./AssetSettingsView";
import { GraphView } from "./GraphView";
import {
  annotateNow,
  collectNow,
  listAnnotationRuns,
  listAssets,
  listRuns,
  listZones,
  type AnnotationRun,
  type AssetItem,
  type CollectionRun,
  type ZoneKind,
  type ZoneRule,
} from "./api";

/** How often the list is read again; faster while a run is going. */
const REFRESH_MS = 30_000;
const RUNNING_MS = 2_000;

const when = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "-";

/** The latest run in a line: when, how many hosts, how many failed. */
function RunStatus({
  run,
  running,
}: {
  run: CollectionRun | undefined;
  running: boolean;
}) {
  const { t } = useTranslation();
  if (running) return <span>{t("assets.collecting")}</span>;
  if (!run) return <span>{t("assets.neverRun")}</span>;
  if (run.status === "failed") {
    const reason = Object.values(run.errorSummary ?? {})[0];
    return (
      <span className="text-destructive">
        {t("assets.lastRunFailed", { time: when(run.startedAt) })}
        {reason ? `: ${reason}` : ""}
      </span>
    );
  }
  const failures = Object.entries(run.errorSummary ?? {});
  return (
    <span title={failures.map(([id, error]) => `#${id}: ${error}`).join("\n")}>
      {t("assets.lastRun", {
        time: when(run.finishedAt ?? run.startedAt),
        ok: run.hostsOk,
        total: run.hostsTotal,
      })}
      {run.hostsFailed > 0 && (
        <span className="text-destructive">
          {" "}
          {t("assets.hostsFailed", { count: run.hostsFailed })}
        </span>
      )}
    </span>
  );
}

/** The latest annotation run in a line: assets, tokens, or why it failed. */
function AnnotationStatus({
  run,
  running,
}: {
  run: AnnotationRun | undefined;
  running: boolean;
}) {
  const { t } = useTranslation();
  if (running) return <span>{t("assets.annotating")}</span>;
  if (!run) return <span>{t("assets.neverAnnotated")}</span>;
  const errors = Object.values(run.errorSummary ?? {});
  return (
    <span title={errors.join("\n")}>
      {t("assets.lastAnnotation", {
        time: when(run.finishedAt ?? run.startedAt),
        ok: run.hostsOk,
        total: run.hostsTotal,
        tokens: run.tokens.toLocaleString(),
      })}
      {run.status === "failed" && (
        <span className="text-destructive">
          {" "}
          {t("assets.annotationFailed", { reason: errors[0] ?? "" })}
        </span>
      )}
    </span>
  );
}

function useManage(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let live = true;
    aiApp()
      .hasPermission("assets.manage")
      .then((value) => live && setAllowed(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return allowed;
}

/**
 * The asset inventory in the AI tab: every asset the collector found, with
 * its zone, filters and search, a detail view per asset, and for managers
 * the zone rules, the schedule and Collect now.
 */
export function AssetsView() {
  const { t } = useTranslation();
  const canManage = useManage();
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [rules, setRules] = useState<ZoneRule[]>([]);
  const [builtin, setBuiltin] = useState<ZoneKind[]>([]);
  const [runs, setRuns] = useState<CollectionRun[]>([]);
  const [running, setRunning] = useState(false);
  const [annotationRuns, setAnnotationRuns] = useState<AnnotationRun[]>([]);
  const [annotating, setAnnotating] = useState(false);
  const [mode, setMode] = useState<"table" | "graph" | "exposure">("table");
  const [refreshKey, setRefreshKey] = useState(0);
  const [query, setQuery] = useState("");
  const [zone, setZone] = useState("");
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, zones, history, annotations] = await Promise.all([
        listAssets({ q: query.trim(), zone, includeRemoved }),
        listZones(),
        listRuns(),
        listAnnotationRuns(),
      ]);
      setAssets(list);
      setRules(zones.zones);
      setBuiltin(zones.builtin);
      setRuns(history.runs);
      setRunning(history.running);
      setAnnotationRuns(annotations.runs);
      setAnnotating(annotations.running);
      setError(null);
    } catch (err) {
      setError(apiMessage(err, t("assets.loadFailed")));
    }
  }, [query, zone, includeRemoved, t]);

  useEffect(() => {
    void load();
    const timer = setInterval(
      () => void load(),
      running || annotating ? RUNNING_MS : REFRESH_MS,
    );
    return () => clearInterval(timer);
  }, [load, running, annotating]);

  // A run that just finished changed what the graph shows.
  const latestRun = `${runs[0]?.id}-${runs[0]?.status}-${annotationRuns[0]?.id}-${annotationRuns[0]?.status}`;
  useEffect(() => setRefreshKey((key) => key + 1), [latestRun]);

  const annotate = async () => {
    try {
      await annotateNow(false);
      setAnnotating(true);
    } catch (err) {
      setError(apiMessage(err, t("assets.annotateFailed")));
    }
  };

  const collect = async () => {
    try {
      await collectNow();
      setRunning(true);
    } catch (err) {
      setError(apiMessage(err, t("assets.collectFailed")));
    }
  };

  const zoneLabel = useZoneLabel(rules);
  const zoneOptions = useMemo(
    () => [
      { value: "", label: t("assets.allZones") },
      ...[...builtin, ...rules.map((rule) => rule.name)]
        .filter((name, index, all) => all.indexOf(name) === index)
        .map((name) => ({ value: name, label: zoneLabel(name) })),
    ],
    [builtin, rules, t, zoneLabel],
  );

  const columns: DataColumn<AssetItem>[] = [
    {
      key: "name",
      header: t("assets.columns.name"),
      width: "minmax(0,2fr)",
      cell: (asset) => (
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate font-medium">{asset.name}</span>
          {asset.removedAt && (
            <ListBadge tone="muted">{t("assets.removed")}</ListBadge>
          )}
        </span>
      ),
    },
    {
      key: "kind",
      header: t("assets.columns.kind"),
      width: "90px",
      cell: (asset) => t(`assets.kind.${asset.kind}`),
    },
    {
      key: "zone",
      header: t("assets.columns.zone"),
      width: "minmax(0,1.5fr)",
      cell: (asset) => <ZoneBadge asset={asset} rules={rules} />,
    },
    {
      key: "role",
      header: t("assets.columns.role"),
      width: "minmax(0,2fr)",
      cell: (asset) => (
        <span
          className="flex min-w-0 items-center gap-1"
          title={asset.role ?? undefined}
        >
          <span className="truncate">{asset.role ?? "-"}</span>
          <SourceBadge source={asset.roleSource} />
        </span>
      ),
    },
    {
      key: "importance",
      header: t("assets.columns.importance"),
      width: "minmax(0,1.2fr)",
      cell: (asset) => (
        <span
          className="flex min-w-0 items-center gap-1"
          title={asset.importanceReason ?? undefined}
        >
          <ImportanceBadge importance={asset.importance} />
          <SourceBadge source={asset.importanceSource} />
        </span>
      ),
    },
    {
      key: "system",
      header: t("assets.columns.system"),
      width: "minmax(0,1.2fr)",
      hideBelow: "md",
      cell: (asset) => (
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate">{asset.system ?? "-"}</span>
          <SourceBadge source={asset.systemSource} />
        </span>
      ),
    },
    {
      key: "ips",
      header: t("assets.columns.ips"),
      width: "minmax(0,2fr)",
      cell: (asset) => (
        <span
          className="truncate font-mono text-xs"
          title={asset.ips.join("\n")}
        >
          {asset.ips.join(", ") || "-"}
        </span>
      ),
    },
    {
      key: "listening",
      header: t("assets.columns.listening"),
      width: "70px",
      align: "end",
      hideBelow: "lg",
      cell: (asset) => asset.counts.listening,
    },
    {
      key: "outbound",
      header: t("assets.columns.outbound"),
      width: "70px",
      align: "end",
      hideBelow: "lg",
      cell: (asset) => asset.counts.outbound,
    },
    {
      key: "services",
      header: t("assets.columns.services"),
      width: "70px",
      align: "end",
      hideBelow: "lg",
      cell: (asset) => asset.counts.services,
    },
    {
      key: "collected",
      header: t("assets.columns.collected"),
      width: "minmax(0,1.2fr)",
      hideBelow: "md",
      cell: (asset) => (
        <span className="truncate text-xs text-muted-foreground">
          {when(asset.collectedAt)}
        </span>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-end gap-2 border-b border-border px-3 py-2">
        <Segmented<"table" | "graph" | "exposure">
          value={mode}
          onChange={setMode}
          options={[
            { value: "table", label: t("assets.modeTable") },
            { value: "graph", label: t("assets.modeGraph") },
            { value: "exposure", label: t("exposure.title") },
          ]}
          className="mb-1"
        />
        {mode === "table" ? (
          <>
            <PanelSearch
              value={query}
              onChange={setQuery}
              placeholder={t("assets.search")}
              className="min-w-48 flex-1"
            />
            <SelectField
              label={t("assets.columns.zone")}
              value={zone}
              onChange={setZone}
              options={zoneOptions}
              className="w-44"
            />
            <label className="flex items-center gap-1.5 pb-2 text-xs">
              <input
                type="checkbox"
                checked={includeRemoved}
                onChange={(event) => setIncludeRemoved(event.target.checked)}
              />
              {t("assets.showRemoved")}
            </label>
          </>
        ) : (
          <span className="flex-1" />
        )}
        {canManage && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 className="size-3.5" />
              {t("assets.settingsTitle")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={annotating}
              onClick={() => void annotate()}
            >
              <Sparkles className="size-3.5" />
              {t("assets.annotateNow")}
            </Button>
            <Button size="sm" disabled={running} onClick={() => void collect()}>
              <RefreshCw className="size-3.5" />
              {t("assets.collectNow")}
            </Button>
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <RunStatus run={runs[0]} running={running} />
        <AnnotationStatus run={annotationRuns[0]} running={annotating} />
      </div>
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {mode === "exposure" && (
        <ExposureView canManage={canManage} refreshKey={refreshKey} />
      )}
      {mode === "graph" && (
        <GraphView
          rules={rules}
          canManage={canManage}
          refreshKey={refreshKey}
          onChanged={() => void load()}
        />
      )}
      <div
        className={
          mode !== "table" ? "hidden" : "min-h-0 flex-1 overflow-y-auto"
        }
      >
        <DataView
          items={assets}
          view="list"
          density="compact"
          getKey={(asset) => asset.key}
          renderCard={() => null}
          columns={{ base: 1 }}
          listColumns={columns}
          onRowClick={(asset) => setOpenId(asset.id)}
          isRowActive={(asset) => asset.id === openId}
          empty={
            <EmptyState
              icon={Network}
              title={t("assets.empty")}
              hint={t(canManage ? "assets.emptyHint" : "assets.emptyHintView")}
            />
          }
        />
      </div>
      {openId !== null && (
        <AssetDetailView
          assetId={openId}
          rules={rules}
          canManage={canManage}
          onClose={() => setOpenId(null)}
          onChanged={() => void load()}
        />
      )}
      {settingsOpen && (
        <AssetSettingsView
          rules={rules}
          onClose={() => setSettingsOpen(false)}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
