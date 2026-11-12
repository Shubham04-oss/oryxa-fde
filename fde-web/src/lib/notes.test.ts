import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import { queries } from "./api/client"
import type { MeetingNoteOut } from "./api/schemas"
import { personOf } from "./people"
import {
  MAX_NOTE,
  attendeesLine,
  blankNote,
  chosenIn,
  commitNote,
  commitNoteRemoved,
  latestFirst,
  lineAt,
  lineToTitle,
  noteBody,
  noteChanged,
  noteEditBody,
  noteFields,
  noteLength,
  noteProblem,
  stakeholdersLine,
} from "./notes"
import { CompanyId, ProjectId } from "./api/schemas"

const at = "2026-11-04T10:00:00Z"
function note(id: string, over: Partial<Record<keyof MeetingNoteOut, unknown>> = {}) {
  return {
    id,
    title: `Note ${id}`,
    held_on: "2026-11-02",
    body: "Words",
    stakeholders: [],
    attendees: [],
    created_by: "usr_a",
    created_at: at,
    updated_at: at,
    ...over,
  } as MeetingNoteOut
}
const ok = () => ({ ...blankNote("usr_a", "2026-11-10"), title: "Kickoff", body: "Words" })

describe("a note's form", () => {
  it("starts blank, held today, with the FDE as one who was there", () => {
    expect(blankNote("usr_a", "2026-11-10")).toEqual({
      title: "",
      heldOn: "2026-11-10",
      body: "",
      stakeholders: [],
      attendees: ["usr_a"],
    })
    expect(blankNote(undefined, "2026-11-10").attendees).toEqual([])
  })

  it("says what the API would refuse, in its words, and which field it is about", () => {
    expect(noteProblem(ok())).toBeNull()
    const field = (patch: object) => (noteProblem({ ...ok(), ...patch }) as { field: string }).field
    expect(field({ title: "  " })).toBe("title")
    expect(field({ title: "a\nb" })).toBe("title")
    expect(field({ title: "x".repeat(201) })).toBe("title")
    expect(field({ heldOn: "" })).toBe("heldOn")
    expect(field({ body: " \n " })).toBe("body")
    expect(field({ body: "x".repeat(MAX_NOTE + 1) })).toBe("body")
    expect(field({ body: "bell\u0007" })).toBe("body")
    expect(field({ stakeholders: Array(51).fill("stk_1") })).toBe("stakeholders")
    expect(field({ attendees: Array(51).fill("usr_1") })).toBe("attendees")
  })

  it("allows lines and tabs, counts the trimmed text, and says how far over a long note is", () => {
    expect(noteProblem({ ...ok(), body: "one\n\ttwo" })).toBeNull()
    expect(noteProblem({ ...ok(), body: "x".repeat(MAX_NOTE) })).toBeNull()
    expect(noteLength("  é  \n")).toBe(1)
    expect(noteProblem({ ...ok(), body: ` ${"x".repeat(MAX_NOTE + 512)} ` })).toEqual({
      field: "body",
      message: "A note is up to 20,000 characters. This one is 20,512.",
    })
  })

  it("sends the trimmed words and every field", () => {
    expect(
      noteBody({ ...ok(), title: " Kickoff ", body: "\n Words \n", stakeholders: ["s1"] }),
    ).toEqual({
      title: "Kickoff",
      held_on: "2026-11-10",
      body: "Words",
      stakeholders: ["s1"],
      attendees: ["usr_a"],
    })
  })

  it("notices a change against the copy it opened on, and not a different line ending or order", () => {
    const opened = noteFields(note("a", { body: "one\r\ntwo", stakeholders: ["s1", "s2"] }))
    expect(noteChanged(opened, { ...opened, body: "one\ntwo", stakeholders: ["s2", "s1"] })).toBe(
      false,
    )
    expect(noteChanged(opened, { ...opened, body: "one\ntwo!" })).toBe(true)
    expect(noteChanged(opened, { ...opened, title: "Other" })).toBe(true)
    expect(noteChanged(opened, { ...opened, attendees: ["usr_b"] })).toBe(true)
    expect(noteChanged(opened, { ...opened, heldOn: "2026-11-03" })).toBe(true)
    expect(noteChanged(blankNote("usr_a", "2026-11-10"), blankNote("usr_a", "2026-11-10"))).toBe(
      false,
    )
  })

  it("replaces the whole note, keeping what a teammate changed meanwhile in the fields this edit left alone", () => {
    const opened = note("a", { title: "Old", body: "Old words", attendees: ["usr_a"] })
    const now = note("a", {
      title: "Teammate's title",
      body: "Teammate's words",
      held_on: "2026-11-03",
      stakeholders: ["s9"],
      attendees: ["usr_a", "usr_b"],
    })
    // This edit changed the title only.
    const body = noteEditBody(opened, now, { ...noteFields(opened), title: "Mine" })
    expect(body).toEqual({
      title: "Mine",
      held_on: "2026-11-03",
      body: "Teammate's words",
      stakeholders: ["s9"],
      attendees: ["usr_a", "usr_b"],
    })
    // With nothing newer, it is the form.
    expect(noteEditBody(opened, undefined, { ...noteFields(opened), body: "New" })).toMatchObject({
      title: "Old",
      body: "New",
    })
  })
})

describe("what the list says", () => {
  it("puts the latest meeting first, a note written later first among one day's", () => {
    const list = [
      note("a", { held_on: "2026-10-01" }),
      note("b", { held_on: "2026-11-02", created_at: "2026-11-02T09:00:00Z" }),
      note("c", { held_on: "2026-11-02", created_at: "2026-11-02T15:00:00Z" }),
    ]
    expect(latestFirst(list).map((n) => n.id)).toEqual(["c", "b", "a"])
  })

  it("says who was there by name, you first, and how many more past three", () => {
    const book = new Map([
      ["usr_b", "Jonah Ade"],
      ["usr_c", "Sam Ortiz"],
      ["usr_d", null],
    ])
    const of = (id: string) => personOf(id, { book, state: "listed", me: "usr_a" })
    const line = (...attendees: Array<string>) => attendeesLine(note("a", { attendees }), of)
    expect(line("usr_b", "usr_a", "usr_c")).toBe("You, Jonah Ade and Sam Ortiz")
    expect(line("usr_b", "usr_a", "usr_c", "usr_d")).toBe("You, Jonah Ade and 2 others")
    expect(line("usr_d")).toBe("Unnamed teammate")
    expect(line("usr_b", "usr_d")).toBe("Jonah Ade and an unnamed teammate")
    expect(line("usr_a")).toBe("You")
    expect(line()).toBeNull()
    // Before it knows who you are, it does not guess you are anyone.
    const blind = (id: string) => personOf(id, { book, state: "listed" })
    expect(attendeesLine(note("a", { attendees: ["usr_a"] }), blind)).toBe("A teammate …usr_a")
  })

  it("names the customer's people, and leaves out one the company no longer lists", () => {
    const people = [{ id: "s1", name: "Mara Lindqvist" }]
    expect(stakeholdersLine(note("a", { stakeholders: ["s1", "gone"] }), people)).toBe(
      "Mara Lindqvist",
    )
    expect(stakeholdersLine(note("a", { stakeholders: ["gone"] }), people)).toBeNull()
  })
})

describe("from a line to a title", () => {
  it("drops a list marker or a checkbox, joins lines and keeps a title to one line", () => {
    expect(lineToTitle("- Send Ines the format")).toBe("Send Ines the format")
    expect(lineToTitle("  * [ ] Ask Tomas for a replica ")).toBe("Ask Tomas for a replica")
    expect(lineToTitle("[x] done already")).toBe("done already")
    expect(lineToTitle("2) Confirm the sign-off")).toBe("Confirm the sign-off")
    expect(lineToTitle("first\n\n  second\r\nthird")).toBe("first second third")
    expect(lineToTitle("   \n ")).toBe("")
    // A dash inside the words is the person's.
    expect(lineToTitle("Mara - to confirm")).toBe("Mara - to confirm")
  })

  it("stops at the API's limit with an ellipsis", () => {
    const title = lineToTitle("word ".repeat(80))
    expect([...title]).toHaveLength(200)
    expect(title.endsWith("…")).toBe(true)
  })

  it("takes the line the cursor is on, at its start, its end and in a blank text", () => {
    const text = "one\ntwo words\n\nfour"
    expect(lineAt(text, 0)).toBe("one")
    expect(lineAt(text, 3)).toBe("one")
    expect(lineAt(text, 4)).toBe("two words")
    expect(lineAt(text, 8)).toBe("two words")
    expect(lineAt(text, 14)).toBe("")
    expect(lineAt(text, text.length)).toBe("four")
    expect(lineAt("", 0)).toBe("")
  })

  it("prefers what is selected to the line the cursor is on", () => {
    const value = "- Send Ines the format\nAsk Tomas"
    expect(chosenIn({ value, selectionStart: 0, selectionEnd: 0 })).toBe("Send Ines the format")
    expect(chosenIn({ value, selectionStart: 2, selectionEnd: 11 })).toBe("Send Ines")
    expect(chosenIn({ value, selectionStart: 25, selectionEnd: 25 })).toBe("Ask Tomas")
  })
})

describe("reaching the views", () => {
  const company = CompanyId.parse("cmp_a")
  const project = { company, project: ProjectId.parse("prj_a") }
  function client() {
    const c = new QueryClient()
    const spy = vi.spyOn(c, "invalidateQueries")
    return { c, spy }
  }
  const reread = (spy: ReturnType<typeof client>["spy"]) =>
    spy.mock.calls.some(
      ([filter]) =>
        JSON.stringify(filter?.queryKey) ===
        JSON.stringify(queries.stageChecklist(project).queryKey),
    )

  it("puts a saved note in the list, in order, and reads the checklist again for a new one on a project", async () => {
    const { c, spy } = client()
    c.setQueryData(queries.notes(project).queryKey, [note("a", { held_on: "2026-10-01" })])
    await commitNote(c, project, note("b", { held_on: "2026-11-02" }), true)
    expect(c.getQueryData(queries.notes(project).queryKey)?.map((n) => n.id)).toEqual(["b", "a"])
    expect(reread(spy)).toBe(true)
  })

  it("does not read the checklist again for a change to a note, nor for a note on the company", async () => {
    const { c, spy } = client()
    c.setQueryData(queries.notes(project).queryKey, [note("a")])
    await commitNote(c, project, note("a", { title: "Changed" }), false)
    expect(c.getQueryData(queries.notes(project).queryKey)?.[0]?.title).toBe("Changed")
    expect(reread(spy)).toBe(false)

    c.setQueryData(queries.notes({ company }).queryKey, [])
    await commitNote(c, { company }, note("z"), true)
    expect(reread(spy)).toBe(false)
  })

  it("reads the list when nothing had been read yet, and the checklist again after a removal", async () => {
    const { c, spy } = client()
    await commitNote(c, project, note("a"), true)
    expect(
      spy.mock.calls.some(
        ([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(queries.notes(project).queryKey),
      ),
    ).toBe(true)
    c.setQueryData(queries.notes(project).queryKey, [note("a"), note("b")])
    spy.mockClear()
    await commitNoteRemoved(c, project, "a")
    expect(c.getQueryData(queries.notes(project).queryKey)?.map((n) => n.id)).toEqual(["b"])
    expect(reread(spy)).toBe(true)
  })
})
