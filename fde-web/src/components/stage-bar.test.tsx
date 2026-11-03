import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ProjectPage } from "./project-page"
import { StageBar } from "./stage-bar"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import type { Stage } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"

function renderBar(stage: Stage) {
  const onMove = vi.fn()
  render(<StageBar stage={stage} onMove={onMove} moving={false} error={null} />)
  return onMove
}

/** The stages offered as moves, by accessible name. */
const offered = () =>
  screen
    .getAllByRole("button")
    .filter((button) => !(button as HTMLButtonElement).disabled)
    .map((button) => button.getAttribute("aria-label"))

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
    const confirm = screen.getByRole("group", { name: "Confirm the move" })
    expect(confirm).toHaveTextContent("Move this project to Evaluate?")
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }))
    expect(onMove).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: "Move back to Scope" }))
    expect(screen.getByRole("group")).toHaveTextContent(
      "Move this project back to Scope for rework?",
    )
    await userEvent.click(screen.getByRole("button", { name: "Move back" }))
    expect(onMove).toHaveBeenCalledExactlyOnceWith("scope")
    expect(screen.queryByRole("group")).toBeNull()
  })

  it("moves a project on the API and shows its new stage", async () => {
    const scope = {
      company: CompanyId.parse("cmp_brightwater"),
      project: ProjectId.parse("prj_bw_referrals"),
    }
    renderWithRouter(<ProjectPage scope={scope} />)

    await userEvent.click(await screen.findByRole("button", { name: "Move to Build" }))
    await userEvent.click(screen.getByRole("button", { name: "Move" }))

    await waitFor(() =>
      expect(screen.getByText("Build").closest("[aria-current]")).toHaveAttribute(
        "aria-current",
        "step",
      ),
    )
    expect(screen.getByRole("button", { name: "Move to Evaluate" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Move back to Access" })).toBeEnabled()
  })
})
