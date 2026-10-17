import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  listTasks: vi.fn(),
  getTask: vi.fn(),
  approveTask: vi.fn(),
  rejectTask: vi.fn(),
  listPresets: vi.fn(),
  enablePreset: vi.fn(),
  savePreset: vi.fn(),
  getPreferences: vi.fn(),
  savePreferences: vi.fn(),
}));
vi.mock("../../src/frontend/autoops/api", () => ({
  apiMessage: (_error: unknown, fallback: string) => fallback,
  listTasks: mocks.listTasks,
  getTask: mocks.getTask,
  approveTask: mocks.approveTask,
  rejectTask: mocks.rejectTask,
  listPresets: mocks.listPresets,
  enablePreset: mocks.enablePreset,
  savePreset: mocks.savePreset,
  deletePreset: vi.fn(),
  getPreferences: mocks.getPreferences,
  savePreferences: mocks.savePreferences,
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.name ? `${key}:${values.name}` : key,
    language: "zh_CN",
  }),
  useHosts: () => ({ loaded: true, hosts: [] }),
}));
vi.mock("../../src/frontend/AiMessage", () => ({
  AiMessage: ({ content }: { content: string }) => <p>{content}</p>,
}));
import {
  AutoOpsView,
  newestUnseen,
  SEEN_KEY,
} from "../../src/frontend/autoops/AutoOpsView";
import {
  cronToTime,
  timeToCron,
} from "../../src/frontend/autoops/EnablePresetView";

const task = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  userId: "user-1",
  mine: true,
  automationId: 7,
  presetId: "disk-cleanup",
  title: "Disk cleanup · web-1",
  autonomy: "propose",
  status: "reported",
  severity: "warning",
  summary: "Disk at 87%",
  hostIds: [1],
  dryRun: false,
  conversationId: 12,
  promptTokens: 4000,
  completionTokens: 200,
  totalTokens: 4200,
  createdAt: "2026-10-17T08:00:00.000Z",
  finishedAt: "2026-10-17T08:01:05.000Z",
  expiresAt: null,
  ...overrides,
});

const PRESET = {
  id: "disk-cleanup",
  version: 1,
  autonomy: "propose",
  trigger: {
    kind: "metric_threshold",
    hostSelector: { kind: "all" },
    metric: { path: "disk.percent" },
    operator: ">=",
    value: 85,
    forSeconds: 300,
    cooldownMinutes: 60,
  },
  hostSelector: { kind: "trigger" },
  maxRunSeconds: 900,
  runbook: "Clean safely.",
  enabled: [],
  updateAvailable: false,
};

beforeEach(() => {
  localStorage.setItem(SEEN_KEY, String(Date.now()));
  mocks.listTasks.mockResolvedValue({ tasks: [task()], approvals: [] });
  mocks.listPresets.mockResolvedValue({
    automationsAvailable: true,
    presets: [PRESET],
    custom: [],
  });
  const preferences = { providerId: null, model: null, language: "zh_CN" };
  mocks.getPreferences.mockResolvedValue(preferences);
  mocks.savePreferences.mockResolvedValue(preferences);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

it("lists tasks with their summary and keeps the report language current", async () => {
  render(<AutoOpsView onOpenConversation={() => undefined} />);
  expect(await screen.findByText("Disk cleanup · web-1")).toBeTruthy();
  expect(screen.getByText("Disk at 87%")).toBeTruthy();
  expect(screen.getByText(/1m 5s/)).toBeTruthy();
  expect(mocks.savePreferences).toHaveBeenCalledWith({ language: "zh_CN" });
});

it("opens a task's report and its conversation in the assistant", async () => {
  mocks.getTask.mockResolvedValue({
    ...task(),
    trigger: { summary: "disk.percent 87%" },
    report: "## Verdict\nCaches fill the disk",
    plan: null,
    decidedBy: null,
    decidedAt: null,
    hostNames: { 1: "web-1" },
    canDecide: false,
  });
  const open = vi.fn();
  render(<AutoOpsView onOpenConversation={open} />);
  fireEvent.click(await screen.findByText("Disk cleanup · web-1"));
  expect(await screen.findByText(/Caches fill the disk/)).toBeTruthy();
  expect(screen.getByText("autoOps.tokenUsage")).toBeTruthy();
  fireEvent.click(screen.getByText("autoOps.openConversation"));
  expect(open).toHaveBeenCalledWith(12);
});

it("shows a plan waiting for approval and approves it", async () => {
  const proposed = task({
    id: 2,
    status: "proposed",
    expiresAt: "2026-10-18T08:00:00.000Z",
  });
  mocks.listTasks.mockResolvedValue({ tasks: [], approvals: [proposed] });
  mocks.getTask.mockResolvedValue({
    ...proposed,
    trigger: {},
    report: null,
    plan: [
      {
        hostId: 1,
        commands: ["docker image prune -f"],
        rationale: "2G dangling",
        risk: "Low",
        rollback: "Pulled again",
        verify: ["docker system df"],
      },
    ],
    decidedBy: null,
    decidedAt: null,
    hostNames: { 1: "web-1" },
    canDecide: true,
  });
  mocks.approveTask.mockResolvedValue(undefined);
  localStorage.setItem(SEEN_KEY, "0");
  render(<AutoOpsView onOpenConversation={() => undefined} />);

  // New since the last visit: it opens straight away, on Approvals.
  expect(await screen.findByText("docker image prune -f")).toBeTruthy();
  expect(screen.getByText("2G dangling")).toBeTruthy();
  expect(screen.getByText("docker system df")).toBeTruthy();
  fireEvent.click(screen.getByText("autoOps.approve"));
  await waitFor(() => expect(mocks.approveTask).toHaveBeenCalledWith(2));
});

it("marks presets as needing Automations when it is missing", async () => {
  mocks.listTasks.mockResolvedValue({ tasks: [], approvals: [] });
  mocks.listPresets.mockResolvedValue({
    automationsAvailable: false,
    presets: [PRESET],
    custom: [],
  });
  render(<AutoOpsView onOpenConversation={() => undefined} />);
  expect(await screen.findByText("autoOps.needsAutomations")).toBeTruthy();
  const button = screen.getByRole("button", {
    name: "autoOps.enable.submit",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
});

it("enables a preset with the threshold the user confirmed", async () => {
  mocks.listTasks.mockResolvedValue({ tasks: [], approvals: [] });
  mocks.enablePreset.mockResolvedValue(undefined);
  render(<AutoOpsView onOpenConversation={() => undefined} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "autoOps.enable.submit" }),
  );
  await screen.findByText("autoOps.enable.threshold");
  // Threshold, then duration, then time limit.
  const [threshold] = screen.getAllByRole("spinbutton");
  fireEvent.change(threshold, { target: { value: "90" } });
  const submits = screen.getAllByRole("button", {
    name: "autoOps.enable.submit",
  });
  fireEvent.click(submits[submits.length - 1]);
  await waitFor(() => expect(mocks.enablePreset).toHaveBeenCalled());
  const [presetId, input] = mocks.enablePreset.mock.calls[0];
  expect(presetId).toBe("disk-cleanup");
  expect(input).not.toHaveProperty("name");
  expect(input).toMatchObject({
    title: "autoOps.presets.disk-cleanup.title",
    trigger: { kind: "metric_threshold", value: 90, forSeconds: 300 },
    hostSelector: { kind: "trigger" },
    autonomy: "propose",
    runbook: "Clean safely.",
    maxRunSeconds: 900,
  });
});

it("converts a daily schedule to a time and back", () => {
  expect(cronToTime("0 9 * * *")).toBe("09:00");
  expect(cronToTime("*/5 * * * *")).toBeNull();
  expect(timeToCron("07:30")).toBe("30 7 * * *");
  expect(timeToCron("25:00")).toBeNull();
});

it("finds the newest task since the last visit", () => {
  const seen = Date.parse("2026-10-17T08:00:30.000Z");
  expect(newestUnseen([task()] as never, seen)?.id).toBe(1);
  expect(newestUnseen([task({ status: "skipped" })] as never, seen)).toBeNull();
  expect(
    newestUnseen([task()] as never, Date.parse("2026-10-17T09:00:00.000Z")),
  ).toBeNull();
});
