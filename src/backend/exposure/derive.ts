import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { redactString } from "../redaction.js";
import { isIgnoredIp, parseIp } from "../assets/net.js";
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
const sensitivePorts = new Set([
  22, 53, 445, 2375, 2379, 3306, 3389, 5432, 5900, 6379, 6443, 9200, 11211,
  27017,
]);
export function exposureReasons(
  entry: Pick<
    Entry,
    "endpoint" | "source" | "kind" | "constraints" | "bindings"
  >,
): string[] {
  const reasons: string[] = [];
  if (
    (entry.bindings ?? [entry.endpoint]).some((ep) => publicAddress(ep.address))
  )
    reasons.push("public-address");
  if (
    entry.source === "uci" &&
    entry.kind === "mapping" &&
    entry.constraints.includes("source-zone:wan")
  )
    reasons.push("wan-zone");
  if (
    entry.kind === "tunnel" &&
    ["cloudflared", "tailscale"].includes(entry.source)
  )
    reasons.push("configured-public-tunnel");
  return reasons;
}
export function internetRelevant(entry: Entry): boolean {
  return exposureReasons(entry).length > 0;
}
export function reviewPriority(
  entry: Pick<Entry, "endpoint" | "importance"> & Partial<Entry>,
): { priority: Entry["priority"]; reasons: string[] } {
  const reasons = exposureReasons({
    ...entry,
    source: entry.source ?? "listen",
    kind: entry.kind ?? "listener",
    constraints: entry.constraints ?? [],
  });
  if (reasons.length) {
    const ports = new Set([
      entry.endpoint.port,
      entry.backend?.port,
      ...(entry.paths ?? []).flatMap((p) =>
        p.hops.flatMap((h) => [h.endpoint.port, h.backend?.port]),
      ),
    ]);
    const sensitive = [...ports]
      .filter((p): p is number => p !== undefined && sensitivePorts.has(p))
      .sort((a, b) => a - b);
    const high = sensitive.length > 0 || entry.importance === "critical";
    return {
      priority: high ? "high" : "medium",
      reasons: [
        ...reasons,
        ...sensitive.map((p) => `sensitive-service:${p}`),
        ...(entry.importance === "critical" ? ["critical-asset"] : []),
      ],
    };
  }
  const known = (entry.bindings ?? [entry.endpoint]).some(
    (ep) => isIP(ep.address) && !["0.0.0.0", "::"].includes(ep.address),
  );
  return {
    priority: known ? "low" : "medium",
    reasons: [known ? "internal-only" : "exposure-unknown"],
  };
}
export function rulePriority(
  entry: Pick<Entry, "endpoint" | "importance"> & Partial<Entry>,
): Entry["priority"] {
  return reviewPriority(entry).priority;
}
export const entryIdentity = (
  entry: Pick<Entry, "ownerId" | "sourceHostId" | "source" | "objectKey">,
) =>
  fingerprint([
    "exposure-rule-v2",
    entry.ownerId,
    entry.sourceHostId,
    entry.source,
    entry.objectKey,
  ]);
const sortedBindings = (values: Endpoint[]) =>
  [...new Map(values.map((ep) => [JSON.stringify(ep), ep])).values()].sort(
    (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
export function evidenceFingerprint(entry: Entry): string {
  return fingerprint({
    kind: entry.kind,
    endpoint: { port: entry.endpoint.port, protocol: entry.endpoint.protocol },
    bindings: sortedBindings(entry.bindings ?? [entry.endpoint]),
    backend: entry.backend,
    hostname: entry.hostname,
    path: entry.path,
    tls: entry.tls,
    restricted: entry.restricted,
    constraints: entry.constraints,
  });
}
function firstHop(entry: Entry) {
  return {
    sourceHostId: entry.sourceHostId,
    source: entry.source,
    observationId: entry.observationId,
    observationIds: entry.observationIds,
    endpoint: entry.endpoint,
    ...(entry.backend ? { backend: entry.backend } : {}),
    ...(entry.hostname ? { hostname: entry.hostname } : {}),
    ...(entry.path ? { path: entry.path } : {}),
    constraints: [...entry.constraints],
  };
}
/** Normalize old interface-expanded rows without rewriting observations or losing overrides. */
export function compactEntries(entries: Entry[]): Entry[] {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = entryIdentity(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const active = group.filter((e) => !e.resolvedAt),
      current = active.length ? active : group;
    const latest = [...current].sort(
      (a, b) =>
        b.lastSeen.localeCompare(a.lastSeen) || a.key.localeCompare(b.key),
    )[0];
    const addresses = sortedBindings(
      current.flatMap((e) => e.bindings ?? [e.endpoint]),
    );
    const overrides = group
      .filter((e) => e.prioritySource === "user")
      .sort(
        (a, b) =>
          ({ high: 0, medium: 1, low: 2 })[a.priority] -
          { high: 0, medium: 1, low: 2 }[b.priority],
      );
    const endpoint =
      latest.bindings || addresses.length < 2
        ? latest.endpoint
        : {
            ...latest.endpoint,
            address: addresses.every((e) => isIP(e.address) === 4)
              ? "0.0.0.0"
              : addresses.every((e) => isIP(e.address) === 6)
                ? "::"
                : latest.endpoint.address,
          };
    const entry: Entry = {
      ...latest,
      key,
      endpoint,
      bindings: addresses,
      observationIds: [
        ...new Set(
          current.flatMap((e) => e.observationIds ?? [e.observationId]),
        ),
      ],
      memberKeys: [
        ...new Set(group.flatMap((e) => [e.key, ...(e.memberKeys ?? [])])),
      ],
      firstSeen: group.map((e) => e.firstSeen).sort()[0],
      staleAt: current.find((e) => e.staleAt)?.staleAt ?? null,
      requiredHostIds: [...new Set(current.flatMap((e) => e.requiredHostIds))],
      paths: undefined,
      pathsTruncated: undefined,
      priority: overrides[0]?.priority ?? latest.priority,
      prioritySource: overrides.length ? "user" : "rule",
    };
    entry.exposureReasons = exposureReasons(entry);
    entry.binding = entry.exposureReasons.length
      ? "public"
      : addresses.some(
            (e) => isIP(e.address) && !["0.0.0.0", "::"].includes(e.address),
          )
        ? "local"
        : "unknown";
    const review = reviewPriority(entry);
    if (entry.prioritySource === "rule") entry.priority = review.priority;
    entry.priorityReasons =
      entry.prioritySource === "user" ? ["manual"] : review.reasons;
    entry.hops = [firstHop(entry)];
    entry.pathStatus = "partial";
    entry.fingerprint = evidenceFingerprint(entry);
    return entry;
  });
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
    const ep = record.endpoint;
    const observedBindings = bindings(ep, host);
    // Keep private backends as path evidence, but never label them publicly reachable.
    const backendHosts = assets.filter(
      (a) =>
        a.kind === "host" &&
        (observedBindings.some((binding) => a.ips.includes(binding.address)) ||
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
      bindings: observedBindings,
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
  return compactEntries(rows);
}
export function bindCurrentHosts(
  entries: Entry[],
  assets: AssetRecord[],
): Entry[] {
  return entries.map((entry) => {
    const addresses = new Set(
      [
        ...(entry.bindings ?? [entry.endpoint]).map((ep) => ep.address),
        entry.backend?.address,
      ].filter(
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
  const endpointKey = (owner: string, ep: Endpoint, hostId: number) => {
    const parsed = parseIp(ep.address);
    return JSON.stringify([
      owner,
      isIgnoredIp(ep.address) ? hostId : null,
      parsed ? `${parsed.version}:${parsed.value}` : ep.address,
      ep.port,
      ep.protocol,
    ]);
  };
  const index = new Map<string, Entry[]>();
  for (const entry of live)
    for (const ep of entry.bindings ?? [entry.endpoint]) {
      if (!isIP(ep.address) || ["0.0.0.0", "::"].includes(ep.address)) continue;
      const key = endpointKey(entry.ownerId, ep, entry.sourceHostId);
      index.set(key, [...(index.get(key) ?? []), entry]);
    }
  return entries.map((entry) => {
    const paths: NonNullable<Entry["paths"]> = [],
      required = new Set(entry.requiredHostIds);
    let truncated = false;
    const add = (
      hops: Entry["hops"],
      status: "partial" | "complete" | "conflicting",
    ) => {
      if (paths.length >= 128) {
        truncated = true;
        return;
      }
      paths.push({ hops, status });
    };
    const walk = (
      current: Entry,
      hops: Entry["hops"],
      seen: Set<string>,
      branched = false,
    ) => {
      if (paths.length >= 128) {
        truncated = true;
        return;
      }
      if (!current.backend) {
        add(hops, current.kind === "listener" ? "complete" : "partial");
        return;
      }
      if (
        hops.length >= 8 ||
        current.constraints.includes(
          "container-backend-namespace-unresolved",
        ) ||
        !isIP(current.backend.address)
      ) {
        add(hops, "partial");
        return;
      }
      const candidates = [
        ...new Map(
          (
            index.get(
              endpointKey(entry.ownerId, current.backend, current.sourceHostId),
            ) ?? []
          ).map((e) => [e.key, e]),
        ).values(),
      ];
      for (const e of candidates)
        for (const id of e.requiredHostIds) required.add(id);
      if (!candidates.length) {
        add(hops, "partial");
        return;
      }
      if (new Set(candidates.map((e) => e.sourceHostId)).size > 1) {
        add(hops, "conflicting");
        return;
      }
      // A proxy route explains forwarding; a socket at the same endpoint is supporting evidence, not another branch.
      const forwarding = candidates.filter((e) => e.backend);
      const next = forwarding.length ? forwarding : candidates;
      const distinctRoutes = new Set(
        next.map((e) => JSON.stringify([e.hostname ?? "", e.path ?? ""])),
      );
      const proxyBranches = next.every(
        (e) => e.kind === "proxy" && e.source === next[0].source,
      );
      if (
        next.length > 1 &&
        distinctRoutes.size !== next.length &&
        !proxyBranches
      ) {
        add(hops, "conflicting");
        return;
      }
      if (next.length > 1 && branched) {
        const tail = hops[hops.length - 1];
        add(
          [
            ...hops.slice(0, -1),
            {
              ...tail,
              constraints: [
                ...tail.constraints,
                "downstream-route-selection-unverified",
              ],
            },
          ],
          "partial",
        );
        return;
      }
      for (const e of next.sort((a, b) => a.key.localeCompare(b.key))) {
        if (seen.has(e.key)) {
          add(hops, "conflicting");
          continue;
        }
        walk(
          e,
          [...hops, { ...firstHop(e), endpoint: current.backend }],
          new Set([...seen, e.key]),
          branched || next.length > 1,
        );
      }
    };
    if (entry.staleAt || entry.resolvedAt) add([firstHop(entry)], "partial");
    else walk(entry, [firstHop(entry)], new Set([entry.key]));
    const result: Entry = {
      ...entry,
      paths,
      pathsTruncated: truncated,
      hops: paths.length === 1 ? paths[0].hops : [firstHop(entry)],
      requiredHostIds: [...required],
      pathStatus: truncated
        ? "partial"
        : paths.length > 1
          ? "branched"
          : (paths[0]?.status ?? "partial"),
    };
    const review = reviewPriority(result);
    if (result.prioritySource === "rule") {
      result.priority = review.priority;
      result.priorityReasons = review.reasons;
    }
    return result;
  });
}
export function sourceFailure(source: Source): Observation {
  return { source, status: "failed", complete: false, records: [] };
}
