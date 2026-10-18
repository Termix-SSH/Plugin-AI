import { describe, expect, it } from "vitest";
import {
  buildAssistantSystemPrompt,
  buildSystemPrompt,
} from "../../src/backend/context.js";

const BASE = { hostCount: 3, allowReadOnlyCommands: false };

describe("buildSystemPrompt", () => {
  it("tells the assistant to stay inside what was asked", () => {
    // Without these the assistant answered "what is running on this server"
    // by also proposing a monitoring script and an automation nobody wanted.
    const prompt = buildSystemPrompt(BASE);

    expect(prompt).toContain("nothing beyond it");
    expect(prompt).toMatch(/Read, then report\. Do not propose anything\./);
    expect(prompt).toMatch(/no monitoring automations, no scripts/);
    expect(prompt).toMatch(/One request means one proposal at most/);
  });

  it("states that it proposes rather than applies", () => {
    const prompt = buildSystemPrompt(BASE);
    expect(prompt).toContain("cannot change anything directly");
    expect(prompt).toContain("Never claim you have done something");
  });

  it("never claims credential access", () => {
    const prompt = buildSystemPrompt(BASE);
    expect(prompt).toMatch(/no access to passwords, SSH keys, API keys/);
  });

  it("mentions read-only commands only when the user opted in", () => {
    expect(buildSystemPrompt(BASE)).not.toMatch(/read-only diagnostic/);
    expect(buildSystemPrompt({ ...BASE, allowReadOnlyCommands: true })).toMatch(
      /read-only diagnostic/,
    );
  });

  it("pluralises the host count", () => {
    expect(buildSystemPrompt({ ...BASE, hostCount: 1 })).toContain("1 host ");
    expect(buildSystemPrompt({ ...BASE, hostCount: 2 })).toContain("2 hosts");
  });

  it("includes the active tab only when there is one", () => {
    expect(buildSystemPrompt(BASE)).not.toContain("currently looking at");
    expect(buildSystemPrompt({ ...BASE, activeTab: "terminal" })).toContain(
      "currently looking at: terminal",
    );
  });
});

describe("buildAssistantSystemPrompt", () => {
  it("tells a host operator never to work around missing rights", () => {
    // In real use, without sudo the assistant reached the host's network
    // configuration through a privileged docker container.
    const prompt = buildAssistantSystemPrompt({
      targetCount: 1,
      cli: true,
      hostShell: true,
    });
    expect(prompt).toContain("Never work around it");
    expect(prompt).toContain("privileged containers");
    expect(prompt).toContain("routing, firewall or network configuration");
  });

  it("leaves host guidance out for users who cannot run commands", () => {
    const prompt = buildAssistantSystemPrompt({
      targetCount: 0,
      cli: true,
      hostShell: false,
    });
    expect(prompt).not.toContain("privileged containers");
  });
});
