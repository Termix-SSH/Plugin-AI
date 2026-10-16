import { EventEmitter } from "node:events";

export interface FakePlan {
  stdout?: string;
  stderr?: string;
  code?: number;
  /** Never finishes on its own, like `sleep infinity`. */
  hang?: boolean;
  delayMs?: number;
}

export interface FakeChannel extends EventEmitter {
  command: string;
  stderr: EventEmitter;
  closed: boolean;
  signals: string[];
  signal: (name: string) => void;
  close: () => void;
}

/**
 * An ssh2 Client that answers exec with a scripted channel. Closing a
 * channel ends it the way a server does, with a close event.
 */
export function fakeSshClient(plan: (command: string) => FakePlan) {
  const channels: FakeChannel[] = [];
  let running = 0;
  let maxRunning = 0;

  const client = {
    exec(
      command: string,
      _options: unknown,
      callback: (error: Error | undefined, channel: FakeChannel) => void,
    ) {
      const channel = new EventEmitter() as FakeChannel;
      channel.command = command;
      channel.stderr = new EventEmitter();
      channel.closed = false;
      channel.signals = [];
      channel.signal = (name) => channel.signals.push(name);
      channel.close = () => {
        if (channel.closed) return;
        channel.closed = true;
        running -= 1;
        channel.emit("close");
      };
      channels.push(channel);
      running += 1;
      maxRunning = Math.max(maxRunning, running);

      const step = plan(command);
      callback(undefined, channel);
      if (step.hang) return;
      setTimeout(() => {
        if (channel.closed) return;
        if (step.stdout) channel.emit("data", Buffer.from(step.stdout));
        if (step.stderr) channel.stderr.emit("data", Buffer.from(step.stderr));
        channel.emit("exit", step.code ?? 0);
        channel.close();
      }, step.delayMs ?? 0);
    },
  };

  return {
    client,
    channels,
    maxRunning: () => maxRunning,
  };
}
