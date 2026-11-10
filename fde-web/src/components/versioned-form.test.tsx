import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useVersionedForm } from "./versioned-form"
import { StaleSaveError } from "@/lib/api/client"
import { isHeld } from "@/lib/records"

// The form's side of a stale save (DESIGN.md §3, A stale save): what was typed survives the refusal,
// including what was typed while the save was on its way.

type Note = { version: number; title: string; body: string }
const fieldsOf = (n: Note) => ({ title: n.title, body: n.body })
const LABELS = { title: "title", body: "body" }

function form(send: () => Promise<unknown>) {
  const opened: Note = { version: 1, title: "Old", body: "Words" }
  return renderHook(() =>
    useVersionedForm({
      record: opened,
      snapshot: fieldsOf,
      initial: fieldsOf(opened),
      labels: LABELS,
      send,
      adopt: async () => {},
      what: "note",
    }),
  )
}

describe("a stale save of a form", () => {
  it("keeps what was typed while the save was on its way, on top of the current record", async () => {
    let refuse = (_: unknown) => {}
    const { result } = form(() => new Promise((_, reject) => (refuse = reject)))
    act(() => result.current.set({ title: "New" }))
    let answer: ReturnType<typeof result.current.submit> | undefined
    act(() => {
      answer = result.current.submit()
    })
    // The person goes on typing before the API answers.
    act(() => result.current.set({ title: "New title" }))
    await act(async () => {
      refuse(new StaleSaveError<Note>({ version: 2, title: "Old", body: "Their words" }))
      expect(isHeld(await answer!)).toBe(true)
    })
    expect(result.current.fields).toEqual({ title: "New title", body: "Their words" })
    expect(result.current.stale).toMatchObject({ differs: ["body"], both: [], round: 1 })
  })

  it("counts each refusal, so a second notice is a new one", async () => {
    let current: Note = { version: 2, title: "Old", body: "Their words" }
    const { result } = form(() => Promise.reject(new StaleSaveError<Note>(current)))
    await act(async () => void (await result.current.submit()))
    current = { ...current, version: 3, body: "Their words again" }
    await act(async () => void (await result.current.submit()))
    expect(result.current.stale).toMatchObject({ differs: ["body"], round: 2 })
    expect(result.current.fields.body).toBe("Their words again")
  })
})
