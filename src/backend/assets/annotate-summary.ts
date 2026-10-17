import { createHash } from "node:crypto";
import { estimateTokens } from "../context-window.js";
import type {
  ContainerFacts,
  GuestFacts,
  HostFacts,
  ListenFacts,
} from "./parsers.js";
import type { AssetRecord, EdgeRecord } from "./repository.js";

/**
 * What the model is told about an asset: a short, deterministic text built
 * from the collected facts and the collector's edges.
 *
 * Deterministic because its hash is the fingerprint that decides whether an
 * asset is annotated again, so everything is sorted and nothing that moves
 * between two collections of an unchanged host is in it: no uptime, no
 * connection counts, no container status text, no timestamps, and no AI
 * edges or annotations (those would change the input by annotating it).
 *
 * Nothing secret either: facts already hold no environment, command line or
 * label, and external addresses are reduced to a count per port.
 *
 * A unit is what one host contributes to a batch: the host, the containers
 * and Proxmox guests that run on it. Containers and guests are annotated in
 * their host's unit, never on their own.
 */

/** Entries of one list before "+N more". */
const LIST_LIMIT = 40;
const EDGE_LIMIT = 30;

/** Units that start, stop and keep a host alive; they say nothing about its role. */
const NOISE_SERVICES =
  /^(systemd-|getty@|serial-getty@|user@|dbus|polkit|rsyslog|cron|atd|unattended-upgrades|modemmanager|networkd-dispatcher|multipathd|udisks2|snapd|irqbalance|accounts-daemon|packagekit|upower|thermald|chrony|chronyd|qemu-guest-agent|lvm2|fwupd|wpa_supplicant|networkmanager|avahi-daemon|rtkit-daemon|rpcbind|lxcfs|open-vm-tools|vgauth|hv-kvp|ksmtuned|smartmontools|postfix|exim4)/i;

export interface AssetSummary {
  asset: AssetRecord;
  text: string;
  fingerprint: string;
}

export interface Unit {
  /** The host's key, or the asset's own when nothing it runs on is live. */
  key: string;
  members: AssetSummary[];
  text: string;
  tokens: number;
}

/** What Termix knows of a host that the collection does not: folder, tags. */
export interface HostMeta {
  folder: string | null;
  tags: string | null;
}

export const fingerprint = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 32);

const capped = (items: string[], limit = LIST_LIMIT) =>
  items.length > limit
    ? [...items.slice(0, limit), `+${items.length - limit} more`]
    : items;

const unique = (items: string[]) => [...new Set(items)].sort();

const ref = (asset: AssetRecord) => `${asset.name} [${asset.key}]`;

const isLoopback = (address: string) =>
  address.startsWith("127.") || address === "::1";

/** By protocol, then port as a number, then text, whatever order ss used. */
function listening(entries: ListenFacts[]): string[] {
  const rows = entries.map((entry) => ({
    ...entry,
    text: `${entry.proto}/${entry.port}${entry.process ? ` ${entry.process}` : ""}${isLoopback(entry.address) ? " (local only)" : ""}`,
  }));
  rows.sort(
    (a, b) =>
      a.proto.localeCompare(b.proto) ||
      a.port - b.port ||
      a.text.localeCompare(b.text),
  );
  return [...new Set(rows.map((row) => row.text))];
}

function services(facts: HostFacts): string[] {
  return unique(
    (facts.services ?? [])
      .map((service) => service.name.replace(/\.service$/, ""))
      .filter((name) => !NOISE_SERVICES.test(name)),
  );
}

const ports = (edge: EdgeRecord) =>
  ((edge.detail?.ports as number[] | undefined) ?? []).join(",");

const processes = (edge: EdgeRecord) => {
  const names = (edge.detail?.processes as string[] | undefined) ?? [];
  return names.length ? ` (${[...names].sort().join(", ")})` : "";
};

/** The collector's edges around one asset, as the lines the model reads. */
function edgeLines(
  asset: AssetRecord,
  edges: EdgeRecord[],
  byId: Map<number, AssetRecord>,
): string[] {
  const lines: string[] = [];
  const out = edges.filter(
    (edge) => edge.fromAsset === asset.id && edge.type === "connects_to",
  );
  const known = out
    .filter((edge) => byId.get(edge.toAsset)?.kind !== "external")
    .flatMap((edge) => {
      const peer = byId.get(edge.toAsset);
      return peer ? [`${ref(peer)} tcp/${ports(edge)}${processes(edge)}`] : [];
    });
  const external = out.filter(
    (edge) => byId.get(edge.toAsset)?.kind === "external",
  );
  if (known.length) {
    lines.push(`outbound: ${capped(unique(known), EDGE_LIMIT).join("; ")}`);
  }
  if (external.length) {
    const externalPorts = unique(
      external.map(ports).flatMap((p) => p.split(",")),
    )
      .map(Number)
      .sort((a, b) => a - b);
    lines.push(
      `outbound external: ${external.length} addresses on tcp/${externalPorts.join(",")}`,
    );
  }
  const inbound = edges
    .filter((edge) => edge.toAsset === asset.id && edge.type === "connects_to")
    .flatMap((edge) => {
      const peer = byId.get(edge.fromAsset);
      return peer ? [`${ref(peer)} tcp/${ports(edge)}`] : [];
    });
  if (inbound.length) {
    lines.push(`inbound: ${capped(unique(inbound), EDGE_LIMIT).join("; ")}`);
  }
  const runsOn = edges.find(
    (edge) => edge.fromAsset === asset.id && edge.type === "runs_on",
  );
  const parent = runsOn ? byId.get(runsOn.toAsset) : undefined;
  if (parent && asset.kind === "host") lines.push(`runs on: ${ref(parent)}`);
  const guests = edges
    .filter(
      (edge) =>
        edge.toAsset === asset.id &&
        edge.type === "runs_on" &&
        byId.get(edge.fromAsset)?.kind !== "container",
    )
    .flatMap((edge) => {
      const guest = byId.get(edge.fromAsset);
      return guest ? [ref(guest)] : [];
    });
  if (guests.length) {
    lines.push(
      `proxmox node, guests: ${capped(unique(guests), EDGE_LIMIT).join("; ")}`,
    );
  }
  return lines;
}

function hostLines(asset: AssetRecord, meta: HostMeta | undefined): string[] {
  const facts = (asset.facts ?? {}) as HostFacts;
  const lines: string[] = [];
  const termix = [
    meta?.folder ? `folder=${meta.folder}` : "",
    meta?.tags
      ? `tags=${unique(
          meta.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        ).join(",")}`
      : "",
  ].filter(Boolean);
  if (termix.length) lines.push(`termix: ${termix.join(" ")}`);
  if (facts.os?.pretty) lines.push(`os: ${facts.os.pretty}`);
  if (facts.cloud) {
    lines.push(
      `cloud: ${facts.cloud.provider}${facts.cloud.region ? ` ${facts.cloud.region}` : ""}`,
    );
  }
  const listen = listening(facts.listening ?? []);
  if (listen.length) lines.push(`listening: ${capped(listen).join("; ")}`);
  const running = services(facts);
  if (running.length) lines.push(`services: ${capped(running).join(", ")}`);
  if (facts.kubernetes?.length) {
    lines.push(`kubernetes: ${unique(facts.kubernetes).join(", ")}`);
  }
  if (!asset.collectedAt) lines.push("not collected yet");
  return lines;
}

function containerLines(asset: AssetRecord): string[] {
  const container = (asset.facts as { container?: ContainerFacts } | null)
    ?.container;
  if (!container) return [];
  return [
    `image: ${container.image}`,
    `state: ${container.state}`,
    ...(container.ports ? [`ports: ${container.ports}`] : []),
  ];
}

function guestLines(asset: AssetRecord): string[] {
  const guest = (asset.facts as { guest?: GuestFacts } | null)?.guest;
  return guest
    ? [
        `proxmox ${guest.type} ${guest.vmid} on node ${guest.node}, ${guest.status}`,
      ]
    : [];
}

/** One asset's summary: a header line and indented facts. */
export function summarize(
  asset: AssetRecord,
  edges: EdgeRecord[],
  byId: Map<number, AssetRecord>,
  meta?: HostMeta,
): string {
  const zone = asset.zone
    ? `zone: ${asset.zone}${asset.multiZone ? " (multi-zone)" : ""}`
    : "";
  const body =
    asset.kind === "host"
      ? hostLines(asset, meta)
      : asset.kind === "container"
        ? containerLines(asset)
        : guestLines(asset);
  const lines = [
    ...(zone ? [zone] : []),
    ...body,
    ...edgeLines(asset, edges, byId),
  ];
  return [
    `[${asset.key}] ${asset.name} (${asset.kind})`,
    ...lines.map((line) => `  ${line}`),
  ].join("\n");
}

/**
 * Every live host, guest and container grouped into units. External assets
 * are never sent. Only the collector's edges are read; `edges` may hold
 * others, which are skipped.
 */
export function buildUnits(
  assets: AssetRecord[],
  edges: EdgeRecord[],
  meta: Map<number, HostMeta>,
): Unit[] {
  const live = assets.filter((asset) => !asset.removedAt);
  const byId = new Map(live.map((asset) => [asset.id, asset]));
  const collected = edges.filter(
    (edge) =>
      edge.source === "collector" &&
      byId.has(edge.fromAsset) &&
      byId.has(edge.toAsset),
  );
  const parentOf = (asset: AssetRecord): AssetRecord | undefined => {
    if (asset.kind === "host") return undefined;
    const edge = collected.find(
      (entry) => entry.fromAsset === asset.id && entry.type === "runs_on",
    );
    const target = edge ? byId.get(edge.toAsset) : undefined;
    if (target?.kind === "host") return target;
    return live.find(
      (entry) => entry.kind === "host" && entry.hostId === asset.hostId,
    );
  };

  const units = new Map<string, AssetSummary[]>();
  const ordered = live
    .filter((asset) => asset.kind !== "external")
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const asset of ordered) {
    const text = summarize(
      asset,
      collected,
      byId,
      asset.hostId !== null ? meta.get(asset.hostId) : undefined,
    );
    const unitKey = parentOf(asset)?.key ?? asset.key;
    const members = units.get(unitKey) ?? [];
    members.push({ asset, text, fingerprint: fingerprint(text) });
    units.set(unitKey, members);
  }
  return [...units.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, members]) => {
      // The host first, then what runs on it.
      members.sort(
        (a, b) =>
          Number(b.asset.key === key) - Number(a.asset.key === key) ||
          a.asset.key.localeCompare(b.asset.key),
      );
      const text = members.map((member) => member.text).join("\n");
      return { key, members, text, tokens: estimateTokens(text) };
    });
}
