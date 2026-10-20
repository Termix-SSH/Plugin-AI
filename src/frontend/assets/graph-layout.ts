import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge, GraphNode, Importance } from "./api";

/**
 * Where the graph view draws each node. A force layout run to rest up front,
 * not animated: nodes repel, edges pull, and each zone pulls its nodes to
 * its own spot on a ring, so zones read as groups. Seeded positions keep
 * the same inventory in the same place from one load to the next.
 */

export const RADIUS: Record<Importance | "none", number> = {
  critical: 11,
  high: 9,
  medium: 7,
  low: 6,
  none: 5,
};

/** Ordinal, one hue light to dark (the importance ramp); unset is grey. */
export const IMPORTANCE_FILL: Record<Importance | "none", string> = {
  low: "#86b6ef",
  medium: "#3987e5",
  high: "#1c5cab",
  critical: "#0d366b",
  none: "#a8a7a1",
};

/**
 * The tint of a zone's area, by zone kind in a fixed order checked for
 * colour-blind separation. Areas are always labelled, so the tint is never
 * the only cue.
 */
export const ZONE_TINT: Record<string, string> = {
  internal: "#1baf7a",
  dmz: "#eda100",
  external: "#e87ba4",
  cloud: "#6250d6",
  overlay: "#eb6834",
  none: "#a8a7a1",
};

const TICKS = 300;

export interface PlacedNode extends GraphNode {
  x: number;
  y: number;
  r: number;
  group: string;
}

export interface ZoneArea {
  zone: string;
  x: number;
  y: number;
  r: number;
}

export interface Layout {
  nodes: PlacedNode[];
  byId: Map<number, PlacedNode>;
  zones: ZoneArea[];
  bounds: { x: number; y: number; width: number; height: number };
}

type SimNode = PlacedNode & SimulationNodeDatum;

/** A stable pseudo-random start from the node's key. */
function seed(key: string): number {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 1000) / 1000;
}

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): Layout {
  const groups = [...new Set(nodes.map((node) => node.zone ?? "none"))].sort();
  const ring = groups.length > 1 ? 140 * Math.sqrt(groups.length) : 0;
  const centers = new Map(
    groups.map((group, index) => {
      const angle = (index / groups.length) * 2 * Math.PI;
      return [group, { x: ring * Math.cos(angle), y: ring * Math.sin(angle) }];
    }),
  );

  const sim: SimNode[] = nodes.map((node) => {
    const group = node.zone ?? "none";
    const center = centers.get(group)!;
    const angle = seed(node.key) * 2 * Math.PI;
    return {
      ...node,
      group,
      r: RADIUS[node.importance ?? "none"],
      x: center.x + 60 * Math.cos(angle),
      y: center.y + 60 * Math.sin(angle),
    };
  });
  const ids = new Set(sim.map((node) => node.id));
  const links: Array<SimulationLinkDatum<SimNode>> = edges
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
    .map((edge) => ({ source: edge.from, target: edge.to }));

  forceSimulation(sim)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((node) => node.id)
        .distance(45)
        .strength(0.2),
    )
    .force("charge", forceManyBody<SimNode>().strength(-70).distanceMax(320))
    .force(
      "x",
      forceX<SimNode>((node) => centers.get(node.group)!.x).strength(0.12),
    )
    .force(
      "y",
      forceY<SimNode>((node) => centers.get(node.group)!.y).strength(0.12),
    )
    .force(
      "collide",
      forceCollide<SimNode>((node) => node.r + 4),
    )
    .stop()
    .tick(TICKS);

  const zones = groups.map((zone) => {
    const members = sim.filter((node) => node.group === zone);
    const x = members.reduce((sum, node) => sum + node.x, 0) / members.length;
    const y = members.reduce((sum, node) => sum + node.y, 0) / members.length;
    const r = Math.max(
      ...members.map((node) => Math.hypot(node.x - x, node.y - y) + node.r),
    );
    return { zone, x, y, r: r + 18 };
  });
  const xs = zones.flatMap((zone) => [zone.x - zone.r, zone.x + zone.r]);
  const ys = zones.flatMap((zone) => [zone.y - zone.r, zone.y + zone.r]);
  const pad = 20;
  const bounds = xs.length
    ? {
        x: Math.min(...xs) - pad,
        y: Math.min(...ys) - pad,
        width: Math.max(...xs) - Math.min(...xs) + 2 * pad,
        height: Math.max(...ys) - Math.min(...ys) + 2 * pad,
      }
    : { x: -100, y: -100, width: 200, height: 200 };
  const placed = sim as PlacedNode[];
  return {
    nodes: placed,
    byId: new Map(placed.map((node) => [node.id, node])),
    zones,
    bounds,
  };
}
