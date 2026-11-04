import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { SessionGate } from "./session-gate"
import { resetMockApi } from "@/dev/mock-api"
import { renderWithRouter } from "@/test/render"

describe("SessionGate", () => {
  it("opens the shell for a signed-in FDE", async () => {
    renderWithRouter(
      <SessionGate>
        <p>Canvas</p>
      </SessionGate>,
      { at: "/today" },
    )

    expect(await screen.findByText("Canvas")).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument()
    expect(await screen.findByRole("link", { name: "Kestrel Freight" })).toBeInTheDocument()
  })

  it("sends a visit without a session to sign-in once, to come back to the same place", async () => {
    const { router } = renderWithRouter(
      <SessionGate>
        <p>Canvas</p>
      </SessionGate>,
      { at: "/companies/cmp_lumen?tab=x", signedIn: false },
    )
    let moves = 0
    router.history.subscribe(() => (moves += 1))

    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"))
    // A navigation that repeats on every render would rewrite this to point at sign-in itself.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(router.state.location.search).toEqual({ return_to: "/companies/cmp_lumen?tab=x" })
    expect(moves).toBe(1)
    expect(screen.queryByText("Canvas")).toBeNull()
  })

  it("sends a session that ends mid-visit to sign-in, back to where the FDE is at that moment", async () => {
    const { router, queryClient } = renderWithRouter(
      <SessionGate>
        <p>Canvas</p>
      </SessionGate>,
      { at: "/today" },
    )
    await screen.findByText("Canvas")
    await router.navigate({ to: "/companies/cmp_lumen?tab=x" as never })

    resetMockApi({ signedIn: false })
    // Any read, not only "who am I": the sidebar's companies.
    await queryClient.refetchQueries({ queryKey: ["companies"], exact: true })

    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"))
    expect(router.state.location.search).toEqual({ return_to: "/companies/cmp_lumen?tab=x" })
  })

  it("signs out to sign-in and forgets the session's reads", async () => {
    const { router, queryClient } = renderWithRouter(
      <SessionGate>
        <p>Canvas</p>
      </SessionGate>,
    )
    await screen.findByText("Canvas")

    await userEvent.click(screen.getByRole("button", { name: "Open user menu" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Sign out" }))

    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"))
    expect(queryClient.getQueryData(["companies"])).toBeUndefined()
  })
})
