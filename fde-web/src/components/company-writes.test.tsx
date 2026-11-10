import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { AppShell } from "./app-shell"
import { CompaniesHome } from "./companies-home"
import { CompanyPage } from "./company-page"
import { ProjectPage } from "./project-page"
import { api, queries } from "@/lib/api/client"
import type { ApiError } from "@/lib/api/client"
import { CompanyId, ProjectId, TenantId, UserId } from "@/lib/api/schemas"
import type { Me } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"
import { resetMockApi } from "@/dev/mock-api"
import { installWire, resetWire, wire } from "@/test/wire"

beforeAll(installWire)
afterEach(resetWire)

const KESTREL = CompanyId.parse("cmp_kestrel")
const BRIGHTWATER = CompanyId.parse("cmp_brightwater")
const DISPATCH = { company: KESTREL, project: ProjectId.parse("prj_kestrel_dispatch") }
const forbidden = () => Response.json({ error: "forbidden" }, { status: 403 })

const dialog = (name: string) => screen.findByRole("dialog", { name })
const field = (box: HTMLElement, label: string) => within(box).getByLabelText(label)
/** Clears a field and types `text` (an empty string just clears it). */
async function fill(box: HTMLElement, label: string, text: string) {
  const input = field(box, label)
  await userEvent.clear(input)
  if (text) await userEvent.type(input, text)
}
const writes = () => wire.sent.map(({ method, path }) => `${method} ${path}`)

describe("a new company", () => {
  it("is offered first to someone with none, and opens on its page once the API has made it", async () => {
    const { router, queryClient } = renderWithRouter(<CompaniesHome />, { empty: true })
    expect(await screen.findByText("Add your first company")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "New company" }))
    const box = await dialog("New company")
    await fill(box, "Name", "Orion Rail")
    await fill(box, "Industry", "Transport")
    await userEvent.click(within(box).getByRole("button", { name: "Create company" }))

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/companies\/cmp_new/))
    // Sent as the API takes it: a blank is not sent as text.
    expect(wire.sent[0]).toMatchObject({
      method: "POST",
      path: "/companies",
      body: { name: "Orion Rail", industry: "Transport", region: null, summary: null },
    })
    // It is in the list at once (the sidebar and Jump to read it), and its page is ready, empty.
    const list = queryClient.getQueryData(queries.companies().queryKey)
    expect(list?.companies).toMatchObject([{ name: "Orion Rail", role: "lead", projects: [] }])
    const id = CompanyId.parse(list!.companies[0]!.id)
    expect(queryClient.getQueryData(queries.company(id).queryKey)).toMatchObject({
      stakeholders: [],
      systems: [],
    })
  })

  it("shows up in the sidebar and in Jump to without a reload", async () => {
    const me: Me = {
      user: { id: UserId.parse("usr_riya"), name: "Riya Kapoor" },
      organisation: { id: TenantId.parse("org_northlight"), name: "Northlight FDE" },
      role: "admin",
    }
    renderWithRouter(
      <AppShell me={me}>
        <CompaniesHome />
      </AppShell>,
    )
    const nav = await screen.findByRole("navigation", { name: "Main" })
    await within(nav).findByText("5")

    await userEvent.click(await screen.findByRole("button", { name: "New company" }))
    const box = await dialog("New company")
    await fill(box, "Name", "Orion Rail")
    await userEvent.click(within(box).getByRole("button", { name: "Create company" }))

    const yours = await screen.findByRole("region", { name: "Your companies" })
    expect(await within(yours).findByRole("link", { name: "Orion Rail" })).toBeInTheDocument()
    expect(within(nav).getByText("6")).toBeInTheDocument()
  })

  it("asks for a name before it sends anything", async () => {
    renderWithRouter(<CompaniesHome />)
    await userEvent.click(await screen.findByRole("button", { name: "New company" }))
    const box = await dialog("New company")
    await userEvent.click(within(box).getByRole("button", { name: "Create company" }))
    expect(within(box).getByRole("alert")).toHaveTextContent("Name the company.")
    await fill(box, "Name", "x".repeat(201))
    await userEvent.click(within(box).getByRole("button", { name: "Create company" }))
    expect(within(box).getByRole("alert")).toHaveTextContent("A name is one line, 1 to 200")
    expect(wire.sent).toEqual([])
  })

  it("stays open with what was typed, and the reason, when the API refuses", async () => {
    const { queryClient } = renderWithRouter(<CompaniesHome />)
    await userEvent.click(await screen.findByRole("button", { name: "New company" }))
    const box = await dialog("New company")
    await fill(box, "Name", "Orion Rail")
    wire.refuse = forbidden()
    await userEvent.click(within(box).getByRole("button", { name: "Create company" }))

    expect(await within(box).findByRole("alert")).toHaveTextContent("You are not allowed")
    expect(field(box, "Name")).toHaveValue("Orion Rail")
    expect(queryClient.getQueryData(queries.companies().queryKey)?.companies).toHaveLength(5)
  })

  it("says the workspace is unavailable when it is, and keeps the form", async () => {
    renderWithRouter(<CompaniesHome />)
    await userEvent.click(await screen.findByRole("button", { name: "New company" }))
    const box = await dialog("New company")
    await fill(box, "Name", "Orion Rail")
    wire.refuse = Response.json({ error: "unavailable" }, { status: 503 })
    await userEvent.click(within(box).getByRole("button", { name: "Create company" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("briefly unavailable")
  })

  it("is not shown as saved until the API answers", async () => {
    const { router } = renderWithRouter(<CompaniesHome />)
    await userEvent.click(await screen.findByRole("button", { name: "New company" }))
    const box = await dialog("New company")
    await fill(box, "Name", "Orion Rail")
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await userEvent.click(within(box).getByRole("button", { name: "Create company" }))

    expect(await within(box).findByRole("button", { name: "Saving…" })).toBeDisabled()
    expect(router.state.location.pathname).toBe("/")
    answered()
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/companies\/cmp_new/))
  })
})

describe("a company's profile", () => {
  it("is edited by its lead, sending only what changed", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Edit company" }))
    const box = await dialog("Edit company")
    expect(field(box, "Industry")).toHaveValue("Logistics")
    await fill(box, "Summary", "A freight carrier with 14 depots.")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(wire.sent).toHaveLength(1)
    expect(wire.sent[0]).toMatchObject({
      method: "PATCH",
      path: "/companies/cmp_kestrel",
      body: { summary: "A freight carrier with 14 depots." },
    })
    expect(await screen.findByText("A freight carrier with 14 depots.")).toBeInTheDocument()
  })

  it("does not undo a teammate's change that arrives while the form is open", async () => {
    const { queryClient } = renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Edit company" }))
    const box = await dialog("Edit company")
    // A teammate changes the industry, and the page reads the company again behind the form.
    await api.updateCompany(KESTREL, { industry: "Freight" })
    await queryClient.refetchQueries({ queryKey: queries.company(KESTREL).queryKey })
    wire.sent = []
    await fill(box, "Summary", "A freight carrier with 14 depots.")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(wire.sent.map((w) => w.body)).toEqual([{ summary: "A freight carrier with 14 depots." }])
    expect((await api.company(KESTREL)).industry).toBe("Freight")
  })

  it("clears a field that is emptied, and sends nothing when nothing changed", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Edit company" }))
    let box = await dialog("Edit company")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(wire.sent).toEqual([])

    await userEvent.click(screen.getByRole("button", { name: "Edit company" }))
    box = await dialog("Edit company")
    await fill(box, "Region", "")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(wire.sent).toHaveLength(1))
    expect(wire.sent[0]?.body).toEqual({ region: null })
    await waitFor(() => expect(screen.getAllByText("Not set")).toHaveLength(1))
  })

  it("keeps the old profile on screen when the API refuses the change", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Edit company" }))
    const box = await dialog("Edit company")
    await fill(box, "Name", "Kestrel Logistics")
    wire.refuse = forbidden()
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("You are not allowed")
    expect(field(box, "Name")).toHaveValue("Kestrel Logistics")
    expect(
      within(screen.getByRole("region", { name: "Profile", hidden: true })).getByText(
        "A regional freight carrier with 14 depots. Wants dispatchers to plan in minutes.",
      ),
    ).toBeInTheDocument()
  })

  it("is not offered to an engineer, who is told why, but can still add stakeholders", async () => {
    // Riya is an engineer at Brightwater, and not an organisation admin here.
    renderWithRouter(<CompanyPage companyId={BRIGHTWATER} />, { engineer: true })
    await screen.findByRole("heading", { name: "Profile" })
    expect(screen.queryByRole("button", { name: "Edit company" })).toBeNull()
    expect(screen.queryByRole("button", { name: "New project" })).toBeNull()
    expect(
      screen.getByText(
        "Only a lead or an organisation admin changes the profile or starts a project.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add stakeholder" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add system" })).toBeInTheDocument()
  })

  it("shows the API's refusal when it disagrees about who may change it", async () => {
    // Offered on what the list says; the API's answer is the one that counts.
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Edit company" }))
    const box = await dialog("Edit company")
    await fill(box, "Industry", "Freight")
    wire.refuse = forbidden()
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "Ask a lead, or an organisation admin.",
    )
  })
})

describe("a company's projects", () => {
  it("starts at Discover and opens on its page, with what to do first", async () => {
    const { router, queryClient } = renderWithRouter(<CompanyPage companyId={KESTREL} />)
    // The sidebar has the list; this page does not, so read it as the sidebar would.
    await queryClient.fetchQuery(queries.companies())
    await userEvent.click(await screen.findByRole("button", { name: "New project" }))
    const box = await dialog("New project")
    await fill(box, "Name", "Depot rules audit")
    await userEvent.click(within(box).getByRole("button", { name: "Create project" }))

    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(
        /^\/companies\/cmp_kestrel\/projects\/prj_new/,
      ),
    )
    expect(wire.sent[0]).toMatchObject({
      method: "POST",
      path: "/companies/cmp_kestrel/projects",
      body: { name: "Depot rules audit", summary: null },
    })
    const company = queryClient.getQueryData(queries.company(KESTREL).queryKey)
    expect(company?.projects.at(-1)).toMatchObject({ name: "Depot rules audit", stage: "discover" })
    // The company's list (the sidebar, Jump to and Home) has it too.
    const list = queryClient.getQueryData(queries.companies().queryKey)
    expect(list?.companies.find((c) => c.id === KESTREL)?.projects.at(-1)?.name).toBe(
      "Depot rules audit",
    )
  })

  it("opens a new project on a page that says what to do next", async () => {
    resetMockApi()
    const made = await api.createProject(KESTREL, { name: "Depot rules audit" })
    renderWithRouter(
      <ProjectPage scope={{ company: KESTREL, project: ProjectId.parse(made.id) }} />,
      { keep: true },
    )
    expect(await screen.findByText("A new project. Start here.")).toBeInTheDocument()
    expect(screen.getByText(/Name who you work with at Kestrel Freight/)).toBeInTheDocument()
  })

  it("says what to do when a company has no project, and who can start one", async () => {
    resetMockApi()
    const made = await api.createCompany({ name: "Orion Rail" })
    renderWithRouter(<CompanyPage companyId={CompanyId.parse(made.id)} />, { keep: true })
    expect(await screen.findByText(/Start one for the first piece of work/)).toBeInTheDocument()
    expect(screen.getByText(/Add the people you work with at the customer/)).toBeInTheDocument()
    expect(screen.getByText(/Add what the work touches at the customer/)).toBeInTheDocument()
  })

  it("needs a name", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "New project" }))
    const box = await dialog("New project")
    await userEvent.click(within(box).getByRole("button", { name: "Create project" }))
    expect(within(box).getByRole("alert")).toHaveTextContent("Name the project.")
    expect(wire.sent).toEqual([])
  })

  it("is edited by name and summary, sending only what changed", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(await screen.findByRole("button", { name: "Edit project" }))
    const box = await dialog("Edit project")
    expect(field(box, "Name")).toHaveValue("Dispatch copilot")
    await fill(box, "Name", "Dispatch planner")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(wire.sent[0]).toMatchObject({
      method: "PATCH",
      path: "/companies/cmp_kestrel/projects/prj_kestrel_dispatch",
      body: { name: "Dispatch planner" },
    })
    expect((await api.project(DISPATCH)).name).toBe("Dispatch planner")
  })
})

describe("stakeholders", () => {
  it("are added, then shown only once the API has confirmed", async () => {
    const { queryClient } = renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Add stakeholder" }))
    const box = await dialog("Add stakeholder")
    await fill(box, "Name", "Pia Haas")
    await userEvent.selectOptions(within(box).getByLabelText("Their part"), "security")
    await fill(box, "Job title", "CISO")
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await userEvent.click(within(box).getByRole("button", { name: "Add stakeholder" }))

    expect(await within(box).findByRole("button", { name: "Saving…" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Edit Pia Haas" })).toBeNull()
    answered()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    const added = await screen.findByRole("button", { name: "Edit Pia Haas" })
    expect(within(added).getByText("Security")).toBeInTheDocument()
    expect(wire.sent[0]).toMatchObject({
      path: "/companies/cmp_kestrel/stakeholders",
      body: { name: "Pia Haas", role: "security", title: "CISO", email: null },
    })
    expect(queryClient.getQueryData(queries.company(KESTREL).queryKey)?.stakeholders).toHaveLength(
      5,
    )
  })

  it("send back every field when one is edited, including the email the form shows", async () => {
    // Give one an address first, so there is something to lose.
    resetMockApi()
    const [mara] = (await api.company(KESTREL)).stakeholders
    await api.updateStakeholder(
      KESTREL,
      mara!.id,
      {
        name: mara!.name,
        role: mara!.role,
        title: mara!.title,
        email: "mara@example.com",
      },
      mara!.version,
    )
    resetWire()
    renderWithRouter(<CompanyPage companyId={KESTREL} />, { keep: true })
    await userEvent.click(await screen.findByRole("button", { name: "Edit Mara Lindqvist" }))
    const box = await dialog("Edit stakeholder")
    expect(field(box, "Email")).toHaveValue("mara@example.com")
    await fill(box, "Job title", "Chief operating officer")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    expect(wire.sent[0]).toMatchObject({
      method: "PUT",
      path: `/companies/cmp_kestrel/stakeholders/${mara!.id}`,
      body: {
        name: "Mara Lindqvist",
        role: "sponsor",
        title: "Chief operating officer",
        email: "mara@example.com",
      },
    })
    expect(await screen.findByText("Chief operating officer")).toBeInTheDocument()
  })

  it("show the API's words for an address it refuses", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Add stakeholder" }))
    const box = await dialog("Add stakeholder")
    await fill(box, "Name", "Pia Haas")
    await fill(box, "Email", "pia")
    await userEvent.click(within(box).getByRole("button", { name: "Add stakeholder" }))
    expect(within(box).getByRole("alert")).toHaveTextContent(
      "Use an address like name@example.com.",
    )
    expect(wire.sent).toEqual([])

    // What the browser lets through but the API refuses is shown the same way.
    wire.refuse = Response.json({ error: "invalid_email" }, { status: 400 })
    await fill(box, "Email", "pia@example.com")
    await userEvent.click(within(box).getByRole("button", { name: "Add stakeholder" }))
    await waitFor(() => expect(wire.sent).toHaveLength(1))
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "Use an address like name@example.com.",
    )
  })

  it("are removed only after asking, and one who signed off a scope stays, with the reason", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    // Ines has signed off nothing.
    await userEvent.click(await screen.findByRole("button", { name: "Edit Ines Moreau" }))
    let box = await dialog("Edit stakeholder")
    await userEvent.click(within(box).getByRole("button", { name: "Remove stakeholder" }))
    const ask = within(box).getByRole("group", { name: "Confirm the removal" })
    // From the keyboard: the question takes focus on its safe answer, and Enter keeps them.
    expect(within(ask).getByRole("button", { name: "Keep it" })).toHaveFocus()
    await userEvent.keyboard("{Enter}")
    expect(within(box).queryByRole("group", { name: "Confirm the removal" })).toBeNull()
    expect(writes()).toEqual([])
    await userEvent.click(within(box).getByRole("button", { name: "Remove stakeholder" }))
    await userEvent.click(
      within(within(box).getByRole("group", { name: "Confirm the removal" })).getByRole("button", {
        name: "Remove",
      }),
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.queryByRole("button", { name: "Edit Ines Moreau" })).toBeNull()
    expect(writes()).toEqual([`DELETE /companies/cmp_kestrel/stakeholders/stk_k2`])

    // Mara signed off the scope: the API refuses, and the dialog says so and keeps her.
    await userEvent.click(screen.getByRole("button", { name: "Edit Mara Lindqvist" }))
    box = await dialog("Edit stakeholder")
    await userEvent.click(within(box).getByRole("button", { name: "Remove stakeholder" }))
    await userEvent.click(
      within(within(box).getByRole("group", { name: "Confirm the removal" })).getByRole("button", {
        name: "Remove",
      }),
    )
    expect(await within(box).findByRole("alert")).toHaveTextContent("signed off a scope")
    expect(
      screen.getByRole("button", { name: "Edit Mara Lindqvist", hidden: true }),
    ).toBeInTheDocument()
  })

  it("show the API's refusal for a save the API rejects, with the dialog kept", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Edit Ines Moreau" }))
    const box = await dialog("Edit stakeholder")
    await fill(box, "Job title", "Dispatch lead")
    wire.refuse = forbidden()
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("You are not allowed")
    expect(field(box, "Job title")).toHaveValue("Dispatch lead")
    expect(
      screen.getByRole("button", { name: "Edit Ines Moreau", hidden: true }),
    ).toHaveTextContent("Dispatch lead, Ghent")
  })

  it("keep a saved one when a read of the company taken before it arrives after it", async () => {
    const { queryClient } = renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await screen.findByRole("button", { name: "Add stakeholder" })
    await userEvent.click(screen.getByRole("button", { name: "Add stakeholder" }))
    const box = await dialog("Add stakeholder")
    await fill(box, "Name", "Pia Haas")
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await userEvent.click(within(box).getByRole("button", { name: "Add stakeholder" }))
    await within(box).findByRole("button", { name: "Saving…" })

    // A refetch (window focus, another tab) reads the company while the save is still on the wire.
    let read = () => {}
    wire.holdReads = new Promise((resolve) => (read = resolve))
    void queryClient.invalidateQueries({ queryKey: ["companies", KESTREL] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    answered()
    await screen.findByRole("button", { name: "Edit Pia Haas" })
    read()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByRole("button", { name: "Edit Pia Haas" })).toBeInTheDocument()
  })

  it("start as an empty list that says what to add", async () => {
    resetMockApi()
    const made = await api.createCompany({ name: "Orion Rail" })
    renderWithRouter(<CompanyPage companyId={CompanyId.parse(made.id)} />, { keep: true })
    expect(await screen.findByText(/No stakeholders yet/)).toBeInTheDocument()
    expect(screen.getByText(/No systems yet/)).toBeInTheDocument()
  })
})

describe("systems", () => {
  it("are added, edited with every field, and removed after asking", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Add system" }))
    let box = await dialog("Add system")
    await fill(box, "Name", "Ticket queue")
    await fill(box, "Kind", "Helpdesk")
    await userEvent.click(within(box).getByRole("button", { name: "Add system" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(wire.sent[0]).toMatchObject({
      path: "/companies/cmp_kestrel/systems",
      body: { name: "Ticket queue", kind: "Helpdesk", description: null },
    })

    await userEvent.click(await screen.findByRole("button", { name: "Edit Planning database" }))
    box = await dialog("Edit system")
    await fill(box, "Kind", "Postgres")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    // The description the form shows goes back with the rest.
    expect(wire.sent[1]).toMatchObject({
      method: "PUT",
      body: {
        name: "Planning database",
        kind: "Postgres",
        description: "Read replica only; nightly refresh.",
      },
    })

    await userEvent.click(screen.getByRole("button", { name: "Edit Depot rules" }))
    box = await dialog("Edit system")
    await userEvent.click(within(box).getByRole("button", { name: "Remove system" }))
    expect(within(box).getByRole("group", { name: "Confirm the removal" })).toHaveTextContent(
      "Remove Depot rules?",
    )
    await userEvent.click(
      within(within(box).getByRole("group", { name: "Confirm the removal" })).getByRole("button", {
        name: "Remove",
      }),
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.queryByRole("button", { name: "Edit Depot rules" })).toBeNull()
    expect(wire.sent[2]).toMatchObject({ method: "DELETE" })
  })

  it("need a name", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Add system" }))
    const box = await dialog("Add system")
    await userEvent.click(within(box).getByRole("button", { name: "Add system" }))
    expect(within(box).getByRole("alert")).toHaveTextContent("Name the system.")
  })

  it("keep a system whose removal the API refuses", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(await screen.findByRole("button", { name: "Edit Telematics" }))
    const box = await dialog("Edit system")
    await userEvent.click(within(box).getByRole("button", { name: "Remove system" }))
    wire.refuse = Response.json({ error: "not_found" }, { status: 404 })
    await userEvent.click(
      within(within(box).getByRole("group", { name: "Confirm the removal" })).getByRole("button", {
        name: "Remove",
      }),
    )
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "The system is no longer there.",
    )
  })
})

describe("the team", () => {
  it("shows who is on a company and changes a role, once the API confirms", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    const team = await screen.findByRole("region", { name: "Team" })
    expect(await within(team).findByText("You")).toBeInTheDocument()
    expect(within(team).getByText("A teammate")).toBeInTheDocument()

    const role = within(team).getByLabelText(/Role of teammate/)
    expect(role).toHaveValue("engineer")
    await userEvent.selectOptions(role, "lead")
    await waitFor(() =>
      expect(wire.sent[0]).toMatchObject({
        method: "PUT",
        path: "/companies/cmp_kestrel/members/usr_jonah",
        body: { role: "lead" },
      }),
    )
    await waitFor(() => expect(within(team).getByLabelText(/Role of teammate/)).toHaveValue("lead"))
  })

  it("keeps the old role and says why when the API refuses", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    const team = await screen.findByRole("region", { name: "Team" })
    await within(team).findByText("You")
    wire.refuse = forbidden()
    await userEvent.selectOptions(within(team).getByLabelText(/Role of teammate/), "lead")
    expect(await within(team).findByRole("alert")).toHaveTextContent("You are not allowed")
    expect(within(team).getByLabelText(/Role of teammate/)).toHaveValue("engineer")
  })

  it("removes someone only after asking", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    const team = await screen.findByRole("region", { name: "Team" })
    await within(team).findByText("You")
    await userEvent.click(within(team).getByRole("button", { name: /Remove teammate/ }))
    await userEvent.click(within(team).getByRole("button", { name: "Keep" }))
    expect(writes()).toEqual([])
    await userEvent.click(within(team).getByRole("button", { name: /Remove teammate/ }))
    await userEvent.click(
      within(within(team).getByRole("group", { name: /Confirm removing/ })).getByRole("button", {
        name: "Remove",
      }),
    )
    await waitFor(() => expect(within(team).queryByText("A teammate")).toBeNull())
    expect(writes()).toEqual(["DELETE /companies/cmp_kestrel/members/usr_jonah"])
  })

  it("never offers to remove or demote the only lead, and asks before a lead steps down", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    const team = await screen.findByRole("region", { name: "Team" })
    await within(team).findByText("You")
    // You are Kestrel's only lead: the API would let you go, so the screen does not offer it.
    expect(within(team).queryByLabelText("Role of you")).toBeNull()
    expect(within(team).queryByRole("button", { name: "Remove yourself" })).toBeNull()
    expect(within(team).getByText(/A company always has a lead/)).toBeInTheDocument()

    await userEvent.selectOptions(within(team).getByLabelText(/Role of teammate/), "lead")
    const mine = await within(team).findByLabelText("Role of you")
    expect(within(team).queryByText(/A company always has a lead/)).toBeNull()
    wire.sent = []
    await userEvent.selectOptions(mine, "engineer")
    const ask = within(team).getByRole("group", { name: "Confirm stepping down" })
    await userEvent.click(within(ask).getByRole("button", { name: "Keep" }))
    expect(writes()).toEqual([])
    expect(within(team).getByLabelText("Role of you")).toHaveValue("lead")

    await userEvent.selectOptions(within(team).getByLabelText("Role of you"), "engineer")
    await userEvent.click(
      within(within(team).getByRole("group", { name: "Confirm stepping down" })).getByRole(
        "button",
        { name: "Step down" },
      ),
    )
    await waitFor(() => expect(within(team).getByLabelText("Role of you")).toHaveValue("engineer"))
    expect(wire.sent).toEqual([
      {
        method: "PUT",
        path: "/companies/cmp_kestrel/members/usr_riya",
        body: { role: "engineer" },
      },
    ])
    // Jonah is now the only lead.
    expect(within(team).queryByLabelText(/Role of teammate/)).toBeNull()
  })

  it("is read only for an engineer, who is told who changes it", async () => {
    renderWithRouter(<CompanyPage companyId={BRIGHTWATER} />, { engineer: true })
    const team = await screen.findByRole("region", { name: "Team" })
    await within(team).findByText("You")
    expect(within(team).queryByRole("combobox")).toBeNull()
    expect(within(team).queryByRole("button", { name: /Remove/ })).toBeNull()
    expect(
      within(team).getByText(/Only a lead or an organisation admin changes the team/),
    ).toBeInTheDocument()
  })
})

describe("who is assigned to a project", () => {
  it("lists them, assigns a teammate from the company's team and unassigns one", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const card = await screen.findByRole("region", { name: "Assigned" })
    expect(await within(card).findByText("You")).toBeInTheDocument()
    await userEvent.click(within(card).getByRole("button", { name: /Remove teammate/ }))
    await userEvent.click(
      within(within(card).getByRole("group", { name: /Confirm removing/ })).getByRole("button", {
        name: "Remove",
      }),
    )
    await waitFor(() => expect(within(card).queryByText("A teammate")).toBeNull())
    expect(wire.sent[0]).toMatchObject({
      method: "DELETE",
      path: "/companies/cmp_kestrel/projects/prj_kestrel_dispatch/assignees/usr_jonah",
    })

    await userEvent.selectOptions(
      await within(card).findByLabelText("Assign from the team"),
      within(card).getByRole("option", { name: /A teammate/ }),
    )
    await userEvent.click(within(card).getByRole("button", { name: "Assign" }))
    await waitFor(() => expect(within(card).getByText("A teammate")).toBeInTheDocument())
    expect(wire.sent[1]).toMatchObject({ method: "PUT" })
  })

  it("is read only for an engineer, who may still edit the project itself", async () => {
    renderWithRouter(
      <ProjectPage
        scope={{ company: BRIGHTWATER, project: ProjectId.parse("prj_bw_referrals") }}
      />,
      {
        engineer: true,
      },
    )
    const card = await screen.findByRole("region", { name: "Assigned" })
    await within(card).findByText("You")
    expect(within(card).queryByRole("button", { name: /Remove/ })).toBeNull()
    expect(within(card).queryByLabelText("Assign from the team")).toBeNull()
    // The API's PATCH needs the project's `work`, not `manage`.
    await userEvent.click(screen.getByRole("button", { name: "Edit project" }))
    const box = await dialog("Edit project")
    await fill(box, "Summary", "Referrals triaged in a day.")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(wire.sent[0]).toMatchObject({
      method: "PATCH",
      body: { summary: "Referrals triaged in a day." },
    })
  })
})

describe("the API mock", () => {
  const refused = async (work: Promise<unknown>) => {
    try {
      await work
    } catch (e) {
      return e as ApiError
    }
    throw new Error("expected a refusal")
  }

  it("refuses what the API refuses on a company, a project, a stakeholder and a system", async () => {
    resetMockApi()
    const long = "x".repeat(201)
    expect(await refused(api.createCompany({ name: " " }))).toMatchObject({
      status: 400,
      code: "invalid_name",
    })
    expect(await refused(api.createCompany({ name: "A", industry: long }))).toMatchObject({
      code: "invalid_industry",
    })
    expect(await refused(api.createCompany({ name: "A", region: long }))).toMatchObject({
      code: "invalid_region",
    })
    expect(
      await refused(api.createCompany({ name: "A", summary: "s".repeat(4001) })),
    ).toMatchObject({ code: "invalid_summary" })
    expect(await refused(api.updateCompany(KESTREL, { name: "a\nb" }))).toMatchObject({
      code: "invalid_name",
    })
    expect(await refused(api.createProject(KESTREL, { name: "" }))).toMatchObject({
      code: "invalid_name",
    })
    expect(await refused(api.addStakeholder(KESTREL, { name: "A", email: "nope" }))).toMatchObject({
      code: "invalid_email",
    })
    expect(await refused(api.addStakeholder(KESTREL, { name: "A", title: long }))).toMatchObject({
      code: "invalid_title",
    })
    expect(await refused(api.addSystem(KESTREL, { name: "A", kind: long }))).toMatchObject({
      code: "invalid_kind",
    })
    // The whole-record replace says nothing for a record that is not there.
    expect(
      await refused(api.updateSystem(KESTREL, "sys_nope" as never, { name: "A" }, 1)),
    ).toMatchObject({ status: 404 })
  })

  it("answers 403 where the API does: a company that is not yours, and a change an engineer may not make", async () => {
    resetMockApi({ engineer: true })
    // Riya is an engineer at Brightwater: she may add a system, but not change the company.
    const bw = BRIGHTWATER
    await api.addSystem(bw, { name: "Referral inbox" })
    expect(await refused(api.updateCompany(bw, { name: "B" }))).toMatchObject({
      status: 403,
      message: expect.stringContaining("not allowed") as string,
    })
    expect(await refused(api.createProject(bw, { name: "P" }))).toMatchObject({ status: 403 })
    expect(await refused(api.setMember(bw, "usr_riya" as never, "lead"))).toMatchObject({
      status: 403,
    })
    // A company she is not on is not available to her at all.
    expect(await refused(api.company(CompanyId.parse("cmp_cobalt")))).toMatchObject({ status: 403 })
    // Any member of the organisation may create one, and leads it.
    const made = await api.createCompany({ name: "Orion Rail" })
    expect((await api.members(CompanyId.parse(made.id))).map((m) => m.role)).toEqual(["lead"])
  })
})
