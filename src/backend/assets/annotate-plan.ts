import { estimateTokens, type ContextPlan } from "../context-window.js";
import type { AssetSummary, Unit } from "./annotate-summary.js";
import type { EdgeRecord } from "./repository.js";

/**
 * Which units an annotation run sends, and in how many model calls.
 *
 * Incremental: an asset whose summary hash differs from the fingerprint of
 * its last annotation changed (or was never annotated, or was unlocked),
 * and so may its one-hop neighbours' view of it, so they go too. A unit
 * goes whole when any of its members does: the host and what runs on it
 * are read together.
 *
 * Batches are filled unit by unit up to a share of the context budget and
 * an asset count the reply can hold, so a call stays well under the window
 * whatever the provider.
 */

/** The share of the prompt budget a batch's summaries may take. */
const BATCH_SHARE = 0.4;
/** Never more than this per call, however large the window. */
const BATCH_TOKENS_MAX = 24_000;
/** Reply tokens one asset's annotation takes, about. */
const REPLY_TOKENS_PER_ASSET = 120;
const ASSETS_MIN = 4;
const ASSETS_MAX = 40;

export interface Batch {
  members: AssetSummary[];
  text: string;
  tokens: number;
}

export interface BatchLimits {
  tokens: number;
  assets: number;
}

export function batchLimits(
  plan: Pick<ContextPlan, "budget" | "reservedOutput">,
  overhead: number,
): BatchLimits {
  return {
    tokens: Math.max(
      1_000,
      Math.min(
        BATCH_TOKENS_MAX,
        Math.floor(plan.budget * BATCH_SHARE) - overhead,
      ),
    ),
    assets: Math.max(
      ASSETS_MIN,
      Math.min(
        ASSETS_MAX,
        Math.floor(plan.reservedOutput / REPLY_TOKENS_PER_ASSET),
      ),
    ),
  };
}

const changed = (member: AssetSummary) =>
  member.asset.annotationFingerprint !== member.fingerprint;

/** Units with a changed member or a neighbour of one; all with `all`. */
export function selectUnits(
  units: Unit[],
  edges: EdgeRecord[],
  all: boolean,
): Unit[] {
  if (all) return units;
  const dirty = new Set(
    units.flatMap((unit) =>
      unit.members.filter(changed).map((member) => member.asset.id),
    ),
  );
  const selected = new Set(dirty);
  for (const edge of edges) {
    if (dirty.has(edge.fromAsset)) selected.add(edge.toAsset);
    if (dirty.has(edge.toAsset)) selected.add(edge.fromAsset);
  }
  return units.filter((unit) =>
    unit.members.some((member) => selected.has(member.asset.id)),
  );
}

/**
 * Units packed into batches. A unit that does not fit what is left starts a
 * new batch; one too large for any batch is split by member, its host first.
 */
export function batchUnits(units: Unit[], limits: BatchLimits): Batch[] {
  const batches: Batch[] = [];
  let current: Batch = { members: [], text: "", tokens: 0 };
  const flush = () => {
    if (current.members.length) batches.push(current);
    current = { members: [], text: "", tokens: 0 };
  };
  const fits = (tokens: number, count: number) =>
    current.tokens + tokens <= limits.tokens &&
    current.members.length + count <= limits.assets;
  const add = (member: AssetSummary, tokens: number) => {
    current.members.push(member);
    current.text = current.text
      ? `${current.text}\n${member.text}`
      : member.text;
    current.tokens += tokens;
  };

  for (const unit of units) {
    if (!fits(unit.tokens, unit.members.length)) flush();
    for (const member of unit.members) {
      const tokens = estimateTokens(member.text);
      if (current.members.length && !fits(tokens, 1)) flush();
      add(member, tokens);
    }
  }
  flush();
  return batches;
}
