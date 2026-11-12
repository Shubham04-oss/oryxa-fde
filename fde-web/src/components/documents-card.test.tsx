import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { CompanyPage } from "./company-page"
import { DocumentsCard } from "./documents-card"
import { mockApi } from "@/dev/mock-api"
import { CompanyId } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

beforeAll(installWire)
afterEach(() => {
  resetWire()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).__fdeMockIngestMs
  delete (globalThis as Record<string, unknown>).__fdeMockFailWrites
  delete (globalThis as Record<string, unknown>).__fdeMockPeople
})

const KESTREL = CompanyId.parse("cmp_kestrel")
const ATLAS = CompanyId.parse("cmp_atlas")

const card = () => screen.findByRole("region", { name: "Documents" })
const uploadDialog = () => screen.findByRole("dialog", { name: "Upload a document" })
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
const rowOf = async (name: string) => {
  const rows = await within(await card()).findAllByRole("listitem")
  const row = rows.find((r) => r.textContent.includes(name))
  if (!row) throw new Error(`no row for ${name}`)
  return row
}
const refuseWith = (status: number, error: string) =>
  (wire.refuse = Response.json({ error }, { status }))
const pdf = (name = "Runbook.pdf", size = 2048) =>
  new File([new Uint8Array(size)], name, { type: "application/pdf" })

/** The file the form has chosen, as the chooser holds it. */
const chosen = (box: HTMLElement) => within(box).getByLabelText<HTMLInputElement>("File").files?.[0]

async function openUpload() {
  await userEvent.click(await screen.findByRole("button", { name: "Upload a document" }))
  return uploadDialog()
}
async function choose(box: HTMLElement, file: File) {
  await userEvent.upload(within(box).getByLabelText("File"), file)
}
const send = (box: HTMLElement) =>
  userEvent.click(within(box).getByRole("button", { name: "Upload" }))
/** How many times the page has asked for the list of documents. */
const listReads = () => wire.reads.filter((path) => path.endsWith("/documents")).length

describe("the documents list", () => {
  it("lists a company's documents, newest first, each with its status in words", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    const rows = await within(await card()).findAllByRole("listitem")
    expect(rows.map((r) => r.querySelector("span")?.textContent)).toEqual([
      "Kickoff call transcript.txt",
      "Scanned site survey, Leeds depot.pdf",
      "Security questionnaire.docx",
      "Driver hours policy.pdf",
      "Depot rules.md",
    ])
    // Being read, failed, ready: only the last is searchable, and the words say so.
    expect(rows[0]).toHaveTextContent("Being read")
    expect(rows[0]).toHaveTextContent("It can be searched once it has been read.")
    expect(rows[1]).toHaveTextContent("Could not be read")
    expect(rows[2]).toHaveTextContent("Ready")
    expect(rows[2]).toHaveTextContent("Word · 94 KB · 3 passages")
    // You are "you"; anyone else is named.
    await waitFor(() => expect(rows[2]).toHaveTextContent("by you"))
    await waitFor(() => expect(rows[0]).toHaveTextContent("by Jonah Ade"))
    // Nothing is called ready that the API has not ingested, and a pending one has no passage count.
    expect(rows[0]).not.toHaveTextContent("passage")
    expect(rows[0]).not.toHaveTextContent("Ready")
  })

  it("keeps who added it together on a phone when names are unavailable", async () => {
    ;(globalThis as Record<string, unknown>).__fdeMockPeople = "unavailable"
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    const rows = await within(await card()).findAllByRole("listitem")
    // "by a teammate …" and the end of the id stay on one line: only the space after "by" may break.
    await waitFor(() => expect(rows[0]!.textContent).toMatch(/by a\u00a0teammate\u00a0…\S+/))
    // A person's own name still wraps between words.
    expect(rows[2]!.textContent).toContain("by you")
  })

  it("says why a document could not be read, and that it cannot be read again from here", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    const failed = await rowOf("Scanned site survey")
    expect(failed).toHaveTextContent("There was no text in it to search")
    expect(await within(await card()).findByText(/cannot be removed or read again/)).toBeVisible()
    // No delete and no re-read are offered: the API has neither.
    expect(
      within(await card()).queryByRole("button", { name: /delete|remove|retry|read again/i }),
    ).toBeNull()
  })

  it("says what to add when there is nothing, without claiming a search can find anything", async () => {
    renderWithRouter(<DocumentsCard company={ATLAS} />)
    expect(await within(await card()).findByText(/No documents yet/)).toBeVisible()
    expect(within(await card()).queryByRole("list")).toBeNull()
  })

  it("keeps a failed read to the card, with Try again", async () => {
    wire.refuseReads = {
      ending: "/documents",
      response: Response.json({ error: "unavailable" }, { status: 400 }),
    }
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    expect(await within(await card()).findByRole("alert")).toHaveTextContent(
      "We couldn't read the documents.",
    )
    wire.refuseReads = null
    await userEvent.click(within(await card()).getByRole("button", { name: "Try again" }))
    expect(await rowOf("Depot rules.md")).toBeInTheDocument()
  })

  it("says so when the API will not show the company's documents", async () => {
    wire.refuseReads = {
      ending: "/documents",
      response: Response.json({ error: "forbidden" }, { status: 403 }),
    }
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    expect(await within(await card()).findByRole("alert")).toHaveTextContent(
      "You are not allowed to do that here.",
    )
  })

  it("is a card on the company page, between its projects and its notes", async () => {
    renderWithRouter(<CompanyPage companyId={KESTREL} />)
    const headings = (await screen.findAllByRole("heading", { level: 2 })).map((h) => h.textContent)
    expect(headings.indexOf("Documents")).toBe(headings.indexOf("Projects") + 1)
    expect(headings.indexOf("Notes")).toBe(headings.indexOf("Documents") + 1)
  })

  it("shows a name that is markup as the characters it is, and nothing runs", async () => {
    const hostile = `<img src=x onerror="document.title='owned'"><script>document.title='owned'</script>.txt`
    renderWithRouter(<DocumentsCard company={ATLAS} />)
    const box = await openUpload()
    await choose(box, new File(["hello"], "a.txt", { type: "text/plain" }))
    const name = within(box).getByLabelText("Name")
    await userEvent.clear(name)
    await userEvent.click(name)
    await userEvent.paste(hostile)
    await send(box)
    await closed()
    const row = await rowOf("onerror")
    expect(row).toHaveTextContent(hostile)
    expect(row.querySelector("img, script")).toBeNull()
    expect(document.querySelector("img[src='x'], script:not([src])")).toBeNull()
    expect(document.title).not.toBe("owned")
  })
})

describe("uploading", () => {
  it("opens with the one quiet line about sample data and the limits, and nothing chosen", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    const box = await openUpload()
    expect(box).toHaveTextContent("Sample data only for now.")
    expect(box).toHaveTextContent("Text, Markdown, PDF and Word (.docx) files, up to 20 MB.")
    expect(within(box).getByLabelText("Name")).toHaveValue("")
  })

  it("sends the file as it is, through the app's own origin, and shows it only once the API has it", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    const list = await card()
    const box = await openUpload()
    await choose(box, pdf("Rota & rest rules #2.pdf"))
    // The name starts from the file's, and can be changed.
    expect(within(box).getByLabelText("Name")).toHaveValue("Rota & rest rules #2.pdf")

    let release: () => void = () => {}
    wire.hold = new Promise((resolve) => (release = resolve))
    await send(box)
    // On its way: progress is shown, the dialog is still open, and the list does not have it yet.
    expect(await within(box).findByRole("progressbar", { name: "Upload progress" })).toBeVisible()
    expect(within(box).getByRole("button", { name: "Saving…" })).toBeDisabled()
    expect(within(list).queryByText("Rota & rest rules #2.pdf")).toBeNull()

    release()
    await closed()
    expect(wire.sent).toEqual([
      {
        method: "POST",
        path: "/companies/cmp_kestrel/documents",
        body: {
          name: "Rota & rest rules #2.pdf",
          contentType: "application/pdf",
          csrf: "1",
          size: 2048,
        },
      },
    ])
    const row = await rowOf("Rota & rest rules #2.pdf")
    expect(row).toHaveTextContent("Being read")
    expect(row).toHaveTextContent("PDF · 2.0 KB")
    // The newest is first, the announcement says what happens next, and focus is back on Upload.
    expect(within(list).getAllByRole("listitem")[0]).toBe(row)
    expect(await within(list).findByRole("status")).toHaveTextContent(
      "Uploaded “Rota & rest rules #2.pdf”. It can be searched once it has been read.",
    )
    expect(screen.getByRole("button", { name: "Upload a document" })).toHaveFocus()
  })

  it("reports how far the bytes have gone, then that it is waiting for the API", async () => {
    const real = mockApi.upload
    let half: () => void = () => {}
    let all: () => void = () => {}
    const reachedHalf = new Promise<void>((resolve) => (half = resolve))
    const reachedAll = new Promise<void>((resolve) => (all = resolve))
    mockApi.upload = async (request) => {
      request.onProgress(512, 2048)
      await reachedHalf
      request.onProgress(2048, 2048)
      await reachedAll
      return real(request)
    }
    try {
      renderWithRouter(<DocumentsCard company={KESTREL} />)
      const box = await openUpload()
      await choose(box, pdf())
      await send(box)
      const bar = await within(box).findByRole("progressbar")
      await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "25"))
      expect(box).toHaveTextContent("Sending 512 B of 2.0 KB")
      act(() => half())
      await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "100"))
      expect(box).toHaveTextContent("Sent. Waiting for the workspace to store it…")
      act(() => all())
      await closed()
    } finally {
      mockApi.upload = real
    }
  })

  it("refuses a file that is too big, empty or of a kind the API does not take, before sending", async () => {
    const user = userEvent.setup({ applyAccept: false })
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    const box = await openUpload()

    await user.click(within(box).getByRole("button", { name: "Upload" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("Choose a file to upload.")
    await waitFor(() => expect(within(box).getByLabelText("File")).toHaveFocus())

    await user.upload(
      within(box).getByLabelText("File"),
      new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" }),
    )
    await user.click(within(box).getByRole("button", { name: "Upload" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "That file is over the 20 MB limit.",
    )

    await user.upload(
      within(box).getByLabelText("File"),
      new File([""], "blank.txt", { type: "text/plain" }),
    )
    await user.click(within(box).getByRole("button", { name: "Upload" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("That file is empty.")

    await user.upload(
      within(box).getByLabelText("File"),
      new File(["x"], "photo.png", { type: "image/png" }),
    )
    await user.click(within(box).getByRole("button", { name: "Upload" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "Only text, Markdown, PDF and Word (.docx) files are accepted.",
    )
    expect(within(box).getByLabelText("File")).toHaveAttribute("aria-invalid", "true")
    expect(wire.sent).toEqual([])
  })

  it("takes the name from the person once they have typed one, and checks it", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    const box = await openUpload()
    await choose(box, pdf("first.pdf"))
    const name = within(box).getByLabelText("Name")
    await userEvent.clear(name)
    await userEvent.type(name, "Mine")
    await choose(box, pdf("second.pdf"))
    expect(name).toHaveValue("Mine")
    await userEvent.clear(name)
    await userEvent.click(within(box).getByRole("button", { name: "Upload" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("Give the document a name.")
    await waitFor(() => expect(name).toHaveFocus())
    expect(name).toHaveAttribute("aria-invalid", "true")
  })

  it.each([
    [413, null, "That file is over the 20 MB limit.", "File"],
    [415, "unsupported_media_type", "Only text, Markdown, PDF and Word (.docx) files", "File"],
    [400, "invalid_body", "That file is empty.", "File"],
    [400, "invalid_name", "A name is one line, 1 to 200 characters.", "Name"],
    [403, "forbidden", "You are not allowed to do that here.", null],
    [503, "unavailable", "The workspace is briefly unavailable.", null],
  ] as const)(
    "shows the API's refusal (%i %s) with its reason, and keeps the file chosen to send again",
    async (status, code, words, field) => {
      renderWithRouter(<DocumentsCard company={KESTREL} />)
      const list = await card()
      const box = await openUpload()
      const file = pdf("keep.pdf")
      await choose(box, file)
      wire.refuse = code ? Response.json({ error: code }, { status }) : new Response("", { status })
      await send(box)

      expect(await within(box).findByRole("alert")).toHaveTextContent(words)
      // The dialog stays, with the file and the name as they were, and the field it is about is marked.
      expect(box).toBeInTheDocument()
      expect(chosen(box)).toBe(file)
      expect(within(box).getByLabelText("Name")).toHaveValue("keep.pdf")
      if (field) expect(within(box).getByLabelText(field)).toHaveAttribute("aria-invalid", "true")
      expect(within(list).queryByText("keep.pdf")).toBeNull()

      // Sent again, it goes.
      wire.refuse = null
      await send(box)
      await closed()
      expect(await rowOf("keep.pdf")).toBeInTheDocument()
    },
  )

  it("keeps the file chosen when the connection fails, and says so", async () => {
    const real = mockApi.upload
    mockApi.upload = () => Promise.reject(new TypeError("The upload could not be sent."))
    try {
      renderWithRouter(<DocumentsCard company={KESTREL} />)
      const box = await openUpload()
      const file = pdf("offline.pdf")
      await choose(box, file)
      await send(box)
      expect(await within(box).findByRole("alert")).toHaveTextContent(
        "The upload did not finish. Check your connection and try again. The file is still chosen.",
      )
      expect(chosen(box)).toBe(file)
      // The progress that was shown is gone, and Upload is ready again.
      expect(within(box).queryByRole("progressbar")).toBeNull()
      expect(within(box).getByRole("button", { name: "Upload" })).toBeEnabled()
    } finally {
      mockApi.upload = real
    }
  })

  it("tells a person whose session has ended, and keeps the dialog", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    const box = await openUpload()
    await choose(box, pdf())
    refuseWith(401, "unauthorized")
    await send(box)
    expect(await within(box).findByRole("alert")).toHaveTextContent("Your session has ended.")
  })

  it("stops an upload that is cancelled, and reads the list again in case the API has it", async () => {
    let signal: AbortSignal | undefined
    const real = mockApi.upload
    mockApi.upload = (request) => {
      signal = request.signal
      return new Promise<Response>(() => {})
    }
    try {
      renderWithRouter(<DocumentsCard company={KESTREL} />)
      const box = await openUpload()
      await choose(box, pdf())
      await send(box)
      await within(box).findByRole("progressbar")
      const before = listReads()
      await userEvent.click(within(box).getByRole("button", { name: "Cancel" }))
      await closed()
      expect(signal?.aborted).toBe(true)
      await waitFor(() => expect(listReads()).toBeGreaterThan(before))
    } finally {
      mockApi.upload = real
    }
  })
})

describe("while a document is being read", () => {
  it("reads the list again, says when it is ready, and stops asking once everything has settled", async () => {
    ;(globalThis as Record<string, unknown>).__fdeMockIngestMs = 1_000
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithRouter(<DocumentsCard company={ATLAS} />)
    const box = await openUpload()
    await choose(
      box,
      new File(["Drivers rest for nine hours."], "rules.txt", { type: "text/plain" }),
    )
    await send(box)
    await closed()
    expect(await rowOf("rules.txt")).toHaveTextContent("Being read")

    // The first look comes within a couple of seconds, finds it ingested and says so.
    await act(() => vi.advanceTimersByTimeAsync(3_000))
    await waitFor(async () => expect(await rowOf("rules.txt")).toHaveTextContent("Ready"))
    expect(await rowOf("rules.txt")).toHaveTextContent("1 passage")
    expect(within(await card()).getByRole("status")).toHaveTextContent(
      "“rules.txt” is ready to search.",
    )

    // Settled: no more asking, however long the page stays open.
    const settled = listReads()
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000))
    expect(listReads()).toBe(settled)
  })

  it("slows down, and stops for good when a document stays unread, offering Check again", async () => {
    // Still pending a day later: the reader is behind or stuck.
    ;(globalThis as Record<string, unknown>).__fdeMockIngestMs = 24 * 60 * 60_000
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithRouter(<DocumentsCard company={ATLAS} />)
    const box = await openUpload()
    await choose(box, pdf("slow.pdf"))
    await send(box)
    await closed()
    await rowOf("slow.pdf")

    // Minutes watched so far: 0.5, 2.5, 8.5, 22.5 (it gives up at 15), 42.5.
    const counts: Array<number> = []
    for (const minutes of [0.5, 2, 6, 14, 20]) {
      await act(() => vi.advanceTimersByTimeAsync(minutes * 60_000))
      counts.push(listReads())
    }
    // Quick at first, then gentle: a read every 2 seconds all that time would be over 1,200.
    expect(counts[0]).toBeLessThanOrEqual(16)
    expect(counts[3]).toBeLessThan(70)
    // And none once it has given up.
    expect(counts[4]).toBe(counts[3])
    const stopped = listReads()
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000))
    expect(listReads()).toBe(stopped)

    expect(await within(await card()).findByText(/taking longer than usual/)).toBeVisible()
    await userEvent.click(within(await card()).getByRole("button", { name: "Check again" }))
    await waitFor(() => expect(listReads()).toBeGreaterThan(stopped))
  })

  it("does not ask while the page is hidden, and reads again when it is shown", async () => {
    ;(globalThis as Record<string, unknown>).__fdeMockIngestMs = 24 * 60 * 60_000
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    await rowOf("Kickoff call transcript.txt")
    const visibility = vi.spyOn(document, "visibilityState", "get")

    visibility.mockReturnValue("hidden")
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }))
    const hidden = listReads()
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(listReads()).toBe(hidden)

    visibility.mockReturnValue("visible")
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }))
    await waitFor(() => expect(listReads()).toBeGreaterThan(hidden))
  })

  it("stops asking when the page is left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { unmount } = renderWithRouter(<DocumentsCard company={KESTREL} />)
    await rowOf("Kickoff call transcript.txt")
    unmount()
    const left = listReads()
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(listReads()).toBe(left)
  })

  it("shows a document that fails to be read as failed, with the reason the API gives", async () => {
    ;(globalThis as Record<string, unknown>).__fdeMockIngestMs = 500
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithRouter(<DocumentsCard company={ATLAS} />)
    const box = await openUpload()
    await choose(box, pdf("unreadable scan.pdf"))
    await send(box)
    await closed()
    expect(await rowOf("unreadable scan.pdf")).toHaveTextContent("Being read")

    await act(() => vi.advanceTimersByTimeAsync(3_000))
    await waitFor(async () =>
      expect(await rowOf("unreadable scan.pdf")).toHaveTextContent("Could not be read"),
    )
    expect(await rowOf("unreadable scan.pdf")).toHaveTextContent("No text could be read from it.")
    expect(within(await card()).getByRole("status")).toHaveTextContent(
      "“unreadable scan.pdf” could not be read.",
    )
  })
})

describe("search", () => {
  const field = async () =>
    within(await card()).findByRole("searchbox", { name: "Search the documents" })

  it("finds passages as the words are typed, with the document, where in it, and the words marked", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    await userEvent.type(await field(), "driver hours")
    const results = await within(await card()).findByRole("list", { name: "Search results" })
    const first = within(results).getAllByRole("listitem")[0]!
    expect(first).toHaveTextContent("Driver hours policy.pdf")
    expect(first).toHaveTextContent("PDF · Passage")
    expect(first).toHaveTextContent(/of 3/)
    const marks = [...first.querySelectorAll("mark")].map((m) => m.textContent.toLowerCase())
    expect(marks).toContain("driver")
    expect(marks).toContain("hours")
    // The list of documents gives way to the results, and comes back when the field is cleared.
    expect(within(await card()).queryByRole("list", { name: "Documents" })).toBeNull()
    await userEvent.clear(await field())
    expect(await within(await card()).findByRole("list", { name: "Documents" })).toBeVisible()
  })

  it("says how many passages it found, and for what", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    await userEvent.type(await field(), "overtime")
    expect(await within(await card()).findByText(/1 passage for “overtime”/)).toBeVisible()
  })

  it("searches at once on Enter, even for one character, and waits for two on its own", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    await userEvent.type(await field(), "d")
    expect(await within(await card()).findByText(/Keep typing, or press Enter/)).toBeVisible()
    await userEvent.type(await field(), "{Enter}")
    expect(await within(await card()).findByText(/for “d”/)).toBeVisible()
  })

  it("keeps a one-character search sent with Enter once the typing pause has passed", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    await userEvent.type(await field(), "d{Enter}")
    expect(await within(await card()).findByText(/for “d”/)).toBeVisible()
    // The pause that began with the typing must not set the search back to nothing.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(within(await card()).getByText(/for “d”/)).toBeVisible()
  })

  it("says plainly when nothing matches, and what a search cannot see yet", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    await userEvent.type(await field(), "zebra")
    expect(await within(await card()).findByText("No passages match “zebra”.")).toBeVisible()
    expect(within(await card()).queryByRole("list", { name: "Search results" })).toBeNull()
    expect(await within(await card()).findByText(/Try fewer or different words/)).toBeVisible()
    // One is being read and one could not be, and both are left out of every search.
    const gaps = within(await card()).getByText(/still being read and cannot be searched yet/)
    expect(gaps).toHaveTextContent("1 document could not be read and cannot be searched.")
  })

  it("says so when no document has been read at all", async () => {
    ;(globalThis as Record<string, unknown>).__fdeMockIngestMs = 24 * 60 * 60_000
    renderWithRouter(<DocumentsCard company={ATLAS} />)
    const box = await openUpload()
    await choose(box, new File(["x y z"], "only.txt", { type: "text/plain" }))
    await send(box)
    await closed()
    await userEvent.type(await field(), "anything")
    expect(
      await within(await card()).findByText(/No document has been read yet, so there is nothing/),
    ).toBeVisible()
  })

  it("does not find the passages of a document that is still being read", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    await userEvent.type(await field(), "placeholder")
    expect(await within(await card()).findByText("No passages match “placeholder”.")).toBeVisible()
  })

  it("honours a minus sign and a quoted phrase", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    await userEvent.type(await field(), "overtime -manager")
    expect(await within(await card()).findByText(/No passages match/)).toBeVisible()
    await userEvent.clear(await field())
    await userEvent.type(await field(), '"cold-chain"')
    expect(await within(await card()).findByText(/1 passage for/)).toBeVisible()
  })

  it("shows a long passage around the words found, and all of it on request", async () => {
    ;(globalThis as Record<string, unknown>).__fdeMockIngestMs = 0
    renderWithRouter(<DocumentsCard company={ATLAS} />)
    const long = `${"The claim form has many fields. ".repeat(30)}The adjuster number is required. ${"Then the handler reads it back. ".repeat(30)}`
    const box = await openUpload()
    await choose(box, new File([long], "claim form.txt", { type: "text/plain" }))
    await send(box)
    await closed()
    await userEvent.type(await field(), "adjuster")
    const hit = await within(await card()).findByRole("listitem")
    await waitFor(() => expect(hit.querySelector("mark")).toHaveTextContent("adjuster"))
    expect(hit).toHaveTextContent("…")
    expect(hit.textContent.length).toBeLessThan(long.length / 2)
    const more = within(hit).getByRole("button", { name: "Show the whole passage" })
    expect(more).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(more)
    expect(hit).toHaveTextContent(long.slice(0, 40))
    expect(within(hit).getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
  })

  it("shows a passage that is markup as text, with nothing in it run or turned into elements", async () => {
    ;(globalThis as Record<string, unknown>).__fdeMockIngestMs = 0
    renderWithRouter(<DocumentsCard company={ATLAS} />)
    const hostile = `<img src=x onerror="document.title='owned'"> <script>document.title='owned'</script> about the adjuster **bold** [link](javascript:alert(1))`
    const box = await openUpload()
    await choose(box, new File([hostile], "hostile.md", { type: "text/markdown" }))
    await send(box)
    await closed()
    await userEvent.type(await field(), "adjuster")
    const hit = await within(await card()).findByRole("listitem")
    await waitFor(() => expect(hit).toHaveTextContent("about the adjuster"))
    // Every character of it is on the page as a character.
    expect(hit).toHaveTextContent(hostile)
    expect(hit.querySelectorAll("img, script, a, strong, b").length).toBe(0)
    expect(document.title).not.toBe("owned")
  })

  it("keeps what it showed while it asks again, and marks it as waiting", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    const documents = () => within(screen.getByRole("region", { name: "Documents" }))
    await userEvent.type(await field(), "overtime")
    await documents().findByRole("list", { name: "Search results" })
    let release: () => void = () => {}
    wire.holdReads = new Promise((resolve) => (release = resolve))
    await userEvent.type(await field(), " approval")
    await waitFor(() =>
      expect(
        documents().getByRole("list", { name: "Search results" }).parentElement,
      ).toHaveAttribute("aria-busy", "true"),
    )
    release()
    expect(await documents().findByText(/for “overtime approval”/)).toBeVisible()
  })

  it("shows a search that failed with Try again, and the API's words for a query it refused", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    wire.refuseReads = {
      ending: "/search",
      response: Response.json({ error: "unavailable" }, { status: 400 }),
    }
    await userEvent.type(await field(), "overtime")
    expect(await within(await card()).findByRole("alert")).toHaveTextContent(
      "The workspace is briefly unavailable.",
    )
    wire.refuseReads = null
    await userEvent.click(within(await card()).getByRole("button", { name: "Try again" }))
    expect(await within(await card()).findByRole("list", { name: "Search results" })).toBeVisible()
  })

  it("refuses a query over 500 characters before asking, in the API's words", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    fireEvent.change(await field(), { target: { value: "x".repeat(501) } })
    expect(await within(await card()).findByRole("alert")).toHaveTextContent(
      "Search for up to 500 characters on one line.",
    )
  })

  it("clears on Escape and goes back to the list", async () => {
    renderWithRouter(<DocumentsCard company={KESTREL} />)
    await userEvent.type(await field(), "overtime")
    await within(await card()).findByRole("list", { name: "Search results" })
    await userEvent.keyboard("{Escape}")
    expect(await field()).toHaveValue("")
    expect(await within(await card()).findByRole("list", { name: "Documents" })).toBeVisible()
  })

  it("finds again, with the same words, once a document that was being read is ready", async () => {
    ;(globalThis as Record<string, unknown>).__fdeMockIngestMs = 1_000
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderWithRouter(<DocumentsCard company={ATLAS} />)
    const box = await openUpload()
    await choose(
      box,
      new File(["The adjuster signs off the claim."], "signoff.txt", { type: "text/plain" }),
    )
    await send(box)
    await closed()
    await userEvent.type(await field(), "adjuster")
    expect(await within(await card()).findByText("No passages match “adjuster”.")).toBeVisible()
    await act(() => vi.advanceTimersByTimeAsync(3_000))
    expect(await within(await card()).findByRole("list", { name: "Search results" })).toBeVisible()
  })
})
