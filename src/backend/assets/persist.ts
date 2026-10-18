import {
  buildIpIndex,
  deriveConnections,
  deriveWorkloads,
  externalKey,
  hostDraft,
  hostKey,
  type AssetDraft,
  type CollectedHost,
  type EdgeDraft,
  type NamedHost,
} from "./derive.js";
import { normalizeIp } from "./net.js";
import type { AssetRecord, AssetRepository } from "./repository.js";
import { classifyAsset, compileRules } from "./zones.js";

/**
 * Writes one run's results: host assets, their guests and containers, the
 * external addresses they talk to, and the edges between them.
 *
 * An asset with no addresses of its own (a container, a guest pvesh only
 * named) takes the zone of the asset it runs on.
 */

export interface HostOutcome {
  hostId: number;
  name: string;
  address: string;
  facts?: CollectedHost["facts"];
  error?: string;
  complete?: boolean;
}

type Rules = ReturnType<typeof compileRules>;

const isCloud = (asset: Pick<AssetRecord, "facts">) =>
  !!(asset.facts as { cloud?: unknown } | null)?.cloud;

function namedHosts(assets: AssetRecord[]): NamedHost[] {
  return assets
    .filter((asset) => asset.kind === "host")
    .map((asset) => ({
      key: asset.key,
      names: [
        asset.name,
        String((asset.facts as { hostname?: unknown } | null)?.hostname ?? ""),
      ],
    }));
}

/** Writes drafts, each zoned by its addresses or by what it runs on. */
async function writeDrafts(
  repo: AssetRepository,
  rules: Rules,
  drafts: AssetDraft[],
  runsOn: Map<string, string>,
  collectedAt: string | undefined,
): Promise<void> {
  for (const draft of drafts) {
    let zone = classifyAsset(draft.ips, rules, draft.cloud);
    const parent = runsOn.get(draft.key);
    if (!draft.ips.length && parent) {
      const target = await repo.findByKey(parent);
      zone = { zone: target?.zone ?? null, multiZone: false, zones: [] };
    }
    await repo.upsertAsset({
      key: draft.key,
      kind: draft.kind,
      hostId: draft.hostId,
      name: draft.name,
      ips: draft.ips,
      zone: zone.zone,
      multiZone: zone.multiZone,
      facts: draft.facts,
      collectedAt,
    });
  }
}

/** A host that could not be collected still belongs in the inventory. */
async function writeUncollected(
  repo: AssetRepository,
  rules: Rules,
  outcome: HostOutcome,
): Promise<void> {
  const existing = await repo.findByKey(hostKey(outcome.hostId));
  const address = normalizeIp(outcome.address);
  const ips = existing?.ips.length ? existing.ips : address ? [address] : [];
  const zone = classifyAsset(ips, rules, existing ? isCloud(existing) : false);
  await repo.upsertAsset({
    key: hostKey(outcome.hostId),
    kind: "host",
    hostId: outcome.hostId,
    name: outcome.name,
    ips,
    zone: zone.zone,
    multiZone: zone.multiZone,
  });
}

async function writeEdges(
  repo: AssetRepository,
  edges: EdgeDraft[],
): Promise<void> {
  const ids = new Map<string, number | null>();
  const idOf = async (key: string) => {
    if (!ids.has(key)) ids.set(key, (await repo.findByKey(key))?.id ?? null);
    return ids.get(key)!;
  };
  for (const edge of edges) {
    const fromAsset = await idOf(edge.from);
    const toAsset = await idOf(edge.to);
    if (!fromAsset || !toAsset) continue;
    await repo.upsertEdge({ ...edge, fromAsset, toAsset });
  }
}

/**
 * Guests and containers a collected host no longer reports are marked
 * removed. Only that host's, by the hostId on each workload, so a run for
 * one host leaves the rest of the inventory alone.
 */
export async function persistOutcomes(
  repo: AssetRepository,
  outcomes: HostOutcome[],
): Promise<void> {
  const rules = compileRules(await repo.listZones());
  const at = new Date().toISOString();
  const collected: CollectedHost[] = outcomes.flatMap((outcome) =>
    outcome.facts ? [{ ...outcome, facts: outcome.facts }] : [],
  );

  await writeDrafts(repo, rules, collected.map(hostDraft), new Map(), at);
  for (const outcome of outcomes.filter((entry) => !entry.facts)) {
    await writeUncollected(repo, rules, outcome);
  }

  const live = await repo.listAssets();
  const workloads = deriveWorkloads(collected, namedHosts(live));
  const runsOn = new Map(
    workloads.edges
      .filter((edge) => edge.type === "runs_on")
      .map((edge) => [edge.from, edge.to]),
  );
  await writeDrafts(repo, rules, workloads.assets, runsOn, at);

  const okHosts = new Set(collected.map((host) => host.hostId));
  const reported = new Set(workloads.assets.map((asset) => asset.key));
  await repo.markRemoved(
    live
      .filter(
        (asset) =>
          (asset.kind === "guest" || asset.kind === "container") &&
          asset.hostId !== null &&
          okHosts.has(asset.hostId) &&
          !reported.has(asset.key),
      )
      .map((asset) => asset.id),
  );

  const index = buildIpIndex(await repo.listAssets());
  const edges = [...workloads.edges];
  for (const host of collected) {
    const derived = deriveConnections(host, index);
    edges.push(...derived.edges);
    const externals = derived.externals.map((ip) => ({
      key: externalKey(ip),
      kind: "external" as const,
      hostId: null,
      name: ip,
      ips: [ip],
      facts: null,
      cloud: false,
    }));
    await writeDrafts(repo, rules, externals, new Map(), undefined);
  }
  await writeEdges(repo, edges);
  await repo.persist();
}

/**
 * Zones again for every live asset, after the rules changed. Pinned zones
 * stay; assets without addresses follow what they run on.
 */
export async function reclassifyAll(repo: AssetRepository): Promise<void> {
  const rules = compileRules(await repo.listZones());
  const live = await repo.listAssets();
  const zoneByKey = new Map<string, string | null>();
  for (const asset of live.filter((entry) => entry.ips.length)) {
    const zone = classifyAsset(asset.ips, rules, isCloud(asset));
    await repo.setRuleZone(asset.id, zone.zone, zone.multiZone);
    zoneByKey.set(
      asset.key,
      asset.zoneSource === "user" ? asset.zone : zone.zone,
    );
  }
  const byId = new Map(live.map((asset) => [asset.id, asset]));
  const runsOn = await repo.listEdges({ type: "runs_on" });
  for (const asset of live.filter((entry) => !entry.ips.length)) {
    const edge = runsOn.find((entry) => entry.fromAsset === asset.id);
    const target = edge ? byId.get(edge.toAsset) : undefined;
    await repo.setRuleZone(
      asset.id,
      target ? (zoneByKey.get(target.key) ?? null) : null,
      false,
    );
  }
  await repo.persist();
}
