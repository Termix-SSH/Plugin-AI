import type { Response } from "express";

/**
 * Turns `res` into a server-sent event stream for an assistant run: headers,
 * a keepalive, a send that ignores a closed response, and an abort signal for
 * when the client goes away.
 */
export function openEventStream(res: Response) {
  // no-transform keeps core's compression from buffering the stream, and
  // X-Accel-Buffering does the same for nginx.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  // req's own "close" already fired once express read the body, so the
  // response is what tells us the client went away.
  const abort = new AbortController();
  res.on("close", () => {
    clearInterval(heartbeat);
    if (!res.writableFinished) abort.abort();
  });

  const send = (event: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  return {
    send,
    signal: abort.signal,
    stopHeartbeat: () => clearInterval(heartbeat),
  };
}
