import { describe, expect, it } from "vitest"
import type { Project } from "./api/schemas"
import { hintFor, metSummary, openCount } from "./checklist"

const project = (over: Partial<Project> = {}) =>
  ({
    company: { id: "cmp_1", name: "Kestrel" },
    stakeholders: [{ id: "stk_1" }],
    access: [],
    scope: { version: 0, signed_off: false, sign_off: null, items: [], criteria: [] },
    ...over,
  }) as unknown as Project

describe("hintFor", () => {
  it("knows every item the API has today, and sends each to somewhere it can be fixed", () => {
    const keys = [
      "stakeholders_named",
      "scope_signed_off",
      "out_of_scope_listed",
      "criteria_have_targets",
      "access_granted",
      "criteria_have_evals",
      "criteria_met",
    ]
    for (const key of keys) expect(hintFor(key, project())?.fix, key).toBeDefined()
  })

  it("says plainly that meeting notes cannot be written here yet, with nothing to press", () => {
    const hint = hintFor("discovery_notes", project())
    expect(hint?.missing).toMatch(/Notes are not written here yet/)
    expect(hint?.fix).toBeUndefined()
  })

  it("names the customer, and turns sign-off into the step that is actually next", () => {
    const named = (key: string, p: Project) => hintFor(key, p)
    expect(named("stakeholders_named", project())?.missing).toBe("No one is named at Kestrel yet.")

    // No one to sign: name them first. Nothing written: write it first.
    expect(named("scope_signed_off", project({ stakeholders: [] }))?.fix?.do).toBe(
      "add-stakeholder",
    )
    expect(named("scope_signed_off", project())?.fix?.do).toBe("add-in-scope")
    const written = project({
      scope: {
        version: 1,
        signed_off: false,
        sign_off: null,
        items: [
          { id: "i", kind: "in", description: "x", updated_at: "" },
        ] as unknown as Project["scope"]["items"],
        criteria: [],
      },
    })
    expect(named("scope_signed_off", written)?.fix).toEqual({
      do: "sign-off",
      label: "Record sign-off",
    })
    // Signed once, then changed.
    const changed = project({
      scope: {
        ...written.scope,
        sign_off: { version: 0, stakeholder: "stk_1", recorded_by: "u", signed_at: "" },
      },
    } as Partial<Project>)
    expect(named("scope_signed_off", changed)?.fix).toEqual({
      do: "sign-off",
      label: "Sign off again",
    })
  })

  it("counts the access requests that are not granted", () => {
    const requests = ["requested", "denied", "granted"].map((status) => ({ status }))
    const p = project({ access: requests as unknown as Project["access"] })
    expect(hintFor("access_granted", p)?.missing).toBe("2 access requests not granted yet.")
    const one = project({ access: [{ status: "revoked" }] as unknown as Project["access"] })
    expect(hintFor("access_granted", one)?.missing).toBe("1 access request not granted yet.")
  })

  it("has no words for a key it does not know, so the page shows the API's label alone", () => {
    expect(hintFor("something_new", project())).toBeUndefined()
  })
})

describe("counts", () => {
  const items = [
    { key: "a", label: "A", met: true },
    { key: "b", label: "B", met: false },
    { key: "c", label: "C", met: false },
  ]
  it("says how many are open and how many are met", () => {
    expect(openCount(items)).toBe(2)
    expect(metSummary(items)).toBe("1 of 3 met")
  })
})
