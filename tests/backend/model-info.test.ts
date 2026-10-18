import { beforeEach, describe, expect, it, vi } from "vitest";
import { planContext } from "../../src/backend/context-window.js";
import {
  contextPlanFor,
  createModelInfoCache,
} from "../../src/backend/model-info.js";
import { geminiAdapter } from "../../src/backend/providers/gemini.js";
import { ollamaAdapter } from "../../src/backend/providers/ollama.js";
import { openAiAdapter } from "../../src/backend/providers/openai.js";
import type { ProviderConfig } from "../../src/backend/providers/types.js";

const fetch = vi.fn();
beforeEach(() => {
  fetch.mockReset();
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

const config = (
  providerType: ProviderConfig["providerType"],
): ProviderConfig => ({
  providerType,
  baseUrl: "https://llm.example/v1",
  apiKey: "key",
  fetch,
});

describe("model metadata from OpenAI-compatible model lists", () => {
  const describe_ = (entry: Record<string, unknown>) => {
    fetch.mockResolvedValue(json({ data: [{ id: "other" }, entry] }));
    return openAiAdapter.describeModel(config("openai_compatible"), "m");
  };

  it("reads vLLM's max_model_len", async () => {
    expect(await describe_({ id: "m", max_model_len: 524288 })).toEqual({
      contextWindow: 524288,
      maxOutputTokens: undefined,
    });
    expect(fetch.mock.calls[0][0]).toBe("https://llm.example/v1/models");
  });

  it("reads OpenRouter's context_length and top_provider", async () => {
    expect(
      await describe_({
        id: "m",
        context_length: 200000,
        top_provider: { context_length: 100000, max_completion_tokens: 32000 },
      }),
    ).toEqual({ contextWindow: 200000, maxOutputTokens: 32000 });
    expect(
      await describe_({ id: "m", top_provider: { context_length: 100000 } }),
    ).toMatchObject({ contextWindow: 100000 });
  });

  it("reads Groq's context_window and max_completion_tokens", async () => {
    expect(
      await describe_({
        id: "m",
        context_window: 131072,
        max_completion_tokens: 8192,
      }),
    ).toEqual({ contextWindow: 131072, maxOutputTokens: 8192 });
  });

  it("reports nothing for a model the list does not have", async () => {
    fetch.mockResolvedValue(json({ data: [{ id: "other" }] }));
    expect(await openAiAdapter.describeModel(config("openai"), "m")).toEqual(
      {},
    );
  });
});

describe("model metadata from Ollama", () => {
  it("reads the trained length from model_info and num_ctx", async () => {
    fetch.mockResolvedValue(
      json({
        parameters: 'stop "<|eot_id|>"\nnum_ctx                        8192',
        model_info: {
          "general.architecture": "llama",
          "llama.context_length": 131072,
        },
      }),
    );
    const info = await ollamaAdapter.describeModel(config("ollama"), "llama3");
    expect(info).toEqual({ contextWindow: 8192, contextLimit: 131072 });
    expect(fetch.mock.calls[0][0]).toBe("https://llm.example/v1/api/show");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      model: "llama3",
    });
  });

  it("falls back to the trained length without num_ctx", async () => {
    fetch.mockResolvedValue(
      json({ model_info: { "qwen3.context_length": 40960 } }),
    );
    expect(await ollamaAdapter.describeModel(config("ollama"), "q")).toEqual({
      contextWindow: 40960,
      contextLimit: 40960,
    });
  });
});

describe("model metadata from Gemini", () => {
  it("reads inputTokenLimit and outputTokenLimit", async () => {
    fetch.mockResolvedValue(
      json({ inputTokenLimit: 1048576, outputTokenLimit: 65536 }),
    );
    const info = await geminiAdapter.describeModel(
      { ...config("gemini"), baseUrl: null },
      "gemini-2.5-pro",
    );
    expect(info).toEqual({ contextWindow: 1048576, maxOutputTokens: 65536 });
    expect(fetch.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro",
    );
  });
});

describe("planContext", () => {
  const plan = (
    info: Parameters<typeof planContext>[0]["info"],
    overrides = {},
    model = "glm-5.3-flash",
    adapter = {},
  ) => planContext({ model, overrides, info, adapter });

  it("prefers an override, then the provider, then the family, then 128k", () => {
    const override = { "glm-5.3-flash": { contextWindow: 64000 } };
    expect(plan({ contextWindow: 524288 }, override)).toMatchObject({
      contextWindow: 64000,
      source: "override",
    });
    expect(plan({ contextWindow: 524288 })).toMatchObject({
      contextWindow: 524288,
      source: "provider",
    });
    expect(plan({})).toMatchObject({ contextWindow: 200000, source: "guess" });
    expect(plan({}, {}, "brand-new")).toMatchObject({
      contextWindow: 128000,
      source: "default",
    });
  });

  it("holds an override to what the model can take", () => {
    const override = { m: { contextWindow: 262144 } };
    expect(
      plan({ contextWindow: 8192, contextLimit: 131072 }, override, "m"),
    ).toMatchObject({ contextWindow: 131072, source: "override" });
    expect(plan({ contextWindow: 32768 }, override, "m")).toMatchObject({
      contextWindow: 32768,
    });
  });

  it("keeps the reply's tokens and a margin out of the budget", () => {
    // Nothing reported: 8k for the reply, 2% margin.
    expect(plan({ contextWindow: 524288 })).toMatchObject({
      reservedOutput: 8192,
      budget: Math.floor(524288 - 8192 - 524288 * 0.02),
      compactAt: 0.8,
    });
    // The smaller of what the provider allows and the adapter asks for.
    expect(
      plan({ contextWindow: 200000, maxOutputTokens: 64000 }, {}, "c", {
        maxTokens: 16000,
        compactAt: 0.85,
      }),
    ).toMatchObject({ reservedOutput: 16000, compactAt: 0.85 });
    expect(
      plan({ contextWindow: 1048576, maxOutputTokens: 65536 }),
    ).toMatchObject({ reservedOutput: 65536 });
    // Never more than a quarter of the window.
    expect(
      plan({ contextWindow: 16384, maxOutputTokens: 16384 }),
    ).toMatchObject({ reservedOutput: 4096 });
  });
});

describe("model info cache", () => {
  const models = (window: number) =>
    json({ data: [{ id: "m", max_model_len: window }] });

  it("asks once per provider and model until the TTL runs out", async () => {
    let now = 0;
    const cache = createModelInfoCache({ ttlMs: 1000 }, () => now);
    fetch.mockResolvedValueOnce(models(524288));
    const target = config("openai_compatible");

    expect(await cache.get(1, target, "m")).toEqual({
      contextWindow: 524288,
      maxOutputTokens: undefined,
    });
    await cache.get(1, target, "m");
    expect(fetch).toHaveBeenCalledTimes(1);

    now = 1001;
    fetch.mockResolvedValueOnce(models(262144));
    expect((await cache.get(1, target, "m")).contextWindow).toBe(262144);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("forgets a provider when it is invalidated", async () => {
    const cache = createModelInfoCache();
    fetch.mockResolvedValue(models(524288));
    const target = config("openai_compatible");
    await cache.get(1, target, "m");
    await cache.get(2, target, "m");

    cache.invalidate(1);
    await cache.get(1, target, "m");
    await cache.get(2, target, "m");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("falls back silently and asks again sooner after a failure", async () => {
    let now = 0;
    const cache = createModelInfoCache({ retryMs: 100 }, () => now);
    fetch.mockRejectedValueOnce(new Error("fetch failed"));
    const target = config("openai_compatible");

    const plan = await contextPlanFor(
      cache,
      { id: 1, modelOverrides: {} },
      target,
      "glm-5.3-flash",
    );
    expect(plan).toMatchObject({ contextWindow: 200000, source: "guess" });

    now = 101;
    fetch.mockResolvedValueOnce(
      json({ data: [{ id: "glm-5.3-flash", max_model_len: 524288 }] }),
    );
    expect(
      await contextPlanFor(
        cache,
        { id: 1, modelOverrides: {} },
        target,
        "glm-5.3-flash",
      ),
    ).toMatchObject({ contextWindow: 524288, source: "provider" });
  });

  it("gives up on a provider that does not answer in time", async () => {
    const cache = createModelInfoCache({ timeoutMs: 20 });
    fetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        ),
    );
    expect(await cache.get(1, config("openai_compatible"), "m")).toEqual({});
  });
});
