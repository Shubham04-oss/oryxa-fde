import { beforeEach, describe, expect, it } from "vitest"
import { ApiError, api } from "./client"
import type { SetupBody } from "./client"
import { CompanyId, ProjectId } from "./schemas"
import { mockApi, resetMockApi } from "@/dev/mock-api"

// The dev mock answers `POST /v1/companies/setup` as the API does (crates/oryxa-fde-api/src/setup.rs):
// every part by its own route's rules, all or nothing, the key required and claimed by caller and key,
// a retry with the same bytes answered with the first setup (200), and the key with other bytes a 409.

const body: SetupBody = {
  company: { name: "Orion Rail", industry: "Transport" },
  project: { name: "Claims intake", summary: "Automate claims intake." },
  stakeholders: [{ name: "Ines Laurent", role: "sponsor" }, { name: "Dana Ortiz" }],
  main_contact: 1,
  scope_items: [{ kind: "in", description: "Freight claims" }],
  criteria: [
    {
      description: "Claims triaged within two hours",
      metric: "hours to triage",
      comparator: "at_most",
      target: 2,
      baseline: 9.5,
      proof: "An eval on sample claims",
    },
  ],
  plan: [
    { title: "Discovery call", stage: "discover" },
    { title: "Evaluate", stage: "evaluate", criterion: 0, due_on: "2026-12-01" },
  ],
}

const send = (key: string | null, raw: string) =>
  mockApi.fetch(
    new Request(`${location.origin}/api/v1/companies/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: raw,
    }),
  )

async function code(response: Promise<Response>) {
  const r = await response
  const answer: { error?: string } = await r.json()
  return `${r.status} ${answer.error ?? ""}`.trim()
}

const companies = async () => (await api.companies()).companies.map((c) => c.name)

beforeEach(() => resetMockApi())

describe("a setup in one call, in the mock", () => {
  it("makes everything it describes, the plan in order with its next step", async () => {
    const json = JSON.stringify(body)
    const out = await api.setUpCompany({ key: "setup-one", body, json })
    expect(out.company).toMatchObject({ name: "Orion Rail", industry: "Transport", summary: null })
    expect(out.project).toMatchObject({ name: "Claims intake", stage: "discover" })
    expect(out.project.next_step).toMatchObject({ title: "Discovery call", task: out.plan[0]!.id })
    expect(out.stakeholders.map((s) => [s.name, s.role, s.main_contact])).toEqual([
      ["Ines Laurent", "sponsor", false],
      ["Dana Ortiz", "other", true],
    ])
    expect(out.scope.items.map((i) => i.description)).toEqual(["Freight claims"])
    const [criterion] = out.scope.criteria
    expect(criterion).toMatchObject({ baseline: 9.5, proof: "An eval on sample claims" })
    expect(out.plan.map((t) => [t.title, t.status, t.stage, t.criterion ?? null])).toEqual([
      ["Discovery call", "todo", "discover", null],
      ["Evaluate", "todo", "evaluate", criterion!.id],
    ])
    // The caller leads it, and it is theirs to open.
    const listed = (await api.companies()).companies.find((c) => c.id === out.company.id)
    expect(listed).toMatchObject({ role: "lead", projects: [{ name: "Claims intake" }] })
    const scope = {
      company: CompanyId.parse(out.company.id),
      project: ProjectId.parse(out.project.id),
    }
    expect((await api.project(scope)).tasks).toHaveLength(2)
  })

  it("answers a retry with the same key and bytes with the first setup, and makes nothing new", async () => {
    const json = JSON.stringify(body)
    const first = await send("setup-two", json)
    expect(first.status).toBe(201)
    const again = await send("setup-two", json)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(await first.json())
    expect((await companies()).filter((n) => n === "Orion Rail")).toHaveLength(1)
  })

  it("refuses the key with other bytes, and makes nothing", async () => {
    await send("setup-three", JSON.stringify(body))
    const other = JSON.stringify({ ...body, company: { name: "Lumen" } })
    expect(await code(send("setup-three", other))).toBe("409 rejected_idempotency_key_reused")
    // The same body, written another way, is other bytes too: the web keeps what it sent.
    const spaced = JSON.stringify(body, null, 2)
    expect(await code(send("setup-three", spaced))).toBe("409 rejected_idempotency_key_reused")
    expect(await companies()).not.toContain("Lumen")
  })

  it("needs a key the API takes", async () => {
    const json = JSON.stringify(body)
    for (const key of [null, "has space", "a/b", "k".repeat(129)])
      expect(await code(send(key, json))).toBe("400 invalid_idempotency_key")
  })

  it("refuses a body serde would not read, before any part's rules", async () => {
    for (const bad of [
      "{",
      { ...body, invite: ["sam@example.com"] },
      { ...body, plan: [{ title: "x", assignee: "usr_riya" }] },
      { ...body, company: { name: "Acme", owner: "x" } },
      { ...body, plan: [{ title: "x", stage: "launch" }] },
      { ...body, criteria: [{ ...body.criteria![0], baseline: "low" }] },
      { ...body, stakeholders: [{ name: "x", role: "boss" }] },
      { project: body.project },
    ])
      expect(
        await code(send("setup-shape", typeof bad === "string" ? bad : JSON.stringify(bad))),
      ).toBe("400 invalid_body")
  })

  it("refuses a wrong part by its own route's code, and leaves nothing behind", async () => {
    const before = await companies()
    const many = <T>(n: number, one: T) => Array.from({ length: n }, () => one)
    for (const [extra, want] of [
      [{ company: { name: "" } }, "invalid_name"],
      [{ project: { name: " " } }, "invalid_name"],
      [{ stakeholders: many(21, { name: "x" }) }, "invalid_stakeholders"],
      [{ scope_items: many(31, { kind: "in", description: "x" }) }, "invalid_scope_items"],
      [{ plan: many(31, { title: "x" }) }, "invalid_plan"],
      [{ stakeholders: [], main_contact: 0 }, "invalid_main_contact"],
      [{ criteria: [], plan: [{ title: "x", criterion: 0 }] }, "invalid_criterion"],
      [{ plan: [{ title: "" }] }, "invalid_title"],
      [{ plan: [{ title: "x", due_on: "soon" }] }, "invalid_due_on"],
      [{ stakeholders: [{ name: "x", version: 2 }], main_contact: null }, "invalid_version"],
      [{ criteria: [{ ...body.criteria![0], proof: "x".repeat(501) }] }, "invalid_proof"],
      [{ criteria: [{ ...body.criteria![0], metric: "" }] }, "invalid_metric"],
    ] as const)
      expect(await code(send("setup-parts", JSON.stringify({ ...body, ...extra })))).toBe(
        `400 ${want}`,
      )
    expect(await companies()).toEqual(before)
    // A refused key is not claimed: the same key may then set up the body it was meant for.
    expect((await send("setup-parts", JSON.stringify(body))).status).toBe(201)
  })

  it("refuses the next setup once with the code the dev switch names", async () => {
    const g = globalThis as Record<string, unknown>
    g.__fdeMockRefuseSetup = "invalid_target"
    expect(await code(send("setup-switch", JSON.stringify(body)))).toBe("400 invalid_target")
    expect(g.__fdeMockRefuseSetup).toBeUndefined()
    expect((await send("setup-switch", JSON.stringify(body))).status).toBe(201)
  })

  it("is refused through the client as the API refuses it", async () => {
    const e = await api
      .setUpCompany({
        key: "setup-client",
        body,
        json: JSON.stringify({ ...body, plan: [{ title: "" }] }),
      })
      .catch((error: unknown) => error)
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ status: 400, code: "invalid_title" })
  })
})
