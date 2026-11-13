import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { ConversationView } from "./conversation-view"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

// The conversation prototype's screen (issue #263) on the dev mock's scripted assistant.

const flags = globalThis as Record<string, unknown>

beforeAll(installWire)
beforeEach(() => {
  resetWire()
  // jsdom has no ResizeObserver; the thread's scroll and the layout's width only observe.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  )
})
afterEach(() => {
  for (const flag of ["Hold", "Fail"]) flags[`__fdeMockAssistant${flag}`] = undefined
})

const thread = () => screen.findByRole("log", { name: "Conversation" })
const answered = async () =>
  within(await thread()).findAllByRole("button", { name: "Good answer" }, { timeout: 4000 })

describe("a new conversation", () => {
  it("says what it can do in its scope, offers three prompts, and drops them once it has content", async () => {
    renderWithRouter(<ConversationView conversation={null} draft={{ kind: "home" }} />)
    expect(await screen.findByRole("heading", { name: "Ask across your companies" })).toBeVisible()
    const prompts = screen.getByRole("list", { name: "Things to ask" })
    expect(within(prompts).getAllByRole("button")).toHaveLength(3)
    await userEvent.click(within(prompts).getByRole("button", { name: "What needs me today?" }))
    await answered()
    expect(screen.queryByRole("list", { name: "Things to ask" })).toBeNull()
    expect(screen.getByLabelText(/^Scope: Home/)).toBeInTheDocument()
  })
})

describe("proposals", () => {
  it("confirms each one on its own, and never from Enter in the composer", async () => {
    renderWithRouter(<ConversationView conversation={null} draft={{ kind: "home" }} />)
    await userEvent.click(
      await screen.findByRole("button", { name: "Set up Orion Rail and Halden Water" }),
    )
    await answered()
    const cards = screen.getAllByRole("region", { name: "Proposed: Create a company" })
    expect(cards).toHaveLength(2)
    // The first waiting one is the view's one primary; the other is outlined.
    const [first, second] = cards.map((c) =>
      within(c).getByRole("button", { name: "Create company" }),
    )
    expect(first!.className).toMatch(/bg-primary/)
    expect(second!.className).not.toMatch(/bg-primary/)

    await userEvent.type(screen.getByRole("textbox"), "{Enter}")
    expect(wire.sent.filter((s) => s.path.endsWith("/companies"))).toHaveLength(0)

    await userEvent.click(first!)
    expect(await screen.findByText("Created Orion Rail.")).toBeVisible()
    expect(
      wire.sent.filter((s) => s.method === "POST" && s.path.endsWith("/companies")),
    ).toHaveLength(1)
    // The second is still waiting, and is now the primary.
    const waiting = screen.getByRole("region", { name: "Proposed: Create a company" })
    expect(within(waiting).getByText("Halden Water")).toBeVisible()
    expect(within(waiting).getByRole("button", { name: "Create company" }).className).toMatch(
      /bg-primary/,
    )
  })

  it("shows the API's refusal on a change it refuses, and lets it be put away", async () => {
    renderWithRouter(<ConversationView conversation="c_bright_team" draft={null} />)
    const card = await screen.findByRole(
      "region",
      { name: "Proposed: Give a person a role" },
      { timeout: 4000 },
    )
    expect(within(card).getByText("Grants access")).toBeVisible()
    expect(await within(card).findByText("Sam Okafor")).toBeVisible()
    expect(within(card).getByText(/confirmed on its own, never with other changes/)).toBeVisible()
    await userEvent.click(within(card).getByRole("button", { name: "Confirm" }))
    expect(await within(card).findByText("The workspace refused this.")).toBeVisible()
    expect(within(card).queryByRole("button", { name: "Confirm" })).toBeNull()
    await userEvent.click(within(card).getByRole("button", { name: "Not now" }))
    expect(await screen.findByText(/Not now\. Nothing changed\./)).toBeVisible()
  })
})

describe("a turn", () => {
  it("folds its reads into one line once it ends, opening to what was asked and how much came back", async () => {
    renderWithRouter(
      <ConversationView
        conversation={null}
        draft={{ kind: "project", company: "cmp_kestrel", project: "prj_kestrel_dispatch" }}
      />,
    )
    await userEvent.click(await screen.findByRole("button", { name: "What is blocked right now?" }))
    await answered()
    await userEvent.click(screen.getByRole("button", { name: /^Read 3 things/ }))
    await userEvent.click(screen.getByRole("button", { name: /^Read Dispatch copilot's tasks/ }))
    expect(
      await screen.findByText("Every task on Dispatch copilot, with its stage and state."),
    ).toBeVisible()
    expect(screen.getByText("14 tasks.")).toBeVisible()
  })

  it("queues a message typed while it runs, and stops with what it said kept", async () => {
    renderWithRouter(
      <ConversationView
        conversation={null}
        draft={{ kind: "project", company: "cmp_kestrel", project: "prj_kestrel_dispatch" }}
      />,
    )
    flags.__fdeMockAssistantHold = "r2"
    await userEvent.click(await screen.findByRole("button", { name: "What is blocked right now?" }))
    // The answer itself, not the live region, which may read the same sentence.
    const answer = async () => (await screen.findAllByLabelText("The workspace's answer"))[0]!
    expect(
      await within(await answer()).findByText(/One thing holds Dispatch copilot up/),
    ).toBeVisible()
    await userEvent.type(screen.getByRole("textbox"), "Who could chase it?{Enter}")
    expect(await screen.findByText("Queued. It sends when this answer ends.")).toBeVisible()
    await userEvent.click(screen.getByRole("button", { name: "Stop the answer" }))
    expect(await screen.findByText("You stopped this answer. What it said is kept.")).toBeVisible()
    expect(within(await answer()).getByText(/One thing holds Dispatch copilot up/)).toBeVisible()
    // The queued message goes once the stopped turn has ended.
    await waitFor(() => expect(screen.getAllByLabelText("You said")).toHaveLength(2))
    expect(screen.queryByText("Queued. It sends when this answer ends.")).toBeNull()
  })

  it("says plainly when it failed, and tries again once", async () => {
    renderWithRouter(<ConversationView conversation={null} draft={{ kind: "home" }} />)
    flags.__fdeMockAssistantFail = true
    await userEvent.click(await screen.findByRole("button", { name: "What needs me today?" }))
    const again = await screen.findByRole("button", { name: "Try again" }, { timeout: 4000 })
    expect(screen.getByText(/Something went wrong part way through/)).toBeVisible()
    await userEvent.click(again)
    await answered()
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
  })

  it("renders the stream's text as text, never as markup", async () => {
    renderWithRouter(<ConversationView conversation={null} draft={{ kind: "home" }} />)
    await userEvent.type(await screen.findByRole("textbox"), "<img src=x onerror=alert(1)>{Enter}")
    await answered()
    // What the person said shows as text, in the thread and as the conversation's title.
    expect(screen.getAllByText("<img src=x onerror=alert(1)>").length).toBeGreaterThan(0)
    expect(document.querySelector("img")).toBeNull()
  })
})
