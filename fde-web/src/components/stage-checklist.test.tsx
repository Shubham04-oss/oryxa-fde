import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { CompanyPage } from "./company-page"
import { ProjectPage } from "./project-page"
import { api } from "@/lib/api/client"
import { CompanyId, ProjectId, StakeholderId } from "@/lib/api/schemas"
import type { Stage } from "@/lib/api/schemas"
import { resetMockApi } from "@/dev/mock-api"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

beforeAll(installWire)
afterEach(resetWire)

const scopeOf = (company: string, project: string) => ({
  company: CompanyId.parse(company),
  project: ProjectId.parse(project),
})
/** Build, with an eval suite on every criterion: nothing open. */
const DISPATCH = scopeOf("cmp_kestrel", "prj_kestrel_dispatch")
/** Discover: the company has stakeholders, and no meeting note is on the project. */
const CLAIMS = scopeOf("cmp_kestrel", "prj_kestrel_claims")
/** Access, with two requests not granted. */
const REFERRALS = scopeOf("cmp_brightwater", "prj_bw_referrals")
/** Scope: written and never signed off. */
const FNOL = scopeOf("cmp_atlas", "prj_atlas_fnol")
/** Evaluate: one criterion has no result. */
const FORECAST = scopeOf("cmp_lumen", "prj_lumen_forecast")
/** Deploy: nothing to check yet. */
const FIELD = scopeOf("cmp_cobalt", "prj_cobalt_field")

const checklist = (stage: string) => screen.findByRole("region", { name: `To leave ${stage}` })
const dialog = (name: string) => screen.findByRole("dialog", { name })
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

/** A project at `stage`, moved there with a reason so open items do not stop it. */
async function atStage(project: typeof CLAIMS, ...stages: Array<Stage>) {
  resetMockApi()
  for (const stage of stages) await api.moveStage(project, stage, "To test")
}

describe("the stage checklist", () => {
  it("says what the stage needs: met items quietly, open ones with what is missing", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)

    const box = await checklist("Scope")
    expect(within(box).getByText("2 of 3 met")).toBeInTheDocument()
    const rows = within(box).getAllByRole("listitem")
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Open: Scope signed off, and unchanged since"),
      expect.stringContaining("Met: What is out of scope is listed"),
      expect.stringContaining("Met: Success criteria set, each with a target"),
    ])
    expect(rows[0]).toHaveTextContent("Atlas Mutual has not signed off the scope.")
    expect(within(rows[0]!).getByRole("button", { name: "Record sign-off" })).toBeInTheDocument()
    // Met items offer nothing to press.
    expect(within(rows[1]!).queryByRole("button")).toBeNull()
  })

  it("sits under the stage bar and above the board", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    const box = await checklist("Scope")
    const bar = screen.getByRole("region", { name: "Stage" })
    const board = screen.getByRole("region", { name: "Board" })
    expect(bar.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(box.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("collapses to one quiet line when every item is met", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    expect(
      await screen.findByText(/Ready to leave Build\. Everything it needs is in place\./),
    ).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: /leave/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Go to/ })).toBeNull()
  })

  it("shows nothing for a stage with no items", async () => {
    renderWithRouter(<ProjectPage scope={FIELD} />)
    await screen.findByRole("button", { name: "Move back to Evaluate" })
    await waitFor(() => expect(screen.queryByText(/Reading what this stage needs/)).toBeNull())
    expect(screen.queryByRole("region", { name: /To leave/ })).toBeNull()
    expect(screen.queryByText(/Ready to leave/)).toBeNull()
  })

  it("says it could not read the checklist, and tries again", async () => {
    wire.refuseReads = {
      ending: "/stage-checklist",
      response: Response.json({ error: "forbidden" }, { status: 403 }),
    }
    renderWithRouter(<ProjectPage scope={FNOL} />)
    expect(await screen.findByText(/We couldn't read what this stage needs/)).toBeInTheDocument()
    // The rest of the page is there.
    expect(screen.getByRole("button", { name: "Move to Access" })).toBeEnabled()
    wire.refuseReads = null
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await checklist("Scope")).toBeInTheDocument()
  })

  it("is not an error: open items use neither red nor amber", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    const box = await checklist("Scope")
    expect(box.innerHTML).not.toMatch(/destructive|attention/)
  })
})

describe("what an open item says and where it goes", () => {
  it("opens the sign-off dialog for scope signed off", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    const box = await checklist("Scope")
    await userEvent.click(within(box).getByRole("button", { name: "Record sign-off" }))
    expect(await dialog("Record sign-off")).toBeInTheDocument()
  })

  it("on an empty scope offers to write it, then the out-of-scope list and the criteria", async () => {
    await atStage(CLAIMS, "scope")
    renderWithRouter(<ProjectPage scope={CLAIMS} />, { keep: true })

    const box = await checklist("Scope")
    expect(within(box).getByText("0 of 3 met")).toBeInTheDocument()
    expect(box).toHaveTextContent("The scope is empty, so there is nothing to sign off.")
    expect(box).toHaveTextContent("Nothing is listed as out of scope.")
    expect(box).toHaveTextContent("There are no success criteria yet. Each needs a target.")

    await userEvent.click(within(box).getByRole("button", { name: "Add to scope" }))
    expect(await dialog("Add to scope")).toBeInTheDocument()
    expect(within(screen.getByRole("dialog")).getByLabelText("Listed as")).toHaveValue("in")
    await userEvent.keyboard("{Escape}")
    await closed()

    await userEvent.click(within(box).getByRole("button", { name: "Add out of scope" }))
    const out = await dialog("Add to scope")
    expect(within(out).getByLabelText("Listed as")).toHaveValue("out")
    await userEvent.keyboard("{Escape}")
    await closed()

    await userEvent.click(within(box).getByRole("button", { name: "Add criterion" }))
    expect(await dialog("Add success criterion")).toBeInTheDocument()
  })

  it("goes to the Access card and focuses it", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)
    const box = await checklist("Access")
    expect(box).toHaveTextContent("2 access requests not granted yet.")
    await userEvent.click(within(box).getByRole("button", { name: "Go to Access" }))
    expect(screen.getByRole("region", { name: "Access" })).toHaveFocus()
  })

  it("goes to the criteria when a result is missing", async () => {
    renderWithRouter(<ProjectPage scope={FORECAST} />)
    const box = await checklist("Evaluate")
    expect(box).toHaveTextContent("Not every criterion has a result that meets its target yet.")
    await userEvent.click(within(box).getByRole("button", { name: "Go to criteria" }))
    expect(screen.getByRole("region", { name: "Success criteria" })).toHaveFocus()
  })

  it("says plainly when this page cannot fix an item yet, and offers nothing to press", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    const box = await checklist("Discover")
    expect(box).toHaveTextContent("1 of 2 met")
    expect(box).toHaveTextContent(
      "No meeting note is on the project yet. Notes are not written here yet.",
    )
    expect(within(box).queryByRole("button")).toBeNull()
    expect(within(box).queryByRole("link")).toBeNull()
  })

  it("sends the FDE to the company's Add stakeholder when no one is named", async () => {
    resetMockApi()
    const company = await api.createCompany({ name: "Orion Rail" })
    const made = await api.createProject(CompanyId.parse(company.id), { name: "Yard planner" })
    const scope = { company: CompanyId.parse(company.id), project: ProjectId.parse(made.id) }
    const { router } = renderWithRouter(<ProjectPage scope={scope} />, { keep: true })

    const box = await checklist("Discover")
    expect(box).toHaveTextContent("No one is named at Orion Rail yet.")
    const link = within(box).getByRole("link", { name: "Add stakeholder, on the company page" })
    expect(link).toHaveAttribute("href", `/companies/${company.id}?add=stakeholder`)
    await userEvent.click(link)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/companies/${company.id}`))
    expect(router.state.location.search).toEqual({ add: "stakeholder" })
  })

  it("opens the company's Add stakeholder dialog when it is sent there", async () => {
    renderWithRouter(<CompanyPage companyId={CompanyId.parse("cmp_kestrel")} addStakeholder />)
    expect(await dialog("Add stakeholder")).toBeInTheDocument()
  })

  it("does not open it otherwise", async () => {
    renderWithRouter(<CompanyPage companyId={CompanyId.parse("cmp_kestrel")} />)
    await screen.findByRole("button", { name: "Add stakeholder" })
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("the checklist stays true as the page changes", () => {
  it("reads again after a sign-off, and collapses once everything is met", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    const box = await checklist("Scope")
    await userEvent.click(within(box).getByRole("button", { name: "Record sign-off" }))
    const form = await dialog("Record sign-off")
    await userEvent.selectOptions(within(form).getByLabelText("Signed off by"), "stk_a2")
    await userEvent.click(within(form).getByRole("button", { name: "Record sign-off" }))
    await closed()

    expect(
      await screen.findByText(/Ready to leave Scope\. Everything it needs is in place\./),
    ).toBeInTheDocument()
    // Only the one line is left: no rows.
    expect(screen.getByRole("region", { name: "To leave Scope" }).querySelector("li")).toBeNull()
  })

  it("reads again after a scope change: a signed-off scope that changes is open again", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(
      within(await checklist("Scope")).getByRole("button", { name: "Record sign-off" }),
    )
    const form = await dialog("Record sign-off")
    await userEvent.selectOptions(within(form).getByLabelText("Signed off by"), "stk_a2")
    await userEvent.click(within(form).getByRole("button", { name: "Record sign-off" }))
    await screen.findByText(/Ready to leave Scope/)

    // Writing one more scope item moves the version on: the sign-off no longer covers it.
    await userEvent.click(await screen.findByRole("button", { name: "Add out of scope" }))
    const item = await dialog("Add to scope")
    await userEvent.type(within(item).getByLabelText("Description"), "Subrogation")
    await userEvent.click(within(item).getByRole("button", { name: "Add" }))
    await closed()

    const box = await checklist("Scope")
    expect(box).toHaveTextContent("The scope changed after it was signed off")
    expect(within(box).getByRole("button", { name: "Sign off again" })).toBeInTheDocument()
  })

  it("reads again after a criterion is added", async () => {
    await atStage(CLAIMS, "scope")
    renderWithRouter(<ProjectPage scope={CLAIMS} />, { keep: true })
    const box = await checklist("Scope")
    await userEvent.click(within(box).getByRole("button", { name: "Add criterion" }))
    const form = await dialog("Add success criterion")
    await userEvent.type(within(form).getByLabelText("What must be true"), "Plans are accepted")
    await userEvent.type(within(form).getByLabelText("What is measured"), "plans accepted")
    await userEvent.type(within(form).getByLabelText("Target"), "70")
    await userEvent.click(within(form).getByRole("button", { name: "Add criterion" }))
    await closed()

    await waitFor(() => expect(box).toHaveTextContent("1 of 3 met"))
    expect(box).not.toHaveTextContent("There are no success criteria yet")
  })

  it("is not brought back by a read sent before the change and answered after it", async () => {
    const { queryClient } = renderWithRouter(<ProjectPage scope={FNOL} />)
    const box = await checklist("Scope")
    await userEvent.click(within(box).getByRole("button", { name: "Record sign-off" }))
    const form = await dialog("Record sign-off")
    await userEvent.selectOptions(within(form).getByLabelText("Signed off by"), "stk_a2")

    // A read of the checklist (window focus, another tab) is on its way, holding what is true now.
    let release = () => {}
    wire.holdReads = new Promise((resolve) => (release = resolve))
    void queryClient.invalidateQueries({
      queryKey: ["companies", FNOL.company, "projects", FNOL.project, "stage-checklist"],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Only that read is held: the sign-off's own look at the scope goes through.
    wire.holdReads = null
    await userEvent.click(within(form).getByRole("button", { name: "Record sign-off" }))
    await closed()
    release()

    expect(await screen.findByText(/Ready to leave Scope/)).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.getByText(/Ready to leave Scope/)).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "To leave Scope" }).querySelector("li")).toBeNull()
  })

  it("reads again when a sign-off turns out to have been recorded already", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    const box = await checklist("Scope")
    await userEvent.click(within(box).getByRole("button", { name: "Record sign-off" }))
    const form = await dialog("Record sign-off")
    await userEvent.selectOptions(within(form).getByLabelText("Signed off by"), "stk_a2")
    await api.signOffScope(FNOL, StakeholderId.parse("stk_a1"))
    await userEvent.click(within(form).getByRole("button", { name: "Record sign-off" }))
    await within(form).findByRole("alert")

    await userEvent.keyboard("{Escape}")
    await closed()
    expect(await screen.findByText(/Ready to leave Scope/)).toBeInTheDocument()
  })
})

describe("the API mock's checklist", () => {
  const path = (s: typeof FNOL) => `/api/v1/companies/${s.company}/projects/${s.project}`

  async function call(url: string, init?: RequestInit) {
    const { mockApi } = await import("@/dev/mock-api")
    return mockApi.fetch(new Request(`${location.origin}${url}`, init))
  }

  it("works each item out from the project's records, with the API's keys and words", async () => {
    resetMockApi()
    type Read = { stage: string; items: Array<{ key: string; label: string; met: boolean }> }
    const read = async (s: typeof FNOL): Promise<Read> =>
      (await call(`${path(s)}/stage-checklist`)).json()
    expect(await read(CLAIMS)).toEqual({
      stage: "discover",
      items: [
        { key: "stakeholders_named", label: "Stakeholders named", met: true },
        { key: "discovery_notes", label: "A meeting note on the project", met: false },
      ],
    })
    expect((await read(FNOL)).items).toEqual([
      expect.objectContaining({ key: "scope_signed_off", met: false }),
      expect.objectContaining({ key: "out_of_scope_listed", met: true }),
      expect.objectContaining({ key: "criteria_have_targets", met: true }),
    ])
    expect(await read(FIELD)).toEqual({ stage: "deploy", items: [] })
    expect((await read(DISPATCH)).items).toEqual([
      expect.objectContaining({ key: "criteria_have_evals", met: true }),
    ])
    expect((await read(FORECAST)).items).toEqual([
      expect.objectContaining({ key: "criteria_met", met: false }),
    ])
  })

  it("refuses a forward move with an item open and no reason, naming what is open", async () => {
    resetMockApi()
    const put = (body: unknown) =>
      call(`${path(REFERRALS)}/stage`, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      })
    const refused = await put({ stage: "build" })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error: "rejected_checklist_open",
      open: [{ key: "access_granted", label: "Every access request granted", met: false }],
    })
    // A reason that is not one is a 400, whether or not it was needed.
    for (const reason of ["", "   ", "bell\u0007", "c1\u0085x", "x".repeat(501)])
      expect((await put({ stage: "build", reason })).status, reason).toBe(400)
    expect((await put({ stage: "scope", reason: "" })).status).toBe(400)
    // Moving back needs none, and a valid reason moves forward.
    expect((await put({ stage: "scope" })).status).toBe(200)
    // Scope has items open too: forward needs a reason from there as well.
    expect((await put({ stage: "access" })).status).toBe(409)
    expect((await put({ stage: "access", reason: "Signing is booked" })).status).toBe(200)
    expect((await put({ stage: "build", reason: "x".repeat(500) })).status).toBe(200)
  })
})
