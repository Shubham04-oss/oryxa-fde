import { describe, expect, it } from "vitest"
import type { Transport } from "./client"
import { SIGN_IN_TEXT, SignInError, ownSignInOn, signInOver } from "./sign-in-api"

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

describe("the assumed sign-in contract", () => {
  it("is off unless the build turns it on", () => {
    expect(ownSignInOn({})).toBe(false)
    expect(ownSignInOn({ VITE_FDE_OWN_SIGN_IN: "0" })).toBe(false)
    expect(ownSignInOn({ VITE_FDE_OWN_SIGN_IN: "true" })).toBe(false)
    expect(ownSignInOn({ VITE_FDE_OWN_SIGN_IN: "1" })).toBe(true)
  })

  it("posts the password in a JSON body to this origin, never in the address", async () => {
    const { seen, api } = over(ok({ next: "signed_in" }))

    expect(await api.withPassword("riya@example.com", PASSWORD)).toEqual({ next: "signed_in" })

    const { request, body } = seen[0]!
    expect(request.method).toBe("POST")
    expect(request.url).toBe(`${location.origin}/auth/password`)
    expect(request.url).not.toContain(encodeURIComponent(PASSWORD))
    expect(request.headers.get("X-Oryxa-Request")).toBe("1")
    expect(request.headers.get("Content-Type")).toBe("application/json")
    expect(JSON.parse(body)).toEqual({ email: "riya@example.com", password: PASSWORD })
  })

  it("sends each call to its route with only its own fields", async () => {
    const { seen, api } = over((r) =>
      r.url.endsWith("/lookup")
        ? Response.json({ email: "a@example.com" })
        : r.url.endsWith("/reset") || r.url.endsWith("/forgot") || r.url.endsWith("/code")
          ? new Response(null, { status: r.url.endsWith("/reset") ? 204 : 202 })
          : r.url.endsWith("/resend")
            ? new Response(null, { status: 202 })
            : Response.json({ next: "signed_in" }),
    )
    await api.requestCode("a@example.com")
    await api.withCode("a@example.com", "123456")
    await api.invite("tok")
    await api.acceptInvite("tok", "Asha Rao", PASSWORD)
    await api.verifyEmail("123456")
    await api.resendVerification()
    await api.chooseOrganisation("org_1")
    await api.forgotPassword("a@example.com")
    await api.resetPassword("tok", PASSWORD)

    expect(
      seen.map(({ request, body }) => [new URL(request.url).pathname, JSON.parse(body)]),
    ).toEqual([
      ["/auth/code", { email: "a@example.com" }],
      ["/auth/code/verify", { email: "a@example.com", code: "123456" }],
      ["/auth/invite/lookup", { token: "tok" }],
      ["/auth/invite", { token: "tok", name: "Asha Rao", password: PASSWORD }],
      ["/auth/verify-email", { code: "123456" }],
      ["/auth/verify-email/resend", {}],
      ["/auth/organisation", { organisation: "org_1" }],
      ["/auth/password/forgot", { email: "a@example.com" }],
      ["/auth/password/reset", { token: "tok", password: PASSWORD }],
    ])
    // Tokens go in the body only.
    for (const { request } of seen) expect(request.url).not.toContain("tok")
  })

  it("reads the pending step, and only the organisations the API lists", async () => {
    const organisations = [{ id: "org_1", name: "Harbor Labs" }]
    const { seen, api } = over(ok({ step: "choose_organisation", organisations }))

    expect(await api.pending()).toEqual({ step: "choose_organisation", organisations })
    expect(seen[0]!.request.method).toBe("GET")
    expect(new URL(seen[0]!.request.url).pathname).toBe("/auth/pending")
  })

  it("refuses an organisation id that is not a plain id", async () => {
    const { api } = over(
      ok({ step: "choose_organisation", organisations: [{ id: "../x", name: "X" }] }),
    )
    await expect(api.pending()).rejects.toMatchObject({ code: "failed" })
  })

  it("reads a sign-in it cannot finish, and an unknown reason as other", async () => {
    const mfa = over(ok({ next: "cannot_finish", reason: "mfa_required" }))
    expect(await mfa.api.withPassword("a@example.com", PASSWORD)).toEqual({
      next: "cannot_finish",
      reason: "mfa_required",
    })
    const radar = over(ok({ next: "cannot_finish", reason: "radar_challenge" }))
    expect(await radar.api.withPassword("a@example.com", PASSWORD)).toEqual({
      next: "cannot_finish",
      reason: "other",
    })
  })

  it("refuses an answer it does not understand", async () => {
    const { api } = over(ok({ next: "welcome" }))
    await expect(api.withPassword("a@example.com", PASSWORD)).rejects.toMatchObject({
      code: "failed",
    })
  })

  it("says refusals in its own words, never the answer's", async () => {
    const { api } = over(() =>
      Response.json(
        { error: "invalid_credentials", message: "No user with this email exists" },
        { status: 401 },
      ),
    )
    const failure = await api.withPassword("a@example.com", PASSWORD).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(SignInError)
    expect((failure as SignInError).message).toBe(SIGN_IN_TEXT.invalid_credentials)
    expect((failure as SignInError).message).not.toContain(PASSWORD)
  })

  it("reads a code it does not know as a failure, and a 5xx as unavailable", async () => {
    const odd = over(() => Response.json({ error: "user_not_found" }, { status: 404 }))
    await expect(odd.api.withPassword("a@example.com", PASSWORD)).rejects.toMatchObject({
      code: "failed",
    })
    const down = over(() => new Response("oops", { status: 502 }))
    await expect(down.api.withPassword("a@example.com", PASSWORD)).rejects.toMatchObject({
      code: "unavailable",
    })
  })

  it("passes on how long to wait after too many attempts", async () => {
    const { api } = over(() =>
      Response.json(
        { error: "too_many_attempts" },
        { status: 429, headers: { "Retry-After": "120" } },
      ),
    )
    await expect(api.withPassword("a@example.com", PASSWORD)).rejects.toMatchObject({
      code: "too_many_attempts",
      retryAfter: 120,
    })
  })

  it("never passes on the browser's own network error", async () => {
    const { api } = over(() => {
      throw new TypeError(`Failed to fetch with ${PASSWORD}`)
    })
    const failure = (await api
      .withPassword("a@example.com", PASSWORD)
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
