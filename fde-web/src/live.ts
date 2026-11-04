// Live run output for the browser (realtime/README.md). The browser opens a WebSocket on this app's own
// origin; the Worker asks the API whether the session may see the run, then connects it to the run's channel
// in the realtime Worker through a service binding. The browser never reaches the realtime Worker.

import type { Upstream } from "./forward"

/** The realtime Worker, and the token it takes from this Worker alone. */
export type Realtime = { fetch: (request: Request) => Promise<Response>; token: string }

export type LiveTarget = { company: string; project: string; run: string }

const ID = /^[A-Za-z0-9_-]{1,128}$/
const LIVE = /^\/live\/companies\/([^/]+)\/projects\/([^/]+)\/agent-runs\/([^/]+)$/

/** The run in `/live/companies/<c>/projects/<p>/agent-runs/<r>`, or null for any other path or a bad id. */
export function livePath(url: URL): LiveTarget | null {
  const match = LIVE.exec(url.pathname)
  if (!match) return null
  const [, company = "", project = "", run = ""] = match
  return [company, project, run].every((part) => ID.test(part)) ? { company, project, run } : null
}

const refuse = (status: number, error: string) => Response.json({ error }, { status })

/** Asks the API, as the browser's session, and answers with the parsed body or the API's refusal. */
async function ask(request: Request, api: Upstream, path: string): Promise<unknown> {
  const headers = new Headers({ accept: "application/json" })
  const cookie = request.headers.get("cookie")
  if (cookie) headers.set("cookie", cookie)
  const response = await api.fetch(new Request(new URL(path, api.origin), { headers }))
  if (!response.ok) throw response
  return response.json()
}

/**
 * Opens a browser's live view of a run, only for a WebSocket from this app's own pages, and only once the API
 * has answered for the run with the browser's session; its refusal goes back as it is.
 */
export async function openLive(
  request: Request,
  target: LiveTarget,
  api: Upstream,
  realtime: Realtime,
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return refuse(426, "expected_websocket")
  // Cookies go with a cross-site WebSocket too, so its origin is checked as a write's is.
  if (request.headers.get("origin") !== new URL(request.url).origin) return refuse(403, "csrf")
  const { company, project, run } = target
  let me: unknown
  try {
    ;[, me] = await Promise.all([
      ask(request, api, `/v1/companies/${company}/projects/${project}/agent-runs/${run}`),
      ask(request, api, "/v1/me"),
    ])
  } catch (refusal) {
    if (refusal instanceof Response) return new Response(refusal.body, refusal)
    throw refusal
  }
  const tenant = (me as { organisation?: { id?: unknown } } | null)?.organisation?.id
  if (typeof tenant !== "string" || !ID.test(tenant) || tenant.length > 64)
    return refuse(502, "bad_gateway")
  const path = `/internal/v1/tenants/${tenant}/companies/${company}/projects/${project}/agent-runs/${run}/live`
  return realtime.fetch(
    new Request(`https://realtime.internal${path}`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${realtime.token}` },
    }),
  )
}
