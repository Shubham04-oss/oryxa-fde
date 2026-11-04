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
 * Whether a request may change something: reads always, writes only from this app's own pages.
 * The API checks this too (with `X-Oryxa-Request`); the Worker refuses first, failing closed.
 */
export function sameOriginWrite(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true
  return request.headers.get("Origin") === new URL(request.url).origin
}

/**
 * Forwards `request` to `path` on the API, cookies and all, and hands back its answer as it is.
 * Redirects are not followed: an AuthKit 302 belongs to the browser, never to this server.
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
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
  return api.fetch(
    new Request(target, { method: request.method, headers, body, redirect: "manual" }),
  )
}
