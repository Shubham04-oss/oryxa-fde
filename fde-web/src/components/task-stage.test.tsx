import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ProjectPage } from "./project-page"
import { TodayView } from "./today-view"
import { api } from "@/lib/api/client"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

// The API clears a task's `stage` on a save that leaves it out (#238), as it does `criterion`. So every
// way a task is saved sends it back, and the stage survives; clearing it is a choice made in the form.

beforeAll(installWire)
afterEach(resetWire)

const DISPATCH = {
  company: CompanyId.parse("cmp_kestrel"),
  project: ProjectId.parse("prj_kestrel_dispatch"),
}
/** In Build, and works towards crt_k1. */
const REPLAY = "Replay last month's orders through the planner"
/** In Evaluate, and sits below the replay in To do. */
const DRIVER_HOURS = "Add driver-hours checks to the eval suite"

const puts = () => wire.sent.filter((w) => w.method === "PUT" && w.path.includes("/tasks/"))
const posts = () => wire.sent.filter((w) => w.method === "POST" && w.path.endsWith("/tasks"))
const stageOf = async (title: string) =>
  (await api.project(DISPATCH)).tasks.find((t) => t.title === title)?.stage

async function board() {
  renderWithRouter(<ProjectPage scope={DISPATCH} />)
  await screen.findByRole("heading", { name: "Board" })
  await screen.findAllByText("Assigned to you")
}
async function pick(card: string, entry: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${card}` }))
  await userEvent.click(await screen.findByRole("menuitem", { name: entry }))
}

/** Every task saved sent its stage, by name, and the API still has it. */
async function keptStage(title: string, stage: string, saves: number) {
  await waitFor(() => expect(puts()).toHaveLength(saves))
  for (const put of puts()) expect(put.body).toHaveProperty("stage", stage)
  expect(await stageOf(title)).toBe(stage)
}

describe("every task save sends its stage back", () => {
  it("a move to another column, from the card's menu", async () => {
    await board()
    await pick(REPLAY, "In progress")
    await keptStage(REPLAY, "build", 1)
  })

  it("a move within the column", async () => {
    await board()
    await pick(DRIVER_HOURS, "Move up")
    await keptStage(DRIVER_HOURS, "evaluate", 1)
  })

  it("an edit that changes something else", async () => {
    await board()
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const box = await screen.findByRole("dialog", { name: "Edit task" })
    expect(within(box).getByLabelText("Stage")).toHaveValue("build")
    await userEvent.type(within(box).getByLabelText("Title"), ", twice")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await keptStage(`${REPLAY}, twice`, "build", 1)
  })

  it("the Blocked prompt", async () => {
    await board()
    await pick(REPLAY, "Blocked")
    const box = await screen.findByRole("dialog", { name: "What is blocking this?" })
    await userEvent.type(within(box).getByLabelText("The blocker"), "Waiting for a key")
    await userEvent.click(within(box).getByRole("button", { name: "Move to Blocked" }))
    await keptStage(REPLAY, "build", 1)
  })

  it("the Waiting prompt", async () => {
    await board()
    await pick(REPLAY, "Waiting on the customer")
    const box = await screen.findByRole("dialog", { name: "Who is this waiting on?" })
    await userEvent.click(
      within(box).getByRole("button", { name: "Move to Waiting on the customer" }),
    )
    await keptStage(REPLAY, "build", 1)
  })

  it("a row's action on Today", async () => {
    renderWithRouter(<TodayView />)
    await userEvent.click(await screen.findByRole("button", { name: `Done: ${REPLAY}` }))
    await keptStage(REPLAY, "build", 1)
  })

  it("the next step's own form, opened from the top of the project", async () => {
    await board()
    const next = screen.getByRole("region", { name: "Next step" })
    await userEvent.click(
      within(next).getByRole("button", { name: "Load depot rules into the context pack" }),
    )
    const box = await screen.findByRole("dialog", { name: "Edit task" })
    await userEvent.selectOptions(within(box).getByLabelText("Status"), "done")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await keptStage("Load depot rules into the context pack", "build", 1)
  })

  it("and clearing it is a choice made in the form, sent as null", async () => {
    await board()
    await userEvent.click(screen.getByRole("button", { name: `Edit ${REPLAY}` }))
    const box = await screen.findByRole("dialog", { name: "Edit task" })
    await userEvent.selectOptions(within(box).getByLabelText("Stage"), "")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]!.body).toHaveProperty("stage", null)
    expect(await stageOf(REPLAY)).toBeNull()
  })
})

describe("a task's stage on the board", () => {
  it("starts a new task in the project's stage, and the form can set any of the eight", async () => {
    await board()
    await userEvent.click(screen.getByRole("button", { name: "New task" }))
    const box = await screen.findByRole("dialog", { name: "New task" })
    const stage = within(box).getByLabelText("Stage")
    expect(stage).toHaveValue("build")
    expect(
      within(stage)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "No stage",
      "Discover",
      "Scope",
      "Access",
      "Build",
      "Evaluate",
      "Deploy",
      "Handoff",
      "Operate",
    ])
    await userEvent.type(within(box).getByLabelText("Title"), "Book the pilot review")
    await userEvent.selectOptions(stage, "handoff")
    await userEvent.click(within(box).getByRole("button", { name: "Add task" }))
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(posts()[0]!.body).toHaveProperty("stage", "handoff")
    expect(await stageOf("Book the pilot review")).toBe("handoff")
  })

  it("shows it quietly on the card, and says it is the stage to a screen reader", async () => {
    await board()
    const card = screen.getByRole("button", { name: `Edit ${DRIVER_HOURS}` })
    // "Stage:" is for a screen reader; the eye sees "Evaluate · Assigned to Jonah Ade".
    expect(card).toHaveTextContent("Stage: Evaluate · Assigned to Jonah Ade")
    expect(within(card).getByText("Stage:")).toHaveClass("sr-only")
    // A task with no stage says nothing about one.
    const waiting = screen.getByRole("button", { name: "Edit Dispatcher feedback session" })
    expect(waiting.querySelector("[data-stage]")).toBeNull()
  })
})
