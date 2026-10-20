import type { AssetRecord, EdgeRecord } from "./repository.js";

/**
 * What else goes down when an asset does, from the edges alone.
 *
 * Strong: whatever runs on it, and whatever depends on it (an AI or user
 * depends_on), and so on transitively: a Proxmox node takes its guests, a
 * guest the containers on it, and each of those what depends on them.
 * Weak: whatever only connects to one of those, one hop; a connection is a
 * hint, not proof it cannot work without.
 *
 * Breadth first, so every asset is reached by its shortest path, which is
 * kept as the chain of edges from it down to the asset that failed.
 */

export const IMPACT_DEPTH = 6;
export const IMPACT_SIZE = 300;

const STRONG = new Set(["runs_on", "depends_on"]);

export interface PathStep {
  from: number;
  to: number;
  type: string;
  source: string;
}

export interface ImpactItem {
  asset: Pick<
    AssetRecord,
    "id" | "key" | "kind" | "name" | "zone" | "importance" | "role"
  >;
  depth: number;
  /** From this asset down to the one that failed. */
  path: PathStep[];
}

export type ImportanceCounts = Record<
  "critical" | "high" | "medium" | "low" | "unknown",
  number
>;

export interface Impact {
  direct: ImpactItem[];
  transitive: ImpactItem[];
  weak: ImpactItem[];
  counts: { strong: ImportanceCounts; weak: ImportanceCounts };
  truncated: boolean;
}

const brief = (asset: AssetRecord): ImpactItem["asset"] => ({
  id: asset.id,
  key: asset.key,
  kind: asset.kind,
  name: asset.name,
  zone: asset.zone,
  importance: asset.importance,
  role: asset.role,
});

const step = (edge: EdgeRecord): PathStep => ({
  from: edge.fromAsset,
  to: edge.toAsset,
  type: edge.type,
  source: edge.source,
});

function count(items: ImpactItem[]): ImportanceCounts {
  const counts: ImportanceCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
  };
  for (const item of items) {
    const key = (item.asset.importance ?? "unknown") as keyof ImportanceCounts;
    counts[key in counts ? key : "unknown"] += 1;
  }
  return counts;
}

export function impactOf(
  rootId: number,
  assets: AssetRecord[],
  edges: EdgeRecord[],
  limits = { depth: IMPACT_DEPTH, size: IMPACT_SIZE },
): Impact {
  const byId = new Map(
    assets
      .filter((asset) => !asset.removedAt)
      .map((asset) => [asset.id, asset]),
  );
  const incoming = new Map<number, EdgeRecord[]>();
  for (const edge of edges) {
    if (!byId.has(edge.fromAsset) || !byId.has(edge.toAsset)) continue;
    const list = incoming.get(edge.toAsset) ?? [];
    list.push(edge);
    incoming.set(edge.toAsset, list);
  }

  let truncated = false;
  const reached = new Map<number, ImpactItem>();
  const queue: Array<{ id: number; depth: number; path: PathStep[] }> = [
    { id: rootId, depth: 0, path: [] },
  ];
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (next.depth >= limits.depth) {
      truncated ||= (incoming.get(next.id) ?? []).some((e) =>
        STRONG.has(e.type),
      );
      continue;
    }
    for (const edge of incoming.get(next.id) ?? []) {
      if (!STRONG.has(edge.type)) continue;
      if (edge.fromAsset === rootId || reached.has(edge.fromAsset)) continue;
      if (reached.size >= limits.size) {
        truncated = true;
        break;
      }
      const item = {
        asset: brief(byId.get(edge.fromAsset)!),
        depth: next.depth + 1,
        path: [step(edge), ...next.path],
      };
      reached.set(edge.fromAsset, item);
      queue.push({ id: edge.fromAsset, depth: item.depth, path: item.path });
    }
  }

  const strong = [...reached.values()];
  const weak = new Map<number, ImpactItem>();
  const targets = [
    { id: rootId, depth: 0, path: [] as PathStep[] },
    ...strong.map((item) => ({ ...item, id: item.asset.id })),
  ];
  for (const target of targets) {
    for (const edge of incoming.get(target.id) ?? []) {
      const from = edge.fromAsset;
      if (edge.type !== "connects_to" || from === rootId) continue;
      if (reached.has(from) || weak.has(from)) continue;
      if (weak.size >= limits.size) {
        truncated = true;
        break;
      }
      weak.set(from, {
        asset: brief(byId.get(from)!),
        depth: target.depth + 1,
        path: [step(edge), ...target.path],
      });
    }
  }

  const byName = (a: ImpactItem, b: ImpactItem) =>
    a.depth - b.depth || a.asset.name.localeCompare(b.asset.name);
  const weakItems = [...weak.values()].sort(byName);
  return {
    direct: strong.filter((item) => item.depth === 1).sort(byName),
    transitive: strong.filter((item) => item.depth > 1).sort(byName),
    weak: weakItems,
    counts: { strong: count(strong), weak: count(weakItems) },
    truncated,
  };
}
