import { aiApp } from "../app-ref";

/** Asset inventory routes, under /plugin-api/ai/assets. */

export type AssetKind = "host" | "guest" | "container" | "external";
export type ZoneKind = "internal" | "dmz" | "external" | "cloud" | "overlay";
export type Importance = "critical" | "high" | "medium" | "low";
export type AnnotationField = "role" | "importance" | "system";
export type FieldSource = "ai" | "user" | null;

/** An asset's annotation, each field with where it came from. */
export interface Annotation {
  role: string | null;
  roleSource: FieldSource;
  importance: Importance | null;
  importanceSource: FieldSource;
  importanceReason: string | null;
  system: string | null;
  systemSource: FieldSource;
  annotatedAt: string | null;
}

export interface AssetItem extends Annotation {
  id: number;
  key: string;
  kind: AssetKind;
  hostId: number | null;
  name: string;
  ips: string[];
  zone: string | null;
  zoneSource: "rule" | "user" | "ai" | null;
  multiZone: boolean;
  collectedAt: string | null;
  removedAt: string | null;
  os: string | null;
  counts: {
    listening: number;
    outbound: number;
    services: number;
    containers: number;
  };
}

export interface AssetEdge {
  id: number;
  fromAsset: number;
  toAsset: number;
  type: string;
  detail: Record<string, unknown> | null;
  evidence: string | null;
  source: string;
  firstSeen: string;
  lastSeen: string;
  peer: { id: number; key: string; kind: AssetKind; name: string } | null;
}

export interface AssetDetail {
  asset: Omit<AssetItem, "os" | "counts"> & {
    facts: Record<string, unknown> | null;
  };
  outgoing: AssetEdge[];
  incoming: AssetEdge[];
}

export interface ZoneRule {
  id: number;
  name: string;
  kind: ZoneKind;
  cidr: string;
  priority: number;
}

export interface CollectionRun {
  id: number;
  kind: "collect" | "annotate";
  trigger: "schedule" | "manual" | "host_event" | "collection";
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "done" | "failed";
  hostsTotal: number;
  hostsOk: number;
  hostsFailed: number;
  errorSummary: Record<string, string> | null;
  tokens: number;
}

/** An annotation run counts assets in the hosts fields. */
export type AnnotationRun = CollectionRun;

export interface AssetSettings {
  dailyEnabled: boolean;
  dailyTime: string;
  collectorSet: boolean;
  collectorIsMe: boolean;
  annotateAfterCollect: boolean;
  annotateProviderId: number | null;
  annotateModel: string | null;
  annotateProviders: Array<{
    id: number;
    label: string;
    defaultModel: string | null;
  }>;
}

export type EdgeType = "runs_on" | "depends_on" | "connects_to";

export interface GraphNode {
  id: number;
  key: string;
  kind: AssetKind;
  name: string;
  zone: string | null;
  multiZone: boolean;
  role: string | null;
  importance: Importance | null;
  system: string | null;
  containers: number;
}

export interface GraphEdge {
  key: string;
  from: number;
  to: number;
  type: EdgeType;
  source: string;
  stale: boolean;
}

export interface GraphOptions {
  types: EdgeType[];
  containers: boolean;
  external: boolean;
}

export interface ImpactItem {
  asset: Pick<GraphNode, "id" | "key" | "kind" | "name" | "zone" | "role"> & {
    importance: Importance | null;
  };
  depth: number;
  path: Array<{ from: number; to: number; type: EdgeType; source: string }>;
}

export type ImportanceCounts = Record<Importance | "unknown", number>;

export interface Impact {
  asset: { id: number; key: string; name: string };
  direct: ImpactItem[];
  transitive: ImpactItem[];
  weak: ImpactItem[];
  counts: { strong: ImportanceCounts; weak: ImportanceCounts };
  truncated: boolean;
}

export interface AssetFilters {
  q?: string;
  zone?: string;
  kind?: string;
  includeRemoved?: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface LooseClient {
  get(url: string): Promise<{ data: any }>;
  delete(url: string): Promise<{ data: any }>;
  post(url: string, body?: unknown): Promise<{ data: any }>;
  put(url: string, body?: unknown): Promise<{ data: any }>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const api = () => aiApp().api as unknown as LooseClient;

export async function listAssets(filters: AssetFilters): Promise<AssetItem[]> {
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (filters.zone) query.set("zone", filters.zone);
  if (filters.kind) query.set("kind", filters.kind);
  if (filters.includeRemoved) query.set("includeRemoved", "1");
  const suffix = query.toString() ? `?${query}` : "";
  return (await api().get(`assets${suffix}`)).data.assets;
}

export async function getAsset(id: number): Promise<AssetDetail> {
  return (await api().get(`assets/${id}`)).data;
}

export async function pinZone(id: number, zone: string | null): Promise<void> {
  await api().put(`assets/${id}/zone`, { zone });
}

export async function listZones(): Promise<{
  zones: ZoneRule[];
  builtin: ZoneKind[];
}> {
  return (await api().get("assets/zones")).data;
}

export async function saveZone(
  zone: Omit<ZoneRule, "id"> & { id?: number },
): Promise<void> {
  const { id, ...body } = zone;
  if (id) await api().put(`assets/zones/${id}`, body);
  else await api().post("assets/zones", body);
}

export async function deleteZone(id: number): Promise<void> {
  await api().delete(`assets/zones/${id}`);
}

export async function collectNow(): Promise<"started" | "queued"> {
  return (await api().post("assets/collect")).data.status;
}

export async function listRuns(): Promise<{
  runs: CollectionRun[];
  running: boolean;
}> {
  return (await api().get("assets/runs")).data;
}

export async function getSettings(): Promise<AssetSettings> {
  return (await api().get("assets/settings")).data.settings;
}

export async function saveSettings(
  changes: Partial<
    Pick<
      AssetSettings,
      | "dailyEnabled"
      | "dailyTime"
      | "annotateAfterCollect"
      | "annotateProviderId"
      | "annotateModel"
    >
  > & {
    collector?: "me";
  },
): Promise<AssetSettings> {
  return (await api().put("assets/settings", changes)).data.settings;
}

export async function getGraph(
  options: GraphOptions,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const query = new URLSearchParams({ types: options.types.join(",") });
  if (options.containers) query.set("containers", "1");
  if (options.external) query.set("external", "1");
  return (await api().get(`assets/graph?${query}`)).data;
}

export async function getImpact(id: number): Promise<Impact> {
  return (await api().get(`assets/${id}/impact`)).data;
}

/** Sets fields as the user's own, locked against annotation runs. */
export async function saveAnnotation(
  id: number,
  changes: Partial<
    Pick<Annotation, "role" | "importance" | "importanceReason" | "system">
  >,
): Promise<void> {
  await api().put(`assets/${id}/annotation`, changes);
}

export async function unlockAnnotation(
  id: number,
  field: AnnotationField,
): Promise<void> {
  await api().delete(`assets/${id}/annotation/${field}`);
}

export async function annotateNow(all: boolean): Promise<"started" | "queued"> {
  return (await api().post("assets/annotate", { all })).data.status;
}

export async function listAnnotationRuns(): Promise<{
  runs: AnnotationRun[];
  running: boolean;
}> {
  return (await api().get("assets/annotation-runs")).data;
}
