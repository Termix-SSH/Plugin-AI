import type { PluginHostSummary } from "@termix-ssh/plugin-sdk/backend";

/**
 * The host fields a model may see. Tools project explicit fields rather than
 * spreading rows. Redaction runs
 * afterwards as a second line of defense, but the projection here is the
 * primary control: a field that is never selected cannot leak.
 */

function splitTags(tags: string | null): string[] {
  if (!tags) return [];
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function toHostSummary(host: PluginHostSummary) {
  return {
    id: host.id,
    name: host.name ?? null,
    ip: host.ip,
    port: host.port,
    username: host.username,
    folder: host.folder ?? null,
    tags: splitTags(host.tags),
    authType: host.authType,
  };
}
