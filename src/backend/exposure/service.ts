import { PORTABLE, parsePortable, type PortableSource } from "./portable.js";
import { isAiGloballyEnabled, resolveAiAccess } from "../gating.js";
import { ownerLanguage } from "../tasks/language.js";
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { AssetRepository } from "../assets/repository.js";
import type { HostOutcome } from "../assets/persist.js";
import { execOnHost, mapLimit } from "../ops/exec.js";
import { exposureScript, unavailableSecureObservations } from "./collector.js";
import {
  PYTHON,
  QUICK_OUTPUT_LIMIT,
  QUICK_TIMEOUT_MS,
  SECTION_LIMIT,
  quickScript,
  splitSession,
} from "./session.js";
import {
  bindCurrentHosts,
  decodeObservations,
  deriveEntries,
  fingerprint,
  entryIdentity,
  linkPaths,
} from "./derive.js";
import type { ExposureRepository } from "./repository.js";
import type { Entry } from "./types.js";
export async function visibleHosts(ctx: PluginContext): Promise<Set<number>> {
  const visible = new Set<number>();
  for (const host of await ctx.hosts.list()) {
    if ((await ctx.hosts.checkAccess(host.id, "connect")).hasAccess)
      visible.add(host.id);
  }
  return visible;
}
export const canSee = (entry: Entry, hosts: Set<number>) =>
  entry.requiredHostIds.every((id) => hosts.has(id));
export function createExposureService(
  ctx: PluginContext,
  repo: ExposureRepository,
  assets: AssetRepository,
) {
  let controller = new AbortController();
  let closed = false;
  ctx.settings.onChange("globallyEnabled", (value) => {
    if (value !== true) controller.abort();
  });
  let notifying = false;
  let collecting = false;
  return {
    close: () => {
      closed = true;
      controller.abort();
    },
    async collect(outcomes: HostOutcome[], ownerId: string) {
      if (closed || !(await isAiGloballyEnabled(ctx.settings))) return;
      controller = new AbortController();
      const batchId = randomUUID();
      collecting = true;
      try {
        await ctx.asUser(ownerId, async () => {
          if (!(await ctx.rbac.has("assets.manage"))) return;
          const inventory = await assets.listAssets();
          await mapLimit(outcomes, 4, controller.signal, async (outcome) => {
            const host = inventory.find(
              (a) => a.hostId === outcome.hostId && a.kind === "host",
            );
            if (!host) return;
            let raw = "";
            const metadata = new Map<
              string,
              ReturnType<typeof parsePortable>
            >();
            const access = await ctx.hosts.checkAccess(
              outcome.hostId,
              "connect",
            );
            if (
              outcome.facts &&
              access.hasAccess &&
              !controller.signal.aborted
            ) {
              const result = await execOnHost(
                ctx,
                outcome.hostId,
                quickScript(),
                {
                  timeoutMs: QUICK_TIMEOUT_MS,
                  outputLimit: QUICK_OUTPUT_LIMIT,
                  signal: controller.signal,
                },
              );
              const sections =
                result.error || result.aborted
                  ? new Map()
                  : splitSession(result.output);
              for (const source of Object.keys(PORTABLE) as PortableSource[]) {
                const part = sections.get(source);
                metadata.set(
                  source,
                  part?.code === 0
                    ? parsePortable(source, part.output)
                    : {
                        source,
                        status: part?.code === 127 ? "unsupported" : "failed",
                        complete: false,
                        records: [],
                      },
                );
              }
              // python3 missing: its sources are unsupported, not failed.
              const python = sections.get(PYTHON);
              if (python && python.code !== 0) {
                raw = unavailableSecureObservations();
              } else if (python && !controller.signal.aborted) {
                const secure = await execOnHost(
                  ctx,
                  outcome.hostId,
                  exposureScript(),
                  {
                    timeoutMs: 60000,
                    outputLimit: SECTION_LIMIT,
                    signal: controller.signal,
                  },
                );
                if (!secure.error && !secure.timedOut && secure.exitCode === 0)
                  raw = secure.output;
              }
            }
            const stillAllowed = (
              await ctx.hosts.checkAccess(outcome.hostId, "connect")
            ).hasAccess;
            if (!stillAllowed || controller.signal.aborted) raw = "";
            const observations = decodeObservations(
              JSON.stringify(
                decodeObservations(raw).map((o) =>
                  stillAllowed && !controller.signal.aborted
                    ? (metadata.get(o.source) ?? o)
                    : o,
                ),
              ),
            );
            for (const observation of observations) {
              if (!stillAllowed || !access.hasAccess)
                observation.status = "denied";
              const interfaces = (host.facts?.interfaces ?? []) as Array<{
                addrs: string[];
              }>;
              if (
                outcome.complete === false ||
                (observation.records.some((r) =>
                  ["0.0.0.0", "::", "*"].includes(r.endpoint.address),
                ) &&
                  !interfaces.some((i) => i.addrs.length))
              )
                observation.complete = false;
              const at = new Date().toISOString(),
                id = randomUUID();
              const entries = deriveEntries(observation, {
                host,
                assets: inventory,
                ownerId,
                observationId: id,
                at,
              });
              await repo.apply(
                {
                  ...observation,
                  id,
                  at,
                  batchId,
                  hostId: outcome.hostId,
                  ownerId,
                },
                entries,
              );
            }
          });
        });
      } finally {
        collecting = false;
      }
    },
    async notify() {
      if (notifying || collecting || controller.signal.aborted) return;
      if (!(await isAiGloballyEnabled(ctx.settings))) return;
      notifying = true;
      try {
        const inventory = await assets.listAssets();
        const entries = linkPaths(
          bindCurrentHosts(await repo.listEntries(), inventory),
        );
        const groups = new Map<
          string,
          Awaited<ReturnType<ExposureRepository["listChanges"]>>
        >();
        for (const change of (await repo.listChanges()).filter(
          (c) => c.noticeStatus === "pending",
        )) {
          const key = `${change.ownerId}:${change.batchId ?? change.id}`;
          groups.set(key, [...(groups.get(key) ?? []), change]);
        }
        for (const [key, group] of groups) {
          await ctx.asUser(group[0].ownerId, async () => {
            const hosts = await visibleHosts(ctx);
            const permitted =
              (await ctx.rbac.has("assets.view")) &&
              (await resolveAiAccess(ctx.settings, group[0].ownerId)).enabled;
            const visible = group.filter((change) => {
              const stored = change.after ?? change.before;
              const entry = stored
                ? bindCurrentHosts([stored], inventory)[0]
                : null;
              const linked = entry
                ? entries.find((e) => e.key === entryIdentity(entry))
                : null;
              return (
                permitted &&
                hosts.has(change.hostId) &&
                (!entry || canSee(entry, hosts)) &&
                (!linked || canSee(linked, hosts))
              );
            });
            const denied = group.filter((c) => !visible.includes(c));
            if (denied.length)
              await repo.noticeMany(
                denied.map((c) => c.id),
                "withheld",
              );
            if (!visible.length) return;
            try {
              const language = await ownerLanguage(ctx, group[0].ownerId);
              const hostCount = new Set(visible.map((c) => c.hostId)).size;
              const title =
                language === "zh_CN"
                  ? "互联网入口清单变化"
                  : language === "zh_TW"
                    ? "網際網路入口清單變化"
                    : "Internet exposure inventory changed";
              const body =
                language === "zh_CN"
                  ? `${hostCount} 台主机，${visible.length} 项清单变化。仅为配置证据，外部可达性尚未验证。`
                  : language === "zh_TW"
                    ? `${hostCount} 台主機，${visible.length} 項清單變化。僅為設定證據，外部可達性尚未驗證。`
                    : `${hostCount} host(s), ${visible.length} inventory changes. Configuration evidence only; external reachability has not been tested.`;
              await ctx.notify.send({
                title,
                body,
                category: "ai.exposure",
                severity: visible.some((c) => c.kind === "coverage")
                  ? "warning"
                  : "info",
                audience: { userId: group[0].ownerId },
                link: { tab: "ai" },
                dedupeKey: `ai-exposure-${fingerprint(key)}`,
              });
              await repo.noticeMany(
                visible.map((c) => c.id),
                "sent",
              );
            } catch {
              /* durable pending events retried with the same batch key */
            }
          });
        }
      } finally {
        notifying = false;
      }
    },
  };
}
