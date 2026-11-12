import { describe, expect, it } from "vitest"
import { ApiError } from "./api/client"
import type { PersonOut } from "./api/schemas"
import { bookOf, byName, listOf, peopleProblem, personOf } from "./people"
import type { Directory } from "./people"

const people = (...list: Array<[string, string | null]>) =>
  list.map(([id, name]) => ({ id, name }) as PersonOut)

describe("who a user id is", () => {
  const book = bookOf(people(["usr_a", "Riya Kapoor"], ["usr_b", "Jonah Ade"], ["usr_c", null]))
  const listed: Directory = { book, state: "listed", me: "usr_a" }

  it("is You for the signed-in person, and their name for anyone else", () => {
    expect(personOf("usr_a", listed)).toMatchObject({ label: "You", phrase: "you", you: true })
    expect(personOf("usr_b", listed)).toMatchObject({
      label: "Jonah Ade",
      phrase: "Jonah Ade",
      nameless: false,
    })
  })

  it("says unnamed for someone with no name, and no longer listed for someone who has left", () => {
    expect(personOf("usr_c", listed)).toMatchObject({
      label: "Unnamed teammate",
      phrase: "an unnamed teammate",
      nameless: true,
    })
    expect(personOf("usr_gone", listed)).toMatchObject({
      label: "A teammate no longer listed",
      nameless: true,
    })
  })

  it("falls back to the end of the id when names are unavailable, or before it knows who you are", () => {
    const down: Directory = { book: new Map(), state: "unavailable", me: "usr_a" }
    expect(personOf("usr_jonah", down)).toMatchObject({
      label: "A teammate …_jonah",
      phrase: "a teammate …_jonah",
      nameless: true,
    })
    expect(personOf("usr_a", down).label).toBe("You")
    // Listed, but who you are is not known yet: the one not listed may be you.
    expect(personOf("usr_gone", { book, state: "listed" }).label).toBe("A teammate …r_gone")
  })

  it("never shows a name as markup, and keeps a long one whole for the screen to cut", () => {
    const long = "Aurelia ".repeat(40).trim()
    const odd = bookOf(people(["usr_x", "<b>Mallory</b>"], ["usr_y", long]))
    const dir: Directory = { book: odd, state: "listed", me: "usr_a" }
    expect(personOf("usr_x", dir).label).toBe("<b>Mallory</b>")
    expect(personOf("usr_y", dir).label).toBe(long)
  })
})

describe("the names the page has", () => {
  it("takes names from members and assignees, and /v1/people wins", () => {
    const book = bookOf(people(["usr_a", "Riya K."]), [
      { user: "usr_a", name: "Riya Kapoor" },
      { user: "usr_b", name: "Jonah Ade" },
    ])
    expect(book.get("usr_a")).toBe("Riya K.")
    expect(book.get("usr_b")).toBe("Jonah Ade")
  })

  it("lets only /v1/people say someone has no name: a member without one may mean WorkOS did not answer", () => {
    const book = bookOf(undefined, [{ user: "usr_b", name: null }, { user: "usr_c" }])
    expect(book.has("usr_b")).toBe(false)
    expect(book.has("usr_c")).toBe(false)
    // A blank name is no name; a member's name fills in where the list has none.
    const listed = bookOf(people(["usr_b", "  "], ["usr_d", null]), [
      { user: "usr_d", name: "Sam Okafor" },
    ])
    expect(listed.get("usr_b")).toBeNull()
    expect(listed.get("usr_d")).toBe("Sam Okafor")
  })

  it("tells a refusal from an outage", () => {
    expect(peopleProblem(new ApiError(403, "forbidden"))).toBe("forbidden")
    expect(peopleProblem(new ApiError(503, "unavailable"))).toBe("unavailable")
    expect(peopleProblem(new TypeError("offline"))).toBe("unavailable")
  })
})

describe("people in a list", () => {
  it("joins names, and counts the rest past three", () => {
    expect(listOf([])).toBe("")
    expect(listOf(["You"])).toBe("You")
    expect(listOf(["You", "Jonah Ade"])).toBe("You and Jonah Ade")
    expect(listOf(["You", "Jonah Ade", "Sam Okafor"])).toBe("You, Jonah Ade and Sam Okafor")
    expect(listOf(["You", "Jonah Ade", "Sam Okafor", "Tomoko Hale"])).toBe(
      "You, Jonah Ade and 2 others",
    )
  })

  it("puts you first, then names in order, the nameless last", () => {
    const book = bookOf(people(["usr_b", "sam"], ["usr_c", "Aurelia"], ["usr_d", null]))
    const dir: Directory = { book, state: "listed", me: "usr_a" }
    const ids = ["usr_d", "usr_b", "usr_a", "usr_c"].map((id) => personOf(id, dir))
    expect(byName(ids).map((p) => p.label)).toEqual(["You", "Aurelia", "sam", "Unnamed teammate"])
  })
})
