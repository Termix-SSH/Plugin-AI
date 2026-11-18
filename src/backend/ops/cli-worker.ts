import { Worker } from "node:worker_threads";
import type { PluginProcessHandle } from "@termix-ssh/plugin-sdk/backend";

/**
 * In the desktop app the backend runs inside Electron, whose binary can't
 * start as plain Node, so the CLI runs in a worker thread instead of a child
 * process. The worker gets its own env (token, temp config dirs) and argv;
 * nothing of the server's env reaches it. Only used in the desktop app, where
 * plugin processes are not fenced, so the manifest asks for no workers.
 */
export function runCliInWorker(
  file: string,
  args: string[],
  options: { env: Record<string, string> },
): PluginProcessHandle {
  const worker = new Worker(file, {
    argv: args,
    env: { ...options.env },
    stdout: true,
    stderr: true,
    stdin: false,
  });
  const stdout: Array<(chunk: string) => void> = [];
  const stderr: Array<(chunk: string) => void> = [];
  worker.stdout.setEncoding("utf8");
  worker.stderr.setEncoding("utf8");
  worker.stdout.on("data", (chunk: string) => stdout.forEach((l) => l(chunk)));
  worker.stderr.on("data", (chunk: string) => stderr.forEach((l) => l(chunk)));

  let killed: "SIGTERM" | "SIGKILL" | null = null;
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      let failed = false;
      // An uncaught error in the CLI ends the worker like a crash would.
      worker.once("error", (error) => {
        failed = true;
        const text = error instanceof Error ? error.message : String(error);
        stderr.forEach((l) => l(text));
      });
      worker.once("exit", (code) => {
        if (killed) resolve({ code: null, signal: killed });
        else resolve({ code: failed && code === 0 ? 1 : code, signal: null });
      });
    },
  );

  return {
    pid: undefined,
    onStdout: (listener) => stdout.push(listener),
    onStderr: (listener) => stderr.push(listener),
    exited,
    kill: (signal = "SIGTERM") => {
      killed = signal;
      void worker.terminate();
    },
  };
}

export function insideElectron(): boolean {
  return typeof process.versions.electron === "string";
}
