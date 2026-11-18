import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { SessionGate } from "./session-gate"
import { resetMockApi } from "@/dev/mock-api"
import { renderWithRouter } from "@/test/render"

describe("SessionGate", () => {
  it("shows the page for a signed-in person", async () => {
    renderWithRouter(
      <SessionGate>
        <p>Canvas</p>
      </SessionGate>,
    )

    expect(await screen.findByText("Canvas")).toBeInTheDocument()
  })

  it("sends a visit without a session to sign-in once, to come back to the same place", async () => {
    const { router } = renderWithRouter(
      <SessionGate>
        <p>Canvas</p>
      </SessionGate>,
      { at: "/elsewhere?tab=x", signedIn: false },
    )
    let moves = 0
    router.history.subscribe(() => (moves += 1))

    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"))
    // A navigation that repeats on every render would rewrite this to point at sign-in itself.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(router.state.location.search).toEqual({ return_to: "/elsewhere?tab=x" })
    expect(moves).toBe(1)
    expect(screen.queryByText("Canvas")).toBeNull()
  })

  it("sends a session that ends mid-visit to sign-in, back to where the person is at that moment", async () => {
    const { router, queryClient } = renderWithRouter(
      <SessionGate>
        <p>Canvas</p>
      </SessionGate>,
    )
    await screen.findByText("Canvas")
    await router.navigate({ to: "/elsewhere?tab=x" as never })

    resetMockApi({ signedIn: false })
    await queryClient.refetchQueries({ queryKey: ["me"], exact: true })

    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"))
    expect(router.state.location.search).toEqual({ return_to: "/elsewhere?tab=x" })
  })
})
