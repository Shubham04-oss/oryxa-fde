import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { SessionGate } from "./session-gate"
import { SignedIn } from "./signed-in"
import { renderWithRouter } from "@/test/render"

function page() {
  return (
    <SessionGate>
      <SignedIn />
    </SessionGate>
  )
}

describe("SignedIn", () => {
  it("says who is signed in, and in which organisation", async () => {
    renderWithRouter(page())

    expect(
      await screen.findByRole("heading", { level: 1, name: "You are signed in" }),
    ).toBeInTheDocument()
    expect(screen.getByText("Riya Kapoor")).toBeInTheDocument()
    expect(screen.getByText("Northlight FDE")).toBeInTheDocument()
    expect(screen.getByText(/as an organisation admin/)).toBeInTheDocument()
  })

  it("does not call a member an admin", async () => {
    renderWithRouter(page(), { engineer: true })

    expect(await screen.findByText("Riya Kapoor")).toBeInTheDocument()
    expect(screen.queryByText(/as an organisation admin/)).toBeNull()
  })

  it("signs out to sign-in and forgets the session's reads", async () => {
    const { router, queryClient } = renderWithRouter(page())
    await screen.findByText("Riya Kapoor")

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }))

    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"))
    expect(queryClient.getQueryData(["me"])).toBeUndefined()
  })

  it("offers no link to anything else", async () => {
    renderWithRouter(page())
    await screen.findByText("Riya Kapoor")

    expect(screen.queryAllByRole("link")).toEqual([])
  })
})
