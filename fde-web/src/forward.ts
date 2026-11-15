// What the Worker forwards to the FDE API (the platform's web contract, docs/web-api.md there):
// `/api/*` with the `/api` prefix removed, and `/auth/*` unchanged. Nothing else leaves the
// Worker, and it only ever calls the API: the private link in a deploy, a local API in dev.

/** Where the API is: something that fetches, and the origin its requests are addressed to. */
export type Upstream = { fetch: (request: Request) => Promise<Response>; origin: string }

/** The API path for `url`, or null when the Worker serves it itself. */
export function apiPath(url: URL): string | null {
  if (url.pathname.startsWith("/api/")) return url.pathname.slice("/api".length)
  if (url.pathname.startsWith("/auth/")) return url.pathname
  return null
}

/**
 * Whether a call is one of the assistant's conversation writes, which the browser never sends (append a turn,
 * answer a proposal: PUT `/v1/assistant/conversations/{c}/turns/{n}` and `.../turns/{n}/proposals/{p}`), so the
 * stored transcript cannot be written by hand. Every method but a read, on any path under a conversation's
 * `turns`, after decoding, in lower case and with runs of slashes as one, so no spelling slips through; a path that
 * cannot be decoded counts as one.
 */
export function relayOnly(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") return false
  let plain: string
  try {
    plain = decodeURIComponent(path)
  } catch {
    return true
  }
  return /^\/v1\/assistant\/conversations\/.+\/turns(?:\/|$)/.test(
    plain.toLowerCase().replace(/\/+/g, "/"),
  )
}

/**
 * Whether a request may change something: reads always, writes only from this app's own pages.
 * The API checks this too (with `X-Oryxa-Request`); the Worker refuses first, failing closed.
 */
export function sameOriginWrite(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true
  return request.headers.get("Origin") === new URL(request.url).origin
}

/**
 * The most a write may carry through the Worker: the API's own limit for a document (20 MiB,
 * `MAX_DOCUMENT_BYTES` in `oryxa-fde-context`). No other route takes more, and the API still applies
 * each route's own limit; this only keeps a huge body from being buffered here first.
 */
export const MAX_BODY_BYTES = 20 * 1024 * 1024

/**
 * The request's body, or null when it is larger than `max`. It is read in pieces, so a body that
 * declares no length (chunked) cannot fill the Worker's memory before it is refused.
 */
async function bounded(request: Request, max: number): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > max) return null
  const reader = request.body?.getReader()
  if (!reader) return new ArrayBuffer(0)
  const pieces: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
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

/** What the link answers when the API's end of it is going away mid-deploy, so a read is worth repeating. */
// Not 504: a gateway timeout means the API may still be working, so a retry would double the work and the wait.
const RETRIED_STATUSES = new Set([502, 503])

/** How long a read waits before its one retry: short, so a reader barely notices, and fixed. */
export const RETRY_PAUSE_MS = 250

/**
 * Whether an API path is under `/auth`, read the way `relayOnly` reads one: decoded, in lower case and with runs of
 * slashes as one; a path that cannot be decoded counts as one.
 */
function underAuth(path: string): boolean {
  let plain: string
  try {
    plain = decodeURIComponent(path)
  } catch {
    return true
  }
  return /^\/auth(?:\/|$)/.test(plain.toLowerCase().replace(/\/+/g, "/"))
}

/**
 * Forwards `request` to `path` on the API, cookies and all, and hands back its answer as it is.
 * Redirects are not followed: an AuthKit 302 belongs to the browser, never to this server.
 * A read (GET, HEAD) whose first try fails or that the link answers 502 or 503 is sent once more
 * after `RETRY_PAUSE_MS`, unless the browser has gone, and that answer is passed on whatever it is.
 * A write never is, nor anything under `/auth`.
 */
export async function forward(request: Request, path: string, api: Upstream): Promise<Response> {
  const target = new URL(api.origin)
  // Set as a path, never parsed as a URL: `//other.host/x` stays on the API.
  target.pathname = path
  target.search = new URL(request.url).search
  const headers = new Headers(request.headers)
  headers.delete("host")
  // The session is the API's HttpOnly cookie; no other credential passes through.
  headers.delete("authorization")
  // The client must not choose its own address: use Cloudflare's view of the peer.
  const client = request.headers.get("cf-connecting-ip")
  for (const name of ["x-forwarded-for", "x-real-ip", "forwarded"]) headers.delete(name)
  if (client) headers.set("x-forwarded-for", client)
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await bounded(request, MAX_BODY_BYTES)
  if (body === null) return Response.json({ error: "payload_too_large" }, { status: 413 })
  const send = () =>
    api.fetch(new Request(target, { method: request.method, headers, body, redirect: "manual" }))
  if (request.method !== "GET" && request.method !== "HEAD") return send()
  // A sign-in code is single use, and an authorization server may revoke what it issued when one is reused.
  if (underAuth(path)) return send()
  // An API deploy replaces the tunnel connector; a read caught by the old one gets one more try.
  try {
    const first = await send()
    if (!RETRIED_STATUSES.has(first.status)) return first
    await first.body?.cancel()
  } catch {
    // Any failure of the first try: the second try's answer, or what it throws, is the one passed on.
  }
  await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS))
  // Nobody is waiting for the answer any more, so the API is not asked again.
  if (request.signal.aborted) throw new DOMException("aborted", "AbortError")
  return send()
}
