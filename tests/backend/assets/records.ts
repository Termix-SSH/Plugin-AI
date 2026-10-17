import type {
  AssetRecord,
  EdgeRecord,
} from "../../../src/backend/assets/repository";

/** Inventory rows built by hand, for the pure annotation and graph code. */

let nextId = 1000;

export function assetRecord(
  key: string,
  overrides: Partial<AssetRecord> = {},
): AssetRecord {
  const kind = key.split(":")[0] as AssetRecord["kind"];
  return {
    id: nextId++,
    key,
    kind,
    hostId: null,
    name: key.split(/[:/]/).pop()!,
    ips: [],
    zone: "internal",
    zoneSource: "rule",
    multiZone: false,
    facts: null,
    collectedAt: "2026-10-17T03:00:00.000Z",
    removedAt: null,
    role: null,
    roleSource: null,
    importance: null,
    importanceSource: null,
    importanceReason: null,
    system: null,
    systemSource: null,
    annotatedAt: null,
    annotationFingerprint: null,
    createdAt: "2026-10-17T03:00:00.000Z",
    updatedAt: "2026-10-17T03:00:00.000Z",
    ...overrides,
  };
}

let nextEdge = 1;

export function edgeRecord(
  from: AssetRecord,
  to: AssetRecord,
  type: EdgeRecord["type"],
  overrides: Partial<EdgeRecord> = {},
): EdgeRecord {
  return {
    id: nextEdge++,
    fromAsset: from.id,
    toAsset: to.id,
    type,
    detail: null,
    evidence: null,
    source: type === "depends_on" ? "ai" : "collector",
    firstSeen: "2026-10-17T03:00:01.000Z",
    lastSeen: "2026-10-17T03:00:01.000Z",
    ...overrides,
  };
}
