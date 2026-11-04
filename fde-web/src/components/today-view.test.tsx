import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { TodayView } from "./today-view"
import { renderWithRouter } from "@/test/render"

/** The item titles in a Today group, top to bottom. */
async function titles(group: string) {
  const region = await screen.findByRole("region", { name: group })
  return within(region)
    .queryAllByRole("link")
    .map((link) => link.querySelector("span > span")?.textContent)
}

describe("TodayView", () => {
  it("groups open work across companies into blocked, due and waiting on the customer", async () => {
    renderWithRouter(<TodayView />)

    // Oldest first: a refusal from when it was refused, a blocked task from its last change.
    expect(await titles("Blocked")).toEqual([
      "Access: Telematics export",
      "Roll out to the north depot crews",
      "Agree the telematics alternative",
      "Access: Crew roster export",
      "Staging credentials for the intake API",
    ])
    // Overdue first, then due today; not yet due and done tasks are left out.
    expect(await titles("Due")).toEqual([
      "Map intake form fields",
      "Add driver-hours checks to the eval suite",
      "Replay last month's orders through the planner",
      "Answer the security questionnaire",
      "Publish eval results to the customer room",
      "Monthly accuracy spot check",
    ])
    expect(await titles("Waiting on the customer")).toEqual([
      "Access: Clinic directory export",
      "Access: Mobile device management enrolment",
      "Buyer review of week 3 forecasts",
      "Access: Depot rules, read only",
      "Access: Intake form API, staging",
      "Dispatcher feedback session",
      "Access: Redacted call recordings",
      "Scope sign-off meeting",
      "Interview the claims team lead",
    ])
    expect(screen.queryByText("Load depot rules into the context pack")).toBeNull()
    expect(screen.queryByText("Set up the sandbox with sample orders")).toBeNull()
    expect(screen.queryByText(/Read replica of the planning database/)).toBeNull()
    expect(screen.getByText(/^5 blocked, 6 due and 9 waiting on the customer, across 5/))
  })

  it("files each item once, even when it is also late", async () => {
    renderWithRouter(<TodayView />)

    const all = [
      ...(await titles("Blocked")),
      ...(await titles("Due")),
      ...(await titles("Waiting on the customer")),
    ]
    expect(new Set(all).size).toBe(all.length)
    // Overdue, but waiting on the customer: it is the customer's move, not the FDE's.
    expect(await titles("Waiting on the customer")).toContain("Buyer review of week 3 forecasts")
    expect(await titles("Due")).not.toContain("Buyer review of week 3 forecasts")
  })

  it("says why each item is there", async () => {
    renderWithRouter(<TodayView />)

    const blocked = await screen.findByRole("region", { name: "Blocked" })
    expect(within(blocked).getByText("Denied by Tomas Becker")).toBeInTheDocument()
    expect(within(blocked).getByText("Revoked by Ravi Desai")).toBeInTheDocument()
    expect(
      within(blocked).getByText("Telematics export refused by the customer's security team"),
    ).toBeInTheDocument()
    const due = screen.getByRole("region", { name: "Due" })
    expect(within(due).getByText("Overdue by 3 days")).toBeInTheDocument()
    const waiting = screen.getByRole("region", { name: "Waiting on the customer" })
    expect(within(waiting).getByText("Waiting 11 days on Sana Qureshi")).toBeInTheDocument()
    expect(within(waiting).getByText("Waiting 7 days")).toBeInTheDocument()
  })

  it("opens the project an item belongs to", async () => {
    const { router } = renderWithRouter(<TodayView />)

    await userEvent.click(await screen.findByRole("link", { name: /Map intake form fields/ }))

    expect(router.state.location.pathname).toBe(
      "/companies/cmp_brightwater/projects/prj_bw_referrals",
    )
  })

  it("never claims an all clear when Today cannot be read", async () => {
    renderWithRouter(<TodayView />, { signedIn: false })

    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't load Today.")
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
    expect(screen.queryByText(/Nothing needs you today/)).toBeNull()
  })
})
