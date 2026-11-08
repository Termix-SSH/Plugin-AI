import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ listTasks: vi.fn() }));
vi.mock("../../src/frontend/autoops/api", () => ({
  listTasks: mocks.listTasks,
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({
    t: (key: string, o?: { count?: number }) =>
      o?.count === undefined ? key : `${key}:${o.count}`,
  }),
}));
import { aiTasksWidget } from "../../src/frontend/homepage/AiTasksWidget";

afterEach(cleanup);

const task = (id: number, status: string, title: string) => ({
  id,
  title,
  status,
  summary: null,
});

it("shows plans waiting and recent tasks", async () => {
  const proposed = task(1, "proposed", "Restart nginx");
  mocks.listTasks.mockResolvedValue({
    tasks: [proposed, task(2, "done", "Disk report")],
    approvals: [proposed],
  });
  const View = aiTasksWidget.components.view;
  render(<View widget={{ title: null }} config={{ maxItems: 5 }} />);
  expect(await screen.findByText("Restart nginx")).toBeTruthy();
  expect(screen.getByText("Disk report")).toBeTruthy();
  expect(screen.getByText("widget.pending:1")).toBeTruthy();
});
