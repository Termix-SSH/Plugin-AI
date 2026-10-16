import { existsSync } from "node:fs";
import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { buildAssistantSystemPrompt, type PageContext } from "../context.js";
import { runAgent } from "../engine.js";
import {
  createAiGate,
  readPrivateAllowlist,
  type SettingsReader,
} from "../gating.js";
import { toChatHistory, toStoredMessage } from "../history.js";
import { createProviderFetch } from "../providers/http.js";
import type { ProviderConfig } from "../providers/types.js";
import type { AiRepository } from "../repository.js";
import { readService, SERVICE } from "../services.js";
import { openEventStream } from "../sse.js";
import type { ToolDeps } from "../tools/types.js";
import {
  createAssistantTools,
  type AssistantSession,
} from "./assistant-tools.js";
import { bundledCliPath, CORE_URL, requestToken } from "./cli.js";
import { createOpsTools, MAX_TIMEOUT_SEC, type OpsLimits } from "./tools.js";

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
): Promise<OpsLimits & { maxTurns: number }> {
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
    maxTurns: await read("opsMaxTurns", 30, 1, 100),
    concurrency: await read("opsConcurrency", 8, 1, 64),
    timeoutSec: await read("opsCommandTimeout", 120, 5, MAX_TIMEOUT_SEC),
    outputLimit: await read("opsOutputLimit", 4000, 500, 20000),
  };
}

/**
 * Cluster Ops: the assistant with a shell on hosts the user picked. Mounted
 * under /plugin-api/ai/ops, behind the ops.use permission and the AI gate.
 */
export function registerOpsRoutes(
  router: Router,
  repository: AiRepository,
  ctx: PluginContext,
): void {
  const gate = createAiGate(ctx.settings, () => ctx.currentActor());
  router.use("/ops", ctx.rbac.require("ops.use") as never, gate as never);

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

  const findOpsConversation = async (raw: unknown) => {
    const id = parseId(raw);
    const conversation = id
      ? await repository.findConversation(id, ctx.currentActor() as string)
      : null;
    return conversation?.mode === "ops" ? conversation : null;
  };

  const logError = (message: string, error: unknown) =>
    ctx.log.error(
      message,
      error instanceof Error ? error : new Error(String(error)),
    );

  /**
   * @openapi
   * /plugin-api/ai/ops/fleets:
   *   get:
   *     summary: The user's fleets with their member host ids
   *     description: >
   *       For the Cluster Ops target picker. available is false while the
   *       fleets plugin is not running or the user may not read fleets.
   *     tags:
   *       - AI
   *     responses:
   *       200:
   *         description: Fleets and whether the fleets plugin is available.
   *       403:
   *         description: Missing ai.ops.use, or the assistant is off.
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
   *       Shared by the floating assistant and the Cluster Ops tab.
   *     tags:
   *       - AI
   *     responses:
   *       200:
   *         description: Conversations with their targets.
   *       403:
   *         description: Missing ai.ops.use, or the assistant is off.
   */
  router.get("/ops/conversations", async (_req: Request, res: Response) => {
    const userId = ctx.currentActor() as string;
    const conversations = await repository.listConversations(userId, 50, "ops");
    res.json({
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
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
   *         description: The conversation.
   *       404:
   *         description: Conversation not found.
   */
  router.get("/ops/conversations/:id", async (req: Request, res: Response) => {
    const conversation = await findOpsConversation(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    res.json({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        targets: storedTargets(conversation.targets),
      },
      messages: await repository.listMessages(conversation.id),
    });
  });

  /**
   * @openapi
   * /plugin-api/ai/ops/conversations/{id}:
   *   delete:
   *     summary: Delete an assistant conversation and its run records
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
      await repository.deleteConversation(conversation.id, conversation.userId);
      res.json({ success: true });
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
   *       the browser to open a view. hostIds become the conversation's
   *       targets; leave them out to keep the ones it has. page is what the
   *       user is looking at.
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
   *         description: Missing ai.ops.use, or the assistant is off.
   *       404:
   *         description: Provider or conversation not found.
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
      if (conversationId && conversation?.mode !== "ops") {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const targets = requested ?? storedTargets(conversation?.targets);

      if (!conversation) {
        conversation = await repository.createConversation({
          userId,
          title: message.trim().slice(0, 60),
          providerId: resolvedProviderId,
          model: chosenModel,
          mode: "ops",
          targets,
        });
      } else if (requested) {
        await repository.setConversationTargets(conversation.id, targets);
      }

      const history = await repository.listMessages(conversation.id);
      await repository.appendMessage({
        conversationId: conversation.id,
        role: "user",
        content: message.trim(),
      });

      const limits = await readOpsLimits(ctx.settings);
      const config: ProviderConfig = {
        providerType: provider.providerType as ProviderConfig["providerType"],
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        fetch: createProviderFetch(
          ctx.fetch,
          await readPrivateAllowlist(ctx.settings),
        ),
      };

      const { send, signal, stopHeartbeat } = openEventStream(res);
      send({ type: "conversation", conversationId: conversation.id });

      const token = requestToken(req);
      const cliPath = bundledCliPath();
      const ownId = conversation.id;
      const session: AssistantSession = {
        targets,
        limits,
        signal,
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
                token,
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
        ...createOpsTools(session),
        ...createAssistantTools(session),
      ];

      const chatHistory = toChatHistory(history);
      chatHistory.push({ role: "user", content: message.trim() });

      try {
        for await (const event of runAgent({
          config,
          model: chosenModel,
          system: buildAssistantSystemPrompt({
            targetCount: targets.length,
            page: parsePage(page),
            cli: session.cli !== null,
          }),
          history: chatHistory,
          context: {
            userId,
            conversationId: conversation.id,
            allowReadOnlyCommands: false,
            deps: toolDeps,
          },
          tools,
          signal,
          maxTurns: limits.maxTurns,
        })) {
          if (event.type === "message") {
            await repository.appendMessage({
              conversationId: conversation.id,
              ...toStoredMessage(event.message),
            });
            continue;
          }
          send(event);
        }
      } finally {
        stopHeartbeat();
      }
      await repository.touchConversation(conversation.id);

      send({ type: "done" });
      res.end();
    } catch (err) {
      logError("Cluster Ops stream failed", err);
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        res.write(
          `data: ${JSON.stringify({ type: "error", message: "The assistant stopped unexpectedly" })}\n\n`,
        );
        res.end();
      } else {
        res.status(500).json({ error: "Failed to start the assistant" });
      }
    }
  });
}
