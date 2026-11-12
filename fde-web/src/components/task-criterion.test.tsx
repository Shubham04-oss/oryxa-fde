import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ProjectPage } from "./project-page"
import { TodayView } from "./today-view"
import { api } from "@/lib/api/client"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

// The API replaces a task's `criterion` on every save, as it does `assignee`: a save that leaves it
// out unlinks the task (#198). So every way a task is saved sends it back, and the link survives.

beforeAll(installWire)
afterEach(resetWire)

const DISPATCH = {
  company: CompanyId.parse("cmp_kestrel"),
  project: ProjectId.parse("prj_kestrel_dispatch"),
}
/** Works towards crt_k1. */
const REPLAY = "Replay last month's orders through the planner"
/** Works towards crt_k2, and sits below the replay in To do. */
const DRIVER_HOURS = "Add driver-hours checks to the eval suite"

const puts = () => wire.sent.filter((w) => w.method === "PUT" && w.path.includes("/tasks/"))
const criterionOf = async (title: string) =>
  (await api.project(DISPATCH)).tasks.find((t) => t.title === title)?.criterion

async function board() {
  renderWithRouter(<ProjectPage scope={DISPATCH} />)
  await screen.findByRole("heading", { name: "Board" })
  await screen.findAllByText("Assigned to you")
}
async function pick(card: string, entry: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${card}` }))
  await userEvent.click(await screen.findByRole("menuitem", { name: entry }))
}

/** Every task saved sent its criterion, by name, and the API still has the task linked. */
async function keptLinked(title: string, id: string, saves: number) {
  await waitFor(() => expect(puts()).toHaveLength(saves))
  for (const put of puts()) expect(put.body).toHaveProperty("criterion", id)
  expect(await criterionOf(title)).toBe(id)
}

describe("every task save sends its criterion back", () => {
  it("a move to another column, from the card's menu", async () => {
    await board()
    await pick(REPLAY, "In progress")
    await keptLinked(REPLAY, "crt_k1", 1)
  })

  it("a move within the column", async () => {
    await board()
    await pick(DRIVER_HOURS, "Move up")
    await keptLinked(DRIVER_HOURS, "crt_k2", 1)
  })

  it("an edit that changes something else", async () => {
    await board()
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const box = await screen.findByRole("dialog", { name: "Edit task" })
    await userEvent.type(within(box).getByLabelText("Title"), ", twice")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await keptLinked(`${REPLAY}, twice`, "crt_k1", 1)
  })

  it("the Blocked prompt", async () => {
    await board()
    await pick(REPLAY, "Blocked")
    const box = await screen.findByRole("dialog", { name: "What is blocking this?" })
    await userEvent.type(within(box).getByLabelText("The blocker"), "Waiting for a key")
    await userEvent.click(within(box).getByRole("button", { name: "Move to Blocked" }))
    await keptLinked(REPLAY, "crt_k1", 1)
  })

  it("a row's action on Today", async () => {
    renderWithRouter(<TodayView />)
    await userEvent.click(await screen.findByRole("button", { name: `Done: ${REPLAY}` }))
    await keptLinked(REPLAY, "crt_k1", 1)
  })

  it("and unlinking is a choice made in the form, sent as null", async () => {
    await board()
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const box = await screen.findByRole("dialog", { name: "Edit task" })
    await userEvent.selectOptions(within(box).getByLabelText("Works towards"), "")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]!.body).toHaveProperty("criterion", null)
    expect(await criterionOf(REPLAY)).toBeNull()
  })
})
