import { beforeEach, describe, expect, it } from "vitest"
import { resetMockApi } from "@/dev/mock-api"
import { LIMITS, SAMPLE_CODE, SAMPLE_PASSWORD, signInRoutes } from "@/dev/mock-sign-in"

// The dev mock answers the sign-in routes exactly as the API does (crates/oryxa-fde-api/src/signin.rs
// and its tests), so the screens' tests prove the contract: the same status, the same body, byte for
// byte, and `Retry-After` on a limit.

let session = false
const setSession = (on: boolean) => void (session = on)

type Answer = { status: number; body: string; retryAfter: string | null }

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = { "X-Oryxa-Request": "1" },
): Promise<Answer> {
  const request = new Request(`${location.origin}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  const response = await signInRoutes(new URL(request.url).pathname, "POST", request, setSession)
  if (!response) throw new Error(`no answer for ${path}`)
  return {
    status: response.status,
    body: await response.text(),
    retryAfter: response.headers.get("Retry-After"),
  }
}

const password = (email: string, secret = SAMPLE_PASSWORD, extra: object = {}) =>
  post("/auth/sign-in/password", { email, password: secret, ...extra })
const verify = (code: string) => post("/auth/sign-in/verify-email", { code })
const choose = (organisation: string) => post("/auth/sign-in/organisation", { organisation })
const refusal = (status: number, error: string) => ({
  status,
  body: JSON.stringify({ error }),
})

beforeEach(() => {
  resetMockApi({ signedIn: false })
  session = false
})

describe("the mock's sign-in routes", () => {
  it("signs in with a password, back to the return_to it was given", async () => {
    expect(
      await password("riya@example.com", SAMPLE_PASSWORD, { return_to: "/companies" }),
    ).toEqual({ status: 200, body: '{"next":"done","return_to":"/companies"}', retryAfter: null })
    expect(session).toBe(true)
    expect((await password("riya@example.com", SAMPLE_PASSWORD, { return_to: null })).body).toBe(
      '{"next":"done","return_to":"/"}',
    )
  })

  it("refuses a request without X-Oryxa-Request on every route, before anything else", async () => {
    for (const path of ["password", "verify-email", "organisation"])
      expect(await post(`/auth/sign-in/${path}`, "not json", {})).toMatchObject(
        refusal(403, "csrf"),
      )
  })

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["an unknown field", { email: "a@example.com", password: "x", remember: true }],
    ["a missing password", { email: "a@example.com" }],
    ["a password that is not a string", { email: "a@example.com", password: 7 }],
  ])("refuses %s as invalid_body, echoing nothing", async (_, body) => {
    expect(await post("/auth/sign-in/password", body)).toMatchObject(refusal(400, "invalid_body"))
  })

  it.each([
    ["invalid_email", { email: "riya@example..com", password: "x" }],
    ["invalid_email", { email: "no-at-sign", password: "x" }],
    ["invalid_password", { email: "a@example.com", password: "" }],
    ["invalid_password", { email: "a@example.com", password: "é".repeat(513) }],
    ["invalid_return_to", { email: "a@example.com", password: "x", return_to: "//evil.example" }],
    ["invalid_return_to", { email: "a@example.com", password: "x", return_to: "/a b" }],
    [
      "invalid_return_to",
      { email: "a@example.com", password: "x", return_to: "https://x.example" },
    ],
  ])("refuses a bad field as %s", async (code, body) => {
    expect(await post("/auth/sign-in/password", body)).toMatchObject(refusal(400, code))
  })

  it("answers a wrong password and an unknown address alike", async () => {
    const wrong = await password("riya@example.com", "not-it")
    const unknown = await password("nobody@example.com", SAMPLE_PASSWORD)
    expect(wrong).toEqual({ ...refusal(401, "invalid_credentials"), retryAfter: null })
    expect(unknown).toEqual(wrong)
  })

  it("limits every attempt at an address, known or not, with the seconds to wait", async () => {
    for (let i = 0; i < LIMITS.address; i++)
      expect((await password("Nobody@example.com", "x")).status).toBe(401)
    const limited = await password("nobody@example.com", "x")
    expect(limited).toMatchObject(refusal(429, "too_many_attempts"))
    expect(Number(limited.retryAfter)).toBeGreaterThan(0)
    expect(Number(limited.retryAfter)).toBeLessThanOrEqual(LIMITS.windowSeconds)
    // Another address is its own bucket.
    expect((await password("riya@example.com")).status).toBe(200)
  })

  it("asks to verify the email, then takes the code and keeps the step open after a wrong one", async () => {
    expect(
      await password("unverified@example.com", SAMPLE_PASSWORD, { return_to: "/x" }),
    ).toMatchObject({
      status: 200,
      body: '{"next":"verify_email"}',
    })
    expect(await verify("not a code!")).toMatchObject(refusal(400, "invalid_code"))
    expect(await verify("x".repeat(17))).toMatchObject(refusal(400, "invalid_code"))
    expect(await verify("654321")).toMatchObject(refusal(401, "invalid_code"))
    expect(await verify(` ${SAMPLE_CODE} `)).toMatchObject({
      status: 200,
      body: '{"next":"done","return_to":"/x"}',
    })
    expect(session).toBe(true)
    // The step is over.
    expect(await verify(SAMPLE_CODE)).toMatchObject(refusal(400, "invalid_sign_in"))
  })

  it("offers the organisations in the answer, and takes only one of them", async () => {
    expect(await password("two-orgs@example.com")).toMatchObject({
      status: 200,
      body: '{"next":"choose_organisation","organisations":[{"id":"org_sample_northwind","name":"Northwind Field Engineering"},{"id":"org_sample_harbor","name":"Harbor Labs"}]}',
    })
    expect(await post("/auth/sign-in/organisation", { organisation: 7 })).toMatchObject(
      refusal(400, "invalid_body"),
    )
    expect(await choose("org_other")).toMatchObject(refusal(400, "invalid_organisation"))
    // A choice not offered leaves the step open.
    expect(await choose("org_sample_harbor")).toMatchObject({
      status: 200,
      body: '{"next":"done","return_to":"/"}',
    })
    expect(await choose("org_sample_harbor")).toMatchObject(refusal(400, "invalid_sign_in"))
  })

  it("refuses a step with nothing pending, or at the other step, as invalid_sign_in", async () => {
    expect(await verify(SAMPLE_CODE)).toMatchObject(refusal(400, "invalid_sign_in"))
    expect(await choose("org_sample_harbor")).toMatchObject(refusal(400, "invalid_sign_in"))
    await password("unverified@example.com")
    expect(await choose("org_sample_harbor")).toMatchObject(refusal(400, "invalid_sign_in"))
    // ...which also ended the verification.
    expect(await verify(SAMPLE_CODE)).toMatchObject(refusal(400, "invalid_sign_in"))
  })

  it("ends a pending step on a refused password", async () => {
    await password("unverified@example.com")
    await password("riya@example.com", "not-it")
    expect(await verify(SAMPLE_CODE)).toMatchObject(refusal(400, "invalid_sign_in"))
  })

  it("ends with no organisation or an unsupported step as a 403, with no session", async () => {
    expect(await password("no-org@example.com")).toMatchObject(refusal(403, "no_organisation"))
    expect(await password("mfa@example.com")).toMatchObject(refusal(403, "sign_in_unsupported"))
    expect(session).toBe(false)
  })
})
