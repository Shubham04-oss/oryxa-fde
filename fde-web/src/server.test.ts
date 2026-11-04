// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import server, { upstream } from "./server"
import type { Env } from "./server"

const page = vi.hoisted(() =>
  vi.fn(
    (_request: Request, _options?: unknown) => new Response("<!doctype html>", { status: 200 }),
  ),
)
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: page } }))

const APP = "https://fde.example.test"

/** An API binding that records what reaches it and answers with `answer`. */
function apiAnswering(answer = () => Response.json({ ok: true })) {
  const fetch = vi.fn(async (_request: Request) => answer())
  return { env: { API: { fetch } as unknown as Fetcher }, fetch }
}

// workers-types' Request carries Cloudflare's `cf` properties; the DOM one does not.
const call = (request: Request, env: Env = {}) =>
  server.fetch(request as Parameters<typeof server.fetch>[0], env)

const policyOf = (response: Response) => response.headers.get("Content-Security-Policy") ?? ""

describe("the Worker", () => {
  it("serves pages through the app, each with a fresh nonce the render and the policy share", async () => {
    page.mockClear()
    const nonces = []
    for (const path of ["/", "/today", "/companies/cmp_1"]) {
      const response = await call(new Request(`${APP}${path}`))
      const options = page.mock.lastCall?.[1] as { context: { nonce: string } }
      const nonce = options.context.nonce
      expect(response.status).toBe(200)
      expect(response.headers.get("X-Frame-Options")).toBe("DENY")
      expect(policyOf(response)).toContain(`script-src 'self' 'nonce-${nonce}'`)
      expect(policyOf(response)).not.toMatch(/script-src[^;]*unsafe-inline/)
      nonces.push(nonce)
    }
    expect(new Set(nonces).size).toBe(3)
  })

  it("forwards /api/* without its prefix and /auth/* as it is, with the session cookie", async () => {
    page.mockClear()
    const { env, fetch } = apiAnswering()
    const headers = {
      Cookie: "__Host-fde_session=sealed",
      Authorization: "Bearer from-the-page",
      "X-Forwarded-For": "6.6.6.6",
      "CF-Connecting-IP": "203.0.113.7",
    }

    await call(new Request(`${APP}/api/v1/companies?x=1`, { headers }), env)
    await call(new Request(`${APP}/auth/login?return_to=%2Ftoday`), env)

    const [companies, login] = fetch.mock.calls.map(([request]) => request)
    expect(companies!.url).toBe("http://api.internal/v1/companies?x=1")
    expect(companies!.headers.get("Cookie")).toBe("__Host-fde_session=sealed")
    expect(companies!.headers.get("Authorization")).toBeNull()
    expect(companies!.headers.get("X-Forwarded-For")).toBe("203.0.113.7")
    expect(companies!.redirect).toBe("manual")
    expect(login!.url).toBe("http://api.internal/auth/login?return_to=%2Ftoday")
    expect(page).not.toHaveBeenCalled()
  })

  it("keeps a path that looks like another host on the API", async () => {
    const { env, fetch } = apiAnswering()

    await call(new Request(`${APP}/api//evil.example/x`), env)

    expect(new URL(fetch.mock.calls[0]![0].url).host).toBe("api.internal")
  })

  it("hands AuthKit's redirect and the session cookie back to the browser, with the headers", async () => {
    const { env } = apiAnswering(() => {
      const redirect = new Response(null, {
        status: 302,
        headers: { Location: "https://auth.example.test/authorize?state=s" },
      })
      redirect.headers.append("Set-Cookie", "__Host-fde_session=; Path=/; Max-Age=0")
      return redirect
    })

    const response = await call(new Request(`${APP}/auth/callback?code=c&state=s`), env)

    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe("https://auth.example.test/authorize?state=s")
    expect(response.headers.getSetCookie()).toEqual(["__Host-fde_session=; Path=/; Max-Age=0"])
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  it("refuses a write from another origin before it reaches the API, and passes its own", async () => {
    const { env, fetch } = apiAnswering()
    const write = (origin: string | null) =>
      new Request(`${APP}/api/v1/companies`, {
        method: "POST",
        headers: origin ? { Origin: origin, "Content-Type": "application/json" } : {},
        body: JSON.stringify({ name: "Kestrel Freight" }),
      })

    for (const origin of ["https://evil.example", "null", null]) {
      const refused = await call(write(origin), env)
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual({ error: "csrf" })
    }
    expect(fetch).not.toHaveBeenCalled()

    await call(write(APP), env)
    expect(await fetch.mock.calls[0]![0].json()).toEqual({ name: "Kestrel Freight" })
  })

  it("answers 503 when it has no way to the API, never anything else", async () => {
    const response = await call(new Request(`${APP}/api/v1/companies`), {})

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "api_not_configured" })
  })
})

describe("upstream", () => {
  it("takes a local API only in a dev build, and the private link always", () => {
    const local = { API_URL: "http://localhost:8080" }
    expect(upstream(local, true)?.origin).toBe("http://localhost:8080")
    expect(upstream(local, false)).toBeNull()
    expect(upstream({ ...local, ...apiAnswering().env }, false)?.origin).toBe("http://api.internal")
  })
})

describe("failures", () => {
  it("answer a forward that throws with 502 and the security headers, not Cloudflare's page", async () => {
    const env = {
      API: {
        fetch: vi.fn(async () => {
          throw new TypeError("network connection lost")
        }),
      } as unknown as Fetcher,
    }

    const response = await call(new Request(`${APP}/api/v1/companies`), env)

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: "bad_gateway" })
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(policyOf(response)).toContain("frame-ancestors 'none'")
  })

  it("answer anything else that throws with 500 and the security headers", async () => {
    page.mockImplementationOnce(() => {
      throw new Error("render failed")
    })

    const response = await call(new Request(`${APP}/today`))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "internal" })
    expect(response.headers.get("X-Frame-Options")).toBe("DENY")
  })
})

describe("live run output", () => {
  const LIVE = `${APP}/live/companies/cmp_1/projects/prj_1/agent-runs/run_1`
  const TOKEN = "sample-subscribe-token-for-tests-012345"
  const browser = (headers: Record<string, string> = {}) =>
    new Request(LIVE, {
      headers: {
        upgrade: "websocket",
        origin: APP,
        cookie: "__Host-fde_session=sealed",
        ...headers,
      },
    })

  /** The API answering for the run and for /v1/me, and a realtime Worker that records what reaches it. */
  function services(run = () => Response.json({ id: "run_1" })) {
    const api = vi.fn(async (request: Request) =>
      new URL(request.url).pathname === "/v1/me"
        ? Response.json({ user: { id: "u", name: "R" }, organisation: { id: "org_1", name: "N" } })
        : run(),
    )
    const realtime = vi.fn(async (_request: Request) => new Response("subscribed"))
    const env: Env = {
      API: { fetch: api } as unknown as Fetcher,
      REALTIME: { fetch: realtime } as unknown as Fetcher,
      REALTIME_SUBSCRIBE_TOKEN: TOKEN,
    }
    return { env, api, realtime }
  }

  it("asks the API as the browser's session, then subscribes it to the run in its tenant", async () => {
    const { env, api, realtime } = services()

    const response = await call(browser(), env)

    expect(await response.text()).toBe("subscribed")
    const asked = api.mock.calls.map(([r]) => [new URL(r.url).pathname, r.headers.get("cookie")])
    expect(asked).toContainEqual([
      "/v1/companies/cmp_1/projects/prj_1/agent-runs/run_1",
      "__Host-fde_session=sealed",
    ])
    const [subscribe] = realtime.mock.calls[0]!
    expect(new URL(subscribe.url).pathname).toBe(
      "/internal/v1/tenants/org_1/companies/cmp_1/projects/prj_1/agent-runs/run_1/live",
    )
    expect(subscribe.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(subscribe.headers.get("cookie")).toBeNull()
  })

  it("passes on the API's refusal and never subscribes", async () => {
    for (const status of [401, 403, 404]) {
      const { env, realtime } = services(() => Response.json({ error: "no" }, { status }))

      const response = await call(browser(), env)

      expect(response.status).toBe(status)
      expect(realtime).not.toHaveBeenCalled()
    }
  })

  it("refuses another site's page, a plain request and a bad id before asking anyone", async () => {
    const { env, api, realtime } = services()

    expect((await call(browser({ origin: "https://evil.example" }), env)).status).toBe(403)
    expect((await call(new Request(LIVE, { headers: { origin: APP } }), env)).status).toBe(426)
    const badId = new Request(`${APP}/live/companies/cmp:1/projects/prj_1/agent-runs/run_1`, {
      headers: { upgrade: "websocket", origin: APP },
    })
    expect((await call(badId, env)).status).not.toBe(101)
    expect(api).not.toHaveBeenCalled()
    expect(realtime).not.toHaveBeenCalled()
  })

  it("answers 503 without a realtime binding or token", async () => {
    const { env } = services()

    const response = await call(browser(), { ...env, REALTIME_SUBSCRIBE_TOKEN: undefined })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "live_not_configured" })
  })
})
