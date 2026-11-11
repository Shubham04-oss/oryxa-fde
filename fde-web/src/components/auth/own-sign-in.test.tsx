import { useRouterState } from "@tanstack/react-router"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { carried, stepOf, useLinkToken } from "./flow"
import { OwnSignIn } from "./own-sign-in"
import { resetMockApi } from "@/dev/mock-api"
import { MAX_ATTEMPTS, SAMPLE_PASSWORD, mockPendingStep } from "@/dev/mock-sign-in"
import { api, safeReturnTo } from "@/lib/api/client"
import { SIGN_IN_TEXT } from "@/lib/api/sign-in-api"
import { outcomeOf } from "@/lib/sign-in-outcome"
import { renderWithRouter } from "@/test/render"

/** `/sign-in` as the app's route reads it: the step, the outcome and an emailed link's token. */
function Harness() {
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>
  const step = stepOf(search.step)
  const outcome = outcomeOf(search.error)
  const returnTo = safeReturnTo(search.return_to)
  const token = useLinkToken(
    typeof search.token === "string" ? search.token : undefined,
    step,
    returnTo,
  )
  return (
    <OwnSignIn
      key={`${outcome}-${step}`}
      step={step}
      outcome={outcome}
      returnTo={returnTo}
      token={token}
    />
  )
}

const WRONG = "not-the-password"

function open(at = "/sign-in?return_to=%2Ftoday") {
  return renderWithRouter(<Harness />, { at, signedIn: false })
}

async function signIn(email: string, password = SAMPLE_PASSWORD) {
  await userEvent.type(await screen.findByLabelText("Email"), email)
  await userEvent.type(screen.getByLabelText("Password"), password)
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
}

const where = (router: ReturnType<typeof open>["router"]) => router.state.location

beforeEach(() => {
  carried.email = ""
  carried.token = ""
})
afterEach(() => vi.restoreAllMocks())

describe("sign in with email and password", () => {
  it("signs in and goes where the person was going", async () => {
    const { router } = open()
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()

    await signIn("riya@example.com")

    await waitFor(() => expect(where(router).pathname).toBe("/today"))
    expect((await api.me()).user.name).toBe("Riya Kapoor")
  })

  it("gives password managers what they need, in a form that never posts to the address", async () => {
    open()
    const email = await screen.findByLabelText("Email")
    const password = screen.getByLabelText("Password")
    expect(email).toHaveAttribute("autocomplete", "username")
    expect(email).toHaveAttribute("type", "email")
    expect(password).toHaveAttribute("autocomplete", "current-password")
    expect(password).toHaveAttribute("type", "password")
    expect(screen.getByRole("form", { name: "Sign in with email and password" })).toHaveAttribute(
      "method",
      "post",
    )
  })

  it("answers a wrong password and an unknown address in the same words", async () => {
    open()
    await signIn("riya@example.com", WRONG)
    const wrongPassword = (await screen.findByRole("alert")).textContent

    await userEvent.clear(screen.getByLabelText("Email"))
    await signIn("nobody@example.com", WRONG)
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveValue(""))
    const unknown = (await screen.findByRole("alert")).textContent

    expect(wrongPassword).toContain(SIGN_IN_TEXT.invalid_credentials)
    expect(unknown).toBe(wrongPassword)
  })

  it("keeps the password out of the address, storage, logs and the screen after a refusal", async () => {
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level),
    )
    const { router } = open()
    await signIn("riya@example.com", WRONG)
    await screen.findByRole("alert")

    expect(screen.getByLabelText("Password")).toHaveValue("")
    expect(where(router).href).not.toContain(WRONG)
    expect(window.location.href).not.toContain(WRONG)
    for (const store of [localStorage, sessionStorage])
      for (let i = 0; i < store.length; i++)
        expect(store.getItem(store.key(i)!) ?? "").not.toContain(WRONG)
    for (const spy of logged)
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(WRONG)
    expect(document.body.textContent).not.toContain(WRONG)
  })

  it("says what is missing before sending anything, and moves to it", async () => {
    open()
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }))

    const email = screen.getByLabelText("Email")
    expect(email).toHaveAttribute("aria-invalid", "true")
    expect(email).toHaveAccessibleDescription("Enter your email address.")
    expect(email).toHaveFocus()

    await userEvent.type(email, "riya@example")
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(email).toHaveAccessibleDescription("Enter an email address like name@example.com.")

    await userEvent.type(email, ".com")
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription("Enter your password.")
    expect(screen.getByLabelText("Password")).toHaveFocus()
  })

  it("says how long to wait after too many attempts, the same for an unknown address", async () => {
    open()
    for (let i = 0; i <= MAX_ATTEMPTS; i++) {
      await signIn("nobody@example.com", WRONG)
      await screen.findByRole("alert")
      await userEvent.clear(screen.getByLabelText("Email"))
    }
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Too many attempts. Wait 5 minutes, then try again.",
    )
    expect(screen.getByRole("link", { name: "Reset your password" })).toBeInTheDocument()
  })

  it("shows and hides the password with a labelled button", async () => {
    open()
    const show = await screen.findByRole("button", { name: "Show password" })
    expect(show).toHaveAttribute("aria-pressed", "false")
    await userEvent.click(show)
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text")
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
  })

  it("continues with Google, which on the mock comes back signed in", async () => {
    const { router } = open()
    await userEvent.click(await screen.findByRole("button", { name: "Continue with Google" }))
    await waitFor(() => expect(where(router).pathname).toBe("/today"))
  })
})

describe("the steps after a password", () => {
  it("chooses among the organisations the API lists", async () => {
    const { router } = open()
    await signIn("two-orgs@example.com")

    expect(await screen.findByRole("heading", { name: "Choose an organisation" })).toHaveFocus()
    const list = await screen.findByRole("list", { name: "Your organisations" })
    expect(list).toHaveTextContent("Northwind Field Engineering")
    expect(where(router).search).toMatchObject({ step: "organisation", return_to: "/today" })

    await userEvent.click(screen.getByRole("button", { name: "Harbor Labs" }))
    await waitFor(() => expect(where(router).pathname).toBe("/today"))
  })

  it("opens the organisation choice straight from Google's callback", async () => {
    resetMockApi({ signedIn: false })
    mockPendingStep("choose_organisation")
    renderWithRouter(<Harness />, {
      at: "/sign-in?step=organisation&return_to=%2F",
      signedIn: false,
      keep: true,
    })
    expect(await screen.findByRole("button", { name: "Harbor Labs" })).toBeInTheDocument()
  })

  it("says an organisation choice with nothing pending has expired", async () => {
    open("/sign-in?step=organisation")
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_TEXT.step_expired)
    expect(screen.getByRole("link", { name: "Back to sign in" })).toBeInTheDocument()
  })

  it("confirms the email with a code, saying when it is wrong or has expired", async () => {
    const { router } = open()
    await signIn("unverified@example.com")
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument()
    expect(screen.getByText("unverified@example.com")).toBeInTheDocument()
    const code = screen.getByLabelText("Code")
    expect(code).toHaveAttribute("autocomplete", "one-time-code")
    expect(code).toHaveAttribute("inputmode", "numeric")

    await userEvent.type(code, "12")
    await userEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }))
    expect(code).toHaveAccessibleDescription("Enter the 6-digit code from the email.")

    await userEvent.clear(code)
    await userEvent.type(code, "000 000")
    await userEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_TEXT.code_expired)

    await userEvent.click(screen.getByRole("button", { name: "Send a new code" }))
    expect(await screen.findByRole("status")).toHaveTextContent("A new code is on its way.")

    await userEvent.clear(code)
    await userEvent.type(code, "654321")
    await userEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_TEXT.invalid_code)

    await userEvent.clear(code)
    await userEvent.type(code, "123-456")
    await userEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }))
    await waitFor(() => expect(where(router).pathname).toBe("/today"))
  })

  it("says a verification with nothing pending has expired, with a way to start again", async () => {
    open("/sign-in?step=verify-email")
    await userEvent.type(await screen.findByLabelText("Code"), "123456")
    await userEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_TEXT.step_expired)
  })

  it("ends with no organisation: what to do next and back to sign in, no sign-out", async () => {
    const { router } = open()
    await signIn("no-org@example.com")

    expect(
      await screen.findByRole("heading", {
        name: "Your account is not part of an organisation yet",
      }),
    ).toHaveFocus()
    expect(where(router).search).toMatchObject({ error: "no_organisation" })
    expect(screen.getByText("Nothing has been signed in.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull()

    await userEvent.click(screen.getByRole("link", { name: "Back to sign in" }))
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    await expect(api.me()).rejects.toMatchObject({ status: 401 })
  })

  it.each([
    ["mfa@example.com", "mfa_required", /second sign-in step/],
    ["sso@example.com", "sso_required", /single sign-on/],
  ])("ends a sign-in it cannot finish (%s) with no session", async (email, error, text) => {
    const { router } = open()
    await signIn(email)
    expect(
      await screen.findByRole("heading", { name: "We could not finish signing you in" }),
    ).toBeInTheDocument()
    expect(screen.getByText(text)).toBeInTheDocument()
    expect(where(router).search).toMatchObject({ error })
    await expect(api.me()).rejects.toMatchObject({ status: 401 })
  })

  it("reads an outcome from Google's callback in the address", async () => {
    open("/sign-in?error=sso_required")
    expect(await screen.findByText(/single sign-on/)).toBeInTheDocument()
  })
})

describe("sign in with an emailed code", () => {
  it("asks for the address, says the same whatever it is, then signs in with the code", async () => {
    const { router } = open()
    await userEvent.type(await screen.findByLabelText("Email"), "riya@example.com")
    await userEvent.click(screen.getByRole("button", { name: "Email me a code instead" }))

    expect(await screen.findByRole("heading", { name: "Sign in with a code" })).toHaveFocus()
    // The address typed on the first screen comes along.
    expect(screen.getByLabelText("Email")).toHaveValue("riya@example.com")
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email")
    await userEvent.click(screen.getByRole("button", { name: "Email me a code" }))

    expect(await screen.findByRole("heading", { name: "Enter your code" })).toBeInTheDocument()
    expect(screen.getByText(/If an account uses/)).toHaveTextContent(
      "If an account uses riya@example.com, we have emailed it a 6-digit code.",
    )
    await userEvent.type(screen.getByLabelText("Code"), "123456")
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() => expect(where(router).pathname).toBe("/today"))
  })

  it("answers an unknown address as it would a known one, and refuses its code", async () => {
    open("/sign-in?step=code")
    await userEvent.type(await screen.findByLabelText("Email"), "nobody@example.com")
    await userEvent.click(screen.getByRole("button", { name: "Email me a code" }))
    expect(await screen.findByText(/If an account uses/)).toHaveTextContent(
      "If an account uses nobody@example.com",
    )
    await userEvent.type(screen.getByLabelText("Code"), "123456")
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_TEXT.invalid_code)
  })
})

describe("forgotten and reset password", () => {
  it("answers a reset request the same whatever the address", async () => {
    open("/sign-in?step=forgot")
    await userEvent.type(await screen.findByLabelText("Email"), "nobody@example.com")
    await userEvent.click(screen.getByRole("button", { name: "Email me a reset link" }))
    expect(await screen.findByRole("status")).toHaveTextContent(
      "If an account uses nobody@example.com, we have emailed it a link",
    )
  })

  it("takes the token out of the address, sends it in a body, and sets the new password", async () => {
    const { router } = open("/sign-in?step=reset&token=reset-sample&return_to=%2Ftoday")
    const password = await screen.findByLabelText("New password")
    expect(password).toHaveAttribute("autocomplete", "new-password")
    await waitFor(() => expect(where(router).search).not.toHaveProperty("token"))
    expect(where(router).href).not.toContain("reset-sample")
    expect(where(router).search).toMatchObject({ step: "reset", return_to: "/today" })

    await userEvent.type(password, "short")
    await userEvent.click(screen.getByRole("button", { name: "Change password" }))
    expect(await screen.findByText(SIGN_IN_TEXT.password_rejected)).toBeInTheDocument()
    expect(password).toHaveValue("")

    await userEvent.type(password, "a much longer password")
    await userEvent.click(screen.getByRole("button", { name: "Change password" }))
    expect(await screen.findByRole("heading", { name: "Password changed" })).toBeInTheDocument()
    expect(carried.token).toBe("")
  })

  it("says a used or expired reset link has expired, with a way to ask again", async () => {
    open("/sign-in?step=reset&token=old")
    await userEvent.type(await screen.findByLabelText("New password"), "a much longer password")
    await userEvent.click(screen.getByRole("button", { name: "Change password" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_TEXT.link_expired)
    expect(screen.getByRole("link", { name: "Ask for a new link" })).toBeInTheDocument()
  })

  it("refuses a reset with no token at all", async () => {
    open("/sign-in?step=reset")
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_TEXT.link_expired)
  })
})

describe("accept an invite", () => {
  it("shows the invited address, takes a name and a password, and signs in", async () => {
    const { router } = open("/sign-in?step=invite&token=invite-sample&return_to=%2Ftoday")
    const email = await screen.findByLabelText("Email")
    expect(email).toHaveValue("new-colleague@example.com")
    expect(email).toHaveAttribute("readonly")
    expect(email).toHaveAttribute("autocomplete", "username")
    expect(screen.getByLabelText("Your name")).toHaveAttribute("autocomplete", "name")
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "new-password")
    expect(where(router).href).not.toContain("invite-sample")

    await userEvent.click(screen.getByRole("button", { name: "Join and sign in" }))
    expect(screen.getByLabelText("Your name")).toHaveAccessibleDescription("Enter your name.")

    await userEvent.type(screen.getByLabelText("Your name"), "Asha Rao")
    await userEvent.type(screen.getByLabelText("Password"), "a much longer password")
    await userEvent.click(screen.getByRole("button", { name: "Join and sign in" }))
    await waitFor(() => expect(where(router).pathname).toBe("/today"))
  })

  it("says an expired invite has expired, and who to ask", async () => {
    open("/sign-in?step=invite&token=old")
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `${SIGN_IN_TEXT.link_expired} Ask whoever invited you to send a new invite.`,
    )
    // There is no open sign-up.
    expect(screen.queryByRole("button", { name: /sign up|join/i })).toBeNull()
  })
})
