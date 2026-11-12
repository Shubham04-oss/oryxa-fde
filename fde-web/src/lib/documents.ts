import type { QueryClient } from "@tanstack/react-query"
import { queries } from "./api/client"
import type { CompanyId, DocumentOut } from "./api/schemas"
import { MAX_NAME, at, checkName } from "./records"
import type { Problem } from "./records"
import { dayOf, shortDate } from "./time"
import type { Tone } from "@/components/page"

// What the Documents card says and sends (DESIGN.md §3): which files the API takes, what an ingest
// status means in words, how a search result is shown, and how a saved document reaches the page. A
// document is the customer's: its name and its passages are text, and nothing in the file is read here.

/** The API's limit on one file: `MAX_DOCUMENT_BYTES` in `oryxa-fde-context`, 20 MiB. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
/** What the API takes in a search (`MAX_QUERY_CHARS`). */
export const MAX_QUERY = 500

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** The kinds the API reads (`ContentType` in `oryxa-fde-store`), with the file names a computer gives them. */
const KINDS = [
  { type: "text/plain", label: "Text", extensions: [".txt", ".text"] },
  { type: "text/markdown", label: "Markdown", extensions: [".md", ".markdown"] },
  { type: "application/pdf", label: "PDF", extensions: [".pdf"] },
  { type: DOCX, label: "Word", extensions: [".docx"] },
] as const

/** For the file chooser: what it may offer. The API decides again. */
export const ACCEPT = KINDS.flatMap((kind) => [...kind.extensions, kind.type]).join(",")

/** "Text, Markdown, PDF and Word", for a sentence. */
export const KIND_WORDS = "text, Markdown, PDF and Word (.docx) files"

const essence = (contentType: string) => contentType.split(";")[0]!.trim().toLowerCase()

/** The kind a stored content type is, as a word: "PDF", or "File" for one this page does not know. */
export const kindLabel = (contentType: string) =>
  KINDS.find((kind) => kind.type === essence(contentType))?.label ?? "File"

/**
 * The content type to send for a chosen file, or null when it is not one the API reads. The browser's
 * type comes from the file's extension (and is empty for `.md` on some systems), so the name is
 * the fallback. Nothing inside the file is looked at.
 */
export function contentTypeOf(file: { name: string; type: string }): string | null {
  const given = KINDS.find((kind) => kind.type === essence(file.type))
  if (given) return given.type
  const name = file.name.toLowerCase()
  return KINDS.find((kind) => kind.extensions.some((ext) => name.endsWith(ext)))?.type ?? null
}

/** "4.2 MB": sizes as a computer's own file view counts them, so "20 MB" is the limit. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** A file's name as a starting document name: one line, no control characters, at most the API's 200. */
export function nameFromFile(file: string): string {
  // eslint-disable-next-line no-control-regex
  const one = file.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()
  return [...one].slice(0, MAX_NAME).join("")
}

export type UploadFields = { file: File | null; name: string }

/** What the API would refuse, in words, before the file is sent: each is about a field of the form. */
export function uploadProblem({ file, name }: UploadFields): Problem | null {
  if (!file) return at("file", "Choose a file to upload.")
  if (file.size === 0) return at("file", "That file is empty.")
  if (file.size > MAX_DOCUMENT_BYTES) return at("file", "That file is over the 20 MB limit.")
  if (contentTypeOf(file) === null)
    return at("file", `Only ${KIND_WORDS} are accepted. This one is not.`)
  const bad = name.trim() ? checkName(name, "invalid_name", true) : "Give the document a name."
  return at("name", bad)
}

/** The API's refusals of an upload that name a field. */
export const UPLOAD_FIELD: Record<string, string> = {
  invalid_name: "name",
  invalid_body: "file",
  unsupported_media_type: "file",
  payload_too_large: "file",
}

// ── Status ─────────────────────────────────────────────────────────────────

/** A document's status in words. Only `ingested` is searchable, so only that one is "Ready". */
export function statusOf(doc: Pick<DocumentOut, "status">): { tone: Tone; label: string } {
  if (doc.status === "ingested") return { tone: "success", label: "Ready" }
  if (doc.status === "failed") return { tone: "attention", label: "Could not be read" }
  return { tone: "neutral", label: "Being read" }
}

/** Why ingestion gave up (`failure` on a document), in words a person can act on. */
const FAILURES: Record<string, string> = {
  unreadable: "No text could be read from it. The file may be damaged, protected or only images.",
  empty: "There was no text in it to search. A scan or a file of images has none.",
  too_large: "It holds more text than can be read.",
  too_slow: "Reading it took too long.",
  checksum: "The stored copy did not match what was uploaded.",
}

/** The reason a document failed, or a plain line for one the page has no words for. */
export const failureWords = (code: string | null | undefined) =>
  (code && FAILURES[code]) || "It could not be read."

/** Whether a document may still change: a worker has not finished with it. */
export const isPending = (doc: Pick<DocumentOut, "status">) => doc.status === "pending"

export const hasPending = (list: ReadonlyArray<Pick<DocumentOut, "status">> | undefined) =>
  list?.some(isPending) ?? false

/** How many documents a search can find: ingested ones only. */
export const readyCount = (list: ReadonlyArray<Pick<DocumentOut, "status">> | undefined) =>
  list?.filter((doc) => doc.status === "ingested").length ?? 0

/**
 * How long to wait before reading the list again while a document is being read, given how long
 * it has been watched: quickly at first, then less and less often. False once it is clear that
 * something is wrong, so a stuck document does not keep the page asking for ever.
 */
export function pollDelay(watchedMs: number): number | false {
  if (watchedMs < 20_000) return 2_000
  if (watchedMs < 60_000) return 5_000
  if (watchedMs < 5 * 60_000) return 15_000
  if (watchedMs < 15 * 60_000) return 30_000
  return false
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What a search cannot see yet: the documents still being read, and those that could not be. Null when all are ready. */
export function notSearchable(list: ReadonlyArray<Pick<DocumentOut, "status">> | undefined) {
  const waiting = list?.filter(isPending).length ?? 0
  const failed = list?.filter((doc) => doc.status === "failed").length ?? 0
  if (waiting === 0 && failed === 0) return null
  const parts = [
    waiting > 0 &&
      `${plural(waiting, "document is", "documents are")} still being read and cannot be searched yet`,
    failed > 0 &&
      `${plural(failed, "document", "documents")} could not be read and cannot be searched`,
  ].filter(Boolean)
  return `${parts.join(". ")}.`
}

/** "3 Nov 2026": the day it was uploaded, where the browser is. */
export const uploadedOn = (doc: Pick<DocumentOut, "created_at">) => shortDate(dayOf(doc.created_at))

// ── Search ─────────────────────────────────────────────────────────────────

/** A query as the API takes it: trimmed, 1 to 500 characters, no control characters. */
export function queryProblem(raw: string): string | null {
  const q = raw.trim()
  // eslint-disable-next-line no-control-regex
  if ([...q].length > MAX_QUERY || /[\u0000-\u001f\u007f-\u009f]/.test(q))
    return `Search for up to ${MAX_QUERY} characters on one line.`
  return null
}

const MAX_TERMS = 10

/**
 * The words and "quoted phrases" a person typed to find something, without the -exclusions and the
 * operator `or`, for showing where they appear. Only what was typed: the API also finds by meaning
 * and by word stem, so a passage can be right without holding any of these, and is then shown without marks.
 */
export function searchTerms(query: string): Array<string> {
  const terms = new Set<string>()
  const token = /"([^"]*)"|(\S+)/g
  for (const match of query.matchAll(token)) {
    const phrase = match[1]
    const word = match[2]
    // A phrase is kept whole; a word loses punctuation around it, and an exclusion is not wanted.
    const raw = phrase ?? (word!.startsWith("-") ? "" : word!)
    const term = (phrase !== undefined ? raw : raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .trim()
      .replace(/\s+/g, " ")
    if (term.length < 2 || (phrase === undefined && term.toLowerCase() === "or")) continue
    terms.add(term.toLowerCase())
    if (terms.size >= MAX_TERMS) break
  }
  return [...terms].sort((a, b) => b.length - a.length)
}

const escaped = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The matcher for `terms`, or null when there is nothing to mark. Literal text only: never built from markup. */
function matcher(terms: ReadonlyArray<string>) {
  return terms.length === 0 ? null : new RegExp(terms.map(escaped).join("|"), "giu")
}

export type Piece = { text: string; mark: boolean }

/** `text` cut into pieces, the ones that hold a typed term marked. The pieces are text to render as text. */
export function pieces(text: string, terms: ReadonlyArray<string>): Array<Piece> {
  const find = matcher(terms)
  if (!find) return [{ text, mark: false }]
  const out: Array<Piece> = []
  let last = 0
  for (const match of text.matchAll(find)) {
    if (match.index > last) out.push({ text: text.slice(last, match.index), mark: false })
    out.push({ text: match[0], mark: true })
    last = match.index + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), mark: false })
  return out
}

export type Excerpt = { text: string; before: boolean; after: boolean }

/**
 * The part of a passage to show first: all of it when it is short, otherwise a window around the
 * first typed term (or the start, when none is there), cut at spaces so no word is split.
 */
export function excerpt(text: string, terms: ReadonlyArray<string>, width = 320): Excerpt {
  if (text.length <= width) return { text, before: false, after: false }
  const first = matcher(terms)?.exec(text)?.index ?? 0
  let from = Math.max(0, first - Math.floor(width / 3))
  if (from > 0) from = text.indexOf(" ", from - 1) + 1 || from
  let to = Math.min(text.length, from + width)
  if (to < text.length) to = text.lastIndexOf(" ", to) > from ? text.lastIndexOf(" ", to) : to
  return { text: text.slice(from, to).trim(), before: from > 0, after: to < text.length }
}

/** Where in a document a passage is: "Passage 4 of 12", or "Passage 4" when the document is not known. */
export function whereIn(chunk: number, doc: Pick<DocumentOut, "chunks"> | undefined) {
  return doc && chunk < doc.chunks
    ? `Passage ${chunk + 1} of ${doc.chunks}`
    : `Passage ${chunk + 1}`
}

// ── Reaching the views ─────────────────────────────────────────────────────

/** A document the API has stored, at the top of the list. */
export async function commitDocumentAdded(
  client: QueryClient,
  company: CompanyId,
  saved: DocumentOut,
) {
  const key = queries.documents(company).queryKey
  // A read sent before the upload would land after it without the document.
  await client.cancelQueries({ queryKey: key })
  const had = client.getQueryData(key)
  client.setQueryData(key, (old) =>
    old ? [saved, ...old.filter((doc) => doc.id !== saved.id)] : old,
  )
  if (!had) void client.invalidateQueries({ queryKey: key })
}
