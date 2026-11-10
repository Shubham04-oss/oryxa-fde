import { useEffect, useImperativeHandle, useRef, useState } from "react"
import type { Ref } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, ChevronRight } from "lucide-react"
import { TaskDialog } from "./board"
import { DecisionDialog } from "./decisions-card"
import { FormDialog, TextArea, TextField, useFieldProblem } from "./form-dialog"
import { Card, Quiet, Row, Rows } from "./page"
import { useTaskMover } from "./task-move"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { ApiError, api, queries } from "@/lib/api/client"
import type {
  MeetingNoteOut,
  NotePlace,
  Project,
  ProjectScope,
  StakeholderOut,
} from "@/lib/api/schemas"
import {
  MAX_NOTE,
  NOTE_FIELD,
  attendeesLine,
  blankNote,
  chosenIn,
  commitNote,
  commitNoteRemoved,
  lineToTitle,
  noteBody,
  noteChanged,
  noteEditBody,
  noteFields,
  noteLength,
  noteProblem,
  stakeholdersLine,
} from "@/lib/notes"
import type { NoteFields } from "@/lib/notes"
import { PART_LABEL, attempt, attemptAt } from "@/lib/records"
import { localDay, shortDate } from "@/lib/time"
import { cn } from "@/lib/utils"

// Meeting notes (DESIGN.md §3): written like a note, not filled in like a form, and the way from a
// line of it to a task or a decision. A note is plain text: the API stores no markup, and nothing here
// ever renders one, so a note that holds `<b>` or `**` shows exactly those characters.

/** What the stage checklist does on this card. */
export type NotesHandle = {
  /** Opens the blank note. */
  write: () => void
}

/** What a line of a note is being made into. */
type Making = { kind: "task" | "decision"; title: string }

/** A line was made into something: the words that say so. */
const madeLine = (kind: Making["kind"], title: string) =>
  kind === "task" ? `Added the task “${title}” to the board.` : `Logged the decision “${title}”.`

/**
 * The project's notes (a project passes itself, and a note can become a task or a decision), or a
 * company's (a note there is the company's: no board to put a task on).
 */
export function NotesCard({
  place,
  people,
  project,
  handle,
}: {
  place: NotePlace
  /** The company's stakeholders: who a note can say was there. */
  people: ReadonlyArray<StakeholderOut>
  project?: Project
  handle?: Ref<NotesHandle>
}) {
  const notes = useQuery(queries.notes(place))
  const me = useQuery(queries.me())
  // A note to write or to change, as a copy taken when the form opened: "new" for a blank one.
  const [open, setOpen] = useState<MeetingNoteOut | "new" | null>(null)
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set())
  const [made, setMade] = useState<string | null>(null)
  const [making, setMaking] = useState<Making | null>(null)
  const write = useRef<HTMLButtonElement>(null)
  const from = useRef<HTMLElement | null>(null)
  // What was selected in a note being read, and in which: a tap on a button can empty the selection first.
  const selected = useRef<{ id: string; text: string } | null>(null)
  const scope: ProjectScope | undefined = project && {
    company: project.company.id,
    project: project.id,
  }

  useEffect(() => {
    function remember() {
      const picked = window.getSelection()
      if (!picked || picked.isCollapsed) return
      const anchor =
        picked.anchorNode instanceof Element ? picked.anchorNode : picked.anchorNode?.parentElement
      const root = anchor?.closest<HTMLElement>("[data-note-body]")
      if (root?.dataset.noteBody && root.contains(picked.focusNode))
        selected.current = { id: root.dataset.noteBody, text: picked.toString() }
    }
    document.addEventListener("selectionchange", remember)
    return () => document.removeEventListener("selectionchange", remember)
  }, [])

  /** Opens the form, remembering what to give focus back to. */
  function show(next: MeetingNoteOut | "new", opener: HTMLElement | null) {
    from.current = opener
    setMade(null)
    setOpen(next)
  }
  useImperativeHandle(handle, () => ({
    write: () => show("new", document.activeElement as HTMLElement | null),
  }))
  /** Focus goes back to what opened the form; when that has gone (a removed note), to Write a note. */
  function close() {
    setOpen(null)
    setTimeout(() => {
      const opener = from.current
      ;(opener?.isConnected ? opener : write.current)?.focus()
    }, 0)
  }
  function toggle(id: string) {
    if (selected.current?.id === id) selected.current = null
    setReading((now) => {
      const next = new Set(now)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }
  /** A task or a decision from a note being read: what is selected in it, or else a title to type. */
  function make(kind: Making["kind"], note: MeetingNoteOut, opener: HTMLElement) {
    const chosen = selected.current?.id === note.id ? selected.current.text : ""
    selected.current = null
    from.current = opener
    setMade(null)
    setMaking({ kind, title: lineToTitle(chosen) })
  }
  function stopMaking() {
    setMaking(null)
    setTimeout(() => (from.current?.isConnected ? from.current : write.current)?.focus(), 0)
  }

  const list = notes.data
  const where = place.project === undefined ? "company" : "project"

  return (
    <Card
      title="Notes"
      aside={
        <Button
          ref={write}
          variant="outline"
          size="sm"
          onClick={(event) => show("new", event.currentTarget)}
        >
          Write a note
        </Button>
      }
    >
      {where === "company" && (
        <Quiet className="mb-2">
          A note here belongs to the company. A project&apos;s Discover checklist counts only the
          notes written on the project itself.
        </Quiet>
      )}
      {made && (
        <p role="status" className="mb-2 text-xs [overflow-wrap:anywhere] text-soft">
          {made}
        </p>
      )}
      {notes.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Reading the notes…
        </p>
      ) : notes.isError ? (
        <p role="alert" className="flex items-center gap-2 text-xs text-muted-foreground">
          We couldn&apos;t read the notes.
          <Button variant="ghost" size="sm" onClick={() => void notes.refetch()}>
            Try again
          </Button>
        </p>
      ) : list && list.length === 0 ? (
        <Quiet>
          {where === "project"
            ? "No notes on this project yet. Write up each call while it is fresh: what was said, what was agreed and who was there, then turn the actions into tasks and the agreements into decisions."
            : "No notes on this company yet. Write up a call that was not about one project: what was said, what was agreed and who was there."}
        </Quiet>
      ) : (
        <Rows label="Meeting notes">
          {(list ?? []).map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              people={people}
              me={me.data?.user.id}
              reading={reading.has(note.id)}
              canMake={project !== undefined}
              onToggle={() => toggle(note.id)}
              onEdit={(opener) => show(note, opener)}
              onMake={(kind, opener) => make(kind, note, opener)}
            />
          ))}
        </Rows>
      )}
      {open !== null && (
        <NoteWriter
          key={open === "new" ? "new" : open.id}
          place={place}
          note={open === "new" ? null : open}
          people={people}
          project={project}
          me={me.data?.user.id}
          stage={project?.stage}
          only={list?.length === 1}
          onClose={close}
        />
      )}
      {project && scope && (
        <MakeFromNote
          scope={scope}
          project={project}
          making={making}
          onMade={(kind, title) => setMade(madeLine(kind, title))}
          onClose={stopMaking}
        />
      )}
    </Card>
  )
}

/** A note in the list: its title, when and who, and its words, in full once opened. */
function NoteRow({
  note,
  people,
  me,
  reading,
  canMake,
  onToggle,
  onEdit,
  onMake,
}: {
  note: MeetingNoteOut
  people: ReadonlyArray<StakeholderOut>
  me: string | undefined
  reading: boolean
  canMake: boolean
  onToggle: () => void
  onEdit: (opener: HTMLElement) => void
  onMake: (kind: Making["kind"], opener: HTMLElement) => void
}) {
  const attended = attendeesLine(note, me)
  const customers = stakeholdersLine(note, people)
  const bodyId = `note-${note.id}`
  return (
    <Row>
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 flex-1 text-xs font-medium">
          <button
            type="button"
            aria-expanded={reading}
            aria-controls={bodyId}
            onClick={onToggle}
            className="flex w-full items-start gap-1.5 py-0.5 text-left max-[800px]:py-2"
          >
            {reading ? (
              <ChevronDown size={14} strokeWidth={1.7} aria-hidden="true" className="mt-px" />
            ) : (
              <ChevronRight size={14} strokeWidth={1.7} aria-hidden="true" className="mt-px" />
            )}
            <span className="min-w-0 [overflow-wrap:anywhere]">{note.title}</span>
          </button>
        </h3>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Edit ${note.title}`}
          className="max-[800px]:h-9"
          onClick={(event) => onEdit(event.currentTarget)}
        >
          Edit
        </Button>
      </div>
      <Quiet className="pl-5 [overflow-wrap:anywhere]">
        {[
          shortDate(note.held_on),
          attended && `Attended: ${attended}`,
          customers && `With ${customers}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Quiet>
      {/* Plain text, lines kept: the words are the customer's, and never markup. */}
      <div
        id={bodyId}
        data-note-body={note.id}
        className={cn(
          "mt-1.5 pl-5 text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap",
          reading ? "text-foreground" : "line-clamp-2 text-soft",
        )}
      >
        {note.body}
      </div>
      {reading && canMake && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-5">
          <Button
            variant="outline"
            size="sm"
            className="max-[800px]:h-9"
            aria-label={`Make a task from ${note.title}`}
            onClick={(event) => onMake("task", event.currentTarget)}
          >
            Make a task
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="max-[800px]:h-9"
            aria-label={`Log a decision from ${note.title}`}
            onClick={(event) => onMake("decision", event.currentTarget)}
          >
            Log a decision
          </Button>
          <Quiet>Select a line first to start from it, or type the title.</Quiet>
        </div>
      )}
    </Row>
  )
}

/**
 * The task form or the decision form, opened on a line of a note. They are the board's and the
 * Decisions card's own forms, with their own saving: the note is not changed, because the API has no
 * link from a note to a task or a decision.
 */
function MakeFromNote({
  scope,
  project,
  making,
  onMade,
  onClose,
}: {
  scope: ProjectScope
  project: Project
  making: Making | null
  onMade: (kind: Making["kind"], title: string) => void
  onClose: () => void
}) {
  const mover = useTaskMover()
  const me = useQuery(queries.me())
  return (
    <Dialog open={making !== null} onOpenChange={(next) => !next && onClose()}>
      {making?.kind === "task" && (
        <TaskDialog
          task={null}
          status="todo"
          title={making.title}
          people={project.stakeholders}
          requests={project.access}
          me={me.data?.user.id}
          onSave={async (fields) => {
            const failed = await mover.submit(scope, null, fields)
            if (!failed) onMade("task", fields.title.trim())
            return failed
          }}
          onDelete={undefined}
          onClose={onClose}
        />
      )}
      {making?.kind === "decision" && (
        <DecisionDialog
          scope={scope}
          project={project}
          me={me.data?.user.name}
          title={making.title}
          onLogged={(decision) => onMade("decision", decision.title)}
          onClose={onClose}
        />
      )}
    </Dialog>
  )
}

/**
 * Writes a note, or changes one. A big field to write in, the title and the day beside each other
 * above it, who was there below. Closing asks first when there is something to lose; a save that
 * fails keeps every word in the form.
 */
function NoteWriter({
  place,
  note,
  people,
  project,
  me,
  stage,
  only,
  onClose,
}: {
  place: NotePlace
  note: MeetingNoteOut | null
  people: ReadonlyArray<StakeholderOut>
  project?: Project
  me: string | undefined
  stage: Project["stage"] | undefined
  /** This is the only note listed. */
  only: boolean
  onClose: () => void
}) {
  const client = useQueryClient()
  // The copy taken when the form opened: what a change is measured against.
  const [opened] = useState<NoteFields>(() => (note ? noteFields(note) : blankNote(me, localDay())))
  const [fields, setFields] = useState<NoteFields>(opened)
  const set = (patch: Partial<NoteFields>) => setFields({ ...fields, ...patch })
  const [asking, setAsking] = useState(false)
  const [making, setMaking] = useState<Making | null>(null)
  const [made, setMade] = useState<Array<string>>([])
  const text = useRef<HTMLTextAreaElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const scope: ProjectScope | undefined = project && {
    company: project.company.id,
    project: project.id,
  }
  const dirty = noteChanged(opened, fields)
  const count = noteLength(fields.body)

  /** Cancel, Escape or a click outside: asks first when words would be lost. */
  const leave = () => (dirty ? setAsking(true) : onClose())

  function start(kind: Making["kind"], from: HTMLElement) {
    opener.current = from
    setMaking({ kind, title: text.current ? chosenIn(text.current) : "" })
  }
  function stop() {
    setMaking(null)
    setTimeout(() => (opener.current?.isConnected ? opener.current : text.current)?.focus(), 0)
  }

  // Who was there: you, and any teammate the note already names. Others cannot be picked until the
  // API gives their names, so a teammate is "A teammate" with the end of their id, as on the board.
  const attendees = [...new Set([...(me ? [me] : []), ...opened.attendees])].map((id) => ({
    id,
    label: id === me ? "You" : `A teammate …${id.slice(-6)}`,
  }))

  const save = () =>
    attemptAt(
      async () => {
        try {
          if (note) {
            // Nothing changed, so there is nothing to send.
            if (!dirty) return
            const live = client
              .getQueryData(queries.notes(place).queryKey)
              ?.find((n) => n.id === note.id)
            await commitNote(
              client,
              place,
              await api.updateNote(place, note.id, noteEditBody(note, live, fields)),
              false,
            )
          } else {
            await commitNote(client, place, await api.addNote(place, noteBody(fields)), true)
          }
        } catch (error) {
          // The note is gone (removed elsewhere): read the list again so the card says so.
          if (error instanceof ApiError && error.status === 404)
            void client.invalidateQueries({ queryKey: queries.notes(place).queryKey })
          throw error
        }
      },
      "note",
      NOTE_FIELD,
    )

  const lastOne = only && stage === "discover" && place.project !== undefined

  return (
    <Dialog open onOpenChange={(next) => !next && leave()}>
      <FormDialog
        wide
        title={note ? "Edit note" : "Write a note"}
        description={
          note
            ? "Change this meeting note, or delete it."
            : "Write up a meeting: what was said, what was agreed and who was there."
        }
        save={note ? "Save" : "Save note"}
        validate={() => noteProblem(fields)}
        onSubmit={save}
        onClose={onClose}
        onCancel={leave}
        remove={
          note
            ? {
                label: "Delete note",
                ask: lastOne
                  ? "Delete this note? It is the project's only one, so the Discover checklist asks for a note again. This cannot be undone."
                  : "Delete this note? This cannot be undone.",
                group: "Confirm the delete",
                confirm: "Delete",
                run: () =>
                  attempt(async () => {
                    try {
                      await api.removeNote(place, note.id)
                    } catch (error) {
                      if (error instanceof ApiError && error.status === 404)
                        void client.invalidateQueries({ queryKey: queries.notes(place).queryKey })
                      throw error
                    }
                    await commitNoteRemoved(client, place, note.id)
                  }, "note"),
              }
            : undefined
        }
        after={
          scope &&
          project && (
            <MakeFromNote
              scope={scope}
              project={project}
              making={making}
              onMade={(kind, title) => setMade((now) => [...now, madeLine(kind, title)])}
              onClose={stop}
            />
          )
        }
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 max-[560px]:grid-cols-1">
          <TextField
            name="title"
            label="Title"
            value={fields.title}
            onChange={(title) => set({ title })}
          />
          <TextField
            name="heldOn"
            type="date"
            label="Held on"
            value={fields.heldOn}
            onChange={(heldOn) => set({ heldOn })}
          />
        </div>
        <TextArea
          autoFocus
          large
          name="body"
          label="Note"
          inputRef={text}
          value={fields.body}
          onChange={(body) => set({ body })}
        />
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Quiet className={cn(count > MAX_NOTE && "text-destructive")}>
            {count.toLocaleString("en-GB")} of {MAX_NOTE.toLocaleString("en-GB")} characters
          </Quiet>
          {scope && (
            <div className="flex flex-wrap items-center gap-2">
              <Quiet>Select a line, or put the cursor on it:</Quiet>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="max-[800px]:h-9"
                onClick={(event) => start("task", event.currentTarget)}
              >
                Make a task
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="max-[800px]:h-9"
                onClick={(event) => start("decision", event.currentTarget)}
              >
                Log a decision
              </Button>
            </div>
          )}
        </div>
        {made.length > 0 && (
          <ul
            role="status"
            aria-label="Made from this note"
            className="grid gap-0.5 text-xs text-soft"
          >
            {made.map((line, i) => (
              <li key={i} className="[overflow-wrap:anywhere]">
                {line}
              </li>
            ))}
          </ul>
        )}
        <Choose
          name="attendees"
          legend="Who from your team was there"
          options={attendees}
          picked={fields.attendees}
          onChange={(next) => set({ attendees: next })}
          note={
            attendees.length > 0
              ? "Teammates can be added here once the workspace knows their names."
              : undefined
          }
        />
        <Choose
          name="stakeholders"
          legend="Who from the customer was there"
          options={people.map((p) => ({ id: p.id, label: p.name, detail: PART_LABEL[p.role] }))}
          picked={fields.stakeholders}
          onChange={(next) => set({ stakeholders: next })}
          empty="No one at the customer is named yet. Add people on the company page."
        />
        {asking && (
          <div
            role="group"
            aria-label="Confirm leaving the note"
            className="flex flex-wrap items-center gap-2 rounded-xl border bg-raised px-3.5 py-2.5"
          >
            <p className="mr-auto">
              {note ? "Leave without saving your changes?" : "Leave without saving this note?"} What
              you wrote is lost.
            </p>
            {/* The safe answer takes focus: Escape twice must not throw a long note away. */}
            <Button type="button" variant="ghost" autoFocus onClick={() => setAsking(false)}>
              Keep writing
            </Button>
            <Button type="button" onClick={onClose}>
              Leave
            </Button>
          </div>
        )}
      </FormDialog>
    </Dialog>
  )
}

/** Several of a few: each a pill with a checkbox, so none is a long list to scroll. */
function Choose({
  name,
  legend,
  options,
  picked,
  onChange,
  note,
  empty,
}: {
  name: string
  legend: string
  options: ReadonlyArray<{ id: string; label: string; detail?: string }>
  picked: ReadonlyArray<string>
  onChange: (next: Array<string>) => void
  note?: string
  empty?: string
}) {
  const problem = useFieldProblem(name)
  if (options.length === 0 && !empty) return null
  return (
    <fieldset className="grid min-w-0 gap-1.5">
      <legend className="mb-1 text-[11px] text-muted-foreground">{legend}</legend>
      {options.length === 0 ? (
        empty && <p className="text-[11px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
          {options.map((option, i) => (
            <label
              key={option.id}
              className="inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs has-checked:border-strong has-checked:bg-raised has-focus-visible:ring-1 has-focus-visible:ring-ring max-[800px]:min-h-9"
            >
              <input
                type="checkbox"
                className="size-3.5 accent-foreground"
                data-field={i === 0 ? name : undefined}
                {...(i === 0 ? problem : {})}
                checked={picked.includes(option.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...picked, option.id]
                      : picked.filter((id) => id !== option.id),
                  )
                }
              />
              {option.label}
              {option.detail && <span className="text-muted-foreground">{option.detail}</span>}
            </label>
          ))}
        </div>
      )}
      {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
    </fieldset>
  )
}
