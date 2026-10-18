import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  t: (key: string) => key,
}));
vi.mock("../../src/frontend/app-ref", () => ({
  aiApp: () => ({ api: mocks }),
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({ t: mocks.t, language: "en" }),
}));
import { ExposureView } from "../../src/frontend/exposure/ExposureView";
const entry = {
  key: "entry1",
  observationId: "obs1",
  sourceHostId: 1,
  source: "listen",
  endpoint: { address: "8.8.8.8", port: 22, protocol: "tcp" },
  priority: "high",
  prioritySource: "rule",
  pathStatus: "partial",
  staleAt: null,
  resolvedAt: null,
  lastSeen: "2026-10-18T00:00:00Z",
  tls: "unknown",
  restricted: "unknown",
  hops: [
    {
      sourceHostId: 1,
      source: "listen",
      endpoint: { address: "8.8.8.8", port: 22, protocol: "tcp" },
      observationId: "obs1",
      constraints: [],
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    data: { entries: [entry], coverage: [], changes: [], total: 1, offset: 0 },
  });
});
afterEach(cleanup);
describe("exposure evidence view", () => {
  it("states uncertainty and distinguishes never collected from empty results", async () => {
    mocks.get.mockResolvedValue({
      data: { entries: [], coverage: [], changes: [], total: 0, offset: 0 },
    });
    render(<ExposureView canManage={false} refreshKey={0} />);
    expect(screen.getByText("exposure.disclaimer")).toBeTruthy();
    await screen.findByText("exposure.never");
  });
  it("shows evidence without enabling viewer modifications", async () => {
    render(<ExposureView canManage={false} refreshKey={0} />);
    fireEvent.click(await screen.findByText("tcp://8.8.8.8:22"));
    expect(screen.getByText("exposure.notTested")).toBeTruthy();
    expect(screen.getByText(/obs1/)).toBeTruthy();
    expect(screen.queryByText("exposure.explain")).toBeNull();
  });
  it("labels model output separately from observations", async () => {
    mocks.post.mockResolvedValue({
      data: { text: "An interpretation, not proof." },
    });
    render(<ExposureView canManage refreshKey={0} />);
    fireEvent.click(await screen.findByText("tcp://8.8.8.8:22"));
    fireEvent.click(screen.getByText("exposure.explain"));
    await screen.findByText("An interpretation, not proof.");
    expect(screen.getByText("exposure.aiLabel")).toBeTruthy();
    expect(mocks.post).toHaveBeenCalledWith("assets/exposure/entry1/explain");
  });
  it("requests internet scope by default and renders grouped bindings and path branches", async () => {
    mocks.get.mockResolvedValue({
      data: {
        entries: [
          {
            ...entry,
            bindings: [
              entry.endpoint,
              { ...entry.endpoint, address: "10.0.0.1" },
            ],
            priorityReasons: ["sensitive-service:22"],
            paths: [
              {
                hops: [
                  entry.hops[0],
                  {
                    ...entry.hops[0],
                    source: "caddy",
                    hostname: "app.example",
                    path: "/api",
                  },
                ],
                status: "partial",
              },
              { hops: [entry.hops[0]], status: "partial" },
            ],
          },
        ],
        coverage: [],
        changes: [],
        total: 1,
        offset: 0,
      },
    });
    render(<ExposureView canManage={false} refreshKey={0} />);
    fireEvent.click(await screen.findByText("tcp://8.8.8.8:22"));
    expect(mocks.get.mock.calls[0][0]).toContain("scope=internet");
    expect(screen.getByText("exposure.reason_sensitive")).toBeTruthy();
    expect(screen.getAllByText(/app.example/).length).toBeGreaterThan(0);
    expect(screen.getByText("tcp://10.0.0.1:22")).toBeTruthy();
  });
  it("clears cached rows after an authorization failure", async () => {
    render(<ExposureView canManage={false} refreshKey={0} />);
    await screen.findByText("tcp://8.8.8.8:22");
    mocks.get.mockRejectedValue(new Error("forbidden"));
    fireEvent.click(screen.getByText("exposure.refresh"));
    await screen.findByText("exposure.loadFailed");
    expect(screen.queryByText("tcp://8.8.8.8:22")).toBeNull();
  });
});
