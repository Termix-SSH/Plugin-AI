import { objectSchema, type AiTool } from "../tools/types.js";
import {
  IMPORTANCES,
  type AnnotationWrite,
  type AssetRecord,
  type EdgeRecord,
  type Importance,
} from "./repository.js";

/**
 * The submit_annotations tool and the checks its input goes through.
 *
 * The model's word is taken for what an asset is, never for what talks to
 * what: a depends_on suggestion has to name a fact the collector saw, and
 * that fact is looked up. A connects_to between the two (or the hosts they
 * run on), a container port the other side connects to, or a runs_on.
 * Anything else, an unknown key or a dependency of an asset outside the
 * batch is rejected, with the reason sent back to the model.
 */

export const EVIDENCE_TYPES = [
  "connects_to",
  "port_mapping",
  "runs_on",
] as const;
type EvidenceType = (typeof EVIDENCE_TYPES)[number];

const ROLE_MAX = 160;
const REASON_MAX = 300;
const SYSTEM_MAX = 120;
const EVIDENCE_MAX = 300;

export interface DependsOn {
  from: AssetRecord;
  to: AssetRecord;
  evidence: string;
}

export interface Submission {
  annotations: Map<string, AnnotationWrite>;
  dependsOn: DependsOn[];
  errors: string[];
}

export interface SubmissionScope {
  /** Keys of the batch: the only ones that may be annotated. */
  batch: Set<string>;
  /** Every live asset by key; external ones are never valid. */
  known: Map<string, AssetRecord>;
  /** The collector's edges, the facts a suggestion may cite. */
  edges: EdgeRecord[];
}

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function parseAnnotation(
  entry: unknown,
  batch: Set<string>,
): { key: string; write: AnnotationWrite } | { error: string } {
  if (!isObject(entry)) return { error: "an annotation must be an object" };
  const key = text(entry.key, 300);
  if (!batch.has(key))
    return { error: `${key || "?"}: not an asset of this batch` };
  const role = text(entry.role, ROLE_MAX);
  if (!role) return { error: `${key}: role is required` };
  const importance = entry.importance as Importance;
  if (!IMPORTANCES.includes(importance)) {
    return {
      error: `${key}: importance must be one of ${IMPORTANCES.join(", ")}`,
    };
  }
  const system = text(entry.system, SYSTEM_MAX);
  return {
    key,
    write: {
      role,
      importance,
      importanceReason: text(entry.importanceReason, REASON_MAX) || null,
      system: system && system.toLowerCase() !== "null" ? system : null,
    },
  };
}

/** The host an asset runs on, by the collector's runs_on, else itself. */
function hostOf(asset: AssetRecord, scope: SubmissionScope): number {
  const edge = scope.edges.find(
    (entry) => entry.fromAsset === asset.id && entry.type === "runs_on",
  );
  return asset.kind === "container" && edge ? edge.toAsset : asset.id;
}

/** connects_to edges from `from` (or its host) to any of `targets`. */
function connections(
  from: AssetRecord,
  targets: number[],
  scope: SubmissionScope,
): EdgeRecord[] {
  const sources = [from.id, hostOf(from, scope)];
  return scope.edges.filter(
    (edge) =>
      edge.type === "connects_to" &&
      sources.includes(edge.fromAsset) &&
      targets.includes(edge.toAsset),
  );
}

const edgePorts = (edge: EdgeRecord) =>
  (edge.detail?.ports as number[] | undefined) ?? [];

/** Host ports a container publishes, from docker's "0.0.0.0:8080->80/tcp". */
export function publishedPorts(asset: AssetRecord): number[] {
  const ports =
    (asset.facts as { container?: { ports?: string } } | null)?.container
      ?.ports ?? "";
  return [...ports.matchAll(/:(\d+)->/g)].map((match) => Number(match[1]));
}

/** Null when the cited fact holds, else why not. */
function checkEvidence(
  type: EvidenceType,
  port: number | null,
  from: AssetRecord,
  to: AssetRecord,
  scope: SubmissionScope,
): string | null {
  if (type === "runs_on") {
    const found = scope.edges.some(
      (edge) =>
        edge.type === "runs_on" &&
        edge.fromAsset === from.id &&
        edge.toAsset === to.id,
    );
    return found ? null : "no runs_on between them was observed";
  }
  if (type === "port_mapping") {
    if (to.kind !== "container") return "port_mapping needs a container as to";
    if (port === null || !publishedPorts(to).includes(port)) {
      return `${to.key} publishes no port ${port ?? "?"}`;
    }
    const seen = connections(from, [hostOf(to, scope)], scope).some((edge) =>
      edgePorts(edge).includes(port),
    );
    return seen
      ? null
      : `no connection to port ${port} of its host was observed`;
  }
  const seen = connections(from, [to.id, hostOf(to, scope)], scope).filter(
    (edge) => port === null || edgePorts(edge).includes(port),
  );
  return seen.length ? null : "no such connects_to was observed";
}

function parseDependsOn(
  entry: unknown,
  scope: SubmissionScope,
): DependsOn | { error: string } {
  if (!isObject(entry))
    return { error: "a depends_on entry must be an object" };
  const fromKey = text(entry.from, 300);
  const toKey = text(entry.to, 300);
  const label = `depends_on ${fromKey || "?"} -> ${toKey || "?"}`;
  const from = scope.known.get(fromKey);
  const to = scope.known.get(toKey);
  if (!from || !to || from.kind === "external" || to.kind === "external") {
    return { error: `${label}: unknown key` };
  }
  if (from.id === to.id)
    return { error: `${label}: an asset cannot depend on itself` };
  if (!scope.batch.has(fromKey)) {
    return { error: `${label}: from must be an asset of this batch` };
  }
  const evidence = isObject(entry.evidence) ? entry.evidence : {};
  const type = evidence.type as EvidenceType;
  const fact = text(evidence.fact, EVIDENCE_MAX);
  if (!EVIDENCE_TYPES.includes(type) || !fact) {
    return {
      error: `${label}: evidence needs a type (${EVIDENCE_TYPES.join(", ")}) and the fact it cites`,
    };
  }
  const rawPort = Number(evidence.port);
  const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : null;
  const problem = checkEvidence(type, port, from, to, scope);
  if (problem) return { error: `${label}: ${problem}` };
  return {
    from,
    to,
    evidence: `${type}${port ? ` ${port}` : ""}: ${fact}`,
  };
}

/**
 * The spelling already in the inventory for `name`, ignoring case, spaces,
 * hyphens and underscores, or `name` itself. Batches are annotated one
 * after another, so without this one system came back as "OpenXDR" in one
 * batch and "openxdr" in the next.
 */
export function canonicalSystem(name: string, known: string[]): string {
  const norm = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, "");
  return known.find((existing) => norm(existing) === norm(name)) ?? name;
}

/** What a submit_annotations call holds once checked. */
export function validateSubmission(
  args: Record<string, unknown>,
  scope: SubmissionScope,
): Submission {
  const result: Submission = {
    annotations: new Map(),
    dependsOn: [],
    errors: [],
  };
  const annotations = Array.isArray(args.annotations) ? args.annotations : [];
  for (const entry of annotations) {
    const parsed = parseAnnotation(entry, scope.batch);
    if ("error" in parsed) result.errors.push(parsed.error);
    else result.annotations.set(parsed.key, parsed.write);
  }
  const suggestions = Array.isArray(args.depends_on) ? args.depends_on : [];
  for (const entry of suggestions) {
    const parsed = parseDependsOn(entry, scope);
    if ("error" in parsed) result.errors.push(parsed.error);
    else result.dependsOn.push(parsed);
  }
  return result;
}

const str = (description: string) => ({ type: "string", description });

/**
 * The tool, handing each checked call to `onSubmit`, which answers with
 * what the model is told back.
 */
export function submitAnnotationsTool(
  onSubmit: (args: Record<string, unknown>) => unknown,
): AiTool {
  return {
    name: "submit_annotations",
    description:
      "Hand in the annotations for every asset of the batch, and any depends_on relations the facts show. Call it once.",
    category: "read",
    parameters: objectSchema(
      {
        annotations: {
          type: "array",
          items: objectSchema(
            {
              key: str("The asset key, exactly as given in brackets"),
              role: str("What it does, a short phrase"),
              importance: {
                type: "string",
                enum: IMPORTANCES,
                description: "By blast radius: what stops working if it fails",
              },
              importanceReason: str("One sentence: who or what depends on it"),
              system: str(
                "The business system or product it belongs to; empty when it serves the infrastructure as a whole or you cannot tell",
              ),
            },
            ["key", "role", "importance", "importanceReason"],
          ),
        },
        depends_on: {
          type: "array",
          description: "Optional: from depends on to, each with evidence.",
          items: objectSchema(
            {
              from: str("Key of the dependent asset, one of this batch"),
              to: str("Key of the asset it depends on"),
              evidence: objectSchema(
                {
                  type: {
                    type: "string",
                    enum: [...EVIDENCE_TYPES],
                    description:
                      "connects_to: a connection from `from` (or its host) to `to` (or its host); port_mapping: `to` is a container publishing the port `from` connects to; runs_on: `from` runs on `to`",
                  },
                  port: {
                    type: "integer",
                    description: "The port, for connects_to and port_mapping",
                  },
                  fact: str("The observed fact, quoted from the summary"),
                },
                ["type", "fact"],
              ),
            },
            ["from", "to", "evidence"],
          ),
        },
      },
      ["annotations"],
    ),
    handler: async (args) => onSubmit(args),
  };
}
