// Runs inside the Playwright container (started by run.mjs): opens each screen in screens.mjs at
// each size and theme and writes a PNG. Exits 1 when any screen fails to render.
import { createRequire } from "node:module"
import { SIZES, THEMES, screens } from "./screens.mjs"

const { chromium } = createRequire("/pw/")("playwright-core")
const { url, out, only } = JSON.parse(process.env.FDE_SHOTS ?? "{}")

// ponytail: a page taller than this is cut off; the board is nowhere near it.
const MAX_HEIGHT = 12000

const wanted = screens.filter((s) => only.length === 0 || only.some((o) => s.name.includes(o)))
if (wanted.length === 0) {
  console.error(`No screen matches ${only.join(", ")}.`)
  process.exit(2)
}

// The container has no sandbox user to give Chromium; it is a throwaway on a dev machine.
const browser = await chromium.launch({ args: ["--no-sandbox"] })
const failures = []
let taken = 0

async function shoot(screen, size, theme) {
  const name = `${screen.name}-${size.name}-${theme}`
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    colorScheme: theme,
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
    isMobile: size.touch === true,
    hasTouch: size.touch === true,
  })
  // The dev server compiles a route's modules on its first visit, which can take more than
  // Playwright's 30s default on a small machine: every navigation and wait gets 60s.
  context.setDefaultTimeout(60000)
  const page = await context.newPage()
  const problems = []
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`))
  // Before the app's own code runs, so the mock seeds a workspace with no company.
  if (screen.emptyWorkspace)
    await page.addInitScript(() => (globalThis.__fdeMockNoCompanies = true))
  // Reads of the stage checklist say everything is met, so the stale-view refusal can be shown.
  if (screen.staleChecklist)
    await page.addInitScript(() => (globalThis.__fdeMockStaleChecklist = true))
  // The API serves no eval routes (no sandbox gateway): they answer 404, so the Proof card says so.
  if (screen.evalsOff) await page.addInitScript(() => (globalThis.__fdeMockEvalsOff = true))
  // The new workspace (issue #209) on for this tab, as `VITE_FDE_WORKSPACE=1` would be for a build.
  if (screen.workspace) await page.addInitScript(() => (globalThis.__fdeMockWorkspace = true))
  // A sign-in waiting at a step, as a password sign-in leaves it.
  if (screen.pendingStep)
    await page.addInitScript((step) => (globalThis.__fdeMockPendingStep = step), screen.pendingStep)
  try {
    const response = await page.goto(url + (screen.signedOut ? screen.path : "/today"))
    if (response && response.status() >= 400) problems.push(`HTTP ${response.status()}`)
    if (!screen.signedOut) {
      // The mock's sign-in is one click and keeps the session for this tab. Either the app shows (a
      // session is there) or the sign-in card does; wait for whichever comes first.
      // With our own sign-in screens on (VITE_FDE_OWN_SIGN_IN=1), the mock's sample account signs in.
      const canvas = page.locator(".app-canvas")
      const continueButton = page.getByRole("button", { name: "Continue" })
      const email = page.getByLabel("Email", { exact: true })
      await canvas.or(continueButton).or(email).first().waitFor()
      if (await continueButton.isVisible()) {
        await continueButton.click()
        await canvas.waitFor()
      } else if (await email.isVisible()) {
        await email.fill("riya@example.com")
        await page.getByLabel("Password", { exact: true }).fill("sample-password")
        await page.getByRole("button", { name: "Sign in", exact: true }).click()
        await canvas.waitFor()
      }
      await page.goto(url + screen.path)
    }
    await screen.ready(page).waitFor({ state: "visible" })
    await page.evaluate(() => document.fonts.ready)
    if (screen.failWrites) await page.evaluate(() => (globalThis.__fdeMockFailWrites = true))
    if (screen.act) await screen.act(page)

    if (screen.full !== false) {
      // The canvas scrolls, not the page: grow the window by what is hidden in it. Cards that load
      // late make the page taller once it is bigger, so measure until it stops growing.
      let height = size.height
      for (let pass = 0; pass < 4; pass += 1) {
        await page.waitForTimeout(300)
        const hidden = await page.evaluate(() => {
          const canvas = document.querySelector(".app-canvas")
          return canvas ? canvas.scrollHeight - canvas.clientHeight : 0
        })
        if (hidden <= 0) break
        height = Math.min(height + hidden, MAX_HEIGHT)
        await page.setViewportSize({ width: size.width, height })
      }
    }
    await page.waitForTimeout(150)
    if (problems.length > 0) throw new Error(problems.join("; "))
    await page.screenshot({ path: `${out}/${name}.png` })
    taken += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}: ${String(error.message).split("\n")[0]}`)
    // What it looked like when it failed, kept next to the rest.
    await page.screenshot({ path: `${out}/${name}-FAILED.png` }).catch(() => {})
  } finally {
    await context.close()
  }
}

for (const screen of wanted)
  for (const size of SIZES.filter((s) => !screen.sizes || screen.sizes.includes(s.name)))
    for (const theme of THEMES.filter((t) => !screen.themes || screen.themes.includes(t)))
      await shoot(screen, size, theme)

await browser.close()
console.log(`${taken} screenshots, ${failures.length} failed`)
process.exit(failures.length > 0 ? 1 : 0)
