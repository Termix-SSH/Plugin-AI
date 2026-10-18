import { createExposureExplainer } from "./exposure/explain.js";
import { createExposureRepository } from "./exposure/repository.js";
import { createExposureService } from "./exposure/service.js";
import { registerExposureRoutes } from "./exposure/routes.js";
import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { hostImportNormalizer } from "./host-import.js";
import { createModelInfoCache } from "./model-info.js";
import { createAiRepository } from "./repository.js";
import { registerProviderSync } from "./sync.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { createAnnotationService } from "./assets/annotate.js";
import { createAssetRepository } from "./assets/repository.js";
import { registerAssetRoutes } from "./assets/routes.js";
import {
  createAssetService,
  parseTime,
  SETTINGS as ASSET_SETTINGS,
  subscribeHostEvents,
} from "./assets/service.js";
import { createAgentStore } from "./agents/store.js";
import { registerOpsRoutes } from "./ops/routes.js";
import { registerAiRoutes } from "./routes.js";
import { registerUsageRoutes } from "./usage.js";
import { createTaskRepository } from "./tasks/repository.js";
import { registerTaskRoutes } from "./tasks/routes.js";
import type { RunningTasks } from "./tasks/runner.js";
import { createTaskService } from "./tasks/service.js";

/** How often proposed plans are checked for expiry. */
const EXPIRY_CHECK_MS = 5 * 60 * 1000;

export async function activate(ctx: PluginContext) {
  const repository = await createAiRepository(ctx);
  await registerProviderSync(ctx, repository);

  const router = ctx.http.router<Router>();
  // Shared, so a refresh in settings reaches the chat too.
  const modelInfo = createModelInfoCache();
  registerAiRoutes(router, repository, ctx, modelInfo);
  registerAgentRoutes(router, repository, ctx, await createAgentStore(ctx));
  registerOpsRoutes(router, repository, ctx, modelInfo);
  registerUsageRoutes(router, repository, ctx);

  // Auto-ops: the ai.tasks service Automations calls, and its routes.
  const tasks = await createTaskRepository(ctx);
  await tasks.failInterrupted();
  const running: RunningTasks = new Map();
  const toolDeps = {
    hosts: ctx.hosts,
    services: ctx.services,
    notify: ctx.notify,
    rbac: ctx.rbac,
    ssh: ctx.ssh,
    audit: ctx.audit,
  };
  const taskService = createTaskService({
    ctx,
    repository,
    tasks,
    modelInfo,
    toolDeps,
    running,
  });
  registerTaskRoutes(router, ctx, { repository, tasks, toolDeps, running });
  ctx.services.provide("ai.tasks", taskService.service);
  ctx.schedule.every(
    EXPIRY_CHECK_MS,
    () =>
      void taskService
        .expireStale()
        .catch((error) => ctx.log.warn(`Expiring AI plans failed: ${error}`)),
    { runNow: true },
  );
  // The kill switch also stops what is already running.
  ctx.settings.onChange("autoOpsPaused", (value) => {
    if (value === true) taskService.stopAll();
  });

  // Asset inventory: collected daily, on host events and on request.
  const assetRepository = await createAssetRepository(ctx);
  await assetRepository.failInterrupted();
  // Annotated by a model after each collection, unless turned off.
  const annotation = createAnnotationService({
    ctx,
    assets: assetRepository,
    repository,
    modelInfo,
    collector: () => assets.collector(),
  });
  const exposureRepository = await createExposureRepository(ctx);
  const exposure = createExposureService(
    ctx,
    exposureRepository,
    assetRepository,
  );
  const assets = createAssetService(ctx, assetRepository, {
    afterCollect: async (outcomes, userId) => {
      await exposure.collect(outcomes, userId);
      await exposure.notify();
      await annotation.afterCollect();
    },
  });
  registerExposureRoutes(
    router,
    ctx,
    exposureRepository,
    createExposureExplainer(ctx, repository),
    () => assetRepository.listAssets(),
  );
  ctx.schedule.every(60_000, () =>
    exposure
      .notify()
      .catch(() => ctx.log.warn("Exposure notification retry failed")),
  );
  ctx.schedule.every(86400_000, async () => {
    const days = Number(await ctx.settings.get("exposureRetentionDays")) || 90;
    await exposureRepository
      .prune(Date.now(), Math.min(365, Math.max(7, days)))
      .catch(() => ctx.log.warn("Exposure retention failed"));
  });
  ctx.disposables.add(() => exposure.close());
  registerAssetRoutes(router, ctx, assetRepository, assets, annotation);
  subscribeHostEvents(ctx, assets);
  ctx.schedule.every(60_000, () =>
    assets
      .tick()
      .catch((error) => ctx.log.warn(`Asset schedule failed: ${error}`)),
  );
  ctx.disposables.add(() => assets.close());
  ctx.disposables.add(() => annotation.close());
  ctx.settings.onChange("autoOpsPaused", (value) => {
    if (value === true) annotation.stop("AI auto-ops was paused");
  });
  ctx.settings.onChange("globallyEnabled", (value) => {
    if (value !== true) annotation.stop("The AI assistant was turned off");
  });
  ctx.settings.onValidate("admin", (values) => {
    const time = values[ASSET_SETTINGS.time];
    if (time !== undefined && time !== "" && !parseTime(time)) {
      return { [ASSET_SETTINGS.time]: "Use HH:MM, for example 03:00" };
    }
  });

  ctx.registry.provide("ai.hostImportNormalizer", hostImportNormalizer);
  ctx.disposables.add(
    () =>
      void ctx.registry.revoke("ai.hostImportNormalizer", hostImportNormalizer),
  );

  // Offered by reference, not copied: this hands over a resolver, so the key
  // stays ours. Rotating or deleting the provider takes effect on the next
  // read by any borrower, and deactivate withdraws the offer. Keys are per
  // user, so a borrowed read returns the acting user's own key.
  ctx.secrets.offer("api-key", (userId: string) =>
    ctx.asUser(userId, async () => {
      const providers = await repository.listProviders(userId);
      const preferred = providers.find((provider) => provider.apiKeyPrefix);
      if (!preferred) return null;
      const withSecret = await repository.findProviderWithSecret(
        preferred.id,
        userId,
      );
      return withSecret?.apiKey ?? null;
    }),
  );

  ctx.log.info("AI assistant routes mounted at /plugin-api/ai");
}

export async function deactivate() {}
