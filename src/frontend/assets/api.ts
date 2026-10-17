import { aiApp } from "../app-ref";

/** Asset inventory routes, under /plugin-api/ai/assets. */

export type AssetKind = "host" | "guest" | "container" | "external";
export type ZoneKind = "internal" | "dmz" | "external" | "cloud" | "overlay";

export interface AssetItem {
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
  trigger: "schedule" | "manual" | "host_event";
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "done" | "failed";
  hostsTotal: number;
  hostsOk: number;
  hostsFailed: number;
  errorSummary: Record<string, string> | null;
}

export interface AssetSettings {
  dailyEnabled: boolean;
  dailyTime: string;
  collectorSet: boolean;
  collectorIsMe: boolean;
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
  changes: Partial<Pick<AssetSettings, "dailyEnabled" | "dailyTime">> & {
    collector?: "me";
  },
): Promise<AssetSettings> {
  return (await api().put("assets/settings", changes)).data.settings;
}
