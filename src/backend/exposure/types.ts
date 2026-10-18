export const SOURCES = [
  "listen",
  "docker",
  "nft",
  "nginx",
  "ingress",
  "tailscale",
  "iptables",
  "uci",
  "frp",
  "cloudflared",
  "caddy",
  "container_proxy",
] as const;
export type Source = (typeof SOURCES)[number];
export type Coverage = "ok" | "unsupported" | "denied" | "failed" | "truncated";
export interface Endpoint {
  address: string;
  port: number;
  protocol: "tcp" | "udp";
}
export interface Candidate {
  objectKey: string;
  kind: "listener" | "mapping" | "proxy" | "tunnel";
  endpoint: Endpoint;
  backend?: Endpoint;
  hostname?: string;
  path?: string;
  tls: "configured" | "unknown";
  restricted: "configured" | "unknown";
  constraints: string[];
}
export interface Observation {
  source: Source;
  status: Coverage;
  complete: boolean;
  records: Candidate[];
  issues?: Array<{ objectKey: string; reason: string }>;
}
export interface Hop {
  sourceHostId: number;
  source: Source;
  observationId: string;
  observationIds?: string[];
  endpoint: Endpoint;
  backend?: Endpoint;
  constraints: string[];
  hostname?: string;
  path?: string;
}
export interface EvidencePath {
  hops: Hop[];
  status: "partial" | "complete" | "conflicting";
}
export interface Entry extends Candidate {
  key: string;
  sourceHostId: number;
  source: Source;
  observationId: string;
  observationIds?: string[];
  ownerId: string;
  assetId: number | null;
  zone: string | null;
  importance: string | null;
  annotation: string | null;
  requiredHostIds: number[];
  firstSeen: string;
  lastSeen: string;
  staleAt: string | null;
  resolvedAt: string | null;
  fingerprint: string;
  priority: "high" | "medium" | "low";
  prioritySource: "rule" | "user";
  binding: "public" | "local" | "unknown";
  verification: "not_tested";
  pathStatus: "partial" | "complete" | "conflicting" | "branched";
  hops: Hop[];
  /** One rule, many observed interface bindings; absent on legacy rows. */
  bindings?: Endpoint[];
  memberKeys?: string[];
  exposureReasons?: string[];
  priorityReasons?: string[];
  paths?: EvidencePath[];
  pathsTruncated?: boolean;
}
