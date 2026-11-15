// The workspace assistant for the browser (assistant/README.md, ADR 0009). The browser calls `/assistant/*` on
// this app's own origin and never reaches the assistant Worker. On every call, a turn and a reconnect alike, this
// Worker asks the API who the person is and whether they hold this conversation, bound to this company (or home),
// and may still use it (the API's check route); then it signs a binding for that conversation, person and company,
// valid for a minute, and calls the assistant over its service binding with the service token. Any error, timeout
// or mismatch refuses. A new conversation is made by the API, as the person, so the API alone decides the binding.
// The person's session is lent with a turn, a view and an answer to a proposal: the assistant reads with it, writes
// the finished turn and the answer to the API's record with it (issue #279), and rebuilds a conversation it no longer
// holds from that record. It keeps none of it. A reconnect and a stop lend nothing.

import type { Upstream } from "./forward"

/** The assistant Worker, its service token, and the key this Worker signs bindings with. */
export type Assistant = {
  fetch: (request: Request) => Promise<Response>
  token: string
  key: string
}

export type AssistantTarget = {
  /** Null for `POST .../conversations`, which asks the API for a new one. */
  conversation: string | null
  /** The company the conversation is bound to; null for the home conversation, which spans the list. */
  company: string | null
  /** What is asked of it, after the conversation's own path. */
  rest: "" | "/turns" | `/turns/${string}/events` | `/turns/${string}/stop` | `/proposals/${string}`
}

const ID = /^[A-Za-z0-9_-]{1,128}$/
const PATH =
  /^\/assistant\/(?:companies\/([^/]+)\/)?conversations(?:\/([^/]+)(\/turns|\/turns\/([^/]+)\/(?:events|stop)|\/proposals\/([^/]+))?)?$/

/**
 * The conversation in `/assistant/conversations/<c>[...]` (the home one) or
 * `/assistant/companies/<company>/conversations/<c>[...]`, with no conversation for a new one, or null for any
 * other path or a bad id.
 */
export function assistantPath(url: URL): AssistantTarget | null {
  const match = PATH.exec(url.pathname)
  if (!match) return null
  const [, company, conversation, rest = "", turn, proposal] = match
  const ids = [conversation, company, turn, proposal].filter((id) => id !== undefined)
  if (!ids.every((id) => ID.test(id))) return null
  return {
    conversation: conversation ?? null,
    company: company ?? null,
    rest: rest as AssistantTarget["rest"],
  }
}

/** The API's session cookie (`SESSION_COOKIE` in crates/oryxa-fde-api/src/session.rs). */
export const SESSION_COOKIE = "__Host-fde_session"

/**
 * The session cookie alone, as `name=value`, from the browser's Cookie header: the assistant's reads
 * need nothing else. Null when there is none, or more than one, so nothing is guessed.
 */
export function sessionCookie(header: string | null): string | null {
  const found = (header ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
  if (found.length !== 1) return null
  return found[0]!.length > SESSION_COOKIE.length + 1 ? found[0]! : null
}

/** How long a binding lives: long enough for one call, never long enough to replay. */
export const BINDING_SECONDS = 60
/** How long the API may take to answer the check; past it the call is refused. */
const CHECK_TIMEOUT_MS = 5_000
/** The most a turn's body may carry (the assistant's own limit). */
const MAX_BODY_BYTES = 16 * 1024

const refuse = (status: number, error: string) => Response.json({ error }, { status })

/** A refusal from the API (401 or 403), passed on; anything else that fails becomes a 502. */
class Refused extends Error {
  constructor(readonly response: Response) {
    super("refused")
  }
}

/** Another service's answer, with only its status, type and body: it sets nothing else on the browser. */
function passOn(answer: Response): Response {
  const type = answer.headers.get("content-type")
  return new Response(answer.body, {
    status: answer.status,
    headers: { ...(type ? { "content-type": type } : {}), "cache-control": "no-store" },
  })
}

/** A read of the API, as the browser's session, given up after `CHECK_TIMEOUT_MS`. */
function asking(request: Request, api: Upstream, path: string): Promise<Response> {
  const headers = new Headers({ accept: "application/json" })
  const cookie = request.headers.get("cookie")
  if (cookie) headers.set("cookie", cookie)
  return api.fetch(
    new Request(new URL(path, api.origin), {
      headers,
      redirect: "manual",
      // Who someone is, and what they may use, is asked fresh every time.
      cache: "no-store",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    }),
  )
}

/** Asks the API, as the browser's session, and answers with the parsed body. */
async function ask(request: Request, api: Upstream, path: string): Promise<unknown> {
  const response = await asking(request, api, path)
  if (response.status === 401 || response.status === 403) throw new Refused(response)
  if (!response.ok) throw new Error("api")
  return response.json()
}

/**
 * The API's check route: "yes" only for its 204 (the person holds `conversation`, bound to `company` or to home,
 * and may still use it), "no" for its 404, and "error" for anything else, which refuses as well.
 */
async function check(
  request: Request,
  api: Upstream,
  conversation: string,
  company: string | null,
): Promise<"yes" | "no" | "error"> {
  const query = company === null ? "" : `?company=${company}`
  const response = await asking(
    request,
    api,
    `/v1/assistant/conversations/${conversation}/check${query}`,
  )
  if (response.status === 204) return "yes"
  return response.status === 404 ? "no" : "error"
}

/**
 * Asks the API for a new conversation, as the person, bound to `company` (or home): the API mints its id and
 * binds it to the session's person, so nothing the browser sends decides the binding. Answers `{ id }`.
 */
async function start(request: Request, api: Upstream, company: string | null): Promise<Response> {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    // The API's own proof of a write from the web app; the origin was checked equal to this app's.
    "x-oryxa-request": "1",
    origin: new URL(request.url).origin,
  })
  const cookie = request.headers.get("cookie")
  if (cookie) headers.set("cookie", cookie)
  const response = await api.fetch(
    new Request(new URL("/v1/assistant/conversations", api.origin), {
      method: "POST",
      headers,
      body: JSON.stringify(company === null ? {} : { company }),
      redirect: "manual",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    }),
  )
  // A refusal (signed out, no right to the company) is passed on; anything else unexpected is a 502.
  if (response.status >= 400 && response.status < 500) return passOn(response)
  if (response.status !== 201) return refuse(502, "bad_gateway")
  const made = (await response.json().catch(() => null)) as {
    id?: unknown
    company?: unknown
  } | null
  if (typeof made?.id !== "string" || !ID.test(made.id)) return refuse(502, "bad_gateway")
  if ((made.company ?? null) !== company) return refuse(502, "bad_gateway")
  return Response.json({ id: made.id }, { status: 201, headers: { "cache-control": "no-store" } })
}

export type BindingClaims = {
  conversation: string
  tenant: string
  person: string
  company: string | null
}

const encoder = new TextEncoder()
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

/**
 * The binding the assistant verifies (`assistant/src/auth.ts`): the claims as JSON, base64url, then a dot and
 * the HMAC-SHA256 of that text under `key`, base64url.
 */
export async function signBinding(claims: BindingClaims, key: string, now = Date.now()) {
  const payload = base64url(
    encoder.encode(
      JSON.stringify({
        v: 1,
        conv: claims.conversation,
        tenant: claims.tenant,
        person: claims.person,
        company: claims.company,
        exp: Math.floor(now / 1000) + BINDING_SECONDS,
      }),
    ),
  )
  const hmac = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", hmac, encoder.encode(payload))
  return `${payload}.${base64url(new Uint8Array(signature))}`
}

/** The body, or null past `MAX_BODY_BYTES`; it stops reading there. */
async function bounded(request: Request): Promise<ArrayBuffer | null> {
  const reader = request.body?.getReader()
  if (!reader) return new ArrayBuffer(0)
  const pieces: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    pieces.push(value)
  }
  const whole = new Uint8Array(size)
  let at = 0
  for (const piece of pieces) {
    whole.set(piece, at)
    at += piece.byteLength
  }
  return whole.buffer
}

/**
 * Checks the person with the API, then forwards one call to the assistant with a fresh binding. Writes come
 * only from this app's own pages. The person's session cookie, with this app's origin, which the API asks of a
 * write made with it, goes with a turn, a view and an answer, for that call alone.
 */
export async function openAssistant(
  request: Request,
  target: AssistantTarget,
  api: Upstream,
  assistant: Assistant,
): Promise<Response> {
  const { conversation, company } = target
  // Stopping a turn is a write too: only this app's pages may ask for it, and only as the person checked here.
  const write =
    conversation === null ||
    target.rest === "/turns" ||
    target.rest.startsWith("/proposals/") ||
    (target.rest.startsWith("/turns/") && target.rest.endsWith("/stop"))
  if (request.method !== (write ? "POST" : "GET")) return refuse(405, "method_not_allowed")
  if (write && request.headers.get("origin") !== new URL(request.url).origin)
    return refuse(403, "csrf")

  if (conversation === null) return start(request, api, company)

  const [me, bound] = await Promise.allSettled([
    ask(request, api, "/v1/me"),
    check(request, api, conversation, company),
  ])
  if (me.status === "rejected") {
    if (me.reason instanceof Refused) return passOn(me.reason.response)
    return refuse(502, "bad_gateway")
  }
  // Not theirs, bound elsewhere and not there at all are one answer, so it says nothing of whose it is.
  if (bound.status === "fulfilled" && bound.value === "no")
    return refuse(404, "unknown_conversation")
  if (bound.status === "rejected" || bound.value !== "yes") return refuse(502, "bad_gateway")
  const { user, organisation } =
    (me.value as { user?: { id?: unknown }; organisation?: { id?: unknown } } | null) ?? {}
  const person = user?.id
  const tenant = organisation?.id
  if (typeof person !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(person))
    return refuse(502, "bad_gateway")
  if (typeof tenant !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenant))
    return refuse(502, "bad_gateway")

  const binding = await signBinding({ conversation, company, tenant, person }, assistant.key)
  const headers = new Headers({
    authorization: `Bearer ${assistant.token}`,
    "x-assistant-binding": binding,
    accept: write ? "text/event-stream, application/json" : "application/json",
  })
  // A reconnect names the last event it had, so the stream resumes after it.
  const last = request.headers.get("last-event-id")
  if (last !== null && /^\d{1,9}$/.test(last)) headers.set("last-event-id", last)
  let body: ArrayBuffer | undefined
  if (write) {
    const read = await bounded(request)
    if (read === null) return refuse(413, "too_long")
    body = read
    headers.set("content-type", "application/json")
  }
  const lends =
    target.rest === "/turns" || target.rest === "" || target.rest.startsWith("/proposals/")
  const session = lends ? sessionCookie(request.headers.get("cookie")) : null
  // A turn cannot run without it; a view or an answer can, and the record catches up at the next turn.
  if (target.rest === "/turns" && session === null) return refuse(401, "unauthorized")
  if (session !== null) {
    headers.set("x-assistant-session", session)
    headers.set("x-assistant-origin", new URL(request.url).origin)
  }
  const answer = await assistant.fetch(
    new Request(
      `https://assistant.internal/internal/v1/conversations/${conversation}${target.rest}`,
      { method: request.method, headers, body, redirect: "manual" },
    ),
  )
  return passOn(answer)
}
