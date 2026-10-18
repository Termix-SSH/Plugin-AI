import { randomUUID } from "node:crypto";
import type { AssetRecord } from "../../../src/backend/assets/repository.js";
import type {
  Candidate,
  Entry,
  Observation,
} from "../../../src/backend/exposure/types.js";
import { deriveEntries } from "../../../src/backend/exposure/derive.js";
export const host = (hostId = 1, ip = "8.8.8.8"): AssetRecord => ({
  id: hostId,
  hostId,
  key: `host:${hostId}`,
  kind: "host",
  name: `host-${hostId}`,
  ips: [ip],
  zone: "external",
  zoneSource: "rule",
  multiZone: false,
  facts: {
    interfaces: [
      { name: "eth0", addrs: [`${ip}/${ip.includes(":") ? 64 : 24}`] },
    ],
  },
  collectedAt: null,
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
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
export const listener = (port = 22): Candidate => ({
  objectKey: `tcp:0.0.0.0:${port}`,
  kind: "listener",
  endpoint: { address: "0.0.0.0", port, protocol: "tcp" },
  tls: "unknown",
  restricted: "unknown",
  constraints: [],
});
export function observation(
  records = [listener()],
  complete = true,
  at = "2026-01-01T00:00:00.000Z",
) {
  return {
    id: randomUUID(),
    hostId: 1,
    ownerId: "user-1",
    source: "listen" as const,
    status: complete ? ("ok" as const) : ("failed" as const),
    complete,
    at,
    records,
  };
}
export function derived(
  o: ReturnType<typeof observation>,
  assets = [host()],
): Entry[] {
  return deriveEntries(o, {
    host: assets[0],
    assets,
    ownerId: o.ownerId,
    observationId: o.id,
    at: o.at,
  });
}
