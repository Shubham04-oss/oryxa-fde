import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { BlockView } from "./blocks"
import { Welcome } from "./welcome"
import { CompaniesHome } from "@/components/companies-home"
import { Home } from "@/components/home"
import type { Block } from "@/lib/workspace/blocks"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

beforeAll(installWire)
afterEach(() => {
  resetWire()
  vi.unstubAllEnvs()
  delete (globalThis as Record<string, unknown>).__fdeMockWorkspace
})

const MORNING = new Date(2026, 10, 12, 9, 0)
const suggested = () => screen.findAllByRole("button", { name: /^Not now:/ })

describe("the welcome screen", () => {
  it("greets the FDE and puts the conversation box first", async () => {
    renderWithRouter(<Welcome now={MORNING} />)
    expect(await screen.findByRole("heading", { name: "Good morning, Riya." })).toBeInTheDocument()
    expect(
      screen.getByRole("textbox", { name: "What do you want to work on?" }),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
  })

  it("suggests next steps; one can be put away and brought back", async () => {
    renderWithRouter(<Welcome now={MORNING} />)
    const before = await suggested()
    const name = before[0]!.getAttribute("aria-label")!
    await userEvent.click(before[0]!)
    expect(screen.queryByRole("button", { name })).toBeNull()
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(/Put away/)
    await userEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(screen.getByRole("button", { name })).toBeInTheDocument()
    expect(wire.sent).toEqual([])
  })

  it("approves a suggestion by opening where it is done, and writes nothing", async () => {
    const { router } = renderWithRouter(<Welcome now={MORNING} />)
    await suggested()
    await userEvent.click(screen.getAllByRole("button", { name: "Open the project" })[0]!)
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/companies\/cmp_\w+\/projects\//),
    )
    expect(wire.sent).toEqual([])
  })

  it("shows what the FDE typed as text, and answers it", async () => {
    const { container } = renderWithRouter(<Welcome now={MORNING} />)
    await suggested()
    const box = screen.getByRole("textbox", { name: "What do you want to work on?" })
    await userEvent.type(box, "<b>new</b> customer to set up{Enter}")
    const log = screen.getByRole("log", { name: "Conversation" })
    expect(within(log).getByText("<b>new</b> customer to set up")).toBeInTheDocument()
    expect(container.querySelector("b")).toBeNull()
    expect(await within(log).findByText("Let's set it up together.")).toBeInTheDocument()
    expect(within(log).getByRole("button", { name: "Start" })).toBeInTheDocument()
    expect(box).toHaveValue("")
  })

  it("lets Shift and Enter start a new line instead of sending", async () => {
    renderWithRouter(<Welcome now={MORNING} />)
    const box = await screen.findByRole("textbox", { name: "What do you want to work on?" })
    await userEvent.type(box, "one{Shift>}{Enter}{/Shift}two")
    expect(box).toHaveValue("one\ntwo")
    expect(screen.queryByRole("log")).toBeNull()
  })

  it("offers the first company to a workspace with none", async () => {
    renderWithRouter(<Welcome now={MORNING} />, { empty: true })
    expect(await screen.findByRole("article", { name: "Set up a new company" })).toBeInTheDocument()
    expect(screen.getByText("None yet.")).toBeInTheDocument()
  })
})

describe("the home route, with the new workspace off and on", () => {
  it("shows the companies when the flag is off", async () => {
    vi.stubEnv("VITE_FDE_WORKSPACE", "0")
    renderWithRouter(<Home />)
    expect(await screen.findByRole("list", { name: "Your companies" })).toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "What do you want to work on?" })).toBeNull()
  })

  it("shows the welcome screen when the build turns it on", async () => {
    vi.stubEnv("VITE_FDE_WORKSPACE", "1")
    renderWithRouter(<Home />)
    expect(
      await screen.findByRole("textbox", { name: "What do you want to work on?" }),
    ).toBeInTheDocument()
  })

  it("opens the company form when off, and the conversation when on", async () => {
    vi.stubEnv("VITE_FDE_WORKSPACE", "0")
    const off = renderWithRouter(<CompaniesHome />)
    await userEvent.click(await screen.findByRole("button", { name: "New company" }))
    expect(await screen.findByRole("dialog", { name: "New company" })).toBeInTheDocument()
    off.unmount()

    // On for this tab on the dev mock, as `pnpm shots` turns it on.
    ;(globalThis as Record<string, unknown>).__fdeMockWorkspace = true
    const on = renderWithRouter(<CompaniesHome />)
    await userEvent.click(await screen.findByRole("button", { name: "New company" }))
    await waitFor(() => expect(on.router.state.location.pathname).toBe("/new-company"))
  })
})

describe("a block", () => {
  it("of a type the web does not know is drawn as nothing", () => {
    const { container } = render(
      <BlockView block={{ type: "html", html: "<b>x</b>" } as unknown as Block} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
