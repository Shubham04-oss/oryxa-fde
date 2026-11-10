import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ProjectPage } from "./project-page"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import { localDay } from "@/lib/time"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

beforeAll(installWire)
afterEach(resetWire)

const scopeOf = (company: string, project: string) => ({
  company: CompanyId.parse(company),
  project: ProjectId.parse(project),
})
/** Three decisions, the newest promoted from a discussion about an access request. */
const DISPATCH = scopeOf("cmp_kestrel", "prj_kestrel_dispatch")
/** Nothing written in it at all. */
const CLAIMS = scopeOf("cmp_kestrel", "prj_kestrel_claims")

const card = () => screen.findByRole("region", { name: "Decisions" })
const dialog = () => screen.findByRole("dialog", { name: "Log a decision" })
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
const field = (box: HTMLElement, label: string) => within(box).getByLabelText(label)
const titles = (box: HTMLElement) =>
  within(box)
    .getAllByRole("listitem")
    .map((row) => row.querySelector("p")?.textContent)
async function log(
  box: HTMLElement,
  fields: { title?: string; why?: string; by?: string; on?: string },
) {
  if (fields.title) await userEvent.type(field(box, "What was decided"), fields.title)
  if (fields.why) await userEvent.type(field(box, "Why"), fields.why)
  if (fields.by) await userEvent.type(field(box, "Who decided"), fields.by)
  if (fields.on) {
    const on = field(box, "Decided on")
    await userEvent.clear(on)
    await userEvent.type(on, fields.on)
  }
}

describe("the decisions log", () => {
  it("lists the newest decision first, and says where a promoted one came from", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const decisions = await card()
    expect(titles(decisions)).toEqual([
      "Leave the telematics export out of the pilot",
      "Plans are drafts, never sent to drivers directly",
      "Pilot at Leeds and Ghent depots only",
    ])
    await waitFor(() =>
      expect(decisions).toHaveTextContent(
        "Promoted from a discussion about the access request “Telematics export”",
      ),
    )
    // The others came from no discussion, so say nothing of one.
    expect(decisions.textContent.match(/Promoted from/g)).toHaveLength(1)
  })

  it("can only be added to: there is no edit or remove, and the form says so", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const decisions = await card()
    expect(within(decisions).queryByRole("button", { name: /edit|remove|delete/i })).toBeNull()
    await userEvent.click(within(decisions).getByRole("button", { name: "Log a decision" }))
    const box = await dialog()
    expect(box).toHaveTextContent("cannot be edited or removed once it is logged")
    expect(within(box).queryByRole("button", { name: /remove|delete/i })).toBeNull()
  })

  it("is logged for today with the API's own timestamp, and shown once the API has confirmed", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    const decisions = await card()
    expect(decisions).toHaveTextContent(/No decisions logged yet/)
    await userEvent.click(within(decisions).getByRole("button", { name: "Log a decision" }))
    const box = await dialog()
    expect(field(box, "Decided on")).toHaveValue(localDay())
    await log(box, {
      title: "Start with damage claims only",
      why: "They are the largest queue.\nThe rest wait.",
      by: "Mara Lindqvist",
    })
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await userEvent.click(within(box).getByRole("button", { name: "Log decision" }))
    expect(await within(box).findByRole("button", { name: "Saving…" })).toBeDisabled()
    expect(within(decisions).queryByText("Start with damage claims only")).toBeNull()
    answered()
    await closed()

    expect(wire.sent).toHaveLength(1)
    expect(wire.sent[0]).toMatchObject({
      method: "POST",
      path: "/companies/cmp_kestrel/projects/prj_kestrel_claims/decisions",
      body: {
        title: "Start with damage claims only",
        rationale: "They are the largest queue.\nThe rest wait.",
        decided_by: "Mara Lindqvist",
        decided_at: null,
      },
    })
    expect(titles(decisions)).toEqual(["Start with damage claims only"])
    await waitFor(() =>
      expect(within(decisions).getByRole("button", { name: "Log a decision" })).toHaveFocus(),
    )
  })

  it("takes an earlier day, and files it among the others by that day", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const decisions = await card()
    await userEvent.click(within(decisions).getByRole("button", { name: "Log a decision" }))
    const box = await dialog()
    const day = new Date()
    day.setDate(day.getDate() - 22)
    await log(box, {
      title: "Plans cover the morning shift",
      why: "Dispatchers start at six.",
      by: "Ines Moreau",
      on: localDay(day),
    })
    await userEvent.click(within(box).getByRole("button", { name: "Log decision" }))
    await closed()
    const sent = wire.sent[0]?.body as { decided_at: string }
    // Noon where the FDE is, so the day cannot shift in the API's time zone.
    expect(new Date(sent.decided_at).getHours()).toBe(12)
    expect(localDay(new Date(sent.decided_at))).toBe(localDay(day))
    // 22 days ago falls between the decisions of 20 and 24 days ago.
    expect(titles(decisions)).toEqual([
      "Leave the telematics export out of the pilot",
      "Plans are drafts, never sent to drivers directly",
      "Plans cover the morning shift",
      "Pilot at Leeds and Ghent depots only",
    ])
  })

  it("says what is missing at its field before anything is sent", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Log a decision" }))
    const box = await dialog()
    const submit = () => userEvent.click(within(box).getByRole("button", { name: "Log decision" }))
    const states: Array<[string, string, Parameters<typeof log>[1]]> = [
      ["Say what was decided.", "What was decided", {}],
      ["Say why.", "Why", { title: "A decision" }],
      ["Say who decided.", "Who decided", { why: "A reason" }],
    ]
    for (const [message, label, typed] of states) {
      await log(box, typed)
      await submit()
      expect(within(box).getByRole("alert")).toHaveTextContent(message)
      const input = field(box, label)
      expect(input).toHaveAttribute("aria-invalid", "true")
      expect(input.getAttribute("aria-describedby")).toContain(within(box).getByRole("alert").id)
      await waitFor(() => expect(input).toHaveFocus())
    }
    // A day that has not come is not a decision yet.
    await log(box, { by: "Mara" })
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    await userEvent.clear(field(box, "Decided on"))
    await userEvent.type(field(box, "Decided on"), localDay(tomorrow))
    await submit()
    expect(within(box).getByRole("alert")).toHaveTextContent("Pick the day it was decided")
    expect(wire.sent).toEqual([])
  })

  it("keeps what was typed when the API refuses, and marks the field it names", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    const decisions = await card()
    await userEvent.click(within(decisions).getByRole("button", { name: "Log a decision" }))
    const box = await dialog()
    await log(box, { title: "Start small", why: "Less risk", by: "Mara Lindqvist" })
    wire.refuse = Response.json({ error: "invalid_rationale" }, { status: 400 })
    await userEvent.click(within(box).getByRole("button", { name: "Log decision" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("Why is plain text, up to 4000")
    expect(field(box, "Why")).toHaveAttribute("aria-invalid", "true")
    expect(field(box, "What was decided")).toHaveValue("Start small")
    expect(within(decisions).queryByText("Start small")).toBeNull()
    wire.refuse = Response.json({ error: "unavailable" }, { status: 503 })
    await userEvent.click(within(box).getByRole("button", { name: "Log decision" }))
    await waitFor(() =>
      expect(within(box).getByRole("alert")).toHaveTextContent("briefly unavailable"),
    )
    expect(field(box, "Who decided")).toHaveValue("Mara Lindqvist")
  })

  it("offers the customer's people, and the FDE, as who decided", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Log a decision" }))
    const box = await dialog()
    const list = box.querySelector("datalist")
    expect([...(list?.querySelectorAll("option") ?? [])].map((o) => o.value)).toEqual([
      "Mara Lindqvist",
      "Ines Moreau",
      "Tomas Becker",
      "Lea Novak",
      "Riya Kapoor",
    ])
  })
})
