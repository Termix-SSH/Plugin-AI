import { isIP } from "node:net";
import type { Candidate, Endpoint, Observation } from "./types.js";

/** Fixed metadata commands. No discovered argument is interpolated into a shell. */
export const PORTABLE = {
  listen:
    "if command -v ss >/dev/null 2>&1; then ss -H -tuln; else netstat -tuln; fi",
  docker: "docker ps --format '{{json .ID}} {{json .Ports}}'",
  nft: "nft -j list ruleset",
  iptables: "iptables -t nat -S",
  uci: `uci -q show firewall | awk -F= '$1 ~ /^firewall\\.[^.]+(\\.(enabled|target|src_dport|dest_port|dest_ip|proto|src_ip|src_dip|src))?$/ {print}'`,
} as const;
export type PortableSource = keyof typeof PORTABLE;
export function portableScript(source: PortableSource): string {
  // UCI's exit status must survive the projection pipeline; never mistake failure for emptiness.
  if (source === "uci")
    return `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY\ncommand -v uci >/dev/null 2>&1 || exit 127\n(uci -q show firewall 2>/dev/null; printf '\\n__TERMIX_UCI_STATUS_%s\\n' "$?") | awk -F= '$1 ~ /^firewall\\.[^.]+(\\.(enabled|target|src_dport|dest_port|dest_ip|proto|src_ip|src_dip|src))?$/ || /^__TERMIX_UCI_STATUS_/ {print}'`;
  return `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY\n{ ${PORTABLE[source]}; } 2>/dev/null`;
}
const ep = (
  address: string,
  port: string | number,
  protocol = "tcp",
): Endpoint => {
  address = address.replace(/^\[|\]$/g, "");
  const value = Number(port);
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535 ||
    !["tcp", "udp"].includes(protocol)
  )
    throw Error("endpoint");
  return { address, port: value, protocol: protocol as "tcp" | "udp" };
};
const socket = (value: string, protocol = "tcp") => {
  const colon = value.lastIndexOf(":");
  if (colon < 0) throw Error("socket");
  return ep(value.slice(0, colon), value.slice(colon + 1), protocol);
};
const row = (
  objectKey: string,
  kind: Candidate["kind"],
  endpoint: Endpoint,
  backend?: Endpoint,
): Candidate => ({
  objectKey,
  kind,
  endpoint,
  ...(backend ? { backend } : {}),
  tls: "unknown",
  restricted: "unknown",
  constraints: [],
});
// Tokenize shell-quoted metadata, never evaluate it (not a shell interpreter).
function words(text: string): string[] {
  const output: string[] = [];
  let token = "",
    quote = "",
    escape = false,
    active = false;
  for (const c of text) {
    if (escape) {
      token += c;
      escape = false;
      continue;
    }
    if (c === "\\" && quote !== "'") {
      escape = true;
      active = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      else token += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      active = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (active) output.push(token);
      token = "";
      active = false;
      continue;
    }
    token += c;
    active = true;
  }
  if (quote || escape) throw Error("quoting");
  if (active) output.push(token);
  return output;
}
/** Recover ports carried by kube-proxy entry chains; never guess them from backend ports. */
function kubeProxyRules(text: string): { text: string; limited: boolean } {
  const lines = text.split("\n");
  const value = (args: string[], flag: string) =>
    args.indexOf(flag) < 0 ? undefined : args[args.indexOf(flag) + 1];
  const rules = lines.map((line) => {
    try {
      return words(line);
    } catch {
      return [];
    }
  });
  const chains = new Map<string, number[]>();
  rules.forEach((args, index) => {
    const chain = value(args, "-A");
    if (chain?.startsWith("KUBE-"))
      chains.set(chain, [...(chains.get(chain) ?? []), index]);
  });
  const bindings = new Map<number, string[][]>();
  let visits = 0,
    count = 0,
    limited = false;
  roots: for (const root of rules) {
    const port = value(root, "--dport"),
      proto = value(root, "-p"),
      first = value(root, "-j");
    if (
      !port ||
      !["tcp", "udp"].includes(proto ?? "") ||
      !first?.startsWith("KUBE-")
    )
      continue;
    // A negated source/port condition cannot become a positive entry binding.
    if (root.includes("!")) continue;
    const stack = [{ chain: first, seen: new Set<string>() }];
    while (stack.length) {
      if (++visits > 10000) {
        limited = true;
        break roots;
      }
      const { chain, seen } = stack.pop()!;
      if (seen.has(chain) || seen.size >= 16) {
        limited = true;
        continue;
      }
      const nextSeen = new Set([...seen, chain]);
      for (const index of chains.get(chain) ?? []) {
        const args = rules[index],
          jump = value(args, "-j");
        if (
          jump === "DNAT" &&
          !value(args, "--dport") &&
          value(args, "-p") === proto
        ) {
          if (++count > 300) {
            limited = true;
            break roots;
          }
          const inherited = [...args, "--dport", port, "--termix-kube-path"];
          const address = value(root, "-d");
          if (address) inherited.push("-d", address);
          const source = value(root, "-s");
          if (source) inherited.push("-s", source);
          bindings.set(index, [...(bindings.get(index) ?? []), inherited]);
        } else if (jump?.startsWith("KUBE-"))
          stack.push({ chain: jump, seen: nextSeen });
      }
    }
  }
  return {
    limited,
    text: lines
      .flatMap((line, index) =>
        bindings.has(index)
          ? bindings
              .get(index)!
              .map((args) => args.map((arg) => JSON.stringify(arg)).join(" "))
          : [line],
      )
      .join("\n"),
  };
}
export function parsePortable(
  source: PortableSource,
  text: string,
): Observation {
  const records: Candidate[] = [],
    issues: NonNullable<Observation["issues"]> = [];
  const issue = (objectKey: string) =>
    issues.push({ objectKey, reason: "unsupported-rule" });
  const add = (key: string, fn: () => Candidate[]) => {
    try {
      records.push(...fn());
    } catch {
      issue(key);
    }
  };
  if (text.includes("characters cut ..."))
    return { source, status: "truncated", complete: false, records: [] };
  try {
    if (source === "iptables") {
      const expanded = kubeProxyRules(text);
      text = expanded.text;
      if (expanded.limited) issue("kube-proxy-traversal-limit");
    }
    if (source === "listen")
      for (const [i, line] of text.trim().split("\n").entries()) {
        if (!line.trim()) continue;
        add(`line:${i}`, () => {
          const cols = line.trim().split(/\s+/);
          if (/^(Active|Proto)/.test(cols[0])) return [];
          if (
            cols.length < 4 ||
            !["tcp", "udp", "tcp6", "udp6"].includes(cols[0])
          )
            throw Error("listener");
          const endpoint = socket(
            cols[/^\d+$/.test(cols[1]) ? 3 : 4],
            cols[0].replace(/6$/, ""),
          );
          const r = row(
            `${cols[0]}:${endpoint.address}:${endpoint.port}`,
            "listener",
            endpoint,
          );
          if (endpoint.address === "*")
            r.constraints.push("address-family-unknown");
          return [r];
        });
      }
    if (source === "docker")
      for (const [i, line] of text.trim().split("\n").entries()) {
        if (!line.trim()) continue;
        add(`container:${i}`, () => {
          const [id, ports] = JSON.parse(
            `[${line.replace(/^([^ ]+) /, "$1,")}]`,
          );
          if (
            typeof id !== "string" ||
            !/^[a-f0-9]+$/.test(id) ||
            typeof ports !== "string"
          )
            throw Error("container");
          const matches = [
            ...ports.matchAll(/(\[[^\]]+\]|[\d.]+):(\d+)->(\d+)\/(tcp|udp)/g),
          ];
          if (matches.length !== (ports.match(/->/g) ?? []).length)
            issue(`container:${id}`);
          return matches.map((m) => {
            const r = row(
              `${id}:${m[2]}:${m[1]}`,
              "mapping",
              ep(m[1], m[2], m[4]),
            );
            r.constraints.push(`container-port:${m[3]}`);
            return r;
          });
        });
      }
    if (source === "iptables")
      for (const [i, line] of text.trim().split("\n").entries()) {
        if (!line.includes("DNAT")) continue;
        add(`rule:${i}`, () => {
          const args = words(line),
            value = (flag: string) =>
              args.indexOf(flag) < 0 ? undefined : args[args.indexOf(flag) + 1];
          if (value("-j") !== "DNAT") return [];
          const port = value("--dport"),
            proto = value("-p"),
            dest = value("--to-destination");
          if (!port || !proto || !dest) throw Error("dnat");
          const backend = dest.includes(":")
            ? socket(dest, proto)
            : ep(dest, port, proto);
          if (isIP(backend.address) !== 4) throw Error("destination");
          const binding = value("-d");
          const r = row(
            `rule:${i}`,
            "mapping",
            ep(
              binding?.endsWith("/32")
                ? binding.slice(0, -3)
                : binding && isIP(binding) === 4
                  ? binding
                  : "0.0.0.0",
              port,
              proto,
            ),
            backend,
          );
          r.constraints.push("filter-chain-unverified");
          if (args.includes("--termix-kube-path"))
            r.constraints.push(
              "kube-proxy-chain-and-load-balancing-unverified",
            );
          for (let j = 0; j < args.length; j++) {
            if (args[j] !== "!") continue;
            if (!["-i", "-o"].includes(args[j + 1])) throw Error("negation");
            if (!/^[\w.*:+-]{1,64}$/.test(args[j + 2] ?? ""))
              throw Error("interface");
            r.constraints.push(`not-interface:${args[j + 2]}`);
          }
          const src = value("-s");
          if (src && /^[\d./]+$/.test(src)) {
            r.constraints.push(`source:${src}`);
            r.restricted = "configured";
          }
          if (args.includes("-m"))
            r.constraints.push("additional-match-conditions-unverified");
          return [r];
        });
      }
    if (source === "uci") {
      const status = text.match(/\n__TERMIX_UCI_STATUS_(\d+)\s*$/);
      if (!status || status[1] !== "0") throw Error("uci status");
      const objects = new Map<string, Record<string, string>>();
      for (const line of text.split("\n")) {
        if (!line.startsWith("firewall.")) continue;
        const at = line.indexOf("="),
          key = line.slice(0, at).split(".");
        if (at < 0 || key.length > 3) continue;
        const d = objects.get(key[1]) ?? {};
        d[key[2] ?? "type"] = words(line.slice(at + 1)).join(" ");
        objects.set(key[1], d);
      }
      for (const [key, d] of objects) {
        if (
          d.type !== "redirect" ||
          d.enabled === "0" ||
          (d.target && d.target !== "DNAT")
        )
          continue;
        add(key, () => {
          if (!isIP(d.dest_ip ?? "")) throw Error("destination");
          return (d.proto ?? "tcp udp").split(/\s+/).map((proto) => {
            const r = row(
              `${key}:${proto}`,
              "mapping",
              ep(
                d.src_dip || (isIP(d.dest_ip) === 6 ? "::" : "0.0.0.0"),
                d.src_dport,
                proto,
              ),
              ep(d.dest_ip, d.dest_port || d.src_dport, proto),
            );
            r.constraints.push("configured-rule-not-runtime");
            if (d.src && /^[\w-]{1,64}$/.test(d.src))
              r.constraints.push(`source-zone:${d.src}`);
            if (d.src_ip && /^[\da-fA-F:./]+$/.test(d.src_ip)) {
              r.constraints.push(`source:${d.src_ip}`);
              r.restricted = "configured";
            }
            return r;
          });
        });
      }
    }
    if (source === "nft") {
      const data = JSON.parse(text);
      if (!Array.isArray(data.nftables)) throw Error("nft schema");
      for (const [i, item] of data.nftables.entries()) {
        const r = item.rule;
        if (!r || !Array.isArray(r.expr) || !r.expr.some((e: any) => e.dnat))
          continue;
        add(`rule:${i}`, () => {
          const dest = r.expr.find((e: any) => e.dnat).dnat;
          const match = r.expr
            .map((e: any) => e.match)
            .find(
              (m: any) =>
                m?.op === "==" &&
                m.left?.payload?.field === "dport" &&
                Number.isInteger(m.right),
            );
          if (!match || typeof dest.addr !== "string" || !isIP(dest.addr))
            throw Error("dnat");
          const proto = match.left.payload.protocol;
          const result = row(
            `rule:${i}`,
            "mapping",
            ep(isIP(dest.addr) === 6 ? "::" : "0.0.0.0", match.right, proto),
            ep(dest.addr, dest.port ?? match.right, proto),
          );
          result.constraints.push("filter-chain-unverified");
          for (const expr of r.expr) {
            const m = expr.match;
            if (m?.op !== "==" || m.left?.payload?.field !== "saddr") continue;
            const raw =
              typeof m.right === "string"
                ? m.right
                : m.right?.prefix
                  ? `${m.right.prefix.addr}/${m.right.prefix.len}`
                  : "";
            if (/^[\da-fA-F:./]+$/.test(raw)) {
              result.constraints.push(`source:${raw}`);
              result.restricted = "configured";
            }
          }
          result.constraints.push("additional-match-conditions-unverified");
          return [result];
        });
      }
    }
  } catch {
    return { source, status: "failed", complete: false, records: [] };
  }
  return {
    source,
    status: records.length > 300 ? "truncated" : "ok",
    complete: issues.length === 0 && records.length <= 300,
    records: records.slice(0, 300),
    issues: issues.slice(0, 300),
  };
}
