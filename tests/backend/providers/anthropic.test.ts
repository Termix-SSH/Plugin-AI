import { describe, expect, it } from "vitest";
import { anthropicAdapter } from "../../../src/backend/providers/anthropic.js";

describe("anthropicAdapter", () => {
  it("keeps the abort signal out of the request body", async () => {
    let body: Record<string, unknown> | null = null;
    let signal: AbortSignal | null | undefined;
    const fetch = async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      signal = init?.signal;
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "stop here" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    };
    const controller = new AbortController();

    const stream = anthropicAdapter.streamChat(
      { providerType: "anthropic", apiKey: "key", fetch: fetch as never },
      {
        model: "claude-sonnet-5",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: controller.signal,
      } as never,
    );
    await expect(
      (async () => {
        for await (const _chunk of stream) {
          // drain
        }
      })(),
    ).rejects.toThrow(/400/);

    expect(body).not.toBeNull();
    expect(body).not.toHaveProperty("signal");
    expect(signal).toBeDefined();
  });
});
