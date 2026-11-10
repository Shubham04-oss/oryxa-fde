import { beforeEach, describe, expect, it } from "vitest"
import { ApiError, api } from "./client"
import { CompanyId, ProjectId } from "./schemas"
import type { MeetingNoteId } from "./schemas"
import { resetMockApi } from "@/dev/mock-api"
import type { NoteBody } from "@/lib/notes"
import { localDay } from "@/lib/time"

// The dev mock answers the meeting-note routes with the API's rules (crates/oryxa-fde-api/src/meetings.rs),
// so the screens are tried against what the API will say.

const company = CompanyId.parse("cmp_kestrel")
const place = { company, project: ProjectId.parse("prj_kestrel_claims") }
const good: NoteBody = {
  title: "Kickoff",
  held_on: "2026-11-02",
  body: "Words",
  stakeholders: ["stk_k1"],
  attendees: ["usr_riya"],
}

async function code(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ApiError)
  return (error as ApiError).code
}

describe("the mock's meeting notes", () => {
  beforeEach(() => resetMockApi())

  it("takes a note at a project and at a company, apart from each other", async () => {
    const here = await api.addNote(place, good)
    const there = await api.addNote(
      { company },
      { ...good, title: "At the company", held_on: localDay() },
    )
    expect((await api.notes(place)).map((n) => n.id)).toEqual([here.id])
    expect((await api.notes({ company })).map((n) => n.title)).toEqual([
      "At the company",
      "Quarterly review with Kestrel leadership",
    ])
    expect(there.created_by).toBe("usr_riya")
  })

  it("refuses each field the way the API does, with the API's code", async () => {
    const add = (patch: Partial<NoteBody>) => code(api.addNote(place, { ...good, ...patch }))
    expect(await add({ title: " " })).toBe("invalid_title")
    expect(await add({ title: "a\nb" })).toBe("invalid_title")
    expect(await add({ held_on: "02/11/2026" })).toBe("invalid_held_on")
    expect(await add({ body: "  " })).toBe("invalid_body")
    expect(await add({ body: "x".repeat(20_001) })).toBe("invalid_body")
    expect(await add({ body: "bell\u0007" })).toBe("invalid_body")
    expect(await add({ stakeholders: Array(51).fill("stk_k1") })).toBe("invalid_stakeholders")
    expect(await add({ attendees: Array(51).fill("usr_riya") })).toBe("invalid_attendees")
    // A stakeholder must be at the company; an attendee must work there.
    expect(await add({ stakeholders: ["stk_b1"] })).toBe("invalid_stakeholders")
    expect(await add({ attendees: ["usr_nobody"] })).toBe("invalid_attendees")
    expect(await api.notes(place)).toEqual([])
  })

  it("trims the words, keeps lines and tabs, and takes exactly 20,000 characters", async () => {
    const saved = await api.addNote(place, { ...good, body: "  one\n\ttwo \n" })
    expect(saved.body).toBe("one\n\ttwo")
    expect((await api.addNote(place, { ...good, body: "x".repeat(20_000) })).body).toHaveLength(
      20_000,
    )
  })

  it("replaces the whole note on a PUT, and refuses a note that is not there", async () => {
    const saved = await api.addNote(place, good)
    const changed = await api.updateNote(place, saved.id, {
      title: "Renamed",
      held_on: "2026-11-03",
      body: "New words",
      stakeholders: [],
      attendees: [],
    })
    expect(changed).toMatchObject({
      id: saved.id,
      title: "Renamed",
      stakeholders: [],
      attendees: [],
    })
    expect(changed.created_at).toBe(saved.created_at)
    expect(await code(api.updateNote(place, "mtg_nope" as MeetingNoteId, good))).toBe("not_found")
    expect(await code(api.removeNote(place, "mtg_nope" as MeetingNoteId))).toBe("not_found")
  })

  it("lists the latest meeting first", async () => {
    await api.addNote(place, { ...good, title: "Older", held_on: "2026-10-01" })
    await api.addNote(place, { ...good, title: "Newer", held_on: "2026-11-05" })
    expect((await api.notes(place)).map((n) => n.title)).toEqual(["Newer", "Older"])
  })

  it("meets the Discover item with a note on the project, not with one on the company", async () => {
    const item = async () =>
      (await api.stageChecklist(place)).items.find((i) => i.key === "discovery_notes")!.met
    expect(await item()).toBe(false)
    await api.addNote({ company }, good)
    expect(await item()).toBe(false)
    const saved = await api.addNote(place, good)
    expect(await item()).toBe(true)
    await api.removeNote(place, saved.id)
    expect(await item()).toBe(false)
  })
})
