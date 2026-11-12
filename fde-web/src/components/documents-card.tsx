import { useEffect, useRef, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { UploadDialog } from "./document-upload"
import { Card, Quiet, Row, Rows, Status } from "./page"
import { useNames } from "./people"
import type { Names } from "./people"
import type { Person } from "@/lib/people"
import { Button } from "./ui/button"
import { ApiError, SAFE_TEXT, queries } from "@/lib/api/client"
import type { CompanyId, DocumentOut, SearchHitOut } from "@/lib/api/schemas"
import {
  MAX_QUERY,
  excerpt,
  failureWords,
  formatBytes,
  hasPending,
  kindLabel,
  notSearchable,
  pieces,
  pollDelay,
  queryProblem,
  readyCount,
  searchTerms,
  statusOf,
  uploadedOn,
  whereIn,
} from "@/lib/documents"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/ui/icon"

// The company's documents and search over them (DESIGN.md §3, Documents). A document is searchable
// only once the API says it is ingested, and the card says so rather than guessing. Everything from a
// file, its name and its passages, is customer content and is shown as text, never as markup.

/** Searching starts this many characters in on its own (Enter searches for fewer); the API takes one. */
const MIN_AUTO = 2
/** How long typing pauses before a search is sent. */
const PAUSE_MS = 250

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Who, as words that stay on one line when they are ours ("a teammate …x1"); a real name wraps as usual. */
const together = (person: Person) =>
  person.nameless ? person.phrase.replaceAll(" ", "\u00a0") : person.phrase

export function DocumentsCard({ company }: { company: CompanyId }) {
  const names = useNames({ company })
  // When the first document still being read was first seen, so the polling can slow down and stop.
  const watching = useRef<number | null>(null)
  const documents = useQuery({
    ...queries.documents(company),
    refetchInterval: (query) => {
      if (!hasPending(query.state.data)) {
        watching.current = null
        return false
      }
      watching.current ??= Date.now()
      return pollDelay(Date.now() - watching.current)
    },
  })
  const list = documents.data
  const [uploading, setUploading] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const upload = useRef<HTMLButtonElement>(null)
  const [text, setText] = useState("")
  const [q, setQ] = useState("")

  // The words a person typed are sent once typing pauses, and straight away on Enter.
  useEffect(() => {
    const typed = text.trim()
    if (typed === "") return setQ("")
    // A short search Enter already sent for these words stays: the pause must not undo it.
    const pause = setTimeout(
      () => setQ((now) => (typed.length >= MIN_AUTO || now === typed ? typed : "")),
      PAUSE_MS,
    )
    return () => clearTimeout(pause)
  }, [text])

  // Said when a document that was being read has finished, since nothing else on the page moves.
  const before = useRef<Map<string, DocumentOut["status"]> | null>(null)
  useEffect(() => {
    if (!list) return
    const was = before.current
    before.current = new Map(list.map((doc) => [doc.id, doc.status]))
    if (!was) return
    const done = list.filter((doc) => was.get(doc.id) === "pending" && doc.status !== "pending")
    if (done.length === 0) return
    const ok = done.filter((doc) => doc.status === "ingested")
    const bad = done.length - ok.length
    setSaid(
      [
        ok.length > 0 &&
          (ok.length === 1 && done.length === 1
            ? `“${ok[0]!.name}” is ready to search.`
            : `${plural(ok.length, "document is", "documents are")} ready to search.`),
        bad > 0 &&
          (done.length === 1
            ? `“${done[0]!.name}” could not be read.`
            : `${plural(bad, "document", "documents")} could not be read.`),
      ]
        .filter(Boolean)
        .join(" "),
    )
  }, [list])

  // The polling has stopped on a document that is still not read: something is slow or stuck. Worked out
  // from when the list was last read, so every read, even one that found nothing new, brings it up to date.
  const stalled =
    hasPending(list) &&
    watching.current !== null &&
    pollDelay(documents.dataUpdatedAt - watching.current) === false

  function closeUpload() {
    setUploading(false)
    setTimeout(() => upload.current?.focus(), 0)
  }

  return (
    <Card
      title="Documents"
      aside={
        <Button
          ref={upload}
          variant="outline"
          size="sm"
          onClick={() => {
            setSaid(null)
            setUploading(true)
          }}
        >
          Upload a document
        </Button>
      }
    >
      {said && (
        <p role="status" className="mb-2 text-xs [overflow-wrap:anywhere] text-soft">
          {said}
        </p>
      )}
      <SearchField text={text} onChange={setText} onNow={(typed) => setQ(typed)} />
      <div className="mt-3">
        {text.trim() !== "" ? (
          <Results
            company={company}
            typed={text.trim()}
            q={q}
            list={list}
            ready={readyCount(list)}
          />
        ) : documents.isPending ? (
          <p role="status" className="text-xs text-muted-foreground">
            Reading the documents…
          </p>
        ) : documents.isError ? (
          <p
            role="alert"
            className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          >
            {documents.error instanceof ApiError && documents.error.status === 403
              ? SAFE_TEXT.forbidden
              : "We couldn't read the documents."}
            <Button variant="ghost" size="sm" onClick={() => void documents.refetch()}>
              Try again
            </Button>
          </p>
        ) : list && list.length === 0 ? (
          <Quiet>
            No documents yet. Upload what the customer shares, such as runbooks, policies and
            process write-ups, and search them by what they say. A document can be searched once it
            has been read, which takes a moment.
          </Quiet>
        ) : (
          <>
            <Rows label="Documents">
              {(list ?? []).map((doc) => (
                <DocumentRow key={doc.id} doc={doc} names={names} />
              ))}
            </Rows>
            {stalled && (
              <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                Some documents are taking longer than usual to be read.
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    watching.current = Date.now()
                    void documents.refetch()
                  }}
                >
                  Check again
                </Button>
              </p>
            )}
            {list?.some((doc) => doc.status === "failed") && (
              <Quiet className="mt-2">
                A document cannot be removed or read again from here yet. Upload a corrected copy as
                a new document.
              </Quiet>
            )}
          </>
        )}
      </div>
      {uploading && (
        <UploadDialog
          company={company}
          onUploaded={(saved) =>
            setSaid(`Uploaded “${saved.name}”. It can be searched once it has been read.`)
          }
          onClose={closeUpload}
        />
      )}
    </Card>
  )
}

function SearchField({
  text,
  onChange,
  onNow,
}: {
  text: string
  onChange: (text: string) => void
  /** Enter: search now, for what is typed. */
  onNow: (typed: string) => void
}) {
  return (
    <div className="relative">
      <Icon
        name="search"
        size={14}
        strokeWidth={1.7}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        aria-label="Search the documents"
        placeholder="Search what the documents say"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        value={text}
        maxLength={MAX_QUERY + 100}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            const typed = text.trim()
            if (typed && !queryProblem(typed)) onNow(typed)
          } else if (event.key === "Escape" && text) {
            event.preventDefault()
            onChange("")
          }
        }}
        className="h-9 w-full rounded-lg border bg-raised pr-2.5 pl-8 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-strong max-[800px]:text-base"
      />
    </div>
  )
}

/** What a search found, or why it found nothing, under the field. */
function Results({
  company,
  typed,
  q,
  list,
  ready,
}: {
  company: CompanyId
  typed: string
  q: string
  list: ReadonlyArray<DocumentOut> | undefined
  ready: number
}) {
  const problem = queryProblem(typed)
  const search = useQuery({
    ...queries.search(company, q, ready),
    enabled: q !== "" && !queryProblem(q),
    // The last answer stays up (a little dimmer) while the next one is read, so nothing flashes empty.
    placeholderData: keepPreviousData,
  })
  const [whole, setWhole] = useState<ReadonlySet<string>>(new Set())
  const gaps = notSearchable(list)
  const terms = searchTerms(q)

  if (problem)
    return (
      <p role="alert" className="text-xs text-destructive">
        {problem}
      </p>
    )
  if (q === "") return <Quiet>Keep typing, or press Enter, to search.</Quiet>
  if (search.isPending)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Searching…
      </p>
    )
  if (search.isError)
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {search.error instanceof ApiError && search.error.message !== search.error.code
          ? search.error.message
          : "The search did not work."}
        <Button variant="ghost" size="sm" onClick={() => void search.refetch()}>
          Try again
        </Button>
      </p>
    )

  const hits = search.data
  // Between a pause in typing and the answer for it, what is shown is for the words before.
  const stale = search.isPlaceholderData || typed !== q
  return (
    <div aria-busy={stale} className={cn(stale && "opacity-60")}>
      <p role="status" className="text-[11px] [overflow-wrap:anywhere] text-muted-foreground">
        {hits.length === 0
          ? `No passages match “${q}”.`
          : `${plural(hits.length, "passage", "passages")} for “${q}”, best first.`}
      </p>
      {hits.length === 0 && (
        <Quiet className="mt-1">
          {ready === 0
            ? "No document has been read yet, so there is nothing to search."
            : "Try fewer or different words. A search finds a document's words and what they mean, and leaves out any word that follows a minus sign."}
        </Quiet>
      )}
      {gaps && <Quiet className="mt-1">{gaps}</Quiet>}
      {hits.length > 0 && (
        <ol aria-label="Search results" className="mt-2 divide-y divide-border">
          {hits.map((hit) => {
            const key = `${hit.document}:${hit.chunk}`
            return (
              <Hit
                key={key}
                hit={hit}
                doc={list?.find((doc) => doc.id === hit.document)}
                terms={terms}
                whole={whole.has(key)}
                onToggle={() =>
                  setWhole((now) => {
                    const next = new Set(now)
                    if (!next.delete(key)) next.add(key)
                    return next
                  })
                }
              />
            )
          })}
        </ol>
      )}
    </div>
  )
}

/** A passage as it was found: where it is from, and the words, with what was typed marked. */
function Hit({
  hit,
  doc,
  terms,
  whole,
  onToggle,
}: {
  hit: SearchHitOut
  doc: DocumentOut | undefined
  terms: ReadonlyArray<string>
  whole: boolean
  onToggle: () => void
}) {
  const shown = whole ? { text: hit.text, before: false, after: false } : excerpt(hit.text, terms)
  const cut = shown.before || shown.after || whole
  return (
    <li className="min-w-0 py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 text-xs font-medium [overflow-wrap:anywhere]">
          {hit.document_name}
        </span>
        <Quiet>
          {[doc && kindLabel(doc.content_type), whereIn(hit.chunk, doc)]
            .filter(Boolean)
            .join(" · ")}
        </Quiet>
      </div>
      {/* Plain text: the passage is the customer's. Only what was typed is marked, and marked as text. */}
      <p className="mt-1 text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-soft">
        {shown.before && "… "}
        {pieces(shown.text, terms).map((piece, i) =>
          piece.mark ? (
            <mark
              key={i}
              className="rounded-[3px] bg-selected px-0.5 font-semibold text-foreground"
            >
              {piece.text}
            </mark>
          ) : (
            piece.text
          ),
        )}
        {shown.after && " …"}
      </p>
      {cut && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-0.5 -ml-3 max-[800px]:h-9"
          aria-expanded={whole}
          onClick={onToggle}
        >
          {whole ? "Show less" : "Show the whole passage"}
        </Button>
      )}
    </li>
  )
}

function DocumentRow({ doc, names }: { doc: DocumentOut; names: Names }) {
  const status = statusOf(doc)
  return (
    <Row>
      <div className="flex items-start gap-2.5">
        <Icon
          name="file"
          size={16}
          strokeWidth={1.6}
          aria-hidden="true"
          className="mt-0.5 flex-none text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="min-w-0 text-xs font-medium [overflow-wrap:anywhere]">{doc.name}</span>
            <Status tone={status.tone}>{status.label}</Status>
          </div>
          <Quiet className="[overflow-wrap:anywhere]">
            {[
              kindLabel(doc.content_type),
              formatBytes(doc.size_bytes),
              doc.status === "ingested" && plural(doc.chunks, "passage", "passages"),
              `Added ${uploadedOn(doc)} by ${together(names.of(doc.uploaded_by))}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Quiet>
          {doc.status === "failed" && (
            <p className="mt-1 text-[11px] leading-normal text-soft">{failureWords(doc.failure)}</p>
          )}
          {doc.status === "pending" && (
            <Quiet className="mt-0.5">It can be searched once it has been read.</Quiet>
          )}
        </div>
      </div>
    </Row>
  )
}
