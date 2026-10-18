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
  endpoint: Endpoint;
  backend?: Endpoint;
  constraints: string[];
}
export interface Entry extends Candidate {
  key: string;
  sourceHostId: number;
  source: Source;
  observationId: string;
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
  pathStatus: "partial" | "complete" | "conflicting";
  hops: Hop[];
}
