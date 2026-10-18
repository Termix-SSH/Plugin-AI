import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, SelectField, PanelSearch } from "@termix-ssh/plugin-sdk/ui";
import { aiApp } from "../app-ref";
import { SOURCES, type Entry } from "../../backend/exposure/types";
import type { Change } from "../../backend/exposure/repository";
interface Data {
  entries: Entry[];
  total: number;
  offset: number;
  summary?: { all: number; internet: number; unknown: number };
  zones?: string[];
  coverage: Array<{
    hostId: number;
    source: string;
    at: string;
    status: string;
    complete: boolean;
    issues?: Array<{ objectKey: string; reason: string }>;
  }>;
  changes: Change[];
}
interface Client {
  get(path: string): Promise<{ data: Data }>;
  post(path: string): Promise<{ data: { text: string } }>;
  put(path: string, body: unknown): Promise<unknown>;
}
const address = (e: Entry["endpoint"]) =>
  `${e.protocol}://${e.address.includes(":") ? `[${e.address}]` : e.address}:${e.port}`;
export function ExposureView({
  canManage,
  refreshKey,
}: {
  canManage: boolean;
  refreshKey: number;
}) {
  const { t } = useTranslation();
  const requestId = useRef(0);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState("");
  const [zone, setZone] = useState("");
  const [source, setSource] = useState("");
  const [state, setState] = useState("active");
  const [scope, setScope] = useState("internet");
  const [explanation, setExplanation] = useState<{
    key: string;
    observationId: string;
    text: string;
  } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    const params = new URLSearchParams({
      q: query,
      priority,
      zone,
      source,
      state,
      scope,
      offset: String(offset),
    });
    try {
      const result = await (aiApp().api as unknown as Client).get(
        `assets/exposure?${params}`,
      );
      if (id === requestId.current) {
        setData(result.data);
        setError("");
      }
    } catch {
      if (id === requestId.current) {
        setData(null);
        setError(t("exposure.loadFailed"));
      }
    }
  }, [t, query, priority, zone, source, state, scope, offset]);
  useEffect(() => {
    setOffset(0);
  }, [query, priority, zone, source, state, scope]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => {
      clearInterval(timer);
      requestId.current++;
    };
  }, [load, refreshKey]);
  const entry = data?.entries.find((e) => e.key === selected);
  useEffect(() => {
    setExplanation(null);
  }, [selected, entry?.observationId]);
  async function explainEntry() {
    if (!entry) return;
    setExplaining(true);
    setExplanation(null);
    try {
      setExplanation({
        key: entry.key,
        observationId: entry.observationId,
        text: (
          await (aiApp().api as unknown as Client).post(
            `assets/exposure/${entry.key}/explain`,
          )
        ).data.text,
      });
    } catch {
      setError(t("exposure.explainFailed"));
    } finally {
      setExplaining(false);
    }
  }
  const rows = data?.entries ?? [];
  async function override(value: string) {
    if (!entry) return;
    try {
      await (aiApp().api as unknown as Client).put(
        `assets/exposure/${entry.key}/priority`,
        { priority: value || null },
      );
      await load();
    } catch {
      setError(t("exposure.saveFailed"));
    }
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 text-sm">
      <p className="mb-3 text-muted-foreground">{t("exposure.disclaimer")}</p>
      {data?.summary && (
        <p className="mb-2 text-muted-foreground">
          {t("exposure.inventorySummary", data.summary)}
        </p>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <SelectField
          label={t("exposure.scope")}
          value={scope}
          onChange={setScope}
          options={["internet", "all", "unknown"].map((value) => ({
            value,
            label: t(`exposure.scope_${value}`),
          }))}
        />
        <PanelSearch
          value={query}
          onChange={setQuery}
          placeholder={t("exposure.search")}
        />
        <SelectField
          label={t("exposure.priority")}
          value={priority}
          onChange={setPriority}
          options={[
            { value: "", label: t("exposure.allPriority") },
            ...(["high", "medium", "low"] as const).map((value) => ({
              value,
              label: t(`exposure.${value}`),
            })),
          ]}
        />
        <SelectField
          label={t("exposure.allZones")}
          value={zone}
          onChange={setZone}
          options={[
            { value: "", label: t("exposure.allZones") },
            ...[
              ...new Set(
                data?.zones ??
                  data?.entries.flatMap((e) => (e.zone ? [e.zone] : [])) ??
                  [],
              ),
            ].map((value) => ({ value, label: value })),
          ]}
        />
        <SelectField
          label={t("exposure.source")}
          value={source}
          onChange={setSource}
          options={[
            { value: "", label: t("exposure.allSources") },
            ...SOURCES.map((value) => ({ value, label: value })),
          ]}
        />
        <SelectField
          label={t("exposure.freshness")}
          value={state}
          onChange={setState}
          options={["active", "stale", "resolved", "all"].map((value) => ({
            value,
            label: t(`exposure.${value}`),
          }))}
        />
        <Button size="sm" variant="outline" onClick={() => void load()}>
          {t("exposure.refresh")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!data && !error && <p>{t("exposure.loading")}</p>}
      {data && (
        <>
          {!rows.length && (
            <p>
              {t(data.coverage.length ? "exposure.empty" : "exposure.never")}
            </p>
          )}
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {[
                  "endpoint",
                  "source",
                  "binding",
                  "priority",
                  "pathState",
                  "freshness",
                ].map((key) => (
                  <th className="p-2" key={key}>
                    {t(`exposure.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.key} className="border-t border-border">
                  <td className="p-2">
                    <button
                      className="text-primary underline"
                      onClick={() => setSelected(e.key)}
                    >
                      {address(e.endpoint)} {e.hostname} {e.path}
                    </button>
                    {!!e.bindings?.length && (
                      <p className="text-muted-foreground">
                        {t("exposure.bindingCount", {
                          count: e.bindings.length,
                        })}
                      </p>
                    )}
                  </td>
                  <td className="p-2">
                    #{e.sourceHostId} · {e.source}
                  </td>
                  <td className="p-2">
                    {t(`exposure.binding_${e.binding ?? "unknown"}`)}
                  </td>
                  <td className="p-2">{t(`exposure.${e.priority}`)}</td>
                  <td className="p-2">{t(`exposure.${e.pathStatus}`)}</td>
                  <td className="p-2">
                    {t(
                      e.resolvedAt
                        ? "exposure.resolved"
                        : e.staleAt
                          ? "exposure.stale"
                          : "exposure.current",
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="my-2 flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 100))}
            >
              {t("exposure.previous")}
            </Button>
            <span>{data.total ?? rows.length}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + rows.length >= (data.total ?? rows.length)}
              onClick={() => setOffset(offset + 100)}
            >
              {t("exposure.next")}
            </Button>
          </div>
          {entry && (
            <section
              className="my-4 rounded border border-border p-3"
              aria-label={t("exposure.details")}
            >
              <div className="flex justify-between">
                <h3>{t("exposure.details")}</h3>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected(null)}
                >
                  {t("exposure.close")}
                </Button>
              </div>
              <p>{t("exposure.notTested")}</p>
              {canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={explaining}
                  onClick={() => void explainEntry()}
                >
                  {t(explaining ? "exposure.explaining" : "exposure.explain")}
                </Button>
              )}
              {explanation?.key === entry.key &&
                explanation.observationId === entry.observationId && (
                  <div className="my-2 whitespace-pre-wrap rounded border border-border p-2">
                    <strong>{t("exposure.aiLabel")}</strong>
                    <p>{explanation.text}</p>
                  </div>
                )}
              <p>{t("exposure.priorityReason")}</p>
              <ul>
                {entry.priorityReasons?.map((reason) => (
                  <li key={reason}>
                    {reason.startsWith("sensitive-service:")
                      ? t("exposure.reason_sensitive", {
                          port: reason.split(":")[1],
                        })
                      : t(`exposure.reason_${reason}`)}
                  </li>
                ))}
              </ul>
              <details className="my-2">
                <summary>
                  {t("exposure.bindingCount", {
                    count: entry.bindings?.length ?? 1,
                  })}
                </summary>
                <ul>
                  {(entry.bindings ?? [entry.endpoint]).map((binding, i) => (
                    <li key={i}>{address(binding)}</li>
                  ))}
                </ul>
              </details>
              <p>
                {t("exposure.tls")}: {t(`exposure.${entry.tls}`)} ·{" "}
                {t("exposure.restrictions")}:{" "}
                {t(`exposure.${entry.restricted}`)}
              </p>
              <p>
                {t("exposure.observed")}:{" "}
                {new Date(entry.lastSeen).toLocaleString()}
              </p>
              {canManage && (
                <SelectField
                  label={t("exposure.priority")}
                  value={entry.prioritySource === "user" ? entry.priority : ""}
                  onChange={(value) => void override(value)}
                  options={[
                    { value: "", label: t("exposure.rulePriority") },
                    ...["high", "medium", "low"].map((value) => ({
                      value,
                      label: t(`exposure.${value}`),
                    })),
                  ]}
                />
              )}
              {entry.pathsTruncated && <p>{t("exposure.pathsTruncated")}</p>}
              {(
                entry.paths ?? [{ hops: entry.hops, status: entry.pathStatus }]
              ).map((path, pathIndex) => (
                <details
                  key={pathIndex}
                  className="my-2 rounded border border-border p-2"
                  open={(entry.paths?.length ?? 1) === 1}
                >
                  <summary>
                    {t("exposure.pathBranch", { index: pathIndex + 1 })} ·{" "}
                    {t(`exposure.${path.status}`)} ·{" "}
                    {path.hops
                      .filter((h) => h.hostname || h.path)
                      .map((h) => `${h.hostname ?? ""}${h.path ?? ""}`)
                      .join(" → ")}
                  </summary>
                  <ol className="mt-2 list-decimal pl-5">
                    {path.hops.map((hop, index) => (
                      <li key={index}>
                        <span>
                          #{hop.sourceHostId} · {hop.source}:{" "}
                          {address(hop.endpoint)}
                          {hop.backend ? ` → ${address(hop.backend)}` : ""}{" "}
                          {hop.hostname} {hop.path}
                        </span>
                        <p className="text-muted-foreground">
                          {hop.constraints.join("; ") || t("exposure.unknown")}
                        </p>
                        <small>
                          {t("exposure.evidence")}:{" "}
                          {(hop.observationIds ?? [hop.observationId]).join(
                            ", ",
                          )}
                        </small>
                      </li>
                    ))}
                  </ol>
                </details>
              ))}
            </section>
          )}
          <details className="mt-4" open>
            <summary>{t("exposure.coverage")}</summary>
            <ul className="mt-2 text-xs">
              {data.coverage.map((c, i) => (
                <li key={i}>
                  #{c.hostId} · {c.source}: {t(`exposure.status_${c.status}`)} ·{" "}
                  {t(c.complete ? "exposure.complete" : "exposure.partial")} ·{" "}
                  {new Date(c.at).toLocaleString()}
                  {!!c.issues?.length && (
                    <details>
                      <summary>
                        {t("exposure.ruleGaps", { count: c.issues.length })}
                      </summary>
                      <ul>
                        {c.issues.map((issue, j) => (
                          <li key={j}>
                            {issue.objectKey} · {t("exposure.unsupportedRule")}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </details>
          <details className="mt-4">
            <summary>{t("exposure.changes")}</summary>
            <ul className="mt-2 text-xs">
              {data.changes.map((c) => (
                <li key={c.id}>
                  #{c.hostId} · {t(`exposure.change_${c.kind}`)} ·{" "}
                  {new Date(c.at).toLocaleString()}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
