import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createAiGate } from "./gating.js";
import type { AiRepository, UsageRow } from "./repository.js";

/**
 * Token usage summed up for the usage view: totals for today, 7 and 30 days,
 * then per day, per model and, for an admin, per user over the 30 days. Days
 * are the viewer's own, from the offset their browser sends.
 */

export const USAGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  /** Some of it was estimated because the provider reported nothing. */
  estimated: boolean;
}

export interface UsageSummary {
  today: UsageTotals;
  week: UsageTotals;
  month: UsageTotals;
  /** Oldest first, every day of the 30 present even when it is empty. */
  byDay: Array<{ day: string } & UsageTotals>;
  /** Largest first. */
  byModel: Array<{ model: string } & UsageTotals>;
  bySource: Array<{ source: string } & UsageTotals>;
  byUser?: Array<{ userId: string } & UsageTotals>;
}

const empty = (): UsageTotals => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  calls: 0,
  estimated: false,
});

function add(totals: UsageTotals, row: UsageRow): void {
  totals.promptTokens += row.promptTokens;
  totals.completionTokens += row.completionTokens;
  totals.totalTokens += row.promptTokens + row.completionTokens;
  totals.calls += 1;
  totals.estimated ||= Boolean(row.estimated);
}

/** The local calendar day of `time`, given the browser's offset in minutes. */
function localDay(time: number, offsetMinutes: number): string {
  return new Date(time - offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** The earliest instant any row of the summary can be from. */
export function usageWindowStart(now: number): string {
  // A day of slack covers any time zone; rows outside the 30 local days are
  // dropped while summing.
  return new Date(now - (USAGE_DAYS + 1) * DAY_MS).toISOString();
}

function grouped<K extends string>(
  rows: UsageRow[],
  key: (row: UsageRow) => string,
  name: K,
) {
  const groups = new Map<string, UsageTotals>();
  for (const row of rows) {
    const id = key(row);
    if (!groups.has(id)) groups.set(id, empty());
    add(groups.get(id)!, row);
  }
  return [...groups]
    .map(([id, totals]) => ({ [name]: id, ...totals }))
    .sort((a, b) => b.totalTokens - a.totalTokens) as Array<
    Record<K, string> & UsageTotals
  >;
}

export function summarizeUsage(
  rows: UsageRow[],
  options: { now: number; offsetMinutes: number; byUser: boolean },
): UsageSummary {
  const { now, offsetMinutes } = options;
  const days = Array.from({ length: USAGE_DAYS }, (_, index) =>
    localDay(now - (USAGE_DAYS - 1 - index) * DAY_MS, offsetMinutes),
  );
  const perDay = new Map(days.map((day) => [day, empty()]));
  const inRange: UsageRow[] = [];
  const today = empty();
  const week = empty();
  const month = empty();
  const weekStart = days[USAGE_DAYS - 7];

  for (const row of rows) {
    const day = localDay(Date.parse(row.createdAt), offsetMinutes);
    const bucket = perDay.get(day);
    if (!bucket) continue;
    inRange.push(row);
    add(bucket, row);
    add(month, row);
    if (day >= weekStart) add(week, row);
    if (day === days[USAGE_DAYS - 1]) add(today, row);
  }

  return {
    today,
    week,
    month,
    byDay: days.map((day) => ({ day, ...perDay.get(day)! })),
    byModel: grouped(inRange, (row) => row.model, "model"),
    bySource: grouped(inRange, (row) => row.source, "source"),
    ...(options.byUser
      ? { byUser: grouped(inRange, (row) => row.userId, "userId") }
      : {}),
  };
}

/**
 * GET /usage: the acting user's own usage, or with scope=all everyone's,
 * which needs ai.usage.view_all. offset is the browser's
 * Date.getTimezoneOffset(), so "today" is the viewer's today.
 */
export function registerUsageRoutes(
  router: Router,
  repository: AiRepository,
  ctx: PluginContext,
): void {
  const gate = createAiGate(ctx.settings, () => ctx.currentActor());

  /**
   * @openapi
   * /plugin-api/ai/usage:
   *   get:
   *     summary: Token usage, for the current user or everyone
   *     description: >
   *       Totals for today, 7 and 30 days, then per day, per model and per
   *       feature over 30 days. scope=all covers every user and adds a per
   *       user breakdown; it needs ai.usage.view_all. offset is the
   *       browser's time zone offset in minutes, as getTimezoneOffset gives
   *       it, so days are the viewer's own.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: query
   *         name: scope
   *         schema:
   *           type: string
   *           enum: [me, all]
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The usage summary.
   *       403:
   *         description: >
   *           Missing ai.use, scope=all without ai.usage.view_all, or the
   *           assistant is off.
   */
  router.get(
    "/usage",
    ctx.rbac.require("use") as never,
    gate as never,
    async (req: Request, res: Response) => {
      const everyone = req.query.scope === "all";
      if (everyone && !(await ctx.rbac.has("usage.view_all"))) {
        return res.status(403).json({
          error: "Usage for every user needs the ai.usage.view_all permission",
        });
      }
      const offset = Number(req.query.offset);
      const now = Date.now();
      try {
        const rows = await repository.usageSince(
          usageWindowStart(now),
          everyone ? null : (ctx.currentActor() as string),
        );
        res.json({
          scope: everyone ? "all" : "me",
          ...summarizeUsage(rows, {
            now,
            offsetMinutes:
              Number.isFinite(offset) && Math.abs(offset) <= 14 * 60
                ? offset
                : 0,
            byUser: everyone,
          }),
        });
      } catch (err) {
        ctx.log.error(
          "Failed to read AI usage",
          err instanceof Error ? err : new Error(String(err)),
        );
        res.status(500).json({ error: "Failed to read usage" });
      }
    },
  );
}
