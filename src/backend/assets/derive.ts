import { inAny, isIgnoredIp, normalizeIp } from "./net.js";
import {
  bridgeSubnets,
  hostAddresses,
  type ContainerFacts,
  type GuestFacts,
  type HostFacts,
} from "./parsers.js";

/**
 * From parsed facts to assets and edges, with no database in sight.
 *
 * Matching a Proxmox guest to a Termix host: pvesh lists guests by node,
 * vmid and name but not their addresses, so the match is by name. A guest
 * whose name equals a Termix host's name or collected hostname (ignoring
 * case, and only when exactly one host has it) is that host: no separate
 * guest asset, and the host gets the runs_on edge to its node. Any other
 * guest becomes a guest asset of its own. A node is found the same way, by
 * its name against host names and hostnames.
 */

export type AssetKind = "host" | "guest" | "container" | "external";
export type EdgeType = "runs_on" | "connects_to" | "member_of" | "depends_on";

export const hostKey = (hostId: number) => `host:${hostId}`;
export const guestKey = (guest: Pick<GuestFacts, "node" | "vmid">) =>
  `guest:${guest.node}/${guest.vmid}`;
export const containerKey = (hostId: number, name: string) =>
  `container:${hostId}/${name}`;
export const externalKey = (ip: string) => `external:${ip}`;

/** Outbound connections to addresses outside the inventory, kept per host. */
export const EXTERNAL_CAP = 25;
/** Above this the peer's port is itself ephemeral: a reply, not a service. */
const SERVICE_PORT_MAX = 32767;

export interface CollectedHost {
  hostId: number;
  /** The Termix host's name, or its address when it has none. */
  name: string;
  /** The address Termix connects to; may be a DNS name. */
  address: string;
  facts: HostFacts;
}

export interface AssetDraft {
  key: string;
  kind: AssetKind;
  hostId: number | null;
  name: string;
  ips: string[];
  facts: Record<string, unknown> | null;
  cloud: boolean;
}

export interface EdgeDraft {
  from: string;
  to: string;
  type: EdgeType;
  detail: Record<string, unknown>;
  evidence: string;
}

/** A host asset as matching sees it: key and the names it goes by. */
export interface NamedHost {
  key: string;
  names: string[];
}

/**
 * The host's own addresses: its interfaces, led by the Termix address when
 * that is one of them so it decides the zone. A Termix address on no
 * interface is a NAT or port forward in front of the host (see reachedVia),
 * not the host's own; it only stands in when no interface was read at all.
 */
export function hostIps(host: CollectedHost): string[] {
  const own = hostAddresses(host.facts);
  const address = normalizeIp(host.address);
  const usable = address && !isIgnoredIp(address) ? address : null;
  if (!own.length) return usable ? [usable] : [];
  return usable && own.includes(usable)
    ? [usable, ...own.filter((ip) => ip !== usable)]
    : own;
}

/** The Termix address when it sits on none of the host's interfaces. */
export function reachedVia(host: CollectedHost): string | null {
  const own = hostAddresses(host.facts);
  const address = normalizeIp(host.address);
  if (!address || isIgnoredIp(address) || !own.length) return null;
  return own.includes(address) ? null : address;
}

export function hostDraft(host: CollectedHost): AssetDraft {
  return {
    key: hostKey(host.hostId),
    kind: "host",
    hostId: host.hostId,
    name: host.name,
    ips: hostIps(host),
    facts: {
      ...(host.facts as Record<string, unknown>),
      ...(reachedVia(host) ? { reachedVia: reachedVia(host) } : {}),
    },
    cloud: !!host.facts.cloud,
  };
}

/** Lower-cased name to host key; a name two hosts share matches neither. */
export function nameIndex(hosts: NamedHost[]): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const host of hosts) {
    for (const name of new Set(host.names.map((n) => n.toLowerCase()))) {
      if (!name) continue;
      const existing = index.get(name);
      index.set(
        name,
        existing === undefined || existing === host.key ? host.key : null,
      );
    }
  }
  return index;
}

function guestEdge(from: string, node: string, guest: GuestFacts): EdgeDraft {
  return {
    from,
    to: node,
    type: "runs_on",
    detail: { vmid: guest.vmid, type: guest.type, node: guest.node },
    evidence: `pvesh: ${guest.type} ${guest.vmid} (${guest.name}) on node ${guest.node}`,
  };
}

function containerDraft(
  host: CollectedHost,
  container: ContainerFacts,
): AssetDraft {
  return {
    key: containerKey(host.hostId, container.name),
    kind: "container",
    hostId: host.hostId,
    name: container.name,
    ips: [],
    facts: { container },
    cloud: false,
  };
}

/**
 * Guests and containers the collected hosts reported, and the runs_on edges
 * that tie them, and matched hosts, to their hosts. `known` is every host
 * asset in the inventory, so a guest can match a host collected earlier.
 */
export function deriveWorkloads(
  collected: CollectedHost[],
  known: NamedHost[],
): { assets: AssetDraft[]; edges: EdgeDraft[] } {
  const names = nameIndex(known);
  const assets = new Map<string, AssetDraft>();
  const edges = new Map<string, EdgeDraft>();
  const addEdge = (edge: EdgeDraft) =>
    edges.set(`${edge.from}|${edge.to}|${edge.type}`, edge);

  for (const host of collected) {
    for (const container of host.facts.containers ?? []) {
      const draft = containerDraft(host, container);
      assets.set(draft.key, draft);
      addEdge({
        from: draft.key,
        to: hostKey(host.hostId),
        type: "runs_on",
        detail: { image: container.image },
        evidence: `docker ps on ${host.name}: ${container.name} (${container.image})`,
      });
    }

    // Every node of a cluster lists the whole cluster; the first one wins.
    for (const guest of host.facts.guests ?? []) {
      const node = names.get(guest.node.toLowerCase()) ?? null;
      const match = names.get(guest.name.toLowerCase()) ?? null;
      if (match && match !== node) {
        if (node) addEdge(guestEdge(match, node, guest));
        continue;
      }
      const key = guestKey(guest);
      if (assets.has(key)) continue;
      assets.set(key, {
        key,
        kind: "guest",
        hostId: host.hostId,
        name: guest.name,
        ips: [],
        facts: { guest },
        cloud: false,
      });
      if (node) addEdge(guestEdge(key, node, guest));
    }
  }
  return { assets: [...assets.values()], edges: [...edges.values()] };
}

/**
 * connects_to edges from one host's outbound connections.
 *
 * Only outbound ones (the local port is not one the host listens on) to a
 * service port count: inbound clients show up from their own side when they
 * are collected, and public clients of a web server would otherwise flood
 * the inventory. Peers on the host's own addresses or bridges are its own
 * workloads. A peer the index does not know becomes an external asset, at
 * most EXTERNAL_CAP per host, busiest first; an address two assets share is
 * ambiguous and skipped.
 */
export function deriveConnections(
  host: CollectedHost,
  ipIndex: Map<string, string | null>,
): { edges: EdgeDraft[]; externals: string[] } {
  const self = hostKey(host.hostId);
  const own = new Set([
    ...hostIps(host),
    ...(host.facts.interfaces ?? []).flatMap((entry) =>
      entry.addrs.map((addr) => addr.split("/")[0]),
    ),
  ]);
  const bridges = bridgeSubnets(host.facts);
  const groups = new Map<
    string,
    {
      peers: Set<string>;
      ports: Set<number>;
      processes: Set<string>;
      count: number;
    }
  >();

  for (const connection of host.facts.connections ?? []) {
    const peer = connection.peer;
    if (connection.direction !== "out" || connection.port > SERVICE_PORT_MAX) {
      continue;
    }
    if (own.has(peer) || isIgnoredIp(peer) || inAny(peer, bridges)) continue;
    const target = ipIndex.has(peer) ? ipIndex.get(peer) : externalKey(peer);
    if (!target || target === self) continue;
    const group = groups.get(target) ?? {
      peers: new Set(),
      ports: new Set(),
      processes: new Set(),
      count: 0,
    };
    group.peers.add(peer);
    group.ports.add(connection.port);
    connection.processes.forEach((name) => group.processes.add(name));
    group.count += connection.count;
    groups.set(target, group);
  }

  const external = [...groups.entries()]
    .filter(([key]) => key.startsWith("external:"))
    .sort((a, b) => b[1].count - a[1].count);
  const dropped = new Set(external.slice(EXTERNAL_CAP).map(([key]) => key));

  const edges = [...groups.entries()]
    .filter(([key]) => !dropped.has(key))
    .map(([to, group]) => {
      const ports = [...group.ports].sort((a, b) => a - b);
      const processes = [...group.processes].sort();
      const peers = [...group.peers];
      return {
        from: self,
        to,
        type: "connects_to" as const,
        detail: { ports, processes, count: group.count, peers },
        evidence: `ss on ${host.name}: ${group.count} established to ${peers[0]}:${ports.join(",")}${processes.length ? ` (${processes.join(", ")})` : ""}`,
      };
    });
  return {
    edges,
    externals: external
      .slice(0, EXTERNAL_CAP)
      .map(([key]) => key.slice("external:".length)),
  };
}

/**
 * Address to asset key for every live asset. Hosts, guests and containers
 * come before external assets, so an address a host now reports stops
 * resolving to the external asset it once was.
 */
export function buildIpIndex(
  assets: Array<{ key: string; kind: AssetKind; ips: string[] }>,
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  const ordered = [
    ...assets.filter((asset) => asset.kind !== "external"),
    ...assets.filter((asset) => asset.kind === "external"),
  ];
  for (const asset of ordered) {
    for (const ip of asset.ips) {
      const existing = index.get(ip);
      if (existing === undefined) index.set(ip, asset.key);
      else if (existing !== asset.key && asset.kind !== "external") {
        index.set(ip, null);
      }
    }
  }
  return index;
}
