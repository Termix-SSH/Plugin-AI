import en from "../../../locales/en.json";
import zhCN from "../../../locales/translated/zh_CN.json";
import zhTW from "../../../locales/translated/zh_TW.json";
import { userLocale } from "../core-api.js";
import type { SettingsReader } from "../gating.js";
import { readPreferences } from "./limits.js";

/**
 * The owner's language, for what the server writes without a model: a
 * stopped run, an executed plan, an automation's name. The model writes its
 * own reports in the language named by languageName. Strings come from the
 * plugin's locales; languages without a copy here read English.
 */

type ReportKey = keyof typeof en.autoOps.report;

interface AutoOpsStrings {
  report?: Partial<Record<ReportKey, string>>;
  presets?: Record<string, { title?: string }>;
}

const STRINGS: Record<string, AutoOpsStrings> = {
  en: en.autoOps,
  zh_CN: zhCN.autoOps ?? {},
  zh_TW: zhTW.autoOps ?? {},
};

/**
 * The language the owner reads: their Termix UI language when core can say
 * (Termix 26.10.2+), else the one the AI tab saved for them, else English.
 */
export async function ownerLanguage(
  ctx: { settings: SettingsReader },
  userId: string,
): Promise<string> {
  return (
    (await userLocale(ctx, userId)) ??
    (await readPreferences(ctx.settings, userId)).language
  );
}

/** "zh-CN", "zh_cn" and "zh" all read as zh_CN. */
export function normalizeLanguage(raw: string): string {
  const [base, region] = raw.replace("-", "_").split("_");
  const language = (base ?? "").toLowerCase();
  if (language === "zh") {
    return ["TW", "HK", "MO", "HANT"].includes((region ?? "").toUpperCase())
      ? "zh_TW"
      : "zh_CN";
  }
  return region ? `${language}_${region.toUpperCase()}` : language || "en";
}

/** The language's English name, for the prompt. */
export function languageName(raw: string): string {
  const code = normalizeLanguage(raw);
  if (code === "zh_CN") return "Simplified Chinese";
  if (code === "zh_TW") return "Traditional Chinese";
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "language" }).of(
        code.replace("_", "-"),
      ) ?? "English"
    );
  } catch {
    return "English";
  }
}

/** A report string in the owner's language, {{name}} filled in. */
export function reportText(
  language: string,
  key: ReportKey,
  values: Record<string, string | number> = {},
): string {
  const table = STRINGS[normalizeLanguage(language)]?.report ?? {};
  const template = table[key] ?? en.autoOps.report[key];
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(values[name] ?? ""),
  );
}

/** A shipped preset's title in the owner's language, else English. */
export function presetTitle(language: string, presetId: string): string {
  const title = (table: AutoOpsStrings | undefined) =>
    table?.presets?.[presetId]?.title;
  return (
    title(STRINGS[normalizeLanguage(language)]) ?? title(STRINGS.en) ?? presetId
  );
}

/** The name of an automation made from a preset: "AI · Daily patrol". */
export function automationName(title: string): string {
  return `AI · ${title}`;
}
