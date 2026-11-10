import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ProjectPage } from "./project-page"
import { api, queries } from "@/lib/api/client"
import { AccessRequestId, CompanyId, ProjectId } from "@/lib/api/schemas"
import { resetMockApi } from "@/dev/mock-api"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

beforeAll(installWire)
afterEach(resetWire)

const scopeOf = (company: string, project: string) => ({
  company: CompanyId.parse(company),
  project: ProjectId.parse(project),
})
/** Build: one granted, one in progress (6 days), one denied that blocks a task. */
const DISPATCH = scopeOf("cmp_kestrel", "prj_kestrel_dispatch")
/** Access: one granted, two open (5 and 11 days), the checklist's access item open. */
const REFERRALS = scopeOf("cmp_brightwater", "prj_bw_referrals")
/** Nothing written in it at all. */
const CLAIMS = scopeOf("cmp_kestrel", "prj_kestrel_claims")
const base = (s: { company: string; project: string }) =>
  `/companies/${s.company}/projects/${s.project}`
const accessId = (id: string) => AccessRequestId.parse(id)

const card = (hidden = false) => screen.findByRole("region", { name: "Access", hidden })
const dialog = (name: string) => screen.findByRole("dialog", { name })
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
const field = (box: HTMLElement, label: string) => within(box).getByLabelText(label)
const click = (box: HTMLElement, name: string) =>
  userEvent.click(within(box).getByRole("button", { name }))
const writes = () => wire.sent.map(({ method, path }) => `${method} ${path}`)
const rowsOf = (box: HTMLElement) =>
  within(within(box).getByRole("list", { name: "Access requests" })).getAllByRole("listitem")
const rowFor = (box: HTMLElement, text: string) => {
  const row = rowsOf(box).find((r) => r.textContent.includes(text))
  if (!row) throw new Error(`no access row says ${text}`)
  return row
}
/** Opens a row's menu and picks an item. */
async function pick(row: HTMLElement, item: string) {
  await userEvent.click(within(row).getByRole("button", { name: /^Actions for/ }))
  await userEvent.click(await screen.findByRole("menuitem", { name: item }))
}

describe("the Access card, at a glance", () => {
  it("says what is not granted, who holds it up and for how long, with the longest wait first", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)
    const access = await card()
    const summary = within(access).getByLabelText("Access at a glance")
    expect(summary).toHaveTextContent("Not granted2 of 3")
    expect(summary).toHaveTextContent("Held up byOwen Price and Sana Qureshi")
    expect(summary).toHaveTextContent("Longest wait11 days")
    // Open ones by how long they have waited, then the granted one.
    expect(rowsOf(access).map((r) => r.textContent)).toEqual([
      expect.stringContaining("Clinic directory export"),
      expect.stringContaining("Intake form API, staging"),
      expect.stringContaining("Synthetic referral letters"),
    ])
    const long = rowFor(access, "Clinic directory export")
    expect(long).toHaveTextContent("Owner: Sana Qureshi")
    expect(long).toHaveTextContent("In progress, waiting 11 days")
    expect(rowFor(access, "Synthetic referral letters")).toHaveTextContent(/Granted .* after 1 day/)
  })

  it("puts a refusal first and names the tasks that wait on a request", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const access = await card()
    const first = rowsOf(access)[0]!
    expect(first).toHaveTextContent("Telematics export")
    expect(first).toHaveTextContent(/Denied .* after 4 days/)
    expect(first).toHaveTextContent("Blocks 1 task: “Agree the telematics alternative”")
    expect(within(access).getByLabelText("Access at a glance")).toHaveTextContent(
      "Not granted2 of 3",
    )
  })

  it("is one quiet line when everything is granted, and says what to ask for when empty", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    expect(await card()).toHaveTextContent(/No access requested yet/)
    expect(within(await card()).queryByLabelText("Access at a glance")).toBeNull()
  })
})

describe("asking for access", () => {
  it("is added with its owner and system, and shown once the API has confirmed it", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const access = await card()
    await userEvent.click(within(access).getByRole("button", { name: "Request access" }))
    const box = await dialog("Request access")
    await userEvent.type(field(box, "What access is needed"), "Driver hours, read only")
    await userEvent.selectOptions(field(box, "Which system"), "sys_k1")
    await userEvent.selectOptions(field(box, "Who at the customer owns it"), "stk_k2")
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await click(box, "Request access")
    expect(await within(box).findByRole("button", { name: "Saving…" })).toBeDisabled()
    expect(within(access).queryByText("Driver hours, read only")).toBeNull()
    answered()
    await closed()

    expect(wire.sent).toHaveLength(1)
    expect(wire.sent[0]).toMatchObject({
      method: "POST",
      path: `${base(DISPATCH)}/access-requests`,
      body: {
        description: "Driver hours, read only",
        system: "sys_k1",
        owner: "stk_k2",
        status: "requested",
      },
    })
    const row = rowFor(access, "Driver hours, read only")
    expect(row).toHaveTextContent("Owner: Ines Moreau")
    expect(row).toHaveTextContent("Planning database")
    expect(row).toHaveTextContent("Requested, waiting since today")
    expect(within(access).getByLabelText("Access at a glance")).toHaveTextContent(
      "Not granted3 of 4",
    )
    // The button that opened the form is still there: focus returns to it.
    await waitFor(() =>
      expect(within(access).getByRole("button", { name: "Request access" })).toHaveFocus(),
    )
  })

  it("needs words, and says so at the field, for a screen reader and the keyboard", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Request access" }))
    const box = await dialog("Request access")
    await click(box, "Request access")
    const alert = within(box).getByRole("alert")
    expect(alert).toHaveTextContent("Say what access is needed.")
    const what = field(box, "What access is needed")
    expect(what).toHaveAttribute("aria-invalid", "true")
    expect(what.getAttribute("aria-describedby")).toContain(alert.id)
    await waitFor(() => expect(what).toHaveFocus())
    expect(wire.sent).toEqual([])
  })

  it("keeps what was typed when the API refuses, and marks the field it names", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const access = await card()
    await userEvent.click(within(access).getByRole("button", { name: "Request access" }))
    const box = await dialog("Request access")
    await userEvent.type(field(box, "What access is needed"), "Driver hours, read only")
    await userEvent.selectOptions(field(box, "Who at the customer owns it"), "stk_k2")
    wire.refuse = Response.json({ error: "invalid_owner" }, { status: 400 })
    await click(box, "Request access")
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "That person is not a stakeholder at this company.",
    )
    expect(field(box, "Who at the customer owns it")).toHaveAttribute("aria-invalid", "true")
    expect(field(box, "What access is needed")).toHaveValue("Driver hours, read only")
    expect(field(box, "Who at the customer owns it")).toHaveValue("stk_k2")
    expect(within(access).queryByText("Driver hours, read only")).toBeNull()
    // Dialog stays; a second try, accepted, closes it.
    wire.refuse = null
    await click(box, "Request access")
    await closed()
    expect(within(access).getByText("Driver hours, read only")).toBeInTheDocument()
  })

  it("is refused by the API when it starts settled, and the page never sends that", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Request access" }))
    await userEvent.type(field(await dialog("Request access"), "What access is needed"), "Anything")
    await click(await dialog("Request access"), "Request access")
    await closed()
    expect(wire.sent[0]).toMatchObject({ body: { status: "requested" } })
    // The API's own rule, through the same client.
    await expect(
      api.addAccess(DISPATCH, { description: "x", status: "granted" }),
    ).rejects.toMatchObject({ status: 409, code: "rejected_initial_status" })
  })
})

describe("changing an access request", () => {
  it("sends every field of the request, and moves nothing it did not change", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const access = await card()
    await pick(rowFor(access, "Depot rules, read only"), "Edit request")
    const box = await dialog("Edit access request")
    expect(field(box, "What access is needed")).toHaveValue("Depot rules, read only")
    expect(field(box, "Which system")).toHaveValue("sys_k2")
    expect(field(box, "Who at the customer owns it")).toHaveValue("stk_k2")
    await userEvent.selectOptions(field(box, "Who at the customer owns it"), "stk_k3")
    await click(box, "Save")
    await closed()

    expect(wire.sent).toHaveLength(1)
    expect(wire.sent[0]).toMatchObject({
      method: "PUT",
      path: `${base(DISPATCH)}/access-requests/acc_k2`,
      body: {
        description: "Depot rules, read only",
        system: "sys_k2",
        owner: "stk_k3",
        status: "in_progress",
      },
    })
    const row = rowFor(access, "Depot rules, read only")
    expect(row).toHaveTextContent("Owner: Tomas Becker")
    // Focus returns to the row that opened it.
    await waitFor(() => expect(row.querySelector("[data-row]")).toHaveFocus())
  })

  it("sends nothing when nothing changed, so its clock and its event are left alone", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await pick(rowFor(await card(), "Depot rules, read only"), "Edit request")
    await click(await dialog("Edit access request"), "Save")
    await closed()
    expect(wire.sent).toEqual([])
  })

  it("does not undo a status that was moved while the form was open", async () => {
    const view = renderWithRouter(<ProjectPage scope={REFERRALS} />)
    await pick(rowFor(await card(), "Intake form API, staging"), "Edit request")
    const box = await dialog("Edit access request")
    // A teammate marks it in progress, and the page reads it again behind the form.
    await api.updateAccess(REFERRALS, accessId("acc_b2"), {
      description: "Intake form API, staging",
      system: "sys_b1",
      owner: "stk_b2",
      status: "in_progress",
    })
    await view.queryClient.invalidateQueries({ queryKey: queries.project(REFERRALS).queryKey })
    wire.sent = []
    await userEvent.type(field(box, "What access is needed"), " (write too)")
    await click(box, "Save")
    await closed()
    expect(wire.sent[0]).toMatchObject({
      body: { description: "Intake form API, staging (write too)", status: "in_progress" },
    })
  })

  it("keeps the form and says why when the request has gone", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await pick(rowFor(await card(), "Depot rules, read only"), "Edit request")
    const box = await dialog("Edit access request")
    await userEvent.type(field(box, "What access is needed"), "!")
    wire.refuse = Response.json({ error: "not_found" }, { status: 404 })
    await click(box, "Save")
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "The request is no longer there.",
    )
    expect(field(box, "What access is needed")).toHaveValue("Depot rules, read only!")
  })

  it("has no way to remove a request: the API has none", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await pick(rowFor(await card(), "Depot rules, read only"), "Edit request")
    expect(
      within(await dialog("Edit access request")).queryByRole("button", { name: /remove|delete/i }),
    ).toBeNull()
  })
})

describe("moving an access request's status", () => {
  it("offers Today's moves, shows the row moving, and moves it when the API answers", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const access = await card()
    const row = rowFor(access, "Depot rules, read only")
    // Open: granted is the main move, and the rest are in the menu.
    expect(within(row).getByRole("button", { name: /^Mark granted/ })).toBeInTheDocument()
    await userEvent.click(within(row).getByRole("button", { name: /^Actions for/ }))
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
      "Mark denied",
      "Back to requested",
      "Edit request",
    ])
    await userEvent.keyboard("{Escape}")

    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await userEvent.click(within(row).getByRole("button", { name: /^Mark granted/ }))
    await waitFor(() => expect(row).toHaveTextContent("Moving to Granted…"))
    expect(row.querySelector("[data-row]")).toHaveAttribute("aria-busy", "true")
    expect(within(row).getByRole("button", { name: /^Mark granted/ })).toBeDisabled()
    // Not shown as granted until the API says so: still listed above the granted one.
    expect(rowsOf(access)[1]).toHaveTextContent("Depot rules")
    answered()

    await waitFor(() => expect(row).toHaveTextContent(/Granted .* after 6 days/))
    expect(wire.sent[0]).toMatchObject({
      method: "PUT",
      path: `${base(DISPATCH)}/access-requests/acc_k2`,
      body: {
        description: "Depot rules, read only",
        system: "sys_k2",
        owner: "stk_k2",
        status: "granted",
      },
    })
    // Granted rows sort last, and the glance counts only what is left.
    expect(within(access).getByLabelText("Access at a glance")).toHaveTextContent(
      "Not granted1 of 3",
    )
    expect(rowsOf(access).at(-1)).toHaveTextContent("Depot rules, read only")
    // A granted request is not one press from being asked again: its moves are in the menu.
    expect(
      within(rowsOf(access).at(-1)!).queryByRole("button", { name: /^Ask again|^Mark/ }),
    ).toBeNull()
  })

  it("asks again for a refused request, and leaves it where it was when the API refuses", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const access = await card()
    const row = rowFor(access, "Telematics export")
    wire.refuse = Response.json({ error: "forbidden" }, { status: 403 })
    await userEvent.click(within(row).getByRole("button", { name: /^Ask again/ }))
    expect(await within(row).findByRole("alert")).toHaveTextContent(
      "Couldn't change it to Requested. You are not allowed to do that here.",
    )
    expect(row).toHaveTextContent("Denied")
    wire.refuse = null
    await userEvent.click(within(row).getByRole("button", { name: "Dismiss" }))
    expect(within(row).queryByRole("alert")).toBeNull()
    await userEvent.click(within(row).getByRole("button", { name: /^Ask again/ }))
    await waitFor(() => expect(row).toHaveTextContent("Requested, waiting 9 days"))
  })

  it("lets a granted request be revoked, from its menu", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const row = rowFor(await card(), "Read replica of the planning database")
    await pick(row, "Mark revoked")
    await waitFor(() => expect(row).toHaveTextContent(/Revoked .* after 3 days/))
    expect(wire.sent[0]).toMatchObject({ body: { status: "revoked" } })
  })
})

describe("the stage checklist and the tasks that wait", () => {
  it("reads the checklist again after a change here, and its Access item goes", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)
    const list = await screen.findByRole("region", { name: "To leave Access" })
    expect(list).toHaveTextContent("Open: Every access request granted")
    expect(list).toHaveTextContent("2 access requests not granted yet.")
    const access = await card()
    await userEvent.click(
      within(rowFor(access, "Intake form API, staging")).getByRole("button", {
        name: /^Mark granted/,
      }),
    )
    await userEvent.click(
      within(rowFor(access, "Clinic directory export")).getByRole("button", {
        name: /^Mark granted/,
      }),
    )
    await waitFor(() => expect(screen.getByText(/Ready to leave Access/)).toBeInTheDocument())
    expect(screen.getByRole("region", { name: "To leave Access" })).not.toHaveTextContent("Open:")
  })

  it("opens Request access from the checklist when a stale view says none is granted and none was asked", async () => {
    resetMockApi()
    for (const stage of ["scope", "access"] as const) await api.moveStage(CLAIMS, stage, "To test")
    // The API counts no request as met; a view that has not caught up says otherwise.
    wire.refuseReads = {
      ending: "/stage-checklist",
      response: Response.json({
        stage: "access",
        items: [{ key: "access_granted", label: "Every access request granted", met: false }],
      }),
    }
    renderWithRouter(<ProjectPage scope={CLAIMS} />, { keep: true })
    const list = await screen.findByRole("region", { name: "To leave Access" })
    expect(list).toHaveTextContent("No access has been requested yet.")
    await userEvent.click(within(list).getByRole("button", { name: "Request access" }))
    expect(await dialog("Request access")).toBeInTheDocument()
  })

  it("lets Go to Access focus the card", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)
    const list = await screen.findByRole("region", { name: "To leave Access" })
    await userEvent.click(within(list).getByRole("button", { name: "Go to Access" }))
    expect(await card()).toHaveFocus()
  })

  it("chooses the request a task is blocked on, from the project's requests that are not granted", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const board = await screen.findByRole("region", { name: "Board" })
    await userEvent.click(
      within(board).getByRole("button", {
        name: "Actions for Replay last month's orders through the planner",
      }),
    )
    await userEvent.click(await screen.findByRole("menuitem", { name: "Blocked" }))
    const box = await dialog("What is blocking this?")
    await userEvent.type(field(box, "The blocker"), "Needs the depot rules")
    const select = field(box, "Blocked by an access request")
    // Not granted ones only: the granted replica is not a blocker.
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "None, something else",
      "Telematics export (denied)",
      "Depot rules, read only (in progress)",
    ])
    await userEvent.selectOptions(select, "acc_k2")
    await click(box, "Move to Blocked")
    await closed()
    expect(wire.sent[0]).toMatchObject({
      method: "PUT",
      body: {
        status: "blocked",
        blocker: "Needs the depot rules",
        blocked_by: "acc_k2",
      },
    })
    // The request now shows the task that waits on it.
    const access = await card()
    expect(rowFor(access, "Depot rules, read only")).toHaveTextContent(
      "Blocks 1 task: “Replay last month's orders through the planner”",
    )
  })

  it("keeps what a blocked task names when its form is saved, and can clear it", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit Agree the telematics alternative" }),
    )
    const box = await dialog("Edit task")
    expect(field(box, "Blocked by an access request")).toHaveValue("acc_k3")
    await userEvent.selectOptions(field(box, "Blocked by an access request"), "")
    await click(box, "Save")
    await closed()
    expect(wire.sent[0]).toMatchObject({ body: { status: "blocked", blocked_by: null } })
    expect(rowFor(await card(), "Telematics export")).not.toHaveTextContent("Blocks")
  })

  it("offers nothing to choose when the project has no request", async () => {
    resetMockApi()
    renderWithRouter(<ProjectPage scope={CLAIMS} />, { keep: true })
    const board = await screen.findByRole("region", { name: "Board" })
    await userEvent.click(within(board).getByRole("button", { name: "New task" }))
    const box = await dialog("New task")
    await userEvent.selectOptions(field(box, "Status"), "blocked")
    expect(within(box).queryByLabelText("Blocked by an access request")).toBeNull()
    expect(writes()).toEqual([])
  })
})
