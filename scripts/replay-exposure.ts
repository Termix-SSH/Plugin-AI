/** Read-only replay of an exported exposure inventory. Prints aggregate counts only. */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  compactEntries,
  internetRelevant,
  linkPaths,
} from "../src/backend/exposure/derive.js";
import type { Entry } from "../src/backend/exposure/types.js";
const path = process.argv[2];
if (!path)
  throw new Error("Pass the path to an exposure inventory JSON export");
const input = JSON.parse(readFileSync(path, "utf8"));
const entries: Entry[] = Array.isArray(input) ? input : input.entries;
if (!Array.isArray(entries)) throw new Error("Expected an entries array");
const start = performance.now();
const compact = compactEntries(entries),
  linked = linkPaths(compact),
  internet = linked.filter((e) => !e.resolvedAt && internetRelevant(e));
const counts = (rows: Entry[], field: "source" | "priority" | "pathStatus") =>
  Object.fromEntries(
    [...new Set(rows.map((e) => e[field]))].map((v) => [
      v,
      rows.filter((e) => e[field] === v).length,
    ]),
  );
console.log(
  JSON.stringify(
    {
      raw: entries.length,
      grouped: compact.length,
      internet: internet.length,
      priorities: counts(internet, "priority"),
      allPriorities: counts(linked, "priority"),
      internetSources: counts(internet, "source"),
      paths: counts(internet, "pathStatus"),
      multiHop: internet.filter((e) => e.paths?.some((p) => p.hops.length > 1))
        .length,
      caddyRules: compact.filter((e) => e.source === "caddy").length,
      wanHttps: internet
        .filter((e) => e.source === "uci" && e.endpoint.port === 443)
        .map((e) => ({
          status: e.pathStatus,
          branches: e.paths?.length,
          longestPath: Math.max(...(e.paths ?? []).map((p) => p.hops.length)),
          sources: [
            ...new Set(
              (e.paths ?? []).flatMap((p) => p.hops.map((h) => h.source)),
            ),
          ],
        })),
      wanDatabase: internet
        .filter((e) => e.source === "uci" && e.backend?.port === 5432)
        .map((e) => ({ priority: e.priority, reasons: e.priorityReasons })),
      milliseconds: Math.round(performance.now() - start),
    },
    null,
    2,
  ),
);
