/**
 * Splits <think>…</think> out of streamed answer text. Reasoning models served
 * through Ollama, vLLM or a proxy often put their thinking inline in the
 * content rather than in a field of its own, and it read as part of the
 * answer. A tag can arrive split across deltas, so a possible partial tag at
 * the end of a delta is held back until the next one.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

export type ThinkPart = { type: "text" | "reasoning"; text: string };

export function createThinkSplitter() {
  let thinking = false;
  let held = "";

  /** How much of the end of `text` could be the start of `tag`. */
  const partial = (text: string, tag: string) => {
    for (let size = Math.min(tag.length - 1, text.length); size > 0; size--) {
      if (tag.startsWith(text.slice(-size))) return size;
    }
    return 0;
  };

  return {
    push(delta: string): ThinkPart[] {
      const parts: ThinkPart[] = [];
      let text = held + delta;
      held = "";
      while (text) {
        const tag = thinking ? CLOSE : OPEN;
        const at = text.indexOf(tag);
        if (at === -1) {
          const keep = partial(text, tag);
          held = text.slice(text.length - keep);
          text = text.slice(0, text.length - keep);
          if (text) parts.push({ type: thinking ? "reasoning" : "text", text });
          break;
        }
        if (at > 0) {
          parts.push({
            type: thinking ? "reasoning" : "text",
            text: text.slice(0, at),
          });
        }
        thinking = !thinking;
        text = text.slice(at + tag.length);
      }
      return parts;
    },
    /** Whatever was held back, once the stream has ended. */
    flush(): ThinkPart[] {
      const text = held;
      held = "";
      return text ? [{ type: thinking ? "reasoning" : "text", text }] : [];
    },
  };
}
