import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { SignIn } from "./sign-in"
import { api } from "@/lib/api/client"
import { renderWithRouter } from "@/test/render"

describe("SignIn", () => {
  it("signs in and returns to where the FDE was going", async () => {
    const { router } = renderWithRouter(<SignIn returnTo="/today" />, {
      at: "/sign-in",
      signedIn: false,
    })

    expect(await screen.findByRole("heading", { name: "Sign in to your FDE workspace" }))
    expect(screen.getByText(/Running on the mock API with sample data/)).toBeInTheDocument()
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }))

    await waitFor(() => expect(router.state.location.pathname).toBe("/today"))
    expect((await api.me()).user.name).toBe("Riya Kapoor")
  })

  it("never returns to another site", async () => {
    const { router } = renderWithRouter(<SignIn returnTo="//evil.example/x" />, {
      at: "/sign-in",
      signedIn: false,
    })

    await userEvent.click(await screen.findByRole("button", { name: "Continue" }))

    await waitFor(() => expect(router.state.location.href).toBe("/"))
  })
})
