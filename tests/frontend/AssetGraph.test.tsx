import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getGraph: vi.fn(),
  getAsset: vi.fn(),
  getImpact: vi.fn(),
  saveAnnotation: vi.fn(),
  unlockAnnotation: vi.fn(),
}));
vi.mock("../../src/frontend/assets/api", () => mocks);
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values && "count" in values ? `${key}:${values.count}` : key,
    language: "en",
  }),
}));
import { GraphView } from "../../src/frontend/assets/GraphView";

const node = (id: number, key: string, name: string, extra = {}) => ({
  id,
  key,
  kind: key.split(":")[0],
  name,
  zone: "internal",
  multiZone: false,
  role: null,
  importance: null,
  system: null,
  containers: 0,
  ...extra,
});

const GRAPH = {
  nodes: [
    node(1, "host:1", "pve2", { importance: "critical", role: "Proxmox node" }),
    node(2, "host:2", "master-2", { importance: "critical" }),
    node(3, "host:3", "worker-1", { importance: "high", containers: 1 }),
    node(4, "host:4", "monitor"),
    node(5, "host:5", "db-1", { zone: "dmz" }),
  ],
  edges: [
    {
      key: "2|1|runs_on",
      from: 2,
      to: 1,
      type: "runs_on",
      source: "collector",
      stale: false,
    },
    {
      key: "3|1|runs_on",
      from: 3,
      to: 1,
      type: "runs_on",
      source: "collector",
      stale: false,
    },
    {
      key: "4|3|connects_to",
      from: 4,
      to: 3,
      type: "connects_to",
      source: "collector",
      stale: false,
    },
  ],
};

const DETAIL = {
  asset: {
    id: 1,
    key: "host:1",
    kind: "host",
    hostId: 1,
    name: "pve2",
    ips: ["10.0.0.3"],
    zone: "internal",
    zoneSource: "rule",
    multiZone: false,
    collectedAt: "2026-10-17T03:00:00.000Z",
    removedAt: null,
    facts: { os: { pretty: "Debian 12" }, listening: [{}, {}], services: [{}] },
    role: "Proxmox node",
    roleSource: "ai",
    importance: "critical",
    importanceSource: "user",
    importanceReason: "Runs the k3s control plane.",
    system: null,
    systemSource: null,
    annotatedAt: "2026-10-17T03:01:00.000Z",
  },
  outgoing: [],
  incoming: [
    {
      id: 7,
      fromAsset: 2,
      toAsset: 1,
      type: "runs_on",
      detail: null,
      evidence: "pvesh: qemu 101",
      source: "collector",
      firstSeen: "",
      lastSeen: "",
      peer: { id: 2, key: "host:2", kind: "host", name: "master-2" },
    },
  ],
};

const item = (
  id: number,
  key: string,
  name: string,
  depth: number,
  path: unknown[],
) => ({
  asset: {
    id,
    key,
    kind: "host",
    name,
    zone: "internal",
    role: null,
    importance: null,
  },
  depth,
  path,
});

const IMPACT = {
  asset: { id: 1, key: "host:1", name: "pve2" },
  direct: [
    item(2, "host:2", "master-2", 1, [
      { from: 2, to: 1, type: "runs_on", source: "collector" },
    ]),
    item(3, "host:3", "worker-1", 1, [
      { from: 3, to: 1, type: "runs_on", source: "collector" },
    ]),
  ],
  // A container folded into worker-1.
  transitive: [
    item(9, "container:3/dns", "dns", 2, [
      { from: 9, to: 3, type: "runs_on", source: "collector" },
      { from: 3, to: 1, type: "runs_on", source: "collector" },
    ]),
  ],
  weak: [
    item(4, "host:4", "monitor", 2, [
      { from: 4, to: 3, type: "connects_to", source: "collector" },
    ]),
  ],
  counts: {
    strong: { critical: 1, high: 1, medium: 0, low: 0, unknown: 1 },
    weak: { critical: 0, high: 0, medium: 0, low: 0, unknown: 1 },
  },
  truncated: false,
};

beforeEach(() => {
  mocks.getGraph.mockResolvedValue(GRAPH);
  mocks.getAsset.mockResolvedValue(DETAIL);
  mocks.getImpact.mockResolvedValue(IMPACT);
  mocks.saveAnnotation.mockResolvedValue(undefined);
  mocks.unlockAnnotation.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderGraph(canManage = true) {
  const onChanged = vi.fn();
  render(
    <GraphView
      rules={[]}
      canManage={canManage}
      refreshKey={0}
      onChanged={onChanged}
    />,
  );
  return onChanged;
}

it("draws every node and opens a panel with annotations, facts and edges", async () => {
  renderGraph();
  await screen.findByRole("img", { name: "assets.graphTitle" });
  for (const name of ["pve2", "master-2", "worker-1", "monitor", "db-1"]) {
    expect(document.querySelector(`[aria-label="${name}"]`)).not.toBeNull();
  }
  expect(mocks.getGraph).toHaveBeenCalledWith({
    types: ["runs_on", "depends_on", "connects_to"],
    containers: false,
    external: false,
  });

  fireEvent.click(document.querySelector('[aria-label="pve2"]')!);
  const panel = await screen.findByRole("complementary", { name: "pve2" });
  await within(panel).findByText("Proxmox node");
  expect(within(panel).getByText("assets.sourceAi")).toBeTruthy();
  expect(within(panel).getByText("assets.sourceUser")).toBeTruthy();
  expect(within(panel).getByText("Runs the k3s control plane.")).toBeTruthy();
  expect(within(panel).getByText("Debian 12")).toBeTruthy();
  expect(within(panel).getByText("master-2")).toBeTruthy();
});

it("highlights the impact set on the graph and lists it", async () => {
  renderGraph();
  await screen.findByRole("img", { name: "assets.graphTitle" });
  fireEvent.click(document.querySelector('[aria-label="pve2"]')!);
  const panel = await screen.findByRole("complementary", { name: "pve2" });
  fireEvent.click(await within(panel).findByText("assets.impact"));

  await waitFor(() => expect(mocks.getImpact).toHaveBeenCalledWith(1));
  const lit = (name: string) =>
    document.querySelector(`[aria-label="${name}"]`)!.getAttribute("data-lit");
  await waitFor(() => expect(lit("db-1")).toBe("false"));
  expect(lit("pve2")).toBe("true");
  expect(lit("master-2")).toBe("true");
  // The folded dns container lights its host.
  expect(lit("worker-1")).toBe("true");
  expect(lit("monitor")).toBe("true");

  expect(within(panel).getByText("assets.impactSummary:3")).toBeTruthy();
  expect(within(panel).getByText("assets.impactDirect")).toBeTruthy();
  expect(within(panel).getByText("dns")).toBeTruthy();
  expect(
    within(panel).getByText("runs_on worker-1 → runs_on pve2"),
  ).toBeTruthy();
  expect(within(panel).getByText("assets.impactWeak")).toBeTruthy();

  fireEvent.click(within(panel).getByText("assets.clearImpact"));
  await waitFor(() => expect(lit("db-1")).toBe("true"));
});

it("saves only the fields a manager changed, and unlocks a locked one", async () => {
  const onChanged = renderGraph();
  await screen.findByRole("img", { name: "assets.graphTitle" });
  fireEvent.click(document.querySelector('[aria-label="pve2"]')!);
  const panel = await screen.findByRole("complementary", { name: "pve2" });

  fireEvent.click(await within(panel).findByLabelText("assets.unlockField"));
  await waitFor(() =>
    expect(mocks.unlockAnnotation).toHaveBeenCalledWith(1, "importance"),
  );

  fireEvent.click(within(panel).getByText("assets.editAnnotation"));
  const system = within(panel).getAllByRole("textbox").at(-1)!;
  fireEvent.change(system, { target: { value: "homelab" } });
  fireEvent.click(within(panel).getByText("assets.save"));
  await waitFor(() =>
    expect(mocks.saveAnnotation).toHaveBeenCalledWith(1, { system: "homelab" }),
  );
  expect(onChanged).toHaveBeenCalled();
});

it("hides editing from viewers and refetches when containers are expanded", async () => {
  renderGraph(false);
  await screen.findByRole("img", { name: "assets.graphTitle" });
  fireEvent.click(document.querySelector('[aria-label="pve2"]')!);
  const panel = await screen.findByRole("complementary", { name: "pve2" });
  await within(panel).findByText("Proxmox node");
  expect(within(panel).queryByText("assets.editAnnotation")).toBeNull();
  expect(within(panel).queryByLabelText("assets.unlockField")).toBeNull();

  fireEvent.click(screen.getByLabelText("assets.expandContainers"));
  await waitFor(() =>
    expect(mocks.getGraph).toHaveBeenLastCalledWith(
      expect.objectContaining({ containers: true }),
    ),
  );
});

it("lays out 400 nodes quickly, every one placed", async () => {
  const { layoutGraph } =
    await import("../../src/frontend/assets/graph-layout");
  const zones = ["internal", "dmz", "external", "cloud", null];
  const nodes = Array.from({ length: 400 }, (_, i) =>
    node(i + 1, `host:${i + 1}`, `n${i + 1}`, { zone: zones[i % 5] }),
  );
  const edges = Array.from({ length: 600 }, (_, i) => ({
    key: `e${i}`,
    from: (i % 400) + 1,
    to: ((i * 7) % 400) + 1,
    type: "connects_to" as const,
    source: "collector",
    stale: false,
  }));
  const started = performance.now();
  const layout = layoutGraph(nodes as never, edges);
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(layout.nodes).toHaveLength(400);
  expect(layout.zones).toHaveLength(5);
  expect(
    layout.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)),
  ).toBe(true);
});
