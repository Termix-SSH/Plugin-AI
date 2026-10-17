import { existsSync } from "node:fs";
import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { buildAssistantSystemPrompt, type PageContext } from "../context.js";
import { estimateRequest, planContext } from "../context-window.js";
import { compactHistory, runAgent, type ModelUsage } from "../engine.js";
import {
  createAiGate,
  readPrivateAllowlist,
  type SettingsReader,
} from "../gating.js";
import { toChatHistory, toStoredMessage, toStoredSummary } from "../history.js";
import { contextPlanFor, type ModelInfoCache } from "../model-info.js";
import { createProviderFetch } from "../providers/http.js";
import type { ProviderConfig } from "../providers/types.js";
import type { AiProviderWithSecret, AiRepository } from "../repository.js";
import { readService, SERVICE } from "../services.js";
import type { ToolDeps } from "../tools/types.js";
import {
  createAssistantTools,
  type AssistantSession,
} from "./assistant-tools.js";
import { bundledCliPath, CORE_URL, requestToken } from "./cli.js";
import { createRunRegistry, type Frame, type Run } from "./runs.js";
import {
  createOpsTools,
  MAX_TIMEOUT_SEC,
  summaryBudgetFor,
  type OpsLimits,
} from "./tools.js";

/**
 * What the assistant opens and continues: its own conversations and those of
 * auto-ops tasks, so a task can be read and asked about after it ran.
 */
const ASSISTANT_MODES = new Set<string>(["ops", "task"]);

/** Conversations whose host facts are kept in memory at once. */
const FACTS_CONVERSATIONS = 200;

function parseId(raw: unknown): number | null {
  const id = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Deduplicated host ids, or null when anything in the list is not one. */
function parseHostIds(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = raw.map(parseId);
  if (ids.some((id) => id === null)) return null;
  return [...new Set(ids as number[])];
}

function storedTargets(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    return parseHostIds(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

const PAGE_TEXT_LIMIT = 120;

/** What the browser says the user is looking at, trimmed to plain fields. */
function parsePage(raw: unknown): PageContext | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, PAGE_TEXT_LIMIT)
      : undefined;
  const page: PageContext = {
    tabType: text(source.tabType),
    tabTitle: text(source.tabTitle),
    hostId: parseId(source.hostId) ?? undefined,
    hostName: text(source.hostName),
  };
  return Object.values(page).some((value) => value !== undefined) ? page : null;
}

export async function readOpsLimits(
  settings: SettingsReader,
): Promise<OpsLimits> {
  const read = async (
    key: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const value = Number(await settings.get<number>(key));
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.min(Math.max(Math.floor(value), min), max);
  };
  return {
    concurrency: await read("opsConcurrency", 8, 1, 64),
    timeoutSec: await read("opsCommandTimeout", 120, 5, MAX_TIMEOUT_SEC),
    outputLimit: await read("opsOutputLimit", 4000, 500, 20000),
  };
}

/**
 * The assistant behind the floating panel and the AI tab. Mounted under
 * /plugin-api/ai/ops, behind the use permission and the AI gate. A shell on
 * the hosts the user picked additionally needs ops.use, checked per request.
 */
export function registerOpsRoutes(
  router: Router,
  repository: AiRepository,
  ctx: PluginContext,
  modelInfo: ModelInfoCache,
): void {
  const gate = createAiGate(ctx.settings, () => ctx.currentActor());
  router.use("/ops", ctx.rbac.require("use") as never, gate as never);

  const toolDeps: ToolDeps = {
    hosts: ctx.hosts,
    services: ctx.services,
    notify: ctx.notify,
    rbac: ctx.rbac,
    ssh: ctx.ssh,
    audit: ctx.audit,
  };

  // Facts are cheap to probe again, so they live only as long as the process,
  // for the most recent conversations.
  const facts = new Map<number, Map<number, string>>();
  const factsFor = (conversationId: number) => {
    let cache = facts.get(conversationId);
    if (!cache) {
      cache = new Map();
      facts.set(conversationId, cache);
      if (facts.size > FACTS_CONVERSATIONS) {
        facts.delete(facts.keys().next().value as number);
      }
    }
    return cache;
  };

  const runs = createRunRegistry();
  ctx.disposables.add(() => runs.stopAll());

  const findOpsConversation = async (raw: unknown) => {
    const id = parseId(raw);
    const conversation = id
      ? await repository.findConversation(id, ctx.currentActor() as string)
      : null;
    return conversation && ASSISTANT_MODES.has(conversation.mode)
      ? conversation
      : null;
  };

  const logError = (message: string, error: unknown) =>
    ctx.log.error(
      message,
      error instanceof Error ? error : new Error(String(error)),
    );

  const configFor = async (
    provider: AiProviderWithSecret,
  ): Promise<ProviderConfig> => ({
    providerType: provider.providerType as ProviderConfig["providerType"],
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    fetch: createProviderFetch(
      ctx.fetch,
      await readPrivateAllowlist(ctx.settings),
    ),
  });

  /** The window and budget of a provider's model, from what it reports. */
  const planFor = async (
    provider: AiProviderWithSecret | null,
    model: string,
  ) =>
    provider
      ? contextPlanFor(modelInfo, provider, await configFor(provider), model)
      : planContext({ model, overrides: {}, info: {}, adapter: {} });

  /** What the context meter shows of a plan. */
  const meterOf = (plan: Awaited<ReturnType<typeof planFor>>) => ({
    contextWindow: plan.contextWindow,
    contextSource: plan.source,
    reservedOutput: plan.reservedOutput,
  });

  /** Counts each model call of a conversation against its user. */
  const usageRecorder =
    (
      userId: string,
      provider: AiProviderWithSecret,
      model: string,
      conversationId: number,
    ) =>
    (usage: ModelUsage) =>
      repository.recordUsage({
        userId,
        providerId: provider.id,
        model,
        conversationId,
        ...usage,
      });

  /**
   * @openapi
   * /plugin-api/ai/ops/fleets:
   *   get:
   *     summary: The user's fleets with their member host ids
   *     description: >
   *       For the assistant's target picker. available is false while the
   *       fleets plugin is not running or the user may not read fleets.
   *     tags:
   *       - AI
   *     responses:
   *       200:
   *         description: Fleets and whether the fleets plugin is available.
   *       403:
   *         description: Missing ai.use, or the assistant is off.
   */
  router.get("/ops/fleets", async (_req: Request, res: Response) => {
    const fleets = await readService(
      ctx.services,
      SERVICE.fleets,
      async (access) =>
        Promise.all(
          (await access.list()).map(async (fleet) => ({
            id: fleet.id,
            name: fleet.name,
            hostIds: (await access.members(fleet.id)).map((host) => host.id),
          })),
        ),
    );
    res.json({ available: fleets !== null, fleets: fleets ?? [] });
  });

  /**
   * @openapi
   * /plugin-api/ai/ops/conversations:
   *   get:
   *     summary: The assistant's conversations, newest first
   *     description: >
   *       Shared by the floating assistant and the AI tab.
   *     tags:
   *       - AI
   *     responses:
   *       200:
   *         description: >
   *           Conversations with their targets, the tokens each has used
   *           and whether a run is going on in it.
   *       403:
   *         description: Missing ai.use, or the assistant is off.
   */
  router.get("/ops/conversations", async (_req: Request, res: Response) => {
    const userId = ctx.currentActor() as string;
    const conversations = await repository.listConversations(userId, 50, "ops");
    const tokens = await repository.conversationTokens(
      conversations.map((conversation) => conversation.id),
    );
    res.json({
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        targets: storedTargets(conversation.targets),
        totalTokens: tokens.get(conversation.id) ?? 0,
        running: runs.running(conversation.id),
      })),
    });
  });

  /**
   * @openapi
   * /plugin-api/ai/ops/conversations/{id}:
   *   get:
   *     summary: One assistant conversation with its messages and targets
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
   *         description: >
   *           The conversation, with the tokens it has used, how much of
   *           the model's context its latest call took and whether a run is
   *           going on in it.
   *       404:
   *         description: Conversation not found.
   */
  router.get("/ops/conversations/:id", async (req: Request, res: Response) => {
    const conversation = await findOpsConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    const userId = ctx.currentActor() as string;
    const messages = await repository.listMessages(conversation.id);
    const [tokens, last] = await Promise.all([
      repository.conversationTokens([conversation.id]),
      repository.lastContext(conversation.id),
    ]);
    // The window of whichever provider and model made the latest call.
    const providerId = last?.providerId ?? conversation.providerId;
    const provider = providerId
      ? await repository.findProviderWithSecret(providerId, userId)
      : null;
    const model = last?.model ?? conversation.model ?? "";
    // Compacted since its last call: what is left is an estimate until the
    // next one.
    const compacted = messages.at(-1)?.role === "summary";
    const context = compacted
      ? {
          promptTokens: estimateRequest({
            system: "",
            messages: toChatHistory(messages),
            tools: [],
          }),
          estimated: true,
        }
      : last && { promptTokens: last.promptTokens, estimated: last.estimated };
    res.json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        targets: storedTargets(conversation.targets),
        totalTokens: tokens.get(conversation.id) ?? 0,
        running: runs.running(conversation.id),
        context: context
          ? { ...context, ...meterOf(await planFor(provider, model)) }
          : null,
      },
      messages,
    });
  });

  /**
   * @openapi
   * /plugin-api/ai/ops/conversations/{id}:
   *   delete:
   *     summary: Delete an assistant conversation and its run records
   *     description: >
   *       A run going on in it is stopped first.
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
   *         description: Conversation not found.
   */
  router.delete(
    "/ops/conversations/:id",
    async (req: Request, res: Response) => {
      const conversation = await findOpsConversation(req.params.id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      await runs.stop(conversation.id);
      await repository.deleteConversation(conversation.id, conversation.userId);
      res.json({ success: true });
    },
  );

  /**
   * @openapi
   * /plugin-api/ai/ops/conversations/{id}/stream:
   *   get:
   *     summary: Watch the run going on in an assistant conversation
   *     description: >
   *       The frames /ops/chat streams. Joining part way, the run's frames so
   *       far come first, then it continues live until done. With no run
   *       going on the stream is a single done frame, and the stored messages
   *       are all there is. Closing it never stops the run.
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
   *         description: An event stream.
   *       404:
   *         description: Conversation not found.
   */
  router.get(
    "/ops/conversations/:id/stream",
    async (req: Request, res: Response) => {
      const conversation = await findOpsConversation(req.params.id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      runs.watch(conversation.id, res);
    },
  );

  /**
   * @openapi
   * /plugin-api/ai/ops/conversations/{id}/stop:
   *   post:
   *     summary: Stop the run going on in an assistant conversation
   *     description: >
   *       Ends the model call and any command or CLI call it has running, and
   *       answers once the run has ended. stopped is false when there was
   *       none.
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
   *         description: Whether a run was stopped.
   *       404:
   *         description: Conversation not found.
   */
  router.post(
    "/ops/conversations/:id/stop",
    async (req: Request, res: Response) => {
      const conversation = await findOpsConversation(req.params.id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      const stopped = runs.running(conversation.id);
      await runs.stop(conversation.id);
      res.json({ stopped });
    },
  );

  /**
   * @openapi
   * /plugin-api/ai/ops/conversations/{id}/compact:
   *   post:
   *     summary: Summarise the earlier part of an assistant conversation
   *     description: >
   *       What happens on its own once the context is nearly full, on
   *       request: one model call summarises all but the most recent steps,
   *       and the summary stands in for them from then on. compacted is
   *       false when the conversation is too short to gain anything.
   *     tags:
   *       - AI
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               providerId:
   *                 type: integer
   *               model:
   *                 type: string
   *     responses:
   *       200:
   *         description: Whether it was compacted, and the context left.
   *       400:
   *         description: No provider or model.
   *       404:
   *         description: Conversation or provider not found.
   *       502:
   *         description: The provider could not summarise it.
   */
  router.post(
    "/ops/conversations/:id/compact",
    async (req: Request, res: Response) => {
      const userId = ctx.currentActor() as string;
      const conversation = await findOpsConversation(req.params.id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      const { providerId, model } = req.body ?? {};
      const resolvedProviderId = parseId(providerId);
      if (!resolvedProviderId) {
        return res.status(400).json({ error: "providerId is required" });
      }
      const provider = await repository.findProviderWithSecret(
        resolvedProviderId,
        userId,
      );
      if (!provider) {
        return res.status(404).json({ error: "Provider not found" });
      }
      const chosenModel =
        (typeof model === "string" && model.trim()) ||
        provider.defaultModel ||
        "";
      if (!chosenModel) {
        return res.status(400).json({ error: "No model selected" });
      }

      try {
        const plan = await planFor(provider, chosenModel);
        const compacted = await compactHistory({
          config: await configFor(provider),
          model: chosenModel,
          history: toChatHistory(
            await repository.listMessages(conversation.id),
          ),
          contextWindow: plan.contextWindow,
          contextBudget: plan.budget,
          onUsage: usageRecorder(
            userId,
            provider,
            chosenModel,
            conversation.id,
          ),
        });
        if (!compacted) return res.json({ compacted: false });
        await repository.appendMessage({
          conversationId: conversation.id,
          ...toStoredSummary(compacted.summary, compacted.keep),
        });
        res.json({
          compacted: true,
          context: {
            promptTokens: estimateRequest({
              system: "",
              messages: compacted.history,
              tools: [],
            }),
            estimated: true,
            ...meterOf(plan),
          },
        });
      } catch (err) {
        logError("Compacting a conversation failed", err);
        res
          .status(502)
          .json({ error: "The conversation could not be compacted" });
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/ai/ops/chat:
   *   post:
   *     summary: Send a message to the assistant and stream its run
   *     description: >
   *       Server-sent events, like /chat/stream, plus a tool_progress frame for
   *       each host as its command finishes, a targets frame when the
   *       assistant changes the targets and a client_action frame when it asks
   *       the browser to open a view. reasoning frames carry the model's
   *       thinking apart from its tokens, a usage frame follows every model
   *       call with its tokens, the context window, its source (override,
   *       provider, guess or default) and the tokens kept for the reply, and
   *       a compacted frame marks where the history was summarised to fit.
   *       The run goes on in the background: closing the stream only stops
   *       watching it, and /ops/conversations/{id}/stream picks it up again.
   *       There is no step limit; the run ends when the model answers, it is
   *       stopped, or it repeats one call with one result five times. One
   *       run at a time per conversation. hostIds become the conversation's
   *       targets; leave them out to keep the ones it has. Targets, and the
   *       tools that run commands on them, need ai.ops.use; without it a
   *       non-empty hostIds is refused and the CLI cannot exec on hosts.
   *       page is what the user is looking at.
   *     tags:
   *       - AI
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               conversationId:
   *                 type: integer
   *               providerId:
   *                 type: integer
   *               model:
   *                 type: string
   *               message:
   *                 type: string
   *               hostIds:
   *                 type: array
   *                 items:
   *                   type: integer
   *               page:
   *                 type: object
   *                 properties:
   *                   tabType:
   *                     type: string
   *                   tabTitle:
   *                     type: string
   *                   hostId:
   *                     type: integer
   *                   hostName:
   *                     type: string
   *     responses:
   *       200:
   *         description: An event stream.
   *       400:
   *         description: Invalid request body.
   *       403:
   *         description: >
   *           Missing ai.use, hostIds sent without ai.ops.use, or the
   *           assistant is off.
   *       404:
   *         description: Provider or conversation not found.
   *       409:
   *         description: The conversation already has a run going on.
   */
  router.post("/ops/chat", async (req: Request, res: Response) => {
    const userId = ctx.currentActor() as string;
    const { conversationId, providerId, model, message, hostIds, page } =
      req.body ?? {};

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message is required" });
    }
    const resolvedProviderId = parseId(providerId);
    if (!resolvedProviderId) {
      return res.status(400).json({ error: "providerId is required" });
    }
    const requested = hostIds === undefined ? null : parseHostIds(hostIds);
    if (hostIds !== undefined && !requested) {
      return res
        .status(400)
        .json({ error: "hostIds must be a list of host ids" });
    }
    const hostShell = await ctx.rbac.has("ops.use");
    if (!hostShell && requested?.length) {
      return res.status(403).json({
        error: "Running commands on hosts needs the ai.ops.use permission",
      });
    }

    let run: Run | null = null;
    try {
      const provider = await repository.findProviderWithSecret(
        resolvedProviderId,
        userId,
      );
      if (!provider) {
        return res.status(404).json({ error: "Provider not found" });
      }
      const chosenModel =
        (typeof model === "string" && model.trim()) ||
        provider.defaultModel ||
        "";
      if (!chosenModel) {
        return res.status(400).json({ error: "No model selected" });
      }

      let conversation = conversationId
        ? await repository.findConversation(Number(conversationId), userId)
        : null;
      if (
        conversationId &&
        !(conversation && ASSISTANT_MODES.has(conversation.mode))
      ) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      // Claimed before anything is written, so two messages cannot race.
      if (conversation) {
        run = runs.start(conversation.id);
        if (!run) {
          return res
            .status(409)
            .json({ error: "The assistant is still working on this" });
        }
      }

      const targets = hostShell
        ? (requested ?? storedTargets(conversation?.targets))
        : [];

      if (!conversation) {
        conversation = await repository.createConversation({
          userId,
          title: message.trim().slice(0, 60),
          providerId: resolvedProviderId,
          model: chosenModel,
          mode: "ops",
          targets,
        });
        run = runs.start(conversation.id) as Run;
      } else if (requested && hostShell) {
        await repository.setConversationTargets(conversation.id, targets);
      }

      const history = await repository.listMessages(conversation.id);
      await repository.appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: message.trim(),
      });

      const config = await configFor(provider);
      const plan = await planFor(provider, chosenModel);
      const limits = {
        ...(await readOpsLimits(ctx.settings)),
        summaryBudget: summaryBudgetFor(plan.contextWindow),
      };

      const current = run;
      const send = (frame: Frame) => runs.send(current, frame);
      runs.subscribe(current, res);
      send({ type: "conversation", conversationId: conversation.id });

      // Taken now: the run outlives the request, the token stays valid.
      const token = requestToken(req);
      const cliPath = bundledCliPath();
      const ownId = conversation.id;
      const session: AssistantSession = {
        hostShell,
        targets,
        limits,
        signal: current.signal,
        facts: factsFor(ownId),
        onHostResult: (name, command, host) =>
          send({ type: "tool_progress", name, command, host }),
        recordRuns: (runs) => repository.recordOpsRuns(runs),
        cli:
          token && existsSync(cliPath)
            ? {
                run: ctx.process.run,
                cliPath,
                url: CORE_URL,
                token: async () => token,
              }
            : null,
        saveTargets: async (next) => {
          await repository.setConversationTargets(ownId, next);
          send({ type: "targets", hostIds: next });
        },
        clientAction: (action) => send({ type: "client_action", action }),
        recordCliRun: (run) => repository.recordCliRun(run),
      };
      const tools = [
        ...(hostShell ? createOpsTools(session) : []),
        ...createAssistantTools(session),
      ];

      const chatHistory = toChatHistory(history);
      chatHistory.push({ role: "user", content: message.trim() });

      const agent = runAgent({
        config,
        model: chosenModel,
        system: buildAssistantSystemPrompt({
          targetCount: targets.length,
          page: parsePage(page),
          cli: session.cli !== null,
          hostShell,
        }),
        history: chatHistory,
        context: {
          userId,
          conversationId: ownId,
          allowReadOnlyCommands: false,
          deps: toolDeps,
        },
        tools,
        signal: current.signal,
        contextWindow: plan.contextWindow,
        contextBudget: plan.budget,
        compactAt: plan.compactAt,
        onUsage: usageRecorder(userId, provider, chosenModel, ownId),
      });

      // Not awaited: the response is only one of the run's watchers.
      void ctx
        .asUser(userId, async () => {
          try {
            for await (const event of agent) {
              if (event.type === "message") {
                await repository.appendMessage({
                  conversationId: ownId,
                  ...toStoredMessage(event.message),
                });
                continue;
              }
              if (event.type === "compacted") {
                await repository.appendMessage({
                  conversationId: ownId,
                  ...toStoredSummary(event.summary, event.keep),
                });
                send({ type: "compacted" });
                continue;
              }
              send(
                event.type === "usage" ? { ...event, ...meterOf(plan) } : event,
              );
            }
          } finally {
            await repository.touchConversation(ownId);
          }
        })
        .catch((err) => {
          logError("Assistant run failed", err);
          send({
            type: "error",
            message: "The assistant stopped unexpectedly",
          });
        })
        .finally(() => {
          send({ type: "done" });
          runs.finish(current);
        });
    } catch (err) {
      logError("Assistant stream failed", err);
      if (!run) {
        return res.status(500).json({ error: "Failed to start the assistant" });
      }
      if (res.headersSent) {
        runs.send(run, {
          type: "error",
          message: "The assistant stopped unexpectedly",
        });
      } else {
        res.status(500).json({ error: "Failed to start the assistant" });
      }
      runs.finish(run);
    }
  });
}
