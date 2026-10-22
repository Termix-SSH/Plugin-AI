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
  stopAssistantConversation,
  type AiMessage,
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
 * The one assistant behind the floating panel and the AI tab. Runs go on on
 * the server whatever the browser does; this only watches them. It lives
 * outside React, so closing the panel or the tab keeps the stream here, and
 * after a reload it joins the run of the conversation the user left open.
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
/** Whose conversation is remembered across reloads; null until resume. */
let userKey: string | null = null;
/** Stop was asked for before the run's conversation was known. */
let stopRequested = false;

const conversationKey = (user: string) =>
  `termix-ai:assistant-conversation:${user}`;

const providerKey = (user: string | null) =>
  `termix-ai:assistant-provider:${user ?? ""}`;

function rememberedProvider(): number | null {
  try {
    const id = Number(localStorage.getItem(providerKey(userKey)));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function set(patch: Partial<AssistantState>) {
  state = { ...state, ...patch };
  if (userKey && "conversationId" in patch)
    remember(userKey, patch.conversationId);
  for (const listener of listeners) listener();
}

function remember(user: string, id: number | null | undefined) {
  try {
    if (id) localStorage.setItem(conversationKey(user), String(id));
    else localStorage.removeItem(conversationKey(user));
  } catch {
    // Storage may be off; the conversation is just not remembered.
  }
}

function remembered(user: string): number | null {
  try {
    const id = Number(localStorage.getItem(conversationKey(user)));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function loadProviders() {
  const providers = await getAiProviders().catch(() => []);
  const known = (id: number | null) =>
    id !== null && providers.some((entry) => entry.id === id);
  const current = state.providerId;
  const saved = rememberedProvider();
  set({
    providers,
    providerId: known(current)
      ? current
      : known(saved)
        ? saved
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

function requestStop(id: number) {
  // Unreachable server: stop watching at least, rather than spin forever.
  stopAssistantConversation(id).catch(() => abort?.abort());
}

/** One frame of a run, fresh or joined part way, into the store. */
// Frames are typed by their consumer, as in readEvents.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFrame(event: any, run: number) {
  switch (event.type) {
    case "conversation":
      set({ conversationId: event.conversationId });
      if (stopRequested) requestStop(event.conversationId);
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
          contextSource: event.contextSource ?? state.context?.contextSource,
          reservedOutput: event.reservedOutput ?? state.context?.reservedOutput,
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
}

/**
 * Watches a run's stream until it ends. Aborting the request only stops the
 * watching; the run is stopped by asking the server.
 */
async function follow(request: (signal: AbortSignal) => Promise<Response>) {
  const controller = new AbortController();
  abort = controller;
  stopRequested = false;
  const run = runCount++;
  try {
    const response = await request(controller.signal);
    if (!response.ok) throw new Error(await readError(response));
    if (!response.body) {
      throw new Error("The assistant returned an empty response");
    }
    await readEvents(response.body, (event) => {
      if (abort === controller) applyFrame(event, run);
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
}

/** What was stored before the run going on; its stream brings the rest. */
function beforeRun(messages: AiMessage[]): AiMessage[] {
  return messages.slice(
    0,
    messages.findLastIndex((m) => m.role === "user") + 1,
  );
}

/** Shows a stored conversation, and joins its run when one is going on. */
async function show(id: number, join = true) {
  const { conversation, messages } = await getAssistantConversation(id);
  const running = join && conversation.running;
  set({
    conversationId: conversation.id,
    history: storedHistory(running ? beforeRun(messages) : messages),
    targets: conversation.targets,
    context: conversation.context,
    error: null,
  });
  if (running) void attach(id);
}

async function attach(id: number) {
  set({ streaming: true, live: [], error: null });
  await follow((signal) =>
    aiApp().fetch(`ops/conversations/${id}/stream`, { signal }),
  );
  // Replay drops the start of a very long run; the stored record is whole.
  if (state.conversationId === id && !state.streaming) {
    await show(id, false).catch(() => undefined);
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
    try {
      localStorage.setItem(providerKey(userKey), String(providerId));
    } catch {
      // Storage may be off; the choice just is not remembered.
    }
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

  /**
   * Picks up where the user left off after a reload: the conversation they
   * had open, and its run if one is going on. Once per user.
   */
  resume(user: string) {
    if (userKey === user) return;
    userKey = user;
    const id = remembered(user);
    if (!id || state.conversationId !== null || state.streaming) return;
    // Gone, or the assistant is off for them: start from nothing.
    show(id).catch(() => remember(user, null));
  },

  async openConversation(id: number) {
    if (state.streaming) return;
    try {
      await show(id);
    } catch (error) {
      set({ error: getErrorMessage(error, "Failed to load the conversation") });
    }
  },

  async deleteConversation(id: number) {
    await deleteAssistantConversation(id).catch(() => undefined);
    if (state.conversationId === id) assistant.newConversation();
    await loadConversations();
  },

  /** Stops the run on the server; its stream then ends as usual. */
  stop() {
    if (!state.streaming) return;
    stopRequested = true;
    if (state.conversationId) requestStop(state.conversationId);
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

    set({
      history: [...state.history, userEntry(text)],
      streaming: true,
      live: [],
      error: null,
    });
    const body = JSON.stringify({
      message: text,
      providerId: state.providerId,
      conversationId: state.conversationId ?? undefined,
      // The server refuses targets from a user without a shell on hosts.
      hostIds: state.hostShell ? state.targets : undefined,
      page: page ?? undefined,
    });
    await follow((signal) =>
      aiApp().fetch("ops/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body,
      }),
    );
  },

  /** Back to nothing, on deactivate and between tests. */
  reset() {
    abort?.abort();
    abort = null;
    ready = null;
    clientActionHandler = null;
    // Cleared first, so resetting forgets nothing the next session needs.
    userKey = null;
    stopRequested = false;
    window.removeEventListener(AI_PROVIDERS_CHANGED_EVENT, reloadProviders);
    set(INITIAL);
  },
};

export function useAssistant(): AssistantState {
  return useSyncExternalStore(subscribe, assistant.get, assistant.get);
}
