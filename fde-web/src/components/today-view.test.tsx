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
  it("groups open work across companies into blocked and waiting on the customer", async () => {
    renderWithRouter(<TodayView />)

    // Oldest first: a refusal from when it was refused, a task from its last change.
    expect(await titles("Blocked")).toEqual([
      "Access: Telematics export",
      "Roll out to the north depot crews",
      "Agree the telematics alternative",
      "Access: Crew roster export",
      "Staging credentials for the intake API",
    ])
    expect(await titles("Waiting on the customer")).toEqual([
      "Access: Clinic directory export",
      "Access: Mobile device management enrolment",
      "Buyer review of week 3 forecasts",
      "Access: Depot rules, read only",
      "Access: Intake form API, staging",
      "Dispatcher feedback session",
      "Access: Redacted call recordings",
      "Interview the claims team lead",
      "Scope sign-off meeting",
    ])
    // Open work that is the FDE's own move, done tasks and granted access are left out.
    expect(screen.queryByText("Load depot rules into the context pack")).toBeNull()
    expect(screen.queryByText("Set up the sandbox with sample orders")).toBeNull()
    expect(screen.queryByText(/Read replica of the planning database/)).toBeNull()
    expect(screen.getByText(/^5 blocked and 9 waiting on the customer, across 5 companies/))
  })

  it("files each item once", async () => {
    renderWithRouter(<TodayView />)

    const all = [...(await titles("Blocked")), ...(await titles("Waiting on the customer"))]
    expect(new Set(all).size).toBe(all.length)
  })

  it("says why each item is there", async () => {
    renderWithRouter(<TodayView />)

    const blocked = await screen.findByRole("region", { name: "Blocked" })
    expect(within(blocked).getByText("Denied by Tomas Becker")).toBeInTheDocument()
    expect(within(blocked).getByText("Revoked by Ravi Desai")).toBeInTheDocument()
    expect(
      within(blocked).getByText("Telematics export refused by the customer's security team"),
    ).toBeInTheDocument()
    const waiting = screen.getByRole("region", { name: "Waiting on the customer" })
    expect(within(waiting).getByText("Waiting 11 days on Sana Qureshi")).toBeInTheDocument()
    expect(within(waiting).getByText("Updated 7 days ago")).toBeInTheDocument()
  })

  it("opens the project an item belongs to", async () => {
    const { router } = renderWithRouter(<TodayView />)

    await userEvent.click(await screen.findByRole("link", { name: /Staging credentials/ }))

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
