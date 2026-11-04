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
