import { aiApp } from "./app-ref";

/** Fired when the AI status may have changed, so every surface re-reads it. */
export const AI_STATUS_CHANGED_EVENT = "termix-ai:status-changed";

function notifyAiStatusChanged(): void {
  window.dispatchEvent(new Event(AI_STATUS_CHANGED_EVENT));
}

/** Fired after a provider is added, edited or removed. */
export const AI_PROVIDERS_CHANGED_EVENT = "termix-ai:providers-changed";

function notifyProvidersChanged(): void {
  window.dispatchEvent(new Event(AI_PROVIDERS_CHANGED_EVENT));
}

/** The server's own message when it sent one, so the user sees why. */
function apiError(error: unknown, action: string): Error {
  const data = (error as { response?: { data?: { error?: unknown } } })
    ?.response?.data;
  if (typeof data?.error === "string" && data.error) {
    return new Error(data.error);
  }
  if (error instanceof Error && error.message) return error;
  return new Error(`Failed to ${action}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Response bodies are typed per function below, at the edge.
interface LooseClient {
  get(url: string): Promise<{ data: any }>;
  delete(url: string): Promise<{ data: any }>;
  post(url: string, body?: unknown): Promise<{ data: any }>;
  put(url: string, body?: unknown): Promise<{ data: any }>;
  patch(url: string, body?: unknown): Promise<{ data: any }>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const api = () => aiApp().api as unknown as LooseClient;

export type AiProviderType =
  "ollama" | "anthropic" | "openai" | "gemini" | "openai_compatible";

export interface AiProvider {
  id: number;
  providerType: AiProviderType;
  label: string;
  baseUrl: string | null;
  /** The first few characters only; the key itself never leaves the server. */
  apiKeyPrefix: string | null;
  defaultModel: string | null;
  /** Per model id, a context window that replaces the provider's. */
  modelOverrides: ModelOverrides;
  /** Request settings for OpenAI-style providers, empty when none are set. */
  advanced: ProviderAdvanced;
  enabled: boolean;
  createdAt: string;
}

export type ModelOverrides = Record<string, { contextWindow?: number }>;

export type ReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Absent fields keep the model's defaults and are not sent. */
export interface ProviderAdvanced {
  endpoint?: "auto" | "responses" | "chat";
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: "auto" | "concise" | "detailed" | "off";
  verbosity?: "low" | "medium" | "high";
  /** A whole number, 1 to 1,000,000. */
  maxOutputTokens?: number;
  /** 0 to 2. */
  temperature?: number;
}

/** Where a context window came from, best first. */
export type ContextSource = "override" | "provider" | "guess" | "default";

/** How each source reads, as translation keys. */
export const CONTEXT_SOURCE_KEYS: Record<ContextSource, string> = {
  override: "ai.contextSourceOverride",
  provider: "ai.contextSourceProvider",
  guess: "ai.contextSourceGuess",
  default: "ai.contextSourceDefault",
};

/** One model's context window, as the server resolved it. */
export interface ModelContext {
  model: string;
  contextWindow: number;
  source: ContextSource;
  /** Tokens kept free for the reply. */
  reservedOutput: number;
  /** What the provider reported, null when it said nothing. */
  reportedWindow: number | null;
  override: number | null;
}

interface AiConversation {
  id: number;
  title: string | null;
  providerId: number | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessage {
  id: number;
  conversationId: number;
  /** summary marks where the conversation was compacted. */
  role: "user" | "assistant" | "tool" | "summary";
  content: string;
  toolCalls: string | null;
  reasoning?: string | null;
  createdAt: string;
}

export interface AiProposal {
  id: number;
  conversationId: number;
  kind: string;
  summary: string | null;
  payload: string;
  status: "pending" | "applied" | "rejected" | "expired";
  resultSummary: string | null;
  createdAt: string;
}

export interface AiStatus {
  globallyEnabled: boolean;
  enabled: boolean;
  allowReadOnlyCommands: boolean;
}

export async function getAiStatus(): Promise<AiStatus> {
  try {
    return (await api().get("/status")).data;
  } catch (error) {
    throw apiError(error, "get AI status");
  }
}

export async function getAiProviders(): Promise<AiProvider[]> {
  try {
    return (await api().get("/providers")).data.providers;
  } catch (error) {
    throw apiError(error, "list AI providers");
  }
}

export async function createAiProvider(input: {
  providerType: AiProviderType;
  label: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  defaultModel?: string | null;
  advanced?: ProviderAdvanced | null;
}): Promise<AiProvider> {
  try {
    const provider = (await api().post("/providers", input)).data.provider;
    notifyProvidersChanged();
    return provider;
  } catch (error) {
    throw apiError(error, "create AI provider");
  }
}

export async function updateAiProvider(
  id: number,
  input: Partial<{
    label: string;
    baseUrl: string | null;
    apiKey: string | null;
    defaultModel: string | null;
    modelOverrides: ModelOverrides;
    /** Replaces the whole object; null clears it. */
    advanced: ProviderAdvanced | null;
    enabled: boolean;
  }>,
): Promise<AiProvider> {
  try {
    const provider = (await api().patch(`/providers/${id}`, input)).data
      .provider;
    notifyProvidersChanged();
    return provider;
  } catch (error) {
    throw apiError(error, "update AI provider");
  }
}

export async function deleteAiProvider(id: number): Promise<void> {
  try {
    await api().delete(`/providers/${id}`);
    notifyProvidersChanged();
  } catch (error) {
    throw apiError(error, "delete AI provider");
  }
}

/**
 * Model list for a provider that may not be saved yet, so the add form can
 * fill its picker before anything is persisted.
 */
export async function probeAiModels(input: {
  providerType: AiProviderType;
  baseUrl?: string | null;
  apiKey?: string | null;
  providerId?: number | null;
}): Promise<{
  models: string[];
  source: "live" | "fallback" | "none";
  warning?: string;
}> {
  try {
    return (await api().post("/probe-models", input)).data;
  } catch (error) {
    throw apiError(error, "detect models");
  }
}

export async function getAiProviderModels(id: number): Promise<string[]> {
  try {
    return (await api().get(`/providers/${id}/models`)).data.models;
  } catch (error) {
    throw apiError(error, "list provider models");
  }
}

/**
 * The context window of the provider's known models plus `models`; refresh
 * asks the provider again.
 */
export async function getProviderContext(
  id: number,
  options: { models?: string[]; refresh?: boolean } = {},
): Promise<ModelContext[]> {
  try {
    const query = new URLSearchParams();
    if (options.models?.length) query.set("models", options.models.join(","));
    if (options.refresh) query.set("refresh", "1");
    return (await api().get(`/providers/${id}/context?${query}`)).data.models;
  } catch (error) {
    throw apiError(error, "read context windows");
  }
}

async function getAiConversations(): Promise<AiConversation[]> {
  try {
    return (await api().get("/conversations")).data.conversations;
  } catch (error) {
    throw apiError(error, "list AI conversations");
  }
}

async function getAiConversation(id: number): Promise<{
  conversation: AiConversation;
  messages: AiMessage[];
  proposals: AiProposal[];
}> {
  try {
    return (await api().get(`/conversations/${id}`)).data;
  } catch (error) {
    throw apiError(error, "load AI conversation");
  }
}

async function deleteAiConversation(id: number): Promise<void> {
  try {
    await api().delete(`/conversations/${id}`);
  } catch (error) {
    throw apiError(error, "delete AI conversation");
  }
}

export async function applyAiProposal(
  id: number,
): Promise<{ success: boolean; summary: string }> {
  try {
    return (await api().post(`/proposals/${id}/apply`)).data;
  } catch (error) {
    throw apiError(error, "apply AI proposal");
  }
}

export async function rejectAiProposal(id: number): Promise<void> {
  try {
    await api().post(`/proposals/${id}/reject`);
  } catch (error) {
    throw apiError(error, "reject AI proposal");
  }
}

/**
 * For the terminal-docked assistant: records that a run_command proposal was
 * typed into the user's open terminal instead of run over a pooled connection.
 */
export async function markAiProposalRunInTerminal(
  id: number,
  hostId: number,
  summary?: string,
): Promise<{ success: boolean; summary: string }> {
  try {
    return (
      await api().post(`/proposals/${id}/mark-run-in-terminal`, {
        hostId,
        summary,
      })
    ).data;
  } catch (error) {
    throw apiError(error, "mark AI proposal run in terminal");
  }
}

/** Turns the assistant on or off for the current user. */
export async function setAiOptIn(enabled: boolean): Promise<void> {
  try {
    await api().put("/opt-in", { enabled });
  } catch (error) {
    throw apiError(error, "update the AI setting");
  } finally {
    notifyAiStatusChanged();
  }
}

export interface OpsFleet {
  id: number;
  name: string;
  hostIds: number[];
}

/** Fleets for the target picker; available is false without the plugin. */
export async function getOpsFleets(): Promise<{
  available: boolean;
  fleets: OpsFleet[];
}> {
  try {
    return (await api().get("/ops/fleets")).data;
  } catch (error) {
    throw apiError(error, "list fleets");
  }
}

export interface AssistantConversation {
  id: number;
  title: string | null;
  updatedAt: string;
  targets: number[];
  /** Every model call of the conversation, compaction included. */
  totalTokens: number;
  /** A run is going on in it on the server. */
  running: boolean;
}

/** How much of the model's context the latest call took. */
export interface ContextUse {
  promptTokens: number;
  contextWindow: number;
  estimated: boolean;
  contextSource?: ContextSource;
  /** Tokens kept free for the reply. */
  reservedOutput?: number;
}

/** The assistant's conversations, shared by the floating panel and the AI tab. */
export async function listAssistantConversations(): Promise<
  AssistantConversation[]
> {
  try {
    return (await api().get("/ops/conversations")).data.conversations;
  } catch (error) {
    throw apiError(error, "list conversations");
  }
}

export async function getAssistantConversation(id: number): Promise<{
  conversation: AssistantConversation & { context: ContextUse | null };
  messages: AiMessage[];
}> {
  try {
    return (await api().get(`/ops/conversations/${id}`)).data;
  } catch (error) {
    throw apiError(error, "load the conversation");
  }
}

export async function deleteAssistantConversation(id: number): Promise<void> {
  try {
    await api().delete(`/ops/conversations/${id}`);
  } catch (error) {
    throw apiError(error, "delete the conversation");
  }
}

/** Stops the run going on in the conversation; resolves once it has ended. */
export async function stopAssistantConversation(id: number): Promise<void> {
  try {
    await api().post(`/ops/conversations/${id}/stop`);
  } catch (error) {
    throw apiError(error, "stop the assistant");
  }
}

/** Summarises the conversation's earlier part now, as it would when full. */
export async function compactAssistantConversation(
  id: number,
  providerId: number,
): Promise<{ compacted: boolean; context?: ContextUse }> {
  try {
    return (
      await api().post(`/ops/conversations/${id}/compact`, { providerId })
    ).data;
  } catch (error) {
    throw apiError(error, "compact the conversation");
  }
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  estimated: boolean;
}

export interface UsageSummary {
  scope: "me" | "all";
  today: UsageTotals;
  week: UsageTotals;
  month: UsageTotals;
  byDay: Array<{ day: string } & UsageTotals>;
  byModel: Array<{ model: string } & UsageTotals>;
  bySource: Array<{ source: string } & UsageTotals>;
  byUser?: Array<{ userId: string } & UsageTotals>;
}

/** Token usage over 30 days; "all" needs ai.usage.view_all. */
export async function getAiUsage(
  scope: "me" | "all" = "me",
): Promise<UsageSummary> {
  try {
    const offset = new Date().getTimezoneOffset();
    return (await api().get(`/usage?scope=${scope}&offset=${offset}`)).data;
  } catch (error) {
    throw apiError(error, "load usage");
  }
}
