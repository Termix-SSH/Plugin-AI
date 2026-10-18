import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createAiGate } from "../gating.js";
import { readOpsLimits } from "../ops/routes.js";
import type { AiRepository } from "../repository.js";
import { readService, requireService, SERVICE } from "../services.js";
import { executePlan } from "./execute.js";
import { automationName, ownerLanguage, presetTitle } from "./language.js";
import { PREFERENCES_KEY, readPreferences, readTaskLimits } from "./limits.js";
import {
  applyOverrides,
  automationDefinition,
  findPreset,
  parseSavedConfig,
  PRESETS,
  type PresetConfig,
} from "./presets.js";
import type { TaskRepository, TaskRunRecord } from "./repository.js";
import type { RunningTasks } from "./runner.js";
import type { ToolDeps } from "../tools/types.js";

/**
 * Auto-ops in the AI tab: tasks and their reports, approving or rejecting
 * a proposed plan, presets and the owner's task preferences. Mounted under
 * /plugin-api/ai/tasks behind ai.use and the AI gate. A task is visible to,
 * and decided by, its owner or anyone with ai.ops.use; presets need
 * ai.ops.use, since what they create runs through ai.tasks.
 */

const CUSTOM_PREFIX = "custom:";

function parseId(raw: unknown): number | null {
  const id = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** What the task list shows of a run. */
function listItem(task: TaskRunRecord, userId: string) {
  return {
    id: task.id,
    userId: task.userId,
    mine: task.userId === userId,
    automationId: task.automationId,
    presetId: task.presetId,
    title: task.title,
    autonomy: task.autonomy,
    status: task.status,
    severity: task.severity,
    summary: task.summary,
    hostIds: task.hostIds,
    dryRun: task.dryRun,
    conversationId: task.conversationId,
    promptTokens: task.promptTokens,
    completionTokens: task.completionTokens,
    totalTokens: task.promptTokens + task.completionTokens,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    expiresAt: task.expiresAt,
  };
}

export interface TaskRouteDeps {
  repository: AiRepository;
  tasks: TaskRepository;
  toolDeps: ToolDeps;
  running: RunningTasks;
}

export function registerTaskRoutes(
  router: Router,
  ctx: PluginContext,
  deps: TaskRouteDeps,
): void {
  const { tasks } = deps;
  const gate = createAiGate(ctx.settings, () => ctx.currentActor());
  router.use("/tasks", ctx.rbac.require("use") as never, gate as never);
  const opsOnly = ctx.rbac.require("ops.use") as never;

  const actor = () => ctx.currentActor() as string;

  /** The task when the actor may see it: its owner or an ai.ops.use holder. */
  const visibleTask = async (raw: unknown) => {
    const id = parseId(raw);
    const task = id ? await tasks.findRun(id) : null;
    if (!task) return null;
    if (task.userId === actor() || (await ctx.rbac.has("ops.use"))) return task;
    return null;
  };

  const logError = (message: string, error: unknown) =>
    ctx.log.error(
      message,
      error instanceof Error ? error : new Error(String(error)),
    );

  /**
   * @openapi
   * /plugin-api/ai/tasks:
   *   get:
   *     summary: Auto-ops tasks and plans waiting for a decision
   *     description: >
   *       tasks are the user's own, newest first. approvals are proposed
   *       plans and plans being run that the user may decide on: their own,
   *       and everyone's for a holder of ai.ops.use.
   *     tags:
   *       - AI
   *     responses:
   *       200:
   *         description: The tasks and the approvals.
   *       403:
   *         description: Missing ai.use, or the assistant is off.
   */
  router.get("/tasks", async (_req: Request, res: Response) => {
    const userId = actor();
    const everyone = await ctx.rbac.has("ops.use");
    const [mine, open] = await Promise.all([
      tasks.listRuns(userId, { limit: 100 }),
      tasks.listRuns(everyone ? null : userId, {
        statuses: ["proposed", "approved", "executing"],
      }),
    ]);
    res.json({
      tasks: mine.map((task) => listItem(task, userId)),
      approvals: open.map((task) => listItem(task, userId)),
    });
  });

  /**
   * @openapi
   * /plugin-api/ai/tasks/preferences:
   *   get:
   *     summary: The provider, model and language the user's tasks use
   *     tags:
   *       - AI
   *     responses:
   *       200:
   *         description: The preferences.
   *   put:
   *     summary: Save the provider, model and language for the user's tasks
   *     description: >
   *       Fields left out keep their value. language is the user's interface
   *       language, which reports are written in.
   *     tags:
   *       - AI
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               providerId:
   *                 type: integer
   *                 nullable: true
   *               model:
   *                 type: string
   *                 nullable: true
   *               language:
   *                 type: string
   *     responses:
   *       200:
   *         description: The saved preferences.
   *       400:
   *         description: Invalid field.
   *       404:
   *         description: Provider not found.
   */
  router.get("/tasks/preferences", async (_req: Request, res: Response) => {
    res.json({ preferences: await readPreferences(ctx.settings, actor()) });
  });

  router.put("/tasks/preferences", async (req: Request, res: Response) => {
    const userId = actor();
    const body = req.body ?? {};
    const next = await readPreferences(ctx.settings, userId);
    if (body.providerId !== undefined) {
      if (body.providerId === null) next.providerId = null;
      else {
        const id = parseId(body.providerId);
        if (!id || !(await deps.repository.findProvider(id, userId))) {
          return res.status(404).json({ error: "Provider not found" });
        }
        next.providerId = id;
      }
    }
    if (body.model !== undefined) {
      if (body.model !== null && typeof body.model !== "string") {
        return res.status(400).json({ error: "model must be a string" });
      }
      next.model = body.model?.trim().slice(0, 200) || null;
    }
    if (body.language !== undefined) {
      if (
        typeof body.language !== "string" ||
        !/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/.test(body.language)
      ) {
        return res.status(400).json({ error: "language is not a language" });
      }
      next.language = body.language;
    }
    await ctx.settings.setUser(userId, PREFERENCES_KEY, next);
    res.json({ preferences: next });
  });

  /**
   * @openapi
   * /plugin-api/ai/tasks/presets:
   *   get:
   *     summary: Shipped and saved auto-ops presets, with what is enabled
   *     description: >
   *       Each preset lists the automations made from it and whether the
   *       shipped version is newer than the one they were made from.
   *       automationsAvailable is false while the Automations plugin is not
   *       running, and presets cannot be enabled then.
   *     tags:
   *       - AI
   *     responses:
   *       200:
   *         description: Presets.
   *       403:
   *         description: Missing ai.ops.use, or the assistant is off.
   */
  router.get("/tasks/presets", opsOnly, async (_req, res: Response) => {
    const userId = actor();
    const automationsAvailable =
      ctx.services.providers(SERVICE.automations).length > 0;
    const enabled = new Map<
      string,
      Array<{ automationId: number; version: number; name: string }>
    >();
    if (automationsAvailable) {
      for (const link of await tasks.presetLinks(userId)) {
        const automation = await readService(
          ctx.services,
          SERVICE.automations,
          (access) => access.get(link.automationId),
        );
        // Deleted in Automations: the preset is no longer enabled.
        if (!automation) {
          await tasks.unlinkPreset(link.id);
          continue;
        }
        const list = enabled.get(link.presetId) ?? [];
        list.push({
          automationId: link.automationId,
          version: link.presetVersion,
          name: automation.name,
        });
        enabled.set(link.presetId, list);
      }
    }
    const custom = await tasks.listPresets(userId);
    res.json({
      automationsAvailable,
      presets: PRESETS.map((preset) => {
        const links = enabled.get(preset.id) ?? [];
        return {
          ...preset,
          enabled: links,
          updateAvailable: links.some((link) => link.version < preset.version),
        };
      }),
      custom: custom.flatMap((preset) => {
        const config = parseSavedConfig(preset.config);
        if (!config) return [];
        const id = `${CUSTOM_PREFIX}${preset.id}`;
        return [
          {
            id,
            version: 1,
            name: preset.name,
            description: preset.description,
            shared: preset.shared,
            mine: preset.userId === userId,
            ...config,
            enabled: enabled.get(id) ?? [],
            updateAvailable: false,
          },
        ];
      }),
    });
  });

  /**
   * A shipped or saved preset's config, version and title, by its id. A
   * shipped preset's title is in the user's language.
   */
  const presetBase = async (
    presetId: string,
    userId: string,
  ): Promise<{
    config: PresetConfig;
    version: number;
    title: string;
  } | null> => {
    if (presetId.startsWith(CUSTOM_PREFIX)) {
      const saved = await tasks.findPreset(
        parseId(presetId.slice(CUSTOM_PREFIX.length)) ?? 0,
      );
      if (!saved || (!saved.shared && saved.userId !== userId)) return null;
      const config = parseSavedConfig(saved.config);
      return config ? { config, version: 1, title: saved.name } : null;
    }
    const preset = findPreset(presetId);
    if (!preset) return null;
    const language = await ownerLanguage(ctx, userId);
    return {
      config: preset,
      version: preset.version,
      title: presetTitle(language, presetId),
    };
  };

  /**
   * @openapi
   * /plugin-api/ai/tasks/presets/{presetId}/enable:
   *   post:
   *     summary: Create an automation from a preset
   *     description: >
   *       Creates it through automations.access as the user: the preset's
   *       trigger with the user's changes and one ai_task step. The preset
   *       version is recorded so a newer one can be offered later.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: path
   *         name: presetId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name:
   *                 type: string
   *                 description: >
   *                   The automation's name. Defaults to "AI · " and the
   *                   title.
   *               title:
   *                 type: string
   *                 description: >
   *                   The report title. Defaults to the preset's title in
   *                   the user's language.
   *               description:
   *                 type: string
   *               trigger:
   *                 type: object
   *               hostSelector:
   *                 type: object
   *               autonomy:
   *                 type: string
   *                 enum: [report, propose]
   *               runbook:
   *                 type: string
   *               maxRunSeconds:
   *                 type: integer
   *     responses:
   *       201:
   *         description: The automation was created.
   *       400:
   *         description: Invalid changes, or Automations refused them.
   *       403:
   *         description: Missing ai.ops.use, or the assistant is off.
   *       404:
   *         description: Preset not found.
   *       503:
   *         description: The Automations plugin is not running.
   */
  router.post(
    "/tasks/presets/:presetId/enable",
    opsOnly,
    async (req: Request, res: Response) => {
      const userId = actor();
      const presetId = String(req.params.presetId);
      const base = await presetBase(presetId, userId);
      if (!base) return res.status(404).json({ error: "Preset not found" });
      const applied = applyOverrides(base.config, req.body);
      if ("error" in applied) {
        return res.status(400).json({ error: applied.error });
      }
      const body = req.body ?? {};
      const title =
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim().slice(0, 200)
          : base.title;
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim().slice(0, 120)
          : automationName(title).slice(0, 120);
      let access;
      try {
        access = requireService(ctx.services, SERVICE.automations);
      } catch {
        return res
          .status(503)
          .json({ error: "The Automations plugin is not available" });
      }
      try {
        const created = await access.create({
          name,
          description:
            typeof body.description === "string" ? body.description : null,
          definition: automationDefinition(applied.config, presetId, title),
          enabled: body.enabled !== false,
          concurrencyPolicy: applied.config.concurrencyPolicy,
          maxRunSeconds: applied.config.maxRunSeconds,
        });
        await tasks.linkPreset({
          userId,
          presetId,
          presetVersion: base.version,
          automationId: created.id,
        });
        res.status(201).json({ automation: created });
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error
              ? error.message
              : "Automations refused the automation",
        });
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/ai/tasks/custom-presets:
   *   post:
   *     summary: Save an auto-ops configuration as a preset
   *     description: >
   *       shared makes it a preset for everyone who may use auto-ops; only
   *       its creator can delete it.
   *     tags:
   *       - AI
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name:
   *                 type: string
   *               description:
   *                 type: string
   *               shared:
   *                 type: boolean
   *               config:
   *                 type: object
   *     responses:
   *       201:
   *         description: The saved preset.
   *       400:
   *         description: Missing name or an unusable config.
   *       403:
   *         description: Missing ai.ops.use, or the assistant is off.
   */
  router.post(
    "/tasks/custom-presets",
    opsOnly,
    async (req: Request, res: Response) => {
      const body = req.body ?? {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return res.status(400).json({ error: "name is required" });
      const config = parseSavedConfig(body.config);
      if (!config) {
        return res.status(400).json({ error: "config is not a preset config" });
      }
      const preset = await tasks.createPreset({
        userId: actor(),
        name: name.slice(0, 120),
        description:
          typeof body.description === "string" ? body.description : null,
        shared: body.shared === true,
        config: { ...config },
      });
      res
        .status(201)
        .json({ preset: { ...preset, id: `${CUSTOM_PREFIX}${preset.id}` } });
    },
  );

  /**
   * @openapi
   * /plugin-api/ai/tasks/custom-presets/{id}:
   *   delete:
   *     summary: Delete a preset the user saved
   *     tags:
   *       - AI
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Deleted.
   *       404:
   *         description: Not found, or saved by someone else.
   */
  router.delete(
    "/tasks/custom-presets/:id",
    opsOnly,
    async (req: Request, res: Response) => {
      const id = parseId(req.params.id);
      if (!id || !(await tasks.deletePreset(id, actor()))) {
        return res.status(404).json({ error: "Preset not found" });
      }
      res.json({ success: true });
    },
  );

  /**
   * @openapi
   * /plugin-api/ai/tasks/{id}:
   *   get:
   *     summary: One auto-ops task with its report and plan
   *     description: >
   *       Visible to its owner and to holders of ai.ops.use. canDecide says
   *       whether the user may approve or reject its plan.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The task.
   *       404:
   *         description: Task not found.
   */
  router.get("/tasks/:id", async (req: Request, res: Response) => {
    const task = await visibleTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    const names = new Map(
      (await ctx.hosts.list()).map((host) => [host.id, host.name || host.ip]),
    );
    res.json({
      task: {
        ...listItem(task, actor()),
        trigger: task.trigger,
        report: task.report,
        plan: task.plan,
        decidedBy: task.decidedBy,
        decidedAt: task.decidedAt,
        hostNames: Object.fromEntries(
          task.hostIds.map((id) => [id, names.get(id) ?? `#${id}`]),
        ),
        canDecide: task.status === "proposed",
      },
    });
  });

  /** Why the actor may not decide on a task's plan, or nothing. */
  const decisionRefusal = async (task: TaskRunRecord) => {
    if (task.userId === actor()) return null;
    if (!(await ctx.rbac.has("ops.use"))) {
      return "Only the owner or a holder of ai.ops.use may decide on this plan";
    }
    // Someone else's plan: they must be able to reach every host it changes.
    for (const host of task.plan ?? []) {
      const access = await ctx.hosts.checkAccess(host.hostId, "connect");
      if (!access.hasAccess)
        return "You cannot connect to every host in this plan";
    }
    return null;
  };

  /**
   * @openapi
   * /plugin-api/ai/tasks/{id}/approve:
   *   post:
   *     summary: Approve a proposed plan and run it
   *     description: >
   *       The owner, or a holder of ai.ops.use who can connect to every host
   *       in the plan, may approve. The plan then runs as the owner, verbatim,
   *       per host in order, stopping a host at its first failure, then its
   *       verify commands. Answers at once; poll the task for progress.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       202:
   *         description: Approved; the plan is running.
   *       403:
   *         description: Not allowed to decide on this plan.
   *       404:
   *         description: Task not found.
   *       409:
   *         description: >
   *           Not waiting for a decision, expired, or auto-ops is paused.
   */
  router.post("/tasks/:id/approve", async (req: Request, res: Response) => {
    const task = await visibleTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    const refusal = await decisionRefusal(task);
    if (refusal) return res.status(403).json({ error: refusal });
    if (task.status !== "proposed" || !task.plan?.length) {
      return res
        .status(409)
        .json({ error: "This plan is not waiting for a decision" });
    }
    const now = new Date();
    if (task.expiresAt && Date.parse(task.expiresAt) <= now.getTime()) {
      await tasks.transition(task.id, ["proposed"], {
        status: "expired",
        finishedAt: now.toISOString(),
      });
      return res.status(409).json({ error: "This plan has expired" });
    }
    // The plan must still be what was proposed: hosts of this task only.
    if (
      task.plan.some(
        (host) => !task.hostIds.includes(host.hostId) || !host.commands.length,
      )
    ) {
      return res.status(409).json({ error: "This plan is no longer valid" });
    }
    if ((await readTaskLimits(ctx.settings)).paused) {
      return res.status(409).json({ error: "AI auto-ops is paused" });
    }
    const approved = await tasks.transition(task.id, ["proposed"], {
      status: "approved",
      decidedBy: actor(),
      decidedAt: now.toISOString(),
    });
    if (!approved) {
      return res
        .status(409)
        .json({ error: "This plan is not waiting for a decision" });
    }
    await tasks.transition(task.id, ["approved"], { status: "executing" });
    const current = (await tasks.findRun(task.id)) as TaskRunRecord;
    const limits = await readOpsLimits(ctx.settings);
    const language = await ownerLanguage(ctx, task.userId);
    void ctx
      .asUser(task.userId, () =>
        executePlan(
          {
            ctx,
            toolDeps: deps.toolDeps,
            repository: deps.repository,
            tasks,
            running: deps.running,
          },
          current,
          limits,
          language,
        ),
      )
      .catch(async (error) => {
        logError("Running an approved AI plan failed", error);
        await tasks
          .updateRun(task.id, {
            status: "failed",
            summary: "The plan could not be run.",
            finishedAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      });
    res.status(202).json({ status: "executing" });
  });

  /**
   * @openapi
   * /plugin-api/ai/tasks/{id}/reject:
   *   post:
   *     summary: Reject a proposed plan
   *     tags:
   *       - AI
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Rejected; nothing ran.
   *       403:
   *         description: Not allowed to decide on this plan.
   *       404:
   *         description: Task not found.
   *       409:
   *         description: Not waiting for a decision.
   */
  router.post("/tasks/:id/reject", async (req: Request, res: Response) => {
    const task = await visibleTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    const refusal = await decisionRefusal(task);
    if (refusal) return res.status(403).json({ error: refusal });
    const now = new Date().toISOString();
    const rejected = await tasks.transition(task.id, ["proposed"], {
      status: "rejected",
      decidedBy: actor(),
      decidedAt: now,
      finishedAt: now,
    });
    if (!rejected) {
      return res
        .status(409)
        .json({ error: "This plan is not waiting for a decision" });
    }
    res.json({ status: "rejected" });
  });
}
