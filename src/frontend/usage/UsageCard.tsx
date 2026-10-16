import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { MiniStat } from "@termix-ssh/plugin-sdk/ui";
import { formatTokens } from "./format";
import { useCanViewAllUsage, useUsage } from "./UsageView";

/**
 * The dashboard card: today's and the last 30 days' tokens, the user's own
 * or, for someone who may see everyone's, the whole server's.
 */
export function UsageCard() {
  const { t } = useTranslation();
  const everyone = useCanViewAllUsage();
  const { usage, error } = useUsage(everyone ? "all" : "me");

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="grid grid-cols-2 gap-2">
        <MiniStat
          caption={t("usage.today")}
          value={usage ? formatTokens(usage.today.totalTokens) : "–"}
        />
        <MiniStat
          caption={t("usage.month")}
          value={usage ? formatTokens(usage.month.totalTokens) : "–"}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t(everyone ? "usage.everyoneCaption" : "usage.mineCaption")}
      </p>
    </div>
  );
}
