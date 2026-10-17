import { isIP } from "node:net";

/**
 * Addresses as numbers, so a CIDR test is a shift and a compare. IPv4-mapped
 * IPv6 is folded back to IPv4 and a zone suffix (%eth0) is dropped, since ss
 * prints both and a peer should match however it was written.
 */

export interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

export function normalizeIp(raw: string): string | null {
  let ip = raw.trim().replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (!isIP(ip)) return null;
  return isIP(ip) === 6 ? ip.toLowerCase() : ip;
}

function parseV4(ip: string): bigint {
  return ip
    .split(".")
    .reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function parseV6(ip: string): bigint {
  // A trailing dotted quad is two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    const v4 = parseV4(dotted[1]);
    ip = `${ip.slice(0, dotted.index)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = ip.split("::");
  const groups = (part: string | undefined) =>
    part ? part.split(":").filter(Boolean) : [];
  const left = groups(head);
  const right = groups(tail);
  const fill =
    tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].reduce(
    (value, group) => (value << 16n) | BigInt(parseInt(group, 16)),
    0n,
  );
}

export function parseIp(raw: string): ParsedIp | null {
  const ip = normalizeIp(raw);
  if (!ip) return null;
  return isIP(ip) === 4
    ? { version: 4, value: parseV4(ip) }
    : { version: 6, value: parseV6(ip) };
}

export interface Cidr {
  version: 4 | 6;
  base: bigint;
  prefix: number;
}

/** "10.0.0.0/8", or a bare address as a host route. Null when invalid. */
export function parseCidr(raw: string): Cidr | null {
  const [address, length, extra] = raw.trim().split("/");
  if (extra !== undefined) return null;
  const ip = parseIp(address);
  if (!ip) return null;
  const bits = ip.version === 4 ? 32 : 128;
  const prefix = length === undefined ? bits : Number(length);
  if (!/^\d+$/.test(length ?? String(bits)) || prefix > bits) return null;
  const shift = BigInt(bits - prefix);
  return { version: ip.version, base: (ip.value >> shift) << shift, prefix };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  if (cidr.version !== ip.version) return false;
  const shift = BigInt((ip.version === 4 ? 32 : 128) - cidr.prefix);
  return ip.value >> shift === cidr.base >> shift;
}

/** Known-good literals only: an invalid entry would throw at load. */
export const parseCidrList = (list: string[]) =>
  list.map((entry) => parseCidr(entry)!);

/** Loopback, link-local, unspecified and multicast: never a zone. */
const IGNORED = parseCidrList([
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "::/128",
  "::1/128",
  "fe80::/10",
  "ff00::/8",
]);

export function isIgnoredIp(ip: string): boolean {
  const parsed = parseIp(ip);
  return !parsed || IGNORED.some((cidr) => cidrContains(cidr, parsed));
}

export function inAny(ip: string, list: Cidr[]): boolean {
  const parsed = parseIp(ip);
  return !!parsed && list.some((cidr) => cidrContains(cidr, parsed));
}
