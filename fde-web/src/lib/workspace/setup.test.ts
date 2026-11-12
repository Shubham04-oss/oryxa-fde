import { afterEach, describe, expect, expectTypeOf, it } from "vitest"
import { NO_ANSWERS, NO_CRITERION, defaultRules, proposePlan } from "./new-company"
import type { Answers } from "./new-company"
import { holdKey, prepare, releaseKey, settlesKey, setupBody, setupProblem } from "./setup"
import { ApiError, api } from "@/lib/api/client"
import type { SetupRequest } from "@/lib/api/client"
import type { components, paths } from "@/lib/api/fde-api.gen"

type Spec = components["schemas"]
type Route = paths["/v1/companies/setup"]["post"]

const company = {
  name: " Orion Rail ",
  project: " Claims intake ",
  industry: "Transport",
  region: "",
  summary: "Automate claims intake.",
}
const criterion = {
  ...NO_CRITERION,
  description: "Claims triaged within two hours",
  metric: "hours to triage",
  comparator: "at_most" as const,
  target: "2",
  unit: "h",
  baseline: "9.5",
  proof: "An eval on sample claims",
}
const start = { approach: "talk" as const, contact: "Dana Ortiz", criterion }
const all: Answers = {
  company,
  start,
  rules: defaultRules(),
  people: [{ email: "sam@example.com", role: "engineer" }],
  plan: proposePlan({ ...NO_ANSWERS, start }),
}

describe("the setup call's body", () => {
  it("is pinned to the generated types, as the client sends it", () => {
    expectTypeOf<NonNullable<ReturnType<typeof setupBody>>>().toEqualTypeOf<Spec["SetupBody"]>()
    expectTypeOf<SetupRequest["body"]>().toEqualTypeOf<
      Route["requestBody"]["content"]["application/json"]
    >()
    expectTypeOf<SetupRequest["key"]>().toEqualTypeOf<
      Route["parameters"]["header"]["Idempotency-Key"]
    >()
    expectTypeOf(api.setUpCompany).parameter(0).toEqualTypeOf<SetupRequest>()
  })

  it("maps every answer that has a field, and only those", () => {
    expect(setupBody(all)).toEqual({
      company: { name: "Orion Rail", industry: "Transport", region: null, summary: null },
      project: { name: "Claims intake", summary: "Automate claims intake." },
      stakeholders: [{ name: "Dana Ortiz" }],
      main_contact: 0,
      scope_items: [],
      criteria: [
        {
          description: "Claims triaged within two hours",
          metric: "hours to triage",
          comparator: "at_most",
          target: 2,
          unit: "h",
          baseline: 9.5,
          proof: "An eval on sample claims",
        },
      ],
      plan: [
        { title: "Discovery call", stage: "discover", criterion: null },
        { title: "Agree scope and success criteria", stage: "scope", criterion: 0 },
        { title: "Request access to the systems", stage: "access", criterion: null },
        { title: "Build", stage: "build", criterion: null },
        { title: "Evaluate", stage: "evaluate", criterion: 0 },
        { title: "Hand off", stage: "handoff", criterion: null },
      ],
    })
    // Rules, invitations and who a step is with have no field: none of them is sent anywhere.
    const sent = JSON.stringify(setupBody(all))
    for (const absent of ["sam@example.com", "allowed", "approver", '"with"', "Ask first"])
      expect(sent).not.toContain(absent)
  })

  it("sends no person, criterion or link that was not given", () => {
    const bare = { ...start, contact: "", criterion: NO_CRITERION }
    const body = setupBody({
      ...all,
      start: bare,
      plan: proposePlan({ ...NO_ANSWERS, start: bare }),
    })
    expect(body).toMatchObject({ stakeholders: [], main_contact: null, criteria: [] })
    expect(body?.plan?.every((s) => s.criterion === null)).toBe(true)
    // A blank baseline, unit or proof is none, never a zero or an empty string.
    const plain = { ...criterion, unit: "", baseline: "", proof: "" }
    expect(
      setupBody({ ...all, start: { ...start, criterion: plain } })?.criteria?.[0],
    ).toMatchObject({ unit: null, baseline: null, proof: null })
  })

  it("is not made until every required answer is there", () => {
    expect(setupBody(NO_ANSWERS)).toBeNull()
    expect(setupBody({ ...all, rules: null })).toBeNull()
    expect(setupBody({ ...all, plan: [] })).toBeNull()
    expect(setupBody({ ...all, company: { ...company, project: " " } })).toBeNull()
    // People are optional.
    expect(setupBody({ ...all, people: [] })).not.toBeNull()
  })
})

describe("the setup's key", () => {
  afterEach(releaseKey)

  it("is held from its first send until the API answers with a setup or a 409", () => {
    let n = 0
    const key = () => `setup-${++n}`
    const body = setupBody(all)!
    const first = prepare(body, key)
    expect(first).toEqual({ key: "setup-1", body, json: JSON.stringify(body) })
    // Not held yet: nothing was sent, so a new key is fine.
    expect(prepare(body, key).key).toBe("setup-2")
    holdKey(first.key)
    // Held: the same key, for the same body or a changed one, with that body's own bytes.
    const changed = setupBody({ ...all, company: { ...company, region: "UK" } })!
    expect(prepare(changed, key)).toEqual({
      key: "setup-1",
      body: changed,
      json: JSON.stringify(changed),
    })
    // Kept by the tab, so a new page in it (Back, then Forward) finds it.
    expect(sessionStorage.getItem("fde.setup.key")).toBe("setup-1")
    releaseKey()
    expect(prepare(body, key).key).toBe("setup-3")
  })

  it("is settled only by a 409: a 400, 401 or 403 says nothing about an earlier send", () => {
    expect(settlesKey(new ApiError(409, "rejected_idempotency_key_reused"))).toBe(true)
    expect(settlesKey(new ApiError(400, "invalid_idempotency_key"))).toBe(true)
    for (const [status, code] of [
      [400, "invalid_target"],
      [400, "invalid_body"],
      [401, "unauthorized"],
      [403, "forbidden"],
      [503, "unavailable"],
    ] as const)
      expect(settlesKey(new ApiError(status, code))).toBe(false)
    expect(settlesKey(new TypeError("Failed to fetch"))).toBe(false)
    expect(settlesKey(new DOMException("The operation was aborted.", "AbortError"))).toBe(false)
  })

  it("is one the API takes", () => {
    expect(prepare(setupBody(all)!).key).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
  })
})

describe("a refused setup", () => {
  const body = setupBody(all)!
  const refused = (status: number, code: string) => setupProblem(new ApiError(status, code), body)

  it("is shown beside the part that is wrong", () => {
    expect(refused(400, "invalid_target")).toMatchObject({ kind: "part", part: "criterion" })
    expect(refused(400, "invalid_proof")).toMatchObject({ kind: "part", part: "criterion" })
    expect(refused(400, "invalid_plan")).toEqual({
      kind: "part",
      part: "plan",
      message: "A plan has at most 30 steps.",
    })
    expect(refused(400, "invalid_title")).toMatchObject({ kind: "part", part: "plan" })
    expect(refused(400, "invalid_summary")).toMatchObject({ kind: "part", part: "project" })
    expect(refused(400, "invalid_region")).toMatchObject({ kind: "part", part: "company" })
    expect(refused(400, "invalid_main_contact")).toMatchObject({ kind: "part", part: "contact" })
  })

  it("works out which name the API refused, in the API's order", () => {
    const named = (companyName: string, projectName: string, contact: string) =>
      setupProblem(new ApiError(400, "invalid_name"), {
        ...body,
        company: { name: companyName },
        project: { name: projectName },
        stakeholders: contact ? [{ name: contact }] : [],
      })
    expect(named("Orion\u0007", "Claims", "Dana")).toMatchObject({ part: "company" })
    expect(named("Orion", "x".repeat(201), "Dana")).toMatchObject({ part: "project" })
    expect(named("Orion\u0007", "Claims", "Dana\nOrtiz")).toMatchObject({ part: "contact" })
    // None it can see: it says so, and the next try is a new setup.
    expect(named("Orion", "Claims", "Dana")).toMatchObject({ kind: "general", retry: false })
  })

  it("keeps the key where a retry is safe, and drops it where it is not", () => {
    expect(setupProblem(new TypeError("Failed to fetch"), body)).toMatchObject({
      kind: "general",
      retry: true,
      message: expect.stringMatching(/will not make a second company/),
    })
    expect(refused(503, "unavailable")).toMatchObject({ retry: true })
    expect(refused(403, "forbidden")).toMatchObject({ retry: true })
    expect(refused(401, "unauthorized")).toMatchObject({ retry: true })
    expect(refused(409, "rejected_idempotency_key_reused")).toMatchObject({
      retry: false,
      message: expect.stringMatching(/Check your companies/),
    })
    expect(refused(400, "invalid_body")).toMatchObject({ kind: "general", retry: false })
    expect(refused(400, "invalid_idempotency_key")).toMatchObject({ kind: "general", retry: false })
  })
})
