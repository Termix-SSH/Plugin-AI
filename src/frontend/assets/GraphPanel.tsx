import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, GroupHeading, ListBadge } from "@termix-ssh/plugin-sdk/ui";
import { Crosshair, X } from "lucide-react";
import { apiMessage } from "../autoops/api";
import { AnnotationFields, ImportanceBadge } from "./AnnotationFields";
import { ZoneBadge } from "./ZoneBadge";
import {
  getAsset,
  getImpact,
  type AssetDetail,
  type AssetEdge,
  type Impact,
  type ImpactItem,
  type ZoneRule,
} from "./api";

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

function EdgeRows({
  edges,
  onSelect,
}: {
  edges: AssetEdge[];
  onSelect: (id: number) => void;
}) {
  const { t } = useTranslation();
  if (!edges.length) {
    return (
      <p className="text-xs text-muted-foreground">{t("assets.noEdges")}</p>
    );
  }
  return (
    <ul className="space-y-1 text-xs">
      {edges.map((edge) => (
        <li
          key={edge.id}
          className="flex flex-wrap items-center gap-1.5"
          title={edge.evidence ?? undefined}
        >
          <ListBadge tone="muted">{edge.type}</ListBadge>
          {edge.peer ? (
            <button
              type="button"
              className="truncate font-medium hover:underline"
              onClick={() => onSelect(edge.peer!.id)}
            >
              {edge.peer.name}
            </button>
          ) : (
            <span>?</span>
          )}
          {edge.source === "ai" && (
            <ListBadge tone="brand">{t("assets.sourceAi")}</ListBadge>
          )}
        </li>
      ))}
    </ul>
  );
}

function ImpactGroup({
  title,
  items,
  names,
  onSelect,
}: {
  title: string;
  items: ImpactItem[];
  names: Map<number, string>;
  onSelect: (id: number) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="space-y-1">
      <GroupHeading title={title} count={items.length} />
      <ul className="space-y-1 text-xs">
        {items.map((item) => (
          <li key={item.asset.id}>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="truncate font-medium hover:underline"
                onClick={() => onSelect(item.asset.id)}
              >
                {item.asset.name}
              </button>
              <ImportanceBadge importance={item.asset.importance} />
            </div>
            <p className="truncate text-muted-foreground">
              {item.path
                .map(
                  (step) =>
                    `${step.type} ${names.get(step.to) ?? `#${step.to}`}`,
                )
                .join(" → ")}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The selected node of the graph: its annotations (editable for managers),
 * a summary of its facts, its edges, and the impact of it failing.
 */
export function GraphPanel({
  nodeId,
  rules,
  canManage,
  impact,
  onImpact,
  onSelect,
  onChanged,
  onClose,
}: {
  nodeId: number;
  rules: ZoneRule[];
  canManage: boolean;
  impact: Impact | null;
  onImpact: (impact: Impact | null) => void;
  onSelect: (id: number) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await getAsset(nodeId));
      setError(null);
    } catch (err) {
      setError(apiMessage(err, t("assets.loadFailed")));
    }
  }, [nodeId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const showImpact = async () => {
    try {
      onImpact(await getImpact(nodeId));
    } catch (err) {
      setError(apiMessage(err, t("assets.loadFailed")));
    }
  };

  const asset = detail?.asset;
  const facts = asset?.facts ?? {};
  const os = (facts.os as { pretty?: string } | undefined)?.pretty;
  const mine = impact?.asset.id === nodeId ? impact : null;
  const names = new Map<number, string>();
  if (mine) {
    names.set(mine.asset.id, mine.asset.name);
    for (const item of [...mine.direct, ...mine.transitive, ...mine.weak]) {
      names.set(item.asset.id, item.asset.name);
    }
  }
  const strong = mine ? mine.direct.length + mine.transitive.length : 0;

  return (
    <aside
      aria-label={asset?.name ?? t("assets.title")}
      className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-border"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-medium">
          {asset?.name ?? "…"}
        </span>
        <button
          type="button"
          aria-label={t("assets.closePanel")}
          className="text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="space-y-4 p-3">
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {asset && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <ListBadge tone="muted">
                {t(`assets.kind.${asset.kind}`)}
              </ListBadge>
              <ZoneBadge asset={asset} rules={rules} />
            </div>
            <AnnotationFields
              asset={asset}
              canManage={canManage}
              onSaved={() => {
                void load();
                onChanged();
              }}
            />
            <section className="space-y-1">
              <GroupHeading title={t("assets.factsTitle")} />
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-muted-foreground">
                  {t("assets.columns.ips")}
                </dt>
                <dd className="font-mono break-all">
                  {asset.ips.join(", ") || "-"}
                </dd>
                {os && (
                  <>
                    <dt className="text-muted-foreground">
                      {t("assets.sections.os")}
                    </dt>
                    <dd>{os}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">
                  {t("assets.columns.listening")}
                </dt>
                <dd>{count(facts.listening)}</dd>
                <dt className="text-muted-foreground">
                  {t("assets.columns.services")}
                </dt>
                <dd>{count(facts.services)}</dd>
                <dt className="text-muted-foreground">
                  {t("assets.sections.containers")}
                </dt>
                <dd>{count(facts.containers)}</dd>
              </dl>
            </section>
            <section className="space-y-1">
              <GroupHeading
                title={t("assets.outgoing")}
                count={detail.outgoing.length}
              />
              <EdgeRows edges={detail.outgoing} onSelect={onSelect} />
              <GroupHeading
                title={t("assets.incoming")}
                count={detail.incoming.length}
              />
              <EdgeRows edges={detail.incoming} onSelect={onSelect} />
            </section>
            <section className="space-y-2">
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void showImpact()}
                >
                  <Crosshair className="size-3.5" />
                  {t("assets.impact")}
                </Button>
                {mine && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onImpact(null)}
                  >
                    {t("assets.clearImpact")}
                  </Button>
                )}
              </div>
              {mine && (
                <>
                  <p className="text-xs">
                    {t("assets.impactSummary", {
                      count: strong,
                      critical: mine.counts.strong.critical,
                      high: mine.counts.strong.high,
                      weak: mine.weak.length,
                    })}
                  </p>
                  {mine.truncated && (
                    <p className="text-xs text-muted-foreground">
                      {t("assets.impactTruncated")}
                    </p>
                  )}
                  <ImpactGroup
                    title={t("assets.impactDirect")}
                    items={mine.direct}
                    names={names}
                    onSelect={onSelect}
                  />
                  <ImpactGroup
                    title={t("assets.impactTransitive")}
                    items={mine.transitive}
                    names={names}
                    onSelect={onSelect}
                  />
                  <ImpactGroup
                    title={t("assets.impactWeak")}
                    items={mine.weak}
                    names={names}
                    onSelect={onSelect}
                  />
                </>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
