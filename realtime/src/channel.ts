import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.js";

// The newest lines kept for a browser that connects late. It reads anything older from the API's stored
// transcript, which is the record; this channel is only the live view.
const KEEP_LINES = 500;
const KEEP_BYTES = 2 * 1024 * 1024;

/** One line of run output, checked by the Worker: its `seq` and the line as it came. */
export interface Line {
  seq: number;
  raw: string;
}

/**
 * One agent run's live output. Lines live in memory only (ADR 0003): nothing is written to storage, so a
 * restarted object starts empty and browsers fall back on the transcript.
 */
export class RunChannel extends DurableObject<Env> {
  private kept: Array<string> = [];
  private keptBytes = 0;
  private lastSeq = -1;
  private readonly sockets = new Set<WebSocket>();

  /** Sends new lines to every browser, in order, and keeps them; a line already seen (`seq`) is dropped. */
  publish(lines: Array<Line>): number {
    let sent = 0;
    for (const { seq, raw } of lines) {
      if (seq <= this.lastSeq) continue;
      this.lastSeq = seq;
      this.keep(raw);
      for (const socket of this.sockets) {
        try {
          socket.send(raw);
        } catch {
          this.sockets.delete(socket);
        }
      }
      sent += 1;
    }
    return sent;
  }

  /** A browser fde-web has checked with the API: the kept lines first, then each new one. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    for (const line of this.kept) server.send(line);
    this.sockets.add(server);
    // The browser only listens; what it sends is ignored.
    const drop = () => {
      this.sockets.delete(server);
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);
    return new Response(null, { status: 101, webSocket: client });
  }

  private keep(raw: string) {
    this.kept.push(raw);
    this.keptBytes += raw.length;
    while (this.kept.length > KEEP_LINES || this.keptBytes > KEEP_BYTES) {
      this.keptBytes -= this.kept.shift()?.length ?? 0;
    }
  }
}
