import { isIgnoredIp, normalizeIp, parseCidr, type Cidr } from "./net.js";
import type { SectionName } from "./script.js";

/**
 * Pure parsers, one per section of the collection script. Each takes the
 * section's text and returns plain data, or an empty result for output it
 * does not recognise: a missing tool is normal, not an error. Nothing here
 * keeps a command line, an environment or a label: processes are reduced to
 * their executable name, containers to name, image, state and ports.
 */

/** Lists are capped so one busy host cannot grow a row without bound. */
export const LIST_CAP = 300;

export interface OsFacts {
  id?: string;
  name?: string;
  version?: string;
  pretty?: string;
}

export interface InterfaceFacts {
  name: string;
  /** "10.0.0.5/24" */
  addrs: string[];
}

export interface RouteFacts {
  dst: string;
  gateway?: string;
  dev?: string;
}

export interface ListenFacts {
  proto: "tcp" | "udp";
  address: string;
  port: number;
  process: string | null;
}

/** One established TCP connection, before aggregation. */
export interface SocketRow {
  localIp: string;
  localPort: number;
  peerIp: string;
  peerPort: number;
  process: string | null;
}

/** Connections grouped by direction, peer and service port. */
export interface ConnectionFacts {
  direction: "out" | "in";
  peer: string;
  /** The service port: the peer's when outbound, ours when inbound. */
  port: number;
  processes: string[];
  count: number;
}

export interface ServiceFacts {
  name: string;
  description: string;
}

export interface ContainerFacts {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  networks: string[];
}

export interface GuestFacts {
  vmid: number;
  node: string;
  name: string;
  type: "qemu" | "lxc";
  status: string;
}

export interface CloudFacts {
  provider: string;
  instanceId?: string;
  region?: string;
}

export interface HostFacts {
  os?: OsFacts;
  hostname?: string;
  uptimeSec?: number;
  interfaces?: InterfaceFacts[];
  routes?: RouteFacts[];
  listening?: ListenFacts[];
  connections?: ConnectionFacts[];
  services?: ServiceFacts[];
  containers?: ContainerFacts[];
  /** Kubernetes agents found active: k3s, k3s-agent, kubelet. */
  kubernetes?: string[];
  guests?: GuestFacts[];
  cloud?: CloudFacts;
  /** Sections the host printed nothing for. */
  missing?: SectionName[];
}

const text = (value: unknown, max = 200): string =>
  typeof value === "string" ? value.slice(0, max) : "";

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseOsRelease(raw: string): OsFacts {
  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  const os: OsFacts = {
    id: values.ID,
    name: values.NAME,
    version: values.VERSION_ID,
    pretty: values.PRETTY_NAME,
  };
  for (const key of Object.keys(os) as Array<keyof OsFacts>) {
    if (!os[key]) delete os[key];
    else os[key] = os[key]!.slice(0, 120);
  }
  return os;
}

export function parseHostname(raw: string): string | undefined {
  const name = raw.split("\n")[0]?.trim();
  return name ? name.slice(0, 253) : undefined;
}

export function parseUptime(raw: string): number | undefined {
  const token = raw.trim().split(/\s+/)[0];
  const seconds = token ? Number(token) : NaN;
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.floor(seconds)
    : undefined;
}

export function parseIpAddr(raw: string): InterfaceFacts[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 200).flatMap((entry) => {
    const name = text(entry?.ifname, 64);
    if (!name) return [];
    const info: unknown[] = Array.isArray(entry.addr_info)
      ? entry.addr_info
      : [];
    const addrs = info.flatMap((address) => {
      const record = address as { local?: unknown; prefixlen?: unknown };
      const ip = normalizeIp(text(record.local, 64));
      return ip ? [`${ip}/${Number(record.prefixlen) || 0}`] : [];
    });
    return [{ name, addrs }];
  });
}

export function parseIpRoute(raw: string): RouteFacts[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, LIST_CAP).flatMap((entry) => {
    const dst = text(entry?.dst, 64);
    if (!dst) return [];
    const route: RouteFacts = { dst };
    if (entry.gateway) route.gateway = text(entry.gateway, 64);
    if (entry.dev) route.dev = text(entry.dev, 64);
    return [route];
  });
}

/** "10.0.0.1:22", "[::1]:22", "*:80", "10.0.0.1%lo:53" */
function splitEndpoint(raw: string): { ip: string; port: number } | null {
  const colon = raw.lastIndexOf(":");
  if (colon < 0) return null;
  const port = Number(raw.slice(colon + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  const host = raw.slice(0, colon);
  const ip =
    host === "*" ? "0.0.0.0" : normalizeIp(host.replace(/%[^\]]*$/, ""));
  return ip ? { ip, port } : null;
}

/**
 * The executable names in ss's users:(("nginx",pid=1,fd=6),...) field. A
 * name is the kernel's 15-character comm, which a process may overwrite with
 * its own title ("npm exec tsx /t"), so only its first word is kept.
 */
function processNames(line: string): string[] {
  const names = [...line.matchAll(/\("([^"]{1,64})",pid=/g)].map(
    (match) => match[1].split(" ")[0],
  );
  return [...new Set(names)];
}

/** `ss -H -tulnp`: Netid State Recv-Q Send-Q Local Peer [Process] */
export function parseListening(raw: string): ListenFacts[] {
  const seen = new Set<string>();
  const rows: ListenFacts[] = [];
  for (const line of raw.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const proto = fields[0];
    if (proto !== "tcp" && proto !== "udp") continue;
    const local = splitEndpoint(fields[4] ?? "");
    if (!local) continue;
    const key = `${proto}/${local.ip}/${local.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      proto,
      address: local.ip,
      port: local.port,
      process: processNames(line)[0] ?? null,
    });
    if (rows.length >= LIST_CAP) break;
  }
  return rows;
}

/** `ss -H -tnp state established`: Recv-Q Send-Q Local Peer [Process] */
export function parseEstablished(raw: string): SocketRow[] {
  const rows: SocketRow[] = [];
  for (const line of raw.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // Some ss builds still print the state column.
    const offset = /^\d+$/.test(fields[0] ?? "") ? 0 : 1;
    const local = splitEndpoint(fields[offset + 2] ?? "");
    const peer = splitEndpoint(fields[offset + 3] ?? "");
    if (!local || !peer) continue;
    rows.push({
      localIp: local.ip,
      localPort: local.port,
      peerIp: peer.ip,
      peerPort: peer.port,
      process: processNames(line)[0] ?? null,
    });
  }
  return rows;
}

/**
 * Established connections grouped by peer and service port. A connection is
 * inbound when its local port is one this host listens on; everything else
 * is outbound to the peer's port. Loopback and link-local peers are dropped.
 */
export function aggregateConnections(
  rows: SocketRow[],
  listening: ListenFacts[],
): ConnectionFacts[] {
  const listeningPorts = new Set(
    listening.filter((row) => row.proto === "tcp").map((row) => row.port),
  );
  const groups = new Map<string, ConnectionFacts>();
  for (const row of rows) {
    if (isIgnoredIp(row.peerIp)) continue;
    const inbound = listeningPorts.has(row.localPort);
    const direction = inbound ? "in" : "out";
    const port = inbound ? row.localPort : row.peerPort;
    const key = `${direction}/${row.peerIp}/${port}`;
    const group = groups.get(key) ?? {
      direction,
      peer: row.peerIp,
      port,
      processes: [],
      count: 0,
    };
    group.count += 1;
    if (row.process && !group.processes.includes(row.process)) {
      group.processes.push(row.process);
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, LIST_CAP);
}

/** `systemctl list-units ... --no-legend --plain`: unit load active sub desc */
export function parseServices(raw: string): ServiceFacts[] {
  const rows: ServiceFacts[] = [];
  for (const line of raw.split("\n")) {
    const match = /^(\S+\.service)\s+\S+\s+\S+\s+\S+\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    rows.push({
      name: match[1].slice(0, 120),
      description: match[2].slice(0, 120),
    });
    if (rows.length >= LIST_CAP) break;
  }
  return rows;
}

/** `docker ps --format '{{json .}}'`, one object per line. */
export function parseDocker(raw: string): ContainerFacts[] {
  const rows: ContainerFacts[] = [];
  for (const line of raw.split("\n")) {
    const entry = parseJson(line.trim()) as Record<string, unknown> | null;
    const name = text(entry?.Names, 120).split(",")[0];
    if (!entry || !name) continue;
    rows.push({
      id: text(entry.ID, 64),
      name,
      image: text(entry.Image),
      state: text(entry.State, 32),
      status: text(entry.Status, 80),
      ports: text(entry.Ports, 300),
      networks: text(entry.Networks, 300).split(",").filter(Boolean),
    });
    if (rows.length >= LIST_CAP) break;
  }
  return rows;
}

/** "k3s active" per line; only the active ones are kept. */
export function parseKubernetes(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([unit, state]) => unit && state === "active")
    .map(([unit]) => unit)
    .filter((unit) => ["k3s", "k3s-agent", "kubelet"].includes(unit));
}

/** `pvesh get /cluster/resources --type vm --output-format json` */
export function parsePveGuests(raw: string): GuestFacts[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 2000).flatMap((entry) => {
    const vmid = Number(entry?.vmid);
    const type = entry?.type;
    const node = text(entry?.node, 64);
    if (!Number.isInteger(vmid) || !node) return [];
    if (type !== "qemu" && type !== "lxc") return [];
    if (entry.template === 1) return [];
    return [
      {
        vmid,
        node,
        name: text(entry.name, 120) || `${type}-${vmid}`,
        type,
        status: text(entry.status, 32),
      },
    ];
  });
}

/** What DMI says when no metadata service answered. */
const DMI_VENDORS: Array<[RegExp, string]> = [
  [/amazon/i, "aws"],
  [/alibaba/i, "aliyun"],
  [/tencent/i, "tencent"],
  [/^google/i, "gcp"],
];

/**
 * key=value lines from the cloud probes. Only provider, instance id and
 * region are kept; the script asks for nothing else.
 */
export function parseCloud(raw: string): CloudFacts | undefined {
  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = /^([a-z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && /^[\w .:/@-]*$/.test(match[2]) && match[2].length <= 120) {
      values[match[1]] = match[2];
    }
  }
  const found = (provider: string, id?: string, region?: string) => {
    const facts: CloudFacts = { provider };
    if (id) facts.instanceId = id;
    if (region) facts.region = region;
    return facts;
  };
  if (values.gcp_id) {
    // projects/123/zones/us-central1-a: the project number is not ours to keep.
    return found("gcp", values.gcp_id, values.gcp_zone?.split("/").pop());
  }
  if (values.azure_id) {
    return found("azure", values.azure_id, values.azure_region);
  }
  if (values.aliyun_id) {
    return found("aliyun", values.aliyun_id, values.aliyun_region);
  }
  if (values.tencent_id) {
    return found("tencent", values.tencent_id, values.tencent_region);
  }
  const vendor = DMI_VENDORS.find(([pattern]) =>
    pattern.test(values.dmi_vendor ?? ""),
  )?.[1];
  if (values.ec2_id) {
    // OpenStack and others answer the EC2 paths too.
    return found(vendor ?? "ec2-compatible", values.ec2_id, values.ec2_region);
  }
  return vendor ? found(vendor) : undefined;
}

export function parseSections(
  sections: Partial<Record<SectionName, string>>,
): HostFacts {
  const facts: HostFacts = {};
  const section = (name: SectionName) => sections[name] ?? "";
  const os = parseOsRelease(section("os"));
  if (Object.keys(os).length) facts.os = os;
  facts.hostname = parseHostname(section("hostname"));
  facts.uptimeSec = parseUptime(section("uptime"));
  facts.interfaces = parseIpAddr(section("addr"));
  facts.routes = parseIpRoute(section("route"));
  facts.listening = parseListening(section("listen"));
  facts.connections = aggregateConnections(
    parseEstablished(section("established")),
    facts.listening,
  );
  facts.services = parseServices(section("services"));
  facts.containers = parseDocker(section("docker"));
  facts.kubernetes = parseKubernetes(section("k8s"));
  facts.guests = parsePveGuests(section("pve"));
  facts.cloud = parseCloud(section("cloud"));
  const missing = (Object.keys(sections) as SectionName[]).filter(
    (name) => !sections[name],
  );
  if (missing.length) facts.missing = missing;
  for (const key of Object.keys(facts) as Array<keyof HostFacts>) {
    if (facts[key] === undefined) delete facts[key];
  }
  return facts;
}

/**
 * Interfaces that are plumbing for containers and VMs on this host rather
 * than where the host sits on the network. Their addresses (172.17.0.1 on
 * every Docker host) would put every host in one more zone and make every
 * Docker host look like a pivot.
 */
const VIRTUAL_INTERFACE =
  /^(lo$|docker\d*$|br-|veth|cni|flannel|cali|vxlan|kube-|virbr|lxcbr|lxdbr|podman|cilium|weave|tunl|fwbr|fwpr|fwln|tap|vnet)/;

export function isVirtualInterface(name: string): boolean {
  return VIRTUAL_INTERFACE.test(name);
}

/** The host's own addresses, without loopback, link-local or bridges. */
export function hostAddresses(facts: HostFacts): string[] {
  const ips = (facts.interfaces ?? [])
    .filter((entry) => !isVirtualInterface(entry.name))
    .flatMap((entry) => entry.addrs.map((addr) => addr.split("/")[0]))
    .filter((ip) => !isIgnoredIp(ip));
  return [...new Set(ips)];
}

/** Subnets behind this host's bridges, where its containers and VMs live. */
export function bridgeSubnets(facts: HostFacts): Cidr[] {
  return (facts.interfaces ?? [])
    .filter((entry) => entry.name !== "lo" && isVirtualInterface(entry.name))
    .flatMap((entry) => entry.addrs)
    .map((addr) => parseCidr(addr))
    .filter((cidr): cidr is Cidr => cidr !== null);
}
