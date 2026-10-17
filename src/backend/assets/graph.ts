import type { AssetRecord, EdgeRecord } from "./repository.js";

/**
 * The inventory as the graph view draws it: live assets as nodes, edges of
 * the asked types between them.
 *
 * Containers are folded into the host they run on unless asked for: the
 * host counts them, and their edges move to it (a container's runs_on to
 * its own host disappears). External addresses are left out unless asked
 * for, with their edges.
 */

export const GRAPH_EDGE_TYPES = ["runs_on", "depends_on", "connects_to"];

export interface GraphNode {
  id: number;
  key: string;
  kind: AssetRecord["kind"];
  name: string;
  zone: string | null;
  multiZone: boolean;
  role: string | null;
  importance: string | null;
  system: string | null;
  /** Containers folded into this node. */
  containers: number;
}

export interface GraphEdge {
  key: string;
  from: number;
  to: number;
  type: string;
  source: string;
  /** A collector edge its source's latest collection did not see. */
  stale: boolean;
}

export interface GraphOptions {
  types: string[];
  external: boolean;
  containers: boolean;
}

export function graphPayload(
  assets: AssetRecord[],
  edges: EdgeRecord[],
  options: GraphOptions,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const live = assets.filter(
    (asset) =>
      !asset.removedAt && (options.external || asset.kind !== "external"),
  );
  const byId = new Map(live.map((asset) => [asset.id, asset]));
  // Where a folded container's edges go: the host it runs on.
  const foldedInto = new Map<number, number>();
  if (!options.containers) {
    for (const edge of edges) {
      const from = byId.get(edge.fromAsset);
      if (
        edge.type === "runs_on" &&
        from?.kind === "container" &&
        byId.has(edge.toAsset)
      ) {
        foldedInto.set(from.id, edge.toAsset);
      }
    }
  }
  const counts = new Map<number, number>();
  for (const host of foldedInto.values()) {
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }

  const nodes: GraphNode[] = live
    .filter((asset) => !foldedInto.has(asset.id))
    .map((asset) => ({
      id: asset.id,
      key: asset.key,
      kind: asset.kind,
      name: asset.name,
      zone: asset.zone,
      multiZone: asset.multiZone,
      role: asset.role,
      importance: asset.importance,
      system: asset.system,
      containers: counts.get(asset.id) ?? 0,
    }));

  const out = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (!options.types.includes(edge.type)) continue;
    if (!byId.has(edge.fromAsset) || !byId.has(edge.toAsset)) continue;
    const from = foldedInto.get(edge.fromAsset) ?? edge.fromAsset;
    const to = foldedInto.get(edge.toAsset) ?? edge.toAsset;
    if (from === to) continue;
    const key = `${from}|${to}|${edge.type}`;
    if (out.has(key)) continue;
    const collectedAt = byId.get(edge.fromAsset)?.collectedAt;
    out.set(key, {
      key,
      from,
      to,
      type: edge.type,
      source: edge.source,
      stale:
        edge.source === "collector" &&
        !!collectedAt &&
        edge.lastSeen < collectedAt,
    });
  }
  return { nodes, edges: [...out.values()] };
}
