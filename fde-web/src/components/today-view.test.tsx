import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { TodayView } from "./today-view"
import { mockApi } from "@/dev/mock-api"
import { api } from "@/lib/api/client"
import { AccessRequestId, CompanyId, ProjectId, TaskId } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"

// Lets a test hold a write on the wire, have it refused, or hold a read, as board.test.tsx does.
const answer = mockApi.fetch
const wire: {
  hold: Promise<void> | null
  refuse: Response | null
  holdReads: Promise<void> | null
  /** Answers Today with these items instead of the mock's. */
  today: Response | null
} = { hold: null, refuse: null, holdReads: null, today: null }
mockApi.fetch = async (request) => {
  const write = request.method !== "GET"
  if (write && wire.hold) await wire.hold
  if (write && wire.refuse) return wire.refuse.clone()
  if (!write && wire.today && new URL(request.url).pathname === "/api/v1/today")
    return wire.today.clone()
  const response = await answer(request)
  if (!write && wire.holdReads) await wire.holdReads
  return response
}
afterEach(() => {
  wire.hold = null
  wire.refuse = null
  wire.holdReads = null
  wire.today = null
})

/** The item titles in a Today group, top to bottom. */
async function titles(group: string) {
  // A dialog or menu hides the page behind it from the accessibility tree; the list is still there.
  const region = await screen.findByRole("region", { name: group, hidden: true })
  return within(region)
    .queryAllByRole("link", { hidden: true })
    .map((link) => link.textContent)
}

/** The row an item is on, whatever group it is in. */
const row = (title: string) =>
  screen.getByRole("link", { name: title, hidden: true }).closest("li")!
const where = (title: string) => row(title).closest("section")!.getAttribute("aria-labelledby")

/** Waits for Today, and for the names that follow it. */
async function today() {
  renderWithRouter(<TodayView />)
  await screen.findByRole("region", { name: "Blocked" })
}

describe("TodayView", () => {
  it("groups open work across companies into blocked, due and waiting on the customer", async () => {
    renderWithRouter(<TodayView />)

    // Oldest first: a refusal from when it was refused, a blocked task from its last change.
    expect(await titles("Blocked")).toEqual([
      "Access: Telematics export",
      "Roll out to the north depot crews",
      "Agree the telematics alternative",
      "Access: Crew roster export",
      "Staging credentials for the intake API",
    ])
    // Overdue first, then due today; not yet due and done tasks are left out.
    expect(await titles("Due")).toEqual([
      "Map intake form fields",
      "Add driver-hours checks to the eval suite",
      "Replay last month's orders through the planner",
      "Answer the security questionnaire",
      "Publish eval results to the customer room",
    ])
    expect(await titles("Waiting on the customer")).toEqual([
      "Access: Clinic directory export",
      "Access: Mobile device management enrolment",
      "Buyer review of week 3 forecasts",
      "Access: Depot rules, read only",
      "Access: Intake form API, staging",
      "Dispatcher feedback session",
      "Access: Redacted call recordings",
      "Scope sign-off meeting",
      "Interview the claims team lead",
    ])
    expect(screen.queryByText("Load depot rules into the context pack")).toBeNull()
    expect(screen.queryByText("Set up the sandbox with sample orders")).toBeNull()
    expect(screen.queryByText(/Read replica of the planning database/)).toBeNull()
    expect(
      screen.getByText(
        "19 need you across 5 companies: 5 blocked, 5 due, 9 waiting on the customer. 1 project has no next step.",
      ),
    ).toBeInTheDocument()
  })

  it("files each item once, even when it is also late", async () => {
    renderWithRouter(<TodayView />)

    const all = [
      ...(await titles("Blocked")),
      ...(await titles("Due")),
      ...(await titles("Waiting on the customer")),
    ]
    expect(new Set(all).size).toBe(all.length)
    // Overdue, but waiting on the customer: it is the customer's move, not the FDE's.
    expect(await titles("Waiting on the customer")).toContain("Buyer review of week 3 forecasts")
    expect(await titles("Due")).not.toContain("Buyer review of week 3 forecasts")
  })

  it("says why each item is there", async () => {
    renderWithRouter(<TodayView />)

    const blocked = await screen.findByRole("region", { name: "Blocked" })
    expect(within(blocked).getByText("Denied by Tomas Becker")).toBeInTheDocument()
    expect(within(blocked).getByText("Revoked by Ravi Desai")).toBeInTheDocument()
    expect(
      within(blocked).getByText("Telematics export refused by the customer's security team"),
    ).toBeInTheDocument()
    const due = screen.getByRole("region", { name: "Due" })
    expect(within(due).getByText("Overdue by 3 days")).toBeInTheDocument()
    const waiting = screen.getByRole("region", { name: "Waiting on the customer" })
    expect(within(waiting).getByText("Waiting 11 days on Sana Qureshi")).toBeInTheDocument()
    expect(within(waiting).getByText("Waiting 7 days")).toBeInTheDocument()
  })

  it("names who has a task when it is someone else, and says nothing of your own", async () => {
    await today()
    const theirs = row("Buyer review of week 3 forecasts")
    await waitFor(() =>
      expect(theirs).toHaveTextContent(
        "Lumen Grocers · Store demand forecasts · Assigned to Aurelia Montgomery-Featherstonehaugh de la Cruz Vandermeer-Okonkwo",
      ),
    )
    expect(row("Publish eval results to the customer room")).not.toHaveTextContent("Assigned")
  })

  it("opens the project an item belongs to", async () => {
    const { router } = renderWithRouter(<TodayView />)

    await userEvent.click(await screen.findByRole("link", { name: /Map intake form fields/ }))

    expect(router.state.location.pathname).toBe(
      "/companies/cmp_brightwater/projects/prj_bw_referrals",
    )
  })

  it("never claims an all clear when Today cannot be read", async () => {
    renderWithRouter(<TodayView />, { signedIn: false })

    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't load Today.")
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
    expect(screen.queryByText(/Nothing needs you today/)).toBeNull()
  })
})

const sectionTitle = async (title: string) => {
  const id = where(title)
  return document.getElementById(id!)!.textContent
}

/** Opens a row's menu and picks one entry. */
async function pick(title: string, entry: string) {
  await userEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }))
  await userEvent.click(await screen.findByRole("menuitem", { name: entry }))
}

const DUE = "Map intake form fields"
const BLOCKED = "Agree the telematics alternative"
const WAITING = "Dispatcher feedback session"
const REQUESTED = "Access: Intake form API, staging"
const DENIED = "Access: Telematics export"
const scope = {
  company: CompanyId.parse("cmp_kestrel"),
  project: ProjectId.parse("prj_kestrel_dispatch"),
}

describe("Today as an inbox", () => {
  it("offers one action per row that fits why it is there", async () => {
    await today()

    expect(within(row(DUE)).getByRole("button", { name: `Done: ${DUE}` })).toBeInTheDocument()
    expect(
      within(row(BLOCKED)).getByRole("button", { name: `Unblock: ${BLOCKED}` }),
    ).toBeInTheDocument()
    expect(
      within(row(WAITING)).getByRole("button", { name: `Received: ${WAITING}` }),
    ).toBeInTheDocument()
    expect(
      within(row(REQUESTED)).getByRole("button", { name: `Mark granted: ${REQUESTED}` }),
    ).toBeInTheDocument()
    expect(
      within(row(DENIED)).getByRole("button", { name: `Ask again: ${DENIED}` }),
    ).toBeInTheDocument()
  })

  it("marks a due task done, and the row leaves only once the API has answered", async () => {
    await today()
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))

    await userEvent.click(screen.getByRole("button", { name: `Done: ${DUE}` }))

    // Still there, dimmed and saying where it is going, with the count unchanged.
    expect(await screen.findByText("Moving to Done…")).toBeInTheDocument()
    expect(await titles("Due")).toContain(DUE)
    expect(screen.getByText(/^19 need you/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: `Done: ${DUE}` })).toBeDisabled()
    answered()

    await waitFor(async () => expect(await titles("Due")).not.toContain(DUE))
    expect(
      screen.getByText(/^18 need you across 5 companies: 5 blocked, 4 due, 9 waiting/),
    ).toBeInTheDocument()
    expect(
      (
        await api.project({
          company: CompanyId.parse("cmp_brightwater"),
          project: ProjectId.parse("prj_bw_referrals"),
        })
      ).tasks.find((t) => t.title === DUE)?.status,
    ).toBe("done")
  })

  it("unblocks a task into In progress and a waiting one too, clearing what they were waiting on", async () => {
    await today()

    await userEvent.click(screen.getByRole("button", { name: `Unblock: ${BLOCKED}` }))
    await waitFor(async () => expect(await titles("Blocked")).not.toContain(BLOCKED))
    await userEvent.click(screen.getByRole("button", { name: `Received: ${WAITING}` }))
    await waitFor(async () =>
      expect(await titles("Waiting on the customer")).not.toContain(WAITING),
    )

    const tasks = (await api.project(scope)).tasks
    expect(tasks.find((t) => t.title === BLOCKED)).toMatchObject({
      status: "in_progress",
      blocker: null,
    })
    expect(tasks.find((t) => t.title === WAITING)).toMatchObject({
      status: "in_progress",
      waiting_on: null,
    })
  })

  it("offers the project's access requests as what blocks a task, and sends the one chosen", async () => {
    await today()
    await pick(DUE, "Mark blocked…")
    const blocker = await screen.findByRole("dialog", { name: "What is blocking this?" })
    // Read from the project when the prompt opens: the granted one is not a blocker.
    const choice = await within(blocker).findByLabelText("Blocked by an access request")
    expect(
      within(choice)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "None, something else",
      "Clinic directory export (in progress)",
      "Intake form API, staging",
    ])
    await userEvent.selectOptions(choice, "acc_b2")
    await userEvent.type(within(blocker).getByLabelText("The blocker"), "Needs staging access")
    await userEvent.click(within(blocker).getByRole("button", { name: "Move to Blocked" }))
    await waitFor(async () => expect(await titles("Blocked")).toContain(DUE))
    const referrals = {
      company: CompanyId.parse("cmp_brightwater"),
      project: ProjectId.parse("prj_bw_referrals"),
    }
    expect((await api.project(referrals)).tasks.find((t) => t.title === DUE)).toMatchObject({
      status: "blocked",
      blocker: "Needs staging access",
      blocked_by: "acc_b2",
    })
  })

  it("asks what blocks a task before marking it blocked, and who it waits on before waiting", async () => {
    await today()

    await pick(DUE, "Mark blocked…")
    const blocker = await screen.findByRole("dialog", { name: "What is blocking this?" })
    // Saving without an answer is refused where it is asked.
    await userEvent.click(within(blocker).getByRole("button", { name: "Move to Blocked" }))
    expect(within(blocker).getByRole("alert")).toHaveTextContent("Say what is blocking it.")
    expect(await titles("Due")).toContain(DUE)
    await userEvent.type(within(blocker).getByLabelText("The blocker"), "Waiting on a VPN")
    await userEvent.click(within(blocker).getByRole("button", { name: "Move to Blocked" }))
    await waitFor(async () => expect(await titles("Blocked")).toContain(DUE))
    expect(within(row(DUE)).getByText("Waiting on a VPN")).toBeInTheDocument()

    await pick("Add driver-hours checks to the eval suite", "Waiting on the customer…")
    const who = await screen.findByRole("dialog", { name: "Who is this waiting on?" })
    // The company's people come from the project, as on the board.
    expect(
      await within(who).findByRole("option", { name: "Mara Lindqvist, Head of operations" }),
    ).toBeInTheDocument()
    await userEvent.selectOptions(within(who).getByLabelText("Waiting on"), "stk_k1")
    await userEvent.click(
      within(who).getByRole("button", { name: "Move to Waiting on the customer" }),
    )
    await waitFor(async () =>
      expect(await titles("Waiting on the customer")).toContain(
        "Add driver-hours checks to the eval suite",
      ),
    )
  })

  it("moves nothing when a prompt is cancelled", async () => {
    await today()
    await pick(DUE, "Mark blocked…")
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    )

    expect(screen.queryByRole("dialog")).toBeNull()
    expect(await titles("Due")).toContain(DUE)
  })

  it("starts a task and files it back to to do from the menu", async () => {
    await today()
    await pick(DUE, "Start")
    await waitFor(async () =>
      expect(
        (
          await api.project({
            company: CompanyId.parse("cmp_brightwater"),
            project: ProjectId.parse("prj_bw_referrals"),
          })
        ).tasks.find((t) => t.title === DUE)?.status,
      ).toBe("in_progress"),
    )
    // Still due, so it stays where it is.
    expect(await titles("Due")).toContain(DUE)
  })

  it("leaves a row where it was and says why when the API refuses", async () => {
    await today()
    wire.refuse = Response.json({ error: "unavailable" }, { status: 503 })

    await userEvent.click(screen.getByRole("button", { name: `Done: ${DUE}` }))

    expect(await within(row(DUE)).findByRole("alert")).toHaveTextContent(
      "Couldn't move it to Done. The workspace is briefly unavailable. Try again in a minute.",
    )
    expect(await titles("Due")).toContain(DUE)
    expect(screen.queryByText("Moving to Done…")).toBeNull()
    expect(screen.getByText(/^19 need you/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("shows a refusal when the dev mock is told to fail writes", async () => {
    await today()
    ;(globalThis as Record<string, unknown>).__fdeMockFailWrites = true
    try {
      await userEvent.click(screen.getByRole("button", { name: `Mark granted: ${REQUESTED}` }))
      expect(await within(row(REQUESTED)).findByRole("alert")).toHaveTextContent(
        "Couldn't change it to Granted. The workspace is briefly unavailable.",
      )
      expect(await titles("Waiting on the customer")).toContain(REQUESTED)
    } finally {
      delete (globalThis as Record<string, unknown>).__fdeMockFailWrites
    }
  })

  it("says the task is gone when it was deleted elsewhere, and reads Today again", async () => {
    await today()
    await api.removeTask(scope, TaskId.parse("tsk_k4"))

    await userEvent.click(screen.getByRole("button", { name: `Unblock: ${BLOCKED}` }))

    await waitFor(async () => expect(await titles("Blocked")).not.toContain(BLOCKED))
    expect(screen.getByRole("status")).toHaveTextContent("")
    // The row has gone, so the refusal is said above the groups rather than vanishing with it.
    expect(screen.getByRole("alert")).toHaveTextContent(
      `Couldn't move “${BLOCKED}” to In progress. The task is no longer there.`,
    )
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("keeps a confirmed move when a read of Today taken before it arrives after it", async () => {
    const { queryClient } = renderWithRouter(<TodayView />)
    await screen.findByRole("region", { name: "Blocked" })
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await userEvent.click(screen.getByRole("button", { name: `Done: ${DUE}` }))
    await screen.findByText("Moving to Done…")

    // A refetch (window focus) reads Today while the move is on the wire; its answer is late.
    let read = () => {}
    wire.holdReads = new Promise((resolve) => (read = resolve))
    void queryClient.invalidateQueries({ queryKey: ["today"] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    answered()
    await waitFor(async () => expect(await titles("Due")).not.toContain(DUE))
    read()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(await titles("Due")).not.toContain(DUE)
  })

  describe("access requests", () => {
    it("marks a request granted, which takes it off Today and unblocks what waited on it", async () => {
      await today()
      const bw = {
        company: CompanyId.parse("cmp_brightwater"),
        project: ProjectId.parse("prj_bw_referrals"),
      }
      expect(await titles("Blocked")).toContain("Staging credentials for the intake API")

      await userEvent.click(screen.getByRole("button", { name: `Mark granted: ${REQUESTED}` }))

      await waitFor(async () =>
        expect(await titles("Waiting on the customer")).not.toContain(REQUESTED),
      )
      const saved = (await api.project(bw)).access.find(
        (a) => a.description === "Intake form API, staging",
      )
      // Everything but the status is sent as it was.
      expect(saved).toMatchObject({ status: "granted", system: "sys_b1", owner: "stk_b2" })
      expect(saved?.granted_at).toBeTruthy()
      // Today reads again after the API's rules have run; here the mock has already unblocked it.
      await waitFor(async () =>
        expect(await titles("Blocked")).not.toContain("Staging credentials for the intake API"),
      )
    })

    it("asks again for a refused request, which moves it under waiting", async () => {
      await today()

      await userEvent.click(screen.getByRole("button", { name: `Ask again: ${DENIED}` }))

      await waitFor(async () => expect(await titles("Waiting on the customer")).toContain(DENIED))
      expect(await titles("Blocked")).not.toContain(DENIED)
      expect(await sectionTitle(DENIED)).toBe("Waiting on the customer")
    })

    it("offers the other statuses in the menu, and not the one it is in", async () => {
      await today()
      await userEvent.click(screen.getByRole("button", { name: `Actions for ${REQUESTED}` }))
      const items = (await screen.findAllByRole("menuitem")).map((i) => i.textContent)
      expect(items).toEqual(["Mark in progress", "Mark denied", "Open project"])
      await userEvent.keyboard("{Escape}")

      await userEvent.click(screen.getByRole("button", { name: `Actions for ${DENIED}` }))
      expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual([
        "Mark in progress",
        "Mark granted",
        "Open project",
      ])
    })
  })

  describe("from the keyboard", () => {
    const focused = () => document.activeElement?.closest("[data-row]")?.getAttribute("data-row")

    it("moves between rows with j and k, and the arrows once a row is focused", async () => {
      await today()

      await userEvent.keyboard("j")
      expect(focused()).toBe("access:acc_k3")
      await userEvent.keyboard("j")
      expect(focused()).toBe("task:tsk_f1")
      await userEvent.keyboard("k")
      expect(focused()).toBe("access:acc_k3")
      await userEvent.keyboard("{ArrowDown}{ArrowDown}")
      expect(focused()).toBe("task:tsk_k4")
      await userEvent.keyboard("{ArrowUp}")
      expect(focused()).toBe("task:tsk_f1")
      // Not past the first row.
      await userEvent.keyboard("kkkkk")
      expect(focused()).toBe("access:acc_k3")
    })

    it("is one stop for Tab: the row the keys are on", async () => {
      await today()
      await userEvent.keyboard("jj")

      const reachable = Array.from(
        document.querySelectorAll<HTMLElement>("[data-row] :is(a, button)"),
      ).filter((el) => el.getAttribute("tabindex") !== "-1")
      // Its link, its action and its menu, and nothing from any other row.
      expect(reachable.map((el) => el.closest("li")?.dataset.row)).toEqual([
        "task:tsk_f1",
        "task:tsk_f1",
        "task:tsk_f1",
      ])
    })

    it("opens the project with Enter on a row", async () => {
      const { router } = renderWithRouter(<TodayView />)
      await screen.findByRole("region", { name: "Blocked" })
      await userEvent.keyboard("j")

      await userEvent.keyboard("{Enter}")

      expect(router.state.location.pathname).toBe(
        "/companies/cmp_kestrel/projects/prj_kestrel_dispatch",
      )
    })

    it("does the row's main action with e, and moves on to the next row", async () => {
      await today()
      await userEvent.keyboard("jj")
      expect(focused()).toBe("task:tsk_f1")

      await userEvent.keyboard("e")

      await waitFor(async () =>
        expect(await titles("Blocked")).not.toContain("Roll out to the north depot crews"),
      )
      // Focus lands on the row that followed it, so the next e acts on that one.
      await waitFor(() => expect(focused()).toBe("task:tsk_k4"))
      expect(document.activeElement).toBe(row(BLOCKED))
    })

    it("falls back to the row before when the last one is cleared", async () => {
      await today()
      const waiting = await titles("Waiting on the customer")
      const last = waiting[waiting.length - 1]!
      row(last).focus()

      await userEvent.keyboard("e")

      await waitFor(async () => expect(await titles("Waiting on the customer")).not.toContain(last))
      await waitFor(() => expect(focused()).toBe(row(waiting[waiting.length - 2]!).dataset.row))
    })

    it("opens the menu with m, on its first entry, and picks with the arrows and Enter", async () => {
      await today()
      await userEvent.keyboard("jj")

      await userEvent.keyboard("m")
      expect(await screen.findByRole("menu")).toBeInTheDocument()
      // The first entry for a blocked task is Mark done; Enter takes it.
      expect(screen.getByRole("menuitem", { name: "Mark done" })).toHaveFocus()
      await userEvent.keyboard("{Enter}")
      await waitFor(async () =>
        expect(await titles("Blocked")).not.toContain("Roll out to the north depot crews"),
      )

      // Focus has moved on to the next row. Arrow down to the second entry, which asks first.
      await waitFor(() => expect(document.activeElement).toBe(row(BLOCKED)))
      await userEvent.keyboard("m")
      await screen.findByRole("menu")
      await userEvent.keyboard("{ArrowDown}{Enter}")
      expect(
        await screen.findByRole("dialog", { name: "Who is this waiting on?" }),
      ).toBeInTheDocument()
    })

    it("leaves the keys alone while a field or a dialog has them", async () => {
      await today()
      await pick(DUE, "Mark blocked…")
      const blocker = await screen.findByLabelText("The blocker")
      await userEvent.click(blocker)

      await userEvent.keyboard("jke m")

      expect(blocker).toHaveValue("jke m")
      expect(document.activeElement).toBe(blocker)
      expect(await titles("Due")).toContain(DUE)
    })

    it("does not take a key with a modifier, or the arrows when no row has focus", async () => {
      await today()
      const before = document.activeElement

      fireEvent.keyDown(document.body, { key: "j", ctrlKey: true })
      fireEvent.keyDown(document.body, { key: "ArrowDown" })

      expect(document.activeElement).toBe(before)
    })

    it("does not move focus to the next row when the person has gone elsewhere", async () => {
      await today()
      let answered = () => {}
      wire.hold = new Promise((resolve) => (answered = resolve))
      await userEvent.keyboard("jj")
      await userEvent.keyboard("e")
      await screen.findByText(/^Moving to/)
      // Tab to somewhere that is not the row while it saves.
      const elsewhere = screen.getByRole("button", { name: `Actions for ${BLOCKED}` })
      elsewhere.focus()

      answered()
      await waitFor(async () =>
        expect(await titles("Blocked")).not.toContain("Roll out to the north depot crews"),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(document.activeElement).toBe(elsewhere)
    })
  })

  describe("projects with no next step", () => {
    it("lists each with its company and one way to give it one: New task, open on the project", async () => {
      renderWithRouter(<TodayView />)
      const card = await screen.findByRole("region", { name: "No next step" })
      expect(within(card).getByText("Outage report summaries")).toBeInTheDocument()
      expect(within(card).getByText("Cobalt Grid")).toBeInTheDocument()
      const link = within(card).getByRole("link", {
        name: "Add a next step to Outage report summaries",
      })
      expect(link).toHaveAttribute(
        "href",
        "/companies/cmp_cobalt/projects/prj_cobalt_outage?add=task",
      )
      // Not a row of the inbox: J and K skip it, and it has no menu.
      expect(card.querySelector("[data-row]")).toBeNull()
    })

    it("shows no card when every project has a next step", async () => {
      wire.today = Response.json({ items: [], projects_without_next_step: [] })
      renderWithRouter(<TodayView />)
      expect(await screen.findByText("Nothing needs you today.")).toBeInTheDocument()
      expect(screen.queryByRole("region", { name: "No next step" })).toBeNull()
    })

    it("is not all clear while a project has none", async () => {
      wire.today = Response.json({
        items: [],
        projects_without_next_step: [
          {
            company: { id: "cmp_kestrel", name: "Kestrel Freight" },
            project: { id: "prj_kestrel_claims", name: "Damage claims triage" },
          },
        ],
      })
      renderWithRouter(<TodayView />)
      expect(await screen.findByText("1 project has no next step.")).toBeInTheDocument()
      expect(screen.queryByText("Nothing needs you today.")).toBeNull()
    })
  })

  describe("what is left", () => {
    it("says nothing needs you only once the API has answered and every group is empty", async () => {
      let answered = () => {}
      const gate = new Promise<void>((resolve) => (answered = resolve))
      wire.holdReads = gate
      wire.today = Response.json({ items: [] })
      renderWithRouter(<TodayView />)

      expect(await screen.findByRole("status")).toHaveTextContent("Gathering what needs you today")
      expect(screen.queryByText("Nothing needs you today.")).toBeNull()
      answered()

      expect(await screen.findByText("Nothing needs you today.")).toBeInTheDocument()
    })

    it("counts what is left as rows leave, and says so when the last one goes", async () => {
      wire.today = Response.json({
        items: [
          {
            kind: "task",
            task: {
              id: "tsk_only",
              title: "The only thing",
              status: "todo",
              due_on: "2000-01-01",
              created_at: "2026-10-01T09:00:00Z",
              updated_at: "2026-10-01T09:00:00Z",
              version: 1,
            },
            company: { id: "cmp_kestrel", name: "Kestrel Freight" },
            project: { id: "prj_kestrel_dispatch", name: "Dispatch copilot" },
          },
        ],
      })
      renderWithRouter(<TodayView />)
      expect(await screen.findByText("1 needs you across 1 company: 1 due.")).toBeInTheDocument()
      // The API's next read of Today has nothing in it.
      wire.today = Response.json({ items: [] })

      await userEvent.click(screen.getByRole("button", { name: "Done: The only thing" }))
      expect(await screen.findByText("Nothing needs you today.")).toBeInTheDocument()
    })
  })
})

describe("the API mock", () => {
  it("refuses what the API refuses on an access request", async () => {
    renderWithRouter(<TodayView />)
    const body = { description: "x", status: "requested" as const }
    const acc = AccessRequestId.parse("acc_k3")
    const refused = (b: object, id = acc) =>
      api.updateAccess(scope, id, b as never, 1).catch((e: unknown) => e)

    expect(await refused({ ...body, status: "nope" })).toMatchObject({ status: 400 })
    expect(await refused({ ...body, description: " " })).toMatchObject({ status: 400 })
    expect(await refused({ ...body, owner: "stk_nobody" })).toMatchObject({ status: 400 })
    expect(await refused({ ...body, system: "sys_nobody" })).toMatchObject({ status: 400 })
    expect(await refused(body, AccessRequestId.parse("acc_missing"))).toMatchObject({ status: 404 })
  })

  it("stamps a status change and sets or clears granted_at, as the API does", async () => {
    renderWithRouter(<TodayView />)
    const acc = AccessRequestId.parse("acc_k3")
    // Each save names the version of what it is based on: the answer's is the next one's.
    const send = (status: "granted" | "requested", version: number) =>
      api.updateAccess(scope, acc, { description: "Telematics export", status }, version)

    const granted = await send("granted", 1)
    expect(granted.granted_at).toBeTruthy()
    expect(granted.status_changed_at >= granted.requested_at).toBe(true)
    expect((await send("requested", granted.version)).granted_at).toBeNull()
  })
})
