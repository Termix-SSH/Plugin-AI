import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  listAssets: vi.fn(),
  getAsset: vi.fn(),
  pinZone: vi.fn(),
  listZones: vi.fn(),
  saveZone: vi.fn(),
  deleteZone: vi.fn(),
  collectNow: vi.fn(),
  listRuns: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  listAnnotationRuns: vi.fn(),
  annotateNow: vi.fn(),
  getGraph: vi.fn(),
  getImpact: vi.fn(),
  saveAnnotation: vi.fn(),
  unlockAnnotation: vi.fn(),
}));
vi.mock("../../src/frontend/app-ref", () => ({
  aiApp: () => ({ hasPermission: mocks.hasPermission }),
}));
vi.mock("../../src/frontend/assets/api", () => ({
  listAssets: mocks.listAssets,
  getAsset: mocks.getAsset,
  pinZone: mocks.pinZone,
  listZones: mocks.listZones,
  saveZone: mocks.saveZone,
  deleteZone: mocks.deleteZone,
  collectNow: mocks.collectNow,
  listRuns: mocks.listRuns,
  getSettings: mocks.getSettings,
  saveSettings: mocks.saveSettings,
  listAnnotationRuns: mocks.listAnnotationRuns,
  annotateNow: mocks.annotateNow,
  getGraph: mocks.getGraph,
  getImpact: mocks.getImpact,
  saveAnnotation: mocks.saveAnnotation,
  unlockAnnotation: mocks.unlockAnnotation,
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values && "ok" in values
        ? `${key}:${values.ok}/${values.total}`
        : values && "count" in values
          ? `${key}:${values.count}`
          : key,
    language: "en",
  }),
}));
import { AssetsView } from "../../src/frontend/assets/AssetsView";

const asset = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  key: "host:1",
  kind: "host",
  hostId: 1,
  name: "web-1",
  ips: ["10.0.0.1", "100.79.120.126"],
  zone: "internal",
  zoneSource: "rule",
  multiZone: true,
  collectedAt: "2026-10-17T03:00:00.000Z",
  removedAt: null,
  os: "Ubuntu 24.04.4 LTS",
  counts: { listening: 7, outbound: 5, services: 5, containers: 2 },
  ...overrides,
});

beforeEach(() => {
  mocks.hasPermission.mockResolvedValue(true);
  mocks.listAssets.mockResolvedValue([
    asset(),
    asset({
      id: 2,
      key: "external:93.184.216.34",
      kind: "external",
      name: "93.184.216.34",
      ips: ["93.184.216.34"],
      zone: "external",
      multiZone: false,
      collectedAt: null,
    }),
  ]);
  mocks.listZones.mockResolvedValue({
    zones: [
      { id: 3, name: "dc", kind: "internal", cidr: "10.0.0.0/24", priority: 0 },
    ],
    builtin: ["internal", "external", "cloud", "overlay"],
  });
  mocks.listRuns.mockResolvedValue({
    running: false,
    runs: [
      {
        id: 9,
        trigger: "manual",
        startedAt: "2026-10-17T03:00:00.000Z",
        finishedAt: "2026-10-17T03:00:09.000Z",
        status: "done",
        hostsTotal: 3,
        hostsOk: 2,
        hostsFailed: 1,
        errorSummary: { "4": "connect ECONNREFUSED" },
      },
    ],
  });
  mocks.collectNow.mockResolvedValue("started");
  mocks.listAnnotationRuns.mockResolvedValue({ running: false, runs: [] });
  mocks.getSettings.mockResolvedValue({
    dailyEnabled: true,
    dailyTime: "03:00",
    collectorSet: true,
    collectorIsMe: false,
    annotateAfterCollect: true,
    annotateProviderId: null,
    annotateModel: null,
    annotateProviders: [{ id: 4, label: "Work", defaultModel: "gpt-5" }],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("lists assets with zones, the multi-zone marker and the last run", async () => {
  render(<AssetsView />);
  expect(await screen.findByText("web-1")).toBeTruthy();
  expect(screen.getAllByText("93.184.216.34").length).toBeGreaterThan(0);
  expect(screen.getByText("assets.zone.internal")).toBeTruthy();
  expect(screen.getByText("assets.multiZone")).toBeTruthy();
  expect(screen.getByText("assets.lastRun:2/3")).toBeTruthy();
  expect(screen.getByText("assets.hostsFailed:1")).toBeTruthy();
});

it("filters by search, zone and removed", async () => {
  render(<AssetsView />);
  await screen.findByText("web-1");
  fireEvent.change(screen.getByPlaceholderText("assets.search"), {
    target: { value: "10.0" },
  });
  await waitFor(() =>
    expect(mocks.listAssets).toHaveBeenLastCalledWith({
      q: "10.0",
      zone: "",
      includeRemoved: false,
    }),
  );
  fireEvent.click(screen.getByLabelText("assets.showRemoved"));
  await waitFor(() =>
    expect(mocks.listAssets).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeRemoved: true }),
    ),
  );
});

it("collects on request for a manager", async () => {
  render(<AssetsView />);
  fireEvent.click(await screen.findByText("assets.collectNow"));
  await waitFor(() => expect(mocks.collectNow).toHaveBeenCalled());
});

it("hides managing for someone who may only look", async () => {
  mocks.hasPermission.mockResolvedValue(false);
  render(<AssetsView />);
  await screen.findByText("web-1");
  expect(screen.queryByText("assets.collectNow")).toBeNull();
  expect(screen.queryByText("assets.settingsTitle")).toBeNull();
});

it("opens an asset with its facts and edges", async () => {
  mocks.getAsset.mockResolvedValue({
    asset: {
      ...asset(),
      facts: {
        hostname: "web-1",
        listening: [
          { proto: "tcp", address: "0.0.0.0", port: 22, process: "sshd" },
        ],
      },
    },
    outgoing: [
      {
        id: 1,
        fromAsset: 1,
        toAsset: 2,
        type: "connects_to",
        detail: { ports: [443] },
        evidence: "ss on web-1: 2 established to 93.184.216.34:443 (curl)",
        source: "collector",
        firstSeen: "2026-10-16T03:00:00.000Z",
        lastSeen: "2026-10-16T03:00:00.000Z",
        peer: {
          id: 2,
          key: "external:93.184.216.34",
          kind: "external",
          name: "93.184.216.34",
        },
      },
    ],
    incoming: [],
  });
  render(<AssetsView />);
  fireEvent.click(await screen.findByText("web-1"));
  expect(
    await screen.findByText(
      "ss on web-1: 2 established to 93.184.216.34:443 (curl)",
    ),
  ).toBeTruthy();
  // Not seen in the latest collection.
  expect(screen.getByText("assets.stale")).toBeTruthy();
  expect(screen.getByText("assets.sections.listening")).toBeTruthy();
  expect(screen.getByText("sshd")).toBeTruthy();
});

it("adds a zone rule from the settings", async () => {
  mocks.saveZone.mockResolvedValue(undefined);
  render(<AssetsView />);
  fireEvent.click(await screen.findByText("assets.settingsTitle"));
  expect(await screen.findByText("dc")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("assets.zoneNameExample"), {
    target: { value: "lab" },
  });
  fireEvent.change(screen.getByPlaceholderText("10.1.1.0/24"), {
    target: { value: "10.9.0.0/16" },
  });
  fireEvent.click(screen.getByText("assets.addZone"));
  await waitFor(() =>
    expect(mocks.saveZone).toHaveBeenCalledWith({
      name: "lab",
      kind: "internal",
      cidr: "10.9.0.0/16",
      priority: 0,
    }),
  );
});

it("shows annotation columns with their source, and annotates on request", async () => {
  mocks.listAssets.mockResolvedValue([
    asset({
      role: "Shop front end",
      roleSource: "user",
      importance: "high",
      importanceSource: "ai",
      importanceReason: "Customers reach the shop through it.",
      system: "shop",
      systemSource: "ai",
    }),
  ]);
  mocks.annotateNow.mockResolvedValue("started");
  mocks.listAnnotationRuns.mockResolvedValue({
    running: false,
    runs: [
      {
        id: 3,
        kind: "annotate",
        trigger: "collection",
        startedAt: "2026-10-17T03:01:00.000Z",
        finishedAt: "2026-10-17T03:02:00.000Z",
        status: "failed",
        hostsTotal: 4,
        hostsOk: 2,
        hostsFailed: 2,
        errorSummary: { run: "Stopped at the token budget of 1000" },
        tokens: 1200,
      },
    ],
  });
  render(<AssetsView />);
  expect(await screen.findByText("Shop front end")).toBeTruthy();
  expect(screen.getByText("assets.importance.high")).toBeTruthy();
  expect(screen.getByText("assets.sourceUser")).toBeTruthy();
  expect(screen.getAllByText("assets.sourceAi")).toHaveLength(2);
  expect(screen.getByText("assets.annotationFailed")).toBeTruthy();

  fireEvent.click(screen.getByText("assets.annotateNow"));
  await waitFor(() => expect(mocks.annotateNow).toHaveBeenCalledWith(false));

  fireEvent.click(screen.getByText("assets.settingsTitle"));
  expect(await screen.findByText("assets.annotationTitle")).toBeTruthy();
});
