// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

const OTHER_COOKIE = "__Host-fde_session=omar"
const PEOPLE: Record<string, typeof ME> = {
  [COOKIE]: ME,
  [OTHER_COOKIE]: { ...ME, user: { id: "user_omar", name: "Omar" } },
}
/** The conversations the API holds: whose each is, and the company it is bound to (null for home). */
const HELD: Record<string, { person: string; company: string | null }> = {
  c_1: { person: "user_riya", company: null },
  c_2: { person: "user_riya", company: "cmp_kestrel" },
  c_omar: { person: "user_omar", company: null },
}

/** The API's check route, as `crates/oryxa-fde-api/src/assistant.rs` answers it: 204, or 404 for every refusal. */
function checkAnswer(request: Request): Response {
  const url = new URL(request.url)
  const conversation = /^\/v1\/assistant\/conversations\/([^/]+)\/check$/.exec(url.pathname)?.[1]
  const person = PEOPLE[request.headers.get("cookie") ?? ""]?.user.id
  const held = HELD[conversation ?? ""]
  if (held && held.person === person && held.company === url.searchParams.get("company"))
    return new Response(null, { status: 204 })
  return Response.json({ error: "not_found" }, { status: 404 })
}

/**
 * An API that knows two sessions and the conversations above, and records what reaches it; `answer` stands in
 * for every route, or `onCheck` for the check route alone.
 */
function apiBinding(
  answer?: (request: Request) => Response,
  onCheck: (request: Request) => Response = checkAnswer,
) {
  const fetch = vi.fn(async (request: Request) => {
    if (answer) return answer(request)
    const path = new URL(request.url).pathname
    if (path.endsWith("/check")) return onCheck(request)
    const me = PEOPLE[request.headers.get("cookie") ?? ""]
    if (!me) return Response.json({ error: "unauthorized" }, { status: 401 })
    if (path === "/v1/me") return Response.json(me)
    if (path === "/v1/assistant/conversations" && request.method === "POST") {
      const { company = null } = await request.clone().json<{ company?: string }>()
      if (company !== null && company !== "cmp_kestrel")
        return Response.json({ error: "forbidden" }, { status: 403 })
      return Response.json({ id: "cnv_new", company, project: null }, { status: 201 })
    }
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

// The routes are live only in a build with the new workspace on (src/lib/workspace/flag.ts).
beforeEach(() => vi.stubEnv("VITE_FDE_WORKSPACE", "1"))
afterEach(() => vi.unstubAllEnvs())

describe("the assistant's routes on this app", () => {
  it("are not there at all unless the build turns the new workspace on", async () => {
    for (const flag of ["0", "", "true"]) {
      vi.stubEnv("VITE_FDE_WORKSPACE", flag)
      const { env, api, assistant: helper } = setup()
      for (const request of [
        turn(),
        new Request(`${APP}/assistant/conversations/c_1`, { headers: { cookie: COOKIE } }),
        new Request(`${APP}/assistant/companies/cmp_kestrel/conversations/c_1/turns/t_1/events`, {
          headers: { cookie: COOKIE },
        }),
      ]) {
        const response = await call(request, env)
        expect(response.status, flag).toBe(404)
        expect(await response.json()).toEqual({ error: "not_found" })
      }
      // Configured or not, nothing is asked of the API or the assistant.
      expect(api).not.toHaveBeenCalled()
      expect(helper).not.toHaveBeenCalled()
    }
  })

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
    expect(at("/assistant/conversations/c_1/turns/t_1/stop")?.rest).toBe("/turns/t_1/stop")
    // A new conversation: the API makes it, so there is no id yet.
    expect(at("/assistant/conversations")).toEqual({ conversation: null, company: null, rest: "" })
    expect(at("/assistant/companies/cmp_1/conversations")).toEqual({
      conversation: null,
      company: "cmp_1",
      rest: "",
    })
    for (const path of [
      "/assistant/conversations/c%2F1",
      "/assistant/conversations/c:1/turns",
      "/assistant/conversations/c_1/other",
      "/assistant/conversations/c_1/turns/t:1/events",
      "/assistant/conversations/c_1/turns/t%2F1/stop",
      "/assistant/conversations/c_1/turns/stop",
      "/assistant/conversations/",
      "/assistant/companies/cmp:1/conversations",
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
    expect(api.mock.calls.map(([r]) => new URL(r.url).pathname)).toEqual([
      "/v1/me",
      "/v1/assistant/conversations/c_1/check",
    ])
    // A home conversation is checked as one: no company is named.
    expect(new URL(api.mock.calls[1]![0].url).search).toBe("")

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
    expect(api.mock.calls.map(([r]) => new URL(r.url).pathname)).toEqual([
      "/v1/me",
      "/v1/assistant/conversations/c_2/check",
    ])
    expect(new URL(api.mock.calls[1]![0].url).searchParams.get("company")).toBe("cmp_kestrel")
    expect(claimsOf(helper.mock.calls[0]![0].headers.get("x-assistant-binding")).company).toBe(
      "cmp_kestrel",
    )
    const other = await call(turn("/assistant/companies/cmp_other/conversations/c_2/turns"), env)
    expect(other.status).toBe(404)
    expect(helper).toHaveBeenCalledTimes(1)
  })

  it("lend the assistant the session cookie alone, never the browser's other cookies", async () => {
    const {
      env,
      api,
      assistant: helper,
    } = setup(
      apiBinding((request) =>
        !request.headers.get("cookie")?.includes(COOKIE)
          ? Response.json({ error: "unauthorized" }, { status: 401 })
          : request.url.endsWith("/check")
            ? new Response(null, { status: 204 })
            : Response.json(ME),
      ),
    )
    const response = await call(
      turn(undefined, { cookie: `theme=dark; ${COOKIE}; __Host-fde_signin=pending; other=1` }),
      env,
    )
    expect(response.status).toBe(200)
    // The API still checks the person with the browser's own header.
    expect(api.mock.calls[0]![0].headers.get("cookie")).toContain("theme=dark")
    expect(helper.mock.calls[0]![0].headers.get("x-assistant-session")).toBe(COOKIE)
  })

  it("refuse a turn with no session cookie, or two, before the assistant hears of it", async () => {
    for (const cookie of ["theme=dark; other=1", `${COOKIE}; __Host-fde_session=another`]) {
      // The API is not what refuses here: it is told the person is known.
      const { env, assistant: helper } = setup(
        apiBinding((request) =>
          new URL(request.url).pathname === "/v1/me"
            ? Response.json(ME)
            : new Response(null, { status: 204 }),
        ),
      )
      const response = await call(turn(undefined, { cookie }), env)
      expect(response.status, cookie).toBe(401)
      expect(helper).not.toHaveBeenCalled()
    }
  })

  it("check on every reconnect, and pass on where the stream resumes, with no session", async () => {
    const { env, api, assistant: helper } = setup()
    const reconnect = new Request(`${APP}/assistant/conversations/c_1/turns/t_1/events`, {
      headers: { cookie: COOKIE, "last-event-id": "7" },
    })
    expect((await call(reconnect, env)).status).toBe(200)
    expect(api).toHaveBeenCalledTimes(2)
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

describe("stopping a turn through this app", () => {
  const stop = (headers: Record<string, string> = {}, method = "POST") =>
    new Request(`${APP}/assistant/conversations/c_1/turns/t_1/stop`, {
      method,
      headers: { cookie: COOKIE, origin: APP, ...headers },
    })

  it("checks the person like any call, then asks the assistant with a fresh binding and no session", async () => {
    const { env, api, assistant: helper } = setup()
    expect((await call(stop(), env)).status).toBe(200)
    expect(api).toHaveBeenCalledTimes(2)
    const forwarded = helper.mock.calls[0]![0]
    expect(forwarded.method).toBe("POST")
    expect(new URL(forwarded.url).pathname).toBe("/internal/v1/conversations/c_1/turns/t_1/stop")
    expect(forwarded.headers.get("authorization")).toBe(`Bearer ${TOKEN}`)
    expect(claimsOf(forwarded.headers.get("x-assistant-binding"))).toMatchObject({
      conv: "c_1",
      person: "user_riya",
      tenant: "org_sample",
      company: null,
    })
    // Stopping reads nothing, so the person's session is not lent for it.
    expect(forwarded.headers.get("x-assistant-session")).toBeNull()
  })

  it("checks the company too for a company's conversation, and binds the stop to it", async () => {
    const { env, api, assistant: helper } = setup()
    const company = new Request(
      `${APP}/assistant/companies/cmp_kestrel/conversations/c_2/turns/t_1/stop`,
      { method: "POST", headers: { cookie: COOKIE, origin: APP } },
    )
    expect((await call(company, env)).status).toBe(200)
    expect(api.mock.calls.map(([r]) => new URL(r.url).pathname)).toEqual([
      "/v1/me",
      "/v1/assistant/conversations/c_2/check",
    ])
    const forwarded = helper.mock.calls[0]![0]
    expect(new URL(forwarded.url).pathname).toBe("/internal/v1/conversations/c_2/turns/t_1/stop")
    expect(claimsOf(forwarded.headers.get("x-assistant-binding"))).toMatchObject({
      conv: "c_2",
      company: "cmp_kestrel",
    })

    // A company the conversation is not bound to: the API's refusal, and the assistant never hears of it.
    const { env: other, assistant: unseen } = setup()
    const elsewhere = new Request(
      `${APP}/assistant/companies/cmp_other/conversations/c_2/turns/t_1/stop`,
      { method: "POST", headers: { cookie: COOKIE, origin: APP } },
    )
    expect((await call(elsewhere, other)).status).toBe(404)
    expect(unseen).not.toHaveBeenCalled()
  })

  it("refuses with 502 when the API times out, fails or redirects, and never reaches the assistant", async () => {
    for (const answer of [
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError")
      },
      () => Response.json({ error: "internal" }, { status: 500 }),
      () => Response.json({ error: "unavailable" }, { status: 503 }),
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }),
    ]) {
      const { env, assistant: helper } = setup(apiBinding(answer))
      const response = await call(stop(), env)
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: "bad_gateway" })
      expect(helper).not.toHaveBeenCalled()
    }
  })

  it("passes on who-are-you refusals with only their status, type and body", async () => {
    for (const status of [401, 403]) {
      const { env, assistant: helper } = setup(
        apiBinding(() =>
          Response.json(
            { error: "refused" },
            { status, headers: { "set-cookie": "planted=1", "x-other": "1" } },
          ),
        ),
      )
      const response = await call(stop(), env)
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: "refused" })
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(response.headers.get("x-other")).toBeNull()
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(helper).not.toHaveBeenCalled()
    }
  })

  it("is refused from another site, by GET, or signed out, before the assistant hears of it", async () => {
    const { env, assistant: helper } = setup()
    expect((await call(stop({ origin: "https://evil.example" }), env)).status).toBe(403)
    expect((await call(stop({}, "GET"), env)).status).toBe(405)
    const signedOut = new Request(`${APP}/assistant/conversations/c_1/turns/t_1/stop`, {
      method: "POST",
      headers: { origin: APP },
    })
    expect((await call(signedOut, env)).status).toBe(401)
    expect(helper).not.toHaveBeenCalled()
  })
})

describe("the API's check on every call", () => {
  const get = (path: string, cookie = COOKIE) =>
    new Request(`${APP}${path}`, { headers: { cookie, "last-event-id": "3" } })
  const post = (path: string, body: unknown, cookie = COOKIE) =>
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: { cookie, origin: APP, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  /** Each relay route, for the conversation at `base` (e.g. `/assistant/conversations/c_1`). */
  const routes = (base: string, cookie = COOKIE) => ({
    turn: () => post(`${base}/turns`, { text: "hello" }, cookie),
    view: () => get(base, cookie),
    events: () => get(`${base}/turns/t_1/events`, cookie),
    stop: () => post(`${base}/turns/t_1/stop`, {}, cookie),
    answer: () => post(`${base}/proposals/p_1`, { outcome: "dismissed" }, cookie),
  })

  it("lets every route through for the person who holds the conversation, bound as asked", async () => {
    for (const [name, request] of Object.entries({
      ...routes("/assistant/conversations/c_1"),
    })) {
      const { env, api, assistant: helper } = setup()
      expect((await call(request(), env)).status, name).toBe(200)
      expect(
        api.mock.calls.some(([r]) => r.url.endsWith("/c_1/check")),
        name,
      ).toBe(true)
      expect(helper, name).toHaveBeenCalledTimes(1)
    }
  })

  it("refuses another person's conversation on every route, as if it were not there", async () => {
    for (const [name, request] of Object.entries(routes("/assistant/conversations/c_omar"))) {
      const { env, assistant: helper } = setup()
      const response = await call(request(), env)
      expect(response.status, name).toBe(404)
      expect(await response.json(), name).toEqual({ error: "unknown_conversation" })
      expect(helper, name).not.toHaveBeenCalled()
    }
    // The holder signed in as someone else: the same.
    for (const [name, request] of Object.entries(
      routes("/assistant/conversations/c_1", OTHER_COOKIE),
    )) {
      const { env, assistant: helper } = setup()
      expect((await call(request(), env)).status, name).toBe(404)
      expect(helper, name).not.toHaveBeenCalled()
    }
  })

  it("refuses the conversation in a company it is not bound to, or as home when it is bound, on every route", async () => {
    for (const base of [
      "/assistant/companies/cmp_other/conversations/c_2",
      "/assistant/conversations/c_2",
      "/assistant/companies/cmp_kestrel/conversations/c_1",
    ])
      for (const [name, request] of Object.entries(routes(base))) {
        const { env, assistant: helper } = setup()
        const response = await call(request(), env)
        expect(response.status, `${base} ${name}`).toBe(404)
        expect(await response.json()).toEqual({ error: "unknown_conversation" })
        expect(helper, `${base} ${name}`).not.toHaveBeenCalled()
      }
  })

  it("answers a view or a reconnect of someone else's conversation exactly as one that does not exist", async () => {
    const answer = async (request: Request) => {
      const response = await call(request, setup().env)
      return { status: response.status, body: await response.text() }
    }
    for (const route of ["view", "events"] as const) {
      const missing = await answer(routes("/assistant/conversations/c_missing")[route]())
      expect(await answer(routes("/assistant/conversations/c_omar")[route]())).toEqual(missing)
      expect(
        await answer(routes("/assistant/companies/cmp_other/conversations/c_2")[route]()),
      ).toEqual(missing)
    }
  })

  it("refuses with 502 on every route when the check times out, fails, or answers anything but 204 or 404", async () => {
    for (const onCheck of [
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError")
      },
      () => {
        throw new TypeError("network")
      },
      () => Response.json({ error: "internal" }, { status: 500 }),
      () => Response.json({ error: "unavailable" }, { status: 503 }),
      // Not the route's answer: a body where none belongs is not a yes.
      () => Response.json({ ok: true }),
      () => Response.json({ error: "forbidden" }, { status: 403 }),
    ])
      for (const [name, request] of Object.entries(routes("/assistant/conversations/c_1"))) {
        const { env, assistant: helper } = setup(apiBinding(undefined, onCheck))
        const response = await call(request(), env)
        expect(response.status, name).toBe(502)
        expect(helper, name).not.toHaveBeenCalled()
      }
  })

  it("gives up on the check after a while, with the request's own deadline", async () => {
    const { env, api } = setup()
    await call(routes("/assistant/conversations/c_1").view(), env)
    for (const [asked] of api.mock.calls) {
      expect(asked.signal.aborted).toBe(false)
      expect(asked.redirect).toBe("manual")
      // Never answered from a cache: who the person is and what they may use is asked fresh.
      expect(asked.cache).toBe("no-store")
    }
    expect(api).toHaveBeenCalledTimes(2)
  })
})

describe("a new conversation through this app", () => {
  const start = (path = "/assistant/conversations", headers: Record<string, string> = {}) =>
    new Request(`${APP}${path}`, {
      method: "POST",
      headers: { cookie: COOKIE, origin: APP, "content-type": "application/json", ...headers },
      // The browser's body is never read: it cannot choose the binding.
      body: JSON.stringify({ company: "cmp_other", person: "user_omar" }),
    })

  it("is made by the API as the person, home or in the company of the path, and answers its id", async () => {
    for (const [path, company] of [
      ["/assistant/conversations", null],
      ["/assistant/companies/cmp_kestrel/conversations", "cmp_kestrel"],
    ] as const) {
      const { env, api, assistant: helper } = setup()
      const response = await call(start(path), env)
      expect(response.status, path).toBe(201)
      expect(await response.json()).toEqual({ id: "cnv_new" })
      const made = api.mock.calls[0]![0]
      expect(made.method).toBe("POST")
      expect(new URL(made.url).pathname).toBe("/v1/assistant/conversations")
      expect(made.headers.get("cookie")).toBe(COOKIE)
      expect(made.headers.get("x-oryxa-request")).toBe("1")
      expect(made.headers.get("origin")).toBe(APP)
      expect(await made.json()).toEqual(company === null ? {} : { company })
      expect(api).toHaveBeenCalledTimes(1)
      // Nothing is asked of the assistant until the first turn.
      expect(helper).not.toHaveBeenCalled()
    }
  })

  it("passes on the API's refusal, and refuses what it cannot trust with 502", async () => {
    const { env } = setup()
    expect((await call(start("/assistant/companies/cmp_other/conversations"), env)).status).toBe(
      403,
    )
    expect((await call(start(undefined, { cookie: "theme=dark" }), env)).status).toBe(401)
    // A refusal comes back with its status, type and body alone.
    const refused = await call(
      start(),
      setup(
        apiBinding(() =>
          Response.json(
            { error: "forbidden" },
            { status: 403, headers: { "set-cookie": "planted=1" } },
          ),
        ),
      ).env,
    )
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: "forbidden" })
    expect(refused.headers.get("set-cookie")).toBeNull()
    expect(refused.headers.get("cache-control")).toBe("no-store")
    for (const answer of [
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError")
      },
      () => Response.json({ error: "internal" }, { status: 500 }),
      () => Response.json({ id: "cnv:bad", company: null }, { status: 201 }),
      // Bound elsewhere than asked: never handed to the browser.
      () => Response.json({ id: "cnv_new", company: "cmp_other" }, { status: 201 }),
      () => new Response("not json", { status: 201 }),
    ]) {
      const response = await call(start(), setup(apiBinding(answer)).env)
      expect(response.status).toBe(502)
    }
  })

  it("is refused from another site or by GET before the API hears of it", async () => {
    const { env, api } = setup()
    expect((await call(start(undefined, { origin: "https://evil.example" }), env)).status).toBe(403)
    const read = new Request(`${APP}/assistant/conversations`, { headers: { cookie: COOKIE } })
    expect((await call(read, env)).status).toBe(405)
    expect(api).not.toHaveBeenCalled()
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
