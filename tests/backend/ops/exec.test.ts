import { describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import {
  createCapture,
  execOnClient,
  mapLimit,
  wrapCommand,
  truncateMiddle,
} from "../../../src/backend/ops/exec.js";
import { fakeSshClient } from "./fake-ssh";

const limits = (
  overrides: Partial<Parameters<typeof execOnClient>[2]> = {},
) => ({
  timeoutMs: 1000,
  outputLimit: 1000,
  signal: new AbortController().signal,
  ...overrides,
});

describe("output capture", () => {
  it("keeps everything under the limit", () => {
    expect(truncateMiddle("short", 100)).toBe("short");
  });

  it("keeps the head and tail of long output, across chunks", () => {
    const capture = createCapture(10);
    for (const chunk of ["01234", "56789", "abcde", "fghij"]) {
      capture.push(chunk);
    }
    expect(capture.text()).toBe("01234\n... 10 characters cut ...\nfghij");
  });
});

describe("execOnClient", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const ssh = fakeSshClient(() => ({
      stdout: "out\n",
      stderr: "err\n",
      code: 3,
    }));
    const result = await execOnClient(
      ssh.client as unknown as Client,
      "false",
      limits(),
    );
    expect(result).toEqual({ exitCode: 3, output: "out\nerr\n" });
    expect(ssh.channels[0].command).toBe(wrapCommand("false"));
  });

  it("truncates output to the limit", async () => {
    const ssh = fakeSshClient(() => ({ stdout: "x".repeat(50) + "END" }));
    const result = await execOnClient(
      ssh.client as unknown as Client,
      "cat big",
      limits({ outputLimit: 10 }),
    );
    expect(result.output).toBe("xxxxx\n... 43 characters cut ...\nxxEND");
  });

  it("stops and closes the channel on timeout", async () => {
    const ssh = fakeSshClient(() => ({ stdout: "partial", hang: true }));
    const result = await execOnClient(
      ssh.client as unknown as Client,
      "sleep 999",
      limits({ timeoutMs: 20 }),
    );
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(ssh.channels[0].closed).toBe(true);
    expect(ssh.channels[0].signals).toEqual(["KILL"]);
  });

  it("stops and closes the channel when the run is aborted", async () => {
    const ssh = fakeSshClient(() => ({ hang: true }));
    const abort = new AbortController();
    const running = execOnClient(
      ssh.client as unknown as Client,
      "tail -f /var/log/syslog",
      limits({ signal: abort.signal }),
    );
    abort.abort();
    expect(await running).toMatchObject({ exitCode: null, aborted: true });
    expect(ssh.channels[0].closed).toBe(true);
  });

  it("does not start a command once aborted", async () => {
    const ssh = fakeSshClient(() => ({}));
    const abort = new AbortController();
    abort.abort();
    const result = await execOnClient(
      ssh.client as unknown as Client,
      "uptime",
      limits({ signal: abort.signal }),
    );
    expect(result.aborted).toBe(true);
  });
});

describe("mapLimit", () => {
  it("never runs more than the limit at once and keeps order", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit(
      [1, 2, 3, 4, 5],
      2,
      new AbortController().signal,
      async (item) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return item * 10;
      },
    );
    expect(peak).toBe(2);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("starts nothing new after an abort", async () => {
    const abort = new AbortController();
    const started: number[] = [];
    const results = await mapLimit(
      [1, 2, 3, 4],
      1,
      abort.signal,
      async (item) => {
        started.push(item);
        if (item === 2) abort.abort();
        return item;
      },
    );
    expect(started).toEqual([1, 2]);
    expect(results.filter((value) => value !== undefined)).toEqual([1, 2]);
  });
});
