import { useRouterState } from "@tanstack/react-router"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { carried, stepOf, useLinkToken } from "./flow"
import { OwnSignIn } from "./own-sign-in"
import { resetMockApi } from "@/dev/mock-api"
import { LIMITS, LOCKED_ADDRESS, SAMPLE_PASSWORD, mockPendingStep } from "@/dev/mock-sign-in"
import { api, safeReturnTo } from "@/lib/api/client"
import { LATER, SIGN_IN_TEXT } from "@/lib/api/sign-in-api"
import type { Later } from "@/lib/api/sign-in-api"
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

/** The ways in as this build has them: the served ones on, the ones still to come off. */
const SERVED = { ...LATER }

/** Turns on every way in whose API route is still to come, for the tests of their screens. */
function withLater() {
  beforeEach(() => {
    for (const k of Object.keys(LATER) as Later[]) LATER[k] = true
  })
  afterEach(() => void Object.assign(LATER, SERVED))
}

beforeEach(() => {
  carried.email = ""
  carried.codeSentTo = null
  carried.organisations = []
  carried.note = null
  carried.token = ""
  carried.tokenFor = null
})
afterEach(() => vi.restoreAllMocks())

describe("sign in with email and password", () => {
  it("signs in and goes where the person was going", async () => {
    const { router } = open()
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()

    await signIn("riya@example.com")

    await waitFor(() => expect(where(router).pathname).toBe("/today"))
    expect((await api.me()).user.name).toBe("Riya Kapoor")
    // Nothing of the sign-in is left in memory once it is done.
    expect(carried).toMatchObject({ email: "", organisations: [], note: null })
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

  it("keeps the password and the address out of the address bar, storage and logs", async () => {
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level),
    )
    const { router } = open()
    await signIn("riya@example.com", WRONG)
    await screen.findByRole("alert")

    expect(screen.getByLabelText("Password")).toHaveValue("")
    for (const secret of [WRONG, "riya@example.com", "riya%40example.com"]) {
      expect(where(router).href).not.toContain(secret)
      expect(window.location.href).not.toContain(secret)
      expect(document.cookie).not.toContain(secret)
      for (const store of [localStorage, sessionStorage])
        for (let i = 0; i < store.length; i++)
          expect(store.getItem(store.key(i)!) ?? "").not.toContain(secret)
      for (const spy of logged)
        for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(secret)
    }
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
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      "Enter your password, or choose Email me a code below.",
    )
    expect(screen.getByLabelText("Password")).toHaveFocus()
  })

  it("says under the field when the API refuses the address or the password", async () => {
    open()
    // The browser's check passes it; the API's does not.
    await signIn("riya@example..com")
    expect(await screen.findByLabelText("Email")).toHaveAccessibleDescription(
      SIGN_IN_TEXT.invalid_email,
    )

    await userEvent.clear(screen.getByLabelText("Email"))
    await userEvent.type(screen.getByLabelText("Email"), "riya@example.com")
    await userEvent.click(screen.getByLabelText("Password"))
    await userEvent.paste("x".repeat(1025))
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() =>
      expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
        SIGN_IN_TEXT.invalid_password,
      ),
    )
  })

  it("says how long to wait after too many attempts, the same for an unknown address", async () => {
    open()
    await userEvent.type(await screen.findByLabelText("Email"), "nobody@example.com")
    for (let i = 0; i <= LIMITS.address; i++) {
      await userEvent.type(screen.getByLabelText("Password"), WRONG)
      await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
      await waitFor(() => expect(screen.getByLabelText("Password")).toHaveValue(""))
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Wait 5 minutes, then try again.",
    )
    // No reset link until its route is served.
    expect(screen.queryByRole("link", { name: "Reset your password" })).toBeNull()
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

  it("says plainly when the account needs a step we do not support, with no session", async () => {
    const { router } = open()
    await signIn("mfa@example.com")
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_TEXT.sign_in_unsupported)
    expect(where(router).pathname).toBe("/sign-in")
    await expect(api.me()).rejects.toMatchObject({ status: 401 })
  })

  it("offers no way in whose route is still to come", async () => {
    open()
    await screen.findByRole("heading", { name: "Sign in" })
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull()
    expect(screen.queryByRole("link", { name: "Forgotten password?" })).toBeNull()
    expect(screen.queryByRole("link", { name: /sign up|invite/i })).toBeNull()
  })

  it.each(["forgot", "reset&token=reset-sample", "invite&token=invite-sample"])(
    "opens the first screen for step=%s until its route is served",
    async (step) => {
      open(`/sign-in?step=${step}`)
      expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    },
  )
})

describe("the steps after a password", () => {
  it("chooses among the organisations the API offered", async () => {
    const { router } = open()
    await signIn("two-orgs@example.com")

    expect(await screen.findByRole("heading", { name: "Choose an organisation" })).toHaveFocus()
    const list = await screen.findByRole("list", { name: "Your organisations" })
    expect(list).toHaveTextContent("Northwind Field Engineering")
    expect(where(router).search).toEqual({ step: "organisation", return_to: "/today" })

    await userEvent.click(screen.getByRole("button", { name: "Harbor Labs" }))
    await waitFor(() => expect(where(router).pathname).toBe("/today"))
    expect((await api.me()).user.name).toBe("Riya Kapoor")
  })

  it("starts again with a note when the organisations are gone, as after a reload", async () => {
    const { router } = open("/sign-in?step=organisation&return_to=%2Ftoday")
    expect(await screen.findByRole("status")).toHaveTextContent(SIGN_IN_TEXT.invalid_sign_in)
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(where(router).search).toEqual({ return_to: "/today" })
  })

  it("confirms the email with a code, keeping the step open after a wrong one", async () => {
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
    await userEvent.type(code, "654 321")
    await userEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_TEXT.invalid_code)

    await userEvent.clear(code)
    await userEvent.type(code, "123-456")
    await userEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }))
    await waitFor(() => expect(where(router).pathname).toBe("/today"))
  })

  it("opens the verification straight from a pending step", async () => {
    resetMockApi({ signedIn: false })
    mockPendingStep("verify_email")
    const { router } = renderWithRouter(<Harness />, {
      at: "/sign-in?step=verify-email&return_to=%2F",
      signedIn: false,
      keep: true,
    })
    await userEvent.type(await screen.findByLabelText("Code"), "123456")
    await userEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }))
    await waitFor(() => expect(where(router).pathname).toBe("/"))
  })

  it("sends a lapsed verification back to the start with a note, keeping the address", async () => {
    carried.email = "unverified@example.com"
    const { router } = open("/sign-in?step=verify-email&return_to=%2Ftoday")
    await userEvent.type(await screen.findByLabelText("Code"), "123456")
    await userEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }))

    const title = await screen.findByRole("heading", { name: "Sign in" })
    expect(screen.getByRole("status")).toHaveTextContent(SIGN_IN_TEXT.invalid_sign_in)
    // The note is read out with the title, which takes focus for it.
    await waitFor(() => expect(title).toHaveFocus())
    expect(title).toHaveAccessibleDescription(SIGN_IN_TEXT.invalid_sign_in)
    expect(screen.getByLabelText("Email")).toHaveValue("unverified@example.com")
    expect(where(router).search).toEqual({ return_to: "/today" })

    // The note goes once the person tries again.
    await userEvent.type(screen.getByLabelText("Password"), WRONG)
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    await screen.findByRole("alert")
    expect(screen.queryByRole("status")).toBeNull()
    expect(title).not.toHaveAccessibleDescription()
  })

  it("leaves focus alone on the first screen when there is no note", async () => {
    open()
    const title = await screen.findByRole("heading", { name: "Sign in" })
    expect(title).not.toHaveFocus()
    expect(title).not.toHaveAccessibleDescription()
  })

  it("goes on from a confirmed email to choosing an organisation", async () => {
    const { router } = open()
    await signIn("unverified-two-orgs@example.com")
    await userEvent.type(await screen.findByLabelText("Code"), "123456")
    await userEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }))

    expect(await screen.findByRole("heading", { name: "Choose an organisation" })).toHaveFocus()
    await userEvent.click(screen.getByRole("button", { name: "Northwind Field Engineering" }))
    await waitFor(() => expect(where(router).pathname).toBe("/today"))
  })

  it("offers one way to start again when a confirmed email needs a step we do not support", async () => {
    open()
    await signIn("unverified-mfa@example.com")
    await userEvent.type(await screen.findByLabelText("Code"), "123456")
    await userEvent.click(screen.getByRole("button", { name: "Confirm and sign in" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_TEXT.sign_in_unsupported)
    expect(screen.getAllByRole("link", { name: "Start again" })).toHaveLength(1)
    await expect(api.me()).rejects.toMatchObject({ status: 401 })
  })

  it("answers too many attempts for a locked address whatever the password", async () => {
    open()
    await signIn(LOCKED_ADDRESS, WRONG)
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Wait 5 minutes, then try again.",
    )
  })

  it("ends with no organisation: what to do next and back to sign in, no sign-out", async () => {
    const { router } = open()
    await signIn("no-org@example.com")

    expect(
      await screen.findByRole("heading", {
        name: "Your account is not part of an organisation yet",
      }),
    ).toHaveFocus()
    expect(where(router).pathname).toBe("/sign-in")
    expect(where(router).search).toEqual({ error: "no_organisation", return_to: "/today" })
    expect(screen.getByText("Nothing has been signed in.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /sign out/i })).toBeNull()
    expect(carried.email).toBe("")

    await userEvent.click(screen.getByRole("link", { name: "Back to sign in" }))
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    await expect(api.me()).rejects.toMatchObject({ status: 401 })
  })

  it.each([
    ["mfa_required", /second sign-in step/],
    ["sso_required", /single sign-on/],
  ])("reads an outcome from the callback in the address (%s)", async (error, text) => {
    open(`/sign-in?error=${error}`)
    expect(
      await screen.findByRole("heading", { name: "We could not finish signing you in" }),
    ).toBeInTheDocument()
    expect(screen.getByText(text)).toBeInTheDocument()
  })
})

describe("continue with Google, once its route is served", () => {
  withLater()

  it("comes back signed in on the mock", async () => {
    const { router } = open()
    await userEvent.click(await screen.findByRole("button", { name: "Continue with Google" }))
    await waitFor(() => expect(where(router).pathname).toBe("/today"))
  })
})

describe("a new verification code", () => {
  it("sends one while the step waits, and starts again once the step has lapsed", async () => {
    resetMockApi({ signedIn: false })
    mockPendingStep("verify_email")
    const { router } = renderWithRouter(<Harness />, {
      at: "/sign-in?step=verify-email",
      signedIn: false,
      keep: true,
    })
    await userEvent.click(await screen.findByRole("button", { name: "Send a new code" }))
    expect(await screen.findByRole("status")).toHaveTextContent(
      "A new code is on its way. Use the newest one.",
    )

    resetMockApi({ signedIn: false })
    await userEvent.click(screen.getByRole("button", { name: "Send a new code" }))
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(SIGN_IN_TEXT.invalid_sign_in)
    expect(where(router).search).toEqual({ return_to: "/" })
  })
})

describe("sign in with an emailed code", () => {
  it("is a choice of its own on the first screen, beside the one main button", async () => {
    open()
    await screen.findByRole("heading", { name: "Sign in" })
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeInTheDocument()
    expect(screen.getByText("or")).toBeInTheDocument()
    expect(
      screen.getAllByRole("button").filter((b) => b.getAttribute("type") === "submit"),
    ).toHaveLength(1)
  })

  it("signs in with no password: the address on the first screen, then the code", async () => {
    const { router } = open()
    await userEvent.type(await screen.findByLabelText("Email"), "riya@example.com")
    await userEvent.click(screen.getByRole("button", { name: "Email me a code" }))

    expect(await screen.findByRole("heading", { name: "Enter your code" })).toBeInTheDocument()
    expect(where(router).search).toEqual({ step: "code", return_to: "/today" })
    expect(screen.getByText(/If an account uses/)).toHaveTextContent(
      "If an account uses riya@example.com, we have emailed it a 6-digit code.",
    )
    const code = screen.getByLabelText("Code")
    expect(code).toHaveFocus()
    expect(code).toHaveAttribute("autocomplete", "one-time-code")
    await userEvent.type(code, "123 456")
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() => expect(where(router).pathname).toBe("/today"))
    expect((await api.me()).user.name).toBe("Riya Kapoor")
    expect(carried).toMatchObject({ email: "", codeSentTo: null })
  })

  it("asks for the address when none was typed, then says the same whatever it is", async () => {
    open()
    await userEvent.click(await screen.findByRole("button", { name: "Email me a code" }))

    expect(await screen.findByRole("heading", { name: "Sign in with a code" })).toHaveFocus()
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email")
    await userEvent.click(screen.getByRole("button", { name: "Email me a code" }))
    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Enter your email address.")

    await userEvent.type(screen.getByLabelText("Email"), "nobody@example.com")
    await userEvent.click(screen.getByRole("button", { name: "Email me a code" }))
    expect(await screen.findByText(/If an account uses/)).toHaveTextContent(
      "If an account uses nobody@example.com, we have emailed it a 6-digit code.",
    )
    await userEvent.type(screen.getByLabelText("Code"), "123456")
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGN_IN_TEXT.invalid_code)
  })

  it("says what is wrong with a typed address before sending a code to it", async () => {
    open()
    await userEvent.type(await screen.findByLabelText("Email"), "riya@example")
    await userEvent.click(screen.getByRole("button", { name: "Email me a code" }))
    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription(
      "Enter an email address like name@example.com.",
    )
    expect(screen.getByLabelText("Email")).toHaveFocus()
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument()
  })

  it("sends a new code without saying whether the address has an account", async () => {
    open("/sign-in?step=code")
    await userEvent.type(await screen.findByLabelText("Email"), "nobody@example.com")
    await userEvent.click(screen.getByRole("button", { name: "Email me a code" }))
    await userEvent.click(await screen.findByRole("button", { name: "Send a new code" }))
    expect(await screen.findByRole("status")).toHaveTextContent(
      "If an account uses that address, a new code is on its way. Use the newest one.",
    )

    await userEvent.click(screen.getByRole("button", { name: "Use a different address" }))
    expect(await screen.findByRole("heading", { name: "Sign in with a code" })).toBeInTheDocument()
    expect(screen.getByLabelText("Email")).toHaveValue("nobody@example.com")
  })

  it("says how long to wait once too many codes were asked for", async () => {
    open("/sign-in?step=code")
    await userEvent.type(await screen.findByLabelText("Email"), "riya@example.com")
    await userEvent.click(screen.getByRole("button", { name: "Email me a code" }))
    for (let i = 1; i <= LIMITS.sendAddress; i++)
      await userEvent.click(await screen.findByRole("button", { name: "Send a new code" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Wait 15 minutes, then try again.",
    )
  })

  it("shows the first screen's refusal when the code cannot be asked for", async () => {
    open()
    await userEvent.type(await screen.findByLabelText("Email"), LOCKED_ADDRESS)
    await userEvent.click(screen.getByRole("button", { name: "Email me a code" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts.")
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument()
  })

  it.each([
    ["unverified@example.com", "Check your email"],
    ["two-orgs@example.com", "Choose an organisation"],
  ])("takes %s on to its next step", async (email, title) => {
    open()
    await userEvent.type(await screen.findByLabelText("Email"), email)
    await userEvent.click(screen.getByRole("button", { name: "Email me a code" }))
    await userEvent.type(await screen.findByLabelText("Code"), "123456")
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument()
    if (email.startsWith("unverified")) expect(screen.getByText(email)).toBeInTheDocument()
  })

  it("asks for the address again after a reload", async () => {
    open("/sign-in?step=code")
    expect(await screen.findByRole("heading", { name: "Sign in with a code" })).toBeInTheDocument()
  })
})

describe("forgotten and reset password, once their routes are served", () => {
  withLater()

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

describe("accept an invite, once its route is served", () => {
  withLater()

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
