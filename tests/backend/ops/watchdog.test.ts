import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote, wrapCommand } from "../../../src/backend/ops/exec.js";

/**
 * Runs the wrapped command through a real sh, the way sshd hands it to the
 * login shell, with a stdin pipe standing in for the channel.
 */
function run(command: string) {
  const child = spawn("/bin/sh", ["-c", wrapCommand(command)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const done = new Promise<{ code: number | null; output: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, output })),
  );
  return { child, done };
}

describe("shellQuote", () => {
  it("keeps single quotes inside one word", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("wrapCommand", () => {
  it("passes the exit code through", async () => {
    expect((await run("exit 7").done).code).toBe(7);
  });

  it("keeps quotes, variables, pipes and lines intact", async () => {
    const { output, code } = await run(
      `x="a'b"; echo "$x" | tr a A\necho 'done' && echo $((1 + 2))`,
    ).done;
    expect(code).toBe(0);
    expect(output).toBe("A'b\ndone\n3\n");
  });

  it("gives the command an empty stdin", async () => {
    const { output, code } = await run("cat; echo end").done;
    expect(code).toBe(0);
    expect(output).toBe("end\n");
  });

  it("ends a silent command and its children when stdin closes", async () => {
    const started = Date.now();
    const { child, done } = run("sleep 30 & sleep 30; echo never");
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.end();
    const { code, output } = await done;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(code).not.toBe(0);
    expect(output).not.toContain("never");
  });

  it("finishes normally without waiting for stdin", async () => {
    const started = Date.now();
    const { child, done } = run("echo quick");
    const { code, output } = await done;
    child.stdin.end();
    expect(code).toBe(0);
    expect(output).toBe("quick\n");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
