import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { AiProviderSettings } from "../AiProviderSettings";
import { aiApp } from "../app-ref";
import {
  AI_PROVIDERS_CHANGED_EVENT,
  AI_STATUS_CHANGED_EVENT,
  getAiProviders,
  getAiStatus,
  type AiProvider,
} from "../ai-api";

/**
 * The "providers" custom field in the plugin's user settings: a list with
 * per-provider forms, which a schema field cannot express.
 */
export function ProvidersSetting() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{
    globallyEnabled: boolean;
    enabled: boolean;
  } | null>(null);
  const [providers, setProviders] = useState<AiProvider[]>([]);

  const load = useCallback(async () => {
    try {
      const next = await getAiStatus();
      setProviders(next.enabled ? await getAiProviders() : []);
      setStatus(next);
    } catch {
      setStatus({ globallyEnabled: false, enabled: false });
    }
  }, []);

  useEffect(() => {
    void load();
    // Saving the "enabled" switch above this field is what opts in.
    const stop = aiApp().onSettingsChanged(() => void load());
    const events = [AI_STATUS_CHANGED_EVENT, AI_PROVIDERS_CHANGED_EVENT];
    for (const event of events) window.addEventListener(event, load);
    return () => {
      stop();
      for (const event of events) window.removeEventListener(event, load);
    };
  }, [load]);

  if (status === null) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-b border-border py-3 last:border-0">
      <span className="text-sm font-medium leading-snug">
        {t("settings.providers.label")}
      </span>
      <span className="text-xs leading-snug text-muted-foreground">
        {status.enabled
          ? t("settings.providers.description")
          : status.globallyEnabled
            ? t("settings.providersNeedOptIn")
            : t("settings.assistantUnavailable")}
      </span>
      {status.enabled && (
        <AiProviderSettings
          providers={providers}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
