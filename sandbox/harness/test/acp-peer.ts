import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

import type { Peer } from "../src/opencode.js";
import { fixture, jsonLines } from "./fakes.js";

export interface Frame {
  dir: "agent->client" | "client->agent";
  msg: Record<string, any>;
}

export const recording = (name: string) => jsonLines(fixture(`opencode/session-${name}.acp.jsonl`)) as Frame[];

/**
 * Plays OpenCode's side of a recorded ACP session (the spike's fixtures) against the backend. Each frame the client
 * sent in the recording is a point where the peer waits for the backend to send the same kind of message; the
 * backend's own answers are kept in `sent`, so a test asserts what the backend said, not what the recording's client
 * said. Ids of the backend's requests are mapped onto the recording's. A mismatch ends the replay with an error.
 */
export class RecordedPeer implements Peer {
  readonly sent: Record<string, any>[] = [];
  stopped = false;
  error: string | undefined;
  readonly stream: Stream;
  readonly #toClient = new TransformStream<AnyMessage, AnyMessage>();
  readonly #fromClient = new TransformStream<AnyMessage, AnyMessage>();

  constructor(
    private readonly frames: readonly Frame[],
    /** The model OpenCode reports for the session; the recordings ran a stub. */
    private readonly model?: string,
  ) {
    this.stream = { writable: this.#fromClient.writable, readable: this.#toClient.readable };
    void this.#play().catch((cause: unknown) => (this.error = String(cause)));
  }

  stop(): void {
    this.stopped = true;
  }

  async #play(): Promise<void> {
    const out = this.#toClient.writable.getWriter();
    const input = this.#fromClient.readable.getReader();
    const ids = new Map<unknown, unknown>();
    for (const { dir, msg } of this.frames) {
      if (dir === "agent->client") {
        const sent = structuredClone(msg);
        if (sent["method"] === undefined) sent["id"] = ids.get(msg["id"]);
        if (this.model !== undefined)
          for (const o of sent["result"]?.configOptions ?? []) if (o.id === "model") o.currentValue = this.model;
        await out.write(sent as AnyMessage);
        continue;
      }
      const { value, done } = await input.read();
      if (done) return;
      const got = value as Record<string, any>;
      this.sent.push(got);
      const expected = msg["method"] ?? `response to ${msg["id"]}`;
      const actual = got["method"] ?? `response to ${got["id"]}`;
      if (expected !== actual) throw new Error(`expected ${expected}, got ${actual}`);
      if (msg["method"] !== undefined && msg["id"] !== undefined) ids.set(msg["id"], got["id"]);
    }
    // The recording is over: keep taking what the backend sends, and answer nothing more.
    for (;;) {
      const { value, done } = await input.read();
      if (done) return;
      this.sent.push(value as Record<string, any>);
    }
  }
}
