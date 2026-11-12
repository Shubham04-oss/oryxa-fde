import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { CompanyPage } from "./company-page"
import { ProjectPage } from "./project-page"
import { resetMockApi } from "@/dev/mock-api"
import { api } from "@/lib/api/client"
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
/** Two notes, a long one with actions and an agreement in it; at Build. */
const DISPATCH = scopeOf("cmp_kestrel", "prj_kestrel_dispatch")
/** Discover, with no note: the checklist asks for one. */
const CLAIMS = scopeOf("cmp_kestrel", "prj_kestrel_claims")
const KESTREL = CompanyId.parse("cmp_kestrel")

const WORKSHOP = "Dispatcher workshop, Leeds depot"
const IT_CALL = "Data access call with IT"

const card = () => screen.findByRole("region", { name: "Notes" })
const writer = () => screen.findByRole("dialog", { name: "Write a note" })
const editor = () => screen.findByRole("dialog", { name: "Edit note" })
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
const field = (box: HTMLElement, label: string) => within(box).getByLabelText(label)
const bodyOf = (box: HTMLElement) => field(box, "Note") as HTMLTextAreaElement
const refuseWith = (status: number, error: string) =>
  (wire.refuse = Response.json({ error }, { status }))

async function write(box: HTMLElement, fields: { title?: string; text?: string }) {
  if (fields.title) await userEvent.type(field(box, "Title"), fields.title)
  if (fields.text) {
    await userEvent.click(bodyOf(box))
    await userEvent.paste(fields.text)
  }
}

/** Selects `part` of the note being read, as a person does, and tells the page. */
function select(root: HTMLElement, part: string) {
  const text = root.firstChild as Text
  const from = text.data.indexOf(part)
  expect(from, part).toBeGreaterThanOrEqual(0)
  const range = document.createRange()
  range.setStart(text, from)
  range.setEnd(text, from + part.length)
  const picked = window.getSelection()!
  picked.removeAllRanges()
  picked.addRange(range)
  document.dispatchEvent(new Event("selectionchange"))
}

describe("the notes list", () => {
  it("lists the newest meeting first: when it was, who was there from the team and from the customer", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const notes = await card()
    const rows = await within(notes).findAllByRole("listitem")
    expect(rows.map((row) => row.querySelector("h3")?.textContent)).toEqual([WORKSHOP, IT_CALL])
    await waitFor(() => expect(rows[0]).toHaveTextContent("Attended: You and Jonah Ade"))
    expect(rows[0]).toHaveTextContent("With Mara Lindqvist, Ines Moreau")
    // Someone at the customer was there and no one else from the team: nothing is said of the team.
    expect(rows[1]).toHaveTextContent("Attended: You")
    expect(rows[1]).toHaveTextContent("With Tomas Becker")
  })

  it("says what a note is for when there are none, and that a read that failed can be tried again", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    expect(
      await within(await card()).findByText(/No notes on this project yet/),
    ).toBeInTheDocument()
  })

  it("keeps a failed read to the card, with Try again", async () => {
    wire.refuseReads = {
      ending: "/meeting-notes",
      response: Response.json({ error: "unavailable" }, { status: 400 }),
    }
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const notes = await card()
    expect(await within(notes).findByRole("alert")).toHaveTextContent("We couldn't read the notes.")
    wire.refuseReads = null
    await userEvent.click(within(notes).getByRole("button", { name: "Try again" }))
    expect(await within(notes).findByRole("button", { name: WORKSHOP })).toBeInTheDocument()
    // The rest of the page was never in question.
    expect(screen.getByRole("region", { name: "Board" })).toBeInTheDocument()
  })

  it("shows a note as plain text with its lines kept: markup in it is only characters", async () => {
    resetMockApi()
    await api.addNote(CLAIMS, {
      title: "<img src=x onerror=alert(1)> & **bold**",
      held_on: "2026-11-09",
      body: "<b>not bold</b> and **not bold either**\n\n- [ ] a line\n<script>alert(1)</script>",
      attendees: [],
      stakeholders: [],
    })
    renderWithRouter(<ProjectPage scope={CLAIMS} />, { keep: true })
    const notes = await card()
    const row = (await within(notes).findAllByRole("listitem"))[0]!
    // The two-line preview on the card is text too, before the note is opened.
    const preview = row.querySelector("[data-note-body]")!
    expect(preview).toHaveClass("line-clamp-2")
    expect(preview.children).toHaveLength(0)
    expect(preview.textContent).toContain("<script>alert(1)</script>")
    expect(row.querySelector("img, b, script, strong")).toBeNull()
    await userEvent.click(within(row).getAllByRole("button")[0]!)
    const body = row.querySelector("[data-note-body]")!
    expect(body.textContent).toBe(
      "<b>not bold</b> and **not bold either**\n\n- [ ] a line\n<script>alert(1)</script>",
    )
    expect(body.children).toHaveLength(0)
    expect(row.querySelector("img, b, script, strong")).toBeNull()
    expect(row.querySelector("h3")?.textContent).toBe("<img src=x onerror=alert(1)> & **bold**")
    expect(body).toHaveClass("whitespace-pre-wrap")
  })

  it("opens a note to read it all and shuts it again", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const notes = await card()
    const toggle = await within(notes).findByRole("button", { name: WORKSHOP })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(notes).toHaveTextContent("Went through a real morning")
    expect(notes).toHaveTextContent("Drivers hate being re-planned")
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
  })
})

describe("writing a note", () => {
  it("opens on the words, with the title and the day above, and is held today with you there", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    const notes = await card()
    await userEvent.click(within(notes).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    expect(bodyOf(box)).toHaveFocus()
    expect(field(box, "Held on")).toHaveValue(localDay())
    expect(within(box).getByRole("checkbox", { name: "You" })).toBeChecked()
    expect(box).toHaveTextContent("0 of 20,000 characters")
    // Whoever works on the project can be ticked, by name; and the company's four at the customer.
    expect(await within(box).findByRole("checkbox", { name: "Jonah Ade" })).not.toBeChecked()
    expect(within(box).getAllByRole("checkbox")).toHaveLength(2 + 4)
  })

  it("picks a teammate who works on the project as an attendee, by name", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    await userEvent.click(await within(box).findByRole("checkbox", { name: "Jonah Ade" }))
    await write(box, { title: "Claims sync", text: "Agreed the sample set." })
    await userEvent.click(within(box).getByRole("button", { name: "Save note" }))
    await closed()
    expect(wire.sent[0]).toMatchObject({ body: { attendees: ["usr_riya", "usr_jonah"] } })
    const rows = await within(await card()).findAllByRole("listitem")
    expect(rows[0]).toHaveTextContent("Attended: You and Jonah Ade")
  })

  it("says plainly when names are unavailable, and still offers who works there by the end of their id", async () => {
    ;(globalThis as Record<string, unknown>).__fdeMockPeople = "unavailable"
    try {
      renderWithRouter(<ProjectPage scope={CLAIMS} />)
      await userEvent.click(within(await card()).getByRole("button", { name: "Write a note" }))
      const box = await writer()
      expect(await within(box).findByText(/Names are unavailable right now/)).toBeInTheDocument()
      expect(
        await within(box).findByRole("checkbox", { name: "A teammate …_jonah" }),
      ).toBeInTheDocument()
    } finally {
      delete (globalThis as Record<string, unknown>).__fdeMockPeople
    }
  })

  it("saves a note once the API confirms it, with every field, and the checklist is read again", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    const notes = await card()
    const checklist = await screen.findByRole("region", { name: "To leave Discover" })
    expect(checklist).toHaveTextContent("1 of 2 met")
    await userEvent.click(within(notes).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    await write(box, {
      title: "Kickoff with claims",
      text: "Agreed the goal.\nNext: sample claims.",
    })
    await userEvent.click(within(box).getByRole("checkbox", { name: /Ines Moreau/ }))
    expect(box).toHaveTextContent("37 of 20,000 characters")

    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await userEvent.click(within(box).getByRole("button", { name: "Save note" }))
    expect(await within(box).findByRole("button", { name: "Saving…" })).toBeDisabled()
    // Nothing is shown as saved until the API says so.
    expect(within(notes).queryByRole("button", { name: "Kickoff with claims" })).toBeNull()
    answered()
    await closed()

    expect(wire.sent).toHaveLength(1)
    expect(wire.sent[0]).toMatchObject({
      method: "POST",
      path: "/companies/cmp_kestrel/projects/prj_kestrel_claims/meeting-notes",
      body: {
        title: "Kickoff with claims",
        held_on: localDay(),
        body: "Agreed the goal.\nNext: sample claims.",
        stakeholders: ["stk_k2"],
        attendees: ["usr_riya"],
      },
    })
    expect(
      await within(notes).findByRole("button", { name: "Kickoff with claims" }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(within(notes).getByRole("button", { name: "Write a note" })).toHaveFocus(),
    )
    // The Discover item is met: the checklist says so.
    expect(await screen.findByText(/Ready to leave Discover/)).toBeInTheDocument()
  })

  it("asks for a title and some words before it sends anything, and names the field", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    await userEvent.click(within(box).getByRole("button", { name: "Save note" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("Give the note a title.")
    await waitFor(() => expect(field(box, "Title")).toHaveFocus())
    expect(field(box, "Title")).toHaveAttribute("aria-invalid", "true")
    await userEvent.type(field(box, "Title"), "Kickoff")
    await userEvent.click(within(box).getByRole("button", { name: "Save note" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("Write the note first.")
    await waitFor(() => expect(bodyOf(box)).toHaveFocus())
    expect(wire.sent).toEqual([])
  })

  it("refuses a note over 20,000 characters, says by how much, and keeps every word", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    await userEvent.type(field(box, "Title"), "Everything")
    const long = "word ".repeat(4100)
    fireEvent.change(bodyOf(box), { target: { value: long } })
    expect(box).toHaveTextContent("20,499 of 20,000 characters")
    await userEvent.click(within(box).getByRole("button", { name: "Save note" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "A note is up to 20,000 characters. This one is 20,499.",
    )
    expect(bodyOf(box)).toHaveAttribute("aria-invalid", "true")
    expect(bodyOf(box).value).toBe(long)
    expect(wire.sent).toEqual([])
  })

  it("keeps what was typed when the API cannot save, says what happened, and saves on the next try", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    const notes = await card()
    await userEvent.click(within(notes).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    await write(box, { title: "Long call", text: "Line one\nLine two\n\nLine four" })
    refuseWith(503, "unavailable")
    await userEvent.click(within(box).getByRole("button", { name: "Save note" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("briefly unavailable")
    expect(box).toBeInTheDocument()
    expect(field(box, "Title")).toHaveValue("Long call")
    expect(bodyOf(box).value).toBe("Line one\nLine two\n\nLine four")
    expect(within(box).getByRole("button", { name: "Save note" })).toBeEnabled()
    expect(within(notes).queryByRole("button", { name: "Long call" })).toBeNull()

    // And a refusal that is about a field marks that field, with the words kept too.
    refuseWith(400, "invalid_held_on")
    await userEvent.click(within(box).getByRole("button", { name: "Save note" }))
    await waitFor(() => expect(field(box, "Held on")).toHaveAttribute("aria-invalid", "true"))
    await waitFor(() => expect(field(box, "Held on")).toHaveFocus())
    expect(bodyOf(box).value).toBe("Line one\nLine two\n\nLine four")

    wire.refuse = null
    await userEvent.click(within(box).getByRole("button", { name: "Save note" }))
    await closed()
    expect(
      await within(await card()).findByRole("button", { name: "Long call" }),
    ).toBeInTheDocument()
  })

  it("keeps the words when the network fails outright", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    await write(box, { title: "Offline call", text: "All of this" })
    refuseWith(500, "internal")
    await userEvent.click(within(box).getByRole("button", { name: "Save note" }))
    expect(await within(box).findByRole("alert")).toBeInTheDocument()
    expect(bodyOf(box).value).toBe("All of this")
  })

  it("names the field of a refusal about the customer's people, and keeps the choice", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    await write(box, { title: "Call", text: "Words" })
    await userEvent.click(within(box).getByRole("checkbox", { name: /Mara Lindqvist/ }))
    refuseWith(400, "invalid_stakeholders")
    await userEvent.click(within(box).getByRole("button", { name: "Save note" }))
    const mara = within(box).getByRole("checkbox", { name: /Mara Lindqvist/ })
    await waitFor(() => expect(mara).toHaveAttribute("aria-invalid", "true"))
    expect(mara).toBeChecked()
    await waitFor(() => expect(mara).toHaveFocus())
  })

  it("asks before it throws words away, and a note nobody has written in closes at once", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    const notes = await card()
    await userEvent.click(within(notes).getByRole("button", { name: "Write a note" }))
    let box = await writer()
    await userEvent.click(within(box).getByRole("button", { name: "Cancel" }))
    await closed()

    await userEvent.click(within(notes).getByRole("button", { name: "Write a note" }))
    box = await writer()
    await write(box, { text: "A page of thoughts" })
    await userEvent.click(within(box).getByRole("button", { name: "Cancel" }))
    const ask = await within(box).findByRole("alertdialog", { name: "Confirm leaving the note" })
    expect(ask).toHaveTextContent("What you wrote is lost")
    const keep = within(ask).getByRole("button", { name: "Keep writing" })
    expect(keep).toHaveFocus()
    // Escape does the same, and does not close it.
    await userEvent.keyboard("{Escape}")
    expect(screen.getByRole("dialog", { name: "Write a note" })).toBeInTheDocument()
    await userEvent.click(keep)
    expect(within(box).queryByRole("alertdialog", { name: "Confirm leaving the note" })).toBeNull()
    expect(bodyOf(box).value).toBe("A page of thoughts")

    await userEvent.click(within(box).getByRole("button", { name: "Cancel" }))
    await userEvent.click(await within(box).findByRole("button", { name: "Leave" }))
    await closed()
    expect(wire.sent).toEqual([])
    await waitFor(() =>
      expect(within(notes).getByRole("button", { name: "Write a note" })).toHaveFocus(),
    )
  })

  it("asks before leaving the page with words in it, and lets a note nobody wrote go at once", async () => {
    const { router } = renderWithRouter(<ProjectPage scope={CLAIMS} />, { at: "/projects/claims" })
    const notes = await card()
    await userEvent.click(within(notes).getByRole("button", { name: "Write a note" }))
    let box = await writer()
    // Nothing written: going elsewhere is not held up.
    await router.navigate({ to: "/elsewhere" as never })
    await waitFor(() => expect(router.state.location.pathname).toBe("/elsewhere"))
    await router.navigate({ to: "/projects/claims" as never })

    // Every path renders the page here, so the dialog is still open.
    box = await writer()
    await write(box, { text: "Forty minutes of notes" })
    // The back button, a link or a sign-in redirect: the page stays, and asks.
    void router.navigate({ to: "/elsewhere" as never })
    const ask = await within(box).findByRole("alertdialog", { name: "Confirm leaving the note" })
    expect(router.state.location.pathname).toBe("/projects/claims")
    await userEvent.click(within(ask).getByRole("button", { name: "Keep writing" }))
    expect(within(box).queryByRole("alertdialog")).toBeNull()
    expect(bodyOf(box).value).toBe("Forty minutes of notes")
    expect(router.state.location.pathname).toBe("/projects/claims")

    void router.navigate({ to: "/elsewhere" as never })
    await userEvent.click(
      within(
        await within(box).findByRole("alertdialog", { name: "Confirm leaving the note" }),
      ).getByRole("button", { name: "Leave" }),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe("/elsewhere"))
    expect(wire.sent).toEqual([])
  })

  it("tells a screen reader the count once typing pauses", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    const live = box.querySelector("[aria-live='polite']")!
    expect(live.textContent).toBe("")
    await write(box, { text: "Twelve words" })
    await waitFor(() => expect(live.textContent).toBe("12 of 20,000 characters"), { timeout: 2000 })
    expect(within(box).getByRole("button", { name: "Make a task" })).toHaveAccessibleDescription(
      "Select a line, or put the cursor on it:",
    )
  })

  it("is offered to an engineer, who works on the project like anyone", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />, { engineer: true })
    expect(within(await card()).getByRole("button", { name: "Write a note" })).toBeEnabled()
  })
})

describe("changing and removing a note", () => {
  it("opens on the note as it is, sends every field, and shows the change once the API confirms it", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const notes = await card()
    await userEvent.click(await within(notes).findByRole("button", { name: `Edit ${IT_CALL}` }))
    const box = await editor()
    expect(field(box, "Title")).toHaveValue(IT_CALL)
    expect(bodyOf(box).value).toMatch(/^Tomas can give a read replica/)
    expect(within(box).getByRole("checkbox", { name: /Tomas Becker/ })).toBeChecked()
    expect(within(box).getByRole("checkbox", { name: /Mara Lindqvist/ })).not.toBeChecked()

    await userEvent.clear(field(box, "Title"))
    await userEvent.type(field(box, "Title"), "Data access call, IT")
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    expect(await within(box).findByRole("button", { name: "Saving…" })).toBeDisabled()
    expect(within(notes).queryByRole("button", { name: "Data access call, IT" })).toBeNull()
    answered()
    await closed()

    // The PUT replaces the note, so it carries every field.
    expect(wire.sent).toHaveLength(1)
    expect(wire.sent[0]).toMatchObject({
      method: "PUT",
      path: expect.stringMatching(/\/prj_kestrel_dispatch\/meeting-notes\/mtg_kd2$/),
      body: {
        title: "Data access call, IT",
        held_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        body: expect.stringMatching(/^Tomas can give a read replica/),
        stakeholders: ["stk_k3"],
        attendees: ["usr_riya"],
      },
    })
    expect(
      await within(notes).findByRole("button", { name: "Data access call, IT" }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(notes).getByRole("button", { name: "Edit Data access call, IT" }),
      ).toHaveFocus(),
    )
  })

  it("keeps a teammate attendee on a save, shown by name", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(
      await within(await card()).findByRole("button", { name: `Edit ${WORKSHOP}` }),
    )
    const box = await editor()
    const teammate = await within(box).findByRole("checkbox", { name: "Jonah Ade" })
    expect(teammate).toBeChecked()
    await userEvent.type(field(box, "Title"), "!")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await closed()
    expect(wire.sent[0]).toMatchObject({ body: { attendees: ["usr_riya", "usr_jonah"] } })
  })

  it("sends nothing when nothing changed", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(
      await within(await card()).findByRole("button", { name: `Edit ${IT_CALL}` }),
    )
    const box = await editor()
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    await closed()
    expect(wire.sent).toEqual([])
  })

  it("keeps an edit's words when the API refuses it", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(
      await within(await card()).findByRole("button", { name: `Edit ${IT_CALL}` }),
    )
    const box = await editor()
    await userEvent.type(bodyOf(box), " And one more thing.")
    refuseWith(403, "forbidden")
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "You are not allowed to do that here",
    )
    expect(bodyOf(box).value).toMatch(/And one more thing\.$/)
  })

  it("says the note is gone when it was removed elsewhere, and reads the list again", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const notes = await card()
    await userEvent.click(await within(notes).findByRole("button", { name: `Edit ${IT_CALL}` }))
    const box = await editor()
    await userEvent.type(field(box, "Title"), "!")
    // Someone else removed it while the form was open.
    await api.removeNote(DISPATCH, "mtg_kd2" as never)
    await userEvent.click(within(box).getByRole("button", { name: "Save" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("The note is no longer there.")
    await waitFor(() => expect(within(notes).queryByRole("button", { name: IT_CALL })).toBeNull())
  })

  it("removes a note after asking, and only once the API confirms", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const notes = await card()
    await userEvent.click(await within(notes).findByRole("button", { name: `Edit ${IT_CALL}` }))
    const box = await editor()
    await userEvent.click(within(box).getByRole("button", { name: "Delete note" }))
    const ask = within(box).getByRole("group", { name: "Confirm the delete" })
    expect(ask).toHaveTextContent("Delete this note? This cannot be undone.")
    // A project past Discover has no checklist item to reopen, so it says nothing of one.
    expect(ask).not.toHaveTextContent("Discover")
    await userEvent.click(within(ask).getByRole("button", { name: "Keep it" }))
    expect(wire.sent).toEqual([])

    await userEvent.click(within(box).getByRole("button", { name: "Delete note" }))
    let answered = () => {}
    wire.hold = new Promise((resolve) => (answered = resolve))
    await userEvent.click(
      within(within(box).getByRole("group", { name: "Confirm the delete" })).getByRole("button", {
        name: "Delete",
      }),
    )
    // Still listed behind the dialog until the API says it is gone.
    expect(within(notes).getByRole("button", { name: IT_CALL, hidden: true })).toBeInTheDocument()
    answered()
    await closed()
    expect(wire.sent[0]).toMatchObject({
      method: "DELETE",
      path: expect.stringMatching(/\/prj_kestrel_dispatch\/meeting-notes\/mtg_kd2$/),
    })
    expect(within(notes).queryByRole("button", { name: IT_CALL })).toBeNull()
    expect(within(notes).getByRole("button", { name: WORKSHOP })).toBeInTheDocument()
    // The row that opened it is gone, so focus goes to the card's own button.
    await waitFor(() =>
      expect(within(notes).getByRole("button", { name: "Write a note" })).toHaveFocus(),
    )
  })

  it("keeps the dialog open with its reason when a removal fails", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    await userEvent.click(
      await within(await card()).findByRole("button", { name: `Edit ${IT_CALL}` }),
    )
    const box = await editor()
    await userEvent.click(within(box).getByRole("button", { name: "Delete note" }))
    refuseWith(503, "unavailable")
    await userEvent.click(
      within(within(box).getByRole("group", { name: "Confirm the delete" })).getByRole("button", {
        name: "Delete",
      }),
    )
    expect(await within(box).findByRole("alert")).toHaveTextContent("briefly unavailable")
    expect(box).toBeInTheDocument()
  })

  it("reads the stage checklist again after a removal: the project's only note met the Discover item", async () => {
    resetMockApi()
    await api.addNote(CLAIMS, {
      title: "The only call",
      held_on: "2026-11-09",
      body: "Words",
      attendees: [],
      stakeholders: [],
    })
    renderWithRouter(<ProjectPage scope={CLAIMS} />, { keep: true })
    expect(await screen.findByText(/Ready to leave Discover/)).toBeInTheDocument()
    await userEvent.click(
      await within(await card()).findByRole("button", { name: "Edit The only call" }),
    )
    const box = await editor()
    await userEvent.click(within(box).getByRole("button", { name: "Delete note" }))
    expect(within(box).getByRole("group", { name: "Confirm the delete" })).toHaveTextContent(
      "It is the project's only one, so the Discover checklist asks for a note again.",
    )
    await userEvent.click(
      within(within(box).getByRole("group", { name: "Confirm the delete" })).getByRole("button", {
        name: "Delete",
      }),
    )
    await closed()
    const checklist = await screen.findByRole("region", { name: "To leave Discover" })
    expect(checklist).toHaveTextContent("Open: A meeting note on the project")
  })
})

describe("from a note to a task or a decision", () => {
  it("makes a task from the line the cursor is on, while writing, without losing the note", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    const notes = await card()
    await userEvent.click(within(notes).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    const text = "Call with claims\n- [ ] Send Ines the format\nThen the rest"
    await write(box, { title: "Claims call", text })
    // The cursor is on the second line.
    bodyOf(box).setSelectionRange(text.indexOf("Send") + 3, text.indexOf("Send") + 3)
    const make = within(box).getByRole("button", { name: "Make a task" })
    await userEvent.click(make)

    const form = await screen.findByRole("dialog", { name: "New task" })
    expect(field(form, "Title")).toHaveValue("Send Ines the format")
    await userEvent.click(within(form).getByRole("button", { name: "Add task" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull())

    // The task went to the board with the usual task body; nothing links it to the note.
    expect(wire.sent).toHaveLength(1)
    expect(wire.sent[0]).toMatchObject({
      method: "POST",
      path: "/companies/cmp_kestrel/projects/prj_kestrel_claims/tasks",
      body: { title: "Send Ines the format", status: "todo" },
    })
    // The note is as it was, still open, and says what was made. Focus is back on the button.
    expect(screen.getByRole("dialog", { name: "Write a note" })).toBe(box)
    expect(bodyOf(box).value).toBe(text)
    expect(field(box, "Title")).toHaveValue("Claims call")
    expect(within(box).getByRole("status", { name: "Made from this note" })).toHaveTextContent(
      "Added the task “Send Ines the format” to the board.",
    )
    await waitFor(() => expect(make).toHaveFocus())
    // And the task is on the board, behind the dialog.
    expect(
      within(screen.getByRole("region", { name: "Board", hidden: true })).getByText(
        "Send Ines the format",
      ),
    ).toBeInTheDocument()
  })

  it("prefers what is selected to the line, and a task that fails to save keeps the form and the note", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    const text = "Agreed: Ines reviews the format by Friday."
    await write(box, { title: "Claims call", text })
    bodyOf(box).setSelectionRange(text.indexOf("Ines"), text.indexOf(" by Friday"))
    await userEvent.click(within(box).getByRole("button", { name: "Make a task" }))
    const form = await screen.findByRole("dialog", { name: "New task" })
    expect(field(form, "Title")).toHaveValue("Ines reviews the format")
    refuseWith(503, "unavailable")
    await userEvent.click(within(form).getByRole("button", { name: "Add task" }))
    expect(await within(form).findByRole("alert")).toHaveTextContent("briefly unavailable")
    expect(field(form, "Title")).toHaveValue("Ines reviews the format")
    // Escape closes the task form only; the note and its words are still there.
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull())
    expect(bodyOf(box).value).toBe(text)
  })

  it("starts from an empty title when no line is chosen, for the FDE to type", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    await userEvent.click(within(box).getByRole("button", { name: "Make a task" }))
    const form = await screen.findByRole("dialog", { name: "New task" })
    expect(field(form, "Title")).toHaveValue("")
  })

  it("logs a decision from a line, while writing, with the usual decision form", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    await userEvent.click(within(await card()).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    const text = "We start with damage claims only."
    await write(box, { title: "Scoping call", text })
    bodyOf(box).setSelectionRange(0, 0)
    await userEvent.click(within(box).getByRole("button", { name: "Log a decision" }))
    const form = await screen.findByRole("dialog", { name: "Log a decision" })
    expect(field(form, "What was decided")).toHaveValue(text)
    await userEvent.type(field(form, "Why"), "They are the largest queue.")
    await userEvent.type(field(form, "Who decided"), "Mara Lindqvist")
    await userEvent.click(within(form).getByRole("button", { name: "Log decision" }))
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Log a decision" })).toBeNull())
    expect(wire.sent[0]).toMatchObject({
      path: "/companies/cmp_kestrel/projects/prj_kestrel_claims/decisions",
      body: { title: text, rationale: "They are the largest queue.", decided_by: "Mara Lindqvist" },
    })
    expect(within(box).getByRole("status", { name: "Made from this note" })).toHaveTextContent(
      `Logged the decision “${text}”.`,
    )
    expect(bodyOf(box).value).toBe(text)
  })

  it("makes a task from the words selected in a note being read, and leaves the note open", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const notes = await card()
    const toggle = await within(notes).findByRole("button", { name: WORKSHOP })
    await userEvent.click(toggle)
    const root = notes.querySelector<HTMLElement>('[data-note-body="mtg_kd1"]')!
    select(root, "- Drivers hate being re-planned after they have clocked on.")
    const make = within(notes).getByRole("button", { name: `Make a task from ${WORKSHOP}` })
    await userEvent.click(make)
    const form = await screen.findByRole("dialog", { name: "New task" })
    expect(field(form, "Title")).toHaveValue(
      "Drivers hate being re-planned after they have clocked on.",
    )
    await userEvent.clear(field(form, "Title"))
    await userEvent.type(field(form, "Title"), "Plan nothing after clock-on")
    await userEvent.click(within(form).getByRole("button", { name: "Add task" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    expect(wire.sent[0]).toMatchObject({ body: { title: "Plan nothing after clock-on" } })
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(within(notes).getByRole("status")).toHaveTextContent(
      "Added the task “Plan nothing after clock-on” to the board.",
    )
    await waitFor(() => expect(make).toHaveFocus())
    // The selection was used once; the next task starts from nothing.
    await userEvent.click(make)
    expect(field(await screen.findByRole("dialog", { name: "New task" }), "Title")).toHaveValue("")
  })

  it("logs a decision from the words selected in a note being read, in the Decisions log", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const notes = await card()
    await userEvent.click(await within(notes).findByRole("button", { name: WORKSHOP }))
    const root = notes.querySelector<HTMLElement>('[data-note-body="mtg_kd1"]')!
    select(
      root,
      "We pilot at Leeds and Ghent only, plans stay drafts and nothing goes to drivers directly.",
    )
    await userEvent.click(
      within(notes).getByRole("button", { name: `Log a decision from ${WORKSHOP}` }),
    )
    const form = await screen.findByRole("dialog", { name: "Log a decision" })
    expect(field(form, "What was decided")).toHaveValue(
      "We pilot at Leeds and Ghent only, plans stay drafts and nothing goes to drivers directly.",
    )
    await userEvent.type(field(form, "Why"), "Fewest depots, cleanest data.")
    await userEvent.type(field(form, "Who decided"), "Ines Moreau")
    await userEvent.click(within(form).getByRole("button", { name: "Log decision" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    const decisions = screen.getByRole("region", { name: "Decisions" })
    expect(
      within(decisions).getByText(/^We pilot at Leeds and Ghent only, plans stay drafts/),
    ).toBeInTheDocument()
  })

  it("offers neither on a note at the company: a task and a decision belong to a project", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    const notes = await card()
    await userEvent.click(
      await within(notes).findByRole("button", {
        name: "Quarterly review with Kestrel leadership",
      }),
    )
    expect(within(notes).queryByRole("button", { name: /Make a task|Log a decision/ })).toBeNull()
  })
})

describe("notes on the company", () => {
  it("lists them, and says the Discover checklist counts only the project's", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    const notes = await card()
    expect(
      await within(notes).findByRole("button", {
        name: "Quarterly review with Kestrel leadership",
      }),
    ).toBeInTheDocument()
    expect(notes).toHaveTextContent("A note here belongs to the company.")
    expect(notes).toHaveTextContent("counts only the notes written on the project itself")
  })

  it("writes one to the company's own route", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    const notes = await card()
    await userEvent.click(within(notes).getByRole("button", { name: "Write a note" }))
    const box = await writer()
    // The company's team and its four people at the customer can be ticked.
    await within(box).findByRole("checkbox", { name: "Jonah Ade" })
    expect(within(box).getAllByRole("checkbox")).toHaveLength(2 + 4)
    expect(within(box).queryByRole("button", { name: "Make a task" })).toBeNull()
    await write(box, { title: "Steering call", text: "General points." })
    await userEvent.click(within(box).getByRole("button", { name: "Save note" }))
    await closed()
    expect(wire.sent[0]).toMatchObject({
      method: "POST",
      path: "/companies/cmp_kestrel/meeting-notes",
    })
    expect(await within(notes).findByRole("button", { name: "Steering call" })).toBeInTheDocument()
  })

  it("does not meet a project's checklist: a company note leaves the item open", async () => {
    resetMockApi()
    await api.addNote(
      { company: KESTREL },
      {
        title: "Company call",
        held_on: "2026-11-09",
        body: "Words",
        attendees: [],
        stakeholders: [],
      },
    )
    renderWithRouter(<ProjectPage scope={CLAIMS} />, { keep: true })
    const checklist = await screen.findByRole("region", { name: "To leave Discover" })
    expect(checklist).toHaveTextContent("Open: A meeting note on the project")
    // And the project's own list does not hold it.
    expect(
      await within(await card()).findByText(/No notes on this project yet/),
    ).toBeInTheDocument()
  })
})
