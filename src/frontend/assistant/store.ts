import { useSyncExternalStore } from "react";
import type { ClientAction } from "../../backend/ops/assistant-tools";
import type { PageContext } from "../../backend/context";
import {
  AI_PROVIDERS_CHANGED_EVENT,
  compactAssistantConversation,
  deleteAssistantConversation,
  getAiUsage,
  getAiProviders,
  getAiStatus,
  getAssistantConversation,
  getOpsFleets,
  listAssistantConversations,
  setAiOptIn,
  type AiProvider,
  type AssistantConversation,
  type ContextUse,
  type OpsFleet,
} from "../ai-api";
import { aiApp } from "../app-ref";
import { getErrorMessage } from "../errors";
import {
  applyStreamEvent,
  storedHistory,
  userEntry,
  type AssistantEntry,
} from "../transcript";
import { readEvents } from "../use-ai-stream";

/**
 * The one assistant behind the floating panel and the AI tab. It
 * lives outside React, so closing the panel or the tab never ends a run:
 * the stream keeps going here and either view shows it when it comes back.
 */

export type { ClientAction, PageContext };

export interface AssistantState {
  /** The floating panel. */
  open: boolean;
  /** The floating panel docked as a full-height drawer on the right. */
  drawer: boolean;
  conversationId: number | null;
  history: AssistantEntry[];
  streaming: boolean;
  /** The run in progress, in the order its frames arrived. */
  live: AssistantEntry[];
  error: string | null;
  /** How full the model's context was at the conversation's latest call. */
  context: ContextUse | null;
  /** The user's tokens today, null until loaded. */
  todayTokens: number | null;
  compacting: boolean;
  /** Host ids run_command may use; sent with every message. */
  targets: number[];
  /** Whether the user holds ai.ops.use, so the assistant has a shell on targets. */
  hostShell: boolean;
  providers: AiProvider[];
  providerId: number | null;
  /** Null while the fleets plugin is not available. */
  fleets: OpsFleet[] | null;
  conversations: AssistantConversation[];
}

const INITIAL: AssistantState = {
  open: false,
  drawer: false,
  conversationId: null,
  history: [],
  streaming: false,
  live: [],
  error: null,
  context: null,
  todayTokens: null,
  compacting: false,
  targets: [],
  hostShell: false,
  providers: [],
  providerId: null,
  fleets: null,
  conversations: [],
};

let state = INITIAL;
const listeners = new Set<() => void>();
let abort: AbortController | null = null;
let runCount = 0;
let toolCount = 0;
let ready: Promise<void> | null = null;
let clientActionHandler: ((action: ClientAction) => void) | null = null;

function set(patch: Partial<AssistantState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function loadProviders() {
  const providers = await getAiProviders().catch(() => []);
  const current = state.providerId;
  set({
    providers,
    providerId:
      current && providers.some((entry) => entry.id === current)
        ? current
        : (providers[0]?.id ?? null),
  });
}

const reloadProviders = () => void loadProviders();

async function loadConversations() {
  const conversations = await listAssistantConversations().catch(() => null);
  if (conversations) set({ conversations });
}

async function loadTodayUsage() {
  const usage = await getAiUsage().catch(() => null);
  if (usage) set({ todayTokens: usage.today.totalTokens });
}

async function prepare() {
  // Opening the assistant is consent, as in the assistant panel; every route
  // sits behind the user's own opt-in.
  const status = await getAiStatus().catch(() => null);
  if (status?.globallyEnabled && !status.enabled) {
    await setAiOptIn(true).catch(() => undefined);
  }
  window.addEventListener(AI_PROVIDERS_CHANGED_EVENT, reloadProviders);
  await loadProviders();
  const fleets = await getOpsFleets().catch(() => null);
  set({ fleets: fleets?.available ? fleets.fleets : null });
  await loadConversations();
  await loadTodayUsage();
}

function finish(controller: AbortController, error: string | null) {
  // Superseded by a newer conversation; this run's state is already gone.
  if (abort !== controller) return;
  abort = null;
  set({
    history: [...state.history, ...state.live],
    streaming: false,
    live: [],
    ...(error ? { error } : {}),
  });
  void loadConversations();
  void loadTodayUsage();
}

async function readError(response: Response): Promise<string> {
  try {
    return (
      (await response.json()).error ?? "The assistant could not be reached"
    );
  } catch {
    return "The assistant could not be reached";
  }
}

export const assistant = {
  get: () => state,
  subscribe,

  /** Loads providers, fleets and conversations once, opting the user in. */
  ensureReady(): Promise<void> {
    ready ??= prepare();
    return ready;
  },

  setOpen(open: boolean) {
    set({ open });
  },
  toggle() {
    set({ open: !state.open });
  },
  setDrawer(drawer: boolean) {
    set({ drawer });
  },
  setTargets(targets: number[]) {
    set({ targets });
  },
  setHostShell(hostShell: boolean) {
    set({ hostShell });
  },
  setProvider(providerId: number) {
    set({ providerId });
  },

  /** Where the browser does what a client_action frame asks. */
  onClientAction(handler: ((action: ClientAction) => void) | null) {
    clientActionHandler = handler;
  },

  loadConversations,
  loadTodayUsage,

  newConversation() {
    if (state.streaming) return;
    set({ conversationId: null, history: [], error: null, context: null });
  },

  async openConversation(id: number) {
    if (state.streaming) return;
    try {
      const { conversation, messages } = await getAssistantConversation(id);
      set({
        conversationId: conversation.id,
        history: storedHistory(messages),
        targets: conversation.targets,
        context: conversation.context,
        error: null,
      });
    } catch (error) {
      set({ error: getErrorMessage(error, "Failed to load the conversation") });
    }
  },

  async deleteConversation(id: number) {
    await deleteAssistantConversation(id).catch(() => undefined);
    if (state.conversationId === id) assistant.newConversation();
    await loadConversations();
  },

  stop() {
    abort?.abort();
  },

  /**
   * Summarises the open conversation's earlier part now. False when it was
   * too short to gain anything.
   */
  async compact(): Promise<boolean> {
    const id = state.conversationId;
    if (!id || !state.providerId || state.streaming || state.compacting) {
      return false;
    }
    set({ compacting: true, error: null });
    try {
      const result = await compactAssistantConversation(id, state.providerId);
      if (!result.compacted) return false;
      // Reloaded so the marker sits where the summary was stored.
      await assistant.openConversation(id);
      if (result.context) set({ context: result.context });
      void loadConversations();
      void loadTodayUsage();
      return true;
    } catch (error) {
      set({ error: getErrorMessage(error, "Failed to compact") });
      return false;
    } finally {
      set({ compacting: false });
    }
  },

  async send(message: string, page: PageContext | null) {
    const text = message.trim();
    if (!text || state.streaming || !state.providerId) return;

    const controller = new AbortController();
    abort = controller;
    const run = runCount++;
    set({
      history: [...state.history, userEntry(text)],
      streaming: true,
      live: [],
      error: null,
    });

    try {
      const response = await aiApp().fetch("ops/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          providerId: state.providerId,
          conversationId: state.conversationId ?? undefined,
          // The server refuses targets from a user without a shell on hosts.
          hostIds: state.hostShell ? state.targets : undefined,
          page: page ?? undefined,
        }),
      });
      if (!response.ok) throw new Error(await readError(response));
      if (!response.body) {
        throw new Error("The assistant returned an empty response");
      }

      await readEvents(response.body, (event) => {
        if (abort !== controller) return;
        switch (event.type) {
          case "conversation":
            set({ conversationId: event.conversationId });
            break;
          case "token":
          case "reasoning":
          case "tool_call":
          case "tool_result":
          case "tool_progress":
          case "compacted":
            set({
              live: applyStreamEvent(
                state.live,
                event,
                () => `run-${run}-tool-${toolCount++}`,
              ),
            });
            break;
          case "usage":
            set({
              context: {
                promptTokens: event.usage.promptTokens,
                contextWindow:
                  event.contextWindow ?? state.context?.contextWindow ?? 0,
                estimated: event.usage.estimated,
              },
              todayTokens:
                (state.todayTokens ?? 0) +
                event.usage.promptTokens +
                event.usage.completionTokens,
            });
            break;
          case "targets":
            set({ targets: event.hostIds });
            break;
          case "client_action":
            clientActionHandler?.(event.action);
            break;
          case "error":
            set({ error: event.message });
            break;
        }
      });
      finish(controller, null);
    } catch (error) {
      finish(
        controller,
        controller.signal.aborted
          ? null
          : getErrorMessage(error, "The assistant stopped unexpectedly"),
      );
    }
  },

  /** Back to nothing, on deactivate and between tests. */
  reset() {
    abort?.abort();
    abort = null;
    ready = null;
    clientActionHandler = null;
    window.removeEventListener(AI_PROVIDERS_CHANGED_EVENT, reloadProviders);
    set(INITIAL);
  },
};

export function useAssistant(): AssistantState {
  return useSyncExternalStore(subscribe, assistant.get, assistant.get);
}
