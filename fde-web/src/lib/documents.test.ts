import { describe, expect, it } from "vitest"
import {
  MAX_DOCUMENT_BYTES,
  contentTypeOf,
  excerpt,
  failureWords,
  formatBytes,
  nameFromFile,
  notSearchable,
  pieces,
  pollDelay,
  queryProblem,
  searchTerms,
  statusOf,
  uploadProblem,
  whereIn,
} from "./documents"

const file = (name: string, type: string, size = 10) =>
  new File([new Uint8Array(size)], name, { type })

describe("which files the API reads", () => {
  it("takes the browser's type, and falls back to the extension when it has none", () => {
    expect(contentTypeOf({ name: "a.pdf", type: "application/pdf" })).toBe("application/pdf")
    expect(contentTypeOf({ name: "notes.md", type: "" })).toBe("text/markdown")
    expect(contentTypeOf({ name: "Notes.MD", type: "application/octet-stream" })).toBe(
      "text/markdown",
    )
    expect(contentTypeOf({ name: "plan.docx", type: "" })).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    expect(contentTypeOf({ name: "a.txt", type: "text/plain;charset=utf-8" })).toBe("text/plain")
  })

  it("refuses what it does not read", () => {
    for (const [name, type] of [
      ["photo.png", "image/png"],
      ["sheet.xlsx", ""],
      ["old.doc", "application/msword"],
      ["page.html", "text/html"],
      ["archive.pdf.zip", "application/zip"],
      ["noextension", ""],
    ] as const)
      expect(contentTypeOf({ name, type }), name).toBeNull()
  })
})

describe("uploadProblem", () => {
  const ok = file("a.pdf", "application/pdf")

  it("is quiet for a good file and name", () => {
    expect(uploadProblem({ file: ok, name: "Runbook" })).toBeNull()
    expect(uploadProblem({ file: file("a.md", ""), name: "Runbook" })).toBeNull()
  })

  it("asks for a file first, then says what is wrong with it, in the API's terms", () => {
    expect(uploadProblem({ file: null, name: "x" })).toEqual({
      field: "file",
      message: "Choose a file to upload.",
    })
    expect(uploadProblem({ file: file("a.pdf", "application/pdf", 0), name: "x" })).toEqual({
      field: "file",
      message: "That file is empty.",
    })
    expect(
      uploadProblem({ file: file("a.pdf", "application/pdf", MAX_DOCUMENT_BYTES + 1), name: "x" }),
    ).toEqual({ field: "file", message: "That file is over the 20 MB limit." })
    // Exactly the limit is allowed.
    expect(
      uploadProblem({ file: file("a.pdf", "application/pdf", MAX_DOCUMENT_BYTES), name: "x" }),
    ).toBeNull()
    expect(uploadProblem({ file: file("a.png", "image/png"), name: "x" })).toEqual({
      field: "file",
      message: "Only text, Markdown, PDF and Word (.docx) files are accepted. This one is not.",
    })
  })

  it("checks the name as the API does: one line, 1 to 200 characters", () => {
    expect(uploadProblem({ file: ok, name: "   " })).toEqual({
      field: "name",
      message: "Give the document a name.",
    })
    expect(uploadProblem({ file: ok, name: "x".repeat(201) })).toMatchObject({ field: "name" })
    expect(uploadProblem({ file: ok, name: "x".repeat(200) })).toBeNull()
    expect(uploadProblem({ file: ok, name: "two\nlines" })).toMatchObject({ field: "name" })
  })
})

describe("names and sizes", () => {
  it("starts the name from the file's, on one line and within the limit", () => {
    expect(nameFromFile("  Depot rules.md ")).toBe("Depot rules.md")
    expect(nameFromFile("a\nb\tc")).toBe("a b c")
    expect([...nameFromFile("é".repeat(300))]).toHaveLength(200)
  })

  it("writes sizes the way a computer's own file view does", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(900)).toBe("900 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(12_300)).toBe("12 KB")
    expect(formatBytes(4.2 * 1024 * 1024)).toBe("4.2 MB")
    expect(formatBytes(MAX_DOCUMENT_BYTES)).toBe("20 MB")
  })
})

describe("status", () => {
  it("calls a document Ready only when the API says it is ingested", () => {
    expect(statusOf({ status: "ingested" })).toEqual({ tone: "success", label: "Ready" })
    expect(statusOf({ status: "pending" })).toEqual({ tone: "neutral", label: "Being read" })
    expect(statusOf({ status: "failed" })).toEqual({
      tone: "attention",
      label: "Could not be read",
    })
  })

  it("says why in words for each code the API gives, and plainly for one it does not know", () => {
    for (const code of ["unreadable", "empty", "too_large", "too_slow", "checksum"])
      expect(failureWords(code), code).not.toBe("It could not be read.")
    expect(failureWords("blob_key")).toBe("It could not be read.")
    expect(failureWords(null)).toBe("It could not be read.")
    // A code is never put on the page as it is.
    expect(failureWords("<b>x</b>")).toBe("It could not be read.")
  })

  it("polls quickly, then less often, then stops", () => {
    expect(pollDelay(0)).toBe(2_000)
    expect(pollDelay(19_999)).toBe(2_000)
    expect(pollDelay(20_000)).toBe(5_000)
    expect(pollDelay(60_000)).toBe(15_000)
    expect(pollDelay(5 * 60_000)).toBe(30_000)
    expect(pollDelay(15 * 60_000)).toBe(false)
  })

  it("says what a search cannot see yet, and nothing when all are ready", () => {
    expect(notSearchable([])).toBeNull()
    expect(notSearchable([{ status: "ingested" }])).toBeNull()
    expect(notSearchable([{ status: "pending" }, { status: "ingested" }])).toBe(
      "1 document is still being read and cannot be searched yet.",
    )
    expect(
      notSearchable([{ status: "pending" }, { status: "pending" }, { status: "failed" }]),
    ).toBe(
      "2 documents are still being read and cannot be searched yet. 1 document could not be read and cannot be searched.",
    )
  })
})

describe("search", () => {
  it("takes what the API takes: 1 to 500 characters, no control characters", () => {
    expect(queryProblem("drivers")).toBeNull()
    expect(queryProblem("x".repeat(500))).toBeNull()
    expect(queryProblem("x".repeat(501))).not.toBeNull()
    expect(queryProblem("a\u0007b")).not.toBeNull()
    // Rust's `char::is_control` also covers the C1 range, so the API refuses these too.
    expect(queryProblem("a\u0085b")).not.toBeNull()
    expect(queryProblem("a\u009fb")).not.toBeNull()
  })

  it("finds the words and phrases typed, without exclusions and the operator or", () => {
    expect(searchTerms('Drivers "rest hours" -overtime or lunch,')).toEqual([
      "rest hours",
      "drivers",
      "lunch",
    ])
    expect(searchTerms("a -b  ")).toEqual([])
    expect(searchTerms("   ")).toEqual([])
    expect(searchTerms("drivers DRIVERS")).toEqual(["drivers"])
    expect(searchTerms(Array.from({ length: 30 }, (_, i) => `word${i}`).join(" "))).toHaveLength(10)
  })

  it("marks what was typed in a passage, as text pieces, whatever the passage or the words hold", () => {
    // Every occurrence, in any case, inside a longer word too, as a stem would be.
    expect(pieces("Drivers may drive for nine hours.", ["drive"])).toEqual([
      { text: "Drive", mark: true },
      { text: "rs may ", mark: false },
      { text: "drive", mark: true },
      { text: " for nine hours.", mark: false },
    ])
    expect(pieces("nothing here", ["zzz"])).toEqual([{ text: "nothing here", mark: false }])
    expect(pieces("anything", [])).toEqual([{ text: "anything", mark: false }])
    // Markup in a passage stays characters; the pieces only ever hold text.
    const hostile = '<img src=x onerror="alert(1)"> and <b>bold</b>'
    const cut = pieces(hostile, ["and"])
    expect(cut.map((p) => p.text).join("")).toBe(hostile)
    // A term full of regular-expression characters is matched as the characters it is.
    expect(
      pieces("cost (a+b)* [x] $5 | \\n", ["(a+b)*", "[x]", "$5", "|", "\\n"]).filter((p) => p.mark),
    ).toHaveLength(5)
    // Letters from other scripts, and a case that changes length, do not shift the marks.
    expect(pieces("İstanbul ışık STRASSE", ["strasse"]).find((p) => p.mark)?.text).toBe("STRASSE")
  })

  it("shows all of a short passage, and a window around the first match in a long one", () => {
    expect(excerpt("short passage", ["short"])).toEqual({
      text: "short passage",
      before: false,
      after: false,
    })
    const long = `${"alpha beta gamma ".repeat(40)}NEEDLE ${"delta epsilon zeta ".repeat(40)}`
    const shown = excerpt(long, ["needle"])
    expect(shown.text).toContain("NEEDLE")
    expect(shown.before).toBe(true)
    expect(shown.after).toBe(true)
    expect(shown.text.length).toBeLessThanOrEqual(320)
    // Cut at spaces: no word is split.
    for (const word of shown.text.split(" ")) expect(long.includes(` ${word} `), word).toBe(true)
    // No match (a hit found by meaning): the start.
    const start = excerpt(long, ["nothing"])
    expect(start.before).toBe(false)
    expect(start.after).toBe(true)
    expect(long.startsWith(start.text)).toBe(true)
  })

  it("says where in a document a passage is", () => {
    expect(whereIn(0, { chunks: 12 })).toBe("Passage 1 of 12")
    expect(whereIn(11, { chunks: 12 })).toBe("Passage 12 of 12")
    // The list has not caught up with the search (or the document is not in it).
    expect(whereIn(3, undefined)).toBe("Passage 4")
    expect(whereIn(12, { chunks: 12 })).toBe("Passage 13")
  })
})
