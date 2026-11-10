// A save that was refused because the record moved on (DESIGN.md §3, A stale save). What a form
// does with the record the API answers with: which fields differ from what the person started
// from, which of those they also changed, and what their changes look like on top of the current
// record. Pure, so each rule is tested on its own.

/** What a form holds, one value per field: text, a pick or none. */
export type Values = Record<string, string | null>

/** Each field's name in a sentence: "due date", "status". Its keys are the fields' keys. */
export type Labels<TFields> = { [K in keyof TFields]: string }

// A form trims what it sends, so "x " and "x" are the same words.
const norm = (value: string | null | undefined) => (typeof value === "string" ? value.trim() : null)
const same = (a: string | null | undefined, b: string | null | undefined) => norm(a) === norm(b)

/** The fields whose values differ between `a` and `b`, in the order `labels` lists them. */
export function differing<TFields extends Values>(
  a: TFields,
  b: TFields,
  labels: Labels<TFields>,
): Array<keyof TFields> {
  return (Object.keys(labels) as Array<keyof TFields>).filter((key) => !same(a[key], b[key]))
}

/**
 * What a form makes of a stale save. `opened` is the record's fields when the person's copy was
 * taken, `form` what the form holds, `current` the record as it stands now.
 */
export type Staleness<TFields> = {
  /** Fields someone else changed since `opened`, named for a sentence. */
  differs: Array<string>
  /** Of those, the ones the person also changed: saving again replaces the other change. */
  both: Array<string>
  /** The form's changes on top of `current`: what saving again would send. */
  merged: TFields
}

export function staleness<TFields extends Values>(
  opened: TFields,
  form: TFields,
  current: TFields,
  labels: Labels<TFields>,
): Staleness<TFields> {
  const theirs = differing(opened, current, labels)
  const mine = new Set(differing(opened, form, labels))
  const merged = { ...current }
  // What the person changed is theirs; every other field is the current record's.
  for (const key of mine) merged[key] = form[key]
  return {
    differs: theirs.map((key) => labels[key]),
    both: theirs.filter((key) => mine.has(key)).map((key) => labels[key]),
    merged,
  }
}

/** "status", "status and due date", "title, status and due date". */
export function listOf(names: ReadonlyArray<string>) {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}
