// The security headers on everything the Worker (src/server.ts) answers.
// Ported unchanged from the platform web app (oryxa-platform web/src), with
// the content security policy enforced rather than report-only: this app
// loads nothing from another origin, so it can say so.

/**
 * What a page of the app may do. Each source is here for one reason:
 *
 * - `script-src 'unsafe-inline'`: TanStack Start's server render puts the
 *   state it hydrates from in an inline script.
 * - `style-src 'unsafe-inline'`: React writes `style` attributes.
 * - `img-src data:`: small SVGs inlined in the stylesheets.
 * - `connect-src 'self'` and its socket origin: the API will be reached on
 *   the app's own origin, and `vite dev` reloads over a socket on it.
 * - `form-action 'self'`, `frame-src 'none'`, `frame-ancestors 'none'`,
 *   `object-src 'none'`, `base-uri 'self'`: no posting, framing or plugins
 *   anywhere else.
 */
function policy(socketOrigin: string): string {
  return [
    "default-src 'self'",
    // ponytail: 'unsafe-inline' for scripts until the router renders with a per-request nonce.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${socketOrigin}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ")
}

/** The headers for a response to a request for `url`. */
export function securityHeaders(url: URL): Record<string, string> {
  const secure = url.protocol === "https:"
  return {
    // RFC 6797 §7.2: never over plain http, as `vite dev` serves.
    ...(secure && { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": policy(`${secure ? "wss" : "ws"}://${url.host}`),
  }
}

/**
 * `response` with the security headers set over any it carries. The copy
 * shares `response`'s body, which stays a stream, and keeps every Set-Cookie.
 */
export function withSecurityHeaders(response: Response, request: Request): Response {
  // A response from `fetch` has immutable headers: copy it to set them.
  const copy = new Response(response.body, response)
  for (const [name, value] of Object.entries(securityHeaders(new URL(request.url)))) {
    copy.headers.set(name, value)
  }
  return copy
}
