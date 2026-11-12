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
//   staleChecklist true: reads of a project's stage checklist say everything is met (the mock's
//             `__fdeMockStaleChecklist`, set before the app loads), so the stale-view refusal can be shown
//   (a screen can make someone else change a record between its open and its save with the mock's
//   `__fdeMockSomeoneElse`, set from `act`, to show a stale save)
//   evalsOff  true: the API serves no eval routes, as where no sandbox gateway is set (the mock's
//             `__fdeMockEvalsOff`, set before the app loads)
//   signedOut true: no sign-in first (the sign-in screens themselves)
//   workspace true: the new workspace (issue #209) on for this tab, whatever the dev server's
//             VITE_FDE_WORKSPACE (the mock's `__fdeMockWorkspace`, set before the app loads)
//   pendingStep "verify_email" or "choose_organisation": the mock starts with a sign-in waiting at that
//             step, as Google's callback leaves it (the mock's `__fdeMockPendingStep`, set before the app loads)
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

// The scope and success criteria. Each state is the viewport with the two cards scrolled to the top,
// so they are seen as a person sees them; `full` keeps whole pages for the one that shows the layout.
const BW_REFERRALS = "/companies/cmp_brightwater/projects/prj_bw_referrals"
const ATLAS_FNOL = "/companies/cmp_atlas/projects/prj_atlas_fnol"
const KESTREL_CLAIMS = `${KESTREL}/projects/prj_kestrel_claims`
const scopeCard = (page) => page.getByRole("region", { name: "Scope", exact: true })
const criteriaCard = (page) => page.getByRole("region", { name: "Success criteria", exact: true })
const scopeReady = (page) => scopeCard(page)
const toScope = (page) =>
  scopeCard(page).evaluate((el) => {
    el.scrollIntoView({ block: "start" })
    // A little air above the cards, as a person who scrolled to them would leave it.
    document.querySelector(".app-canvas")?.scrollBy(0, -16)
  })
const SCOPE = { ready: scopeReady, full: false }

// The stage checklist (DESIGN.md §3). Kestrel's claims project starts in Discover with no scope written.
const COBALT_FIELD = "/companies/cmp_cobalt/projects/prj_cobalt_field"
const checklistRegion = (page, stage) => page.getByRole("region", { name: `To leave ${stage}` })
const confirmation = (page) => page.getByRole("group", { name: "Confirm the move" })
const TOP = { full: false }
/** Moves a project forward with a reason, so the next stage's checklist (all open) can be seen. */
async function moveOn(page, to, reason) {
  await button(page, `Move to ${to}`).click()
  await confirmation(page)
    .getByLabel(/Why are you moving on/)
    .fill(reason)
  await confirmation(page).getByRole("button", { name: "Move with items open" }).click()
  await confirmation(page).waitFor({ state: "detached" })
}
const askToMove = async (page) => {
  await button(page, "Move to Access").click()
  await confirmation(page)
    .getByLabel(/Why are you moving on/)
    .waitFor()
}

function checklistScreens() {
  return [
    // One item open, two met: the common case.
    {
      name: "checklist-open",
      path: ATLAS_FNOL,
      ready: (page) => checklistRegion(page, "Scope"),
      ...TOP,
    },
    // Nothing done yet at Scope: every item open, each with the button to where it is fixed.
    {
      name: "checklist-open-all",
      path: KESTREL_CLAIMS,
      ready: (page) => checklistRegion(page, "Discover"),
      ...TOP,
      act: async (page) => {
        await moveOn(page, "Scope", "The customer has no notes yet; we start from the kickoff call")
        await checklistRegion(page, "Scope").waitFor()
      },
    },
    // Every item met: one quiet line.
    {
      name: "checklist-met",
      path: DISPATCH,
      ready: (page) => page.getByText(/Ready to leave Build/),
      ...TOP,
    },
    // Deploy has nothing to check yet: the page shows nothing.
    {
      name: "checklist-none",
      path: COBALT_FIELD,
      ready: (page) => button(page, "Move back to Evaluate"),
      ...TOP,
    },
    {
      name: "move-confirm-open",
      path: ATLAS_FNOL,
      ready: (page) => checklistRegion(page, "Scope"),
      ...TOP,
      act: askToMove,
    },
    {
      name: "move-reason-typed",
      path: ATLAS_FNOL,
      ready: (page) => checklistRegion(page, "Scope"),
      ...TOP,
      act: async (page) => {
        await askToMove(page)
        await confirmation(page)
          .getByLabel(/Why are you moving on/)
          .fill("Daniel Osei will sign off on Monday; the scope will not change before then.")
      },
    },
    {
      name: "move-reason-invalid",
      path: ATLAS_FNOL,
      ready: (page) => checklistRegion(page, "Scope"),
      ...TOP,
      act: async (page) => {
        await askToMove(page)
        await confirmation(page).getByRole("button", { name: "Move with items open" }).click()
        await confirmation(page).getByRole("alert").waitFor()
      },
    },
    // The page thought nothing was open; the API found one, so the reason is asked for then.
    {
      name: "move-stale-409",
      path: ATLAS_FNOL,
      ready: (page) => page.getByText(/Ready to leave Scope/),
      staleChecklist: true,
      ...TOP,
      act: async (page) => {
        await button(page, "Move to Access").click()
        await confirmation(page).getByRole("button", { name: "Move", exact: true }).click()
        await confirmation(page)
          .getByLabel(/Why are you moving on/)
          .waitFor()
      },
    },
  ]
}

const FINE = ["1440", "1024"]
const ONE = { sizes: ["1440", "390"], themes: ["light"] }

// Access and decisions (DESIGN.md §3). Each state scrolls its card to the top of the viewport, as a person
// who went to it would see it. Kestrel's dispatch project has a denied request that blocks a task, one in
// progress and one granted; Brightwater's referrals has two open requests, one for 11 days (a long wait).
const COBALT_OUTAGE = "/companies/cmp_cobalt/projects/prj_cobalt_outage"
const accessCard = (page) => page.getByRole("region", { name: "Access", exact: true })
const decisionsCard = (page) => page.getByRole("region", { name: "Decisions", exact: true })
const toCard = (find) => (page) =>
  find(page).evaluate((el) => {
    el.scrollIntoView({ block: "start" })
    document.querySelector(".app-canvas")?.scrollBy(0, -16)
  })
const accessRow = (page, text) => accessCard(page).getByRole("listitem").filter({ hasText: text })
async function openAccessForm(page) {
  await toCard(accessCard)(page)
  await accessCard(page).getByRole("button", { name: "Request access", exact: true }).click()
  await dialog(page, "Request access").waitFor()
}
async function openDecisionForm(page) {
  await toCard(decisionsCard)(page)
  await decisionsCard(page).getByRole("button", { name: "Log a decision", exact: true }).click()
  await dialog(page, "Log a decision").waitFor()
}
async function fillAccessForm(page) {
  const box = dialog(page, "Request access")
  await box.getByLabel("What access is needed").fill("Driver hours, read only")
  await box.getByLabel("Which system").selectOption({ label: "Planning database" })
  await box
    .getByLabel("Who at the customer owns it")
    .selectOption({ label: "Ines Moreau, Dispatch lead, Ghent" })
  return box
}
async function fillDecisionForm(page) {
  const box = dialog(page, "Log a decision")
  await box.getByLabel("What was decided").fill("Start with the Ghent depot only")
  await box
    .getByLabel("Why")
    .fill("It has the cleanest order data.\nThe rest follow once plans are accepted.")
  await box.getByLabel("Who decided").fill("Mara Lindqvist")
  return box
}
const ACCESS = { ready: (page) => accessCard(page), full: false }
const DECISIONS = { ready: (page) => decisionsCard(page), full: false }

function accessScreens() {
  return [
    // Denied first, with the task it blocks; the glance says what is left, who holds it and for how long.
    { name: "access-chasing", path: DISPATCH, ...ACCESS, act: toCard(accessCard) },
    // Two open requests, one waiting 11 days: the long wait is amber.
    { name: "access-long-wait", path: BW_REFERRALS, ...ACCESS, act: toCard(accessCard) },
    // Everything granted is one quiet line.
    { name: "access-all-granted", path: COBALT_OUTAGE, ...ACCESS, act: toCard(accessCard) },
    { name: "access-empty", path: KESTREL_CLAIMS, ...ACCESS, act: toCard(accessCard) },
    {
      name: "access-menu",
      path: DISPATCH,
      ...ACCESS,
      act: async (page) => {
        await toCard(accessCard)(page)
        await accessRow(page, "Depot rules")
          .getByRole("button", { name: /^Actions for/ })
          .click()
        await page.getByRole("menu").waitFor()
      },
    },
    {
      name: "access-request-form",
      path: DISPATCH,
      ...ACCESS,
      act: async (page) => {
        await openAccessForm(page)
        await fillAccessForm(page)
      },
    },
    // Nothing typed: the problem is at its field, which has the keyboard.
    {
      name: "access-request-problem",
      path: DISPATCH,
      ...ACCESS,
      act: async (page) => {
        await openAccessForm(page)
        const box = dialog(page, "Request access")
        await box.getByRole("button", { name: "Request access", exact: true }).click()
        await box.getByRole("alert").waitFor()
      },
    },
    // The API refuses: what was typed stays, and the refusal is said in the dialog.
    {
      name: "access-request-refused",
      path: DISPATCH,
      ...ACCESS,
      failWrites: true,
      act: async (page) => {
        await openAccessForm(page)
        const box = await fillAccessForm(page)
        await box.getByRole("button", { name: "Request access", exact: true }).click()
        await box.getByRole("alert").waitFor()
      },
    },
    {
      name: "access-edit-form",
      path: DISPATCH,
      ...ACCESS,
      act: async (page) => {
        await toCard(accessCard)(page)
        await accessRow(page, "Depot rules")
          .getByRole("button", { name: /^Actions for/ })
          .click()
        await page.getByRole("menuitem", { name: "Edit request" }).click()
        await dialog(page, "Edit access request").waitFor()
      },
    },
    // A move the API refuses stays where it was, and says why in the row.
    {
      name: "access-move-refused",
      path: DISPATCH,
      ...ACCESS,
      failWrites: true,
      act: async (page) => {
        await toCard(accessCard)(page)
        await accessRow(page, "Depot rules")
          .getByRole("button", { name: /^Mark granted/ })
          .click()
        await accessRow(page, "Depot rules").getByRole("alert").waitFor()
      },
    },
    // The blocked prompt offers the project's requests that are not granted.
    {
      name: "blocked-prompt-access",
      path: DISPATCH,
      ready: (page) => board(page),
      full: false,
      act: async (page) => {
        await openMenu(page, REPLAY)
        await page.getByRole("menuitem", { name: "Blocked" }).click()
        await dialog(page, "What is blocking this?").waitFor()
        await dialog(page, "What is blocking this?")
          .getByLabel("The blocker")
          .fill("Needs the depot rules")
        await dialog(page, "What is blocking this?")
          .getByLabel("Blocked by an access request")
          .selectOption({ label: "Depot rules, read only (in progress)" })
      },
    },
    // The log, newest first, with a decision promoted from a discussion.
    { name: "decisions-card", path: DISPATCH, ...DECISIONS, act: toCard(decisionsCard) },
    { name: "decisions-empty", path: KESTREL_CLAIMS, ...DECISIONS, act: toCard(decisionsCard) },
    {
      name: "decision-form",
      path: DISPATCH,
      ...DECISIONS,
      act: async (page) => {
        await openDecisionForm(page)
        await fillDecisionForm(page)
      },
    },
    {
      name: "decision-problem",
      path: DISPATCH,
      ...DECISIONS,
      act: async (page) => {
        await openDecisionForm(page)
        const box = await fillDecisionForm(page)
        await box.getByLabel("Why").fill("")
        await box.getByRole("button", { name: "Log decision", exact: true }).click()
        await box.getByRole("alert").waitFor()
      },
    },
  ]
}

// Meeting notes (#162). Kestrel's dispatch project has two notes, the first a long one with actions and an
// agreement in it; its damage claims project is at Discover with none, so its checklist asks for one.
const notesCard = (page) => page.getByRole("region", { name: "Notes", exact: true })
const NOTES = { ready: (page) => notesCard(page), full: false }
const WORKSHOP = "Dispatcher workshop, Leeds depot"
const NOTE_TEXT = [
  "Call with the claims team, 40 minutes.",
  "",
  "Most claims arrive by email with photos attached. About a third are missing the depot code.",
  "- Send Ines the triage format for review",
  "- Ask Tomas which mailbox the claims arrive in",
  "",
  "Agreed: we start with damage claims only, and leave lost-goods claims for later.",
].join("\n")
async function openWriter(page) {
  await toCard(notesCard)(page)
  await notesCard(page).getByRole("button", { name: "Write a note", exact: true }).click()
  await dialog(page, "Write a note").waitFor()
  // The cursor starts in the words, where the writing is.
  const at = await page.evaluate(() => document.activeElement?.getAttribute("data-field"))
  if (at !== "body") throw new Error(`focus is on ${at ?? "nothing"}, not the note`)
}
async function writeNote(page) {
  await openWriter(page)
  const box = dialog(page, "Write a note")
  await box.getByLabel("Title", { exact: true }).fill("Claims team call")
  await box.getByLabel("Note", { exact: true }).fill(NOTE_TEXT)
  await box.getByRole("checkbox", { name: /Ines Moreau/ }).check()
  return box
}
/** Opens the long note to read it, and selects its agreement the way a person would. */
async function readWorkshop(page) {
  await toCard(notesCard)(page)
  await notesCard(page).getByRole("button", { name: WORKSHOP, exact: true }).click()
  await page.evaluate(() => {
    const root = document.querySelector('[data-note-body="mtg_kd1"]')
    const text = root.firstChild
    const part =
      "We pilot at Leeds and Ghent only, plans stay drafts and nothing goes to drivers directly."
    const from = text.data.indexOf(part)
    const range = document.createRange()
    range.setStart(text, from)
    range.setEnd(text, from + part.length)
    const picked = window.getSelection()
    picked.removeAllRanges()
    picked.addRange(range)
  })
  await toCard(notesCard)(page)
}

function notesScreens() {
  return [
    // The list, newest first: when, who from the team and who from the customer, and the first lines.
    { name: "notes-card", path: DISPATCH, ...NOTES, act: toCard(notesCard) },
    { name: "notes-empty", path: KESTREL_CLAIMS, ...NOTES, act: toCard(notesCard) },
    // A note opened to read, a line of it selected, and the way on from it.
    {
      name: "notes-reading",
      path: DISPATCH,
      ...NOTES,
      act: async (page) => {
        await readWorkshop(page)
        await notesCard(page)
          .getByRole("button", { name: /^Make a task from/ })
          .waitFor()
      },
    },
    {
      name: "notes-company",
      path: KESTREL,
      ...NOTES,
      ready: (page) => notesCard(page),
      act: toCard(notesCard),
    },
    // The checklist's item now has its button.
    {
      name: "checklist-write-note",
      path: KESTREL_CLAIMS,
      ready: (page) => checklistRegion(page, "Discover"),
      act: async (page) => {
        await checklistRegion(page, "Discover").scrollIntoViewIfNeeded()
      },
    },
    { name: "note-write-blank", path: KESTREL_CLAIMS, ...NOTES, act: openWriter },
    { name: "note-write", path: KESTREL_CLAIMS, ...NOTES, act: writeNote },
    {
      name: "note-write-problem",
      path: KESTREL_CLAIMS,
      ...NOTES,
      act: async (page) => {
        const box = await writeNote(page)
        await box.getByLabel("Title", { exact: true }).fill("")
        await box.getByRole("button", { name: "Save note", exact: true }).click()
        await box.getByRole("alert").waitFor()
      },
    },
    // The API cannot save: every word is still in the form, and it says what happened.
    {
      name: "note-write-refused",
      path: KESTREL_CLAIMS,
      ...NOTES,
      failWrites: true,
      act: async (page) => {
        const box = await writeNote(page)
        await box.getByRole("button", { name: "Save note", exact: true }).click()
        await box.getByRole("alert").waitFor()
      },
    },
    // Closing with words in it asks first.
    {
      name: "note-write-discard",
      path: KESTREL_CLAIMS,
      ...NOTES,
      act: async (page) => {
        const box = await writeNote(page)
        await box.getByRole("button", { name: "Cancel", exact: true }).click()
        await box.getByRole("alertdialog", { name: "Confirm leaving the note" }).waitFor()
      },
    },
    {
      name: "note-edit",
      path: DISPATCH,
      ...NOTES,
      act: async (page) => {
        await toCard(notesCard)(page)
        await page.getByRole("button", { name: `Edit ${WORKSHOP}` }).click()
        await dialog(page, "Edit note").waitFor()
      },
    },
    {
      name: "note-delete-ask",
      path: DISPATCH,
      ...NOTES,
      act: async (page) => {
        await toCard(notesCard)(page)
        await page.getByRole("button", { name: `Edit ${WORKSHOP}` }).click()
        await dialog(page, "Edit note").getByRole("button", { name: "Delete note" }).click()
        await dialog(page, "Edit note").getByRole("group", { name: "Confirm the delete" }).waitFor()
      },
    },
    // While writing: the task form opens on the line the cursor is on, over the note that stays as it was.
    {
      name: "note-make-task",
      path: KESTREL_CLAIMS,
      ...NOTES,
      act: async (page) => {
        const box = await writeNote(page)
        // The cursor on the first action, as if the FDE had clicked into that line.
        await page.evaluate(() => {
          const el = document.querySelector('textarea[data-field="body"]')
          const at = el.value.indexOf("Send Ines")
          el.focus()
          el.setSelectionRange(at + 4, at + 4)
        })
        await box.getByRole("button", { name: "Make a task", exact: true }).click()
        await dialog(page, "New task").waitFor()
      },
    },
    // While reading: the decision form opens on the selected agreement.
    {
      name: "note-make-decision",
      path: DISPATCH,
      ...NOTES,
      act: async (page) => {
        await readWorkshop(page)
        await page.getByRole("button", { name: `Log a decision from ${WORKSHOP}` }).click()
        await dialog(page, "Log a decision").waitFor()
      },
    },
    // Back in the note once the task is on the board.
    {
      name: "note-made-task",
      path: KESTREL_CLAIMS,
      ...NOTES,
      act: async (page) => {
        const box = await writeNote(page)
        await box.getByRole("button", { name: "Make a task", exact: true }).click()
        const task = dialog(page, "New task")
        await task.getByLabel("Title").fill("Send Ines the triage format")
        await task.getByRole("button", { name: "Add task", exact: true }).click()
        await box.getByRole("status", { name: "Made from this note" }).waitFor()
      },
    },
    // A revoked request that had been granted: the line says when it was granted and how long that took.
    {
      name: "access-revoked-wording",
      path: "/companies/cmp_cobalt/projects/prj_cobalt_field",
      ...ACCESS,
      act: toCard(accessCard),
    },
  ]
}

// Documents and search (#174). Kestrel has five documents (one being read, one that could not be, three
// ready); Atlas has none. Files are made in the page: nothing is read from disk.
const documentsCard = (page) => page.getByRole("region", { name: "Documents", exact: true })
const DOCS = { ready: (page) => documentsCard(page), full: false }
const searchBox = (page) => documentsCard(page).getByRole("searchbox")
/** Chooses a file in the upload dialog from bytes made here, as the browser would from disk. */
async function chooseFile(page, name, mimeType, size = 48_000) {
  await dialog(page, "Upload a document")
    .getByLabel("File", { exact: true })
    .setInputFiles({ name, mimeType, buffer: Buffer.alloc(size, 97) })
}
async function openUpload(page) {
  await listed(page)
  await documentsCard(page).getByRole("button", { name: "Upload a document", exact: true }).click()
  await dialog(page, "Upload a document").waitFor()
}
const uploadButton = (page) =>
  dialog(page, "Upload a document").getByRole("button", { name: "Upload", exact: true })
async function search(page, words) {
  await listed(page)
  await searchBox(page).fill(words)
}

/** Waits for the list to be read (the card gets taller), then scrolls to the card as a person would. */
async function listed(page) {
  await documentsCard(page)
    .getByRole("list", { name: "Documents" })
    .or(documentsCard(page).getByText(/No documents yet/))
    .waitFor()
  await toCard(documentsCard)(page)
}

function documentsScreens() {
  return [
    // The list: a document being read, one that could not be, and ready ones, each said in words.
    { name: "documents-card", path: KESTREL, ...DOCS, act: listed },
    { name: "documents-empty", path: `/companies/cmp_atlas`, ...DOCS, act: listed },
    // The form, with a file chosen: the name starts from the file's.
    {
      name: "documents-upload",
      path: KESTREL,
      ...DOCS,
      act: async (page) => {
        await openUpload(page)
        await chooseFile(page, "Cold-chain handling procedure.pdf", "application/pdf", 3_400_000)
      },
    },
    // On its way: the bytes that have left, then it waits for the API. Nothing is in the list yet.
    {
      name: "documents-uploading",
      path: KESTREL,
      ...DOCS,
      act: async (page) => {
        await page.evaluate(() => (globalThis.__fdeMockStallUpload = true))
        await openUpload(page)
        await chooseFile(page, "Cold-chain handling procedure.pdf", "application/pdf", 3_400_000)
        await uploadButton(page).click()
        await dialog(page, "Upload a document").getByRole("progressbar").waitFor()
        await page.waitForTimeout(200)
      },
    },
    // The file is too big: said before anything is sent, and tied to the field.
    {
      name: "documents-upload-too-big",
      path: KESTREL,
      ...DOCS,
      act: async (page) => {
        await openUpload(page)
        await chooseFile(page, "Site photos.pdf", "application/pdf", 21 * 1024 * 1024)
        await uploadButton(page).click()
        await dialog(page, "Upload a document").getByRole("alert").waitFor()
      },
    },
    // The API cannot take it: the file and the name are still there to send again.
    {
      name: "documents-upload-refused",
      path: KESTREL,
      ...DOCS,
      failWrites: true,
      act: async (page) => {
        await openUpload(page)
        await chooseFile(page, "Cold-chain handling procedure.pdf", "application/pdf", 3_400_000)
        await uploadButton(page).click()
        await dialog(page, "Upload a document").getByRole("alert").waitFor()
      },
    },
    // Stored, and not searchable yet: the list says so, and what happens next.
    {
      name: "documents-uploaded",
      path: KESTREL,
      ...DOCS,
      act: async (page) => {
        await openUpload(page)
        await chooseFile(page, "Cold-chain handling procedure.pdf", "application/pdf", 3_400_000)
        await uploadButton(page).click()
        await dialog(page, "Upload a document").waitFor({ state: "detached" })
        await page.getByText(/Uploaded “Cold-chain handling procedure.pdf”/).waitFor()
        await toCard(documentsCard)(page)
      },
    },
    // The search, with the words typed marked in each passage and where in the document it is from.
    {
      name: "documents-search",
      path: KESTREL,
      ...DOCS,
      act: async (page) => {
        await search(page, "driver hours")
        await documentsCard(page).getByRole("list", { name: "Search results" }).waitFor()
      },
    },
    // A long passage is cut around the words found, with a way to read all of it.
    {
      name: "documents-search-long",
      path: KESTREL,
      ...DOCS,
      act: async (page) => {
        await search(page, "subprocessor")
        await documentsCard(page).getByRole("button", { name: "Show the whole passage" }).waitFor()
      },
    },
    // Nothing found, and what the search cannot see yet.
    {
      name: "documents-search-none",
      path: KESTREL,
      ...DOCS,
      act: async (page) => {
        await search(page, "zebra")
        await documentsCard(page).getByText("No passages match “zebra”.").waitFor()
      },
    },
  ]
}

// A save refused because the record had moved on (DESIGN.md §3, A stale save). `someoneElse` makes the
// mock change the record between the open and the save (its `__fdeMockSomeoneElse`, once), so each state
// is what a person sees when the record they were working on has been changed by someone else.
const someoneElse = (page, change = true) =>
  page.evaluate((c) => (globalThis.__fdeMockSomeoneElse = c), change)
const STALE_FORM = { full: false }
const staleNotice = (page, name) => dialog(page, name).locator("[data-stale]")

function staleScreens() {
  return [
    // A one-click move on the board: the task is shown as it now is, with the move offered again.
    {
      name: "stale-move-board",
      path: DISPATCH,
      ready: (page) => board(page),
      full: false,
      act: async (page) => {
        await toCard(board)(page)
        await someoneElse(page)
        await openMenu(page, REPLAY)
        await page.getByRole("menuitem", { name: "Done", exact: true }).click()
        await board(page).getByRole("alert").waitFor()
      },
    },
    // Someone made the same move first: only the state is shown, nothing to offer.
    {
      name: "stale-move-already",
      path: DISPATCH,
      ready: (page) => board(page),
      full: false,
      act: async (page) => {
        await toCard(board)(page)
        await someoneElse(page, { status: "done" })
        await openMenu(page, REPLAY)
        await page.getByRole("menuitem", { name: "Done", exact: true }).click()
        await board(page).getByRole("alert").waitFor()
      },
    },
    {
      name: "stale-move-today",
      path: "/today",
      ready: todayReady,
      full: false,
      act: async (page) => {
        await someoneElse(page)
        await page.getByRole("button", { name: `Done: ${DUE_ROW}` }).click()
        await page.getByRole("alert").waitFor()
      },
    },
    {
      name: "stale-move-access",
      path: BW_REFERRALS,
      ...ACCESS,
      act: async (page) => {
        await toCard(accessCard)(page)
        await someoneElse(page)
        await accessRow(page, "Intake form API")
          .getByRole("button", { name: /^Mark granted/ })
          .click()
        await accessRow(page, "Intake form API").getByRole("alert").waitFor()
      },
    },
    // A form keeps what was typed, names the fields that differ, and offers to save on the current version.
    {
      name: "stale-form-task",
      path: DISPATCH,
      ready: (page) => board(page),
      ...STALE_FORM,
      act: async (page) => {
        await card(page, REPLAY).click()
        const box = dialog(page, "Edit task")
        await box.getByLabel("Title").fill(`${REPLAY}, with the March orders`)
        await someoneElse(page)
        await box.getByRole("button", { name: "Save", exact: true }).click()
        await staleNotice(page, "Edit task").waitFor()
      },
    },
    {
      name: "stale-form-stakeholder",
      path: KESTREL,
      ready: company,
      ...STALE_FORM,
      act: async (page) => {
        await button(page, "Edit Mara Lindqvist").click()
        const box = dialog(page, "Edit stakeholder")
        await box.getByLabel("Name", { exact: true }).fill("Mara L. Lindqvist")
        await someoneElse(page)
        await box.getByRole("button", { name: "Save", exact: true }).click()
        await staleNotice(page, "Edit stakeholder").waitFor()
      },
    },
    // Both changed the description: the notice says that saving again replaces theirs.
    {
      name: "stale-form-system-both",
      path: KESTREL,
      ready: company,
      ...STALE_FORM,
      act: async (page) => {
        await button(page, "Edit Planning database").click()
        const box = dialog(page, "Edit system")
        await box.getByLabel("Description").fill("The read replica, refreshed nightly at 02:00.")
        await someoneElse(page)
        await box.getByRole("button", { name: "Save", exact: true }).click()
        await staleNotice(page, "Edit system").waitFor()
      },
    },
    {
      name: "stale-form-criterion",
      path: ATLAS_FNOL,
      ...SCOPE,
      ...STALE_FORM,
      act: async (page) => {
        await toScope(page)
        await button(page, "Edit: Calls with every required field").click()
        const box = dialog(page, "Edit success criterion")
        await box.getByLabel("What must be true").fill("Calls captured with every required field")
        await someoneElse(page)
        await box.getByRole("button", { name: "Save", exact: true }).click()
        await staleNotice(page, "Edit success criterion").waitFor()
      },
    },
    // The access form does not show the status, and the notice says it moved.
    {
      name: "stale-form-access",
      path: BW_REFERRALS,
      ...ACCESS,
      ...STALE_FORM,
      act: async (page) => {
        await toCard(accessCard)(page)
        await accessRow(page, "Intake form API")
          .getByRole("button", { name: /^Actions for/ })
          .click()
        await page.getByRole("menuitem", { name: "Edit request" }).click()
        const box = dialog(page, "Edit access request")
        await box
          .getByLabel("What access is needed")
          .fill("Intake form API, staging and production")
        await someoneElse(page)
        await box.getByRole("button", { name: "Save", exact: true }).click()
        await staleNotice(page, "Edit access request").waitFor()
      },
    },
    // A sign-off of a scope that changed after it was read: what changed, the scope as it is now, and a
    // confirmation to read again before anything is signed.
    {
      name: "stale-signoff",
      path: ATLAS_FNOL,
      ...SCOPE,
      ...STALE_FORM,
      act: async (page) => {
        await toScope(page)
        await scopeCard(page).getByRole("button", { name: "Record sign-off", exact: true }).click()
        const box = dialog(page, "Record sign-off")
        await box.getByLabel("Signed off by").selectOption({ label: "Daniel Osei, Champion" })
        await someoneElse(page, { description: "Windscreen and glass claims" })
        await box.getByRole("button", { name: "Record sign-off", exact: true }).click()
        await staleNotice(page, "Record sign-off").waitFor()
      },
    },
  ]
}

// Proof (DESIGN.md §3). Kestrel's dispatch project has three criteria: one met by imported results (with a trend),
// one not met by runs in the sandbox (one case errored), one with a suite that has not been run. Lumen's forecast is
// met but three weeks old, and has a criterion no suite measures. Atlas's first-notice project has criteria and no
// suite at all.
const LUMEN = "/companies/cmp_lumen/projects/prj_lumen_forecast"
const proofCard = (page) => page.getByRole("region", { name: "Proof", exact: true })
const suitesCard = (page) => page.getByRole("region", { name: "Eval suites", exact: true })
const proofReady = (page) =>
  proofCard(page).getByRole("list", { name: "Success criteria and their proof" })
const PROOF = { ready: proofReady, full: false }
const toProof = toCard(proofCard)
const toSuites = toCard(suitesCard)
const suiteItem = (page, name) =>
  suitesCard(page).getByRole("listitem").filter({ hasText: name }).first()
async function openSuite(page, name) {
  await suiteItem(page, name).getByRole("button", { expanded: false }).first().click()
}
/** Chooses a CSV in an import dialog from text made here. */
async function chooseCsv(page, dialogName, name, text) {
  await dialog(page, dialogName)
    .getByLabel("CSV file", { exact: true })
    .setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text) })
}
const PLAN_IDS = Array.from({ length: 12 }, (_, i) => `plan-${String(i + 1).padStart(2, "0")}`)

function proofScreens() {
  return [
    // The glance: met with a trend, not met, no result yet.
    { name: "proof-card", path: DISPATCH, ...PROOF, act: toProof },
    // Met but old, and a criterion nothing measures yet.
    { name: "proof-stale-and-missing", path: LUMEN, ...PROOF, act: toProof },
    // Nothing measures any criterion: what to do next.
    { name: "proof-no-suite", path: ATLAS_FNOL, ...PROOF, act: toProof },
    // A project with no criteria.
    {
      name: "proof-no-criteria",
      path: KESTREL_CLAIMS,
      ready: (page) => proofCard(page),
      full: false,
      act: toProof,
    },
    // Where the API serves no evals: said plainly, no errors.
    {
      name: "proof-unavailable",
      path: DISPATCH,
      ...PROOF,
      evalsOff: true,
      ready: (page) => proofCard(page).getByText(/Evals are not available/),
      act: toProof,
    },
    // The suites: graders, where outputs come from, the runs, and the latest run's counts.
    {
      name: "proof-suite-open",
      path: DISPATCH,
      ready: (page) => suitesCard(page),
      full: false,
      act: async (page) => {
        await suitesCard(page).getByRole("list", { name: "Eval suites" }).waitFor()
        await openSuite(page, "Driver-hours rules")
        await toSuites(page)
      },
    },
    // A failed case: the input, the output (text, whatever it holds) and each grader's reason.
    {
      name: "proof-failed-case",
      path: DISPATCH,
      ready: (page) => suitesCard(page),
      full: false,
      act: async (page) => {
        await suitesCard(page).getByRole("list", { name: "Eval suites" }).waitFor()
        await openSuite(page, "Plan acceptance")
        const open = suiteItem(page, "Plan acceptance")
        await open.getByRole("button", { name: /^plan-04/ }).click()
        await open
          .getByText(/<b>Depot 4<\/b>/)
          .first()
          .waitFor()
        await open.getByRole("button", { name: /^plan-04/ }).scrollIntoViewIfNeeded()
        await open.getByRole("button", { name: /^plan-04/ }).evaluate((el) => {
          el.scrollIntoView({ block: "start" })
          document.querySelector(".app-canvas")?.scrollBy(0, -16)
        })
      },
    },
    // Started from the web: running until the API says it has finished.
    {
      name: "proof-running",
      path: DISPATCH,
      ...PROOF,
      act: async (page) => {
        await page.evaluate(() => (globalThis.__fdeMockEvalMs = 600000))
        await proofCard(page).getByRole("button", { name: "Run Time to a first draft" }).click()
        await proofCard(page)
          .getByText(/is being graded/)
          .waitFor()
        await toProof(page)
      },
    },
    // A new suite: its criteria, graders and where outputs come from.
    {
      name: "proof-new-suite",
      path: LUMEN,
      ...PROOF,
      full: false,
      act: async (page) => {
        await proofCard(page).getByRole("button", { name: "New eval suite for this" }).click()
        const box = dialog(page, "New eval suite")
        await box.waitFor()
        await box.getByLabel("Name", { exact: true }).fill("Reasons a buyer finds useful")
        await box.getByRole("combobox", { name: "Grader 1" }).selectOption("judge")
        await box
          .getByLabel("Rubric")
          .fill("Each of the three reasons names a store fact a buyer can check.")
      },
    },
    // A file of results with rows the API would refuse: named by row, nothing sent.
    {
      name: "proof-import-refused",
      path: DISPATCH,
      ready: (page) => suitesCard(page),
      full: false,
      act: async (page) => {
        await suitesCard(page).getByRole("list", { name: "Eval suites" }).waitFor()
        await openSuite(page, "Plan acceptance")
        await suiteItem(page, "Plan acceptance")
          .getByRole("button", {
            name: "Import results for Plan acceptance, reviewed by dispatchers",
          })
          .click()
        await chooseCsv(
          page,
          "Import results",
          "results.csv",
          ["case,output", "plan-01,fine", "plan-01,fine again", "plan-99,fine", "plan 3,fine"].join(
            "\n",
          ),
        )
        await dialog(page, "Import results")
          .getByText(/would make the API refuse it/)
          .waitFor()
      },
    },
    // A file that is fine, with four cases it leaves without an output.
    {
      name: "proof-import-ready",
      path: DISPATCH,
      ready: (page) => suitesCard(page),
      full: false,
      act: async (page) => {
        await suitesCard(page).getByRole("list", { name: "Eval suites" }).waitFor()
        await openSuite(page, "Plan acceptance")
        await suiteItem(page, "Plan acceptance")
          .getByRole("button", {
            name: "Import results for Plan acceptance, reviewed by dispatchers",
          })
          .click()
        const rows = PLAN_IDS.slice(0, 8).map((id) => `${id},Plan with every load assigned`)
        await chooseCsv(page, "Import results", "results.csv", ["case,output", ...rows].join("\n"))
        await dialog(page, "Import results")
          .getByText(/have no row/)
          .waitFor()
      },
    },
    // The API cannot take it: the file stays chosen and the reason is in the dialog.
    {
      name: "proof-import-save-refused",
      path: DISPATCH,
      ready: (page) => suitesCard(page),
      full: false,
      failWrites: true,
      act: async (page) => {
        await suitesCard(page).getByRole("list", { name: "Eval suites" }).waitFor()
        await openSuite(page, "Plan acceptance")
        await suiteItem(page, "Plan acceptance")
          .getByRole("button", {
            name: "Import results for Plan acceptance, reviewed by dispatchers",
          })
          .click()
        await chooseCsv(
          page,
          "Import results",
          "results.csv",
          ["case,output", "plan-01,fine"].join("\n"),
        )
        await dialog(page, "Import results")
          .getByText(/Read 1 row/)
          .waitFor()
        await dialog(page, "Import results")
          .getByRole("button", { name: "Grade these results", exact: true })
          .click()
        await dialog(page, "Import results").getByRole("alert").waitFor()
      },
    },
    // The checklist's eval items lead here.
    {
      name: "proof-checklist",
      path: LUMEN,
      ready: (page) => page.getByRole("region", { name: "To leave Evaluate" }),
      full: false,
    },
  ]
}

// Our own sign-in screens (ADR 0007), on the mock's sample accounts (src/dev/mock-sign-in.ts). Each
// screen at every size; each refusal or later state at the widest and at phone width.
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
  async function codeSent(page) {
    await field(page, "Email").fill("riya@example.com")
    await press(page, "Email me a code")
    await title("Enter your code")(page).waitFor()
  }
  async function code(page, value) {
    await codeSent(page)
    await field(page, "Code").fill(value)
    await press(page, "Sign in")
    await alert(page).waitFor()
  }
  const screens = [
    { name: "auth-password", path: "/sign-in", signedOut: true, ready: title("Sign in") },
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
      name: "auth-code-ask",
      path: "/sign-in?step=code",
      signedOut: true,
      ready: title("Sign in with a code"),
    },
    {
      name: "auth-code-enter",
      path: "/sign-in?step=code",
      signedOut: true,
      ready: title("Sign in with a code"),
      act: codeSent,
    },
    {
      name: "auth-code-wrong",
      path: "/sign-in?step=code",
      ...STATE,
      ready: title("Sign in with a code"),
      act: (page) => code(page, "654321"),
    },
    {
      name: "auth-code-expired",
      path: "/sign-in?step=code",
      ...STATE,
      ready: title("Sign in with a code"),
      act: (page) => code(page, "000000"),
    },
    {
      name: "auth-verify-email",
      path: "/sign-in?step=verify-email",
      signedOut: true,
      pendingStep: "verify_email",
      ready: title("Check your email"),
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
    {
      name: "auth-organisation",
      path: "/sign-in?step=organisation",
      signedOut: true,
      pendingStep: "choose_organisation",
      ready: (page) => page.getByRole("list", { name: "Your organisations" }),
    },
    {
      name: "auth-organisation-expired",
      path: "/sign-in?step=organisation",
      ...STATE,
      ready: alert,
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
    {
      name: "auth-forgot",
      path: "/sign-in?step=forgot",
      signedOut: true,
      ready: title("Reset your password"),
    },
    {
      name: "auth-forgot-sent",
      path: "/sign-in?step=forgot",
      ...STATE,
      ready: title("Reset your password"),
      act: async (page) => {
        await field(page, "Email").fill("riya@example.com")
        await press(page, "Email me a reset link")
        await page.getByRole("status").waitFor()
      },
    },
    {
      name: "auth-reset",
      path: "/sign-in?step=reset&token=reset-sample",
      signedOut: true,
      ready: title("Choose a new password"),
    },
    {
      name: "auth-reset-rejected",
      path: "/sign-in?step=reset&token=reset-sample",
      ...STATE,
      ready: title("Choose a new password"),
      act: async (page) => {
        await field(page, "New password").fill("short")
        await press(page, "Change password")
        await page.getByText("That password was refused.").waitFor()
      },
    },
    {
      name: "auth-reset-done",
      path: "/sign-in?step=reset&token=reset-sample",
      ...STATE,
      ready: title("Choose a new password"),
      act: async (page) => {
        await field(page, "New password").fill("a much longer password")
        await press(page, "Change password")
        await title("Password changed")(page).waitFor()
      },
    },
    {
      name: "auth-reset-expired",
      path: "/sign-in?step=reset",
      ...STATE,
      ready: alert,
    },
    {
      name: "auth-invite",
      path: "/sign-in?step=invite&token=invite-sample",
      signedOut: true,
      ready: (page) => field(page, "Your name"),
    },
    {
      name: "auth-invite-missing",
      path: "/sign-in?step=invite&token=invite-sample",
      ...STATE,
      ready: (page) => field(page, "Your name"),
      act: (page) => press(page, "Join and sign in"),
    },
    {
      name: "auth-invite-expired",
      path: "/sign-in?step=invite&token=old",
      ...STATE,
      ready: alert,
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

// The new workspace (issue #209): the welcome screen and a new company made in a conversation, on
// with `workspace: true` whatever the dev server's flag. Desktop and phone, light and dark.
const WORKSPACE = { workspace: true, sizes: ["1440", "390"] }
const question = (name) => (page) => page.getByRole("heading", { name, exact: true })
const conversation = (page) => page.getByRole("region", { name: "Conversation" })
async function cont(page, label = "Continue") {
  await conversation(page).getByRole("button", { name: label, exact: true }).click()
}
/** Answers the conversation's first `n` steps with sample answers. */
async function answer(page, n) {
  const c = conversation(page)
  if (n >= 1) {
    await c.getByLabel("Company name").fill("Orion Rail")
    await c
      .getByLabel("What are you delivering?")
      .fill("Automate claims intake for their freight team.")
    await c.getByLabel("Industry").fill("Transport")
    await c.getByLabel("Region").fill("UK")
    await cont(page)
    await question("How do you want to start?")(page).waitFor()
  }
  if (n >= 2) {
    await c.getByLabel("Main contact at the company").fill("Dana Ortiz")
    await c.getByLabel("What would show it worked?").fill("Claims triaged within two hours")
    await cont(page)
    await question("What may agents do here, and who approves?")(page).waitFor()
  }
  if (n >= 3) {
    await cont(page)
    await question("Who should be invited?")(page).waitFor()
  }
  if (n >= 4) {
    await c.getByLabel("Email of person 1").fill("sam@example.com")
    await c.getByRole("button", { name: "Add a person" }).click()
    await c.getByLabel("Email of person 2").fill("dana.ortiz@example.com")
    await c.getByLabel("Role of person 2").selectOption("sponsor")
    await cont(page)
    await question("Here is a plan to start with. Change anything.")(page).waitFor()
  }
  if (n >= 5) {
    await cont(page, "Use this plan")
    await question("Ready to create Orion Rail?")(page).waitFor()
  }
  // Settle the quiet motion, and leave no field focused.
  await page.evaluate(
    () => document.activeElement instanceof HTMLElement && document.activeElement.blur(),
  )
  await page.waitForTimeout(400)
}
const STEP_NAMES = ["company", "start", "rules", "people", "plan", "review"]

function workspaceScreens() {
  return [
    {
      name: "welcome",
      path: "/",
      ...WORKSPACE,
      sizes: undefined,
      ready: (page) => page.getByRole("button", { name: /^Not now:/ }).first(),
    },
    {
      name: "welcome-empty",
      path: "/",
      ...WORKSPACE,
      emptyWorkspace: true,
      ready: (page) => page.getByRole("button", { name: "Start" }),
    },
    {
      name: "welcome-reply",
      path: "/",
      ...WORKSPACE,
      ready: (page) => page.getByRole("button", { name: /^Not now:/ }).first(),
      act: async (page) => {
        await page
          .getByLabel("What do you want to work on?")
          .fill("We have a new customer to set up")
        await page.keyboard.press("Enter")
        await page.getByText("Let's set it up together.").waitFor()
        await page.waitForTimeout(400)
      },
    },
    ...STEP_NAMES.map((step, i) => ({
      name: `new-company-${i + 1}-${step}`,
      path: "/new-company",
      ...WORKSPACE,
      ready: question("Which company is it, and what are you delivering for them?"),
      act: (page) => answer(page, i),
    })),
    {
      name: "new-company-plan-edited",
      path: "/new-company",
      ...WORKSPACE,
      themes: ["light"],
      ready: question("Which company is it, and what are you delivering for them?"),
      act: async (page) => {
        await answer(page, 4)
        const plan = page.getByRole("list", { name: "Plan" })
        await plan.getByRole("button", { name: "Move “Build” up" }).click()
        await plan.getByRole("button", { name: "Remove “Hand off”" }).click()
        await page.getByLabel("New step").fill("Train the claims team")
        await page.getByLabel("New step").press("Enter")
        await page.getByLabel("New step").blur()
        await page.waitForTimeout(400)
      },
    },
    {
      name: "new-company-summary",
      path: "/new-company",
      ...WORKSPACE,
      sizes: ["390"],
      full: false,
      ready: question("Which company is it, and what are you delivering for them?"),
      act: async (page) => {
        await answer(page, 4)
        await page.getByRole("button", { name: /^Summary/ }).click()
        await page.getByRole("dialog", { name: "Summary" }).waitFor()
        await page.waitForTimeout(500)
      },
    },
  ]
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
  ...workspaceScreens(),
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

  // Scope, success criteria and sign-off: the three sign-off states, the empty states, the forms, a refusal.
  { name: "scope-signed", path: DISPATCH, ready: scopeReady },
  { name: "scope-changed", path: BW_REFERRALS, ...SCOPE, act: toScope },
  { name: "scope-unsigned", path: ATLAS_FNOL, ...SCOPE, act: toScope },
  { name: "scope-empty", path: KESTREL_CLAIMS, ...SCOPE, act: toScope },
  {
    name: "scope-item-add",
    path: KESTREL_CLAIMS,
    ...SCOPE,
    act: async (page) => {
      await toScope(page)
      await button(page, "Add in scope").click()
      await dialog(page, "Add to scope").waitFor()
      await dialog(page, "Add to scope")
        .getByLabel("Description")
        .fill("Sort each incoming damage claim by likely cause\nand name the team it goes to")
    },
  },
  {
    name: "scope-item-edit-signed",
    path: DISPATCH,
    ...SCOPE,
    act: async (page) => {
      await toScope(page)
      await button(page, "Edit: Changing the planning database").click()
      await dialog(page, "Edit scope item").waitFor()
    },
  },
  {
    name: "scope-item-remove-ask",
    path: DISPATCH,
    ...SCOPE,
    ...ONE,
    act: async (page) => {
      await toScope(page)
      await button(page, "Edit: Live re-routing during the day").click()
      await button(page, "Remove item").click()
      await page.getByRole("group", { name: "Confirm the removal" }).waitFor()
    },
  },
  {
    name: "scope-item-invalid",
    path: KESTREL_CLAIMS,
    ...SCOPE,
    ...ONE,
    act: async (page) => {
      await toScope(page)
      await button(page, "Add out of scope").click()
      await dialog(page, "Add to scope").getByRole("button", { name: "Add", exact: true }).click()
      await dialog(page, "Add to scope").getByRole("alert").waitFor()
    },
  },
  {
    name: "criterion-add",
    path: KESTREL_CLAIMS,
    ...SCOPE,
    act: async (page) => {
      await toScope(page)
      await button(page, "Add criterion").click()
      const box = dialog(page, "Add success criterion")
      await box.waitFor()
      await box
        .getByLabel("What must be true")
        .fill("Claims reach the right team the first time, with no one re-routing them")
      await box.getByLabel("What is measured").fill("claims routed correctly")
      await box.getByLabel("Target").fill("85")
      await box.getByLabel("Unit").fill("%")
    },
  },
  {
    name: "criterion-invalid",
    path: KESTREL_CLAIMS,
    ...SCOPE,
    ...ONE,
    act: async (page) => {
      await toScope(page)
      await button(page, "Add criterion").click()
      const box = dialog(page, "Add success criterion")
      await box.getByLabel("What must be true").fill("Fast enough")
      await box.getByLabel("What is measured").fill("seconds per claim")
      await box.getByLabel("Target").fill("ten")
      await box.getByRole("button", { name: "Add criterion", exact: true }).click()
      await box.getByRole("alert").waitFor()
    },
  },
  {
    name: "criterion-edit-signed",
    path: DISPATCH,
    ...SCOPE,
    ...ONE,
    act: async (page) => {
      await toScope(page)
      await button(page, "Edit: Time to a draft plan").click()
      await dialog(page, "Edit success criterion").waitFor()
    },
  },
  {
    name: "signoff-unsigned",
    path: ATLAS_FNOL,
    ...SCOPE,
    act: async (page) => {
      await toScope(page)
      await scopeCard(page).getByRole("button", { name: "Record sign-off", exact: true }).click()
      await dialog(page, "Record sign-off").waitFor()
    },
  },
  {
    name: "signoff-again",
    path: BW_REFERRALS,
    ...SCOPE,
    ...ONE,
    act: async (page) => {
      await toScope(page)
      await button(page, "Sign off again").click()
      await dialog(page, "Sign off again").waitFor()
    },
  },
  {
    name: "signoff-recorded",
    path: ATLAS_FNOL,
    ...SCOPE,
    ...ONE,
    act: async (page) => {
      await toScope(page)
      await scopeCard(page).getByRole("button", { name: "Record sign-off", exact: true }).click()
      const box = dialog(page, "Record sign-off")
      await box.getByLabel("Signed off by").selectOption({ label: "Daniel Osei, Champion" })
      await box.getByRole("button", { name: "Record sign-off", exact: true }).click()
      await page.getByText(/Daniel Osei agreed/).waitFor()
      await toScope(page)
    },
  },
  {
    name: "scope-save-refused",
    path: DISPATCH,
    ...SCOPE,
    ...ONE,
    failWrites: true,
    act: async (page) => {
      await toScope(page)
      await button(page, "Edit: Changing the planning database").click()
      const box = dialog(page, "Edit scope item")
      await box.getByLabel("Description").fill("Changing the planning database schema")
      await box.getByRole("button", { name: "Save", exact: true }).click()
      await box.getByRole("alert").waitFor()
    },
  },

  // Access requests and decisions on the project page.
  ...accessScreens(),
  ...notesScreens(),

  // A company's documents and search over them.
  ...documentsScreens(),

  // A save refused because the record had moved on: a move, each kind of form, a sign-off.
  ...staleScreens(),

  // The stage checklist and the move that asks for a reason. The checklist sits under the stage
  // bar, so each state is the viewport at the top of the page; the move states keep the confirmation in view.
  ...checklistScreens(),

  // Proof: each criterion with its eval results, and the suites and runs behind them.
  ...proofScreens(),

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
