import type { SettingsReader } from "../gating.js";

/** The admin's auto-ops guardrails, with the manifest's defaults. */
export interface TaskLimits {
  paused: boolean;
  runsPerHour: number;
  runTokens: number;
  dailyTokens: number;
}

export const TASK_DEFAULTS = {
  runsPerHour: 6,
  runTokens: 200_000,
  dailyTokens: 2_000_000,
};

/** How long a proposed plan waits for a decision. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export async function readTaskLimits(
  settings: SettingsReader,
): Promise<TaskLimits> {
  const read = async (key: string, fallback: number) => {
    const value = Number(await settings.get<number>(key));
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };
  return {
    paused: (await settings.get<boolean>("autoOpsPaused")) === true,
    runsPerHour: await read("autoOpsRunsPerHour", TASK_DEFAULTS.runsPerHour),
    runTokens: await read("autoOpsRunTokens", TASK_DEFAULTS.runTokens),
    dailyTokens: await read("autoOpsDailyTokens", TASK_DEFAULTS.dailyTokens),
  };
}

/** Midnight UTC today: daily budgets reset on the server's UTC day. */
export function startOfUtcDay(time: number): string {
  const day = new Date(time);
  day.setUTCHours(0, 0, 0, 0);
  return day.toISOString();
}

/** What a user picked for their tasks: provider, model and language. */
export interface TaskPreferences {
  providerId: number | null;
  model: string | null;
  language: string;
}

export const PREFERENCES_KEY = "autoOpsPreferences";

export async function readPreferences(
  settings: SettingsReader,
  userId: string,
): Promise<TaskPreferences> {
  const raw = await settings.getUser<unknown>(userId, PREFERENCES_KEY);
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const providerId = Number(value.providerId);
  return {
    providerId:
      Number.isInteger(providerId) && providerId > 0 ? providerId : null,
    model:
      typeof value.model === "string" && value.model.trim()
        ? value.model.trim()
        : null,
    language:
      typeof value.language === "string" && value.language.trim()
        ? value.language.trim()
        : "en",
  };
}
