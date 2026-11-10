import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { FormDialog, TextField, useFieldProblem } from "./form-dialog"
import { Quiet } from "./page"
import { FIELD, Labelled } from "./task-move"
import { Dialog } from "./ui/dialog"
import { ApiError, api, queries } from "@/lib/api/client"
import type { CompanyId, DocumentOut } from "@/lib/api/schemas"
import {
  ACCEPT,
  KIND_WORDS,
  UPLOAD_FIELD,
  commitDocumentAdded,
  contentTypeOf,
  formatBytes,
  kindLabel,
  nameFromFile,
  uploadProblem,
} from "@/lib/documents"
import { reason } from "@/lib/task-move"
import type { Problem } from "@/lib/records"

// The upload form (DESIGN.md §3, Documents). One file at a time, as the API takes one. The browser
// sends the file as it is (no reading, no conversion) through this app's own origin; the form stays
// open until the API has the document, and a file that did not go stays chosen so it can be sent again.

/** How far an upload is: what has left the browser, then the wait for the API to store it. */
type Progress = { sent: number; total: number }

/** Why an upload did not finish, in words. A refusal the API gave says its reason; anything else is the connection. */
function failure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401)
      return "Your session has ended. Sign in again, then send the file again."
    return reason(error, "company")
  }
  return "The upload did not finish. Check your connection and try again. The file is still chosen."
}

export function UploadDialog({
  company,
  onUploaded,
  onClose,
}: {
  company: CompanyId
  onUploaded: (saved: DocumentOut) => void
  onClose: () => void
}) {
  const client = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState("")
  // Once the name is typed in, choosing another file does not write over it.
  const [named, setNamed] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const sending = useRef<AbortController | null>(null)

  // Leaving (Cancel, Escape, the page) stops an upload in flight. The API may already have it, so the
  // list is read again to say what is true.
  useEffect(
    () => () => {
      if (!sending.current) return
      sending.current.abort()
      void client.invalidateQueries({ queryKey: queries.documents(company).queryKey })
    },
    [client, company],
  )

  function choose(chosen: File | null) {
    setFile(chosen)
    if (chosen && !named) setName(nameFromFile(chosen.name))
  }

  async function save(): Promise<Problem | null> {
    const type = file ? contentTypeOf(file) : null
    if (!file || !type) return null
    const controller = new AbortController()
    sending.current = controller
    setProgress({ sent: 0, total: file.size })
    try {
      const saved = await api.uploadDocument(
        company,
        { file, contentType: type, name: name.trim() },
        (sent, total) => setProgress({ sent, total }),
        controller.signal,
      )
      await commitDocumentAdded(client, company, saved)
      onUploaded(saved)
      return null
    } catch (error) {
      const message = failure(error)
      const field = error instanceof ApiError ? UPLOAD_FIELD[error.code] : undefined
      return field ? { message, field } : message
    } finally {
      sending.current = null
      setProgress(null)
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <FormDialog
        title="Upload a document"
        description="Choose a file to add to this company's documents. It can be searched once it has been read."
        save="Upload"
        validate={() => uploadProblem({ file, name })}
        onSubmit={save}
        onClose={onClose}
      >
        <Quiet>
          Sample data only for now. Files are kept under the shared environment key until each
          company has its own.
        </Quiet>
        <FileField file={file} onChange={choose} />
        <TextField
          name="name"
          label="Name"
          value={name}
          onChange={(value) => {
            setName(value)
            setNamed(true)
          }}
          hint="Shown in the list and in search results. One line, up to 200 characters."
        />
        {progress && <UploadProgress {...progress} />}
      </FormDialog>
    </Dialog>
  )
}

/** The chooser. A file dropped on it is chosen too: the browser does that for a file input. */
function FileField({
  file,
  onChange,
}: {
  file: File | null
  onChange: (file: File | null) => void
}) {
  const problem = useFieldProblem("file")
  const type = file ? contentTypeOf(file) : null
  return (
    <div className="grid gap-1">
      <Labelled label="File">
        <input
          type="file"
          accept={ACCEPT}
          data-field="file"
          className={`${FIELD} cursor-pointer file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-selected file:px-2.5 file:py-1 file:text-xs file:text-foreground`}
          onChange={(event) => onChange(event.target.files?.[0] ?? null)}
          {...problem}
        />
      </Labelled>
      <Quiet>
        {file
          ? `${type ? kindLabel(type) : "Not a kind of file the API reads"} · ${formatBytes(file.size)}`
          : `${KIND_WORDS[0]!.toUpperCase()}${KIND_WORDS.slice(1)}, up to 20 MB.`}
      </Quiet>
    </div>
  )
}

/** A bar for the bytes that have left, and a line for the phase; the numbers are not read out as they change. */
function UploadProgress({ sent, total }: Progress) {
  const done = total > 0 && sent >= total
  const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0
  return (
    <div className="grid gap-1.5">
      <div
        role="progressbar"
        aria-label="Upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-selected"
      >
        <div className="h-full bg-foreground" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-[11px] text-muted-foreground" aria-hidden="true">
        {done
          ? "Sent. Waiting for the workspace to store it…"
          : `Sending ${formatBytes(sent)} of ${formatBytes(total)}`}
      </p>
      <p role="status" className="sr-only">
        {done ? "Sent. Storing the document." : "Sending the file."}
      </p>
    </div>
  )
}
