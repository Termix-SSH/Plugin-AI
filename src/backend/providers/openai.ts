import { assertOk, firstCount, joinUrl, readSseLines } from "./http.js";
import {
  cappedMaxTokens,
  streamResponses,
  usesResponsesApi,
} from "./openai-responses.js";
import { createThinkSplitter } from "./think-tags.js";
import type {
  ChatChunk,
  ChatRequest,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig,
  ToolCall,
} from "./types.js";
import { AiProviderError } from "./types.js";

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

function baseFor(config: ProviderConfig): string {
  if (config.baseUrl?.trim()) return config.baseUrl.trim();
  if (config.providerType === "openai") return OPENAI_DEFAULT_BASE;
  throw new AiProviderError("This provider needs a base URL");
}

function toOpenAiMessages(request: ChatRequest): unknown[] {
  const messages: unknown[] = [{ role: "system", content: request.system }];

  for (const message of request.messages) {
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      messages.push({
        role: "assistant",
        content: message.content || null,
        // Reasoning endpoints (DeepSeek, GLM) want this run's thinking back
        // with its tool calls; reasoningState is only set within the run.
        ...(message.reasoningState?.length
          ? (message.reasoningState[0] as object)
          : {}),
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      });
      continue;
    }

    messages.push({ role: message.role, content: message.content });
  }

  return messages;
}

/**
 * Tool call arguments arrive as JSON fragments spread across many deltas, so
 * they are accumulated per index and only parsed once the stream ends.
 */
interface PartialCall {
  id: string;
  name: string;
  args: string;
}

export const openAiAdapter: ProviderAdapter = {
  async *streamChat(
    config: ProviderConfig,
    request: ChatRequest,
  ): AsyncIterable<ChatChunk> {
    const url = joinUrl(baseFor(config), "chat/completions");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    if (usesResponsesApi(config)) {
      yield* streamResponses(
        config,
        request,
        joinUrl(baseFor(config), "responses"),
        headers,
      );
      return;
    }

    const advanced = config.advanced;
    const maxTokens = cappedMaxTokens(advanced?.maxOutputTokens, request);
    let temperature = advanced?.temperature;
    // OpenAI's reasoning models take temperature only with effort none.
    if (
      temperature !== undefined &&
      config.providerType === "openai" &&
      advanced?.reasoningEffort !== undefined &&
      advanced.reasoningEffort !== "none"
    ) {
      config.log?.warn(
        `OpenAI skipped temperature for ${request.model} because reasoning effort is ${advanced.reasoningEffort}; temperature requires reasoning effort none.`,
      );
      temperature = undefined;
    }

    let body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAiMessages(request),
      stream: true,
      // Asks for a final usage chunk. A compatible server that rejects the
      // option is asked again without it.
      stream_options: { include_usage: true },
      // OpenAI's own API refuses max_tokens for its reasoning models;
      // compatible servers (vLLM, LM Studio, Groq, OpenRouter) know max_tokens.
      ...(maxTokens
        ? config.providerType === "openai"
          ? { max_completion_tokens: maxTokens }
          : { max_tokens: maxTokens }
        : {}),
      ...(advanced?.reasoningEffort !== undefined
        ? { reasoning_effort: advanced.reasoningEffort }
        : {}),
      ...(advanced?.verbosity !== undefined
        ? { verbosity: advanced.verbosity }
        : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(request.tools.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
    };
    const post = (payload: object) =>
      config.fetch(url, {
        method: "POST",
        headers,
        signal: request.signal,
        body: JSON.stringify(payload),
      });

    let response = await post(body);
    // A server can refuse an option it does not know, or OpenAI's newer
    // models refuse tools with their default reasoning effort. Ask again
    // without the option, or with reasoning off.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (response.status !== 400 && response.status !== 422) break;
      const detail = await response.text().catch(() => "");
      if (/stream_options/i.test(detail) && body.stream_options) {
        const { stream_options: _dropped, ...rest } = body;
        body = rest;
      } else if (
        /temperature/i.test(detail) &&
        body.temperature !== undefined
      ) {
        config.log?.warn(
          `OpenAI refused temperature for ${request.model}, continuing without it: ${detail.slice(0, 300)}`,
        );
        const { temperature: _dropped, ...rest } = body;
        body = rest;
      } else if (
        /reasoning_effort/i.test(detail) &&
        /tools/i.test(detail) &&
        !body.reasoning_effort
      ) {
        body = { ...body, reasoning_effort: "none" };
      } else {
        response = new Response(detail, {
          status: response.status,
          statusText: response.statusText,
        });
        break;
      }
      response = await post(body);
    }

    await assertOk(response, "OpenAI");

    const partial = new Map<number, PartialCall>();
    const think = createThinkSplitter();
    let stopReason: string | undefined;
    let usage: { prompt_tokens?: number; completion_tokens?: number } | null =
      null;
    let reasoning = "";

    for await (const data of readSseLines(response)) {
      if (data === "[DONE]") break;

      let frame: any;
      try {
        frame = JSON.parse(data);
      } catch {
        continue;
      }

      // The usage chunk has no choices; some servers put usage on the last
      // content chunk instead, or on every chunk as a running total.
      if (frame.usage) usage = frame.usage;

      const choice = frame.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) stopReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      // DeepSeek and GLM send reasoning_content, OpenRouter and Ollama's
      // OpenAI endpoint send reasoning.
      const thought = delta.reasoning_content ?? delta.reasoning;
      if (typeof thought === "string" && thought) {
        reasoning += thought;
        yield { type: "reasoning", text: thought };
      }

      if (typeof delta.content === "string" && delta.content) {
        yield* think.push(delta.content);
      }

      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const existing = partial.get(index) ?? { id: "", name: "", args: "" };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.name = call.function.name;
        if (call.function?.arguments) existing.args += call.function.arguments;
        partial.set(index, existing);
      }
    }

    yield* think.flush();

    for (const call of partial.values()) {
      if (!call.name) continue;
      yield { type: "tool_call", call: finalizeCall(call) };
    }

    if (reasoning) {
      yield {
        type: "reasoning_state",
        blocks: [{ reasoning_content: reasoning }],
      };
    }
    if (usage) {
      yield {
        type: "usage",
        usage: {
          promptTokens: Number(usage.prompt_tokens) || 0,
          completionTokens: Number(usage.completion_tokens) || 0,
        },
      };
    }

    yield { type: "done", stopReason };
  },

  async listModels(config: ProviderConfig): Promise<string[]> {
    return (await fetchModels(config))
      .map((entry: any) => entry.id)
      .filter((id: unknown): id is string => typeof id === "string")
      .sort();
  },

  /**
   * Read from the same model list. Servers name the window differently:
   * vLLM and SGLang max_model_len, OpenRouter and LM Studio context_length,
   * Groq and Together context_window.
   */
  async describeModel(
    config: ProviderConfig,
    model: string,
  ): Promise<ModelInfo> {
    const entry = (await fetchModels(config)).find(
      (candidate: any) => candidate?.id === model,
    );
    if (!entry) return {};
    return {
      contextWindow: firstCount(
        entry.max_model_len,
        entry.context_length,
        entry.top_provider?.context_length,
        entry.context_window,
        entry.max_context_length,
        entry.input_token_limit,
      ),
      maxOutputTokens: firstCount(
        entry.top_provider?.max_completion_tokens,
        entry.max_completion_tokens,
        entry.max_output_tokens,
      ),
    };
  },
};

async function fetchModels(config: ProviderConfig): Promise<any[]> {
  const headers: Record<string, string> = {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await config.fetch(joinUrl(baseFor(config), "models"), {
    method: "GET",
    headers,
  });
  await assertOk(response, "OpenAI");

  const body: any = await response.json();
  return Array.isArray(body.data) ? body.data : [];
}

function finalizeCall(call: PartialCall): ToolCall {
  let args: Record<string, unknown> = {};
  if (call.args.trim()) {
    try {
      const parsed = JSON.parse(call.args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // A model that emitted malformed arguments gets an empty object; the
      // tool's own schema validation reports the problem back to it.
      args = {};
    }
  }
  return {
    id:
      call.id || `call_${call.name}_${Math.random().toString(36).slice(2, 10)}`,
    name: call.name,
    arguments: args,
  };
}
