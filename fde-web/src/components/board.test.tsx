import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { ProjectPage } from "./project-page"
import { mockApi } from "@/dev/mock-api"
import { api } from "@/lib/api/client"
import type { ApiError } from "@/lib/api/client"
import { CompanyId, ProjectId, TaskId } from "@/lib/api/schemas"
import { fieldsOf, toBody } from "@/lib/board"
import { renderWithRouter } from "@/test/render"

// Lets a test hold a write on the wire, or have it refused, before the mock answers. The client
// reads `mockApi.fetch` when it first connects, so this wrapper is in place before any call.
const answer = mockApi.fetch
const wire: {
  hold: Promise<void> | null
  refuse: Response | null
  /** Holds a read's answer, already taken, so it arrives late with what was true when it was asked. */
  holdReads: Promise<void> | null
  /** The body of every write sent, in order. */
  sent: Array<Record<string, unknown>>
} = { hold: null, refuse: null, holdReads: null, sent: [] }
mockApi.fetch = async (request) => {
  const write = request.method !== "GET"
  if (write) wire.sent.push(JSON.parse((await request.clone().text()) || "null") ?? {})
  if (write && wire.hold) await wire.hold
  if (write && wire.refuse) return wire.refuse.clone()
  const response = await answer(request)
  if (!write && wire.holdReads) await wire.holdReads
  return response
}
afterEach(() => {
  wire.hold = null
  wire.refuse = null
  wire.holdReads = null
  wire.sent = []
})

const scope = {
  company: CompanyId.parse("cmp_kestrel"),
  project: ProjectId.parse("prj_kestrel_dispatch"),
}

async function board() {
  renderWithRouter(<ProjectPage scope={scope} />)
  await screen.findByRole("heading", { name: "Board" })
  // Cards say who has them once the board knows who you are.
  await screen.findAllByText("Assigned to you")
  return screen.getByRole("region", { name: "Board" })
}

// A dialog or menu hides the page behind it from the accessibility tree; the board is still there.
const column = (name: string) => screen.getByRole("region", { name, hidden: true })
const titles = (name: string) =>
  within(column(name))
    .queryAllByRole("button", { name: /^Edit /, hidden: true })
    .map((b) => b.getAttribute("aria-label")!.slice("Edit ".length))

/** Opens the Done column, which starts collapsed. */
async function openDone() {
  await userEvent.click(within(column("Done")).getByRole("button", { name: /^Done/ }))
}

/** Opens a card's menu and picks one entry. */
async function pick(card: string, entry: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${card}` }))
  await userEvent.click(await screen.findByRole("menuitem", { name: entry }))
}

const REPLAY = "Replay last month's orders through the planner"
const TELEMATICS = "Agree the telematics alternative"
const DRIVER_HOURS = "Add driver-hours checks to the eval suite"
const DEPOT_RULES = "Load depot rules into the context pack"
const cardOf = (title: string) =>
  screen.getByRole("button", { name: `Edit ${title}`, hidden: true }).closest("li")!

/**
 * A drag event at height `y`. jsdom has no DragEvent, so it is a mouse event carrying `dataTransfer`,
 * and lays nothing out, so every card's box is at 0 with no height: 0 is its upper half, 1 its lower.
 */
function drag(type: "dragover" | "drop", target: Element, y = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: y })
  Object.defineProperty(event, "dataTransfer", { value: { setData: () => {}, effectAllowed: "" } })
  fireEvent(target, event)
}

describe("Board", () => {
  it("shows a column for each status, each card with who has it and why it is stuck", async () => {
    await board()

    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(
      expect.arrayContaining([
        "To do2",
        "In progress1",
        "Waiting on the customer1",
        "Blocked1",
        "Done6",
      ]),
    )
    // The API's order, not creation order: the replay was made later and sits first.
    expect(titles("To do")).toEqual([REPLAY, DRIVER_HOURS])
    const blocked = column("Blocked")
    expect(within(blocked).getByText(/Telematics export refused/)).toBeInTheDocument()
    expect(within(blocked).getByText("Overdue by 1 day")).toBeInTheDocument()
    expect(
      within(column("Waiting on the customer")).getByText("Waiting 4 days on Mara Lindqvist"),
    ).toBeInTheDocument()
    expect(within(column("To do")).getByText("Due today")).toBeInTheDocument()
    expect(within(column("To do")).getByText("Assigned to a teammate")).toBeInTheDocument()
    expect(within(column("Blocked")).getByText("Assigned to you")).toBeInTheDocument()
  })

  it("moves a card by its menu, and shows it moved only once the API has answered", async () => {
    await board()
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))

    await pick(REPLAY, "In progress")

    // The card stays where it is, marked as moving, until the API confirms.
    expect(titles("To do")).toContain(REPLAY)
    expect(titles("In progress")).not.toContain(REPLAY)
    expect(await screen.findByText("Moving to In progress…")).toBeInTheDocument()
    answered()
    await waitFor(() => expect(titles("In progress")).toContain(REPLAY))
    expect(titles("To do")).not.toContain(REPLAY)
    expect((await api.project(scope)).tasks.find((t) => t.title === REPLAY)?.status).toBe(
      "in_progress",
    )
  })

  it("keeps the first lines of a title clear of the card's menu button", async () => {
    await board()
    // jsdom has no layout: this checks the spacer that floats beside the title's first lines.
    const title = within(screen.getByRole("button", { name: `Edit ${REPLAY}` })).getByText(REPLAY)
    expect(title.querySelector("[data-menu-gap]")).not.toBeNull()
  })

  it("does not open a card that is still moving, so saving cannot undo the move", async () => {
    await board()
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await pick(REPLAY, "In progress")
    await screen.findByText("Moving to In progress…")

    const card = screen.getByRole("button", { name: `Edit ${REPLAY}` })
    expect(card).toHaveAttribute("aria-disabled", "true")
    await userEvent.click(card)
    card.focus()
    await userEvent.keyboard("{Enter}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

    answered()
    await waitFor(() => expect(titles("In progress")).toContain(REPLAY))
    // Once the API has answered, the card opens again, on the new status.
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const dialog = await screen.findByRole("dialog", { name: "Edit task" })
    expect(within(dialog).getByLabelText("Status")).toHaveValue("in_progress")
  })

  it("keeps a confirmed move when a read of the board taken before it arrives after it", async () => {
    const { queryClient } = renderWithRouter(<ProjectPage scope={scope} />)
    await screen.findAllByText("Assigned to you")
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await pick(REPLAY, "In progress")
    await screen.findByText("Moving to In progress…")

    // A refetch (window focus, another tab) reads the board while the move is still on the wire.
    let read = () => {}
    wire.holdReads = new Promise((resolve) => (read = resolve))
    void queryClient.invalidateQueries({ queryKey: ["companies", scope.company] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    answered()
    await waitFor(() => expect(titles("In progress")).toContain(REPLAY))
    read()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(titles("In progress")).toContain(REPLAY)
    expect(titles("To do")).not.toContain(REPLAY)
  })

  it("moves a card to Done and drops its blocker", async () => {
    await board()

    await pick(TELEMATICS, "Done")

    await openDone()
    await waitFor(() => expect(titles("Done")).toContain(TELEMATICS))
    const saved = (await api.project(scope)).tasks.find((t) => t.title === TELEMATICS)
    expect(saved).toMatchObject({ status: "done", blocker: null, blocked_by: null })
  })

  it("moves a card by keyboard alone", async () => {
    await board()

    screen.getByRole("button", { name: `Actions for ${REPLAY}` }).focus()
    await userEvent.keyboard("{Enter}")
    await screen.findByRole("menuitem", { name: "In progress" })
    await userEvent.keyboard("{Enter}")

    await waitFor(() => expect(titles("In progress")).toContain(REPLAY))
  })

  it("moves a card by drag and drop", async () => {
    await board()
    const card = screen.getByRole("button", { name: `Edit ${REPLAY}` }).closest("li")!
    const dataTransfer = { setData: () => {}, effectAllowed: "" }

    fireEvent.dragStart(card, { dataTransfer })
    const target = column("Done")
    fireEvent.dragOver(target, { dataTransfer })
    fireEvent.drop(target, { dataTransfer })

    // Dropped on the collapsed column: it counts there, and shows once the column is opened.
    await waitFor(() =>
      expect(within(column("Done")).getByRole("heading", { level: 3 })).toHaveTextContent("Done7"),
    )
    await openDone()
    expect(titles("Done")).toContain(REPLAY)
  })

  it("does nothing when a card is dropped back where it is", async () => {
    await board()
    const card = cardOf(DRIVER_HOURS)
    const dataTransfer = { setData: () => {}, effectAllowed: "" }

    fireEvent.dragStart(card, { dataTransfer })
    // Over its own card, and below the column's last card, which it already is.
    fireEvent.dragOver(card, { dataTransfer })
    expect(document.querySelector("[data-drop]")).toBeNull()
    fireEvent.dragOver(column("To do"), { dataTransfer })
    expect(document.querySelector("[data-drop]")).toBeNull()
    fireEvent.drop(column("To do"), { dataTransfer })

    expect(screen.queryByText(/^Moving/)).toBeNull()
    expect(wire.sent).toEqual([])
    expect(titles("To do")).toEqual([REPLAY, DRIVER_HOURS])
  })

  it("moves a card to a place in its column by drag and drop, beside the card it lands on", async () => {
    await board()
    const dataTransfer = { setData: () => {}, effectAllowed: "" }

    fireEvent.dragStart(cardOf(DRIVER_HOURS), { dataTransfer })
    drag("dragover", cardOf(REPLAY), 0)
    // The line shows where it would land, above the card.
    expect(cardOf(REPLAY).querySelector("[data-drop]")).toHaveAttribute("data-drop", "before")
    drag("drop", cardOf(REPLAY), 0)

    await waitFor(() => expect(titles("To do")).toEqual([DRIVER_HOURS, REPLAY]))
    expect(wire.sent).toEqual([expect.objectContaining({ status: "todo", before: "tsk_k2" })])
    expect(wire.sent[0]).not.toHaveProperty("after")
    // The API has the same order.
    const tasks = (await api.project(scope)).tasks.filter((t) => t.status === "todo")
    expect(tasks.map((t) => t.title)).toEqual([DRIVER_HOURS, REPLAY])
    expect(
      screen.getByText(`Moved “${DRIVER_HOURS}” above “${REPLAY}”.`, { selector: "[role=status]" }),
    ).toBeInTheDocument()
  })

  it("moves a card into another column at the place it is dropped", async () => {
    await board()
    const dataTransfer = { setData: () => {}, effectAllowed: "" }

    fireEvent.dragStart(cardOf(REPLAY), { dataTransfer })
    // Past the middle of the one card in In progress: below it.
    drag("dragover", cardOf(DEPOT_RULES), 1)
    expect(cardOf(DEPOT_RULES).querySelector("[data-drop]")).toHaveAttribute("data-drop", "after")
    drag("drop", cardOf(DEPOT_RULES), 1)

    await waitFor(() => expect(titles("In progress")).toEqual([DEPOT_RULES, REPLAY]))
    expect(wire.sent).toEqual([expect.objectContaining({ status: "in_progress", after: "tsk_k1" })])
  })

  it("moves a card up and down its column by keyboard, and keeps the focus on it", async () => {
    await board()
    // The top card cannot go up, the bottom one cannot go down, and Done keeps no order of its own.
    await userEvent.click(screen.getByRole("button", { name: `Actions for ${REPLAY}` }))
    expect(await screen.findByRole("menuitem", { name: "Move down" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull()
    await userEvent.keyboard("{Escape}")

    const actions = screen.getByRole("button", { name: `Actions for ${DRIVER_HOURS}` })
    actions.focus()
    await userEvent.keyboard("{Enter}")
    ;(await screen.findByRole("menuitem", { name: "Move up" })).focus()
    expect(screen.queryByRole("menuitem", { name: "Move down" })).toBeNull()
    await userEvent.keyboard("{Enter}")

    await waitFor(() => expect(titles("To do")).toEqual([DRIVER_HOURS, REPLAY]))
    expect(wire.sent).toEqual([expect.objectContaining({ status: "todo", before: "tsk_k2" })])
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `Actions for ${DRIVER_HOURS}` })).toHaveFocus(),
    )

    // And back down, from the same place.
    await userEvent.keyboard("{Enter}")
    ;(await screen.findByRole("menuitem", { name: "Move down" })).focus()
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(titles("To do")).toEqual([REPLAY, DRIVER_HOURS]))
    expect(wire.sent[1]).toMatchObject({ status: "todo", after: "tsk_k2" })
  })

  it("offers no Move up or Move down in Done", async () => {
    await board()
    await openDone()
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Share the pilot plan with the dispatchers" }),
    )
    expect(await screen.findByRole("menuitem", { name: "In progress" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: /^Move (up|down)$/ })).toBeNull()
  })

  it("shows the criterion a task works towards, and links one from the form", async () => {
    await board()
    expect(within(cardOf(REPLAY)).getByText(/^Towards:/)).toHaveTextContent(
      "Towards: Plans dispatchers accept with no changes",
    )
    expect(within(cardOf(TELEMATICS)).queryByText(/^Towards:/)).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: `Edit ${TELEMATICS}` }))
    const box = await screen.findByRole("dialog", { name: "Edit task" })
    const works = within(box).getByLabelText("Works towards")
    expect(works).toHaveValue("")
    await userEvent.selectOptions(works, "Time to a draft plan")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(within(cardOf(TELEMATICS)).getByText(/^Towards:/)).toHaveTextContent(
        "Towards: Time to a draft plan",
      ),
    )
    expect(wire.sent).toEqual([expect.objectContaining({ criterion: "crt_k3" })])
    // It stays in its place: an edit names none.
    expect(wire.sent[0]).not.toHaveProperty("before")
    expect(wire.sent[0]).not.toHaveProperty("after")
  })

  it("asks what blocks a task before moving it to Blocked", async () => {
    await board()

    await pick(REPLAY, "Blocked")

    const dialog = await screen.findByRole("dialog", { name: "What is blocking this?" })
    // Nothing moved yet, and an empty answer is refused without asking the API.
    await userEvent.click(within(dialog).getByRole("button", { name: "Move to Blocked" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Say what is blocking it.")
    expect(titles("To do")).toContain(REPLAY)

    await userEvent.type(within(dialog).getByLabelText("The blocker"), "Waiting for VPN access")
    await userEvent.click(within(dialog).getByRole("button", { name: "Move to Blocked" }))

    await waitFor(() => expect(titles("Blocked")).toContain(REPLAY))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(within(column("Blocked")).getByText("Waiting for VPN access")).toBeInTheDocument()
  })

  it("asks who a task waits on before moving it to Waiting on the customer", async () => {
    await board()

    await pick(REPLAY, "Waiting on the customer")

    const dialog = await screen.findByRole("dialog", { name: "Who is this waiting on?" })
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Waiting on"),
      "Ines Moreau, Dispatch lead, Ghent",
    )
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Move to Waiting on the customer" }),
    )

    await waitFor(() => expect(titles("Waiting on the customer")).toContain(REPLAY))
    expect(
      within(column("Waiting on the customer")).getByText("Waiting less than a day on Ines Moreau"),
    ).toBeInTheDocument()
  })

  it("moves nothing when the prompt is cancelled", async () => {
    await board()

    await pick(REPLAY, "Blocked")
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))

    expect(screen.queryByRole("dialog")).toBeNull()
    expect(titles("To do")).toContain(REPLAY)
  })

  it("leaves a card where it was and says why when the API refuses the move", async () => {
    await board()
    // Someone else deletes it while the board is open, so the API no longer knows it.
    await api.removeTask(scope, TaskId.parse("tsk_k2"))

    await pick(REPLAY, "Done")

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(
      `Couldn't move “${REPLAY}” to Done. The task is no longer there.`,
    )
    expect(titles("Done")).not.toContain(REPLAY)
    expect(screen.queryByText(/^Moving to/)).toBeNull()
    // The board read again, so the card that is gone is gone.
    await waitFor(() => expect(titles("To do")).not.toContain(REPLAY))
  })

  it("shows a failed save when the dev mock is told to fail writes", async () => {
    await board()
    ;(globalThis as Record<string, unknown>).__fdeMockFailWrites = true
    try {
      await pick(REPLAY, "In progress")
      expect(await screen.findByRole("alert")).toHaveTextContent(
        `Couldn't move “${REPLAY}” to In progress. The workspace is briefly unavailable.`,
      )
      expect(titles("To do")).toContain(REPLAY)
    } finally {
      delete (globalThis as Record<string, unknown>).__fdeMockFailWrites
    }
  })

  it("leaves a card where it was and says why when the API is unavailable", async () => {
    await board()
    wire.refuse = Response.json({ error: "unavailable" }, { status: 503 })

    await pick(REPLAY, "In progress")

    expect(await screen.findByRole("alert")).toHaveTextContent(
      `Couldn't move “${REPLAY}” to In progress. The workspace is briefly unavailable. Try again in a minute.`,
    )
    expect(titles("To do")).toContain(REPLAY)
    expect(titles("In progress")).not.toContain(REPLAY)
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("sums up what is stuck above the columns, and each part goes to where it is", async () => {
    await board()
    const summary = screen.getByRole("group", { name: "What needs attention" })
    expect(summary).toHaveTextContent("1 blocked1 waiting on the customer2 overdue")

    await userEvent.click(within(summary).getByRole("button", { name: "1 blocked" }))
    expect(column("Blocked")).toHaveFocus()
    await userEvent.click(
      within(summary).getByRole("button", { name: "1 waiting on the customer" }),
    )
    expect(column("Waiting on the customer")).toHaveFocus()
    // Overdue spans columns: the first late card, in column order.
    await userEvent.click(within(summary).getByRole("button", { name: "2 overdue" }))
    expect(
      screen.getByRole("button", { name: "Edit Add driver-hours checks to the eval suite" }),
    ).toHaveFocus()
  })

  it("updates the summary as work moves, and says so when nothing is stuck", async () => {
    await board()
    await pick(TELEMATICS, "Done")
    await waitFor(() =>
      expect(screen.getByRole("group", { name: "What needs attention" })).toHaveTextContent(
        "1 waiting on the customer1 overdue",
      ),
    )
  })

  it("keeps Done collapsed, and opens it with the latest first and the rest behind Show all", async () => {
    await board()
    // Collapsed: the count shows, the cards do not.
    expect(titles("Done")).toEqual([])
    expect(within(column("Done")).getByRole("button", { name: /^Done/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    )

    await openDone()
    expect(titles("Done")).toEqual([
      "Share the pilot plan with the dispatchers",
      "Run the first planner replay on sample orders",
      "Write the first depot rules summary",
      "Set up the sandbox with sample orders",
      "Pick the two pilot depots",
    ])
    await userEvent.click(screen.getByRole("button", { name: "Show all 6" }))
    expect(titles("Done")).toHaveLength(6)
    expect(titles("Done").at(-1)).toBe("Sign the data processing terms with the customer")
    await userEvent.click(screen.getByRole("button", { name: "Show the latest 5" }))
    expect(titles("Done")).toHaveLength(5)
  })

  it("moves a card into the collapsed Done column by its menu", async () => {
    await board()
    await pick(REPLAY, "Done")
    await waitFor(() =>
      expect(within(column("Done")).getByRole("heading", { level: 3 })).toHaveTextContent("Done7"),
    )
    expect(titles("Done")).toEqual([])
  })

  it("adds a task to To do once the API confirms it", async () => {
    await board()

    await userEvent.click(screen.getByRole("button", { name: "New task" }))
    const dialog = await screen.findByRole("dialog", { name: "New task" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Add task" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Give the task a title.")

    await userEvent.type(within(dialog).getByLabelText("Title"), "Write the depot runbook")
    await userEvent.type(within(dialog).getByLabelText("Due"), "2026-12-01")
    await userEvent.selectOptions(within(dialog).getByLabelText("Assigned to"), "You")
    await userEvent.click(within(dialog).getByRole("button", { name: "Add task" }))

    await waitFor(() => expect(titles("To do")).toContain("Write the depot runbook"))
    // Creation order: the new task is last.
    expect(titles("To do").at(-1)).toBe("Write the depot runbook")
    const saved = (await api.project(scope)).tasks.at(-1)
    expect(saved).toMatchObject({
      title: "Write the depot runbook",
      status: "todo",
      due_on: "2026-12-01",
      assignee: "usr_riya",
    })
  })

  it("edits a task, and keeps what the form did not change", async () => {
    await board()

    await userEvent.click(screen.getByRole("button", { name: `Edit ${TELEMATICS}` }))
    const dialog = await screen.findByRole("dialog", { name: "Edit task" })
    const title = within(dialog).getByLabelText("Title")
    expect(title).toHaveValue(TELEMATICS)
    await userEvent.clear(title)
    await userEvent.type(title, "Agree the GPS alternative")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))

    await waitFor(() => expect(titles("Blocked")).toEqual(["Agree the GPS alternative"]))
    expect(within(column("Blocked")).getByText(/Telematics export refused/)).toBeInTheDocument()
  })

  it("keeps the access request a task is blocked on, and a teammate's assignment, on edit", async () => {
    const { queryClient } = renderWithRouter(<ProjectPage scope={scope} />)
    await screen.findAllByText("Assigned to you")
    const blocked = (await api.project(scope)).tasks.find((t) => t.title === TELEMATICS)!
    await api.updateTask(
      scope,
      blocked.id,
      {
        title: TELEMATICS,
        status: "blocked",
        blocker: blocked.blocker,
        assignee: "usr_jonah",
        blocked_by: "acc_k1",
      },
      blocked.version,
    )
    await queryClient.invalidateQueries()
    await within(column("Blocked")).findByText("Assigned to a teammate")

    await userEvent.click(screen.getByRole("button", { name: `Edit ${TELEMATICS}` }))
    const dialog = await screen.findByRole("dialog", { name: "Edit task" })
    await userEvent.type(within(dialog).getByLabelText("Title"), " now")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))

    await waitFor(() => expect(titles("Blocked")).toEqual([`${TELEMATICS} now`]))
    expect((await api.project(scope)).tasks.find((t) => t.id === blocked.id)).toMatchObject({
      assignee: "usr_jonah",
      blocked_by: "acc_k1",
    })
  })

  it("asks for the blocker when an edit makes a task blocked, and shows the API's refusal", async () => {
    await board()

    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const dialog = await screen.findByRole("dialog", { name: "Edit task" })
    await userEvent.selectOptions(within(dialog).getByLabelText("Status"), "Blocked")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Say what is blocking it.")

    // The API's own rule, if the form ever let it through.
    await expect(
      api.updateTask(scope, TaskId.parse("tsk_k2"), { title: REPLAY, status: "blocked" }, 1),
    ).rejects.toMatchObject({ status: 409, message: "Say what is blocking it." })
  })

  it("keeps a failed edit open, with the reason, and saves nothing", async () => {
    await board()
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const dialog = await screen.findByRole("dialog", { name: "Edit task" })
    await api.removeTask(scope, TaskId.parse("tsk_k2"))

    await userEvent.type(within(dialog).getByLabelText("Title"), " now")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The task is no longer there.",
    )
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("deletes a task only after asking", async () => {
    await board()

    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const dialog = await screen.findByRole("dialog", { name: "Edit task" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete task" }))
    const ask = within(dialog).getByRole("group", { name: "Confirm the delete" })
    await userEvent.click(within(ask).getByRole("button", { name: "Keep it" }))
    expect(titles("To do")).toContain(REPLAY)

    await userEvent.click(within(dialog).getByRole("button", { name: "Delete task" }))
    await userEvent.click(
      within(within(dialog).getByRole("group", { name: "Confirm the delete" })).getByRole(
        "button",
        { name: "Delete" },
      ),
    )

    await waitFor(() => expect(titles("To do")).not.toContain(REPLAY))
    expect((await api.project(scope)).tasks.map((t) => t.title)).not.toContain(REPLAY)
  })

  it("says so when a project has no tasks, and still offers a new one", async () => {
    const { queryClient } = renderWithRouter(<ProjectPage scope={scope} />)
    await screen.findByRole("heading", { name: "Board" })
    for (const task of (await api.project(scope)).tasks) await api.removeTask(scope, task.id)
    await queryClient.invalidateQueries()

    expect(await screen.findByText("No tasks yet. Add the first one.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "New task" })).toBeInTheDocument()
  })
})

describe("the API mock", () => {
  const put = (id: string, body: object) =>
    api.updateTask(scope, TaskId.parse(id), { title: "x", status: "todo", ...body }, 1)

  it("orders tasks as the API does, and a repeated move changes nothing", async () => {
    renderWithRouter(<p />)
    const todo = async () =>
      (await api.project(scope)).tasks.filter((t) => t.status === "todo").map((t) => t.id)
    const replay = (await api.project(scope)).tasks.find((t) => t.id === "tsk_k2")!
    const after = { side: "after" as const, anchor: { ...replay, id: TaskId.parse("tsk_k3") } }
    const fields = fieldsOf(replay)

    const moved = await api.updateTask(scope, replay.id, toBody(fields, after), 1)
    expect(await todo()).toEqual(["tsk_k3", "tsk_k2"])
    expect(moved.version).toBe(2)
    // The same move again: it is already there, so nothing changes, its version included.
    const again = await api.updateTask(scope, replay.id, toBody(fields, after), 2)
    expect(again.version).toBe(2)
    // A save with no place keeps the place; a change of status with none goes to the end.
    await api.updateTask(scope, replay.id, toBody({ ...fields, title: "Renamed" }), 2)
    expect(await todo()).toEqual(["tsk_k3", "tsk_k2"])
    await api.updateTask(scope, TaskId.parse("tsk_k1"), { title: "Back", status: "todo" }, 1)
    expect(await todo()).toEqual(["tsk_k3", "tsk_k2", "tsk_k1"])
  })

  it("refuses a place the API refuses, and a criterion of another project", async () => {
    renderWithRouter(<p />)
    const refused = (id: string, body: object) => put(id, body).catch((e: unknown) => e as ApiError)
    expect(await refused("tsk_k2", { before: "tsk_k3", after: "tsk_k3" })).toMatchObject({
      status: 400,
      code: "invalid_place",
    })
    // Another status, itself, another project's, none at all.
    expect(await refused("tsk_k2", { after: "tsk_k1" })).toMatchObject({ code: "invalid_after" })
    expect(await refused("tsk_k2", { before: "tsk_k2" })).toMatchObject({ code: "invalid_before" })
    expect(await refused("tsk_k2", { after: "tsk_b2" })).toMatchObject({ code: "invalid_after" })
    expect(await refused("tsk_k2", { after: "tsk_nope" })).toMatchObject({ code: "invalid_after" })
    expect(await refused("tsk_k2", { criterion: "crt_b1" })).toMatchObject({
      status: 400,
      code: "invalid_criterion",
    })
  })

  it("lists the tasks linked to a criterion, and unlinks them when it is removed", async () => {
    renderWithRouter(<p />)
    const path = `/api/v1/companies/${scope.company}/projects/${scope.project}/tasks?criterion=crt_k1`
    const linked = await (await mockApi.fetch(new Request(`http://localhost${path}`))).json()
    expect((linked as Array<{ id: string }>).map((t) => t.id)).toEqual(["tsk_k2", "tsk_k10"])

    await api.removeCriterion(scope, "crt_k1" as never)
    const tasks = (await api.project(scope)).tasks
    expect(tasks.find((t) => t.id === "tsk_k2")).toMatchObject({ criterion: null, version: 2 })
    expect(tasks.find((t) => t.id === "tsk_k1")).toMatchObject({ criterion: "crt_k2", version: 1 })
  })

  it("refuses what the API refuses on a task", async () => {
    renderWithRouter(<p />)
    const body = { title: "x", status: "todo" as const }
    const refused = (over: object) =>
      api.addTask(scope, { ...body, ...over }).catch((e: unknown) => e as ApiError)

    expect(await refused({ title: " " })).toMatchObject({ status: 400, code: "invalid_title" })
    expect(await refused({ due_on: "soon" })).toMatchObject({ code: "invalid_due_on" })
    expect(await refused({ assignee: "usr_nobody" })).toMatchObject({ code: "invalid_assignee" })
    expect(
      await refused({ status: "waiting_on_customer", waiting_on: "stk_nobody" }),
    ).toMatchObject({
      code: "invalid_waiting_on",
    })
    expect(await refused({ blocked_by: "acc_k1" })).toMatchObject({
      status: 409,
      code: "rejected_blocked_by_needs_blocked",
    })
    // Only one of this project's own access requests: not a missing one, not another company's.
    const blocked = { status: "blocked" as const, blocker: "Waiting on access" }
    expect(await refused({ ...blocked, blocked_by: "acc_nobody" })).toMatchObject({
      status: 400,
      code: "invalid_blocked_by",
    })
    expect(await refused({ ...blocked, blocked_by: "acc_b1" })).toMatchObject({
      status: 400,
      code: "invalid_blocked_by",
    })
    await expect(api.removeTask(scope, TaskId.parse("tsk_nope"))).rejects.toMatchObject({
      status: 404,
    })
  })
})
