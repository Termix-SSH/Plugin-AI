import { describe, expect, it, vi } from "vitest";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  resolve: vi.fn(),
  config: vi.fn(),
}));
vi.mock("../../../src/backend/engine.js", () => ({ runAgent: mocks.run }));
vi.mock("../../../src/backend/tasks/runner.js", () => ({
  resolveProvider: mocks.resolve,
  providerConfig: mocks.config,
}));
import { createExposureExplainer } from "../../../src/backend/exposure/explain.js";
import { derived, observation } from "./fixtures.js";
describe("evidence-only model interpretation", () => {
  it("uses one bounded call, no execution tools, and records actual usage", async () => {
    const mock = createMockCtx({ settings: { globallyEnabled: true } });
    mocks.resolve.mockResolvedValue({ provider: { id: 1 }, model: "test" });
    mocks.config.mockResolvedValue({ providerType: "openai" });
    mocks.run.mockImplementation(async function* (options) {
      await options.onUsage({
        source: "assets",
        promptTokens: 90,
        completionTokens: 15,
        estimated: false,
      });
      yield { type: "token", text: "External reachability remains untested." };
    });
    const repository = { recordUsage: vi.fn() };
    const explain = createExposureExplainer(mock.ctx, repository as never);
    const text = await explain(
      derived(observation())[0],
      new AbortController().signal,
    );
    expect(text).toContain("untested");
    expect(mocks.run.mock.calls.at(-1)![0]).toMatchObject({
      tools: [],
      maxTurns: 1,
      maxReplyTokens: 2048,
      source: "assets",
    });
    expect(mocks.run.mock.calls.at(-1)![0].system).toContain("untrusted data");
    expect(repository.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 90,
        completionTokens: 15,
        estimated: false,
      }),
    );
  });
  it("rejects a missing provider without changing facts", async () => {
    const mock = createMockCtx();
    mocks.resolve.mockResolvedValue(null);
    const entry = derived(observation())[0];
    const saved = JSON.stringify(entry);
    await expect(
      createExposureExplainer(mock.ctx, {} as never)(
        entry,
        new AbortController().signal,
      ),
    ).rejects.toThrow("No configured model");
    expect(JSON.stringify(entry)).toBe(saved);
  });
});
