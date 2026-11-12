import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { CompanyPage } from "./company-page"
import { ProjectPage } from "./project-page"
import { TodayView } from "./today-view"
import { api } from "@/lib/api/client"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

// A save is sent with the version of the copy it was based on. When someone else changed the record
// first the API refuses it, and the page never retries and never overwrites: it takes the record as it
// now stands, says so, and lets the person decide (DESIGN.md §3, A stale save). The mock's
// `__fdeMockSomeoneElse` makes someone else change the record between the open and the save.

beforeAll(installWire)
afterEach(() => {
  resetWire()
  delete (globalThis as Record<string, unknown>).__fdeMockSomeoneElse
})

/** Someone else changes the record the next versioned save is about, just before it is checked. */
const someoneElse = (change: Record<string, unknown> | true = true) =>
  ((globalThis as Record<string, unknown>).__fdeMockSomeoneElse = change)

const scopeOf = (company: string, project: string) => ({
  company: CompanyId.parse(company),
  project: ProjectId.parse(project),
})
const DISPATCH = scopeOf("cmp_kestrel", "prj_kestrel_dispatch")
const REFERRALS = scopeOf("cmp_brightwater", "prj_bw_referrals")
const FNOL = scopeOf("cmp_atlas", "prj_atlas_fnol")
const KESTREL = CompanyId.parse("cmp_kestrel")
const REPLAY = "Replay last month's orders through the planner"
const DRIVER_HOURS = "Add driver-hours checks to the eval suite"

const dialog = (name: string) => screen.findByRole("dialog", { name })
const field = (box: HTMLElement, label: string) => within(box).getByLabelText(label)
const click = (box: HTMLElement, name: string) =>
  userEvent.click(within(box).getByRole("button", { name }))
async function fill(box: HTMLElement, label: string, text: string) {
  const input = field(box, label)
  await userEvent.clear(input)
  if (text) await userEvent.type(input, text)
}
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
/** The writes sent, as `METHOD path version`: a create names none. */
const puts = () => wire.sent.filter((w) => w.method === "PUT")
const versionOf = (w: { body: unknown } | undefined) => (w?.body as { version?: number }).version

const column = (name: string) => screen.getByRole("region", { name, hidden: true })
const titles = (name: string) =>
  within(column(name))
    .queryAllByRole("button", { name: /^Edit /, hidden: true })
    .map((b) => b.getAttribute("aria-label")!.slice("Edit ".length))
async function board() {
  renderWithRouter(<ProjectPage scope={DISPATCH} />)
  await screen.findByRole("heading", { name: "Board" })
  await screen.findAllByText("Assigned to you")
}
async function pick(card: string, entry: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${card}` }))
  await userEvent.click(await screen.findByRole("menuitem", { name: entry }))
}
const alert = () => screen.findByRole("alert")

describe("a stale move of a task", () => {
  it("on the board: says the task changed, shows it as it is, and offers the move again on it", async () => {
    await board()
    someoneElse() // moves it to In progress
    await pick(REPLAY, "Done")

    const note = await alert()
    expect(note).toHaveTextContent(
      `“${REPLAY}” changed since you last read it, so it was not moved.`,
    )
    expect(note).toHaveTextContent("It is now In progress.")
    // Nothing was overwritten, and the board shows what is true.
    expect(puts()).toHaveLength(1)
    expect(versionOf(puts()[0])).toBe(1)
    await waitFor(() => expect(titles("In progress")).toContain(REPLAY))
    expect((await api.project(DISPATCH)).tasks.find((t) => t.title === REPLAY)).toMatchObject({
      status: "in_progress",
      version: 2,
    })

    // Moving it again is the person's choice, made on the current task and its version.
    await userEvent.click(within(note).getByRole("button", { name: "Move to Done" }))
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(versionOf(puts()[1])).toBe(2)
    expect(puts()[1]!.body).toMatchObject({ status: "done" })
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
    expect((await api.project(DISPATCH)).tasks.find((t) => t.title === REPLAY)).toMatchObject({
      status: "done",
      version: 3,
    })
  })

  it("on the board: when someone already made the same move it only shows the state", async () => {
    await board()
    someoneElse({ status: "done" })
    await pick(REPLAY, "Done")

    const note = await alert()
    expect(note).toHaveTextContent(`Someone already moved “${REPLAY}” to Done.`)
    expect(within(note).queryByRole("button", { name: /^Move to/ })).toBeNull()
    expect(puts()).toHaveLength(1)
    expect((await api.project(DISPATCH)).tasks.find((t) => t.title === REPLAY)?.version).toBe(2)
  })

  it("within its column: says it changed, and offers the same move again on the current task", async () => {
    await board()
    someoneElse({ due_on: "2027-01-15", status: "todo" })
    await pick(DRIVER_HOURS, "Move up")

    const note = await alert()
    expect(note).toHaveTextContent(
      `“${DRIVER_HOURS}” changed since you last read it, so it was not moved. It is now To do.`,
    )
    // Nothing moved, and the card shows what is true.
    expect(puts()).toHaveLength(1)
    expect(titles("To do")).toEqual([REPLAY, DRIVER_HOURS])
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `Edit ${DRIVER_HOURS}` })).toHaveTextContent(
        /Due in \d+ days/,
      ),
    )

    await userEvent.click(within(note).getByRole("button", { name: "Move it again" }))
    await waitFor(() => expect(titles("To do")).toEqual([DRIVER_HOURS, REPLAY]))
    expect(versionOf(puts()[1])).toBe(2)
    expect(puts()[1]!.body).toMatchObject({
      due_on: "2027-01-15",
      status: "todo",
      before: "tsk_k2",
    })
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })

  it("on Today: the row says it changed and offers the move again", async () => {
    renderWithRouter(<TodayView />)
    await screen.findByRole("region", { name: "Due" })
    someoneElse() // moves it to In progress, so it stays due
    await userEvent.click(await screen.findByRole("button", { name: `Done: ${REPLAY}` }))

    const note = await alert()
    expect(note).toHaveTextContent("This task changed since you last read it, so it was not moved.")
    expect(note).toHaveTextContent("It is now In progress.")
    expect(versionOf(puts()[0])).toBe(1)
    await userEvent.click(within(note).getByRole("button", { name: "Move to Done" }))
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(versionOf(puts()[1])).toBe(2)
    expect(puts()[1]!.body).toMatchObject({ status: "done" })
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })

  it("into Blocked: keeps what was typed, names what changed, and saves on the current version", async () => {
    await board()
    someoneElse({ title: `${REPLAY}, rewritten` })
    await pick(REPLAY, "Blocked")
    const box = await dialog("What is blocking this?")
    await userEvent.type(field(box, "The blocker"), "Waiting for a key")
    await click(box, "Move to Blocked")

    expect(await within(box).findByText(/Someone changed the title/)).toBeInTheDocument()
    expect(field(box, "The blocker")).toHaveValue("Waiting for a key")
    expect(versionOf(puts()[0])).toBe(1)
    await click(box, "Save on the current version")
    await closed()
    expect(versionOf(puts()[1])).toBe(2)
    expect(puts()[1]!.body).toMatchObject({
      title: `${REPLAY}, rewritten`,
      status: "blocked",
      blocker: "Waiting for a key",
    })
  })
})

describe("a stale move of an access request", () => {
  it("on the Access card: says it changed and offers the move again on the current request", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)
    const access = await screen.findByRole("region", { name: "Access" })
    someoneElse() // marks it in progress
    await userEvent.click(
      within(access).getByRole("button", { name: "Mark granted: Intake form API, staging" }),
    )

    const note = await within(access).findByRole("alert")
    expect(note).toHaveTextContent(
      "This request changed since you last read it, so it was not changed.",
    )
    expect(note).toHaveTextContent("It is now In progress.")
    expect(versionOf(puts()[0])).toBe(1)
    // The row shows the request as it is now.
    expect(within(access).getByText("In progress, waiting 5 days")).toBeInTheDocument()

    await userEvent.click(within(note).getByRole("button", { name: "Mark granted" }))
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(versionOf(puts()[1])).toBe(2)
    expect(puts()[1]!.body).toMatchObject({ status: "granted" })
    await waitFor(() => expect(within(access).queryByRole("alert")).toBeNull())
  })

  it("on Today: an access request someone already granted is only shown as it is", async () => {
    renderWithRouter(<TodayView />)
    await screen.findByRole("region", { name: "Waiting on the customer" })
    someoneElse({ status: "granted" })
    await userEvent.click(
      await screen.findByRole("button", { name: "Mark granted: Access: Intake form API, staging" }),
    )
    const note = await alert()
    expect(note).toHaveTextContent("Someone already changed")
    expect(note).toHaveTextContent("to Granted.")
    expect(within(note).queryByRole("button", { name: /^Mark/ })).toBeNull()
    expect(puts()).toHaveLength(1)
  })
})

describe("a stale save of a form", () => {
  it("a task: keeps the typed title, names the status that changed, and saves on top of it", async () => {
    await board()
    someoneElse() // moves it to In progress
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const box = await dialog("Edit task")
    await userEvent.type(field(box, "Title"), " (v2)")
    await click(box, "Save")

    const note = await within(box).findByRole("alert")
    expect(note).toHaveTextContent("This task changed after you opened it, so nothing was saved.")
    expect(note).toHaveTextContent("Someone changed the status. What you typed is still here.")
    expect(note).not.toHaveTextContent("You also changed")
    expect(versionOf(puts()[0])).toBe(1)
    // Nothing was typed away, and the status shows the current one.
    expect(field(box, "Title")).toHaveValue(`${REPLAY} (v2)`)
    expect(field(box, "Status")).toHaveValue("in_progress")
    expect((await api.project(DISPATCH)).tasks.find((t) => t.title === REPLAY)?.status).toBe(
      "in_progress",
    )
    // The page behind the form already shows the task as it is now.
    await waitFor(() => expect(titles("In progress")).toContain(REPLAY))

    await click(box, "Save on the current version")
    await closed()
    expect(versionOf(puts()[1])).toBe(2)
    expect(puts()[1]!.body).toMatchObject({ title: `${REPLAY} (v2)`, status: "in_progress" })
    expect(titles("In progress")).toContain(`${REPLAY} (v2)`)
  })

  it("a task: says so when the person also changed what someone else changed", async () => {
    await board()
    someoneElse({ status: "done" })
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const box = await dialog("Edit task")
    await userEvent.selectOptions(field(box, "Status"), "In progress")
    await click(box, "Save")
    const note = await within(box).findByRole("alert")
    expect(note).toHaveTextContent("Someone changed the status.")
    expect(note).toHaveTextContent("You also changed the status, so yours replaces theirs.")
    // Saving again is a choice: it replaces theirs, on the current version.
    await click(box, "Save on the current version")
    await closed()
    expect(versionOf(puts()[1])).toBe(2)
    expect(puts()[1]!.body).toMatchObject({ status: "in_progress" })
  })

  it("a stakeholder: names the job title that changed and keeps the typed name", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Edit Mara Lindqvist" }))
    const box = await dialog("Edit stakeholder")
    someoneElse()
    await fill(box, "Name", "Mara L. Lindqvist")
    await click(box, "Save")

    const note = await within(box).findByRole("alert")
    expect(note).toHaveTextContent("This stakeholder changed after you opened it")
    expect(note).toHaveTextContent("Someone changed the job title.")
    expect(field(box, "Name")).toHaveValue("Mara L. Lindqvist")
    expect(field(box, "Job title")).toHaveValue("Changed by a teammate")
    expect(versionOf(puts()[0])).toBe(1)

    await click(box, "Save on the current version")
    await closed()
    expect(versionOf(puts()[1])).toBe(2)
    expect(puts()[1]!.body).toMatchObject({
      name: "Mara L. Lindqvist",
      title: "Changed by a teammate",
    })
    expect(
      await screen.findByRole("button", { name: "Edit Mara L. Lindqvist" }),
    ).toBeInTheDocument()
  })

  it("a system: says when both changed the same field, and cancel leaves the current record", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Edit Planning database" }))
    const box = await dialog("Edit system")
    someoneElse()
    await fill(box, "Description", "My own words about it")
    await click(box, "Save")

    const note = await within(box).findByRole("alert")
    expect(note).toHaveTextContent("Someone changed the description.")
    expect(note).toHaveTextContent("You also changed the description, so yours replaces theirs.")
    expect(field(box, "Description")).toHaveValue("My own words about it")
    await click(box, "Cancel")
    await closed()
    // Nothing of theirs was overwritten.
    const system = (await api.company(KESTREL)).systems.find((s) => s.name === "Planning database")
    expect(system).toMatchObject({ description: "Changed by a teammate.", version: 2 })
    expect(puts()).toHaveLength(1)
  })

  it("a scope item: names the description that changed", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: /^Edit: Fraud scoring/ }))
    const box = await dialog("Edit scope item")
    someoneElse()
    await userEvent.selectOptions(field(box, "Listed as"), "In scope")
    await click(box, "Save")
    const note = await within(box).findByRole("alert")
    expect(note).toHaveTextContent("This item changed after you opened it")
    expect(note).toHaveTextContent("Someone changed the description.")
    expect(note).not.toHaveTextContent("You also changed")
    expect(field(box, "Listed as")).toHaveValue("in")
    expect(field(box, "Description")).toHaveValue("Fraud scoring (edited by a teammate)")
    expect(versionOf(puts()[0])).toBe(1)

    await click(box, "Save on the current version")
    await closed()
    expect(versionOf(puts()[1])).toBe(2)
    const item = (await api.scope(FNOL)).items.find((i) => i.id === "itm_a4")
    expect(item).toMatchObject({ kind: "in", description: "Fraud scoring (edited by a teammate)" })
  })

  it("a criterion: names the target that changed and keeps the typed sentence", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(
      await screen.findByRole("button", { name: /^Edit: Calls with every required field/ }),
    )
    const box = await dialog("Edit success criterion")
    someoneElse() // the target moves up by 5
    await fill(box, "What must be true", "Calls captured with every required field")
    await click(box, "Save")
    const note = await within(box).findByRole("alert")
    expect(note).toHaveTextContent("This criterion changed after you opened it")
    expect(note).toHaveTextContent("Someone changed the target.")
    expect(field(box, "What must be true")).toHaveValue("Calls captured with every required field")
    expect(field(box, "Target")).toHaveValue("103")
    expect(versionOf(puts()[0])).toBe(1)

    await click(box, "Save on the current version")
    await closed()
    expect(versionOf(puts()[1])).toBe(2)
    expect(puts()[1]!.body).toMatchObject({
      description: "Calls captured with every required field",
      target: 103,
    })
  })

  it("an access request: names the status that moved, which the form does not show", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)
    const access = await screen.findByRole("region", { name: "Access" })
    const row = within(access)
      .getAllByRole("listitem")
      .find((r) => r.textContent.includes("Intake form API, staging"))!
    await userEvent.click(within(row).getByRole("button", { name: /^Actions for/ }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit request" }))
    const box = await dialog("Edit access request")
    someoneElse() // marks it in progress
    await userEvent.type(field(box, "What access is needed"), " (write too)")
    await click(box, "Save")
    const note = await within(box).findByRole("alert")
    expect(note).toHaveTextContent("This request changed after you opened it")
    expect(note).toHaveTextContent("Someone changed the status.")
    expect(field(box, "What access is needed")).toHaveValue("Intake form API, staging (write too)")
    expect(versionOf(puts()[0])).toBe(1)
    await click(box, "Save on the current version")
    await closed()
    expect(puts()[1]!.body).toMatchObject({
      description: "Intake form API, staging (write too)",
      status: "in_progress",
      version: 2,
    })
  })

  it("a save that is refused for another reason is still the dialog's alert, with no notice", async () => {
    await board()
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const box = await dialog("Edit task")
    wire.refuse = Response.json({ error: "forbidden" }, { status: 403 })
    await click(box, "Save")
    expect(await within(box).findByRole("alert")).toHaveTextContent("You are not allowed")
    expect(box.querySelector("[data-stale]")).toBeNull()
    expect(within(box).getByRole("button", { name: "Save" })).toBeInTheDocument()
  })

  it("a task's other 409 is not mistaken for a stale save", async () => {
    await board()
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const box = await dialog("Edit task")
    // The API's own rule, if the form ever let it through.
    wire.refuse = Response.json({ error: "rejected_blocker_required" }, { status: 409 })
    await click(box, "Save")
    expect(await within(box).findByRole("alert")).toHaveTextContent("Say what is blocking it.")
    expect(box.querySelector("[data-stale]")).toBeNull()
  })

  it("keeps a second stale save apart from the first: it is told again, and still nothing is lost", async () => {
    await board()
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const box = await dialog("Edit task")
    await userEvent.type(field(box, "Title"), " (v2)")
    someoneElse({ due_on: "2030-01-01" })
    await click(box, "Save")
    expect(
      await within(box).findByText(/Someone changed the status and due date/),
    ).toBeInTheDocument()
    // Someone changes it again before the person saves on top.
    someoneElse({ assignee: null })
    await click(box, "Save on the current version")
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(versionOf(puts()[1])).toBe(2)
    expect(
      await within(box).findByText(/Someone changed the status and assignee/),
    ).toBeInTheDocument()
    expect(field(box, "Title")).toHaveValue(`${REPLAY} (v2)`)
    await click(box, "Save on the current version")
    await closed()
    expect(versionOf(puts()[2])).toBe(3)
  })
})

describe("an identical save", () => {
  it("is answered as it is: the version does not move and the form closes", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Edit Mara Lindqvist" }))
    const box = await dialog("Edit stakeholder")
    await click(box, "Save")
    await closed()
    // It was sent, with the version, and the API said nothing changed.
    expect(puts()).toHaveLength(1)
    expect(versionOf(puts()[0])).toBe(1)
    const mara = (await api.company(KESTREL)).stakeholders.find((s) => s.name === "Mara Lindqvist")
    expect(mara?.version).toBe(1)
  })

  it("a task: saving it unchanged leaves its version alone", async () => {
    await board()
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    await click(await dialog("Edit task"), "Save")
    await closed()
    expect(puts()).toHaveLength(1)
    expect((await api.project(DISPATCH)).tasks.find((t) => t.title === REPLAY)?.version).toBe(1)
  })
})

describe("a stale sign-off", () => {
  async function openSignOff() {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(
      within(await screen.findByRole("region", { name: "Scope" })).getByRole("button", {
        name: "Record sign-off",
      }),
    )
    const box = await dialog("Record sign-off")
    await userEvent.selectOptions(field(box, "Signed off by"), "stk_a2")
    return box
  }

  it("shows that the scope changed and what it is now, and needs it read and confirmed again", async () => {
    const box = await openSignOff()
    const read = (await api.scope(FNOL)).version
    someoneElse({ description: "Windscreen claims" })
    wire.sent = []
    await click(box, "Record sign-off")

    const note = await within(box).findByRole("alert", {}, { timeout: 3000 })
    expect(note).toHaveTextContent("The scope changed while this was open, so nothing was signed.")
    // The version it sent was the one that was read; the API refused it.
    expect(wire.sent[0]).toMatchObject({ method: "POST", body: { version: read } })
    expect(note).toHaveTextContent("Added: In scope: Windscreen claims")
    // The scope as it is now is shown to be read, and nothing is signed.
    expect(within(note).getByText("Windscreen claims", { selector: "li" })).toBeInTheDocument()
    expect(within(note).getByText("Home claims by phone")).toBeInTheDocument()
    expect((await api.scope(FNOL)).sign_off).toBeFalsy()
    // The dialog's own sentence is about the scope now.
    expect(box).toHaveTextContent("3 in scope, 2 out of scope, 2 success criteria")

    // Saving again without confirming asks for it, and sends nothing.
    wire.sent = []
    await click(box, "Record sign-off")
    await waitFor(() =>
      expect(
        within(box)
          .getAllByRole("alert")
          .map((a) => a.textContent),
      ).toEqual(expect.arrayContaining([expect.stringContaining("confirm it first.")])),
    )
    expect(wire.sent.filter((w) => w.method === "POST")).toEqual([])
    // The confirmation is the field that problem is about, so it is marked and described by it.
    expect(within(box).getByRole("checkbox")).toHaveAttribute("aria-invalid", "true")
    expect(within(box).getByRole("checkbox")).toHaveAccessibleDescription(/confirm it first\./)

    // Confirmed, it is signed on the version that was shown.
    await userEvent.click(within(box).getByRole("checkbox"))
    await click(box, "Record sign-off")
    await closed()
    const posted = wire.sent.find((w) => w.method === "POST")
    expect(versionOf(posted)).toBe(read + 1)
    expect((await api.scope(FNOL)).sign_off).toMatchObject({
      version: read + 1,
      stakeholder: "stk_a2",
    })
  })

  it("is also caught by the re-read before the sign-off, with the same notice", async () => {
    const box = await openSignOff()
    // A teammate adds something the person has not read.
    await api.addScopeItem(FNOL, { kind: "in", description: "Windscreen claims" })
    wire.sent = []
    await click(box, "Record sign-off")
    const note = await within(box).findByRole("alert")
    expect(note).toHaveTextContent("The scope changed while this was open, so nothing was signed.")
    expect(note).toHaveTextContent("Added: In scope: Windscreen claims")
    expect(wire.sent.filter((w) => w.method === "POST")).toEqual([])
    expect(within(note).getByRole("checkbox")).not.toBeChecked()
  })
})

describe("a create never sends a version", () => {
  it("not a task, stakeholder, system, scope item, criterion or access request", async () => {
    // A new task.
    renderWithRouter(<ProjectPage scope={FNOL} />)
    await userEvent.click(await screen.findByRole("button", { name: "New task" }))
    let box = await dialog("New task")
    await fill(box, "Title", "A new task")
    await click(box, "Add task")
    await closed()

    // A new scope item and a new criterion.
    await userEvent.click(await screen.findByRole("button", { name: "Add in scope" }))
    box = await dialog("Add to scope")
    await fill(box, "Description", "A new item")
    await click(box, "Add")
    await closed()
    await userEvent.click(await screen.findByRole("button", { name: "Add criterion" }))
    box = await dialog("Add success criterion")
    await fill(box, "What must be true", "Something measurable")
    await fill(box, "What is measured", "a thing")
    await fill(box, "Target", "5")
    await click(box, "Add criterion")
    await closed()

    // A new access request.
    await userEvent.click(await screen.findByRole("button", { name: "Request access" }))
    box = await dialog("Request access")
    await fill(box, "What access is needed", "Read the claims queue")
    await click(box, "Request access")
    await closed()

    const created = wire.sent.filter((w) => w.method === "POST")
    expect(created).toHaveLength(4)
    for (const write of created)
      expect(write.body, `${write.path} names no version`).not.toHaveProperty("version")
  })

  it("not a stakeholder or a system", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Add stakeholder" }))
    let box = await dialog("Add stakeholder")
    await fill(box, "Name", "Ines Moreau")
    await click(box, "Add stakeholder")
    await closed()
    await userEvent.click(await screen.findByRole("button", { name: "Add system" }))
    box = await dialog("Add system")
    await fill(box, "Name", "Ticket queue")
    await click(box, "Add system")
    await closed()

    const created = wire.sent.filter((w) => w.method === "POST")
    expect(created).toHaveLength(2)
    for (const write of created) expect(write.body).not.toHaveProperty("version")
    // The API starts a record at version 1.
    const company = await api.company(KESTREL)
    expect(company.stakeholders.find((s) => s.name === "Ines Moreau")?.version).toBe(1)
    expect(company.systems.find((s) => s.name === "Ticket queue")?.version).toBe(1)
  })
})
