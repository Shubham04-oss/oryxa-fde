// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { assistantPath, signBinding } from "./assistant"
import server, { assistant } from "./server"
import type { Env } from "./server"

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: () => new Response("<!doctype html>", { status: 200 }) },
}))

const APP = "https://fde.example.test"
const TOKEN = "sample-service-token-for-tests-0123456789"
const KEY = "sample-binding-key-for-tests-0123456789ab"
const COOKIE = "__Host-fde_session=sealed"
const ME = {
  user: { id: "user_riya", name: "Riya" },
  organisation: { id: "org_sample", name: "Sample" },
  role: "member",
}

/** An API that knows the session and one company, and records what reaches it. */
function apiBinding(answer?: (request: Request) => Response) {
  const fetch = vi.fn(async (request: Request) => {
    if (answer) return answer(request)
    if (request.headers.get("cookie") !== COOKIE)
      return Response.json({ error: "unauthorized" }, { status: 401 })
    const path = new URL(request.url).pathname
    if (path === "/v1/me") return Response.json(ME)
    if (path === "/v1/companies/cmp_kestrel") return Response.json({ id: "cmp_kestrel" })
    return Response.json({ error: "not_found" }, { status: 404 })
  })
  return { binding: { fetch } as unknown as Fetcher, fetch }
}

/** The assistant Worker, recording each call and answering a stream. */
function assistantBinding() {
  const fetch = vi.fn(
    async (_request: Request) =>
      new Response("id: 0\ndata: {}\n\n", {
        headers: { "content-type": "text/event-stream", "set-cookie": "planted=1" },
      }),
  )
  return { binding: { fetch } as unknown as Fetcher, fetch }
}

function setup(api = apiBinding()) {
  const helper = assistantBinding()
  const env: Env = {
    API: api.binding,
    ASSISTANT: helper.binding,
    ASSISTANT_SERVICE_TOKEN: TOKEN,
    ASSISTANT_BINDING_KEY: KEY,
  }
  return { env, api: api.fetch, assistant: helper.fetch }
}

const call = (request: Request, env: Env) =>
  server.fetch(request as Parameters<typeof server.fetch>[0], env)

const turn = (path = "/assistant/conversations/c_1/turns", headers: Record<string, string> = {}) =>
  new Request(`${APP}${path}`, {
    method: "POST",
    headers: { cookie: COOKIE, origin: APP, "content-type": "application/json", ...headers },
    body: JSON.stringify({ text: "Set up a company called Kestrel" }),
  })

/** The claims of a binding this Worker signed. */
function claimsOf(binding: string | null) {
  const [payload] = (binding ?? "").split(".")
  return JSON.parse(atob(payload!.replaceAll("-", "+").replaceAll("_", "/"))) as Record<
    string,
    unknown
  >
}

describe("the assistant's routes on this app", () => {
  it("parse only the conversation routes, with the platform's id rule", () => {
    const at = (path: string) => assistantPath(new URL(`${APP}${path}`))
    expect(at("/assistant/conversations/c_1")).toEqual({
      conversation: "c_1",
      company: null,
      rest: "",
    })
    expect(at("/assistant/companies/cmp_1/conversations/c_1/turns/t_1/events")).toEqual({
      conversation: "c_1",
      company: "cmp_1",
      rest: "/turns/t_1/events",
    })
    for (const path of [
      "/assistant/conversations/c%2F1",
      "/assistant/conversations/c:1/turns",
      "/assistant/conversations/c_1/other",
      "/assistant/conversations/c_1/turns/t:1/events",
      "/agents/conversation/c_1",
    ])
      expect(at(path), path).toBeNull()
  })

  it("answer that the assistant is not configured without its binding, token or key", async () => {
    const { env } = setup()
    for (const missing of [
      { ASSISTANT: undefined },
      { ASSISTANT_SERVICE_TOKEN: undefined },
      { ASSISTANT_BINDING_KEY: "short" },
    ]) {
      const response = await call(turn(), { ...env, ...missing })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: "assistant_not_configured" })
    }
    expect(assistant(env)).not.toBeNull()
  })

  it("check the person with the API, then forward with the service token and a fresh binding", async () => {
    const { env, api, assistant: helper } = setup()
    const now = Date.now()
    const response = await call(turn(), env)
    expect(response.status).toBe(200)
    expect(api.mock.calls.map(([r]) => new URL(r.url).pathname)).toEqual(["/v1/me"])

    const forwarded = helper.mock.calls[0]![0]
    expect(forwarded.url).toBe("https://assistant.internal/internal/v1/conversations/c_1/turns")
    expect(forwarded.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    // The session goes with a turn, for its reads; no other cookie header does.
    expect(forwarded.headers.get("x-assistant-session")).toBe(COOKIE)
    expect(forwarded.headers.get("cookie")).toBeNull()
    const claims = claimsOf(forwarded.headers.get("x-assistant-binding"))
    expect(claims).toMatchObject({
      v: 1,
      conv: "c_1",
      tenant: "org_sample",
      person: "user_riya",
      company: null,
    })
    expect(claims.exp).toBeGreaterThanOrEqual(Math.floor(now / 1000) + 59)
    expect(claims.exp).toBeLessThanOrEqual(Math.floor(now / 1000) + 61)
    // Only the stream's type comes back from the assistant, never a cookie of its own.
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("check the company too for a company's conversation, and bind it", async () => {
    const { env, api, assistant: helper } = setup()
    const response = await call(
      turn("/assistant/companies/cmp_kestrel/conversations/c_2/turns"),
      env,
    )
    expect(response.status).toBe(200)
    expect(api.mock.calls.map(([r]) => new URL(r.url).pathname).sort()).toEqual([
      "/v1/companies/cmp_kestrel",
      "/v1/me",
    ])
    expect(claimsOf(helper.mock.calls[0]![0].headers.get("x-assistant-binding")).company).toBe(
      "cmp_kestrel",
    )
    const other = await call(turn("/assistant/companies/cmp_other/conversations/c_2/turns"), env)
    expect(other.status).toBe(404)
    expect(helper).toHaveBeenCalledTimes(1)
  })

  it("check on every reconnect, and pass on where the stream resumes, with no session", async () => {
    const { env, api, assistant: helper } = setup()
    const reconnect = new Request(`${APP}/assistant/conversations/c_1/turns/t_1/events`, {
      headers: { cookie: COOKIE, "last-event-id": "7" },
    })
    expect((await call(reconnect, env)).status).toBe(200)
    expect(api).toHaveBeenCalledTimes(1)
    const forwarded = helper.mock.calls[0]![0]
    expect(forwarded.headers.get("last-event-id")).toBe("7")
    expect(forwarded.headers.get("x-assistant-session")).toBeNull()

    const signedOut = new Request(`${APP}/assistant/conversations/c_1/turns/t_1/events`)
    const refused = await call(signedOut, env)
    expect(refused.status).toBe(401)
    expect(helper).toHaveBeenCalledTimes(1)
  })

  it("refuse when the API refuses, fails or answers something else, and never reach the assistant", async () => {
    for (const answer of [
      () => Response.json({ error: "unauthorized" }, { status: 401 }),
      () => {
        throw new TypeError("network")
      },
      () => Response.json({ user: { id: "user:x" }, organisation: { id: "org_sample" } }),
    ]) {
      const { env, assistant: helper } = setup(apiBinding(answer))
      const response = await call(turn(), env)
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(helper).not.toHaveBeenCalled()
    }
  })

  it("take writes only from this app's own pages, and only by POST", async () => {
    const { env, assistant: helper } = setup()
    expect((await call(turn(undefined, { origin: "https://evil.example" }), env)).status).toBe(403)
    const get = new Request(`${APP}/assistant/conversations/c_1/turns`, {
      headers: { cookie: COOKIE },
    })
    expect((await call(get, env)).status).toBe(405)
    const big = new Request(`${APP}/assistant/conversations/c_1/turns`, {
      method: "POST",
      headers: { cookie: COOKIE, origin: APP },
      body: "x".repeat(17 * 1024),
    })
    expect((await call(big, env)).status).toBe(413)
    expect(helper).not.toHaveBeenCalled()
  })
})

describe("a binding", () => {
  // The same vector is verified by the assistant's own tests (assistant/test/auth.test.ts).
  it("is signed exactly as the assistant verifies it", async () => {
    const binding = await signBinding(
      {
        conversation: "c_vector",
        tenant: "org_sample",
        person: "user_riya",
        company: "cmp_kestrel",
      },
      "sample-vector-key-not-a-secret-0123456789",
      Date.UTC(2026, 10, 12, 9, 0, 0),
    )
    expect(binding).toBe(
      "eyJ2IjoxLCJjb252IjoiY192ZWN0b3IiLCJ0ZW5hbnQiOiJvcmdfc2FtcGxlIiwicGVyc29uIjoidXNlcl9yaXlhIiwiY29tcGFueSI6ImNtcF9rZXN0cmVsIiwiZXhwIjoxNzk0NDc0MDYwfQ.cLwhBRHlOgjFKpTkyKXbFxHf2mqjUrWh7YA5xUHi3gc",
    )
  })
})
