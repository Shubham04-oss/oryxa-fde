// What `pnpm shots` photographs. Add a screen by adding an entry; nothing else needs to change.
//
// An entry is one screenshot per size and theme:
//   name      the file name stem: `<name>-<width>-<theme>.png`
//   path      the route, signed in on the dev mock (a fresh session and fresh sample data every time)
//   ready     (page) => a Playwright locator that is visible once the screen has rendered; the run
//             fails when it never is
//   act       (page) => the interaction to capture: open a dialog or a menu, hover, type. Optional.
//   failWrites  true: every write answers 503 before `act` runs (the mock's `__fdeMockFailWrites`)
//   full      false for a screen with an overlay open: the shot is then the viewport only. By
//             default the app's own scroll container is grown so the whole page is captured.
//   sizes, themes  names to take instead of all of `SIZES` and `THEMES`
//   emptyWorkspace  true: a workspace with no company yet (the mock's `__fdeMockNoCompanies`, set before the app loads)
//   signedOut true: no sign-in first (the sign-in screen itself)
// Everything here runs inside the Playwright container; the page is the app's, not this repo's.

export const SIZES = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 768 },
  // A phone: touch, so the hover-only controls behave as they do on a device.
  { name: "390", width: 390, height: 844, touch: true },
]
export const THEMES = ["light", "dark"]

const KESTREL = "/companies/cmp_kestrel"
const DISPATCH = `${KESTREL}/projects/prj_kestrel_dispatch`
const REPLAY = "Replay last month's orders through the planner"

const heading = (name) => (page) => page.getByRole("heading", { name, exact: true }).first()
const board = (page) => page.getByRole("region", { name: "Board" })
const card = (page, title) => page.getByRole("button", { name: `Edit ${title}` })
const dialog = (page, name) => page.getByRole("dialog", { name })

/** Opens a card's menu: hover first, because with a mouse the button only shows then. */
async function openMenu(page, title) {
  await card(page, title).hover()
  await page.getByRole("button", { name: `Actions for ${title}` }).click()
  await page.getByRole("menu").waitFor()
}

const DUE_ROW = "Map intake form fields"
const BLOCKED_ROW = "Roll out to the north depot crews"
const todayReady = (page) => page.getByRole("region", { name: "Blocked" })
/** Opens a Today row's menu, with the keyboard's own key. */
async function openRowMenu(page, title) {
  await page.getByRole("button", { name: `Actions for ${title}` }).click()
  await page.getByRole("menu").waitFor()
}

// The company and project forms. `open` names the dialog; `fill` types into a field.
const button = (page, name) => page.getByRole("button", { name, exact: true })
async function fill(page, dialogName, label, text) {
  await dialog(page, dialogName).getByLabel(label, { exact: true }).fill(text)
}
const company = (page) => page.getByRole("heading", { name: "Projects" })
const newCompany = async (page) => {
  await button(page, "New company").click()
  await dialog(page, "New company").waitFor()
}

const FINE = ["1440", "1024"]
const ONE = { sizes: ["1440", "390"], themes: ["light"] }

export const screens = [
  {
    name: "sign-in",
    path: "/sign-in",
    signedOut: true,
    ready: (page) => page.getByRole("heading", { name: /^Sign in/ }),
  },
  { name: "companies", path: "/", ready: heading("Companies") },
  { name: "today", path: "/today", ready: heading("Today") },
  {
    name: "company",
    path: KESTREL,
    ready: (page) => page.getByRole("heading", { name: "Projects" }),
  },
  { name: "project", path: DISPATCH, ready: (page) => board(page) },

  // Today as an inbox: the keyboard on a row, its menu, the two prompts, a refusal and the all clear.
  {
    name: "today-keyboard",
    path: "/today",
    ready: todayReady,
    act: async (page) => {
      await page.keyboard.press("j")
      await page.keyboard.press("j")
    },
  },
  {
    name: "today-menu",
    path: "/today",
    ready: todayReady,
    full: false,
    act: (page) => openRowMenu(page, BLOCKED_ROW),
  },
  {
    name: "today-ask-blocker",
    path: "/today",
    ready: todayReady,
    ...ONE,
    full: false,
    act: async (page) => {
      await openRowMenu(page, DUE_ROW)
      await page.getByRole("menuitem", { name: "Mark blocked…" }).click()
      await page.getByRole("dialog").waitFor()
    },
  },
  {
    name: "today-ask-waiting",
    path: "/today",
    ready: todayReady,
    ...ONE,
    full: false,
    act: async (page) => {
      await openRowMenu(page, DUE_ROW)
      await page.getByRole("menuitem", { name: "Waiting on the customer…" }).click()
      await page.getByRole("dialog").waitFor()
      await page.locator("option", { hasText: "Owen Price" }).waitFor({ state: "attached" })
    },
  },
  {
    name: "today-refused",
    path: "/today",
    ready: todayReady,
    failWrites: true,
    act: async (page) => {
      await page.getByRole("button", { name: `Done: ${DUE_ROW}` }).click()
      await page.getByRole("alert").waitFor()
    },
  },
  // Every row acted on with its main action, until Today says it is clear.
  {
    name: "today-all-clear",
    path: "/today",
    ready: todayReady,
    ...ONE,
    act: async (page) => {
      const clear = page.getByText("Nothing needs you today.")
      for (let n = 0; n < 400 && !(await clear.isVisible()); n += 1) {
        const next = page.locator("[data-primary]:not([disabled])").first()
        if (await next.isVisible()) await next.click()
        await page.waitForTimeout(80)
      }
      if (!(await clear.isVisible())) {
        const left = await page.locator("[data-row]").allInnerTexts()
        throw new Error(`rows left: ${left.join(" | ").replace(/\n/g, " ")}`)
      }
    },
  },

  // The board's interactions. Overlays are viewport-only (`full: false`).
  {
    name: "board-new-task",
    path: DISPATCH,
    ready: board,
    ...ONE,
    full: false,
    act: async (page) => {
      await page.getByRole("button", { name: "New task" }).click()
      await dialog(page, "New task").waitFor()
    },
  },
  {
    name: "board-edit-task",
    path: DISPATCH,
    ready: board,
    ...ONE,
    full: false,
    act: async (page) => {
      await card(page, REPLAY).click()
      await dialog(page, "Edit task").waitFor()
    },
  },
  {
    name: "board-ask-blocker",
    path: DISPATCH,
    ready: board,
    ...ONE,
    full: false,
    act: async (page) => {
      await openMenu(page, REPLAY)
      await page.getByRole("menuitem", { name: "Blocked" }).click()
      await page.getByRole("dialog").waitFor()
    },
  },
  {
    name: "board-card-menu",
    path: DISPATCH,
    ready: board,
    full: false,
    act: (page) => openMenu(page, REPLAY),
  },
  {
    name: "board-done-open",
    path: DISPATCH,
    ready: board,
    ...ONE,
    act: async (page) => {
      await page.getByRole("button", { name: /^Done/ }).click()
      await page.getByRole("button", { name: /^Show all/ }).waitFor()
    },
  },
  {
    name: "board-summary-blocked",
    path: DISPATCH,
    ready: board,
    sizes: ["1024"],
    themes: ["light"],
    full: false,
    act: async (page) => {
      await page.getByRole("button", { name: /\d+ blocked/ }).click()
      await page.waitForTimeout(700)
    },
  },
  // A long title with the card hovered: the menu button must not cover it (DESIGN.md, Board).
  {
    name: "board-hover-card",
    path: DISPATCH,
    ready: board,
    sizes: FINE,
    themes: ["light", "dark"],
    full: false,
    act: async (page) => {
      await card(page, REPLAY).scrollIntoViewIfNeeded()
      await card(page, REPLAY).hover()
    },
  },
  // The failed-write states, with the mock switched to refuse every write.
  {
    name: "board-move-refused",
    path: DISPATCH,
    ready: board,
    ...ONE,
    failWrites: true,
    act: async (page) => {
      await openMenu(page, REPLAY)
      await page.getByRole("menuitem", { name: "In progress" }).click()
      await page.getByRole("alert").waitFor()
    },
  },
  {
    name: "board-save-refused",
    path: DISPATCH,
    ready: board,
    ...ONE,
    failWrites: true,
    full: false,
    act: async (page) => {
      await card(page, REPLAY).click()
      const edit = dialog(page, "Edit task")
      await edit.getByRole("button", { name: "Save" }).click()
      await edit.getByRole("alert").waitFor()
    },
  },

  // Starting an engagement: the first company, then what to do on its page, then the project.
  {
    name: "companies-empty",
    path: "/",
    emptyWorkspace: true,
    ready: (page) => page.getByText("Add your first company"),
  },
  {
    name: "company-new",
    path: "/",
    ready: heading("Companies"),
    full: false,
    act: newCompany,
  },
  {
    name: "company-new-invalid",
    path: "/",
    ready: heading("Companies"),
    ...ONE,
    full: false,
    act: async (page) => {
      await newCompany(page)
      await dialog(page, "New company").getByRole("button", { name: "Create company" }).click()
      await dialog(page, "New company").getByRole("alert").waitFor()
    },
  },
  // Made through the form, from an empty workspace: it opens on its page, with what to do next.
  {
    name: "company-created",
    path: "/",
    emptyWorkspace: true,
    ready: (page) => page.getByText("Add your first company"),
    act: async (page) => {
      await newCompany(page)
      await fill(page, "New company", "Name", "Orion Rail")
      await fill(page, "New company", "Industry", "Transport")
      await fill(page, "New company", "Region", "UK")
      await dialog(page, "New company").getByRole("button", { name: "Create company" }).click()
      await page.getByText(/No stakeholders yet/).waitFor()
    },
  },
  {
    name: "company-edit",
    path: KESTREL,
    ready: company,
    ...ONE,
    full: false,
    act: async (page) => {
      await button(page, "Edit company").click()
      await dialog(page, "Edit company").waitFor()
    },
  },
  {
    name: "company-edit-refused",
    path: KESTREL,
    ready: company,
    ...ONE,
    failWrites: true,
    full: false,
    act: async (page) => {
      await button(page, "Edit company").click()
      await fill(page, "Edit company", "Industry", "Freight")
      await dialog(page, "Edit company").getByRole("button", { name: "Save" }).click()
      await dialog(page, "Edit company").getByRole("alert").waitFor()
    },
  },
  {
    name: "project-new",
    path: KESTREL,
    ready: company,
    ...ONE,
    full: false,
    act: async (page) => {
      await button(page, "New project").click()
      await dialog(page, "New project").waitFor()
    },
  },
  {
    name: "project-created",
    path: KESTREL,
    ready: company,
    ...ONE,
    act: async (page) => {
      await button(page, "New project").click()
      await fill(page, "New project", "Name", "Depot rules audit")
      await dialog(page, "New project").getByRole("button", { name: "Create project" }).click()
      await page.getByText("A new project. Start here.").waitFor()
    },
  },
  {
    name: "project-edit",
    path: DISPATCH,
    ready: board,
    ...ONE,
    full: false,
    act: async (page) => {
      await button(page, "Edit project").click()
      await dialog(page, "Edit project").waitFor()
    },
  },
  {
    name: "stakeholder-add",
    path: KESTREL,
    ready: company,
    ...ONE,
    full: false,
    act: async (page) => {
      await button(page, "Add stakeholder").click()
      await dialog(page, "Add stakeholder").waitFor()
    },
  },
  {
    name: "stakeholder-edit",
    path: KESTREL,
    ready: company,
    full: false,
    act: async (page) => {
      await button(page, "Edit Ines Moreau").click()
      await dialog(page, "Edit stakeholder").waitFor()
    },
  },
  {
    name: "stakeholder-remove-ask",
    path: KESTREL,
    ready: company,
    ...ONE,
    full: false,
    act: async (page) => {
      await button(page, "Edit Ines Moreau").click()
      await button(page, "Remove stakeholder").click()
      await page.getByRole("group", { name: "Confirm the removal" }).waitFor()
    },
  },
  {
    name: "system-edit",
    path: KESTREL,
    ready: company,
    ...ONE,
    full: false,
    act: async (page) => {
      await button(page, "Edit Planning database").click()
      await dialog(page, "Edit system").waitFor()
    },
  },
  // Signed off by the sponsor, so the API refuses: the reason stays in the dialog.
  {
    name: "stakeholder-remove-refused",
    path: KESTREL,
    ready: company,
    ...ONE,
    full: false,
    act: async (page) => {
      await button(page, "Edit Mara Lindqvist").click()
      await button(page, "Remove stakeholder").click()
      await page
        .getByRole("group", { name: "Confirm the removal" })
        .getByRole("button", { name: "Remove", exact: true })
        .click()
      await dialog(page, "Edit stakeholder").getByRole("alert").waitFor()
    },
  },

  { name: "run-review", path: `${DISPATCH}/runs/run_k2`, ready: (page) => page.getByRole("main") },
  {
    name: "jump-to",
    path: "/",
    ready: heading("Companies"),
    ...ONE,
    full: false,
    act: async (page) => {
      await page.keyboard.press("Control+k")
      await page.getByRole("dialog").waitFor()
    },
  },
]
