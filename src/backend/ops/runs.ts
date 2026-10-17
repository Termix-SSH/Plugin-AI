import type { Response } from "express";
import { openEventStream } from "../sse.js";

/**
 * Assistant runs live here, not in the request that started them: a browser
 * that closes, reloads or loses its connection only stops watching. A run
 * ends when the model is done or the user asks it to stop.
 *
 * Kept in memory only. The stored messages are the record; this holds what a
 * browser coming back needs to show the run in progress, and is lost on a
 * restart along with the run itself.
 */

/** What a run keeps for replay; beyond it the oldest frames are dropped. */
const REPLAY_BYTES = 1024 * 1024;

export type Frame = { type: string; text?: string; [key: string]: unknown };

export interface Run {
  conversationId: number;
  /** Aborted by stop: ends the model call and whatever it has running. */
  signal: AbortSignal;
}

interface Entry extends Run {
  abort: AbortController;
  frames: Frame[];
  bytes: number;
  subscribers: Set<{ send: (frame: Frame) => void; end: () => void }>;
  ended: Promise<void>;
  markEnded: () => void;
}

const sizeOf = (frame: Frame) => JSON.stringify(frame).length;

/** Text and thinking come a few characters at a time; replay keeps one frame per stretch. */
const continues = (last: Frame | undefined, frame: Frame): last is Frame =>
  last?.type === frame.type &&
  (frame.type === "token" || frame.type === "reasoning");

export function createRunRegistry() {
  const runs = new Map<number, Entry>();

  const keep = (entry: Entry, frame: Frame) => {
    const last = entry.frames.at(-1);
    if (continues(last, frame)) {
      entry.bytes -= sizeOf(last);
      last.text = `${last.text ?? ""}${frame.text ?? ""}`;
      entry.bytes += sizeOf(last);
    } else {
      entry.frames.push({ ...frame });
      entry.bytes += sizeOf(frame);
    }
    while (entry.bytes > REPLAY_BYTES && entry.frames.length > 1) {
      entry.bytes -= sizeOf(entry.frames.shift()!);
    }
  };

  /** Streams a run to `res`: what happened so far, then live until it ends. */
  const subscribe = (run: Run, res: Response) => {
    const entry = run as Entry;
    const { send, stopHeartbeat } = openEventStream(res);
    const subscriber = {
      send,
      end: () => {
        stopHeartbeat();
        res.end();
      },
    };
    for (const frame of entry.frames) send(frame);
    entry.subscribers.add(subscriber);
    // Going away only stops the watching.
    res.on("close", () => entry.subscribers.delete(subscriber));
  };

  /** Aborts a conversation's run; resolves once it has ended. */
  const stop = async (conversationId: number) => {
    const entry = runs.get(conversationId);
    if (!entry) return;
    entry.abort.abort();
    await entry.ended;
  };

  return {
    running: (conversationId: number) => runs.has(conversationId),

    /** Registers a run, or null while the conversation already has one. */
    start(conversationId: number): Run | null {
      if (runs.has(conversationId)) return null;
      const abort = new AbortController();
      let markEnded = () => {};
      const ended = new Promise<void>((resolve) => (markEnded = resolve));
      runs.set(conversationId, {
        conversationId,
        signal: abort.signal,
        abort,
        frames: [],
        bytes: 0,
        subscribers: new Set(),
        ended,
        markEnded,
      });
      return runs.get(conversationId)!;
    },

    /**
     * Sends a frame to everyone watching and keeps it for whoever comes
     * later. client_action is not kept: a browser coming back must not open
     * the same tabs again.
     */
    send(run: Run, frame: Frame) {
      const entry = run as Entry;
      if (frame.type !== "client_action") keep(entry, frame);
      for (const subscriber of entry.subscribers) subscriber.send(frame);
    },

    subscribe,

    /**
     * Streams a conversation's run to `res`. With none going on, the stream
     * is a single done frame, so the browser knows to show what is stored.
     */
    watch(conversationId: number, res: Response) {
      const entry = runs.get(conversationId);
      if (entry) return subscribe(entry, res);
      const { send, stopHeartbeat } = openEventStream(res);
      send({ type: "done" });
      stopHeartbeat();
      res.end();
    },

    /** Ends a run that is over and lets everyone watching go. */
    finish(run: Run) {
      const entry = run as Entry;
      if (runs.get(run.conversationId) === entry) {
        runs.delete(run.conversationId);
      }
      for (const subscriber of entry.subscribers) subscriber.end();
      entry.subscribers.clear();
      entry.markEnded();
    },

    stop,

    async stopAll() {
      await Promise.all([...runs.keys()].map(stop));
    },
  };
}
