import handler from "@tanstack/react-start/server-entry"
import { apiPath, forward, sameOriginWrite } from "./forward"
import type { Upstream } from "./forward"
import { newNonce, withSecurityHeaders } from "./security-headers"

// The Worker (wrangler.jsonc `main`). It serves the app through TanStack Start, with a fresh CSP
// nonce per page, and forwards `/api/*` and `/auth/*` to the FDE API (src/forward.ts). Every
// answer leaves through one place that sets the security headers.

export type Env = {
  /** The API over the Workers VPC private link (`vpc_services`, infra `api_vpc_service_id`). */
  API?: Fetcher
  /** A local API for `pnpm dev`, e.g. http://localhost:8080. A production build ignores it. */
  API_URL?: string
}

/**
 * Where the API is, or null when this Worker has no way to it. Production goes only through the
 * private link; a plain URL is honoured in a dev build alone, so a stray var cannot redirect it.
 */
export function upstream(env: Env, dev: boolean): Upstream | null {
  // ponytail: the VPC service routes to the internal ALB it was created for (infra); the host
  // named here is assumed not to route. The first `deploy-workers` run (#40) confirms it.
  if (env.API) return { fetch: (request) => env.API!.fetch(request), origin: "http://api.internal" }
  if (dev && env.API_URL) return { fetch: (request) => fetch(request), origin: env.API_URL }
  return null
}

const refuse = (status: number, error: string) => Response.json({ error }, { status })

async function respond(request: Request, env: Env, nonce: string): Promise<Response> {
  const path = apiPath(new URL(request.url))
  if (path === null) return handler.fetch(request, { context: { nonce } })
  if (!sameOriginWrite(request)) return refuse(403, "csrf")
  const api = upstream(env, import.meta.env.DEV)
  if (!api) return refuse(503, "api_not_configured")
  return forward(request, path, api)
}

export default {
  async fetch(request, env) {
    const nonce = newNonce()
    return withSecurityHeaders(await respond(request, env, nonce), request, nonce)
  },
} satisfies ExportedHandler<Env>
