import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getAiUsage: vi.fn(),
  hasPermission: vi.fn(),
}));
vi.mock("../../src/frontend/app-ref", () => ({
  aiApp: () => ({ hasPermission: mocks.hasPermission }),
}));
vi.mock("../../src/frontend/ai-api", () => ({
  getAiUsage: mocks.getAiUsage,
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
import { UsageView } from "../../src/frontend/usage/UsageView";
import { UsageCard } from "../../src/frontend/usage/UsageCard";
import { formatTokens } from "../../src/frontend/usage/format";

const totals = (totalTokens: number, estimated = false) => ({
  promptTokens: totalTokens - 100,
  completionTokens: 100,
  totalTokens,
  calls: 3,
  estimated,
});

function summary(scope: "me" | "all") {
  return {
    scope,
    today: totals(1500),
    week: totals(42_000),
    month: totals(1_250_000, true),
    byDay: Array.from({ length: 30 }, (_, index) => ({
      day: `2026-10-${String(index + 1).padStart(2, "0")}`,
      ...totals(index * 1000),
    })),
    byModel: [{ model: "glm-5.3-flash", ...totals(1_000_000) }],
    bySource: [{ source: "assistant", ...totals(1_000_000) }],
    ...(scope === "all"
      ? { byUser: [{ userId: "user-2", ...totals(900_000) }] }
      : {}),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows the totals, the days, the models and the estimate note", async () => {
  mocks.hasPermission.mockResolvedValue(false);
  mocks.getAiUsage.mockResolvedValue(summary("me"));

  render(<UsageView />);

  expect(await screen.findByText("1.5k")).toBeTruthy();
  expect(screen.getByText("42k")).toBeTruthy();
  expect(screen.getByText("1.3M")).toBeTruthy();
  expect(screen.getByText("glm-5.3-flash")).toBeTruthy();
  expect(screen.getByText("10-30")).toBeTruthy();
  expect(screen.getByText("usage.estimatedNote")).toBeTruthy();
  expect(screen.queryByText("usage.everyone")).toBeNull();
  expect(mocks.getAiUsage).toHaveBeenCalledWith("me");
});

it("lets someone with ai.usage.view_all see every user", async () => {
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getAiUsage.mockImplementation(async (scope: "me" | "all") =>
    summary(scope),
  );

  render(<UsageView />);
  fireEvent.click(await screen.findByText("usage.everyone"));

  expect(await screen.findByText("user-2")).toBeTruthy();
  expect(mocks.getAiUsage).toHaveBeenLastCalledWith("all");
});

it("says when there is nothing yet", async () => {
  mocks.hasPermission.mockResolvedValue(false);
  mocks.getAiUsage.mockResolvedValue({
    ...summary("me"),
    month: { ...totals(0), calls: 0 },
  });

  render(<UsageView />);

  expect(await screen.findByText("usage.empty")).toBeTruthy();
});

it("shows the server's totals on the dashboard card for an admin", async () => {
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getAiUsage.mockImplementation(async (scope: "me" | "all") =>
    summary(scope),
  );

  render(<UsageCard />);

  await waitFor(() => expect(mocks.getAiUsage).toHaveBeenLastCalledWith("all"));
  expect(await screen.findByText("usage.everyoneCaption")).toBeTruthy();
});

it("formats token counts compactly", () => {
  expect(formatTokens(950)).toBe("950");
  expect(formatTokens(1000)).toBe("1k");
  expect(formatTokens(42_400)).toBe("42k");
  expect(formatTokens(128_000)).toBe("128k");
  expect(formatTokens(2_500_000)).toBe("2.5M");
});
