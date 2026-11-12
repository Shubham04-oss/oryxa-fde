import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { NewCompanyConversation } from "./new-company"
import { api } from "@/lib/api/client"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import { releaseKey } from "@/lib/workspace/setup"
import { conversation, press, question, savedList, toPlan, toReview } from "@/test/conversation"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

beforeAll(installWire)
afterEach(() => {
  resetWire()
  releaseKey()
  delete (globalThis as Record<string, unknown>).__fdeMockFailWrites
})

const summary = () => screen.getByRole("complementary", { name: "Summary" })

/** The plan's step titles in order, read from each step's menu button. */
const planTitles = () =>
  within(screen.getByRole("list", { name: "Plan" }))
    .getAllByRole("button", { name: /^Change “/ })
    .map((b) => b.getAttribute("aria-label")!.slice("Change “".length, -1))

/** Opens a step's menu and picks one of its items. */
async function stepMenu(title: string, item: string) {
  const plan = screen.getByRole("list", { name: "Plan" })
  await userEvent.click(within(plan).getByRole("button", { name: `Change “${title}”` }))
  await userEvent.click(await screen.findByRole("menuitem", { name: item }))
}

const focused = () => document.activeElement

const review = savedList
const notSaved = () => within(conversation()).getByRole("region", { name: "Not saved yet" })

/** Where the router went after a setup: the new project's page. */
const PROJECT_PAGE = /^\/companies\/(cmp_new\d+)\/projects\/(prj_new\d+)$/

describe("a new company as a conversation", () => {
  it("saves nothing until the person confirms, then sets it all up in one call and opens the project", async () => {
    const { router } = renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    // Five steps answered, rules and invites among them: not one write yet.
    expect(wire.sent).toEqual([])

    await press("Create company")
    await waitFor(() => expect(router.state.location.pathname).toMatch(PROJECT_PAGE))
    expect(wire.sent).toEqual([
      {
        method: "POST",
        path: "/companies/setup",
        body: {
          company: { name: "Orion Rail", industry: null, region: null, summary: null },
          project: { name: "Claims intake", summary: "Claims intake." },
          stakeholders: [{ name: "Dana Ortiz" }],
          main_contact: 0,
          scope_items: [],
          criteria: [
            {
              description: "Claims triaged in two hours",
              metric: "hours to triage",
              comparator: "at_most",
              target: 2,
              unit: "h",
              baseline: 9,
              proof: null,
            },
          ],
          plan: [
            { title: "Discovery call", stage: "discover", criterion: null },
            { title: "Agree scope and success criteria", stage: "scope", criterion: 0 },
            { title: "Request access to the systems", stage: "access", criterion: null },
            { title: "Build", stage: "build", criterion: null },
            { title: "Evaluate", stage: "evaluate", criterion: 0 },
            { title: "Hand off", stage: "handoff", criterion: null },
          ],
        },
      },
    ])
    expect(wire.keys[0]?.key).toMatch(/^setup-[A-Za-z0-9-]+$/)
    // The project it lands on has the plan, and its first step is the next step.
    const [, company, project] = PROJECT_PAGE.exec(router.state.location.pathname)!
    const scope = { company: CompanyId.parse(company), project: ProjectId.parse(project) }
    expect((await api.project(scope)).next_step?.title).toBe("Discovery call")
  })

  it("says what will be saved, and what will not, with no control for rules or invitations", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    const saved = review()
    for (const text of [
      "Orion Rail",
      "Claims intake",
      "Dana Ortiz",
      "Claims triaged in two hours",
      "Met when hours to triage is at most 2 h. Baseline 9 h.",
      "How it will be proven is not said yet.",
    ])
      expect(within(saved).getByText(text)).toBeInTheDocument()
    expect(within(saved).getByText(/^6 tasks, in this order/)).toBeInTheDocument()
    const later = notSaved()
    expect(within(later).getByText("Rules for agents")).toBeInTheDocument()
    expect(within(later).getByText("1 invitation")).toBeInTheDocument()
    expect(within(later).getByText(/sam@example\.com/)).toBeInTheDocument()
    expect(within(later).getByText("Who a step is with")).toBeInTheDocument()
    expect(within(later).queryAllByRole("button")).toEqual([])
    expect(within(later).queryAllByRole("checkbox")).toEqual([])
    expect(within(later).queryAllByRole("radio")).toEqual([])
  })

  it("sends one request for a double click", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    let release = () => {}
    wire.hold = new Promise<void>((resolve) => (release = resolve))
    const create = within(conversation()).getByRole("button", { name: "Create company" })
    await userEvent.dblClick(create)
    expect(wire.sent).toHaveLength(1)
    release()
    await waitFor(() => expect(within(conversation()).getByRole("button", { name: /Creating/ })))
  })

  it("retries a lost answer with the same key and bytes, and makes one company", async () => {
    const { router } = renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    // The API made it, and the answer never came back.
    wire.lose = 1
    await press("Create company")
    expect(await within(conversation()).findByRole("alert")).toHaveTextContent(
      "may or may not have been saved",
    )
    await press("Try again")
    await waitFor(() => expect(router.state.location.pathname).toMatch(PROJECT_PAGE))
    expect(wire.keys).toHaveLength(2)
    expect(wire.keys[1]).toEqual(wire.keys[0])
    const named = (await api.companies()).companies.filter((c) => c.name === "Orion Rail")
    expect(named).toHaveLength(1)
  })

  it("keeps the key after a lost answer even when an answer then changes, so it makes one company", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    // The API made it, and the answer never came back.
    wire.lose = 1
    await press("Create company")
    await within(conversation()).findByRole("alert")
    // The person changes an answer, and creates again.
    await press("Change: How do you want to start?")
    const target = await screen.findByLabelText("Target")
    await userEvent.clear(target)
    await userEvent.type(target, "1.5")
    await press("Continue")
    await question("Ready to create Orion Rail?")
    await press("Create company")
    await waitFor(() =>
      expect(within(conversation()).getByRole("alert")).toHaveTextContent("Check your companies"),
    )
    expect(wire.keys).toHaveLength(2)
    expect(wire.keys[1]!.key).toBe(wire.keys[0]!.key)
    expect(wire.keys[1]!.text).not.toBe(wire.keys[0]!.text)
    const named = (await api.companies()).companies.filter((c) => c.name === "Orion Rail")
    expect(named).toHaveLength(1)
  })

  it("keeps the key when the page gave up waiting, and the API had made it", async () => {
    renderWithRouter(<NewCompanyConversation giveUpMs={50} />, { at: "/new-company" })
    await toReview()
    // The API makes it, and the answer is slower than the page will wait.
    wire.holdAnswers = new Promise<void>(() => {})
    await press("Create company")
    expect(await within(conversation()).findByRole("alert")).toHaveTextContent(
      "may or may not have been saved",
    )
    wire.holdAnswers = null
    await press("Change: Which company is it, and what are you delivering for them?")
    await userEvent.type(await screen.findByLabelText("Region"), "UK")
    await press("Continue")
    await question("Ready to create Orion Rail?")
    await press("Create company")
    await waitFor(() =>
      expect(within(conversation()).getByRole("alert")).toHaveTextContent("Check your companies"),
    )
    expect(wire.keys.map((k) => k.key)).toEqual([wire.keys[0]!.key, wire.keys[0]!.key])
    const named = (await api.companies()).companies.filter((c) => c.name === "Orion Rail")
    expect(named).toHaveLength(1)
  })

  it("keeps the key across Back and Forward in the tab, so answering again makes no second company", async () => {
    const first = renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    wire.lose = 1
    await press("Create company")
    await within(conversation()).findByRole("alert")
    // Back leaves the page; Forward opens a new conversation in the same tab.
    first.unmount()
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company", keep: true })
    // Answered again, a little differently: a new body, under the same key.
    await toReview("Orion Rail Ltd")
    await press("Create company")
    await waitFor(() =>
      expect(within(conversation()).getByRole("alert")).toHaveTextContent("Check your companies"),
    )
    expect(wire.keys[1]!.key).toBe(wire.keys[0]!.key)
    const names = (await api.companies()).companies.map((c) => c.name)
    expect(names.filter((n) => n.startsWith("Orion Rail"))).toEqual(["Orion Rail"])
  })

  it("settles a setup that answers after the page was left, and frees the key", async () => {
    const page = renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    let answer = () => {}
    wire.holdAnswers = new Promise<void>((resolve) => (answer = resolve))
    await press("Create company")
    await waitFor(() => expect(wire.keys).toHaveLength(1))
    expect(sessionStorage.getItem("fde.setup.key")).toBe(wire.keys[0]!.key)
    // Back, while it is on its way; then the API answers that it made it.
    page.unmount()
    answer()
    await waitFor(() => expect(sessionStorage.getItem("fde.setup.key")).toBeNull())
    const named = (await api.companies()).companies.filter((c) => c.name === "Orion Rail")
    expect(named).toHaveLength(1)
  })

  it("keeps the key and the bytes when the review is left and opened again unchanged", async () => {
    const { router } = renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    wire.lose = 1
    await press("Create company")
    await within(conversation()).findByRole("alert")
    await press("Change: Here is a plan to start with. Change anything.")
    await press("Use this plan")
    await question("Ready to create Orion Rail?")
    await press("Create company")
    // The same key and bytes: the API answers with the setup it made (200), and the page opens it.
    await waitFor(() => expect(router.state.location.pathname).toMatch(PROJECT_PAGE))
    expect(wire.keys[1]).toEqual(wire.keys[0])
    const named = (await api.companies()).companies.filter((c) => c.name === "Orion Rail")
    expect(named).toHaveLength(1)
  })

  it("shows a refused part beside it; the changed answer goes under the same key, never claimed", async () => {
    const { router } = renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    wire.refuse = Response.json({ error: "invalid_target" }, { status: 400 })
    await press("Create company")
    const alert = await within(review()).findByRole("alert")
    expect(alert).toHaveTextContent("The target must be a number.")
    wire.refuse = null

    await userEvent.click(within(alert).getByRole("button", { name: "Change success criterion" }))
    const target = await screen.findByLabelText("Target")
    await userEvent.clear(target)
    await userEvent.type(target, "1.5")
    await press("Continue")
    await question("Ready to create Orion Rail?")
    await press("Create company")
    await waitFor(() => expect(router.state.location.pathname).toMatch(PROJECT_PAGE))
    expect(wire.keys).toHaveLength(2)
    expect(wire.keys[1]!.key).toBe(wire.keys[0]!.key)
    expect(wire.sent[1]?.body).toMatchObject({ criteria: [{ target: 1.5 }] })
  })

  it("keeps the key for a refusal it may retry, and takes a new one after a 409", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    wire.refuse = Response.json({ error: "forbidden" }, { status: 403 })
    await press("Create company")
    expect(await within(conversation()).findByRole("alert")).toHaveTextContent(
      "You are not allowed to set up a company here.",
    )
    await press("Try again")
    await within(conversation()).findByRole("alert")
    expect(wire.keys[1]).toEqual(wire.keys[0])

    wire.refuse = Response.json({ error: "rejected_idempotency_key_reused" }, { status: 409 })
    await press("Try again")
    await waitFor(() =>
      expect(within(conversation()).getByRole("alert")).toHaveTextContent("Check your companies"),
    )
    wire.refuse = Response.json({ error: "unavailable" }, { status: 503 })
    await press("Create company")
    await waitFor(() => expect(wire.keys).toHaveLength(4))
    expect(wire.keys[3]!.key).not.toBe(wire.keys[2]!.key)
    expect(wire.keys[3]!.text).toBe(wire.keys[2]!.text)
  })

  it("can be left from the review without saving anything", async () => {
    const { router } = renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toPlan()
    await press("Use this plan")
    await userEvent.click(await screen.findByRole("link", { name: "Not now" }))
    await waitFor(() => expect(router.state.location.pathname).toBe("/"))
    expect(wire.sent).toEqual([])
  })

  it("keeps every answer when the create is refused, and can try again", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview()
    ;(globalThis as Record<string, unknown>).__fdeMockFailWrites = true
    await press("Create company")
    expect(await within(conversation()).findByRole("alert")).toBeInTheDocument()
    expect(within(summary()).getByText("Orion Rail")).toBeInTheDocument()
    expect(within(conversation()).getByRole("button", { name: "Try again" })).toBeEnabled()
  })

  it("shows what was typed as text, never as markup", async () => {
    const hostile = '<img src=x onerror="window.__owned=1"><b>Bold</b>'
    const { container } = renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toReview(hostile)
    expect(within(summary()).getByText(hostile)).toBeInTheDocument()
    expect(within(review()).getByText(hostile)).toBeInTheDocument()
    expect(container.querySelector("img, b")).toBeNull()
    expect((window as unknown as Record<string, unknown>).__owned).toBeUndefined()
  })

  it("keeps the baseline and proof a step away, and reads a comma decimal as a plain hint", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await userEvent.type(await screen.findByLabelText("Company name"), "Orion Rail")
    await userEvent.type(screen.getByLabelText("First project"), "Claims intake")
    await press("Continue")
    await question("How do you want to start?")
    expect(screen.queryByLabelText("What is measured")).toBeNull()
    await userEvent.type(screen.getByLabelText("What would show it worked?"), "Claims triaged")
    expect(screen.queryByLabelText("Baseline")).toBeNull()
    await press("Add a baseline and how it will be proven")
    expect(document.activeElement).toBe(screen.getByLabelText("Baseline"))
    expect(screen.getByLabelText("How we will prove it")).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText("What is measured"), "hours to triage")
    await userEvent.type(screen.getByLabelText("Target"), "1,5")
    await press("Continue")
    expect(within(conversation()).getByRole("alert")).toHaveTextContent(
      "Use a point for decimals, such as 1.5, and no commas.",
    )
    await userEvent.clear(screen.getByLabelText("Target"))
    await userEvent.type(screen.getByLabelText("Target"), "0x10")
    await press("Continue")
    expect(within(conversation()).getByRole("alert")).toHaveTextContent(
      "The target must be a number.",
    )
    expect(wire.sent).toEqual([])
  })

  it("needs a name before it moves on, and says so at the field", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await screen.findByRole("region", { name: "Conversation" })
    await press("Continue")
    const name = screen.getByLabelText("Company name")
    expect(name).toHaveAttribute("aria-invalid", "true")
    expect(name).toHaveAccessibleDescription("Name the company.")
    expect(screen.queryByRole("heading", { name: "How do you want to start?" })).toBeNull()
  })

  it("proposes a plan the person can reorder, rename, add to and remove from, as the summary shows", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toPlan()
    expect(planTitles()[0]).toBe("Discovery call")
    // The criterion they gave says how it will be proven, beside the steps that name it.
    expect(within(conversation()).getAllByText(/How we will prove it/)).toHaveLength(2)
    expect(within(conversation()).getAllByText("How we will prove it: Not said yet")).toHaveLength(
      2,
    )

    await stepMenu("Build", "Move up")
    expect(planTitles()[2]).toBe("Build")
    // Focus stays with the step that moved, so it can be moved again.
    await waitFor(() => expect(focused()).toHaveAccessibleName("Change “Build”"))

    await stepMenu("Hand off", "Remove")
    await userEvent.type(screen.getByLabelText("New step"), "Train the claims team{Enter}")
    await stepMenu("Discovery call", "Rename")
    const rename = screen.getByLabelText("Name of step 1")
    await userEvent.clear(rename)
    await userEvent.type(rename, "Call the sponsor{Enter}")

    expect(planTitles()).toEqual([
      "Call the sponsor",
      "Agree scope and success criteria",
      "Build",
      "Request access to the systems",
      "Evaluate",
      "Train the claims team",
    ])
    // The summary shows the draft as it changes, as a digest that opens to the whole plan.
    expect(within(summary()).getByText("6 steps")).toBeInTheDocument()
    expect(within(summary()).queryByText("Train the claims team")).toBeNull()
    await userEvent.click(within(summary()).getByRole("button", { name: "Show all 6 steps" }))
    expect(within(summary()).getByText("Train the claims team")).toBeInTheDocument()
    expect(within(summary()).queryByText("Hand off")).toBeNull()

    await press("Use this plan")
    await question("Ready to create Orion Rail?")
    expect(wire.sent).toEqual([])
  })

  it("keeps focus on the plan after a step is removed, renamed or the rename is left", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toPlan()

    // Removing a step hands focus to the step that takes its place.
    await stepMenu("Evaluate", "Remove")
    await waitFor(() => expect(focused()).toHaveAccessibleName("Change “Hand off”"))
    // The last step hands it to the one before; the only step, to the field that adds one.
    await stepMenu("Hand off", "Remove")
    await waitFor(() => expect(focused()).toHaveAccessibleName("Change “Build”"))

    // Saving a new name, or Escape, puts focus back on the step's menu button.
    await stepMenu("Build", "Rename")
    expect(focused()).toHaveAccessibleName("Name of step 4")
    await userEvent.type(focused()!, " the intake{Enter}")
    await waitFor(() => expect(focused()).toHaveAccessibleName("Change “Build the intake”"))
    await stepMenu("Discovery call", "Rename")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(focused()).toHaveAccessibleName("Change “Discovery call”"))
    expect(planTitles()[0]).toBe("Discovery call")

    for (const title of [...planTitles()]) await stepMenu(title, "Remove")
    await waitFor(() => expect(focused()).toHaveAccessibleName("New step"))
    expect(wire.sent).toEqual([])
  })

  it("shows a long answer shortened in the summary, never drops it, and opens it in place", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    const long = "Automate claims intake for their freight team. ".repeat(20).trim()
    await userEvent.type(await screen.findByLabelText("Company name"), "Orion Rail")
    await userEvent.type(screen.getByLabelText("First project"), "Claims intake")
    // Pasted, as a long brief would be; typing it would take the test's whole budget.
    await userEvent.click(screen.getByLabelText("What are you delivering?"))
    await userEvent.paste(long)
    await press("Continue")
    await question("How do you want to start?")
    const company = within(summary()).getByRole("region", { name: "Company" })
    expect(within(company).getByText(long)).toBeInTheDocument()
    const more = within(company).getByRole("button", { name: "Show more" })
    expect(more).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(more)
    expect(within(company).getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
  })

  it("lets an earlier answer be changed, and keeps the rest", async () => {
    renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toPlan()
    await press("Use this plan")
    await userEvent.click(
      within(conversation()).getByRole("button", {
        name: "Change: Which company is it, and what are you delivering for them?",
      }),
    )
    const name = await screen.findByLabelText("Company name")
    expect(name).toHaveValue("Orion Rail")
    await userEvent.clear(name)
    await userEvent.type(name, "Orion Freight")
    await press("Continue")
    await question("Ready to create Orion Freight?")
  })
})
