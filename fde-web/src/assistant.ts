// The workspace assistant for the browser (assistant/README.md, ADR 0009). The browser calls `/assistant/*` on
// this app's own origin and never reaches the assistant Worker. On every call, a turn and a reconnect alike, this
// Worker asks the API who the person is and, for a company's conversation, that they may read the company; then
// it signs a binding for that conversation, person and company, valid for a minute, and calls the assistant over
// its service binding with the service token. Any error, timeout or mismatch refuses.

import type { Upstream } from "./forward"

/** The assistant Worker, its service token, and the key this Worker signs bindings with. */
export type Assistant = {
  fetch: (request: Request) => Promise<Response>
  token: string
  key: string
}

export type AssistantTarget = {
  conversation: string
  /** The company the conversation is bound to; null for the home conversation, which spans the list. */
  company: string | null
  /** What is asked of it, after the conversation's own path. */
  rest: "" | "/turns" | `/turns/${string}/events` | `/proposals/${string}`
}

const ID = /^[A-Za-z0-9_-]{1,128}$/
const PATH =
  /^\/assistant\/(?:companies\/([^/]+)\/)?conversations\/([^/]+)(\/turns|\/turns\/([^/]+)\/events|\/proposals\/([^/]+))?$/

/**
 * The conversation in `/assistant/conversations/<c>[...]` (the home one) or
 * `/assistant/companies/<company>/conversations/<c>[...]`, or null for any other path or a bad id.
 */
export function assistantPath(url: URL): AssistantTarget | null {
  const match = PATH.exec(url.pathname)
  if (!match) return null
  const [, company, conversation = "", rest = "", turn, proposal] = match
  const ids = [conversation, company, turn, proposal].filter((id) => id !== undefined)
  if (!ids.every((id) => ID.test(id))) return null
  return { conversation, company: company ?? null, rest: rest as AssistantTarget["rest"] }
}

/** How long a binding lives: long enough for one call, never long enough to replay. */
export const BINDING_SECONDS = 60
/** How long the API may take to answer the check; past it the call is refused. */
const CHECK_TIMEOUT_MS = 5_000
/** The most a turn's body may carry (the assistant's own limit). */
const MAX_BODY_BYTES = 16 * 1024

const refuse = (status: number, error: string) => Response.json({ error }, { status })

/** A refusal from the API, passed on as it is; anything else that fails becomes a 502. */
class Refused extends Error {
  constructor(readonly response: Response) {
    super("refused")
  }
}

/** Asks the API, as the browser's session, and answers with the parsed body. */
async function ask(request: Request, api: Upstream, path: string): Promise<unknown> {
  const headers = new Headers({ accept: "application/json" })
  const cookie = request.headers.get("cookie")
  if (cookie) headers.set("cookie", cookie)
  const response = await api.fetch(
    new Request(new URL(path, api.origin), {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    }),
  )
  if (!response.ok) throw new Refused(response)
  return response.json()
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
 * only from this app's own pages. The person's session goes with a turn alone, for that turn's reads.
 */
export async function openAssistant(
  request: Request,
  target: AssistantTarget,
  api: Upstream,
  assistant: Assistant,
): Promise<Response> {
  const write = target.rest === "/turns" || target.rest.startsWith("/proposals/")
  if (request.method !== (write ? "POST" : "GET")) return refuse(405, "method_not_allowed")
  if (write && request.headers.get("origin") !== new URL(request.url).origin)
    return refuse(403, "csrf")

  let me: unknown
  try {
    ;[me] = await Promise.all([
      ask(request, api, "/v1/me"),
      target.company === null ? null : ask(request, api, `/v1/companies/${target.company}`),
    ])
  } catch (failure) {
    if (failure instanceof Refused) return new Response(failure.response.body, failure.response)
    return refuse(502, "bad_gateway")
  }
  const { user, organisation } =
    (me as { user?: { id?: unknown }; organisation?: { id?: unknown } } | null) ?? {}
  const person = user?.id
  const tenant = organisation?.id
  if (typeof person !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(person))
    return refuse(502, "bad_gateway")
  if (typeof tenant !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tenant))
    return refuse(502, "bad_gateway")

  const binding = await signBinding({ ...target, tenant, person }, assistant.key)
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
  if (target.rest === "/turns") {
    const cookie = request.headers.get("cookie")
    if (!cookie) return refuse(401, "unauthorized")
    headers.set("x-assistant-session", cookie)
  }
  const answer = await assistant.fetch(
    new Request(
      `https://assistant.internal/internal/v1/conversations/${target.conversation}${target.rest}`,
      { method: request.method, headers, body, redirect: "manual" },
    ),
  )
  // Only its status, type and body come back: the assistant sets nothing else on the browser.
  const type = answer.headers.get("content-type")
  return new Response(answer.body, {
    status: answer.status,
    headers: { ...(type ? { "content-type": type } : {}), "cache-control": "no-store" },
  })
}
