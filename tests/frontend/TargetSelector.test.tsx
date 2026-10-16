import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));
import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";
import { TargetSelector } from "../../src/frontend/ops/TargetSelector";
import {
  toTargetHosts,
  type TargetGroup,
} from "../../src/frontend/ops/targets";

afterEach(cleanup);

const hosts = toTargetHosts([
  {
    id: "1",
    name: "web-1",
    ip: "10.0.0.1",
    port: 22,
    folder: "prod",
    tags: ["nginx"],
  },
  {
    id: "2",
    name: "web-2",
    ip: "10.0.0.2",
    port: 22,
    folder: "prod",
    tags: ["nginx"],
  },
  { id: "3", name: "db-1", ip: "10.0.0.3", port: 22, tags: ["postgres"] },
] as PluginHostRecord[]);

function Harness({ fleets }: { fleets: TargetGroup[] | null }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  return (
    <TargetSelector
      hosts={hosts}
      fleets={fleets}
      selected={selected}
      onChange={setSelected}
    />
  );
}

it("counts the union of the checked groups and hosts", () => {
  render(<Harness fleets={null} />);
  expect(screen.getByRole("status").textContent).toBe("ops.selectedCount:0");

  fireEvent.click(screen.getByRole("checkbox", { name: "prod" }));
  expect(screen.getByRole("status").textContent).toBe("ops.selectedCount:2");
  // Both hosts in the folder show as checked, and so does their tag.
  expect(
    screen
      .getByRole("checkbox", { name: "web-1" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen
      .getByRole("checkbox", { name: "nginx" })
      .getAttribute("aria-checked"),
  ).toBe("true");

  fireEvent.click(screen.getByRole("checkbox", { name: "postgres" }));
  expect(screen.getByRole("status").textContent).toBe("ops.selectedCount:3");

  fireEvent.click(screen.getByRole("checkbox", { name: "web-2" }));
  expect(screen.getByRole("status").textContent).toBe("ops.selectedCount:2");
  expect(
    screen.getByRole("checkbox", { name: "prod" }).getAttribute("aria-checked"),
  ).toBe("mixed");

  fireEvent.click(screen.getByText("ops.clear"));
  expect(screen.getByRole("status").textContent).toBe("ops.selectedCount:0");
});

it("hides fleets without the fleets plugin and shows them with it", () => {
  render(<Harness fleets={null} />);
  expect(screen.queryByText("ops.fleets")).toBeNull();
  cleanup();

  render(<Harness fleets={[{ key: "7", name: "edge", hostIds: [1, 3] }]} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "edge" }));
  expect(screen.getByRole("status").textContent).toBe("ops.selectedCount:2");
});

it("filters by the search", () => {
  render(<Harness fleets={null} />);
  fireEvent.change(screen.getByPlaceholderText("ops.searchHosts"), {
    target: { value: "db" },
  });
  expect(screen.queryByRole("checkbox", { name: "web-1" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "db-1" })).toBeTruthy();
});
