import {
  cidrContains,
  isIgnoredIp,
  parseCidr,
  parseCidrList,
  parseIp,
  type Cidr,
} from "./net.js";

/**
 * Which zone an address, and so an asset, sits in.
 *
 * An admin's CIDR rules come first: the most specific prefix wins, and a
 * higher priority breaks a tie. Then the built-in rules: 100.64/10 (and
 * Tailscale's IPv6 range) is overlay, RFC 1918 and IPv6 ULA are internal,
 * anything else routable is external. A host whose cloud metadata answered
 * is cloud instead of internal or external. Loopback and link-local have no
 * zone. An asset with addresses in more than one zone is multi-zone: it can
 * reach both sides, which makes it a potential pivot.
 */

export const ZONE_KINDS = [
  "internal",
  "dmz",
  "external",
  "cloud",
  "overlay",
] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

export interface ZoneRule {
  name: string;
  kind: ZoneKind;
  cidr: string;
  priority: number;
}

interface CompiledRule extends ZoneRule {
  parsed: Cidr;
}

export interface ZoneMatch {
  /** The rule's name, or the built-in kind. */
  name: string;
  kind: ZoneKind;
  builtin: boolean;
}

const OVERLAY = parseCidrList(["100.64.0.0/10", "fd7a:115c:a1e0::/48"]);
const PRIVATE = parseCidrList([
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "fc00::/7",
]);

export function compileRules(rules: ZoneRule[]): CompiledRule[] {
  return rules
    .flatMap((rule) => {
      const parsed = parseCidr(rule.cidr);
      return parsed ? [{ ...rule, parsed }] : [];
    })
    .sort(
      (a, b) => b.parsed.prefix - a.parsed.prefix || b.priority - a.priority,
    );
}

export function classifyIp(
  ip: string,
  rules: CompiledRule[],
  cloud = false,
): ZoneMatch | null {
  if (isIgnoredIp(ip)) return null;
  const parsed = parseIp(ip)!;
  const rule = rules.find((entry) => cidrContains(entry.parsed, parsed));
  if (rule) return { name: rule.name, kind: rule.kind, builtin: false };
  const builtin = (kind: ZoneKind): ZoneMatch => ({
    name: kind,
    kind,
    builtin: true,
  });
  if (OVERLAY.some((cidr) => cidrContains(cidr, parsed))) {
    return builtin("overlay");
  }
  if (cloud) return builtin("cloud");
  return builtin(
    PRIVATE.some((cidr) => cidrContains(cidr, parsed))
      ? "internal"
      : "external",
  );
}

export interface AssetZone {
  zone: string | null;
  multiZone: boolean;
  zones: string[];
}

/**
 * The asset's zone is that of its first address that has one, so callers put
 * the address Termix connects to first. Every zone counts for multi-zone.
 */
export function classifyAsset(
  ips: string[],
  rules: CompiledRule[],
  cloud = false,
): AssetZone {
  const zones = [
    ...new Set(ips.flatMap((ip) => classifyIp(ip, rules, cloud)?.name ?? [])),
  ];
  return { zone: zones[0] ?? null, multiZone: zones.length > 1, zones };
}
