import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { ProjectPage } from "./project-page"
import { mockApi } from "@/dev/mock-api"
import { api } from "@/lib/api/client"
import type { ApiError } from "@/lib/api/client"
import { CompanyId, ProjectId, TaskId } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"

// Lets a test hold a write on the wire, or have it refused, before the mock answers. The client
// reads `mockApi.fetch` when it first connects, so this wrapper is in place before any call.
const answer = mockApi.fetch
const wire: { hold: Promise<void> | null; refuse: Response | null } = { hold: null, refuse: null }
mockApi.fetch = async (request) => {
  const write = request.method !== "GET"
  if (write && wire.hold) await wire.hold
  if (write && wire.refuse) return wire.refuse.clone()
  return answer(request)
}
afterEach(() => {
  wire.hold = null
  wire.refuse = null
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

/** Opens a card's menu and picks one entry. */
async function pick(card: string, entry: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${card}` }))
  await userEvent.click(await screen.findByRole("menuitem", { name: entry }))
}

const REPLAY = "Replay last month's orders through the planner"
const TELEMATICS = "Agree the telematics alternative"

describe("Board", () => {
  it("shows a column for each status, each card with who has it and why it is stuck", async () => {
    await board()

    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(
      expect.arrayContaining([
        "To do2",
        "In progress1",
        "Waiting on the customer1",
        "Blocked1",
        "Done1",
      ]),
    )
    // Creation order.
    expect(titles("To do")).toEqual(["Add driver-hours checks to the eval suite", REPLAY])
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

  it("moves a card to Done and drops its blocker", async () => {
    await board()

    await pick(TELEMATICS, "Done")

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

    await waitFor(() => expect(titles("Done")).toContain(REPLAY))
  })

  it("does nothing when a card is dropped on its own column", async () => {
    await board()
    const card = screen.getByRole("button", { name: `Edit ${REPLAY}` }).closest("li")!
    const dataTransfer = { setData: () => {}, effectAllowed: "" }

    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(column("To do"), { dataTransfer })

    expect(screen.queryByText(/^Moving to/)).toBeNull()
    expect(titles("To do")).toContain(REPLAY)
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
      within(column("Waiting on the customer")).getByText("Waiting since today on Ines Moreau"),
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

  it("asks for the blocker when an edit makes a task blocked, and shows the API's refusal", async () => {
    await board()

    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const dialog = await screen.findByRole("dialog", { name: "Edit task" })
    await userEvent.selectOptions(within(dialog).getByLabelText("Status"), "Blocked")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Say what is blocking it.")

    // The API's own rule, if the form ever let it through.
    await expect(
      api.updateTask(scope, TaskId.parse("tsk_k2"), { title: REPLAY, status: "blocked" }),
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
    await expect(api.removeTask(scope, TaskId.parse("tsk_nope"))).rejects.toMatchObject({
      status: 404,
    })
  })
})
