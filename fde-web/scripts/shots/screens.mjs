// What `pnpm shots` photographs. Add a screen by adding an entry; nothing else needs to change.
//
// An entry is one screenshot per size and theme:
//   name      the file name stem: `<name>-<width>-<theme>.png`
//   path      the route, signed in on the dev mock (a fresh session and fresh sample data every time)
//   ready     (page) => a Playwright locator that is visible once the screen has rendered; the run
//             fails when it never is
//   act       (page) => the interaction to capture: open a dialog or a menu, hover, type. Optional.
//   full      false for a screen with an overlay open: the shot is then the viewport only. By
//             default the app's own scroll container is grown so the whole page is captured.
//   sizes, themes  names to take instead of all of `SIZES` and `THEMES`
//   signedOut true: no sign-in first (the sign-in screens themselves)
//   pendingStep "verify_email": the mock starts with a sign-in waiting to verify its email, as a
//             password sign-in leaves it (the mock's `__fdeMockPendingStep`, set before the app loads)
// Everything here runs inside the Playwright container; the page is the app's, not this repo's.

export const SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 768 },
  // A phone: touch, so the hover-only controls behave as they do on a device.
  { name: "390", width: 390, height: 844, touch: true },
]
export const THEMES = ["light", "dark"]

const heading = (name) => (page) => page.getByRole("heading", { name, exact: true }).first()

// Our own sign-in screens (ADR 0007), on the mock's sample accounts (src/dev/mock-sign-in.ts). Each
// screen at every size; each refusal or later state at the widest and at phone width. Only the steps
// the API serves are here: the invite, reset, forgotten password and Google screens stay hidden
// (`LATER` in src/lib/api/sign-in-api.ts) and come back here with their routes.
function ownSignInScreens() {
  const STATE = { signedOut: true, sizes: ["1440", "390"] }
  // These pages are server-rendered: typing before React hydrates is lost, so every act waits for it.
  const hydrated = (page) =>
    page.waitForFunction(() => {
      const form = document.querySelector("main form, main button")
      return form !== null && Object.keys(form).some((k) => k.startsWith("__reactFiber"))
    })
  const title = (name) => (page) => page.getByRole("heading", { name, exact: true })
  const alert = (page) => page.getByRole("alert")
  const field = (page, label) => page.getByLabel(label, { exact: true })
  const press = (page, name) => page.getByRole("button", { name, exact: true }).click()
  async function password(page, email, secret) {
    await field(page, "Email").fill(email)
    await field(page, "Password").fill(secret)
    await press(page, "Sign in")
  }
  // Nothing to do but wait for the page to hydrate, so the main button is drawn enabled.
  const settled = async () => {}
  const screens = [
    {
      name: "auth-password",
      path: "/sign-in",
      signedOut: true,
      ready: title("Sign in"),
      act: settled,
    },
    {
      name: "auth-password-missing",
      path: "/sign-in",
      ...STATE,
      ready: title("Sign in"),
      act: (page) => press(page, "Sign in"),
    },
    {
      name: "auth-password-wrong",
      path: "/sign-in",
      ...STATE,
      ready: title("Sign in"),
      act: async (page) => {
        await password(page, "riya@example.com", "not-the-password")
        await alert(page).waitFor()
      },
    },
    {
      name: "auth-password-too-many",
      path: "/sign-in",
      ...STATE,
      ready: title("Sign in"),
      act: async (page) => {
        await password(page, "locked@example.com", "sample-password")
        await alert(page).waitFor()
      },
    },
    {
      name: "auth-unsupported",
      path: "/sign-in",
      ...STATE,
      ready: title("Sign in"),
      act: async (page) => {
        await password(page, "mfa@example.com", "sample-password")
        await alert(page).waitFor()
      },
    },
    {
      name: "auth-verify-email",
      path: "/sign-in?step=verify-email",
      signedOut: true,
      pendingStep: "verify_email",
      ready: title("Check your email"),
      act: settled,
    },
    {
      name: "auth-verify-email-wrong",
      path: "/sign-in?step=verify-email",
      ...STATE,
      pendingStep: "verify_email",
      ready: title("Check your email"),
      act: async (page) => {
        await field(page, "Code").fill("654321")
        await press(page, "Confirm and sign in")
        await alert(page).waitFor()
      },
    },
    {
      name: "auth-organisation",
      path: "/sign-in",
      signedOut: true,
      ready: title("Sign in"),
      act: async (page) => {
        await password(page, "two-orgs@example.com", "sample-password")
        await page.getByRole("list", { name: "Your organisations" }).waitFor()
      },
    },
    {
      name: "auth-verify-email-resent",
      path: "/sign-in?step=verify-email",
      ...STATE,
      pendingStep: "verify_email",
      ready: title("Check your email"),
      act: async (page) => {
        await press(page, "Send a new code")
        await page.getByRole("status").waitFor()
      },
    },
    // Sign in with an emailed code: asked for from the first screen, or on its own screen when no
    // address was typed.
    {
      name: "auth-code",
      path: "/sign-in?step=code",
      signedOut: true,
      ready: title("Sign in with a code"),
      act: settled,
    },
    {
      name: "auth-code-enter",
      path: "/sign-in",
      signedOut: true,
      ready: title("Sign in"),
      act: async (page) => {
        await field(page, "Email").fill("riya@example.com")
        await press(page, "Email me a code")
        await title("Enter your code")(page).waitFor()
      },
    },
    {
      name: "auth-code-wrong",
      path: "/sign-in",
      ...STATE,
      ready: title("Sign in"),
      act: async (page) => {
        await field(page, "Email").fill("riya@example.com")
        await press(page, "Email me a code")
        await field(page, "Code").fill("654321")
        await press(page, "Sign in")
        await alert(page).waitFor()
      },
    },
    {
      name: "auth-code-resent",
      path: "/sign-in?step=code",
      ...STATE,
      ready: title("Sign in with a code"),
      act: async (page) => {
        await field(page, "Email").fill("riya@example.com")
        await press(page, "Email me a code")
        await press(page, "Send a new code")
        await page.getByRole("status").waitFor()
      },
    },
    {
      // A step that lapsed, or the organisations lost to a reload: back to the start with a note.
      name: "auth-start-again",
      path: "/sign-in?step=organisation",
      ...STATE,
      ready: (page) => page.getByRole("status"),
    },
    {
      name: "auth-mfa-required",
      path: "/sign-in?error=mfa_required",
      ...STATE,
      ready: title("We could not finish signing you in"),
    },
    {
      name: "auth-sso-required",
      path: "/sign-in?error=sso_required",
      ...STATE,
      ready: title("We could not finish signing you in"),
    },
  ]
  return screens.map((screen) =>
    screen.act
      ? {
          ...screen,
          act: async (page) => {
            await hydrated(page)
            await screen.act(page)
          },
        }
      : screen,
  )
}

export const screens = [
  {
    name: "sign-in",
    path: "/sign-in",
    signedOut: true,
    ready: (page) => page.getByRole("heading", { name: /^Sign in/ }),
  },
  // `/auth/callback` refused a person in no organisation: today's sign-in says so, and so do our own
  // screens. Either one is ready.
  {
    name: "sign-in-no-organisation",
    path: "/sign-in?error=no_organisation",
    signedOut: true,
    ready: (page) =>
      page
        .getByRole("alert")
        .or(page.getByRole("heading", { name: "Your account is not part of an organisation yet" })),
  },
  ...ownSignInScreens(),
  // The one signed-in page: who is signed in, and sign out.
  { name: "signed-in", path: "/", ready: heading("You are signed in") },
]
