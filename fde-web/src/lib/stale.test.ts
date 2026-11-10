import { describe, expect, it } from "vitest"
import { differing, listOf, staleness } from "./stale"
import type { Labels } from "./stale"

type F = { title: string; status: string; due: string | null; owner: string | null }
const labels: Labels<F> = { title: "title", status: "status", due: "due date", owner: "owner" }
const was: F = { title: "Write it", status: "todo", due: null, owner: "a" }

describe("which fields differ", () => {
  it("names them in the order the labels list them, and trims what a form trims", () => {
    expect(differing(was, { ...was, status: "done", title: "Write it " }, labels)).toEqual([
      "status",
    ])
    expect(differing(was, { ...was, owner: null, due: "2030-01-01" }, labels)).toEqual([
      "due",
      "owner",
    ])
    expect(differing(was, was, labels)).toEqual([])
  })
})

describe("what a stale save makes of the form", () => {
  it("takes what the person changed from the form and everything else from the current record", () => {
    const form = { ...was, title: "Write it well" }
    const current = { ...was, status: "in_progress", owner: "b" }
    expect(staleness(was, form, current, labels)).toEqual({
      differs: ["status", "owner"],
      both: [],
      merged: { title: "Write it well", status: "in_progress", due: null, owner: "b" },
    })
  })

  it("says which of the fields someone else changed the person changed too, and keeps theirs on top", () => {
    const form = { ...was, status: "done", due: "2030-01-01" }
    const current = { ...was, status: "in_progress" }
    expect(staleness(was, form, current, labels)).toEqual({
      differs: ["status"],
      both: ["status"],
      merged: { ...was, status: "done", due: "2030-01-01" },
    })
  })

  it("has nothing to name when only something the form does not hold changed", () => {
    expect(staleness(was, was, was, labels)).toEqual({ differs: [], both: [], merged: was })
  })
})

describe("a list of names", () => {
  it("reads as a sentence", () => {
    expect(listOf([])).toBe("")
    expect(listOf(["status"])).toBe("status")
    expect(listOf(["status", "due date"])).toBe("status and due date")
    expect(listOf(["title", "status", "due date"])).toBe("title, status and due date")
  })
})
