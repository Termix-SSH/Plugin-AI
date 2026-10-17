import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { EmptyState } from "@termix-ssh/plugin-sdk/ui";
import { Network } from "lucide-react";
import { apiMessage } from "../autoops/api";
import { GraphPanel } from "./GraphPanel";
import {
  IMPORTANCE_FILL,
  layoutGraph,
  ZONE_TINT,
  type Layout,
  type PlacedNode,
} from "./graph-layout";
import { useZoneLabel } from "./ZoneBadge";
import {
  getGraph,
  type EdgeType,
  type GraphEdge,
  type GraphNode,
  type GraphOptions,
  type Impact,
  type ZoneRule,
} from "./api";

const EDGE_TYPES: EdgeType[] = ["runs_on", "depends_on", "connects_to"];

/** Below this many nodes every one is named; above, only the important. */
const LABEL_ALL = 60;

const EDGE_STYLE: Record<EdgeType, { width: number; dash?: string }> = {
  runs_on: { width: 1.2 },
  depends_on: { width: 1.6 },
  connects_to: { width: 0.8, dash: "3 3" },
};

/**
 * The impact as node ids on this graph. A folded container stands for its
 * host, whose key it carries.
 */
function impactIds(impact: Impact, nodes: GraphNode[]) {
  const byKey = new Map(nodes.map((node) => [node.key, node.id]));
  const onGraph = (key: string, id: number) => {
    if (byKey.has(key)) return id;
    const host = /^container:(\d+)\//.exec(key);
    return host ? (byKey.get(`host:${host[1]}`) ?? null) : null;
  };
  const ids = (items: Impact["direct"]) =>
    new Set(
      items
        .map((item) => onGraph(item.asset.key, item.asset.id))
        .filter((id): id is number => id !== null),
    );
  return {
    root: impact.asset.id,
    strong: ids([...impact.direct, ...impact.transitive]),
    weak: ids(impact.weak),
  };
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function Legend() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
      {(["critical", "high", "medium", "low", "none"] as const).map((level) => (
        <span key={level} className="flex items-center gap-1">
          <svg width="10" height="10" aria-hidden>
            <circle cx="5" cy="5" r="4.5" fill={IMPORTANCE_FILL[level]} />
          </svg>
          {level === "none"
            ? t("assets.importanceUnknown")
            : t(`assets.importance.${level}`)}
        </span>
      ))}
      {EDGE_TYPES.map((type) => (
        <span key={type} className="flex items-center gap-1">
          <svg width="18" height="6" aria-hidden>
            <line
              x1="0"
              y1="3"
              x2="18"
              y2="3"
              stroke="currentColor"
              strokeWidth={EDGE_STYLE[type].width + 0.4}
              strokeDasharray={EDGE_STYLE[type].dash}
            />
          </svg>
          {type}
        </span>
      ))}
    </div>
  );
}

function Edges({
  layout,
  edges,
  dim,
}: {
  layout: Layout;
  edges: GraphEdge[];
  dim: (edge: GraphEdge) => boolean;
}) {
  return (
    <g className="text-muted-foreground">
      {edges.map((edge) => {
        const from = layout.byId.get(edge.from);
        const to = layout.byId.get(edge.to);
        if (!from || !to) return null;
        const style = EDGE_STYLE[edge.type] ?? EDGE_STYLE.connects_to;
        return (
          <line
            key={edge.key}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="currentColor"
            strokeWidth={style.width}
            strokeDasharray={style.dash}
            markerEnd={
              edge.type === "depends_on" ? "url(#asset-arrow)" : undefined
            }
            opacity={dim(edge) ? 0.08 : edge.stale ? 0.35 : 0.7}
          />
        );
      })}
    </g>
  );
}

/**
 * The inventory as a graph: nodes grouped in zone areas, sized and shaded by
 * importance, edges filtered by type. Click a node for its panel; Impact
 * there dims everything it would not take down.
 */
export function GraphView({
  rules,
  canManage,
  refreshKey,
  onChanged,
}: {
  rules: ZoneRule[];
  canManage: boolean;
  /** Changes when the inventory may have, to read the graph again. */
  refreshKey: number;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const zoneLabel = useZoneLabel(rules);
  const [options, setOptions] = useState<GraphOptions>({
    types: EDGE_TYPES,
    containers: false,
    external: false,
  });
  const [graph, setGraph] = useState<{
    nodes: GraphNode[];
    edges: GraphEdge[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setGraph(await getGraph(options));
      setError(null);
    } catch (err) {
      setError(apiMessage(err, t("assets.loadFailed")));
    }
  }, [options, t]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const layout = useMemo(
    () => (graph ? layoutGraph(graph.nodes, graph.edges) : null),
    [graph],
  );
  const highlight = useMemo(
    () => (impact && graph ? impactIds(impact, graph.nodes) : null),
    [impact, graph],
  );

  const kindOf = (zone: string) =>
    rules.find((rule) => rule.name === zone)?.kind ?? zone;
  const lit = (id: number) =>
    !highlight ||
    id === highlight.root ||
    highlight.strong.has(id) ||
    highlight.weak.has(id);
  const setType = (type: EdgeType, on: boolean) =>
    setOptions({
      ...options,
      types: EDGE_TYPES.filter((entry) =>
        entry === type ? on : options.types.includes(entry),
      ),
    });

  const nodeStroke = (node: PlacedNode) => {
    if (!highlight)
      return { width: node.id === selected ? 2.5 : 1, dash: undefined };
    if (node.id === highlight.root) return { width: 3, dash: undefined };
    if (highlight.strong.has(node.id)) return { width: 2.5, dash: undefined };
    if (highlight.weak.has(node.id)) return { width: 2, dash: "2 2" };
    return { width: 1, dash: undefined };
  };

  const labelled = (node: PlacedNode) =>
    (layout?.nodes.length ?? 0) <= LABEL_ALL ||
    node.importance === "critical" ||
    node.importance === "high" ||
    node.id === selected ||
    (!!highlight && lit(node.id));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-2">
        {EDGE_TYPES.map((type) => (
          <Toggle
            key={type}
            label={type}
            checked={options.types.includes(type)}
            onChange={(on) => setType(type, on)}
          />
        ))}
        <Toggle
          label={t("assets.expandContainers")}
          checked={options.containers}
          onChange={(containers) => setOptions({ ...options, containers })}
        />
        <Toggle
          label={t("assets.showExternal")}
          checked={options.external}
          onChange={(external) => setOptions({ ...options, external })}
        />
        <span className="ml-auto text-xs text-muted-foreground">
          {graph
            ? t("assets.graphCounts", {
                nodes: graph.nodes.length,
                edges: graph.edges.length,
              })
            : ""}
        </span>
      </div>
      <Legend />
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {layout && !layout.nodes.length && (
            <EmptyState icon={Network} title={t("assets.empty")} />
          )}
          {layout && layout.nodes.length > 0 && (
            <svg
              role="img"
              aria-label={t("assets.graphTitle")}
              className="size-full cursor-grab touch-none select-none"
              viewBox={`${layout.bounds.x} ${layout.bounds.y} ${layout.bounds.width} ${layout.bounds.height}`}
              onWheel={(event) => {
                const k = Math.min(
                  8,
                  Math.max(0.3, view.k * (event.deltaY < 0 ? 1.15 : 0.87)),
                );
                setView({ ...view, k });
              }}
              onPointerDown={(event) => {
                drag.current = { x: event.clientX, y: event.clientY };
              }}
              onPointerMove={(event) => {
                if (!drag.current) return;
                const svg = event.currentTarget.getBoundingClientRect();
                const scale =
                  layout.bounds.width / Math.max(1, svg.width) / view.k;
                const dx = (event.clientX - drag.current.x) * scale;
                const dy = (event.clientY - drag.current.y) * scale;
                drag.current = { x: event.clientX, y: event.clientY };
                setView({ ...view, x: view.x + dx, y: view.y + dy });
              }}
              onPointerUp={() => (drag.current = null)}
              onPointerLeave={() => (drag.current = null)}
            >
              <defs>
                <marker
                  id="asset-arrow"
                  viewBox="0 0 10 10"
                  refX="16"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {layout.zones.map((zone) => (
                  <g key={zone.zone}>
                    <circle
                      cx={zone.x}
                      cy={zone.y}
                      r={zone.r}
                      fill={ZONE_TINT[kindOf(zone.zone)] ?? ZONE_TINT.none}
                      fillOpacity={0.08}
                      stroke={ZONE_TINT[kindOf(zone.zone)] ?? ZONE_TINT.none}
                      strokeOpacity={0.5}
                    />
                    <text
                      x={zone.x}
                      y={zone.y - zone.r + 12}
                      textAnchor="middle"
                      fontSize="11"
                      fill="currentColor"
                      className="text-muted-foreground"
                    >
                      {zone.zone === "none"
                        ? t("assets.noZone")
                        : zoneLabel(zone.zone)}
                    </text>
                  </g>
                ))}
                <Edges
                  layout={layout}
                  edges={graph!.edges}
                  dim={(edge) =>
                    !!highlight && !(lit(edge.from) && lit(edge.to))
                  }
                />
                {layout.nodes.map((node) => {
                  const stroke = nodeStroke(node);
                  return (
                    <g
                      key={node.id}
                      role="button"
                      aria-label={node.name}
                      aria-pressed={node.id === selected}
                      data-lit={lit(node.id) ? "true" : "false"}
                      className="cursor-pointer"
                      opacity={lit(node.id) ? 1 : 0.15}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => setSelected(node.id)}
                    >
                      <title>
                        {[node.name, node.role, node.system]
                          .filter(Boolean)
                          .join(" · ")}
                      </title>
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={node.r}
                        fill={IMPORTANCE_FILL[node.importance ?? "none"]}
                        stroke="currentColor"
                        strokeWidth={stroke.width}
                        strokeDasharray={stroke.dash}
                        className="text-foreground"
                      />
                      {node.containers > 0 && (
                        <text
                          x={node.x}
                          y={node.y + 3}
                          textAnchor="middle"
                          fontSize="8"
                          fill="#ffffff"
                        >
                          {node.containers}
                        </text>
                      )}
                      {labelled(node) && (
                        <text
                          x={node.x}
                          y={node.y + node.r + 10}
                          textAnchor="middle"
                          fontSize="9"
                          fill="currentColor"
                          className="text-foreground"
                        >
                          {node.name}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
        </div>
        {selected !== null && (
          <GraphPanel
            nodeId={selected}
            rules={rules}
            canManage={canManage}
            impact={impact}
            onImpact={setImpact}
            onSelect={setSelected}
            onChanged={() => {
              void load();
              onChanged();
            }}
            onClose={() => {
              setSelected(null);
              setImpact(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
