import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  GroupHeading,
  InlineView,
  ListBadge,
  SelectField,
} from "@termix-ssh/plugin-sdk/ui";
import { Network } from "lucide-react";
import { apiMessage } from "../autoops/api";
import { AnnotationFields } from "./AnnotationFields";
import { useZoneLabel, ZoneBadge } from "./ZoneBadge";
import {
  getAsset,
  pinZone,
  type AssetDetail,
  type AssetEdge,
  type ZoneRule,
} from "./api";

const ZONE_NAMES = ["internal", "dmz", "external", "cloud", "overlay"];

const scalar = (value: unknown) =>
  Array.isArray(value) ? value.join(", ") : String(value ?? "");

/** An array of records as a table, its columns the union of their keys. */
function RecordTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            {columns.map((column) => (
              <th key={column} className="px-2 py-1 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-border">
              {columns.map((column) => (
                <td key={column} className="px-2 py-1 font-mono break-all">
                  {scalar(row[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One section of the facts, drawn by its shape. */
function FactValue({ value }: { value: unknown }) {
  if (Array.isArray(value) && value.every((v) => v && typeof v === "object")) {
    return value.length ? (
      <RecordTable rows={value as Record<string, unknown>[]} />
    ) : (
      <p className="text-xs text-muted-foreground">-</p>
    );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {Object.entries(value).map(([key, entry]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="font-mono break-all">
              {entry && typeof entry === "object"
                ? JSON.stringify(entry)
                : scalar(entry)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <p className="font-mono text-xs break-all">{scalar(value) || "-"}</p>;
}

function EdgeList({
  edges,
  staleBefore,
}: {
  edges: AssetEdge[];
  /** Outgoing edges not seen in the asset's latest collection are stale. */
  staleBefore: string | null;
}) {
  const { t } = useTranslation();
  if (!edges.length) {
    return (
      <p className="text-xs text-muted-foreground">{t("assets.noEdges")}</p>
    );
  }
  return (
    <ul className="space-y-1.5 text-xs">
      {edges.map((edge) => (
        <li key={edge.id} className="border border-border p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <ListBadge tone="muted">{edge.type}</ListBadge>
            <span className="font-medium">{edge.peer?.name ?? "?"}</span>
            {staleBefore && edge.lastSeen < staleBefore && (
              <ListBadge tone="warning">{t("assets.stale")}</ListBadge>
            )}
          </div>
          {edge.evidence && (
            <p className="mt-1 font-mono break-all text-muted-foreground">
              {edge.evidence}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One asset: its zone, facts by section and edges in and out. */
export function AssetDetailView({
  assetId,
  rules,
  canManage,
  onClose,
  onChanged,
}: {
  assetId: number;
  rules: ZoneRule[];
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const zoneLabel = useZoneLabel(rules);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await getAsset(assetId));
    } catch (err) {
      setError(apiMessage(err, t("assets.loadFailed")));
    }
  }, [assetId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const pin = async (zone: string) => {
    try {
      await pinZone(assetId, zone || null);
      await load();
      onChanged();
    } catch (err) {
      setError(apiMessage(err, t("assets.saveFailed")));
    }
  };

  const asset = detail?.asset;
  const zones = [...ZONE_NAMES, ...rules.map((rule) => rule.name)];
  return (
    <InlineView
      open
      onOpenChange={(open) => !open && onClose()}
      title={asset?.name ?? t("assets.title")}
      icon={<Network className="size-4" />}
      status={asset && <ZoneBadge asset={asset} rules={rules} />}
    >
      <div className="space-y-4 p-3">
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {asset && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">
                {t("assets.columns.kind")}
              </dt>
              <dd>{t(`assets.kind.${asset.kind}`)}</dd>
              <dt className="text-muted-foreground">
                {t("assets.columns.ips")}
              </dt>
              <dd className="font-mono">{asset.ips.join(", ") || "-"}</dd>
              <dt className="text-muted-foreground">
                {t("assets.columns.collected")}
              </dt>
              <dd>
                {asset.collectedAt
                  ? new Date(asset.collectedAt).toLocaleString()
                  : "-"}
              </dd>
              {asset.removedAt && (
                <>
                  <dt className="text-muted-foreground">
                    {t("assets.removed")}
                  </dt>
                  <dd>{new Date(asset.removedAt).toLocaleString()}</dd>
                </>
              )}
            </dl>
            <AnnotationFields
              asset={asset}
              canManage={canManage}
              onSaved={() => {
                void load();
                onChanged();
              }}
            />
            {canManage && (
              <SelectField
                label={t("assets.pinZone")}
                value={asset.zoneSource === "user" ? (asset.zone ?? "") : ""}
                onChange={(zone) => void pin(zone)}
                options={[
                  { value: "", label: t("assets.rulesDecide") },
                  ...zones
                    .filter((name, index) => zones.indexOf(name) === index)
                    .map((name) => ({ value: name, label: zoneLabel(name) })),
                ]}
              />
            )}
            <section className="space-y-2">
              <GroupHeading
                title={t("assets.outgoing")}
                count={detail.outgoing.length}
              />
              <EdgeList
                edges={detail.outgoing}
                staleBefore={asset.collectedAt}
              />
              <GroupHeading
                title={t("assets.incoming")}
                count={detail.incoming.length}
              />
              <EdgeList edges={detail.incoming} staleBefore={null} />
            </section>
            {Object.entries(asset.facts ?? {}).map(([section, value]) => (
              <section key={section} className="space-y-1.5">
                <GroupHeading
                  title={t(`assets.sections.${section}`, {
                    defaultValue: section,
                  })}
                />
                <FactValue value={value} />
              </section>
            ))}
          </>
        )}
      </div>
    </InlineView>
  );
}
