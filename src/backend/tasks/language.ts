import en from "../../../locales/en.json";
import zhCN from "../../../locales/translated/zh_CN.json";
import zhTW from "../../../locales/translated/zh_TW.json";

/**
 * The owner's language, for the reports the server writes without a model:
 * a stopped run, an executed plan. The model writes its own reports in the
 * language named by languageName. Strings come from the plugin's locales;
 * languages without a copy here read English.
 */

type ReportKey = keyof typeof en.autoOps.report;

const REPORT_STRINGS: Record<string, Partial<Record<ReportKey, string>>> = {
  en: en.autoOps.report,
  zh_CN: zhCN.autoOps?.report ?? {},
  zh_TW: zhTW.autoOps?.report ?? {},
};

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
  const table = REPORT_STRINGS[normalizeLanguage(language)] ?? {};
  const template = table[key] ?? en.autoOps.report[key];
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(values[name] ?? ""),
  );
}
