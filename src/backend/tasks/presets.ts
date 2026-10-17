import certExpiryWeekly from "../../../presets/cert-expiry-weekly.json";
import containerAnomaly from "../../../presets/container-anomaly.json";
import dailyPatrol from "../../../presets/daily-patrol.json";
import diskCleanup from "../../../presets/disk-cleanup.json";
import hostDownTriage from "../../../presets/host-down-triage.json";
import resourceOverloadCpu from "../../../presets/resource-overload-cpu.json";
import resourceOverloadMemory from "../../../presets/resource-overload-memory.json";
import securityUpdatesWeekly from "../../../presets/security-updates-weekly.json";
import serviceFailure from "../../../presets/service-failure.json";
import type { Autonomy } from "./types.js";

/**
 * Presets ship as JSON next to the plugin and are bundled from here, so a
 * plain build carries them. Titles and descriptions are locale keys
 * (autoOps.presets.<id>); runbooks stay English for the model.
 */

export interface PresetConfig {
  autonomy: Autonomy;
  /** An Automations trigger, as its src/types.ts defines it. */
  trigger: Record<string, unknown> & { kind: string };
  /** Which hosts the ai_task step runs on, an Automations HostSelector. */
  hostSelector: Record<string, unknown> & { kind: string };
  concurrencyPolicy: "skip";
  maxRunSeconds: number;
  runbook: string;
}

export interface PresetDefinition extends PresetConfig {
  id: string;
  version: number;
}

export const PRESETS = [
  dailyPatrol,
  diskCleanup,
  hostDownTriage,
  serviceFailure,
  containerAnomaly,
  resourceOverloadCpu,
  resourceOverloadMemory,
  securityUpdatesWeekly,
  certExpiryWeekly,
] as PresetDefinition[];

export function findPreset(id: string): PresetDefinition | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/** Selectors a step may use; "trigger" only after a host-scoped trigger. */
const SELECTOR_KINDS = ["all", "host", "hosts", "fleet", "trigger"];
const HOST_TRIGGERS = [
  "metric_threshold",
  "host_status",
  "health_check",
  "docker_event",
];
const MAX_RUNBOOK = 20_000;
const MAX_RUN_SECONDS = 3600;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * A preset's config with the user's changes from the enable form, or why
 * they cannot be used. The trigger keeps the preset's kind; Automations
 * validates the rest of it when the automation is created.
 */
export function applyOverrides(
  base: PresetConfig,
  raw: unknown,
): { config: PresetConfig } | { error: string } {
  const changes = isObject(raw) ? raw : {};
  const trigger = isObject(changes.trigger)
    ? { ...base.trigger, ...changes.trigger, kind: base.trigger.kind }
    : base.trigger;
  if (trigger.kind === "webhook") {
    return { error: "Webhook triggers are set up in Automations" };
  }
  const hostSelector = isObject(changes.hostSelector)
    ? (changes.hostSelector as PresetConfig["hostSelector"])
    : base.hostSelector;
  if (!SELECTOR_KINDS.includes(String(hostSelector.kind))) {
    return { error: "hostSelector is not a host selector" };
  }
  if (
    hostSelector.kind === "trigger" &&
    !HOST_TRIGGERS.includes(trigger.kind)
  ) {
    return { error: "This trigger has no host to target" };
  }
  const autonomy = changes.autonomy ?? base.autonomy;
  if (autonomy !== "report" && autonomy !== "propose") {
    return { error: "autonomy must be report or propose" };
  }
  const runbook =
    typeof changes.runbook === "string" ? changes.runbook.trim() : base.runbook;
  if (!runbook || runbook.length > MAX_RUNBOOK) {
    return { error: `The runbook must be 1 to ${MAX_RUNBOOK} characters` };
  }
  const seconds = Number(changes.maxRunSeconds ?? base.maxRunSeconds);
  const maxRunSeconds =
    Number.isFinite(seconds) && seconds >= 60
      ? Math.min(Math.floor(seconds), MAX_RUN_SECONDS)
      : base.maxRunSeconds;
  return {
    config: {
      autonomy,
      trigger,
      hostSelector,
      concurrencyPolicy: "skip",
      maxRunSeconds,
      runbook,
    },
  };
}

/** The automation a preset becomes: its trigger and one ai_task step. */
export function automationDefinition(
  config: PresetConfig,
  presetId: string,
  title: string,
) {
  return {
    version: 1,
    trigger: config.trigger,
    steps: [
      {
        id: "ai-task",
        type: "ai_task",
        runbook: config.runbook,
        autonomy: config.autonomy,
        hostSelector: config.hostSelector,
        presetId,
        title,
      },
    ],
  };
}

/** A saved preset's config, read leniently, or null when it is unusable. */
export function parseSavedConfig(raw: unknown): PresetConfig | null {
  if (!isObject(raw) || !isObject(raw.trigger) || !isObject(raw.hostSelector)) {
    return null;
  }
  const result = applyOverrides(
    {
      autonomy: raw.autonomy === "propose" ? "propose" : "report",
      trigger: raw.trigger as PresetConfig["trigger"],
      hostSelector: raw.hostSelector as PresetConfig["hostSelector"],
      concurrencyPolicy: "skip",
      maxRunSeconds: Number(raw.maxRunSeconds) || 900,
      runbook: typeof raw.runbook === "string" ? raw.runbook : "",
    },
    {},
  );
  return "config" in result ? result.config : null;
}
