import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ProjectPage } from "./project-page"
import { api } from "@/lib/api/client"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import { resetMockApi } from "@/dev/mock-api"
import { fieldsOf, toBody } from "@/lib/board"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

// A project's next step is the first thing on its page (direction §4, #244): the API's `next_step`, with
// who has it and when it is due, or a plain "No next step yet" with the one action that gives it one.

beforeAll(installWire)
afterEach(resetWire)

const DISPATCH = {
  company: CompanyId.parse("cmp_kestrel"),
  project: ProjectId.parse("prj_kestrel_dispatch"),
}
/** Operate, with every task done: no next step. */
const OUTAGE = {
  company: CompanyId.parse("cmp_cobalt"),
  project: ProjectId.parse("prj_cobalt_outage"),
}
const FIRST = "Load depot rules into the context pack"

const nextStep = () => screen.findByRole("region", { name: "Next step" })

describe("the next step", () => {
  it("comes first on the page: the task, who has it and when it is due", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const next = await nextStep()
    expect(within(next).getByRole("button", { name: FIRST })).toBeInTheDocument()
    await waitFor(() => expect(next).toHaveTextContent("Assigned to you"))
    expect(next).toHaveTextContent(/Due (today|tomorrow|in \d+ days)|Overdue/)
    // Before the stage bar, the checklist and the board.
    const board = screen.getByRole("region", { name: "Board" })
    expect(next.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Nothing on it is the page's main action while there is a next step.
    expect(within(next).queryByRole("button", { name: "Add a task" })).toBeNull()
  })

  it("opens the task's own form, as its card does", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(within(await nextStep()).getByRole("button", { name: FIRST }))
    const box = await screen.findByRole("dialog", { name: "Edit task" })
    expect(within(box).getByLabelText("Title")).toHaveValue(FIRST)
  })

  it("moves on when its task is done, without reading the whole project again", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const next = await nextStep()
    await userEvent.click(screen.getByRole("button", { name: `Actions for ${FIRST}` }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Done" }))
    await waitFor(() =>
      expect(
        within(next).getByRole("button", {
          name: "Replay last month's orders through the planner",
        }),
      ).toBeInTheDocument(),
    )
  })

  it("says when there is no date or no one has it, rather than leave a gap", async () => {
    resetMockApi()
    const p = await api.project(DISPATCH)
    const first = p.tasks[0]!
    await api.updateTask(
      DISPATCH,
      first.id,
      { ...toBody(fieldsOf(first)), assignee: null, due_on: null },
      first.version,
    )
    renderWithRouter(<ProjectPage scope={DISPATCH} />, { keep: true })
    const next = await nextStep()
    expect(next).toHaveTextContent("Unassigned")
    expect(next).toHaveTextContent("No due date")
  })

  it("shows the title as text, never as markup", async () => {
    resetMockApi()
    const p = await api.project(DISPATCH)
    const first = p.tasks[0]!
    await api.updateTask(
      DISPATCH,
      first.id,
      { ...toBody(fieldsOf(first)), title: "<b>Call</b> **Mara**" },
      first.version,
    )
    renderWithRouter(<ProjectPage scope={DISPATCH} />, { keep: true })
    const next = await nextStep()
    expect(within(next).getByRole("button", { name: "<b>Call</b> **Mara**" })).toBeInTheDocument()
    expect(next.querySelector("b")).toBeNull()
  })
})

describe("no next step", () => {
  it("says so plainly, with one action: add a task", async () => {
    renderWithRouter(<ProjectPage scope={OUTAGE} />)
    const next = await nextStep()
    expect(within(next).getByText("No next step yet")).toBeInTheDocument()
    await userEvent.click(within(next).getByRole("button", { name: "Add a task" }))
    const box = await screen.findByRole("dialog", { name: "New task" })
    // A new task starts in the project's stage.
    expect(within(box).getByLabelText("Stage")).toHaveValue("operate")
    await userEvent.type(within(box).getByLabelText("Title"), "Plan the quarterly review")
    await userEvent.click(within(box).getByRole("button", { name: "Add task" }))
    await waitFor(() =>
      expect(
        within(next).getByRole("button", { name: "Plan the quarterly review" }),
      ).toBeInTheDocument(),
    )
    expect(wire.sent.filter((w) => w.method === "POST")).toHaveLength(1)
  })

  it("opens New task straight away when Today sent the FDE here to add one", async () => {
    renderWithRouter(<ProjectPage scope={OUTAGE} addTask />)
    expect(await screen.findByRole("dialog", { name: "New task" })).toBeInTheDocument()
  })
})
