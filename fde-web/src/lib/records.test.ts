import { describe, expect, it } from "vitest"
import type { CompanyOut, StakeholderOut } from "./api/schemas"
import { CompanyId, StakeholderId } from "./api/schemas"
import {
  canManage,
  companyBody,
  companyFields,
  companyPatch,
  companyProblem,
  projectPatch,
  stakeholderBody,
  stakeholderFields,
  stakeholderProblem,
  systemBody,
  systemFields,
  systemProblem,
} from "./records"

const at = "2026-11-04T10:06:24Z"
const company: CompanyOut = {
  id: CompanyId.parse("cmp_1"),
  name: "Kestrel Freight",
  industry: "Logistics",
  region: null,
  summary: "A carrier.",
  created_at: at,
  updated_at: at,
}

describe("company forms", () => {
  it("send a new company with what is blank left unset", () => {
    const fields = { name: "  Lumen Grocers ", industry: "", region: " ", summary: "" }
    expect(companyBody(fields)).toEqual({
      name: "Lumen Grocers",
      industry: null,
      region: null,
      summary: null,
    })
  })

  it("send only the fields that changed, and null for one that was cleared", () => {
    const fields = {
      ...companyFields(company),
      summary: "A carrier with 14 depots.",
      industry: " ",
    }
    expect(companyPatch(company, fields)).toEqual({
      summary: "A carrier with 14 depots.",
      industry: null,
    })
    expect(companyPatch(company, companyFields(company))).toEqual({})
  })

  it("say what is wrong in the API's words before anything is sent", () => {
    const ok = companyFields(company)
    expect(companyProblem(ok)).toBeNull()
    expect(companyProblem({ ...ok, name: "  " })).toBe("Name the company.")
    expect(companyProblem({ ...ok, name: "a".repeat(201) })).toBe(
      "A name is one line, 1 to 200 characters.",
    )
    expect(companyProblem({ ...ok, name: "two\nlines" })).toBe(
      "A name is one line, 1 to 200 characters.",
    )
    expect(companyProblem({ ...ok, region: "r".repeat(201) })).toBe(
      "Region is one line, up to 200 characters.",
    )
    expect(companyProblem({ ...ok, summary: "s".repeat(4001) })).toBe(
      "The summary is plain text, up to 4000 characters.",
    )
    // A summary may run to several lines.
    expect(companyProblem({ ...ok, summary: "one\ntwo" })).toBeNull()
  })

  it("counts characters, not code units", () => {
    const ok = companyFields(company)
    expect(companyProblem({ ...ok, name: "🚚".repeat(200) })).toBeNull()
    expect(companyProblem({ ...ok, name: "🚚".repeat(201) })).not.toBeNull()
  })
})

describe("project and record forms", () => {
  it("patch a project with only its changes", () => {
    const before = { id: company.id as never, name: "Dispatch", summary: null }
    expect(projectPatch(before, { name: "Dispatch", summary: "Plan in minutes." })).toEqual({
      summary: "Plan in minutes.",
    })
    expect(projectPatch(before, { name: "Dispatch copilot", summary: "" })).toEqual({
      name: "Dispatch copilot",
    })
  })

  it("send every field of a stakeholder, so a whole-record replace loses nothing", () => {
    const person: StakeholderOut = {
      id: StakeholderId.parse("stk_1"),
      name: "Mara Lindqvist",
      role: "sponsor",
      title: "Head of operations",
      email: "mara@example.com",
      digest_unsubscribed_at: at,
      updated_at: at,
      version: 1,
    }
    // Change one field: the others go back as they were.
    const fields = { ...stakeholderFields(person), title: "COO" }
    expect(stakeholderBody(fields)).toEqual({
      name: "Mara Lindqvist",
      role: "sponsor",
      title: "COO",
      email: "mara@example.com",
    })
    // A blank title or email clears it.
    expect(stakeholderBody({ ...fields, title: "", email: "" })).toMatchObject({
      title: null,
      email: null,
    })
  })

  it("check a stakeholder's address and a system's fields", () => {
    const person = { name: "Ines", role: "champion" as const, title: "", email: "" }
    expect(stakeholderProblem(person)).toBeNull()
    expect(stakeholderProblem({ ...person, title: "t".repeat(201) })).toBe(
      "The title is one line, up to 200 characters.",
    )
    expect(stakeholderProblem({ ...person, name: "" })).toBe("Name the stakeholder.")
    expect(stakeholderProblem({ ...person, email: "ines@example.com" })).toBeNull()
    for (const bad of [
      "ines",
      "ines@",
      "@example.com",
      "in es@example.com",
      "ines@example",
      "ines@.example.com",
      "ines@example..com",
      "ines@example.com.",
    ])
      expect(stakeholderProblem({ ...person, email: bad }), bad).toBe(
        "Use an address like name@example.com.",
      )
    const system = { name: "CRM", kind: "", description: "" }
    expect(systemProblem(system)).toBeNull()
    expect(systemProblem({ ...system, name: "" })).toBe("Name the system.")
    expect(systemProblem({ ...system, kind: "k".repeat(201) })).toBe(
      "The kind is one line, up to 200 characters.",
    )
    expect(systemBody({ name: " CRM ", kind: "SaaS", description: "" })).toEqual({
      name: "CRM",
      kind: "SaaS",
      description: null,
    })
    expect(systemFields().name).toBe("")
  })
})

describe("who may change a company", () => {
  const me = (role: "admin" | "member") =>
    ({ user: { id: "u", name: "n" }, organisation: { id: "o", name: "n" }, role }) as never
  it("is its lead or an organisation admin, never an engineer", () => {
    expect(canManage(me("member"), "lead")).toBe(true)
    expect(canManage(me("member"), "engineer")).toBe(false)
    expect(canManage(me("member"), null)).toBe(false)
    expect(canManage(me("admin"), "engineer")).toBe(true)
    expect(canManage(me("admin"), "admin")).toBe(true)
    expect(canManage(undefined, null)).toBe(false)
  })
})
