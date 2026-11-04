import { authorized } from "./auth.js";
import type { Line } from "./channel.js";
import type { Env } from "./env.js";
import { channelName, parseRunPath } from "./run.js";

export { RunChannel } from "./channel.js";

// The harness's own limit on one line (`oryxa_fde_agent::event::MAX_LINE_BYTES`), and a batch of a few.
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 4 * MAX_LINE_BYTES;
const encoder = new TextEncoder();

/**
 * Live output for agent runs (ADR 0003). Two callers, each with its own token:
 * - `oryxa-fde-api` posts a run's harness lines as NDJSON to `.../agent-runs/<run>/events`;
 * - fde-web, once the API has said the FDE may see the run, opens `.../agent-runs/<run>/live` for a browser.
 * Both paths are `/internal/v1/tenants/<t>/companies/<c>/projects/<p>/agent-runs/<run>/...`.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const route = parseRunPath(new URL(request.url).pathname);
    if (route === null) return text(404, "not found");
    const channel = env.RUNS.getByName(channelName(route.address));

    if (route.action === "events") {
      if (request.method !== "POST") return text(405, "method not allowed");
      if (!(await authorized(request, env.PUBLISH_TOKEN))) return text(401, "unauthorized");
      if (!request.headers.get("content-type")?.startsWith("application/x-ndjson")) {
        return text(415, "expected application/x-ndjson");
      }
      const bytes = await readCapped(request, MAX_BODY_BYTES);
      if (bytes === null) return text(413, "too large");
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      } catch {
        return text(400, "invalid UTF-8");
      }
      const lines = parseLines(body);
      if (lines === null) return text(400, "invalid line");
      await channel.publish(lines);
      return new Response(null, { status: 202 });
    }

    if (route.action === "live") {
      if (request.method !== "GET") return text(405, "method not allowed");
      if (!(await authorized(request, env.SUBSCRIBE_TOKEN))) return text(401, "unauthorized");
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return text(426, "expected a WebSocket");
      return channel.fetch(request);
    }

    return text(404, "not found");
  },
} satisfies ExportedHandler<Env>;

/** The body, or null past `max` bytes; it stops reading there. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}

/**
 * Each non-empty line, if every one is a harness event line (`{"v":1,"seq":n,"type":...}`) under the size
 * limit; otherwise null. Lines come from a sandbox through the API, so none is trusted.
 */
export function parseLines(body: string): Array<Line> | null {
  const lines: Array<Line> = [];
  for (const raw of body.split("\n")) {
    if (raw === "") continue;
    if (encoder.encode(raw).byteLength > MAX_LINE_BYTES) return null;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof event !== "object" || event === null || Array.isArray(event)) return null;
    const { v, seq, type } = event as Record<string, unknown>;
    if (v !== 1 || typeof type !== "string" || !Number.isSafeInteger(seq) || (seq as number) < 0) return null;
    lines.push({ seq: seq as number, raw });
  }
  return lines;
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
