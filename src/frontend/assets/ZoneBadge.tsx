import { useCallback } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { ListBadge } from "@termix-ssh/plugin-sdk/ui";
import type { AssetItem, ZoneKind, ZoneRule } from "./api";

const ZONE_TONES: Record<
  ZoneKind,
  "destructive" | "warning" | "brand" | "muted" | "success"
> = {
  external: "destructive",
  dmz: "warning",
  cloud: "brand",
  overlay: "muted",
  internal: "success",
};

/** Zone names the plugin owns are translated; a rule's name is the user's. */
export function useZoneLabel(rules: ZoneRule[]) {
  const { t } = useTranslation();
  return useCallback(
    (zone: string) =>
      rules.some((rule) => rule.name === zone)
        ? zone
        : t(`assets.zone.${zone}`, { defaultValue: zone }),
    [rules, t],
  );
}

export function ZoneBadge({
  asset,
  rules,
}: {
  asset: Pick<AssetItem, "zone" | "zoneSource" | "multiZone">;
  rules: ZoneRule[];
}) {
  const { t } = useTranslation();
  const label = useZoneLabel(rules);
  if (!asset.zone) return <span className="text-muted-foreground">-</span>;
  const kind = (rules.find((rule) => rule.name === asset.zone)?.kind ??
    asset.zone) as ZoneKind;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <ListBadge tone={ZONE_TONES[kind] ?? "muted"}>
        {label(asset.zone)}
      </ListBadge>
      {asset.multiZone && (
        <span title={t("assets.multiZoneHint")}>
          <ListBadge tone="warning">{t("assets.multiZone")}</ListBadge>
        </span>
      )}
      {asset.zoneSource === "user" && (
        <ListBadge tone="muted">{t("assets.pinned")}</ListBadge>
      )}
    </span>
  );
}
