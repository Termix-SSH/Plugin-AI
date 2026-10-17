import {
  applySummary,
  findCut,
  renderTranscript,
  SUMMARY_SYSTEM,
} from "./compaction.js";
import {
  capToolResult,
  COMPACT_AT,
  estimateRequest,
  estimateTokens,
  shrinkOldToolResults,
} from "./context-window.js";
import { getErrorMessage } from "./errors.js";
import { describeProviderError } from "./providers/http.js";
import { getAdapter } from "./providers/registry.js";
import type {
  ChatMessage,
  ProviderAdapter,
  ProviderConfig,
  ToolCall,
} from "./providers/types.js";
import { redact, redactToJson } from "./redaction.js";
import { toolDefinitions } from "./tools/catalog.js";
import {
  isProposalDraft,
  type AiTool,
  type ProposalDraft,
  type ToolContext,
} from "./tools/types.js";

/**
 * The agent loop: stream a turn, run any tools the model asked for, feed the
 * results back, repeat until the model answers without a tool or the user
 * stops it. A caller can still cap the number of turns.
 */

/** The same call with the same result this many times in a row is a loop. */
export const REPEAT_LIMIT = 5;

/** The share of the budget the verbatim tail may keep after a summary. */
const KEEP_RECENT = 0.3;

/** The share of the budget the summariser's input may take. */
const SUMMARY_INPUT = 0.6;

export type UsageSource = "assistant" | "terminal" | "compaction" | "task";

/** One model call's tokens, estimated when the provider reported none. */
export interface ModelUsage {
  source: UsageSource;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
}

export type EngineEvent =
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "proposal"; draft: ProposalDraft }
  /** A message added to the conversation, for the caller to store. */
  | { type: "message"; message: ChatMessage }
  /** After every model call, for the context meter. */
  | { type: "usage"; usage: ModelUsage; contextWindow?: number }
  /**
   * The history was summarised: `summary` now stands in for all but the last
   * `keep` messages. The caller stores it so a reload does the same.
   */
  | { type: "compacted"; summary: string; keep: number }
  | { type: "done" }
  | { type: "error"; message: string };

export interface EngineOptions {
  config: ProviderConfig;
  model: string;
  system: string;
  history: ChatMessage[];
  context: ToolContext;
  /** What the model may call this turn; availableTools() decides. */
  tools: AiTool[];
  signal?: AbortSignal;
  /** Model turns before giving up. Unset runs until the model is done. */
  maxTurns?: number;
  /**
   * The model's context in tokens, sent with every call. Set, it turns on
   * automatic compaction unless `compact` is false.
   */
  contextWindow?: number;
  /** What a prompt may take, the window less the reply. Defaults to it. */
  contextBudget?: number;
  /** The share of the budget that starts compaction. Defaults to 80%. */
  compactAt?: number;
  compact?: boolean;
  /** Where every model call is counted, compaction's included. */
  onUsage?: (usage: ModelUsage) => unknown;
  /** What the run's model calls are counted as. Defaults to "assistant". */
  source?: UsageSource;
  /** The most tokens one reply may hold. Defaults to MAX_REPLY_TOKENS. */
  maxReplyTokens?: number;
}

/**
 * A ceiling on every reply. Without one, a model that falls into a loop
 * streams until its whole window is spent: in real use GLM wrote 1.9 MB
 * for one asset annotation call over 40 minutes, and usage (and so every
 * token budget) is only reported when a reply ends.
 */
export const MAX_REPLY_TOKENS = 32_768;

interface TurnResult {
  text: string;
  reasoning: string;
  reasoningState: unknown[];
  calls: ToolCall[];
  failed: boolean;
}

/** Reports a call's usage to the caller, never failing the run over it. */
async function report(
  options: Pick<EngineOptions, "onUsage">,
  usage: ModelUsage,
): Promise<void> {
  try {
    await options.onUsage?.(usage);
  } catch {
    // Counting is best effort; the answer matters more.
  }
}

export async function* runAgent(
  options: EngineOptions,
): AsyncGenerator<EngineEvent> {
  const adapter = getAdapter(options.config.providerType);
  const tools = toolDefinitions(options.tools);
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  let messages: ChatMessage[] = options.history.map((message) =>
    message.role === "tool"
      ? { ...message, content: capToolResult(message.content) }
      : message,
  );
  const source = options.source ?? "assistant";
  // Real prompt tokens over estimated ones, from the last call, so estimates
  // made before a call track how this model actually counts.
  let calibration = 1;
  let repeat = { key: "", count: 0 };

  for (
    let turn = 0;
    options.maxTurns === undefined || turn < options.maxTurns;
    turn += 1
  ) {
    if (options.signal?.aborted) return;
    if (options.contextWindow && options.compact !== false) {
      const budget = options.contextBudget ?? options.contextWindow;
      const fits = (list: ChatMessage[]) =>
        estimateRequest({ system: options.system, messages: list, tools }) *
          calibration <=
        budget * (options.compactAt ?? COMPACT_AT);
      if (!fits(messages)) {
        messages = shrinkOldToolResults(messages);
        if (!fits(messages)) {
          const summary = await summarize({
            ...options,
            adapter,
            messages,
            budget: (budget * KEEP_RECENT) / calibration,
            inputLimit: (budget * SUMMARY_INPUT * 4) / calibration,
          });
          if (summary) {
            yield { type: "compacted", ...summary };
            messages = applySummary(messages, summary.summary, summary.keep);
          }
        }
      }
    }

    const estimate = estimateRequest({
      system: options.system,
      messages,
      tools,
    });
    const result: TurnResult = {
      text: "",
      reasoning: "",
      reasoningState: [],
      calls: [],
      failed: false,
    };
    let reported: ModelUsage | null = null;

    try {
      for await (const chunk of adapter.streamChat(options.config, {
        model: options.model,
        system: options.system,
        messages,
        tools,
        contextWindow: options.contextWindow,
        maxTokens: options.maxReplyTokens ?? MAX_REPLY_TOKENS,
        signal: options.signal,
      })) {
        if (chunk.type === "text") {
          result.text += chunk.text;
          yield { type: "token", text: chunk.text };
        } else if (chunk.type === "reasoning") {
          result.reasoning += chunk.text;
          yield { type: "reasoning", text: chunk.text };
        } else if (chunk.type === "reasoning_state") {
          result.reasoningState.push(...chunk.blocks);
        } else if (chunk.type === "usage") {
          reported = { source, ...chunk.usage, estimated: false };
        } else if (chunk.type === "tool_call") {
          result.calls.push(chunk.call);
        } else if (chunk.type === "error") {
          result.failed = true;
          yield { type: "error", message: chunk.message };
        }
      }
    } catch (error) {
      // Stopped part way, the tokens were still spent.
      await report(options, estimatedUsage(source, estimate, result));
      // The user stopped it; there is no one left to show an error to.
      if (options.signal?.aborted) return;
      const message = describeProviderError(
        error,
        "The provider request failed",
      );
      yield { type: "error", message };
      return;
    }

    const usage = reported ?? estimatedUsage(source, estimate, result);
    if (!usage.estimated && usage.promptTokens > 0) {
      calibration = usage.promptTokens / Math.max(1, estimate);
    }
    await report(options, usage);
    yield { type: "usage", usage, contextWindow: options.contextWindow };

    if (result.failed) return;

    const reasoning = result.reasoning ? { reasoning: result.reasoning } : {};

    if (!result.calls.length) {
      yield {
        type: "message",
        message: { role: "assistant", content: result.text, ...reasoning },
      };
      yield { type: "done" };
      return;
    }

    const assistant: ChatMessage = {
      role: "assistant",
      content: result.text,
      toolCalls: result.calls,
      ...reasoning,
    };
    yield { type: "message", message: assistant };
    messages.push(
      result.reasoningState.length
        ? { ...assistant, reasoningState: result.reasoningState }
        : assistant,
    );

    for (const call of result.calls) {
      if (options.signal?.aborted) return;
      yield { type: "tool_call", name: call.name, arguments: call.arguments };

      const output = await runTool(byName, call, options.context);

      if (isProposalDraft(output)) {
        // Closes the tool call before the proposal card is emitted. Without
        // this the call has no matching result and renders as permanently
        // running, even though the work is done and awaiting the user.
        yield {
          type: "tool_result",
          name: call.name,
          result: { status: "awaiting_user_approval" },
        };
        yield { type: "proposal", draft: output };
        // The model is told the proposal is awaiting the user rather than done,
        // so it does not go on to describe the change as applied.
        const pending: ChatMessage = {
          role: "tool",
          content: JSON.stringify({
            status: "awaiting_user_approval",
            summary: output.summary,
          }),
          toolCallId: call.id,
          toolName: call.name,
        };
        messages.push(pending);
        yield { type: "message", message: pending };
        continue;
      }

      yield { type: "tool_result", name: call.name, result: redact(output) };
      const answer: ChatMessage = {
        role: "tool",
        content: capToolResult(redactToJson(output)),
        toolCallId: call.id,
        toolName: call.name,
      };
      messages.push(answer);
      yield { type: "message", message: answer };

      // Only a loop that gets nowhere is stopped: the same call, the same
      // arguments and the same result, again and again.
      const key = JSON.stringify([call.name, call.arguments, answer.content]);
      repeat = { key, count: repeat.key === key ? repeat.count + 1 : 1 };
      if (repeat.count >= REPEAT_LIMIT) {
        yield {
          type: "error",
          message: `The assistant was stopped: it called ${call.name} with the same arguments and got the same result ${REPEAT_LIMIT} times in a row.`,
        };
        return;
      }
    }
  }

  // Ran out of the caller's turns with the model still calling tools.
  yield {
    type: "error",
    message: "The assistant used too many steps without finishing.",
  };
}

function estimatedUsage(
  source: UsageSource,
  promptTokens: number,
  result: TurnResult,
): ModelUsage {
  return {
    source,
    promptTokens,
    completionTokens: estimateTokens(
      result.text +
        result.reasoning +
        (result.calls.length ? JSON.stringify(result.calls) : ""),
    ),
    estimated: true,
  };
}

interface SummarizeOptions extends Pick<
  EngineOptions,
  "config" | "model" | "signal" | "onUsage" | "contextWindow"
> {
  adapter: ProviderAdapter;
  messages: ChatMessage[];
  /** Tokens the verbatim tail may keep. */
  budget: number;
  /** Characters of transcript the summariser is given at most. */
  inputLimit: number;
}

/**
 * Summarises all but the most recent steps with one model call, counted as
 * compaction. Null when there is nothing old enough to summarise or the call
 * failed, in which case the history stays as it was.
 */
async function summarize(
  options: SummarizeOptions,
): Promise<{ summary: string; keep: number } | null> {
  const { messages } = options;
  const cut = findCut(messages, options.budget);
  // One message, or none, before the cut: nothing to win.
  if (cut <= 1) return null;

  const input = renderTranscript(messages.slice(0, cut), options.inputLimit);
  const request = {
    model: options.model,
    system: SUMMARY_SYSTEM,
    messages: [{ role: "user" as const, content: input }],
    tools: [],
    contextWindow: options.contextWindow,
    maxTokens: MAX_REPLY_TOKENS,
    signal: options.signal,
  };
  let text = "";
  let usage: ModelUsage | null = null;
  try {
    for await (const chunk of options.adapter.streamChat(
      options.config,
      request,
    )) {
      if (chunk.type === "text") text += chunk.text;
      else if (chunk.type === "usage") {
        usage = { source: "compaction", ...chunk.usage, estimated: false };
      } else if (chunk.type === "error") return null;
    }
  } catch {
    return null;
  } finally {
    await report(
      options,
      usage ?? {
        source: "compaction",
        promptTokens: estimateRequest(request),
        completionTokens: estimateTokens(text),
        estimated: true,
      },
    );
  }
  text = text.trim();
  return text ? { summary: text, keep: messages.length - cut } : null;
}

/**
 * Compaction on request, from the header button: the conversation's earlier
 * part summarised whatever its size, keeping the most recent steps.
 */
export async function compactHistory(
  options: Pick<
    EngineOptions,
    "config" | "model" | "signal" | "onUsage" | "history" | "contextBudget"
  > & { contextWindow: number },
): Promise<{ summary: string; keep: number; history: ChatMessage[] } | null> {
  const messages = options.history;
  const size = estimateRequest({ system: "", messages, tools: [] });
  const budget = options.contextBudget ?? options.contextWindow;
  const summary = await summarize({
    ...options,
    adapter: getAdapter(options.config.providerType),
    messages,
    budget: Math.min(budget, size) * KEEP_RECENT,
    inputLimit: budget * SUMMARY_INPUT * 4,
  });
  if (!summary) return null;
  return {
    ...summary,
    history: applySummary(messages, summary.summary, summary.keep),
  };
}

async function runTool(
  tools: Map<string, AiTool>,
  call: ToolCall,
  context: ToolContext,
): Promise<unknown> {
  const tool = tools.get(call.name);

  // A model can emit any name it likes; only what was offered runs.
  if (!tool) {
    return { error: `Unknown tool: ${call.name}` };
  }

  try {
    return await tool.handler(call.arguments ?? {}, context);
  } catch (error) {
    return {
      error: getErrorMessage(error, "The tool failed"),
    };
  }
}
