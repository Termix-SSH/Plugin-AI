import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { UsageView } from "../usage/UsageView";

/** The "usage" custom field in the plugin's user settings. */
export function UsageSetting() {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-b border-border py-3 last:border-0">
      <span className="text-sm font-medium leading-snug">
        {t("usage.title")}
      </span>
      <span className="text-xs leading-snug text-muted-foreground">
        {t("usage.settingDescription")}
      </span>
      <UsageView className="pt-2" />
    </div>
  );
}
