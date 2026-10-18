import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { redactString } from "../redaction.js";
import { classifyIp } from "../assets/zones.js";
import type { AssetRecord } from "../assets/repository.js";
import {
  SOURCES,
  type Candidate,
  type Endpoint,
  type Entry,
  type Observation,
  type Source,
} from "./types.js";

export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safe = (value: unknown, max = 250): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  !/[\r\n\x00-\x1f]/.test(value) &&
  redactString(value) === value;
function endpoint(value: unknown): Endpoint | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Endpoint;
  if (
    !safe(v.address) ||
    !/^[a-zA-Z0-9._:*%-]+$/.test(v.address) ||
    !Number.isInteger(v.port) ||
    v.port < 1 ||
    v.port > 65535 ||
    !["tcp", "udp"].includes(v.protocol)
  )
    return;
  return { address: v.address, port: v.port, protocol: v.protocol };
}
function candidate(value: unknown): Candidate | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Candidate;
  const ep = endpoint(v.endpoint),
    backend = endpoint(v.backend);
  if (
    !ep ||
    !safe(v.objectKey, 600) ||
    !["listener", "mapping", "proxy", "tunnel"].includes(v.kind) ||
    (v.backend && !backend)
  )
    return null;
  if (
    v.hostname &&
    (!safe(v.hostname) || !/^[a-zA-Z0-9.*_-]+$/.test(v.hostname))
  )
    return null;
  if (v.path && (!safe(v.path) || /[?#@$]/.test(v.path))) return null;
  if (
    !Array.isArray(v.constraints) ||
    v.constraints.length > 30 ||
    v.constraints.some((c) => !safe(c))
  )
    return null;
  return {
    objectKey: v.objectKey,
    kind: v.kind,
    endpoint: ep,
    ...(backend ? { backend } : {}),
    ...(v.hostname ? { hostname: v.hostname } : {}),
    ...(v.path ? { path: v.path } : {}),
    tls: v.tls === "configured" ? "configured" : "unknown",
    restricted: v.restricted === "configured" ? "configured" : "unknown",
    constraints: [...v.constraints],
  };
}
export function decodeObservations(raw: string): Observation[] {
  let values: unknown = null;
  try {
    values = JSON.parse(raw);
  } catch {
    /* interrupted or unsupported collector */
  }
  return SOURCES.map((source) => {
    const matches = Array.isArray(values)
      ? values.filter((v) => v?.source === source)
      : [];
    const v = matches.length === 1 ? matches[0] : null;
    if (
      !v ||
      !Array.isArray(v.records) ||
      !["ok", "unsupported", "denied", "failed", "truncated"].includes(v.status)
    )
      return { source, status: "failed", complete: false, records: [] };
    const parsed = v.records
      .slice(0, 300)
      .map(candidate)
      .filter((r: Candidate | null): r is Candidate => r !== null);
    const grouped = new Map<string, Candidate[]>();
    for (const record of parsed as Candidate[])
      grouped.set(record.objectKey, [
        ...(grouped.get(record.objectKey) ?? []),
        record,
      ]);
    const records = [...grouped.values()].flatMap((group) =>
      group.every((r) => fingerprint(r) === fingerprint(group[0]))
        ? [group[0]]
        : [],
    );
    const complete =
      v.status === "ok" &&
      v.complete === true &&
      parsed.length === v.records.length &&
      records.length === parsed.length;
    return {
      source,
      status: v.records.length > 300 ? "truncated" : v.status,
      complete,
      records,
      issues: Array.isArray(v.issues)
        ? v.issues
            .slice(0, 300)
            .filter(
              (i: { objectKey: unknown; reason: unknown }) =>
                safe(i?.objectKey, 600) && safe(i?.reason),
            )
            .map((i: { objectKey: string; reason: string }) => ({
              objectKey: i.objectKey,
              reason: i.reason,
            }))
        : [],
    };
  });
}
export function publicAddress(ip: string): boolean {
  return !!isIP(ip) && classifyIp(ip, [])?.kind === "external";
}
export function rulePriority(
  entry: Pick<Entry, "endpoint" | "importance">,
): Entry["priority"] {
  return publicAddress(entry.endpoint.address) &&
    ([22, 3389, 3306, 5432, 6379, 27017, 6443].includes(entry.endpoint.port) ||
      entry.importance === "critical")
    ? "high"
    : "medium";
}
function bindings(ep: Endpoint, asset: AssetRecord): Endpoint[] {
  if (!["0.0.0.0", "::"].includes(ep.address)) return [ep];
  const ips =
    (
      asset.facts?.interfaces as Array<{ addrs: string[] }> | undefined
    )?.flatMap((i) => i.addrs.map((a) => a.split("/")[0])) ?? [];
  const family = ep.address === "::" ? 6 : 4;
  const addresses = [...new Set(ips.filter((ip) => isIP(ip) === family))];
  return addresses.length
    ? addresses.map((address) => ({ ...ep, address }))
    : [ep];
}
export function deriveEntries(
  observation: Observation,
  context: {
    host: AssetRecord;
    assets: AssetRecord[];
    ownerId: string;
    observationId: string;
    at: string;
  },
): Entry[] {
  const { host, assets, ownerId, observationId, at } = context;
  const rows: Entry[] = [];
  for (const record of observation.records) {
    for (const ep of bindings(record.endpoint, host)) {
      // Keep private backends as path evidence, but never label them publicly reachable.
      const backendHosts = assets.filter(
        (a) =>
          a.kind === "host" &&
          (a.ips.includes(ep.address) ||
            (record.backend && a.ips.includes(record.backend.address))),
      );
      const ids = [
        ...new Set([
          host.hostId!,
          ...backendHosts.flatMap((a) => (a.hostId ? [a.hostId] : [])),
        ]),
      ];
      const key = fingerprint([
        ownerId,
        host.hostId,
        observation.source,
        record.objectKey,
        ep,
      ]);
      const priority = rulePriority({
        endpoint: ep,
        importance: host.importance,
      });
      const normalized = { ...record, endpoint: ep };
      rows.push({
        ...normalized,
        key,
        sourceHostId: host.hostId!,
        source: observation.source,
        observationId,
        ownerId,
        assetId: host.id,
        zone: host.zone,
        importance: host.importance,
        annotation: null,
        requiredHostIds: ids,
        firstSeen: at,
        lastSeen: at,
        staleAt: observation.status === "ok" ? null : at,
        resolvedAt: null,
        fingerprint: fingerprint(normalized),
        priority,
        prioritySource: "rule",
        binding: publicAddress(ep.address)
          ? "public"
          : isIP(ep.address) && !["0.0.0.0", "::"].includes(ep.address)
            ? "local"
            : "unknown",
        verification: "not_tested",
        pathStatus: "partial",
        hops: [
          {
            sourceHostId: host.hostId!,
            source: observation.source,
            observationId,
            endpoint: ep,
            ...(record.backend ? { backend: record.backend } : {}),
            constraints: [...record.constraints],
          },
        ],
      });
    }
  }
  return rows;
}
export function bindCurrentHosts(
  entries: Entry[],
  assets: AssetRecord[],
): Entry[] {
  return entries.map((entry) => {
    const addresses = new Set(
      [entry.endpoint.address, entry.backend?.address].filter(
        (ip): ip is string =>
          !!ip &&
          !!isIP(ip) &&
          ip !== "::1" &&
          !ip.startsWith("127.") &&
          ip !== "0.0.0.0" &&
          ip !== "::",
      ),
    );
    const targets = assets.filter(
      (asset) =>
        asset.kind === "host" &&
        asset.hostId &&
        asset.ips.some((ip) => addresses.has(ip)),
    );
    return {
      ...entry,
      requiredHostIds: [
        ...new Set([
          ...entry.requiredHostIds,
          ...targets.map((asset) => asset.hostId!),
        ]),
      ],
    };
  });
}
export function ageEntries(entries: Entry[], at = Date.now()): Entry[] {
  return entries.map((entry) => {
    const expired = Date.parse(entry.lastSeen) + 48 * 3600000;
    return !entry.resolvedAt && !entry.staleAt && at >= expired
      ? { ...entry, staleAt: new Date(expired).toISOString() }
      : entry;
  });
}
export function linkPaths(entries: Entry[]): Entry[] {
  const live = entries.filter((e) => !e.resolvedAt && !e.staleAt);
  const index = new Map<string, Entry[]>();
  const local = (address: string) =>
    address === "::1" || address.startsWith("127.");
  const endpointKey = (owner: string, ep: Endpoint, hostId: number) =>
    JSON.stringify([owner, local(ep.address) ? hostId : null, ep]);
  for (const e of live) {
    if (e.hostname || e.path) continue;
    const key = endpointKey(e.ownerId, e.endpoint, e.sourceHostId);
    index.set(key, [...(index.get(key) ?? []), e]);
  }
  return entries.map((entry) => {
    const result = {
      ...entry,
      hops: entry.hops.slice(0, 1),
      requiredHostIds: [entry.sourceHostId, ...entry.requiredHostIds],
      pathStatus: "partial" as Entry["pathStatus"],
    };
    if (entry.staleAt || entry.resolvedAt) return result;
    const seen = new Set([entry.key]);
    let current = entry;
    while (current.backend && result.hops.length < 8) {
      if (
        current.constraints.includes("container-backend-namespace-unresolved")
      )
        break;
      const target = current.backend;
      if (!isIP(target.address)) break;
      // Names, load balancing, and local-loopback targets remain unresolved unless explicit.
      const candidates =
        index.get(endpointKey(entry.ownerId, target, current.sourceHostId)) ??
        [];
      if (candidates.length !== 1) {
        if (candidates.length > 1) result.pathStatus = "conflicting";
        break;
      }
      const next = candidates[0];
      if (seen.has(next.key)) {
        result.pathStatus = "conflicting";
        break;
      }
      seen.add(next.key);
      result.hops.push(next.hops[0]);
      result.requiredHostIds.push(...next.requiredHostIds);
      current = next;
      if (!current.backend && current.kind === "listener")
        result.pathStatus = "complete";
    }
    result.requiredHostIds = [...new Set(result.requiredHostIds)];
    return result;
  });
}
export function sourceFailure(source: Source): Observation {
  return { source, status: "failed", complete: false, records: [] };
}
