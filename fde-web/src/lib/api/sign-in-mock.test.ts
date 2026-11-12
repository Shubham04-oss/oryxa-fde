import { beforeEach, describe, expect, it } from "vitest"
import { resetMockApi } from "@/dev/mock-api"
import {
  LIMITS,
  LOCKED_ADDRESS,
  SAMPLE_CODE,
  SAMPLE_PASSWORD,
  SAMPLE_ORGANISATIONS,
  signInRoutes,
} from "@/dev/mock-sign-in"

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
const askCode = (email: string) => post("/auth/sign-in/code", { email })
const withCode = (email: string, code: string, extra: object = {}) =>
  post("/auth/sign-in/code/verify", { email, code, ...extra })
const resend = (body: unknown = "") => post("/auth/sign-in/verify-email/resend", body)
const CHOOSE = JSON.stringify({ next: "choose_organisation", organisations: SAMPLE_ORGANISATIONS })
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
    for (const path of [
      "password",
      "verify-email",
      "organisation",
      "code",
      "code/verify",
      "verify-email/resend",
    ])
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

  it("answers too_many_attempts for an address over its limit, whatever the password or code", async () => {
    for (const answer of [
      await password(LOCKED_ADDRESS, SAMPLE_PASSWORD),
      await password(LOCKED_ADDRESS, "not-it"),
      await password("Locked@Example.com", "not-it"),
      await askCode(LOCKED_ADDRESS),
      await withCode(LOCKED_ADDRESS, SAMPLE_CODE),
      await withCode(LOCKED_ADDRESS, "000000"),
    ]) {
      expect(answer).toMatchObject(refusal(429, "too_many_attempts"))
      expect(Number(answer.retryAfter)).toBeGreaterThan(0)
    }
    // The input is still checked first, as the API does.
    expect(await password(LOCKED_ADDRESS, "")).toMatchObject(refusal(400, "invalid_password"))
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

  it("can go on from a verified email to choosing an organisation, or to a step we cannot show", async () => {
    await password("unverified-two-orgs@example.com", SAMPLE_PASSWORD, { return_to: "/x" })
    expect(await verify(SAMPLE_CODE)).toMatchObject({ status: 200, body: CHOOSE })
    expect(await choose("org_sample_harbor")).toMatchObject({
      status: 200,
      body: '{"next":"done","return_to":"/x"}',
    })

    session = false
    await password("unverified-mfa@example.com")
    expect(await verify(SAMPLE_CODE)).toMatchObject(refusal(403, "sign_in_unsupported"))
    expect(session).toBe(false)
    // ...which ended the step.
    expect(await verify(SAMPLE_CODE)).toMatchObject(refusal(400, "invalid_sign_in"))
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

describe("the mock's code routes", () => {
  it("answers asking for a code alike whether or not the address has an account", async () => {
    const known = await askCode("riya@example.com")
    expect(known).toEqual({ status: 200, body: '{"next":"enter_code"}', retryAfter: null })
    expect(await askCode("nobody@example.com")).toEqual(known)
  })

  it.each([
    ["not JSON", "{", "invalid_body"],
    ["an unknown field", { email: "a@example.com", return_to: "/" }, "invalid_body"],
    ["an email that is not a string", { email: 7 }, "invalid_body"],
    ["a bad address", { email: "riya@example..com" }, "invalid_email"],
  ])("refuses asking for a code with %s", async (_, body, code) => {
    expect(await post("/auth/sign-in/code", body)).toMatchObject(refusal(400, code))
  })

  it("limits the codes emailed to an address, known or not, and to a client", async () => {
    for (let i = 0; i < LIMITS.sendAddress; i++)
      expect((await askCode("Nobody@example.com")).status).toBe(200)
    const limited = await askCode("nobody@example.com")
    expect(limited).toMatchObject(refusal(429, "too_many_attempts"))
    expect(Number(limited.retryAfter)).toBeLessThanOrEqual(LIMITS.sendWindowSeconds)
    expect(Number(limited.retryAfter)).toBeGreaterThan(LIMITS.windowSeconds)
    // The client's own limit, across addresses.
    for (let i = LIMITS.sendAddress + 1; i < LIMITS.sendClient; i++)
      expect((await askCode(`a${i}@example.com`)).status).toBe(200)
    expect(await askCode("fresh@example.com")).toMatchObject(refusal(429, "too_many_attempts"))
  })

  it("signs in with the code, back to the return_to it was given", async () => {
    expect(
      await withCode("Riya@example.com", ` ${SAMPLE_CODE} `, { return_to: "/companies" }),
    ).toEqual({
      status: 200,
      body: '{"next":"done","return_to":"/companies"}',
      retryAfter: null,
    })
    expect(session).toBe(true)
    expect((await withCode("riya@example.com", SAMPLE_CODE, { return_to: null })).body).toBe(
      '{"next":"done","return_to":"/"}',
    )
  })

  it("answers a wrong code and an address with no account alike", async () => {
    const wrong = await withCode("riya@example.com", "654321")
    const unknown = await withCode("nobody@example.com", SAMPLE_CODE)
    expect(wrong).toEqual({ ...refusal(401, "invalid_code"), retryAfter: null })
    expect(unknown).toEqual(wrong)
    expect(session).toBe(false)
  })

  it("answers each next step a code sign-in can lead to", async () => {
    expect(await withCode("two-orgs@example.com", SAMPLE_CODE)).toMatchObject({
      status: 200,
      body: CHOOSE,
    })
    expect(await choose("org_sample_northwind")).toMatchObject({ status: 200 })
    expect(await withCode("unverified@example.com", SAMPLE_CODE)).toMatchObject({
      status: 200,
      body: '{"next":"verify_email"}',
    })
    expect(await verify(SAMPLE_CODE)).toMatchObject({ status: 200 })
    expect(await withCode("no-org@example.com", SAMPLE_CODE)).toMatchObject(
      refusal(403, "no_organisation"),
    )
    expect(await withCode("mfa@example.com", SAMPLE_CODE)).toMatchObject(
      refusal(403, "sign_in_unsupported"),
    )
  })

  it("ends a pending step on a refused code", async () => {
    await password("unverified@example.com")
    await withCode("riya@example.com", "654321")
    expect(await verify(SAMPLE_CODE)).toMatchObject(refusal(400, "invalid_sign_in"))
  })

  it.each([
    ["a missing code", { email: "a@example.com" }, "invalid_body"],
    [
      "an unknown field",
      { email: "a@example.com", code: "123456", remember: true },
      "invalid_body",
    ],
    ["a bad address", { email: "bad", code: "123456" }, "invalid_email"],
    ["an empty code", { email: "a@example.com", code: "" }, "invalid_code"],
    ["a code with a space inside", { email: "a@example.com", code: "12 34" }, "invalid_code"],
    ["a code too long", { email: "a@example.com", code: "1".repeat(17) }, "invalid_code"],
    [
      "a return_to on another host",
      { email: "a@example.com", code: "123456", return_to: "//evil.example" },
      "invalid_return_to",
    ],
  ])("refuses a code sign-in with %s", async (_, body, code) => {
    expect(await post("/auth/sign-in/code/verify", body)).toMatchObject(refusal(400, code))
  })

  it("counts code guesses at an address with the email verification's", async () => {
    await password("unverified@example.com")
    for (let i = 0; i < LIMITS.address; i++) await verify("654321")
    expect(await withCode("unverified@example.com", SAMPLE_CODE)).toMatchObject(
      refusal(429, "too_many_attempts"),
    )
  })

  it("sends the verification code again only while the step waits, and keeps the step", async () => {
    expect(await resend()).toMatchObject(refusal(400, "invalid_sign_in"))
    await password("unverified@example.com", SAMPLE_PASSWORD, { return_to: "/x" })
    // The route reads no body.
    expect(await resend()).toEqual({
      status: 200,
      body: '{"next":"verify_email"}',
      retryAfter: null,
    })
    expect(await resend({ anything: true })).toMatchObject({ status: 200 })
    expect(await verify(SAMPLE_CODE)).toMatchObject({ body: '{"next":"done","return_to":"/x"}' })
  })

  it("counts a resend with the codes emailed to that address", async () => {
    await password("unverified@example.com")
    for (let i = 0; i < LIMITS.sendAddress - 1; i++) expect((await resend()).status).toBe(200)
    expect((await askCode("unverified@example.com")).status).toBe(200)
    expect(await resend()).toMatchObject(refusal(429, "too_many_attempts"))
    expect(await askCode("unverified@example.com")).toMatchObject(refusal(429, "too_many_attempts"))
  })
})
