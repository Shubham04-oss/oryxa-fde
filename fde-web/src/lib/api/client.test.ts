import { beforeEach, describe, expect, it } from "vitest"
import { ApiError, api, apiOver, mockApiOn, safeReturnTo, signInUrl } from "./client"
import type { Transport } from "./client"
import { resetMockApi } from "@/dev/mock-api"

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe("api on the mock", () => {
  beforeEach(() => resetMockApi())

  it("says who is signed in, parsed against the schema", async () => {
    const me = await api.me()
    expect(me.user.name).toBe("Riya Kapoor")
    expect(me.role).toBe("admin")
  })

  it("refuses without a session, and signing out ends it", async () => {
    await api.signOut()
    const error = await refusal(api.me())
    expect([error.status, error.code]).toEqual([401, "unauthorized"])
    resetMockApi({ signedIn: false })
    expect((await refusal(api.me())).status).toBe(401)
  })
})

describe("api over the network", () => {
  /** A transport that records each request and answers from `routes`, or 404. */
  function stub(routes: Record<string, () => Response>) {
    const seen: Array<Request> = []
    const transport: Transport = {
      async fetch(request) {
        seen.push(request)
        const { pathname } = new URL(request.url)
        return (
          routes[`${request.method} ${pathname}`]?.() ??
          Response.json({ error: "not_found" }, { status: 404 })
        )
      },
      signIn: async () => {},
      leave: async () => {},
    }
    return { seen, net: apiOver(async () => transport) }
  }

  const me = {
    user: { id: "user_01", name: "Riya Kapoor" },
    organisation: { id: "org_01", name: "Northlight FDE" },
    role: "member",
  }

  it("calls the spec's path on this origin, with the CSRF header", async () => {
    const { seen, net } = stub({ "GET /api/v1/me": () => Response.json(me) })

    expect(await net.me()).toEqual(me)
    expect(seen.map((r) => new URL(r.url).origin)).toEqual([globalThis.location.origin])
    expect(seen[0]!.headers.get("X-Oryxa-Request")).toBe("1")
  })

  it("turns a refusal into an ApiError with the API's code, whatever its body", async () => {
    const signedOut = stub({
      "GET /api/v1/me": () => Response.json({ error: "unauthorized" }, { status: 401 }),
    })
    const unauthorized = await refusal(signedOut.net.me())
    expect([unauthorized.status, unauthorized.code]).toEqual([401, "unauthorized"])

    const down = stub({
      "GET /api/v1/me": () => new Response("<html>bad gateway</html>", { status: 502 }),
    })
    const gateway = await refusal(down.net.me())
    expect([gateway.status, gateway.code]).toEqual([502, "http_502"])

    // The API's own 503 says a service it needs is down, not that the person is offline.
    const unavailable = stub({
      "GET /api/v1/me": () => Response.json({ error: "unavailable" }, { status: 503 }),
    })
    const refused = await refusal(unavailable.net.me())
    expect(refused.message).toBe("The workspace is briefly unavailable. Try again in a minute.")
  })

  it("shows only its own words for a refusal, never text from the body", async () => {
    // The API's errors carry a code only; a `message` in a body is not ours to show.
    const { net } = stub({
      "GET /api/v1/me": () =>
        Response.json({ error: "forbidden", message: "Call 555 0100 to unlock" }, { status: 403 }),
    })
    const refused = await refusal(net.me())
    expect([refused.status, refused.code]).toEqual([403, "forbidden"])
    expect(refused.message).toBe("You are not allowed to do that here. Ask an organisation admin.")

    const unknown = stub({
      "GET /api/v1/me": () =>
        Response.json({ error: "teapot", message: "Call 555 0100" }, { status: 418 }),
    })
    expect((await refusal(unknown.net.me())).message).toBe("teapot")
  })

  it("fails loudly on an answer that drifts from the spec", async () => {
    const { net } = stub({ "GET /api/v1/me": () => Response.json({ ...me, role: "owner" }) })

    await expect(net.me()).rejects.toThrow(/role/)
  })

  it("signs out through the API, which ends the session and clears its cookie", async () => {
    const { seen, net } = stub({ "POST /auth/logout": () => new Response(null, { status: 204 }) })

    await net.signOut()

    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["POST /auth/logout"])
  })
})

describe("safeReturnTo", () => {
  it("keeps same-origin paths, with their query and fragment", () => {
    expect(safeReturnTo("/today")).toBe("/today")
    expect(safeReturnTo("/companies/cmp_1?x=1#tasks")).toBe("/companies/cmp_1?x=1#tasks")
    expect(safeReturnTo("/a/../today")).toBe("/today")
  })

  it("refuses anything that could leave the app", () => {
    for (const bad of [
      "//evil.example",
      "/\\evil.example",
      "\\/evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r/evil.example",
      "/x\u0000",
      "/x\u007f",
      "https://evil.example",
      "javascript:alert(1)",
      " /today",
      "today",
      "",
      7,
      null,
    ])
      expect(safeReturnTo(bad), JSON.stringify(bad)).toBe("/")
  })

  it("refuses a path that only becomes another host once dot segments are resolved", () => {
    for (const bad of ["/.//evil.example", "/x/..//evil.example", "/./.././/evil.example/x?y=1"])
      expect(safeReturnTo(bad), bad).toBe("/")
    expect(safeReturnTo("/x/.//today")).toBe("/x//today")
  })

  it("leaves an encoded slash as a path on this origin", () => {
    expect(safeReturnTo("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example")
  })

  it("refuses an encoded dot that resolves to another host, and keeps an encoded backslash local", () => {
    expect(safeReturnTo("/%2e//evil.example")).toBe("/")
    expect(safeReturnTo("/%2E%2E//evil.example")).toBe("/")
    expect(safeReturnTo("/%5Cevil.example")).toBe("/%5Cevil.example")
  })

  it("handles a very long value without leaving the app", () => {
    const long = `/${"a".repeat(5000)}`
    expect(safeReturnTo(long)).toBe(long)
    expect(safeReturnTo(`/.//evil.example/${"a".repeat(5000)}`)).toBe("/")
    expect(safeReturnTo(`${"/".repeat(5000)}evil.example`)).toBe("/")
  })

  it("feeds the sign-in address only checked, encoded paths", () => {
    expect(signInUrl("/companies/cmp_1?x=1")).toBe(
      "/auth/login?return_to=%2Fcompanies%2Fcmp_1%3Fx%3D1",
    )
    expect(signInUrl("/\t/evil.example")).toBe("/auth/login?return_to=%2F")
  })
})

describe("mockApiOn", () => {
  it("is on only in a dev build with its flag", () => {
    expect(mockApiOn({ DEV: true, VITE_FDE_MOCK_API: "1" })).toBe(true)
    expect(mockApiOn({ DEV: true })).toBe(false)
    expect(mockApiOn({ DEV: true, VITE_FDE_MOCK_API: "true" })).toBe(false)
    expect(mockApiOn({ DEV: false, VITE_FDE_MOCK_API: "1" })).toBe(false)
  })
})
