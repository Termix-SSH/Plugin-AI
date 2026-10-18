import { PORTABLE, portableScript, type PortableSource } from "./portable.js";

/**
 * The quick exposure sources in one SSH session, and the Python collector in
 * a second only where Python exists. One session per source meant six
 * connections per host per collection, and a burst of short sessions is
 * what an SSH daemon or guard treats as abuse: during testing one host
 * stopped accepting this server's connections for twenty minutes. The
 * Python collector stays apart because it is ~23 KB and dropbear (OpenWrt)
 * refuses exec commands over ~9000 bytes. Each section keeps its own limit
 * and exit status.
 */

const MARK = "__TERMIX_EXPOSURE__";
/** The section saying whether python3 is there. */
export const PYTHON = "python";
/** Bytes one source may return, as when each ran on its own. */
export const SECTION_LIMIT = 2_000_000;
export const QUICK_TIMEOUT_MS = 40_000;
export const QUICK_OUTPUT_LIMIT = 11_000_000;

const sources = () => Object.keys(PORTABLE) as PortableSource[];

function section(name: string, body: string): string {
  // A quoted heredoc keeps the body away from this shell's expansion.
  return [
    `printf '\\n${MARK} %s\\n' '${name}'`,
    `run <<'TERMIX_SECTION_${name}' 2>/dev/null`,
    body,
    `TERMIX_SECTION_${name}`,
    `printf '\\n${MARK} %s %s\\n' 'status' "$?"`,
  ].join("\n");
}

/** The quick sources and the python3 check, small enough for dropbear. */
export function quickScript(): string {
  return [
    "unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY",
    // A function, not "$T sh": zsh, a common login shell, does not split $T.
    "run() { if command -v timeout >/dev/null 2>&1; then timeout 5 sh; else sh; fi; }",
    ...sources().map((source) => section(source, portableScript(source))),
    section(PYTHON, "command -v python3 >/dev/null 2>&1"),
  ].join("\n");
}

export interface SectionResult {
  code: number;
  output: string;
}

/**
 * The session's output by section. A section that never printed its status
 * (the session was cut short) is missing, and one over the limit is dropped,
 * so neither can pass for an empty, successful source.
 */
export function splitSession(output: string): Map<string, SectionResult> {
  const sections = new Map<string, SectionResult>();
  let name: string | null = null;
  let lines: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith(`${MARK} `)) {
      if (name) lines.push(line);
      continue;
    }
    const [, first, code] = line.trimEnd().split(" ");
    if (first !== "status") {
      name = first;
      lines = [];
      continue;
    }
    const text = lines.join("\n").replace(/\n$/, "");
    if (name && text.length <= SECTION_LIMIT && /^\d+$/.test(code ?? "")) {
      sections.set(name, { code: Number(code), output: text });
    }
    name = null;
  }
  return sections;
}
