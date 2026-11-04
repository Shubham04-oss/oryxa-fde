import { beforeEach, describe, expect, it } from "vitest"
import { ApiError, api, apiOver, mockApiOn, safeReturnTo, signInUrl } from "./client"
import type { Transport } from "./client"
import { CompanyId, ProjectId } from "./schemas"
import { resetMockApi } from "@/dev/mock-api"

const company = CompanyId.parse("cmp_kestrel")
const project = ProjectId.parse("prj_kestrel_dispatch")

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

  it("answers every screen's reads, parsed against the schemas", async () => {
    const { companies } = await api.companies()
    expect(companies.map((c) => [c.name, c.role])).toEqual([
      ["Kestrel Freight", "lead"],
      ["Brightwater Clinics", "engineer"],
      ["Lumen Grocers", "lead"],
      ["Atlas Mutual", "engineer"],
      // An organisation admin who is not a member has no part there.
      ["Cobalt Grid", null],
    ])
    for (const c of companies) {
      const detail = await api.company(c.id)
      for (const p of detail.projects) {
        expect((await api.project({ company: c.id, project: p.id })).company.id).toBe(c.id)
      }
    }
    expect((await api.today()).items.length).toBeGreaterThan(0)
    expect((await api.me()).organisation.name).toBe("Northlight FDE")
  })

  it("gathers a project's records and the people and systems they name", async () => {
    const p = await api.project({ company, project })
    expect(p.company).toEqual({ id: company, name: "Kestrel Freight" })
    expect(p.scope.items).toHaveLength(5)
    expect(p.tasks.map((t) => t.status)).toContain("blocked")
    const denied = p.access.find((a) => a.status === "denied")!
    expect(p.stakeholders.find((s) => s.id === denied.owner)?.name).toBe("Tomas Becker")
    expect(p.systems.find((s) => s.id === denied.system)?.name).toBe("Telematics")
  })

  it("lists open work for Today, with the owner's name and never settled access", async () => {
    const { items } = await api.today()
    const access = items.flatMap((item) => (item.kind === "access_request" ? [item] : []))
    expect(access.map((item) => item.access.status)).not.toContain("granted")
    expect(access.find((item) => item.access.id === "acc_k3")?.owner).toBe("Tomas Becker")
    const tasks = items.flatMap((item) => (item.kind === "task" ? [item.task.status] : []))
    expect(tasks).not.toContain("done")
  })

  it("refuses everything without a session", async () => {
    resetMockApi({ signedIn: false })
    expect((await refusal(api.me())).status).toBe(401)
    expect((await refusal(api.companies())).status).toBe(401)
    await api.signIn("/")
    expect((await api.me()).user.name).toBe("Riya Kapoor")
    await api.signOut()
    expect((await refusal(api.today())).status).toBe(401)
  })

  it("refuses a company that is not the FDE's, and a project under the wrong company", async () => {
    expect((await refusal(api.company(CompanyId.parse("cmp_other")))).status).toBe(403)
    const elsewhere = { company: CompanyId.parse("cmp_lumen"), project }
    expect((await refusal(api.project(elsewhere))).status).toBe(403)
  })

  it("keeps the stage machine: one forward, any back, never a skip", async () => {
    const scope = { company, project }
    expect((await api.moveStage(scope, "evaluate")).stage).toBe("evaluate")
    expect((await api.moveStage(scope, "access")).stage).toBe("access")
    const skip = await refusal(api.moveStage(scope, "deploy"))
    expect([skip.status, skip.code]).toEqual([409, "rejected_stage_transition"])
    // The API sends a code only; the client puts words to the ones a screen shows.
    expect(skip.message).toBe("A project moves one stage forward, or back to an earlier one.")
    expect((await api.project(scope)).stage).toBe("access")
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
    }
    return { seen, net: apiOver(async () => transport) }
  }

  const at = "2026-11-04T10:06:24.123456789Z"
  const me = {
    user: { id: "user_01", name: "Riya Kapoor" },
    organisation: { id: "org_01", name: "Northlight FDE" },
    role: "member",
  }

  it("calls the spec's paths on this origin, with the CSRF header on every call", async () => {
    const { seen, net } = stub({
      "GET /api/v1/me": () => Response.json(me),
      "GET /api/v1/companies": () =>
        Response.json([{ id: "cmp_1", name: "Kestrel", created_at: at, updated_at: at }]),
      "GET /api/v1/companies/cmp_1/projects": () => Response.json([]),
      "GET /api/v1/companies/cmp_1/members": () =>
        Response.json([{ user: "user_01", role: "engineer", added_at: at }]),
    })

    const { companies } = await net.companies()

    expect(companies).toEqual([
      {
        id: "cmp_1",
        name: "Kestrel",
        created_at: at,
        updated_at: at,
        role: "engineer",
        projects: [],
      },
    ])
    for (const request of seen) {
      expect(new URL(request.url).origin).toBe(window.location.origin)
      expect(request.headers.get("X-Oryxa-Request")).toBe("1")
      expect(request.headers.get("Authorization")).toBeNull()
    }
  })

  it("turns a refusal into an ApiError with the API's code, whatever its body", async () => {
    const { net } = stub({
      "GET /api/v1/me": () => Response.json(me),
      "GET /api/v1/companies": () => Response.json({ error: "unauthorized" }, { status: 401 }),
      "GET /api/v1/companies/cmp_1": () =>
        new Response("<html>bad gateway</html>", { status: 502 }),
    })

    const unauthorized = await refusal(net.companies())
    expect([unauthorized.status, unauthorized.code]).toEqual([401, "unauthorized"])
    const gateway = await refusal(net.company(CompanyId.parse("cmp_1")))
    expect([gateway.status, gateway.code]).toEqual([502, "http_502"])
  })

  it("fails loudly on an answer that drifts from the spec", async () => {
    const { net } = stub({
      "GET /api/v1/me": () => Response.json(me),
      "GET /api/v1/companies": () => Response.json([{ id: "cmp_1", name: "Kestrel" }]),
    })

    await expect(net.companies()).rejects.toThrow(/created_at/)
  })

  it("reads a project's people and systems through the project, as an assignee may", async () => {
    const base = "GET /api/v1/companies/cmp_1"
    const p = `${base}/projects/prj_1`
    const { seen, net } = stub({
      [base]: () => Response.json({ id: "cmp_1", name: "Kestrel", created_at: at, updated_at: at }),
      [p]: () =>
        Response.json({
          id: "prj_1",
          company: "cmp_1",
          name: "Dispatch",
          stage: "build",
          created_at: at,
          updated_at: at,
        }),
      [`${p}/scope`]: () =>
        Response.json({ version: 0, signed_off: false, sign_off: null, items: [], criteria: [] }),
      [`${p}/access-requests`]: () => Response.json([]),
      [`${p}/tasks`]: () => Response.json([]),
      [`${p}/decisions`]: () => Response.json([]),
      [`${p}/stakeholders`]: () =>
        Response.json([{ id: "stk_1", name: "Mara Lindqvist", updated_at: at }]),
      [`${p}/systems`]: () => Response.json([]),
    })

    const project = await net.project({
      company: CompanyId.parse("cmp_1"),
      project: ProjectId.parse("prj_1"),
    })

    expect(project.stakeholders.map((s) => s.name)).toEqual(["Mara Lindqvist"])
    const paths = seen.map((r) => new URL(r.url).pathname)
    expect(paths).toContain("/api/v1/companies/cmp_1/projects/prj_1/stakeholders")
    expect(paths).not.toContain("/api/v1/companies/cmp_1/stakeholders")
    expect(paths).not.toContain("/api/v1/companies/cmp_1/systems")
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

  it("leaves an encoded slash as a path on this origin", () => {
    expect(safeReturnTo("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example")
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
