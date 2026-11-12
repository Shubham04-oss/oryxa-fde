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

/** The plan's step titles in order, read from each step's Rename button. */
const planTitles = () =>
  within(screen.getByRole("list", { name: "Plan" }))
    .getAllByRole("button", { name: /^Rename “/ })
    .map((b) => b.getAttribute("aria-label")!.slice("Rename “".length, -1))

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

    const plan = screen.getByRole("list", { name: "Plan" })
    await userEvent.click(within(plan).getByRole("button", { name: "Move “Build” up" }))
    expect(planTitles()[2]).toBe("Build")
    // Focus stays with the step that moved, so it can be moved again.
    expect(document.activeElement).toHaveAccessibleName("Move “Build” up")

    await userEvent.click(within(plan).getByRole("button", { name: "Remove “Hand off”" }))
    await userEvent.type(screen.getByLabelText("New step"), "Train the claims team{Enter}")
    await userEvent.click(within(plan).getByRole("button", { name: "Rename “Discovery call”" }))
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
    // The summary shows the draft as it changes.
    expect(within(summary()).getByText("Train the claims team")).toBeInTheDocument()
    expect(within(summary()).queryByText("Hand off")).toBeNull()

    await press("Use this plan")
    await question("Ready to create Orion Rail?")
    expect(wire.sent).toEqual([])
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
