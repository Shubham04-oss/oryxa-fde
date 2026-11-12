import { authorized, validId, verifyBinding } from "./auth.js";
import { Settle } from "./catalogue/wire.js";
import type { Env } from "./env.js";
import { MAX_BODY_BYTES, MAX_SESSION_BYTES } from "./limits.js";

export { Conversation } from "./conversation.js";
export { PersonTurns } from "./limits.js";

/** The binding fde-web signed for this request (auth.ts). */
export const BINDING_HEADER = "x-assistant-binding";
/** The person's session, as their browser sent it to fde-web: on a turn only, for that turn's reads. */
export const SESSION_HEADER = "x-assistant-session";

export type Route =
  | { action: "view"; conversation: string }
  | { action: "turn"; conversation: string }
  | { action: "events"; conversation: string; turn: string }
  | { action: "settle"; conversation: string; proposal: string };

/**
 * The route for `pathname`, or null. Not URI-decoded: an encoded `/` stays in an id and is refused.
 * - `GET  /internal/v1/conversations/<c>`: the conversation so far (JSON);
 * - `POST /internal/v1/conversations/<c>/turns`: a turn, answered with its stream (SSE);
 * - `GET  /internal/v1/conversations/<c>/turns/<t>/events`: a turn's stream again, from `Last-Event-ID` (SSE);
 * - `POST /internal/v1/conversations/<c>/proposals/<p>`: the person's answer to a proposal.
 */
export function parseRoute(method: string, pathname: string): Route | "method" | null {
  const [empty, internal, version, conversations, conversation, ...rest] = pathname.split("/");
  if (empty !== "" || internal !== "internal" || version !== "v1" || conversations !== "conversations") return null;
  if (!validId(conversation)) return null;
  const want = (m: string, route: Route) => (method === m ? route : "method");
  if (rest.length === 0) return want("GET", { action: "view", conversation });
  if (rest.length === 1 && rest[0] === "turns") return want("POST", { action: "turn", conversation });
  if (rest.length === 3 && rest[0] === "turns" && validId(rest[1], 80) && rest[2] === "events") {
    return want("GET", { action: "events", conversation, turn: rest[1] });
  }
  if (rest.length === 2 && rest[0] === "proposals" && validId(rest[1], 80)) {
    return want("POST", { action: "settle", conversation, proposal: rest[1] });
  }
  return null;
}

/**
 * The workspace assistant (issue #236, ADR 0008 and 0009). Only fde-web calls it, by service binding: there is
 * no workers.dev URL and no route, and the Agents SDK's default routing by name is not used. Every call carries
 * the service token and a binding fde-web signed after checking the person with the API; any failure refuses.
 */
export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      // Nothing about the failure is logged or returned: it could carry the message or the session.
      return json(500, "internal");
    }
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env): Promise<Response> {
  const route = parseRoute(request.method, new URL(request.url).pathname);
  if (route === null) return json(404, "not_found");
  if (!(await authorized(request, env.SERVICE_TOKEN))) return json(401, "unauthorized");
  if (route === "method") return json(405, "method_not_allowed");
  const binding = await verifyBinding(request.headers.get(BINDING_HEADER), env.BINDING_KEY, route.conversation);
  if (binding === null) return json(403, "forbidden");
  const conversation = env.CONVERSATIONS.getByName(route.conversation);

  switch (route.action) {
    case "view":
      return conversation.view(binding);
    case "events":
      return conversation.events(binding, route.turn, resumeFrom(request));
    case "turn": {
      const session = request.headers.get(SESSION_HEADER);
      if (session === null || session === "" || session.length > MAX_SESSION_BYTES) return json(400, "no_session");
      const body = await jsonBody(request);
      if (body === TOO_LARGE) return json(413, "too_long");
      const text = (body as { text?: unknown } | null)?.text;
      if (typeof text !== "string") return json(400, "invalid_message");
      return conversation.turn(binding, text, session);
    }
    case "settle": {
      const settle = Settle.safeParse(await jsonBody(request));
      if (!settle.success) return json(400, "invalid_outcome");
      return conversation.settle(binding, route.proposal, settle.data.outcome);
    }
  }
}

/** Where a resumed stream starts: after `Last-Event-ID`, as an `EventSource` sends it, else `?from=`, else 0. */
export function resumeFrom(request: Request): number {
  const last = Number(request.headers.get("last-event-id") ?? "");
  if (request.headers.has("last-event-id") && Number.isSafeInteger(last) && last >= 0) return last + 1;
  const from = Number(new URL(request.url).searchParams.get("from") ?? "0");
  return Number.isSafeInteger(from) && from >= 0 ? from : 0;
}

const TOO_LARGE = Symbol("too large");

/** The JSON body, null when it does not parse, or `TOO_LARGE` past `MAX_BODY_BYTES`, where it stops reading. */
async function jsonBody(request: Request): Promise<unknown> {
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(concat(chunks, size)),
    ) as unknown;
  } catch {
    return null;
  }
}

function concat(chunks: Array<Uint8Array>, size: number): Uint8Array {
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}

function json(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
