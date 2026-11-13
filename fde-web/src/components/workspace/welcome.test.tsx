import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { BlockView } from "./blocks"
import { Welcome } from "./welcome"
import { CompaniesHome } from "@/components/companies-home"
import { mockApi } from "@/dev/mock-api"
import { Home } from "@/components/home"
import { NOTICE_TEXT, TURN_DEADLINE_MS } from "@/lib/workspace/assistant"
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

  it("suggests the API's next steps, worded from the web's templates", async () => {
    renderWithRouter(<Welcome now={MORNING} />)
    await suggested()
    expect(wire.reads).toContain("/home")
    expect(wire.reads).not.toContain("/today")
  })

  it("puts one away at once, and tells the API", async () => {
    renderWithRouter(<Welcome now={MORNING} />)
    const before = await suggested()
    const name = before[0]!.getAttribute("aria-label")!
    let release = () => {}
    wire.hold = new Promise((r) => (release = r))
    await userEvent.click(before[0]!)
    // Gone before the API answers.
    expect(screen.queryByRole("button", { name })).toBeNull()
    expect(wire.sent).toEqual([
      {
        method: "POST",
        path: expect.stringMatching(/^\/home\/suggestions\/[^/]+\/dismiss$/),
        body: null,
      },
    ])
    release()
    expect(await screen.findByText(/^Put away: /)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name })).toBeNull()
  })

  it("brings a suggestion back when the API refuses to put it away", async () => {
    renderWithRouter(<Welcome now={MORNING} />)
    const before = await suggested()
    const name = before[0]!.getAttribute("aria-label")!
    wire.refuse = new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })
    await userEvent.click(before[0]!)
    expect(await screen.findByText(/^We couldn't put away/)).toBeInTheDocument()
    expect(await screen.findByRole("button", { name })).toBeInTheDocument()
  })

  it("says so calmly, with Try again, when the day cannot be read", async () => {
    wire.refuseReads = {
      ending: "/home",
      // A refusal is not retried, so the error shows at once.
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    }
    renderWithRouter(<Welcome now={MORNING} />)
    expect(
      await screen.findByText("We couldn't read your day, so there is nothing to suggest yet."),
    ).toBeInTheDocument()
    wire.refuseReads = null
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await suggested()).not.toHaveLength(0)
  })

  it("says nothing needs the FDE when the API suggests nothing, and claims no more", async () => {
    wire.refuseReads = {
      ending: "/home",
      response: new Response(JSON.stringify({ suggestions: [] }), { status: 200 }),
    }
    renderWithRouter(<Welcome now={MORNING} />)
    expect(await screen.findByText(/^Nothing needs you right now\./)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Not now:/ })).toBeNull()
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

describe("the conversation with the assistant", () => {
  const original = { fetch: mockApi.fetch }
  const asked: Array<{ method: string; path: string; body: unknown }> = []
  const frames = (events: Array<unknown>) =>
    `${events.map((e, i) => `id: ${i}\ndata: ${JSON.stringify(e)}\n\n`).join("")}event: done\ndata: {}\n\n`
  let turnAnswer: () => Response = () => new Response(null, { status: 500 })

  beforeEach(() => {
    asked.length = 0
    original.fetch = mockApi.fetch
    // The assistant's routes, as this app's server answers them once it has checked the person.
    mockApi.fetch = async (request) => {
      const { pathname } = new URL(request.url)
      if (!pathname.startsWith("/assistant/")) return original.fetch(request)
      const text = request.method === "POST" ? await request.text() : ""
      asked.push({ method: request.method, path: pathname, body: text ? JSON.parse(text) : null })
      if (/^\/assistant\/conversations\/c_\w+$/.test(pathname))
        return Response.json({ error: "no_conversation" }, { status: 404 })
      if (pathname.endsWith("/turns")) return turnAnswer()
      if (pathname.includes("/proposals/")) return new Response(null, { status: 204 })
      return Response.json({ error: "not_found" }, { status: 404 })
    }
  })
  afterEach(() => {
    mockApi.fetch = original.fetch
  })

  const said = async (text: string) => {
    const box = await screen.findByRole("textbox", { name: "What do you want to work on?" })
    await userEvent.type(box, `${text}{Enter}`)
    return screen.getByRole("log", { name: "Conversation" })
  }

  it("renders the block and shows the proposal from its arguments, dropping what is unknown", async () => {
    turnAnswer = () =>
      new Response(
        frames([
          { v: 1, type: "turn", turn: "t_1", said: "Set up Kestrel" },
          // The model's words name another company: the card must not take them.
          { v: 1, type: "text", delta: "I'll create Harbor Health for you." },
          {
            v: 1,
            type: "block",
            block: {
              type: "brief",
              items: [{ label: "Company", value: "<b>Kestrel</b> Logistics" }],
            },
          },
          {
            v: 1,
            type: "block",
            block: { type: "html", html: "<img src=https://evil.example/x>" },
          },
          { v: 1, type: "block", block: { type: "suggestion", id: "s", title: "No approve" } },
          {
            v: 1,
            type: "proposal",
            proposal: { id: "p_bad", action: "delete_company", args: { company: "cmp_kestrel" } },
          },
          {
            v: 1,
            type: "proposal",
            proposal: { id: "p_1", action: "create_company", args: { name: "Kestrel Logistics" } },
          },
          {
            v: 1,
            type: "proposal",
            proposal: {
              id: "p_2",
              action: "open_route",
              args: { to: { screen: "company", company: "cmp_unseen" } },
            },
          },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      )
    const { container, router } = renderWithRouter(<Welcome now={MORNING} />)
    await suggested()
    const log = await said("Set up a new company called Kestrel Logistics")

    expect(await within(log).findByText("I'll create Harbor Health for you.")).toBeInTheDocument()
    // Text is text: the block's markup is shown as typed, never rendered.
    expect(within(log).getByText("<b>Kestrel</b> Logistics")).toBeInTheDocument()
    expect(container.querySelector("b, img, script")).toBeNull()
    expect(within(log).queryByRole("article", { name: "No approve" })).toBeNull()

    const proposals = within(log).getAllByRole("article", { name: /^Proposed:/ })
    expect(proposals).toHaveLength(2)
    expect(proposals[0]).toHaveTextContent("Create a company")
    expect(proposals[0]).toHaveTextContent("It will be saved as “Kestrel Logistics”")
    expect(proposals[0]).not.toHaveTextContent("Harbor")
    // A record the person cannot read is named as such, and cannot be opened.
    expect(proposals[1]).toHaveTextContent("Open a record you can't see")
    expect(within(proposals[1]!).queryByRole("button", { name: "Open" })).toBeNull()
    expect(asked.find((a) => a.path.endsWith("/turns"))?.body).toEqual({
      text: "Set up a new company called Kestrel Logistics",
    })
    // Nothing was written: proposing is not doing.
    expect(wire.sent).toEqual([])

    await userEvent.click(within(proposals[0]!).getByRole("button", { name: "Create company" }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/companies\/cmp_/))
    // The web ran it, with the person's session, through the API's own route.
    expect(wire.sent).toEqual([
      {
        method: "POST",
        path: "/companies",
        body: expect.objectContaining({ name: "Kestrel Logistics" }),
      },
    ])
    expect(asked.filter((a) => a.path.includes("/proposals/"))).toEqual([
      {
        method: "POST",
        path: expect.stringMatching(/\/proposals\/p_1$/),
        body: { outcome: "confirmed" },
      },
    ])
  })

  it("says plainly why a turn was refused", async () => {
    turnAnswer = () => Response.json({ error: "rate_limited" }, { status: 429 })
    renderWithRouter(<Welcome now={MORNING} />)
    await suggested()
    const log = await said("hello")
    expect(
      await within(log).findByText(
        "You've sent several messages in the last minute. Wait a moment, then try again.",
      ),
    ).toBeInTheDocument()
  })

  it("keeps the scripted answers where the assistant is not configured", async () => {
    turnAnswer = () => Response.json({ error: "assistant_not_configured" }, { status: 503 })
    mockApi.fetch = async (request) => {
      const { pathname } = new URL(request.url)
      if (pathname.startsWith("/assistant/"))
        return Response.json({ error: "assistant_not_configured" }, { status: 503 })
      return original.fetch(request)
    }
    renderWithRouter(<Welcome now={MORNING} />)
    await suggested()
    const log = await said("new customer to set up")
    expect(await within(log).findByText("Let's set it up together.")).toBeInTheDocument()
  })

  it("says plainly when the assistant ran out of time on a turn", async () => {
    turnAnswer = () =>
      new Response(
        frames([
          { v: 1, type: "turn", turn: "t_1", said: "Plan my week" },
          { v: 1, type: "text", delta: "Looking at your week. " },
          { v: 1, type: "notice", notice: "timed_out" },
        ]),
        { headers: { "content-type": "text/event-stream" } },
      )
    renderWithRouter(<Welcome now={MORNING} />)
    await suggested()
    const log = await said("Plan my week")
    expect(await within(log).findByText(NOTICE_TEXT.timed_out)).toBeInTheDocument()
  })

  it("gives up on a turn that never ends, heartbeats or not, and frees the box", async () => {
    // A stuck turn: its first events, then only silence, on the first connection and on each reconnect.
    const stuck = (events: Array<unknown>) =>
      new Response(
        new ReadableStream({
          start(controller) {
            const text = events.map((e, i) => `id: ${i}\ndata: ${JSON.stringify(e)}\n\n`).join("")
            controller.enqueue(new TextEncoder().encode(text))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    turnAnswer = () =>
      stuck([
        { v: 1, type: "turn", turn: "t_1", said: "Plan my week" },
        { v: 1, type: "text", delta: "Looking at your week. " },
      ])
    const answer = mockApi.fetch
    let reconnects = 0
    mockApi.fetch = async (request) => {
      if (!new URL(request.url).pathname.endsWith("/events")) return answer(request)
      reconnects += 1
      return stuck([])
    }
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderWithRouter(<Welcome now={MORNING} />)
      await suggested()
      const log = await said("Plan my week")
      expect(await within(log).findByText("Looking at your week.")).toBeInTheDocument()
      for (let waited = 0; waited <= TURN_DEADLINE_MS; waited += 15_000)
        await vi.advanceTimersByTimeAsync(15_000)
      expect(await within(log).findByText(NOTICE_TEXT.timed_out)).toBeInTheDocument()
      // It reconnected while the turn had time left, then stopped.
      expect(reconnects).toBeGreaterThan(0)
      expect(within(log).getByText("Looking at your week.")).toBeInTheDocument()
      // The person can ask again.
      expect(screen.getByRole("button", { name: "What needs me today?" })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })
})
