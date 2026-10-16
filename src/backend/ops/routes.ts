import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { buildOpsSystemPrompt } from "../context.js";
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
import { createOpsTools, MAX_TIMEOUT_SEC, type OpsLimits } from "./tools.js";

/** Conversations whose host facts are kept in memory at once. */
const FACTS_CONVERSATIONS = 200;

function parseId(raw: unknown): number | null {
  const id = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Deduplicated host ids, or null when anything in the list is not one. */
function parseHostIds(raw: unknown): number[] | null {
  if (raw === undefined) return [];
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
   * /plugin-api/ai/ops/chat:
   *   post:
   *     summary: Send a Cluster Ops message and stream the assistant's run
   *     description: >
   *       Server-sent events, like /chat/stream, plus a tool_progress frame for
   *       each host as its command finishes. hostIds become the conversation's
   *       targets; leave them out to keep the ones it has.
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
   *     responses:
   *       200:
   *         description: An event stream.
   *       400:
   *         description: Invalid request body, or no target hosts.
   *       403:
   *         description: Missing ai.ops.use, or the assistant is off.
   *       404:
   *         description: Provider or conversation not found.
   */
  router.post("/ops/chat", async (req: Request, res: Response) => {
    const userId = ctx.currentActor() as string;
    const { conversationId, providerId, model, message, hostIds } =
      req.body ?? {};

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "message is required" });
    }
    const resolvedProviderId = parseId(providerId);
    if (!resolvedProviderId) {
      return res.status(400).json({ error: "providerId is required" });
    }
    const requested = parseHostIds(hostIds);
    if (!requested) {
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

      const targets = requested.length
        ? requested
        : storedTargets(conversation?.targets);
      if (!targets.length) {
        return res.status(400).json({ error: "Select at least one host" });
      }

      if (!conversation) {
        conversation = await repository.createConversation({
          userId,
          title: message.trim().slice(0, 60),
          providerId: resolvedProviderId,
          model: chosenModel,
          mode: "ops",
          targets,
        });
      } else if (requested.length) {
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

      const tools = createOpsTools({
        targets,
        limits,
        signal,
        facts: factsFor(conversation.id),
        onHostResult: (name, command, host) =>
          send({ type: "tool_progress", name, command, host }),
        recordRuns: (runs) => repository.recordOpsRuns(runs),
      });

      const chatHistory = toChatHistory(history);
      chatHistory.push({ role: "user", content: message.trim() });

      try {
        for await (const event of runAgent({
          config,
          model: chosenModel,
          system: buildOpsSystemPrompt({ targetCount: targets.length }),
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
