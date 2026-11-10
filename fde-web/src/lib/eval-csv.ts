import type { SuiteOut } from "./api/evals"

// What the API accepts of a CSV (`oryxa_fde_evals::import`, with `Suite::check_cases`), read in the browser before
// anything is sent, so a refusal says which row and why. The API takes a whole file or none of it, and answers a
// refusal with a code only, so these words are the page's reading of the API's rules. The API still decides:
// a file this passes can be refused, and what is shown as imported is what the API confirms.

export const MAX_CSV_BYTES = 8 * 1024 * 1024
/** Rows in a file, and cases in a suite. */
export const MAX_ROWS = 10_000
/** One value, in bytes: it reaches a command's environment in the sandbox. */
const MAX_TEXT_BYTES = 64 * 1024
const ID = /^[A-Za-z0-9_-]{1,128}$/

/** A file's text. FileReader, because it is in every browser and in the test DOM; `Blob.text` is not. */
export const readText = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."))
    reader.readAsText(blob)
  })

export type CsvProblem = { row: number | null; text: string }

/** What reading a file found: how many rows, the columns, and every reason the API would refuse it. */
export type CsvReading = {
  rows: number
  columns: Array<string>
  problems: Array<CsvProblem>
}

const utf8 = new TextEncoder()
const bytes = (s: string) => utf8.encode(s).length

/** RFC 4180: quoted values, `""` for a quote, any line ending, blank lines skipped. `null` when a quote never closes. */
export function parseCsv(text: string): Array<Array<string>> | null {
  const source = text.startsWith("﻿") ? text.slice(1) : text
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let field = ""
  let quoted = false
  let touched = false
  const endField = () => {
    row.push(field)
    field = ""
  }
  const endRow = () => {
    endField()
    // An empty line is not a record.
    if (row.length > 1 || row[0] !== "" || touched) rows.push(row)
    row = []
    touched = false
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
      continue
    }
    if (c === '"' && field === "") {
      quoted = true
      touched = true
    } else if (c === ",") {
      touched = true
      endField()
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++
      endRow()
    } else field += c
  }
  if (quoted) return null
  if (field !== "" || row.length > 0 || touched) endRow()
  return rows
}

type Layout = { columns: Array<string>; records: Array<Array<string>> }

function readTable(
  text: string,
  known: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
  problems: Array<CsvProblem>,
): Layout | null {
  if (bytes(text) > MAX_CSV_BYTES) {
    problems.push({ row: null, text: "The file is over the 8 MB limit." })
    return null
  }
  const parsed = parseCsv(text)
  if (parsed === null) {
    problems.push({ row: null, text: "The file ends inside a quoted value." })
    return null
  }
  const [head, ...records] = parsed
  if (!head) {
    problems.push({ row: null, text: "The file is empty. The first row names the columns." })
    return null
  }
  const columns = head.map((h) => h.trim().toLowerCase())
  for (const column of columns)
    if (!known.includes(column))
      problems.push({
        row: null,
        text: `Unknown column “${column.slice(0, 64)}”. This file takes: ${known.join(", ")}.`,
      })
  for (const column of required)
    if (!columns.includes(column))
      problems.push({ row: null, text: `The file needs a column called ${column}.` })
  if (problems.length > 0) return null
  if (records.length > MAX_ROWS) {
    problems.push({
      row: null,
      text: `The file has more than ${MAX_ROWS.toLocaleString("en-GB")} rows.`,
    })
    return null
  }
  records.forEach((r, i) => {
    if (r.length !== columns.length)
      problems.push({
        row: i + 1,
        text: `has ${r.length} values, and the header names ${columns.length} columns.`,
      })
  })
  return { columns, records }
}

const value = (layout: Layout, record: Array<string>, name: string) => {
  const at = layout.columns.indexOf(name)
  return at < 0 ? undefined : record[at]
}

const badText = (s: string) => bytes(s) > MAX_TEXT_BYTES || s.includes("\0")

/** The reading of a file of cases to add to `suite`: columns `input`, and optionally `expected`, `id` and `criteria`. */
export function readCases(text: string, suite: Pick<SuiteOut, "cases" | "criteria">): CsvReading {
  const problems: Array<CsvProblem> = []
  const found = readTable(text, ["id", "input", "expected", "criteria"], ["input"], problems)
  if (!found) return { rows: 0, columns: [], problems }
  const taken = new Set(suite.cases.map((c) => c.id))
  found.records.forEach((record, i) => {
    const row = i + 1
    if (record.length !== found.columns.length) return
    const id = (value(found, record, "id") ?? "").trim()
    if (id !== "") {
      if (!ID.test(id))
        problems.push({
          row,
          text: "has an id that is not letters, digits, _ or -, up to 128 long.",
        })
      else if (taken.has(id))
        problems.push({
          row,
          text: `uses the id “${id}”, which is already a case of this suite or of this file.`,
        })
      else taken.add(id)
    }
    for (const [name, words] of [
      ["input", "an input"],
      ["expected", "an expected output"],
    ] as const)
      if (badText(value(found, record, name) ?? ""))
        problems.push({ row, text: `has ${words} over 64 KB, or with a null character.` })
    for (const criterion of (value(found, record, "criteria") ?? "")
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean))
      if (!suite.criteria.includes(criterion))
        problems.push({
          row,
          text: `names “${criterion.slice(0, 64)}”, which this suite does not measure.`,
        })
  })
  if (suite.cases.length + found.records.length > MAX_ROWS)
    problems.push({
      row: null,
      text: `A suite holds at most ${MAX_ROWS.toLocaleString("en-GB")} cases.`,
    })
  return { rows: found.records.length, columns: found.columns, problems }
}

/** What reading a file of outputs found, and which of the suite's cases it leaves without one. */
export type ResultsReading = CsvReading & { without: number }

/** The reading of a file of outputs to grade for `suite`: columns `case` and `output`. */
export function readResults(text: string, suite: Pick<SuiteOut, "cases">): ResultsReading {
  const problems: Array<CsvProblem> = []
  const found = readTable(text, ["case", "output"], ["case", "output"], problems)
  if (!found) return { rows: 0, columns: [], problems, without: 0 }
  const known = new Set(suite.cases.map((c) => c.id))
  const seen = new Set<string>()
  found.records.forEach((record, i) => {
    const row = i + 1
    if (record.length !== found.columns.length) return
    const id = (value(found, record, "case") ?? "").trim()
    if (!ID.test(id))
      problems.push({ row, text: "has a case that is not an id (letters, digits, _ or -)." })
    else if (seen.has(id)) problems.push({ row, text: `lists the case “${id}” twice.` })
    else if (!known.has(id))
      problems.push({ row, text: `names “${id}”, which is not a case of this suite.` })
    seen.add(id)
    if (badText(value(found, record, "output") ?? ""))
      problems.push({ row, text: "has an output over 64 KB, or with a null character." })
  })
  return {
    rows: found.records.length,
    columns: found.columns,
    problems,
    // The API grades a case with no output as errored, which counts as not passed.
    without: suite.cases.filter((c) => !seen.has(c.id)).length,
  }
}

/** A problem as a line: "Row 7 has …", or the file's own. */
export const problemText = (p: CsvProblem) => (p.row === null ? p.text : `Row ${p.row} ${p.text}`)
