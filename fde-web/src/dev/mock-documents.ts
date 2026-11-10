// A company's documents and search for the dev mock (mock-api.ts), typed from fde-api.gen.ts so they follow the
// spec. It keeps the API's rules: a file is a body with a Content-Type of text, Markdown, PDF or DOCX, at most
// 20 MiB and not empty; its name is 1 to 200 characters on one line; an upload is `pending` until "ingestion"
// finishes a moment later, and then `ingested` (searchable) or `failed` with a code. Search merges nothing
// clever: whole words and phrases, -exclusions, only passages of ingested documents, best first.
//
// Ingestion is worked out when a read asks, from a time, so no timer runs and a test that moves the clock
// moves it too. Sample data only: every document here is invented.

import type { components } from "../lib/api/fde-api.gen"

type S = components["schemas"]

/** A document the mock holds: what the API shows, the passages "reading" will find and how it will end. */
export type MockDoc = {
  doc: S["DocumentOut"]
  passages: Array<string>
  /** When ingestion finishes, in ms since the epoch. */
  settleAt: number
  failure: string | null
}

const MAX_BYTES = 20 * 1024 * 1024
const TYPES = [
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

const json = (body: unknown, status = 200) => Response.json(structuredClone(body), { status })
const refuse = (status: number, error: string) => Response.json({ error }, { status })

const ago = (days: number, hours = 0) =>
  new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString()

/** How long ingestion takes. Dev and test only: `globalThis.__fdeMockIngestMs` (a number) sets it for an upload. */
function ingestMs() {
  const set = (globalThis as Record<string, unknown>).__fdeMockIngestMs
  if (typeof set === "number") return set
  return import.meta.env.MODE === "test" ? 60_000 : 4_000
}

function seeded(
  id: string,
  name: string,
  contentType: string,
  size: number,
  uploader: string,
  daysAgo: number,
  passages: Array<string>,
  outcome: "ready" | "pending" | { fails: string },
): MockDoc {
  const ready = outcome === "ready"
  const failed = typeof outcome === "object"
  return {
    passages,
    settleAt: outcome === "pending" ? Date.now() + 90_000 : 0,
    failure: failed ? outcome.fails : null,
    doc: {
      id,
      name,
      content_type: contentType,
      size_bytes: size,
      sha256: id.padEnd(64, "0"),
      status: ready ? "ingested" : failed ? "failed" : "pending",
      failure: failed ? outcome.fails : null,
      chunks: ready ? passages.length : 0,
      uploaded_by: uploader,
      created_at: ago(daysAgo),
      ingested_at: ready || failed ? ago(daysAgo) : null,
    },
  }
}

const PDF = "application/pdf"
const MD = "text/markdown"
const TXT = "text/plain"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** Documents per company id. Kestrel has the full range of states; Atlas has none, to see the empty card. */
export function seedDocuments(): Record<string, Array<MockDoc>> {
  return {
    cmp_kestrel: [
      seeded(
        "doc_k5",
        "Kickoff call transcript.txt",
        TXT,
        18_400,
        "usr_jonah",
        0,
        ["Placeholder until the reader finishes."],
        "pending",
      ),
      seeded("doc_k4", "Scanned site survey, Leeds depot.pdf", PDF, 3_900_000, "usr_riya", 1, [], {
        fails: "empty",
      }),
      seeded(
        "doc_k3",
        "Security questionnaire.docx",
        DOCX,
        96_000,
        "usr_riya",
        6,
        [
          "Customer data is kept for 90 days after the end of an engagement, then deleted. A written request brings the date forward, and the deletion is confirmed in writing.",
          "Access to production systems is granted per person and per task, reviewed every quarter by the data platform manager, and removed on the day a person leaves the project.",
          "No third party other than the cloud host receives customer data. Subprocessors are listed in the appendix and the customer is told before any is added. A new subprocessor is announced thirty days ahead, and the customer may object in writing within that time. If an objection cannot be settled, the customer may end the engagement without a fee, and the data held for it is deleted as set out in the retention section above.",
        ],
        "ready",
      ),
      seeded(
        "doc_k2",
        "Driver hours policy.pdf",
        PDF,
        1_250_000,
        "usr_jonah",
        11,
        [
          "A driver may drive for at most nine hours in a day, ten twice a week. After four and a half hours of driving a break of forty-five minutes is taken before driving again.",
          "A weekly rest of at least forty-five hours is taken in every week. A reduced rest of twenty-four hours is allowed every second week, and the hours owed are made up before the end of the third week after.",
          "Dispatch may not plan a route that needs a driver to exceed these limits. When a plan would, the planner must offer a second driver or a later slot, and say which rule forced it.",
        ],
        "ready",
      ),
      seeded(
        "doc_k1",
        "Depot rules.md",
        MD,
        12_300,
        "usr_riya",
        24,
        [
          "Leeds depot loads between 05:00 and 11:00. Pallets for the north round are staged on lane 4, and the last pallet is on the dock forty minutes before the vehicle is due out.",
          "Ghent depot closes its dock for lunch from 12:30 to 13:15. Nothing is loaded in that window, and a plan that needs it is moved to the next slot.",
          "Overtime at any depot needs the depot manager's approval the day before. The planner shows the cost of the overtime beside the plan, so the dispatcher can decide with it in view.",
          "Cold-chain loads are planned first. A cold-chain vehicle never waits at the dock for more than twenty minutes, and the planner treats that as a hard limit, not a preference.",
        ],
        "ready",
      ),
    ],
    cmp_brightwater: [
      seeded(
        "doc_b1",
        "Referral intake process.docx",
        DOCX,
        210_000,
        "usr_jonah",
        9,
        [
          "A referral arrives by fax, email or the web form. The intake clerk checks the patient's name and date of birth against the record, and a mismatch holds the referral until it is resolved.",
          "An urgent referral is booked within two working days. A routine one is booked within ten, and the clerk records the reason when a booking is later than that.",
        ],
        "ready",
      ),
    ],
    cmp_lumen: [
      seeded(
        "doc_l1",
        "Produce waste review, Q3.pdf",
        PDF,
        2_100_000,
        "usr_riya",
        18,
        [
          "Fresh produce waste was highest for leafy greens and berries, where shelf life is under five days. Stores with a daily order cut-off wasted less than stores that ordered twice a week.",
        ],
        "ready",
      ),
    ],
  }
}

/** Finishes ingestion for documents whose time has come. */
function settle(list: Array<MockDoc>) {
  for (const m of list) {
    if (m.doc.status !== "pending" || Date.now() < m.settleAt) continue
    m.doc.ingested_at = new Date().toISOString()
    if (m.failure) {
      m.doc.status = "failed"
      m.doc.failure = m.failure
    } else {
      m.doc.status = "ingested"
      m.doc.chunks = m.passages.length
    }
  }
}

const newestFirst = (list: Array<MockDoc>) =>
  list
    .map((m) => m.doc)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id))

/** `GET .../documents` and `GET .../documents/{id}`. */
export function documentReads(list: Array<MockDoc>, id: string | undefined) {
  settle(list)
  if (id === undefined) return json(newestFirst(list))
  const found = list.find((m) => m.doc.id === id)
  return found ? json(found.doc) : refuse(404, "not_found")
}

let uploads = 0

/** A text file's text, for the mock only: the real app never reads a file. */
function textOf(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

/** Paragraphs of a text file, as passages of up to about 900 characters, at most 40. */
function paragraphs(text: string): Array<string> {
  const out: Array<string> = []
  for (const block of text.split(/\n\s*\n/)) {
    const clean = block.replace(/\s+/g, " ").trim()
    if (!clean) continue
    const last = out.at(-1)
    if (last !== undefined && last.length + clean.length < 900)
      out[out.length - 1] = `${last} ${clean}`
    else out.push(clean)
  }
  return out.slice(0, 40)
}

/** `POST .../documents?name=`: the API's checks in its order, then a pending document. */
export async function documentUpload(
  list: Array<MockDoc>,
  url: URL,
  contentType: string,
  body: Blob,
  me: string,
) {
  const name = (url.searchParams.get("name") ?? "").trim()
  if ([...name].length < 1 || [...name].length > 200 || CONTROL.test(name))
    return refuse(400, "invalid_name")
  const type = contentType.split(";")[0]!.trim().toLowerCase()
  if (!TYPES.includes(type)) return refuse(415, "unsupported_media_type")
  if (body.size === 0) return refuse(400, "invalid_body")
  // The API's body limit answers with no body of its own.
  if (body.size > MAX_BYTES) return new Response(null, { status: 413 })

  const text = type === "text/plain" || type === "text/markdown" ? await textOf(body) : null
  const passages =
    text !== null
      ? paragraphs(text)
      : [`Sample text read from ${name}. A real reader finds the document's own words here.`]
  // The sample reader fails on what the API's would: a file with nothing readable in it.
  const failure = /unreadable/i.test(name) ? "unreadable" : passages.length === 0 ? "empty" : null
  const saved: MockDoc = {
    passages,
    settleAt: Date.now() + ingestMs(),
    failure,
    doc: {
      id: `doc_new${++uploads}`,
      name,
      content_type: type,
      size_bytes: body.size,
      sha256: "0".repeat(64),
      status: "pending",
      failure: null,
      chunks: 0,
      uploaded_by: me,
      created_at: new Date().toISOString(),
      ingested_at: null,
    },
  }
  list.push(saved)
  return json(saved.doc, 201)
}

const MAX_QUERY = 500

/** The words and "phrases" of a query, and what it excludes. */
function parse(q: string) {
  const include: Array<string> = []
  const exclude: Array<string> = []
  for (const match of q.matchAll(/(-?)"([^"]*)"|(-?)(\S+)/g)) {
    const minus = match[1] === "-" || match[3] === "-"
    const term = (match[2] ?? match[4] ?? "").trim().toLowerCase()
    if (!term || term === "or") continue
    ;(minus ? exclude : include).push(term)
  }
  return { include, exclude }
}

/** A word matches by its stem, so "drivers" finds "driver": the API's full-text side does too. */
const stem = (term: string) => (term.length > 3 ? term.replace(/(ing|ed|es|s)$/, "") : term)

/** `GET .../search?q=&limit=`: passages of ingested documents holding what was asked, best first. */
export function documentSearch(list: Array<MockDoc>, url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim()
  if ([...q].length < 1 || [...q].length > MAX_QUERY || CONTROL.test(q))
    return refuse(400, "invalid_query")
  const raw = url.searchParams.get("limit")
  const limit = raw === null ? 10 : Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return refuse(400, "invalid_limit")
  settle(list)
  const { include, exclude } = parse(q)
  const hits = list
    .filter((m) => m.doc.status === "ingested")
    .flatMap((m) =>
      m.passages.map((text, chunk) => ({ m, text, chunk, lower: text.toLowerCase() })),
    )
    .filter((p) => !exclude.some((term) => p.lower.includes(term)))
    .map((p) => ({
      ...p,
      score: include.filter((term) => p.lower.includes(stem(term))).length / (include.length || 1),
    }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return json(
    hits.map((p): S["SearchHitOut"] => ({
      document: p.m.doc.id,
      document_name: p.m.doc.name,
      chunk: p.chunk,
      text: p.text,
      score: p.score / 60,
    })),
  )
}
