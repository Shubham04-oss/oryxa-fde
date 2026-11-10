import { beforeEach, describe, expect, it } from "vitest"
import {
  ApiError,
  ChecklistOpenError,
  api,
  apiOver,
  mockApiOn,
  safeReturnTo,
  signInUrl,
} from "./client"
import type { Transport, UploadRequest } from "./client"
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
      // An organisation admin who is not a member reaches it as an admin.
      ["Cobalt Grid", "admin"],
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
    const uploads: Array<UploadRequest> = []
    const transport: Transport = {
      async upload(request) {
        uploads.push(request)
        const { pathname } = new URL(request.url)
        return (
          routes[`POST ${pathname}`]?.() ?? Response.json({ error: "not_found" }, { status: 404 })
        )
      },
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
    return { seen, uploads, net: apiOver(async () => transport) }
  }

  const at = "2026-11-04T10:06:24.123456789Z"
  const me = {
    user: { id: "user_01", name: "Riya Kapoor" },
    organisation: { id: "org_01", name: "Northlight FDE" },
    role: "member",
  }

  it("calls the spec's paths on this origin, with the CSRF header on every call", async () => {
    const kestrel = { id: "cmp_1", name: "Kestrel", created_at: at, updated_at: at }
    const { seen, net } = stub({
      "GET /api/v1/me": () => Response.json(me),
      "GET /api/v1/companies": () =>
        Response.json([
          { ...kestrel, role: "engineer", projects: [{ id: "prj_1", name: "D", stage: "build" }] },
        ]),
      "GET /api/v1/today": () =>
        Response.json({
          items: [
            {
              kind: "access_request",
              access: {
                id: "acc_1",
                description: "Read replica",
                status: "requested",
                requested_at: at,
                status_changed_at: at,
                days_waiting: 3,
                version: 1,
              },
              owner: "Tomas Becker",
              company: { id: "cmp_1", name: "Kestrel" },
              project: { id: "prj_1", name: "D" },
            },
          ],
        }),
    })

    expect((await net.me()).user.name).toBe("Riya Kapoor")
    const { companies } = await net.companies()
    expect(companies.map((c) => [c.role, c.projects.map((p) => p.id)])).toEqual([
      ["engineer", ["prj_1"]],
    ])
    const { items } = await net.today()
    expect(items[0]?.kind === "access_request" && items[0].owner).toBe("Tomas Becker")

    // One call each: the API serves the whole view.
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /api/v1/me",
      "GET /api/v1/companies",
      "GET /api/v1/today",
    ])
    for (const request of seen) {
      expect(new URL(request.url).origin).toBe(window.location.origin)
      expect(request.headers.get("X-Oryxa-Request")).toBe("1")
      expect(request.headers.get("Authorization")).toBeNull()
    }
  })

  describe("documents", () => {
    const doc = {
      id: "doc_1",
      name: "a.pdf",
      content_type: "application/pdf",
      size_bytes: 3,
      sha256: "0".repeat(64),
      status: "pending",
      chunks: 0,
      uploaded_by: "user_01",
      created_at: at,
    }
    const cmp1 = CompanyId.parse("cmp_1")
    const file = new File(["abc"], "a.pdf", { type: "application/pdf" })
    const send = (net: ReturnType<typeof stub>["net"], name: string) =>
      net.uploadDocument(cmp1, { file, contentType: "application/pdf", name }, () => {})

    it("sends the file as the body, its type as the Content-Type and its name in the query, on this origin", async () => {
      const { uploads, net } = stub({
        "POST /api/v1/companies/cmp_1/documents": () => Response.json(doc, { status: 201 }),
      })
      const saved = await send(net, "a&b=c/../d?.pdf #1")
      expect(saved.status).toBe("pending")
      const [sent] = uploads
      const url = new URL(sent!.url)
      expect(url.origin).toBe(window.location.origin)
      expect(url.pathname).toBe("/api/v1/companies/cmp_1/documents")
      // Whatever the name holds is one value of one parameter, never part of the path or another parameter.
      expect([...url.searchParams.keys()]).toEqual(["name"])
      expect(url.searchParams.get("name")).toBe("a&b=c/../d?.pdf #1")
      expect(sent!.body).toBe(file)
      expect(sent!.headers["Content-Type"]).toBe("application/pdf")
      expect(sent!.headers["X-Oryxa-Request"]).toBe("1")
    })

    it("says why in the file's own terms when the API refuses a file", async () => {
      const refused = (status: number, body?: unknown) =>
        stub({
          "POST /api/v1/companies/cmp_1/documents": () =>
            body === undefined ? new Response("", { status }) : Response.json(body, { status }),
        }).net
      const big = await refusal(send(refused(413), "a.pdf"))
      expect([big.status, big.code, big.message]).toEqual([
        413,
        "payload_too_large",
        "That file is over the 20 MB limit.",
      ])
      const kind = await refusal(send(refused(415, { error: "unsupported_media_type" }), "a.pdf"))
      expect([kind.status, kind.message]).toEqual([
        415,
        "Only text, Markdown, PDF and Word (.docx) files are accepted.",
      ])
      // `invalid_body` is the note's code too; for a file it means nothing was in it.
      const empty = await refusal(send(refused(400, { error: "invalid_body" }), "a.pdf"))
      expect(empty.message).toBe("That file is empty.")
      const name = await refusal(send(refused(400, { error: "invalid_name" }), "a.pdf"))
      expect([name.code, name.message]).toEqual([
        "invalid_name",
        "A name is one line, 1 to 200 characters.",
      ])
    })

    it("fails loudly on a document that drifts from the contract", async () => {
      const { net } = stub({
        "POST /api/v1/companies/cmp_1/documents": () =>
          Response.json({ ...doc, status: "reading" }, { status: 201 }),
      })
      await expect(send(net, "a.pdf")).rejects.toThrow()
    })

    it("reads the list and a search, a search's words going in the query as one value", async () => {
      const { seen, net } = stub({
        "GET /api/v1/companies/cmp_1/documents": () => Response.json([doc]),
        "GET /api/v1/companies/cmp_1/search": () =>
          Response.json([
            { document: "doc_1", document_name: "a.pdf", chunk: 0, text: "hello", score: 0.03 },
          ]),
      })
      expect((await net.documents(cmp1))[0]?.id).toBe("doc_1")
      const hits = await net.search(cmp1, 'drivers -"rest hours" & more=1')
      expect(hits[0]?.text).toBe("hello")
      const url = new URL(seen[1]!.url)
      expect(url.searchParams.get("q")).toBe('drivers -"rest hours" & more=1')
      expect(url.searchParams.get("limit")).toBe("20")
      expect([...url.searchParams.keys()].sort()).toEqual(["limit", "q"])
    })
  })

  it("turns a refusal into an ApiError with the API's code, whatever its body", async () => {
    const signedOut = stub({
      "GET /api/v1/me": () => Response.json({ error: "unauthorized" }, { status: 401 }),
    })
    const unauthorized = await refusal(signedOut.net.me())
    expect([unauthorized.status, unauthorized.code]).toEqual([401, "unauthorized"])

    const down = stub({
      "GET /api/v1/today": () => new Response("<html>bad gateway</html>", { status: 502 }),
    })
    const gateway = await refusal(down.net.today())
    expect([gateway.status, gateway.code]).toEqual([502, "http_502"])

    // The API's own 503 says a service it needs is down, not that the FDE is offline.
    const unavailable = stub({
      "GET /api/v1/me": () => Response.json({ error: "unavailable" }, { status: 503 }),
    })
    const refused = await refusal(unavailable.net.me())
    expect(refused.message).toBe("The workspace is briefly unavailable. Try again in a minute.")
  })

  it("reads a stage's checklist, and sends a reason with a move only when given one", async () => {
    const stage = `PUT /api/v1/companies/${company}/projects/${project}/stage`
    const when = "2026-11-04T10:06:24Z"
    const moved = {
      id: project,
      company,
      name: "D",
      stage: "evaluate",
      created_at: when,
      updated_at: when,
    }
    const { seen, net } = stub({
      [`GET /api/v1/companies/${company}/projects/${project}/stage-checklist`]: () =>
        Response.json({
          stage: "build",
          items: [{ key: "criteria_have_evals", label: "An eval suite", met: false }],
        }),
      [stage]: () => Response.json(moved),
    })
    const scope = { company, project }
    expect(await net.stageChecklist(scope)).toEqual({
      stage: "build",
      items: [{ key: "criteria_have_evals", label: "An eval suite", met: false }],
    })
    await net.moveStage(scope, "evaluate")
    await net.moveStage(scope, "evaluate", "Measured by hand")
    const bodies = await Promise.all(seen.filter((r) => r.method === "PUT").map((r) => r.json()))
    expect(bodies).toEqual([
      { stage: "evaluate" },
      { stage: "evaluate", reason: "Measured by hand" },
    ])
  })

  it("turns a 409 with open items into a ChecklistOpenError that carries them", async () => {
    const open = [{ key: "access_granted", label: "Every access request granted", met: false }]
    const { net } = stub({
      [`PUT /api/v1/companies/${company}/projects/${project}/stage`]: () =>
        Response.json({ error: "rejected_checklist_open", open }, { status: 409 }),
    })
    const error = await net.moveStage({ company, project }, "build").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ChecklistOpenError)
    expect((error as ChecklistOpenError).open).toEqual(open)
    expect((error as ApiError).status).toBe(409)
    expect((error as ApiError).message).toBe(
      "Some of this stage's checklist is still open. Give a reason to move on anyway.",
    )
  })

  it("keeps a refusal of the stage move that is not about the checklist as it is", async () => {
    const stage = `PUT /api/v1/companies/${company}/projects/${project}/stage`
    for (const [status, code, said] of [
      [
        409,
        "rejected_stage_transition",
        "A project moves one stage forward, or back to an earlier one.",
      ],
      [400, "invalid_reason", "The reason is plain text, 1 to 500 characters."],
    ] as const) {
      const { net } = stub({ [stage]: () => Response.json({ error: code }, { status }) })
      const error = await refusal(net.moveStage({ company, project }, "build", "x"))
      expect(error).not.toBeInstanceOf(ChecklistOpenError)
      expect([error.status, error.code, error.message]).toEqual([status, code, said])
    }
  })

  it("fails loudly on an answer that drifts from the spec", async () => {
    const { net } = stub({
      "GET /api/v1/companies": () =>
        Response.json([{ id: "cmp_1", name: "Kestrel", role: "lead", projects: [] }]),
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
        Response.json([
          { id: "stk_1", name: "Mara Lindqvist", role: "sponsor", updated_at: at, version: 1 },
        ]),
      [`${p}/systems`]: () => Response.json([]),
    })

    const found = await net.project({
      company: CompanyId.parse("cmp_1"),
      project: ProjectId.parse("prj_1"),
    })

    expect(found.stakeholders.map((s) => s.name)).toEqual(["Mara Lindqvist"])
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
