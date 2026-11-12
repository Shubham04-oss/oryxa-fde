import { describe, expect, expectTypeOf, it } from "vitest"
import type { z } from "zod"
import type { Transport } from "./client"
import type { components } from "./fde-api.gen"
import { SIGN_IN_TEXT, SignInError, ownSignInOn, signInOver } from "./sign-in-api"
import type { Next } from "./sign-in-api"

type Spec = components["schemas"]

const PASSWORD = "a password 9c1f"

/** A transport that records each request and answers with `answer`. */
function over(answer: (request: Request) => Response | Promise<Response>) {
  const seen: Array<{ request: Request; body: string }> = []
  const left: Array<string> = []
  const transport: Transport = {
    async fetch(request) {
      seen.push({ request, body: await request.clone().text() })
      return answer(request)
    },
    upload: () => Promise.reject(new Error("no uploads")),
    signIn: async () => {},
    leave: async (url) => void left.push(url),
  }
  return { seen, left, api: signInOver(async () => transport) }
}

const ok = (body: unknown) => () => Response.json(body)
const refused = (status: number, error: string, headers?: HeadersInit) => () =>
  Response.json({ error }, { status, headers })
const DONE = { next: "done", return_to: "/today" }

describe("the sign-in contract", () => {
  it("is off unless the build turns it on", () => {
    expect(ownSignInOn({})).toBe(false)
    expect(ownSignInOn({ VITE_FDE_OWN_SIGN_IN: "0" })).toBe(false)
    expect(ownSignInOn({ VITE_FDE_OWN_SIGN_IN: "true" })).toBe(false)
    expect(ownSignInOn({ VITE_FDE_OWN_SIGN_IN: "1" })).toBe(true)
  })

  // Checked by `pnpm typecheck`: when the API's answer changes, `pnpm api:generate` changes this.
  it("reads exactly the answer the OpenAPI spec says a step is", () => {
    expectTypeOf<z.input<typeof Next>>().toEqualTypeOf<Spec["SignInStep"]>()
  })

  it("posts the password in a JSON body to the API's route, never in the address", async () => {
    const { seen, api } = over(ok(DONE))

    expect(await api.withPassword("riya@example.com", PASSWORD, "/today")).toEqual(DONE)

    const { request, body } = seen[0]!
    expect(request.method).toBe("POST")
    expect(request.url).toBe(`${location.origin}/auth/sign-in/password`)
    expect(request.url).not.toContain(encodeURIComponent(PASSWORD))
    expect(request.headers.get("X-Oryxa-Request")).toBe("1")
    expect(request.headers.get("Content-Type")).toBe("application/json")
    expect(request.credentials).toBe("same-origin")
    expect(JSON.parse(body)).toEqual({
      email: "riya@example.com",
      password: PASSWORD,
      return_to: "/today",
    })
  })

  it("sends only a local return_to the API takes, or home", async () => {
    const { seen, api } = over(ok(DONE))
    await api.withPassword("a@example.com", PASSWORD, "//evil.example/x")
    await api.withPassword("a@example.com", PASSWORD, `/${"x".repeat(2048)}`)
    await api.withPassword("a@example.com", PASSWORD, "/today?tab=1")
    expect(seen.map(({ body }) => (JSON.parse(body) as { return_to: string }).return_to)).toEqual([
      "/",
      "/",
      "/today?tab=1",
    ])
  })

  it("sends each step to its route with only its own fields", async () => {
    const { seen, api } = over(ok(DONE))
    await api.verifyEmail("123456")
    await api.chooseOrganisation("org_1")

    expect(
      seen.map(({ request, body }) => [new URL(request.url).pathname, JSON.parse(body)]),
    ).toEqual([
      ["/auth/sign-in/verify-email", { code: "123456" }],
      ["/auth/sign-in/organisation", { organisation: "org_1" }],
    ])
    for (const { request } of seen) expect(request.headers.get("X-Oryxa-Request")).toBe("1")
  })

  it("keeps the routes still to come on their assumed paths, tokens in the body only", async () => {
    const { seen, api } = over((r) =>
      r.url.endsWith("/lookup")
        ? Response.json({ email: "a@example.com" })
        : r.url.endsWith("/reset")
          ? new Response(null, { status: 204 })
          : /\/(forgot|code|resend)$/.test(r.url)
            ? new Response(null, { status: 202 })
            : Response.json(DONE),
    )
    await api.requestCode("a@example.com")
    await api.withCode("a@example.com", "123456", "/today")
    await api.invite("tok")
    await api.acceptInvite("tok", "Asha Rao", PASSWORD, "/today")
    await api.resendVerification()
    await api.forgotPassword("a@example.com")
    await api.resetPassword("tok", PASSWORD)

    expect(
      seen.map(({ request, body }) => [new URL(request.url).pathname, JSON.parse(body)]),
    ).toEqual([
      ["/auth/code", { email: "a@example.com" }],
      ["/auth/code/verify", { email: "a@example.com", code: "123456", return_to: "/today" }],
      ["/auth/invite/lookup", { token: "tok" }],
      ["/auth/invite", { token: "tok", name: "Asha Rao", password: PASSWORD, return_to: "/today" }],
      ["/auth/verify-email/resend", {}],
      ["/auth/password/forgot", { email: "a@example.com" }],
      ["/auth/password/reset", { token: "tok", password: PASSWORD }],
    ])
    for (const { request } of seen) expect(request.url).not.toContain("tok")
  })

  it("reads each step the API can answer", async () => {
    const organisations = [{ id: "org_01A", name: "Harbor Labs" }]
    expect(await over(ok({ next: "verify_email" })).api.verifyEmail("1")).toEqual({
      next: "verify_email",
    })
    expect(
      await over(ok({ next: "choose_organisation", organisations })).api.withPassword(
        "a@example.com",
        PASSWORD,
        "/",
      ),
    ).toEqual({ next: "choose_organisation", organisations })
  })

  it.each([
    ["the old signed_in", { next: "signed_in" }],
    ["done with no return_to", { next: "done" }],
    ["an unknown step", { next: "welcome" }],
    ["no organisations to choose", { next: "choose_organisation", organisations: [] }],
    [
      "an organisation id that is not a plain id",
      { next: "choose_organisation", organisations: [{ id: "../x", name: "X" }] },
    ],
  ])("refuses an answer it does not understand: %s", async (_, body) => {
    const { api } = over(ok(body))
    await expect(api.withPassword("a@example.com", PASSWORD, "/")).rejects.toMatchObject({
      code: "failed",
    })
  })

  it.each([
    [400, "invalid_body"],
    [400, "invalid_email"],
    [400, "invalid_password"],
    [400, "invalid_return_to"],
    [400, "invalid_code"],
    [400, "invalid_organisation"],
    [400, "invalid_sign_in"],
    [401, "invalid_credentials"],
    [401, "invalid_code"],
    [403, "csrf"],
    [403, "no_organisation"],
    [403, "sign_in_unsupported"],
    [503, "unavailable"],
  ] as const)("gives %i %s its own words", async (status, code) => {
    const { api } = over(refused(status, code))
    const failure = (await api.verifyEmail("123456").catch((e: unknown) => e)) as SignInError
    expect(failure).toBeInstanceOf(SignInError)
    expect(failure.code).toBe(code)
    expect(failure.message).toBe(SIGN_IN_TEXT[code])
    expect(failure.message).not.toBe(SIGN_IN_TEXT.failed)
  })

  it("gives every code its own words", () => {
    const words = Object.values(SIGN_IN_TEXT)
    expect(new Set(words).size).toBe(words.length)
  })

  it("says refusals in its own words, never the answer's", async () => {
    const { api } = over(() =>
      Response.json(
        { error: "invalid_credentials", message: "No user with this email exists" },
        { status: 401 },
      ),
    )
    const failure = await api.withPassword("a@example.com", PASSWORD, "/").catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(SignInError)
    expect((failure as SignInError).message).toBe(SIGN_IN_TEXT.invalid_credentials)
    expect((failure as SignInError).message).not.toContain(PASSWORD)
  })

  it("reads a code it does not know as a failure, and a 5xx as unavailable", async () => {
    for (const odd of ["user_not_found", "__proto__", "toString"]) {
      const { api } = over(refused(404, odd))
      await expect(api.withPassword("a@example.com", PASSWORD, "/")).rejects.toMatchObject({
        code: "failed",
      })
    }
    const down = over(() => new Response("oops", { status: 502 }))
    await expect(down.api.withPassword("a@example.com", PASSWORD, "/")).rejects.toMatchObject({
      code: "unavailable",
    })
  })

  it("passes on how long to wait after too many attempts, in whole seconds only", async () => {
    const wait = async (header?: string) =>
      (
        (await over(
          refused(429, "too_many_attempts", header ? { "Retry-After": header } : undefined),
        )
          .api.withPassword("a@example.com", PASSWORD, "/")
          .catch((e: unknown) => e)) as SignInError
      ).retryAfter
    expect(await wait("120")).toBe(120)
    expect(await wait("7")).toBe(7)
    expect(await wait()).toBeUndefined()
    expect(await wait("0")).toBeUndefined()
    expect(await wait("Wed, 21 Oct 2026 07:28:00 GMT")).toBeUndefined()
    expect(await wait("1e3")).toBeUndefined()
  })

  it("never passes on the browser's own network error", async () => {
    const { api } = over(() => {
      throw new TypeError(`Failed to fetch with ${PASSWORD}`)
    })
    const failure = (await api
      .withPassword("a@example.com", PASSWORD, "/")
      .catch((e: unknown) => e)) as SignInError
    expect(failure.code).toBe("offline")
    expect(failure.message).not.toContain(PASSWORD)
  })

  it("leaves for Google through the API, only ever back to this app", async () => {
    const { left, api } = over(ok({}))
    await api.withGoogle("/today")
    await api.withGoogle("//evil.example/x")
    expect(left).toEqual(["/auth/google?return_to=%2Ftoday", "/auth/google?return_to=%2F"])
  })
})
