import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { CompanyPage } from "./company-page"
import { api } from "@/lib/api/client"
import { CompanyId } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

// A company's main contact (#238, #244): one of its stakeholders, or none, set on its own route
// (`PUT .../main-contact`) and shown in the Stakeholders card.

beforeAll(installWire)
afterEach(resetWire)

const KESTREL = CompanyId.parse("cmp_kestrel")
const card = () => screen.findByRole("region", { name: "Stakeholders" })
const sent = () => wire.sent.filter((w) => w.path.endsWith("/main-contact"))

describe("a company's main contact", () => {
  it("is named in the Stakeholders card, and marked on their row", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    const people = await card()
    expect(
      within(people).getByText("Main contact: Mara Lindqvist, Head of operations."),
    ).toBeInTheDocument()
    const row = within(people).getByRole("button", { name: "Edit Mara Lindqvist" })
    expect(row).toHaveTextContent("Main contact")
    expect(within(people).getByRole("button", { name: "Edit Ines Moreau" })).not.toHaveTextContent(
      "Main contact",
    )
  })

  it("is changed to another stakeholder, and only one is ever marked", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Change main contact" }))
    const box = await screen.findByRole("dialog", { name: "Main contact" })
    await userEvent.selectOptions(within(box).getByLabelText("Main contact"), "stk_k2")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(sent()).toEqual([
      {
        method: "PUT",
        path: "/companies/cmp_kestrel/main-contact",
        body: { stakeholder: "stk_k2" },
      },
    ])
    const people = await card()
    expect(
      within(people).getByText("Main contact: Ines Moreau, Dispatch lead, Ghent."),
    ).toBeInTheDocument()
    expect(within(people).getAllByText("Main contact")).toHaveLength(1)
    expect((await api.company(KESTREL)).stakeholders.filter((s) => s.main_contact)).toHaveLength(1)
  })

  it("is cleared by choosing none, sent as null", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Change main contact" }))
    const box = await screen.findByRole("dialog", { name: "Main contact" })
    await userEvent.selectOptions(within(box).getByLabelText("Main contact"), "")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(sent()[0]!.body).toEqual({ stakeholder: null })
    expect(
      within(await card()).getByRole("button", { name: "Choose a main contact" }),
    ).toBeInTheDocument()
  })

  it("sends nothing when the choice is unchanged", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Change main contact" }))
    const box = await screen.findByRole("dialog", { name: "Main contact" })
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(sent()).toEqual([])
  })

  it("keeps the dialog open with the API's words when it is refused", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Change main contact" }))
    const box = await screen.findByRole("dialog", { name: "Main contact" })
    await userEvent.selectOptions(within(box).getByLabelText("Main contact"), "stk_k3")
    wire.refuse = Response.json({ error: "invalid_stakeholder" }, { status: 400 })
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    expect(
      await within(box).findByText("That person is not a stakeholder at this company."),
    ).toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Main contact" })).toBeInTheDocument()
  })
})
