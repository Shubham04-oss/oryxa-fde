import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { NewCompanyConversation } from "./new-company"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

beforeAll(installWire)
afterEach(() => {
  resetWire()
  delete (globalThis as Record<string, unknown>).__fdeMockFailWrites
})

const conversation = () => screen.getByRole("region", { name: "Conversation" })
const summary = () => screen.getByRole("complementary", { name: "Summary" })
const question = (name: string) => screen.findByRole("heading", { name })
const press = (name: string) =>
  userEvent.click(within(conversation()).getByRole("button", { name, exact: true } as never))

/** Answers the conversation up to the plan step; `name` is typed as the company's name. */
async function toPlan(name = "Orion Rail") {
  await userEvent.type(await screen.findByLabelText("Company name"), name)
  await userEvent.type(screen.getByLabelText("What are you delivering?"), "Claims intake.")
  await press("Continue")
  await question("How do you want to start?")
  await userEvent.type(screen.getByLabelText("Main contact at the company"), "Dana Ortiz")
  await userEvent.type(
    screen.getByLabelText("What would show it worked?"),
    "Claims triaged in two hours",
  )
  await press("Continue")
  await question("What may agents do here, and who approves?")
  await press("Continue")
  await question("Who should be invited?")
  await userEvent.type(screen.getByLabelText("Email of person 1"), "sam@example.com")
  await press("Continue")
  await question("Here is a plan to start with. Change anything.")
}

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

describe("a new company as a conversation", () => {
  it("saves nothing until the person confirms on the review, then creates it through the existing call", async () => {
    const { router } = renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toPlan()
    await press("Use this plan")
    await question("Ready to create Orion Rail?")
    // Five steps answered, rules and invites among them: not one write yet.
    expect(wire.sent).toEqual([])

    await press("Create company")
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/companies\/cmp_new/))
    expect(wire.sent).toEqual([
      {
        method: "POST",
        path: "/companies",
        body: { name: "Orion Rail", industry: null, region: null, summary: "Claims intake." },
      },
    ])
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
    await toPlan()
    await press("Use this plan")
    await question("Ready to create Orion Rail?")
    ;(globalThis as Record<string, unknown>).__fdeMockFailWrites = true
    await press("Create company")
    expect(await within(conversation()).findByRole("alert")).toBeInTheDocument()
    expect(within(summary()).getByText("Orion Rail")).toBeInTheDocument()
    expect(within(conversation()).getByRole("button", { name: "Create company" })).toBeEnabled()
  })

  it("shows what was typed as text, never as markup", async () => {
    const hostile = '<img src=x onerror="window.__owned=1"><b>Bold</b>'
    const { container } = renderWithRouter(<NewCompanyConversation />, { at: "/new-company" })
    await toPlan(hostile)
    await press("Use this plan")
    await question(`Ready to create ${hostile}?`)
    expect(within(summary()).getByText(hostile)).toBeInTheDocument()
    expect(container.querySelector("img, b")).toBeNull()
    expect((window as unknown as Record<string, unknown>).__owned).toBeUndefined()
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
