import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { BarSeries, MiniStat, Segmented } from "@termix-ssh/plugin-sdk/ui";
import { getAiUsage, type UsageSummary, type UsageTotals } from "../ai-api";
import { aiApp } from "../app-ref";
import { getErrorMessage } from "../errors";
import { formatTokens } from "./format";

/** Days shown in the per-day list; the totals cover all 30. */
const DAYS_SHOWN = 14;

type Scope = "me" | "all";

/** Whether the user may see everyone's usage. */
export function useCanViewAllUsage(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let live = true;
    aiApp()
      .hasPermission("usage.view_all")
      .then((value) => live && setAllowed(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return allowed;
}

/** The usage summary for `scope`, reloaded when it changes. */
export function useUsage(scope: Scope) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    getAiUsage(scope)
      .then((next) => live && setUsage(next))
      .catch(
        (err) => live && setError(getErrorMessage(err, t("usage.loadFailed"))),
      );
    return () => {
      live = false;
    };
  }, [scope, t]);
  return { usage, error };
}

function UsageTable<K extends string>({
  rows,
  name,
  heading,
  label = (value) => value,
}: {
  rows: Array<Record<K, string> & UsageTotals>;
  name: K;
  heading: string;
  label?: (value: string) => string;
}) {
  const { t } = useTranslation();
  if (!rows.length) return null;
  return (
    <table className="w-full text-xs">
      <thead className="text-left text-muted-foreground">
        <tr className="border-b border-border">
          <th className="py-1 pr-2 font-normal">{heading}</th>
          <th className="py-1 pr-2 text-right font-normal">
            {t("usage.calls")}
          </th>
          <th className="py-1 pr-2 text-right font-normal">
            {t("usage.prompt")}
          </th>
          <th className="py-1 pr-2 text-right font-normal">
            {t("usage.completion")}
          </th>
          <th className="py-1 text-right font-normal">{t("usage.total")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row[name]} className="border-b border-border/50">
            <td className="max-w-40 truncate py-1 pr-2" title={row[name]}>
              {label(row[name])}
            </td>
            <td className="py-1 pr-2 text-right tabular-nums">{row.calls}</td>
            <td className="py-1 pr-2 text-right tabular-nums">
              {formatTokens(row.promptTokens)}
            </td>
            <td className="py-1 pr-2 text-right tabular-nums">
              {formatTokens(row.completionTokens)}
            </td>
            <td className="py-1 text-right font-medium tabular-nums">
              {formatTokens(row.totalTokens)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Tokens used over the last 30 days: totals, per day, per model and per
 * feature, and per user for someone who may see everyone's.
 */
export function UsageView({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const canViewAll = useCanViewAllUsage();
  const [scope, setScope] = useState<Scope>("me");
  const { usage, error } = useUsage(scope);

  const days = usage?.byDay.slice(-DAYS_SHOWN).reverse() ?? [];

  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      {canViewAll && (
        <Segmented<Scope>
          value={scope}
          onChange={setScope}
          options={[
            { value: "me", label: t("usage.mine") },
            { value: "all", label: t("usage.everyone") },
          ]}
        />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {usage && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <MiniStat
              caption={t("usage.today")}
              value={formatTokens(usage.today.totalTokens)}
            />
            <MiniStat
              caption={t("usage.week")}
              value={formatTokens(usage.week.totalTokens)}
            />
            <MiniStat
              caption={t("usage.month")}
              value={formatTokens(usage.month.totalTokens)}
            />
          </div>
          {usage.month.calls === 0 ? (
            <p className="text-xs text-muted-foreground">{t("usage.empty")}</p>
          ) : (
            <>
              <Section title={t("usage.byDay")}>
                <BarSeries
                  items={days.map((day) => ({
                    label: day.day.slice(5),
                    value: day.totalTokens,
                    valueLabel: formatTokens(day.totalTokens),
                  }))}
                />
              </Section>
              <Section title={t("usage.byModel")}>
                <UsageTable
                  rows={usage.byModel}
                  name="model"
                  heading={t("usage.model")}
                />
              </Section>
              <Section title={t("usage.bySource")}>
                <UsageTable
                  rows={usage.bySource}
                  name="source"
                  heading={t("usage.feature")}
                  label={(source) =>
                    t(`usage.source.${source}`, { defaultValue: source })
                  }
                />
              </Section>
              {usage.byUser && (
                <Section title={t("usage.byUser")}>
                  <UsageTable
                    rows={usage.byUser}
                    name="userId"
                    heading={t("usage.user")}
                  />
                </Section>
              )}
              {usage.month.estimated && (
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t("usage.estimatedNote")}
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
