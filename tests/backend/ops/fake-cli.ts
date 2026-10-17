import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginProcess } from "@termix-ssh/plugin-sdk/backend";
import { afterAll } from "vitest";

/**
 * A stand-in for the Termix CLI: prints what it was started with as JSON.
 * "sleep" anywhere in its args keeps it running until it is killed, "fail"
 * makes it exit 3 after writing to stderr, "pretty" indents the JSON like the
 * real CLI does.
 */
const SCRIPT = `
const args = process.argv.slice(2);
if (args.includes("sleep")) {
  process.stdout.write("started\\n");
  setInterval(() => {}, 1000);
} else {
  if (args.includes("fail")) {
    process.stderr.write("boom\\n");
    process.exitCode = 3;
  }
  process.stdout.write(JSON.stringify({
    argv: process.argv,
    cwd: process.cwd(),
    pid: process.pid,
    env: {
      TERMIX_URL: process.env.TERMIX_URL,
      TERMIX_TOKEN: process.env.TERMIX_TOKEN,
      TERMIX_API_KEY: process.env.TERMIX_API_KEY ?? null,
      NO_COLOR: process.env.NO_COLOR,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      SECRET: process.env.FAKE_SERVER_SECRET ?? null,
    },
  }, null, args.includes("pretty") ? 2 : 0));
}
`;

/** Call while tests are collected: the file is removed after them. */
export function writeFakeCli(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fake-termix-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "termix-cli.mjs");
  writeFileSync(file, SCRIPT);
  return file;
}

/**
 * ctx.process.run the way core implements it: no shell, a small base
 * environment plus what the caller passes, never the server's own.
 */
export const spawnRun: PluginProcess["run"] = async (file, args, options) => {
  const child = spawn(file, [...args], {
    cwd: options?.cwd,
    env: { PATH: process.env.PATH, ...(options?.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return {
    pid: child.pid,
    onStdout: (listener) => void child.stdout.on("data", listener),
    onStderr: (listener) => void child.stderr.on("data", listener),
    exited,
    kill: (signal = "SIGTERM") => void child.kill(signal),
  };
};
