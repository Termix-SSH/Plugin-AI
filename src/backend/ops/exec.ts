import { StringDecoder } from "node:string_decoder";
import type { Client, ClientChannel } from "ssh2";
import { getErrorMessage } from "../errors.js";
import type { ToolDeps } from "../tools/types.js";

/**
 * One non-interactive command on one host, bounded in time and in memory.
 *
 * execCommand from the SDK buffers everything and cannot be stopped, which is
 * fine for a probe but not for a fan-out a user can cancel across dozens of
 * hosts printing logs. This keeps only the head and tail of the output and
 * closes the channel on timeout or abort.
 */

export interface ExecOutcome {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut?: boolean;
  aborted?: boolean;
  /** Set when the command never ran: no connection, no channel. */
  error?: string;
}

export interface ExecLimits {
  timeoutMs: number;
  /** Characters of output kept, head and tail. */
  outputLimit: number;
  signal: AbortSignal;
}

/** Keeps the first and last half of whatever is pushed, never more. */
export function createCapture(limit: number) {
  const headSize = Math.ceil(limit / 2);
  const tailSize = limit - headSize;
  let head = "";
  let tail = "";
  let dropped = 0;

  return {
    push(text: string) {
      const room = headSize - head.length;
      if (room > 0) {
        head += text.slice(0, room);
        text = text.slice(room);
      }
      if (!text) return;
      tail += text;
      if (tail.length > tailSize) {
        dropped += tail.length - tailSize;
        tail = tailSize > 0 ? tail.slice(-tailSize) : "";
      }
    },
    text(): string {
      if (!dropped) return head + tail;
      return `${head}\n... ${dropped} characters cut ...\n${tail}`;
    },
  };
}

/** The head and tail of `text`, `limit` characters at most plus a marker. */
export function truncateMiddle(text: string, limit: number): string {
  const capture = createCapture(limit);
  capture.push(text);
  return capture.text();
}

/** One POSIX-shell word, safe for any login shell that honours '…'. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs the command so that closing the channel ends it, output or not.
 *
 * OpenSSH ignores signal requests on a non-PTY exec and closing the channel
 * only closes its pipes, so a silent command (sleep, a hung apt or curl) would
 * outlive Stop and the timeout. The command runs in its own process group with
 * stdin from /dev/null, while a watcher reads the channel's stdin (kept on fd
 * 3, since a background job's own stdin is /dev/null) and kills the group on
 * EOF. The watcher's output goes to /dev/null so it never holds the channel
 * open after the command exits. The command is passed as $1 to sh, so the
 * login shell only sees two quoted words.
 */
const WATCHDOG = [
  "exec 3<&0",
  'if command -v setsid >/dev/null 2>&1; then setsid sh -c "$1" </dev/null 3<&- & else sh -c "$1" </dev/null 3<&- & fi',
  "p=$!",
  "( cat <&3; kill -TERM -$p 2>/dev/null || kill -TERM $p; sleep 2; kill -KILL -$p 2>/dev/null || kill -KILL $p ) >/dev/null 2>&1 &",
  "w=$!",
  "exec 3<&-",
  "wait $p",
  "rc=$?",
  "kill $w 2>/dev/null",
  "exit $rc",
].join("\n");

export function wrapCommand(command: string): string {
  return `sh -c ${shellQuote(WATCHDOG)} termix-ops ${shellQuote(command)}`;
}

export function execOnClient(
  client: Client,
  command: string,
  limits: ExecLimits,
): Promise<Omit<ExecOutcome, "durationMs">> {
  return new Promise((resolve, reject) => {
    const output = createCapture(limits.outputLimit);
    let channel: ClientChannel | null = null;
    let exitCode: number | null = null;
    let settled = false;

    const settle = (outcome: Omit<ExecOutcome, "durationMs"> | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      limits.signal.removeEventListener("abort", onAbort);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };

    // Closing the channel trips the watchdog in wrapCommand, which ends the
    // remote command; the pooled connection stays up for the next one.
    const close = () => {
      try {
        channel?.signal("KILL");
        channel?.close();
      } catch {
        // Already gone.
      }
    };

    // Settled before closing, so the close event cannot report it as a
    // normal exit.
    const stop = (reason: "timedOut" | "aborted") => {
      settle({ exitCode: null, output: output.text(), [reason]: true });
      close();
    };

    const timer = setTimeout(() => stop("timedOut"), limits.timeoutMs);
    const onAbort = () => stop("aborted");
    if (limits.signal.aborted) return stop("aborted");
    limits.signal.addEventListener("abort", onAbort, { once: true });

    client.exec(wrapCommand(command), { pty: false }, (error, stream) => {
      if (error) return settle(error);
      channel = stream;
      // Stopped while the channel was opening.
      if (settled) return close();

      const stdout = new StringDecoder("utf8");
      const stderr = new StringDecoder("utf8");
      stream.on("data", (chunk: Buffer) => output.push(stdout.write(chunk)));
      stream.stderr.on("data", (chunk: Buffer) =>
        output.push(stderr.write(chunk)),
      );
      stream.on("exit", (code: number | null) => {
        exitCode = typeof code === "number" ? code : null;
      });
      stream.on("close", (code?: number | null) => {
        // Older servers only report the code here.
        if (exitCode === null && typeof code === "number") exitCode = code;
        output.push(stdout.end() + stderr.end());
        settle({ exitCode, output: output.text() });
      });
      stream.on("error", (streamError: Error) => settle(streamError));
    });
  });
}

/** Runs over the plugin's SSH pool, the same way run_readonly_command does. */
export async function execOnHost(
  deps: ToolDeps,
  hostId: number,
  command: string,
  limits: ExecLimits,
): Promise<ExecOutcome> {
  const started = Date.now();
  try {
    const outcome = await deps.ssh.withConnection<
      Omit<ExecOutcome, "durationMs">,
      Client
    >(hostId, { pool: "ai", purpose: "ops" }, (client) =>
      execOnClient(client, command, limits),
    );
    return { ...outcome, durationMs: Date.now() - started };
  } catch (error) {
    return {
      exitCode: null,
      output: "",
      durationMs: Date.now() - started,
      error: getErrorMessage(error, "The command could not be started"),
    };
  }
}

/**
 * Runs `fn` over `items`, at most `limit` at a time, in order of start. Stops
 * starting new ones once `signal` aborts; their slots stay empty.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
