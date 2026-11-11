// The security headers on everything the Worker (src/server.ts) answers. Ported from the platform
// web app (oryxa-platform web/src), with the content security policy enforced rather than
// report-only, and scripts allowed by a per-request nonce instead of 'unsafe-inline'. Static
// assets are served without running the Worker, so public/_headers carries the same headers for
// them (security-headers.test.ts keeps the two in step).

/** A fresh nonce for one response: 128 random bits, base64. */
export function newNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
}

/**
 * What a page of the app may do. Each source is here for one reason:
 *
 * - `script-src 'nonce-…'`: the inline scripts the server render writes (the state the app
 *   hydrates from, the theme boot script) carry this response's nonce; nothing else inline runs.
 * - `style-src 'unsafe-inline'`: React writes `style` attributes.
 * - `img-src data:`: small SVGs inlined in the stylesheets.
 * - `connect-src 'self'` and its socket origin: the API is reached on the app's own origin, and
 *   `vite dev` reloads over a socket on it.
 * - `form-action 'self'`, `frame-src 'none'`, `frame-ancestors 'none'`, `object-src 'none'`,
 *   `base-uri 'self'`: no posting, framing or plugins anywhere else.
 */
function policy(socketOrigin: string, nonce: string | undefined): string {
  return [
    "default-src 'self'",
    nonce ? `script-src 'self' 'nonce-${nonce}'` : "script-src 'self'",
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

/**
 * The policy on static assets (public/_headers). No asset is a page, so one opened on its own
 * (an SVG, say) may run and load nothing.
 */
export const ASSET_POLICY =
  "default-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'"

/** Whether `url` is a sign-in page (ADR 0007), which may carry an emailed link's token. */
export function signInPage(url: URL): boolean {
  return url.pathname === "/sign-in" || url.pathname.startsWith("/sign-in/")
}

/** The headers for a response to a request for `url`, whose scripts carry `nonce` if any. */
export function securityHeaders(url: URL, nonce?: string): Record<string, string> {
  const secure = url.protocol === "https:"
  return {
    // RFC 6797 §7.2: never over plain http, as `vite dev` serves.
    ...(secure && { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }),
    "X-Content-Type-Options": "nosniff",
    // Sign-in pages may read a reset or invite token from their address: they send no Referer at all.
    "Referrer-Policy": signInPage(url) ? "no-referrer" : "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": policy(`${secure ? "wss" : "ws"}://${url.host}`, nonce),
  }
}

/**
 * `response` with the security headers set over any it carries. The copy shares `response`'s
 * body, which stays a stream, and keeps every Set-Cookie.
 */
export function withSecurityHeaders(
  response: Response,
  request: Request,
  nonce?: string,
): Response {
  // A response from `fetch` has immutable headers: copy it to set them.
  const copy = new Response(response.body, response)
  for (const [name, value] of Object.entries(securityHeaders(new URL(request.url), nonce))) {
    copy.headers.set(name, value)
  }
  return copy
}
