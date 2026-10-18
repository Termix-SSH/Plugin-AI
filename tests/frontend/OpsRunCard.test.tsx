import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
}));
import { OpsRunCard } from "../../src/frontend/ops/OpsRunCard";
import type { ToolActivity } from "../../src/frontend/use-ai-stream";

afterEach(cleanup);

const tool: ToolActivity = {
  id: "tool-0",
  name: "run_command",
  arguments: { hostIds: [1, 2, 3], command: "systemctl is-active nginx" },
  progress: [
    {
      hostId: 2,
      name: "web-2",
      exitCode: 0,
      output: "\nactive\nsince Monday\n",
      durationMs: 1234,
    },
    {
      hostId: 1,
      name: "web-1",
      exitCode: 3,
      output: "inactive\n",
      durationMs: 80,
    },
  ],
};

it("shows the command, counts and a row per finished host", () => {
  render(<OpsRunCard tool={tool} streaming />);

  expect(screen.getByText("systemctl is-active nginx")).toBeTruthy();
  expect(screen.getByText("ops.hostCount:3")).toBeTruthy();
  expect(screen.getByText("ops.succeeded:1")).toBeTruthy();
  expect(screen.getByText("ops.failed:1")).toBeTruthy();

  const rows = screen.getAllByRole("button");
  expect(rows).toHaveLength(2);
  // Hosts in the order they finished, each with exit code, time and the
  // first line of output.
  expect(rows[0].textContent).toContain("web-2");
  expect(rows[0].textContent).toContain("ops.exitCode:0");
  expect(rows[0].textContent).toContain("ops.duration:1.2");
  expect(rows[0].textContent).toContain("active");
  expect(rows[0].textContent).not.toContain("since Monday");
  expect(rows[1].textContent).toContain("ops.exitCode:3");
});

it("expands a host to its full output", () => {
  render(<OpsRunCard tool={tool} />);
  const row = screen.getAllByRole("button")[0];
  expect(row.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(row);
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText(/since Monday/).tagName).toBe("PRE");
});

it("marks timeouts and refused calls", () => {
  render(
    <OpsRunCard
      tool={{
        ...tool,
        progress: [
          {
            hostId: 1,
            name: "web-1",
            exitCode: null,
            output: "",
            durationMs: 120000,
            timedOut: true,
          },
        ],
        result: { error: "Not a target of this conversation: 9." },
      }}
    />,
  );
  expect(screen.getByText("ops.timedOut")).toBeTruthy();
  expect(screen.getByText("ops.failed:1")).toBeTruthy();
  expect(
    screen.getByText("Not a target of this conversation: 9."),
  ).toBeTruthy();
});
