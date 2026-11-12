import handler from "@tanstack/react-start/server-entry"
import { assistantPath, openAssistant } from "./assistant"
import type { Assistant } from "./assistant"
import { apiPath, forward, sameOriginWrite } from "./forward"
import type { Upstream } from "./forward"
import { livePath, openLive } from "./live"
import type { Realtime } from "./live"
import { newNonce, withSecurityHeaders } from "./security-headers"

// The Worker (wrangler.jsonc `main`). It serves the app through TanStack Start, with a fresh CSP
// nonce per page, forwards `/api/*` and `/auth/*` to the FDE API (src/forward.ts), opens live
// run output at `/live/*` (src/live.ts), and reaches the workspace assistant at `/assistant/*`
// (src/assistant.ts). Every answer but a WebSocket's leaves through one place that sets the
// security headers, a failure included.

export type Env = {
  /** The API over the Workers VPC private link (`vpc_services`, infra `api_vpc_service_id`). */
  API?: Fetcher
  /** A local API for `pnpm dev`, e.g. http://localhost:8080. A production build ignores it. */
  API_URL?: string
  /** The realtime Worker (realtime/), by service binding. */
  REALTIME?: Fetcher
  /** What the realtime Worker takes from this Worker to subscribe a browser (its `SUBSCRIBE_TOKEN`). */
  REALTIME_SUBSCRIBE_TOKEN?: string
  /** The assistant Worker (assistant/), by service binding. */
  ASSISTANT?: Fetcher
  /** What the assistant takes from this Worker on every call (its `SERVICE_TOKEN`). */
  ASSISTANT_SERVICE_TOKEN?: string
  /** The key this Worker signs conversation bindings with (the assistant's `BINDING_KEY`). */
  ASSISTANT_BINDING_KEY?: string
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

/** The realtime Worker, or null when this Worker has no binding or token for it. */
export function realtime(env: Env): Realtime | null {
  const { REALTIME: binding, REALTIME_SUBSCRIBE_TOKEN: token } = env
  return binding && token ? { fetch: (request) => binding.fetch(request), token } : null
}

/** The shortest secret taken: a placeholder never configures the assistant. */
const MIN_SECRET_LENGTH = 32

/**
 * The assistant Worker, or null when this Worker has no binding, token or key for it: the welcome
 * screen then keeps its scripted answers.
 */
export function assistant(env: Env): Assistant | null {
  const { ASSISTANT: binding, ASSISTANT_SERVICE_TOKEN: token, ASSISTANT_BINDING_KEY: key } = env
  if (!binding || !token || !key) return null
  if (token.length < MIN_SECRET_LENGTH || key.length < MIN_SECRET_LENGTH) return null
  return { fetch: (request) => binding.fetch(request), token, key }
}

const refuse = (status: number, error: string) => Response.json({ error }, { status })

/** A call to another service that throws (it is down, or the request cannot be made) is a 502. */
async function across(call: () => Promise<Response>): Promise<Response> {
  try {
    return await call()
  } catch {
    return refuse(502, "bad_gateway")
  }
}

async function respond(request: Request, env: Env, nonce: string): Promise<Response> {
  const url = new URL(request.url)
  const live = livePath(url)
  const path = apiPath(url)
  const asked = assistantPath(url)
  if (live === null && path === null && asked === null)
    return handler.fetch(request, { context: { nonce } })
  if (path !== null && !sameOriginWrite(request)) return refuse(403, "csrf")
  const api = upstream(env, import.meta.env.DEV)
  if (!api) return refuse(503, "api_not_configured")
  if (path !== null) return across(() => forward(request, path, api))
  if (asked !== null) {
    const helper = assistant(env)
    if (!helper) return refuse(503, "assistant_not_configured")
    return across(() => openAssistant(request, asked, api, helper))
  }
  const channel = realtime(env)
  if (!channel || live === null) return refuse(503, "live_not_configured")
  return across(() => openLive(request, live, api, channel))
}

export default {
  async fetch(request, env) {
    const nonce = newNonce()
    let response: Response
    try {
      response = await respond(request, env, nonce)
    } catch {
      response = refuse(500, "internal")
    }
    // A WebSocket's 101 carries the socket itself; it is passed on untouched.
    if (response.status === 101) return response
    return withSecurityHeaders(response, request, nonce)
  },
} satisfies ExportedHandler<Env>
