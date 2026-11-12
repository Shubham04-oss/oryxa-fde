import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ProjectPage } from "./project-page"
import { StageBar } from "./stage-bar"
import type { MoveRefusal } from "./stage-bar"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import type { ChecklistItem, Stage } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

beforeAll(installWire)
afterEach(resetWire)

const item = (key: string, label: string): ChecklistItem => ({ key, label, met: false })
const SIGNED = item("scope_signed_off", "Scope signed off, and unchanged since")
const OUT = item("out_of_scope_listed", "What is out of scope is listed")

function renderBar(
  stage: Stage,
  open: Array<ChecklistItem> = [],
  answer: MoveRefusal | null = null,
) {
  const onMove = vi.fn<(to: Stage, reason?: string) => Promise<MoveRefusal | null>>(() =>
    Promise.resolve(answer),
  )
  render(<StageBar stage={stage} open={open} onMove={onMove} />)
  return onMove
}

/** The stages offered as moves, by accessible name. */
const offered = () =>
  screen
    .getAllByRole("button")
    .filter((button) => !(button as HTMLButtonElement).disabled)
    .map((button) => button.getAttribute("aria-label"))

const confirmation = () => screen.getByRole("group", { name: "Confirm the move" })
const reasonField = () => within(confirmation()).getByLabelText(/Why are you moving on/)

describe("StageBar", () => {
  it("offers the next stage and every earlier one, and nothing beyond the next", () => {
    renderBar("access")

    expect(screen.getByText("Access").closest("[aria-current]")).toHaveAttribute(
      "aria-current",
      "step",
    )
    expect(offered()).toEqual(["Move back to Discover", "Move back to Scope", "Move to Build"])
    for (const later of ["Evaluate", "Deploy", "Handoff", "Operate"])
      expect(
        screen.getByRole("button", { name: `${later}, not yet: stages advance one at a time` }),
      ).toBeDisabled()
  })

  it("offers only the next stage from the first, and only rework from the last", () => {
    renderBar("discover")
    expect(offered()).toEqual(["Move to Scope"])
  })

  it("offers only rework from the last stage", () => {
    renderBar("operate")
    expect(offered()).toEqual([
      "Move back to Discover",
      "Move back to Scope",
      "Move back to Access",
      "Move back to Build",
      "Move back to Evaluate",
      "Move back to Deploy",
      "Move back to Handoff",
    ])
  })

  it("asks before moving, and Cancel moves nothing", async () => {
    const onMove = renderBar("build")

    await userEvent.click(screen.getByRole("button", { name: "Move to Evaluate" }))
    expect(confirmation()).toHaveTextContent("Move this project to Evaluate?")
    await userEvent.click(within(confirmation()).getByRole("button", { name: "Cancel" }))
    expect(onMove).not.toHaveBeenCalled()
    expect(screen.queryByRole("group")).toBeNull()
  })

  it("moves forward with nothing open without asking for a reason", async () => {
    const onMove = renderBar("build")
    await userEvent.click(screen.getByRole("button", { name: "Move to Evaluate" }))
    expect(within(confirmation()).queryByLabelText(/Why are you moving on/)).toBeNull()
    await userEvent.click(within(confirmation()).getByRole("button", { name: "Move" }))
    expect(onMove).toHaveBeenCalledExactlyOnceWith("evaluate", undefined)
    await waitFor(() => expect(screen.queryByRole("group")).toBeNull())
  })

  it("keeps the confirmation open while the API has not answered, and says so", async () => {
    let answered: (value: MoveRefusal | null) => void = () => {}
    const onMove = vi.fn(() => new Promise<MoveRefusal | null>((resolve) => (answered = resolve)))
    render(<StageBar stage="build" open={[]} onMove={onMove} />)
    await userEvent.click(screen.getByRole("button", { name: "Move to Evaluate" }))
    await userEvent.click(within(confirmation()).getByRole("button", { name: "Move" }))
    expect(within(confirmation()).getByRole("button", { name: "Moving…" })).toBeDisabled()
    answered(null)
    await waitFor(() => expect(screen.queryByRole("group")).toBeNull())
  })

  it("moves back for rework without asking for a reason, even with items open", async () => {
    const onMove = renderBar("scope", [SIGNED, OUT])

    await userEvent.click(screen.getByRole("button", { name: "Move back to Discover" }))
    expect(confirmation()).toHaveTextContent("Move this project back to Discover for rework?")
    expect(within(confirmation()).queryByLabelText(/Why are you moving on/)).toBeNull()
    expect(confirmation()).not.toHaveTextContent("still open")
    await userEvent.click(within(confirmation()).getByRole("button", { name: "Move back" }))
    expect(onMove).toHaveBeenCalledExactlyOnceWith("discover", undefined)
  })

  describe("with items open", () => {
    it("lists them, asks for a reason, and says it is recorded", async () => {
      renderBar("scope", [SIGNED, OUT])
      await userEvent.click(screen.getByRole("button", { name: "Move to Access" }))

      const box = confirmation()
      expect(box).toHaveTextContent("2 items are still open on Scope:")
      expect(within(box).getByText("Scope signed off, and unchanged since")).toBeInTheDocument()
      expect(within(box).getByText("What is out of scope is listed")).toBeInTheDocument()
      expect(box).toHaveTextContent("Your reason is recorded in the audit log")
      expect(box).toHaveTextContent("0 / 500")
      expect(reasonField()).toHaveFocus()
      expect(within(box).getByRole("button", { name: "Move with items open" })).toBeInTheDocument()
    })

    it("says '1 item' for one", async () => {
      renderBar("scope", [OUT])
      await userEvent.click(screen.getByRole("button", { name: "Move to Access" }))
      expect(confirmation()).toHaveTextContent("1 item is still open on Scope:")
    })

    it("sends nothing without a reason, and says why, until one is given", async () => {
      const onMove = renderBar("scope", [OUT])
      await userEvent.click(screen.getByRole("button", { name: "Move to Access" }))
      await userEvent.click(screen.getByRole("button", { name: "Move with items open" }))
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Say why you are moving on with items open.",
      )
      expect(onMove).not.toHaveBeenCalled()

      // Spaces are no reason: the API trims.
      await userEvent.type(reasonField(), "   ")
      expect(screen.getByRole("alert")).toHaveTextContent("Say why")

      await userEvent.type(reasonField(), "  The customer will list it in the kickoff.  ")
      expect(screen.queryByRole("alert")).toBeNull()
      await userEvent.click(screen.getByRole("button", { name: "Move with items open" }))
      expect(onMove).toHaveBeenCalledExactlyOnceWith(
        "access",
        "The customer will list it in the kickoff.",
      )
    })

    it("counts characters against 500, and refuses more", async () => {
      const onMove = renderBar("scope", [OUT])
      await userEvent.click(screen.getByRole("button", { name: "Move to Access" }))
      await userEvent.click(reasonField())
      await userEvent.paste("a".repeat(500))
      expect(confirmation()).toHaveTextContent("500 / 500")
      expect(screen.queryByRole("alert")).toBeNull()

      await userEvent.paste("b")
      expect(confirmation()).toHaveTextContent("501 / 500")
      await userEvent.click(screen.getByRole("button", { name: "Move with items open" }))
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Keep the reason to 500 characters or fewer.",
      )
      expect(onMove).not.toHaveBeenCalled()
    })

    it("ties its note and its error to the field, and says the count once typing pauses", async () => {
      renderBar("scope", [OUT])
      await userEvent.click(screen.getByRole("button", { name: "Move to Access" }))
      expect(reasonField()).toHaveAccessibleDescription(/recorded in the audit log/)
      await userEvent.click(screen.getByRole("button", { name: "Move with items open" }))
      expect(reasonField()).toHaveAccessibleDescription(/Say why you are moving on with items open/)

      await userEvent.type(reasonField(), "Because")
      const heard = await screen.findByText("7 of 500 characters")
      expect(heard).toHaveAttribute("aria-live", "polite")
      expect(reasonField()).not.toHaveAccessibleDescription(/Say why/)
    })

    it("keeps the reason and shows why when the move fails", async () => {
      const onMove = renderBar("scope", [OUT], {
        error: "The reason is plain text, 1 to 500 characters.",
      })
      await userEvent.click(screen.getByRole("button", { name: "Move to Access" }))
      await userEvent.type(reasonField(), "Because")
      await userEvent.click(screen.getByRole("button", { name: "Move with items open" }))

      expect(await screen.findByRole("alert")).toHaveTextContent("1 to 500 characters")
      expect(onMove).toHaveBeenCalledTimes(1)
      expect(reasonField()).toHaveValue("Because")
      expect(screen.getByRole("button", { name: "Move with items open" })).toBeEnabled()
    })
  })

  describe("when the page's view was stale", () => {
    it("shows the items the API found and asks for a reason then", async () => {
      const onMove = renderBar("scope", [])
      onMove.mockResolvedValueOnce({ open: [SIGNED] })
      await userEvent.click(screen.getByRole("button", { name: "Move to Access" }))
      // Nothing was open as far as the page knew: no reason is asked at first.
      expect(within(confirmation()).queryByLabelText(/Why are you moving on/)).toBeNull()
      await userEvent.click(within(confirmation()).getByRole("button", { name: "Move" }))

      await waitFor(() =>
        expect(confirmation()).toHaveTextContent("1 item is still open on Scope:"),
      )
      expect(within(confirmation()).getByText(SIGNED.label)).toBeInTheDocument()
      expect(onMove).toHaveBeenCalledTimes(1)
      expect(reasonField()).toHaveFocus()
      expect(screen.queryByRole("alert")).toBeNull()

      await userEvent.type(reasonField(), "Signing is booked for Monday")
      await userEvent.click(screen.getByRole("button", { name: "Move with items open" }))
      expect(onMove).toHaveBeenLastCalledWith("access", "Signing is booked for Monday")
    })

    it("still asks when the API refuses for open items it did not name", async () => {
      renderBar("scope", [], { open: [] })
      await userEvent.click(screen.getByRole("button", { name: "Move to Access" }))
      await userEvent.click(within(confirmation()).getByRole("button", { name: "Move" }))
      await waitFor(() => expect(reasonField()).toBeInTheDocument())
      expect(confirmation()).toHaveTextContent("Items are still open on Scope.")
    })
  })
})

const scopeOf = (company: string, project: string) => ({
  company: CompanyId.parse(company),
  project: ProjectId.parse(project),
})
/** Build, with an eval suite on every criterion: nothing open. */
const DISPATCH = scopeOf("cmp_kestrel", "prj_kestrel_dispatch")
/** Access, with two requests not granted. */
const REFERRALS = scopeOf("cmp_brightwater", "prj_bw_referrals")
const stagePut = () => wire.sent.filter((w) => w.method === "PUT" && w.path.endsWith("/stage"))
const current = (name: string) =>
  expect(
    within(screen.getByRole("region", { name: "Stage" }))
      .getByText(name)
      .closest("[aria-current]"),
  ).toHaveAttribute("aria-current", "step")

describe("moving a project's stage on the API", () => {
  it("goes straight through when everything is met, with no reason sent", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)

    await userEvent.click(await screen.findByRole("button", { name: "Move to Evaluate" }))
    expect(within(confirmation()).queryByLabelText(/Why are you moving on/)).toBeNull()
    await userEvent.click(within(confirmation()).getByRole("button", { name: "Move" }))

    await waitFor(() => current("Evaluate"))
    expect(stagePut().map((w) => w.body)).toEqual([{ stage: "evaluate" }])
    expect(screen.getByRole("button", { name: "Move to Deploy" })).toBeEnabled()
  })

  it("asks for a reason with items open, sends it, and then shows the new stage's checklist", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)
    const checklist = await screen.findByRole("region", { name: "To leave Access" })
    expect(within(checklist).getByText("Every access request granted")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Move to Build" }))
    expect(confirmation()).toHaveTextContent("1 item is still open on Access:")
    expect(within(confirmation()).getByText("Every access request granted")).toBeInTheDocument()
    await userEvent.type(reasonField(), "  Synthetic data only until the runner exists  ")
    await userEvent.click(screen.getByRole("button", { name: "Move with items open" }))

    await waitFor(() => current("Build"))
    expect(stagePut().map((w) => w.body)).toEqual([
      { stage: "build", reason: "Synthetic data only until the runner exists" },
    ])
    // The checklist is Build's now: it was read again after the move.
    expect(await screen.findByRole("region", { name: "To leave Build" })).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "To leave Access" })).toBeNull()
  })

  it("never asks for a reason, or sends one, when moving back", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)

    await userEvent.click(await screen.findByRole("button", { name: "Move back to Scope" }))
    expect(within(confirmation()).queryByLabelText(/Why are you moving on/)).toBeNull()
    await userEvent.click(within(confirmation()).getByRole("button", { name: "Move back" }))

    await waitFor(() => current("Scope"))
    expect(stagePut().map((w) => w.body)).toEqual([{ stage: "scope" }])
  })

  it("shows the items the API found when the page thought none were open, and asks then", async () => {
    // The page reads Build as ready to leave...
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await screen.findByText(/Ready to leave Build/)
    // ...and then a teammate adds a criterion that no eval suite measures yet.
    const { api } = await import("@/lib/api/client")
    await api.addCriterion(DISPATCH, {
      description: "Plans that arrive before the first pick",
      metric: "plans on time",
      comparator: "at_least",
      target: 95,
      unit: "%",
      baseline: null,
      proof: null,
    })

    await userEvent.click(screen.getByRole("button", { name: "Move to Evaluate" }))
    await userEvent.click(within(confirmation()).getByRole("button", { name: "Move" }))

    // The API said 409 with the open item: it is shown, and the reason is asked for now.
    await waitFor(() => expect(confirmation()).toHaveTextContent("1 item is still open on Build:"))
    expect(
      within(confirmation()).getByText("An eval suite measures every criterion"),
    ).toBeInTheDocument()
    current("Build")
    expect(stagePut().map((w) => w.body)).toEqual([{ stage: "evaluate" }])

    await userEvent.type(reasonField(), "The new criterion is measured by hand for now")
    await userEvent.click(screen.getByRole("button", { name: "Move with items open" }))
    await waitFor(() => current("Evaluate"))
    expect(stagePut().map((w) => w.body)).toEqual([
      { stage: "evaluate" },
      { stage: "evaluate", reason: "The new criterion is measured by hand for now" },
    ])
  })

  it("shows the open items when the page's read of the checklist was stale, without a teammate's change", async () => {
    // The dev mock's switch: every item reads as met, while the move is judged on the records.
    ;(globalThis as Record<string, unknown>).__fdeMockStaleChecklist = true
    try {
      renderWithRouter(<ProjectPage scope={REFERRALS} />)
      await screen.findByText(/Ready to leave Access/)
      await userEvent.click(screen.getByRole("button", { name: "Move to Build" }))
      await userEvent.click(within(confirmation()).getByRole("button", { name: "Move" }))
      await waitFor(() =>
        expect(confirmation()).toHaveTextContent("1 item is still open on Access:"),
      )
      expect(within(confirmation()).getByText("Every access request granted")).toBeInTheDocument()
      expect(reasonField()).toHaveFocus()
    } finally {
      delete (globalThis as Record<string, unknown>).__fdeMockStaleChecklist
    }
  })

  it("says in plain words that the API refused the reason, and keeps what was typed", async () => {
    renderWithRouter(<ProjectPage scope={REFERRALS} />)
    await userEvent.click(await screen.findByRole("button", { name: "Move to Build" }))
    await userEvent.type(reasonField(), "ok")
    wire.refuse = Response.json({ error: "invalid_reason" }, { status: 400 })
    await userEvent.click(screen.getByRole("button", { name: "Move with items open" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The reason is plain text, 1 to 500 characters.",
    )
    expect(reasonField()).toHaveValue("ok")
    current("Access")
  })

  it("says in plain words that items are open when the API refuses without naming them", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(await screen.findByRole("button", { name: "Move to Evaluate" }))
    wire.refuse = Response.json({ error: "rejected_checklist_open" }, { status: 409 })
    await userEvent.click(within(confirmation()).getByRole("button", { name: "Move" }))
    await waitFor(() => expect(reasonField()).toBeInTheDocument())
    expect(confirmation()).toHaveTextContent("Items are still open on Build.")
  })

  it("never claims a move before the API confirms it", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(await screen.findByRole("button", { name: "Move to Evaluate" }))
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await userEvent.click(within(confirmation()).getByRole("button", { name: "Move" }))
    expect(await within(confirmation()).findByRole("button", { name: "Moving…" })).toBeDisabled()
    current("Build")
    answered()
    await waitFor(() => current("Evaluate"))
  })
})
