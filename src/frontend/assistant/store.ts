import { useSyncExternalStore } from "react";
import type { ClientAction } from "../../backend/ops/assistant-tools";
import type { PageContext } from "../../backend/context";
import {
  AI_PROVIDERS_CHANGED_EVENT,
  deleteAssistantConversation,
  getAiProviders,
  getAiStatus,
  getAssistantConversation,
  getOpsFleets,
  listAssistantConversations,
  setAiOptIn,
  type AiProvider,
  type AssistantConversation,
  type OpsFleet,
} from "../ai-api";
import { aiApp } from "../app-ref";
import { getErrorMessage } from "../errors";
import {
  finishedRunEntries,
  storedHistory,
  userEntry,
  type HistoryEntry,
} from "../transcript";
import {
  readEvents,
  withProgress,
  withResult,
  type ToolActivity,
} from "../use-ai-stream";

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
  history: HistoryEntry[];
  streaming: boolean;
  assistantText: string;
  tools: ToolActivity[];
  error: string | null;
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
  assistantText: "",
  tools: [],
  error: null,
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
}

function finish(
  controller: AbortController,
  reply: string,
  tools: ToolActivity[],
  error: string | null,
) {
  // Superseded by a newer conversation; this run's state is already gone.
  if (abort !== controller) return;
  abort = null;
  set({
    history: [
      ...state.history,
      ...finishedRunEntries(runCount++, tools, reply),
    ],
    streaming: false,
    assistantText: "",
    tools: [],
    ...(error ? { error } : {}),
  });
  void loadConversations();
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

  newConversation() {
    if (state.streaming) return;
    set({ conversationId: null, history: [], error: null });
  },

  async openConversation(id: number) {
    if (state.streaming) return;
    try {
      const { conversation, messages } = await getAssistantConversation(id);
      set({
        conversationId: conversation.id,
        history: storedHistory(messages),
        targets: conversation.targets,
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

  async send(message: string, page: PageContext | null) {
    const text = message.trim();
    if (!text || state.streaming || !state.providerId) return;

    const controller = new AbortController();
    abort = controller;
    let reply = "";
    let tools: ToolActivity[] = [];
    let sequence = 0;
    set({
      history: [...state.history, userEntry(text)],
      streaming: true,
      assistantText: "",
      tools: [],
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
            reply += event.text;
            set({ assistantText: reply });
            break;
          case "tool_call":
            tools = [
              ...tools,
              {
                id: `tool-${sequence++}`,
                name: event.name,
                arguments: event.arguments ?? {},
              },
            ];
            set({ tools });
            break;
          case "tool_result":
            tools = withResult(tools, event.name, event.result);
            set({ tools });
            break;
          case "tool_progress":
            tools = withProgress(tools, event.name, event.host);
            set({ tools });
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
      finish(controller, reply, tools, null);
    } catch (error) {
      finish(
        controller,
        reply,
        tools,
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
