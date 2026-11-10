import { useState } from "react"
import { StaleSaveError } from "@/lib/api/client"
import { HELD, problemOf } from "@/lib/records"
import type { Problem } from "@/lib/records"
import { listOf, staleness } from "@/lib/stale"
import type { Labels, Values } from "@/lib/stale"

// How every form saves a record that carries a version (DESIGN.md §3, A stale save). One rule for
// all six kinds: a save sends the version of the copy the form opened on, every field from the
// form. If the record has moved on the API refuses and answers with it; nothing is retried and
// nothing is overwritten. The form keeps what was typed, says which fields differ, and its next
// Save is made on the current version with the person's changes on top.

type Versioned = { version: number }

/** What a form says once a save was refused because the record moved on. */
export type Stale = {
  /** Fields someone else changed since the form opened, named for a sentence. */
  differs: Array<string>
  /** Of those, the ones the person also changed. */
  both: Array<string>
}

/**
 * The state and the Save of a form over a versioned record. `record` is the copy the form opened on
 * (undefined for a create, which never sends a version). `snapshot` reads every field that can
 * differ, including those the form does not show; `initial` is what the form starts with.
 */
export function useVersionedForm<T extends Versioned, TFields extends Values>({
  record,
  snapshot,
  initial,
  labels,
  send,
  adopt,
  changed,
  what,
  fieldOf,
}: {
  record: T | undefined
  snapshot: (record: T) => TFields
  initial: TFields
  labels: Labels<TFields>
  /** Saves `fields` over `base` (undefined for a create) and puts the answer where the page shows it. */
  send: (base: T | undefined, fields: TFields) => Promise<unknown>
  /** Puts the record the API answered a stale save with where the page shows it. */
  adopt: (current: T) => Promise<void>
  /** When given, a save of an edit that changes nothing sends nothing. */
  changed?: (base: T, fields: TFields) => boolean
  /** The noun a refusal is about: "task". */
  what: string
  /** The API's refusals that are about one field. */
  fieldOf?: Record<string, string>
}) {
  const [fields, setFields] = useState<TFields>(initial)
  // The copy the next save is based on: the one the form opened on, then the current record once a save was held back.
  const [base, setBase] = useState<T | undefined>(record)
  const [stale, setStale] = useState<Stale | null>(null)

  async function submit(): Promise<Problem | typeof HELD | null> {
    if (base && changed && !changed(base, fields)) return null
    try {
      await send(base, fields)
      return null
    } catch (error) {
      if (error instanceof StaleSaveError && base) {
        const current = error.current as T
        const found = staleness(snapshot(base), fields, snapshot(current), labels)
        // The page shows the record as it now stands, and the form keeps what was typed on top of it.
        await adopt(current)
        setBase(current)
        setFields(found.merged)
        setStale({ differs: found.differs, both: found.both })
        return HELD
      }
      return problemOf(error, what, fieldOf ?? {})
    }
  }

  return {
    fields,
    set: (patch: Partial<TFields>) => setFields({ ...fields, ...patch }),
    submit,
    stale,
    /** What Save says: it says more once it is no longer a plain save. */
    save: (plain: string) => (stale ? "Save on the current version" : plain),
  }
}

/** The notice a form shows after a stale save: what happened, what differs and what the next Save does. */
export function StaleNotice({ stale, noun }: { stale: Stale | null; noun: string }) {
  if (!stale) return null
  const { differs, both } = stale
  return (
    <div
      role="alert"
      data-stale
      className="grid gap-1 rounded-xl border bg-raised px-3.5 py-2.5 text-xs"
    >
      <p className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-1 size-1.5 flex-none rounded-full bg-attention" />
        <span>This {noun} changed after you opened it, so nothing was saved.</span>
      </p>
      <p className="pl-3.5">
        {differs.length > 0
          ? `Someone changed the ${listOf(differs)}. What you typed is still here.`
          : "Someone saved it again, though not in anything you can edit here. What you typed is still here."}
      </p>
      {both.length > 0 && (
        <p className="pl-3.5">You also changed the {listOf(both)}, so yours replaces theirs.</p>
      )}
      <p className="pl-3.5 text-muted-foreground">
        Save puts your changes on the current {noun}, or cancel to leave it as it is now.
      </p>
    </div>
  )
}
