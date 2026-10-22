import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { ModelOverrides } from "./context-window.js";
import type { ProviderAdvanced } from "./providers/types.js";
import {
  cliRuns as cliRunsDef,
  conversations as conversationsDef,
  messages as messagesDef,
  opsRuns as opsRunsDef,
  proposals as proposalsDef,
  providers as providersDef,
  usage as usageDef,
} from "./tables.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Tables come from ctx.db.define, which the SDK hands back untyped.
type Table = any;
type Drizzle = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface AiProviderRecord {
  id: number;
  userId: string;
  providerType: string;
  label: string;
  baseUrl: string | null;
  apiKeyPrefix: string | null;
  defaultModel: string | null;
  /** The user's per-model settings, such as a context window override. */
  modelOverrides: ModelOverrides;
  advanced: ProviderAdvanced;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A provider with its key, for the one path that makes outbound calls. */
export interface AiProviderWithSecret extends AiProviderRecord {
  apiKey: string | null;
}

export interface AiConversationRecord {
  id: number;
  userId: string;
  title: string | null;
  providerId: number | null;
  model: string | null;
  mode: ConversationMode;
  /** JSON host ids, for an ops conversation. */
  targets: string | null;
  createdAt: string;
  updatedAt: string;
}

/** ops is the assistant; task is an auto-ops run, opened in the assistant. */
export type ConversationMode = "chat" | "ops" | "task";

/** One Termix CLI call the assistant made. */
export interface CliRunInput {
  conversationId: number;
  userId: string;
  /** JSON args, secret flag values already redacted. */
  args: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

/** One command on one host, as Cluster Ops records it. */
export interface OpsRunInput {
  conversationId: number;
  userId: string;
  hostId: number;
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface AiMessageRecord {
  id: number;
  conversationId: number;
  role: string;
  content: string;
  toolCalls: string | null;
  reasoning: string | null;
  createdAt: string;
}

/** One model call's tokens, as recorded. */
export interface UsageInput {
  userId: string;
  providerId: number | null;
  model: string;
  conversationId: number | null;
  source: string;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
}

export interface UsageRow {
  userId: string;
  model: string;
  source: string;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
  createdAt: string;
}

export interface AiProposalRecord {
  id: number;
  conversationId: number;
  userId: string;
  kind: string;
  summary: string | null;
  payload: string;
  status: string;
  appliedAt: string | null;
  resultSummary: string | null;
  createdAt: string;
}

export interface AiProviderInput {
  providerType: string;
  label: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  defaultModel?: string | null;
  modelOverrides?: ModelOverrides;
  advanced?: ProviderAdvanced;
  enabled?: boolean;
}

/** Where a provider's key lives in ctx.secrets. */
export function providerSecretKey(providerId: number): string {
  return `provider:${providerId}`;
}

/**
 * Keeps the first few characters so the UI can tell two keys apart without
 * ever receiving the key itself.
 */
export function apiKeyPrefix(apiKey: string | null | undefined): string | null {
  if (!apiKey) return null;
  return apiKey.slice(0, 6);
}

const now = () => new Date().toISOString();

/** The column's JSON as a map; anything unreadable is no overrides. */
function parseOverrides(raw: unknown): ModelOverrides {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

const storedOverrides = (overrides: ModelOverrides) =>
  Object.keys(overrides).length ? JSON.stringify(overrides) : null;

/** The column's JSON as settings; anything unreadable is model defaults. */
function parseAdvanced(raw: unknown): ProviderAdvanced {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

const storedAdvanced = (advanced: ProviderAdvanced) =>
  Object.keys(advanced).length ? JSON.stringify(advanced) : null;

/** A provider row as callers see it, without the retired window column. */
function toProvider(row: Record<string, unknown>): AiProviderRecord {
  const { contextWindow: _retired, modelOverrides, advanced, ...rest } = row;
  return {
    ...(rest as Omit<AiProviderRecord, "modelOverrides" | "advanced">),
    modelOverrides: parseOverrides(modelOverrides),
    advanced: parseAdvanced(advanced),
  };
}

export type AiRepository = Awaited<ReturnType<typeof createAiRepository>>;

/**
 * The assistant's rows. Every method takes the owning user and scopes to
 * them. Keys go through ctx.secrets, which is per acting user, so key reads
 * and writes run inside the request (or ctx.asUser) of that same user.
 */
export async function createAiRepository(
  ctx: Pick<PluginContext, "db" | "secrets">,
) {
  const { db, secrets } = ctx;
  const providers: Table = await db.define(providersDef);
  const conversations: Table = await db.define(conversationsDef);
  const messages: Table = await db.define(messagesDef);
  const proposals: Table = await db.define(proposalsDef);
  const opsRuns: Table = await db.define(opsRunsDef);
  const cliRuns: Table = await db.define(cliRunsDef);
  const usage: Table = await db.define(usageDef);

  const client = () => db.client<Drizzle>();

  /** Inserts one row and returns its id. MySQL has no RETURNING. */
  async function insertId(
    table: Table,
    values: Record<string, unknown>,
  ): Promise<number> {
    const drizzle = await client();
    if (db.dialect === "mysql") {
      const result = await drizzle.insert(table).values(values);
      const header = Array.isArray(result) ? result[0] : result;
      return Number(header?.insertId);
    }
    const rows = await drizzle
      .insert(table)
      .values(values)
      .returning({ id: table.id });
    return rows[0].id as number;
  }

  async function first<T>(table: Table, where: unknown): Promise<T | null> {
    const rows = await (
      await client()
    )
      .select()
      .from(table)
      .where(where)
      .limit(1);
    return (rows[0] as T) ?? null;
  }

  const repo = {
    // --- providers ---

    /** Never includes key material; callers get the masked prefix only. */
    async listProviders(userId: string): Promise<AiProviderRecord[]> {
      const rows = await (
        await client()
      )
        .select()
        .from(providers)
        .where(eq(providers.userId, userId))
        .orderBy(providers.id);
      return rows.map(toProvider);
    },

    async findProvider(
      id: number,
      userId: string,
    ): Promise<AiProviderRecord | null> {
      const row = await first<Record<string, unknown>>(
        providers,
        and(eq(providers.id, id), eq(providers.userId, userId)),
      );
      return row && toProvider(row);
    },

    /** Every model the user has called through a provider. */
    async providerModels(id: number, userId: string): Promise<string[]> {
      const rows = await (
        await client()
      )
        .selectDistinct({ model: usage.model })
        .from(usage)
        .where(and(eq(usage.providerId, id), eq(usage.userId, userId)));
      return rows.map((row: { model: string }) => row.model);
    },

    /**
     * The one path that returns usable key material, right before an
     * outbound request. Must run as `userId`.
     */
    async findProviderWithSecret(
      id: number,
      userId: string,
    ): Promise<AiProviderWithSecret | null> {
      const row = await repo.findProvider(id, userId);
      if (!row) return null;
      return { ...row, apiKey: await secrets.get(providerSecretKey(id)) };
    },

    async createProvider(
      userId: string,
      input: AiProviderInput,
    ): Promise<AiProviderRecord> {
      const stamp = now();
      const id = await insertId(providers, {
        userId,
        providerType: input.providerType,
        label: input.label,
        baseUrl: input.baseUrl ?? null,
        apiKeyPrefix: apiKeyPrefix(input.apiKey),
        defaultModel: input.defaultModel ?? null,
        modelOverrides: storedOverrides(input.modelOverrides ?? {}),
        advanced: storedAdvanced(input.advanced ?? {}),
        enabled: input.enabled ?? true,
        createdAt: stamp,
        updatedAt: stamp,
      });
      if (input.apiKey) {
        await secrets.set(providerSecretKey(id), input.apiKey);
      }
      await db.persist();
      const created = await repo.findProvider(id, userId);
      if (!created) throw new Error("Provider could not be read back");
      return created;
    },

    async updateProvider(
      id: number,
      userId: string,
      input: Partial<AiProviderInput>,
    ): Promise<AiProviderRecord | null> {
      const existing = await repo.findProvider(id, userId);
      if (!existing) return null;

      const updates: Record<string, unknown> = { updatedAt: now() };
      if (input.providerType !== undefined)
        updates.providerType = input.providerType;
      if (input.label !== undefined) updates.label = input.label;
      if (input.baseUrl !== undefined) updates.baseUrl = input.baseUrl;
      if (input.defaultModel !== undefined)
        updates.defaultModel = input.defaultModel;
      if (input.modelOverrides !== undefined)
        updates.modelOverrides = storedOverrides(input.modelOverrides);
      if (input.advanced !== undefined)
        updates.advanced = storedAdvanced(input.advanced);
      if (input.enabled !== undefined) updates.enabled = input.enabled;

      // An empty string clears the key; undefined leaves it untouched.
      if (input.apiKey !== undefined) {
        updates.apiKeyPrefix = apiKeyPrefix(input.apiKey);
        await secrets.set(providerSecretKey(id), input.apiKey || null);
      }

      await (
        await client()
      )
        .update(providers)
        .set(updates)
        .where(and(eq(providers.id, id), eq(providers.userId, userId)));
      await db.persist();
      return repo.findProvider(id, userId);
    },

    async deleteProvider(id: number, userId: string): Promise<boolean> {
      const existing = await repo.findProvider(id, userId);
      if (!existing) return false;
      await (
        await client()
      )
        .delete(providers)
        .where(and(eq(providers.id, id), eq(providers.userId, userId)));
      await secrets.delete(providerSecretKey(id));
      await db.persist();
      return true;
    },

    // --- conversations ---

    async listConversations(
      userId: string,
      limit = 50,
      mode: ConversationMode = "chat",
    ): Promise<AiConversationRecord[]> {
      return (await client())
        .select()
        .from(conversations)
        .where(
          and(eq(conversations.userId, userId), eq(conversations.mode, mode)),
        )
        .orderBy(desc(conversations.updatedAt))
        .limit(limit);
    },

    async findConversation(
      id: number,
      userId: string,
    ): Promise<AiConversationRecord | null> {
      return first<AiConversationRecord>(
        conversations,
        and(eq(conversations.id, id), eq(conversations.userId, userId)),
      );
    },

    async createConversation(input: {
      userId: string;
      title?: string | null;
      providerId?: number | null;
      model?: string | null;
      mode?: ConversationMode;
      targets?: number[];
    }): Promise<AiConversationRecord> {
      const stamp = now();
      const id = await insertId(conversations, {
        userId: input.userId,
        title: input.title ?? null,
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        mode: input.mode ?? "chat",
        targets: input.targets ? JSON.stringify(input.targets) : null,
        createdAt: stamp,
        updatedAt: stamp,
      });
      await db.persist();
      const created = await repo.findConversation(id, input.userId);
      if (!created) throw new Error("Conversation could not be read back");
      return created;
    },

    async touchConversation(id: number): Promise<void> {
      await (
        await client()
      )
        .update(conversations)
        .set({ updatedAt: now() })
        .where(eq(conversations.id, id));
      await db.persist();
    },

    async setConversationTargets(id: number, targets: number[]): Promise<void> {
      await (
        await client()
      )
        .update(conversations)
        .set({ targets: JSON.stringify(targets) })
        .where(eq(conversations.id, id));
      await db.persist();
    },

    async deleteConversation(id: number, userId: string): Promise<boolean> {
      const existing = await repo.findConversation(id, userId);
      if (!existing) return false;
      // Deleted explicitly rather than trusting the cascade, which a
      // connection without foreign keys on would skip.
      const drizzle = await client();
      await drizzle.delete(messages).where(eq(messages.conversationId, id));
      await drizzle.delete(proposals).where(eq(proposals.conversationId, id));
      await drizzle.delete(opsRuns).where(eq(opsRuns.conversationId, id));
      await drizzle.delete(cliRuns).where(eq(cliRuns.conversationId, id));
      await drizzle
        .delete(conversations)
        .where(and(eq(conversations.id, id), eq(conversations.userId, userId)));
      await db.persist();
      return true;
    },

    // --- messages ---

    async listMessages(conversationId: number): Promise<AiMessageRecord[]> {
      return (await client())
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(messages.id);
    },

    async appendMessage(input: {
      conversationId: number;
      role: string;
      content: string;
      toolCalls?: string | null;
      reasoning?: string | null;
    }): Promise<void> {
      await insertId(messages, {
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        toolCalls: input.toolCalls ?? null,
        reasoning: input.reasoning ?? null,
        createdAt: now(),
      });
      await db.persist();
    },

    // --- ops runs ---

    /** One insert and one persist for a whole fan-out. */
    async recordOpsRuns(runs: OpsRunInput[]): Promise<void> {
      if (!runs.length) return;
      const createdAt = now();
      await (
        await client()
      )
        .insert(opsRuns)
        .values(runs.map((run) => ({ ...run, createdAt })));
      await db.persist();
    },

    async recordCliRun(run: CliRunInput): Promise<void> {
      await insertId(cliRuns, { ...run, createdAt: now() });
      await db.persist();
    },

    // --- usage ---

    /** Every model call writes one; a lazy persist keeps that cheap. */
    async recordUsage(input: UsageInput): Promise<void> {
      await (await client()).insert(usage).values({
        ...input,
        promptTokens: Math.max(0, Math.round(input.promptTokens)),
        completionTokens: Math.max(0, Math.round(input.completionTokens)),
        createdAt: now(),
      });
      await db.persist({ lazy: true });
    },

    /** Calls since `since`, for one user or, with null, everyone. */
    async usageSince(
      since: string,
      userId: string | null,
    ): Promise<UsageRow[]> {
      const after = gte(usage.createdAt, since);
      return (await client())
        .select({
          userId: usage.userId,
          model: usage.model,
          source: usage.source,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          estimated: usage.estimated,
          createdAt: usage.createdAt,
        })
        .from(usage)
        .where(userId ? and(eq(usage.userId, userId), after) : after);
    },

    /** Total tokens per conversation, for the ones asked about. */
    async conversationTokens(ids: number[]): Promise<Map<number, number>> {
      const totals = new Map<number, number>();
      if (!ids.length) return totals;
      const rows: Array<{
        conversationId: number;
        promptTokens: number;
        completionTokens: number;
      }> = await (
        await client()
      )
        .select({
          conversationId: usage.conversationId,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        })
        .from(usage)
        .where(inArray(usage.conversationId, ids));
      for (const row of rows) {
        totals.set(
          row.conversationId,
          (totals.get(row.conversationId) ?? 0) +
            row.promptTokens +
            row.completionTokens,
        );
      }
      return totals;
    },

    /** The prompt of the conversation's latest call, as the context it holds. */
    async lastContext(conversationId: number): Promise<{
      promptTokens: number;
      estimated: boolean;
      providerId: number | null;
      model: string;
    } | null> {
      const rows = await (
        await client()
      )
        .select({
          promptTokens: usage.promptTokens,
          estimated: usage.estimated,
          providerId: usage.providerId,
          model: usage.model,
        })
        .from(usage)
        .where(
          and(
            eq(usage.conversationId, conversationId),
            inArray(usage.source, ["assistant", "terminal", "task"]),
          ),
        )
        .orderBy(desc(usage.id))
        .limit(1);
      return rows[0] ? { ...rows[0], estimated: !!rows[0].estimated } : null;
    },

    // --- proposals ---

    async listProposals(
      userId: string,
      conversationId: number,
    ): Promise<AiProposalRecord[]> {
      return (await client())
        .select()
        .from(proposals)
        .where(
          and(
            eq(proposals.userId, userId),
            eq(proposals.conversationId, conversationId),
          ),
        )
        .orderBy(desc(proposals.id));
    },

    async findProposal(
      id: number,
      userId: string,
    ): Promise<AiProposalRecord | null> {
      return first<AiProposalRecord>(
        proposals,
        and(eq(proposals.id, id), eq(proposals.userId, userId)),
      );
    },

    async createProposal(input: {
      conversationId: number;
      userId: string;
      kind: string;
      summary?: string | null;
      payload: string;
    }): Promise<AiProposalRecord> {
      const id = await insertId(proposals, {
        conversationId: input.conversationId,
        userId: input.userId,
        kind: input.kind,
        summary: input.summary ?? null,
        payload: input.payload,
        status: "pending",
        createdAt: now(),
      });
      await db.persist();
      const created = await repo.findProposal(id, input.userId);
      if (!created) throw new Error("Proposal could not be read back");
      return created;
    },

    /** Only moves a pending proposal. False when it was not pending. */
    async setProposalStatus(
      id: number,
      userId: string,
      status: "applied" | "rejected" | "expired",
      resultSummary?: string | null,
    ): Promise<boolean> {
      const existing = await repo.findProposal(id, userId);
      if (!existing || existing.status !== "pending") return false;
      await (
        await client()
      )
        .update(proposals)
        .set({
          status,
          appliedAt: status === "applied" ? now() : null,
          resultSummary: resultSummary ?? null,
        })
        .where(
          and(
            eq(proposals.id, id),
            eq(proposals.userId, userId),
            eq(proposals.status, "pending"),
          ),
        );
      await db.persist();
      return true;
    },
  };

  return repo;
}
