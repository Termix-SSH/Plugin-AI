import { useEffect } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { savePreferences } from "./api";

/**
 * Saves the interface language as the one auto-ops reports are written in.
 * Core keeps a user's language where a plugin's backend cannot read it, so
 * every AI view writes it to the task preferences when it opens.
 */
export function useReportLanguage(): void {
  const { language } = useTranslation();
  useEffect(() => {
    if (language) savePreferences({ language }).catch(() => undefined);
  }, [language]);
}
