import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { FormDialog, SelectField, TextArea, TextField, useFieldProblem } from "./form-dialog"
import { Quiet } from "./page"
import { FIELD, Labelled } from "./task-move"
import { Button } from "./ui/button"
import { Dialog } from "./ui/dialog"
import { ApiError, api } from "@/lib/api/client"
import type { EvalRunOut, SuiteOut } from "@/lib/api/evals"
import type { CriterionOut, ProjectScope } from "@/lib/api/schemas"
import { MAX_CSV_BYTES, problemText, readCases, readResults, readText } from "@/lib/eval-csv"
import type { CsvReading, ResultsReading } from "@/lib/eval-csv"
import { commitRun, commitSuite } from "@/lib/proof-cache"
import type { Problem } from "@/lib/records"
import { at } from "@/lib/records"
import {
  GRADER_KINDS,
  MAX_GRADERS,
  blankGrader,
  suiteBody,
  suiteFields,
  suiteProblem,
} from "@/lib/suite"
import type { GraderFields, GraderKind, SuiteFields } from "@/lib/suite"
import { reason } from "@/lib/task-move"
import { formatBytes } from "@/lib/documents"

// The two forms of the Proof cards (DESIGN.md §3, Proof): a new eval suite, and a CSV for a suite, of cases or of
// results. Both are `FormDialog`: they close only when the API confirms, and a refusal keeps what was typed.

// ── A new suite ────────────────────────────────────────────────────────────

export function NewSuiteDialog({
  scope,
  criteria,
  chosen,
  onCreated,
  onClose,
}: {
  scope: ProjectScope
  criteria: ReadonlyArray<CriterionOut>
  /** The criteria ticked to start with. */
  chosen: Array<string>
  onCreated: (suite: SuiteOut) => void
  onClose: () => void
}) {
  const client = useQueryClient()
  const [fields, setFields] = useState<SuiteFields>(() => suiteFields(chosen))
  const set = (patch: Partial<SuiteFields>) => setFields((f) => ({ ...f, ...patch }))
  const setGrader = (n: number, patch: Partial<GraderFields>) =>
    set({ graders: fields.graders.map((g, i) => (i === n ? { ...g, ...patch } : g)) })

  async function save(): Promise<Problem | null> {
    try {
      const saved = await api.createSuite(scope, suiteBody(fields))
      await commitSuite(client, scope, saved)
      onCreated(saved)
      return null
    } catch (error) {
      return reason(error, "project")
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <FormDialog
        title="New eval suite"
        description="An eval suite grades cases against the success criteria it measures."
        save="Create suite"
        validate={() => suiteProblem(fields)}
        onSubmit={save}
        onClose={onClose}
      >
        <Quiet>
          A suite is a set of cases and the graders every case goes through. Its pass rate is the
          result of each criterion it measures. Cases come next, from a CSV.
        </Quiet>
        <TextField
          name="name"
          label="Name"
          value={fields.name}
          onChange={(name) => set({ name })}
          autoFocus
          hint="One line, up to 200 characters."
        />
        <CriteriaPick
          criteria={criteria}
          chosen={fields.criteria}
          onChange={(next) => set({ criteria: next })}
        />
        <fieldset className="grid gap-2.5">
          <legend className="text-[11px] text-muted-foreground">Graders</legend>
          {fields.graders.map((g, n) => (
            <GraderEditor
              key={n}
              n={n}
              grader={g}
              onChange={(patch) => setGrader(n, patch)}
              onRemove={
                fields.graders.length > 1
                  ? () => set({ graders: fields.graders.filter((_, i) => i !== n) })
                  : undefined
              }
            />
          ))}
          {fields.graders.length < MAX_GRADERS && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => set({ graders: [...fields.graders, blankGrader()] })}
            >
              Add a grader
            </Button>
          )}
          <Quiet>A case passes when every grader passes it.</Quiet>
        </fieldset>
        <Source fields={fields} onChange={set} />
      </FormDialog>
    </Dialog>
  )
}

function CriteriaPick({
  criteria,
  chosen,
  onChange,
}: {
  criteria: ReadonlyArray<CriterionOut>
  chosen: Array<string>
  onChange: (next: Array<string>) => void
}) {
  const problem = useFieldProblem("criteria")
  return (
    <fieldset
      data-field="criteria"
      tabIndex={-1}
      className="grid gap-1.5 outline-none"
      {...problem}
    >
      <legend className="text-[11px] text-muted-foreground">Criteria it measures</legend>
      {criteria.map((c) => (
        <label key={c.id} className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={chosen.includes(c.id)}
            onChange={(e) =>
              onChange(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))
            }
          />
          <span className="min-w-0 [overflow-wrap:anywhere]">{c.description}</span>
        </label>
      ))}
    </fieldset>
  )
}

function GraderEditor({
  n,
  grader,
  onChange,
  onRemove,
}: {
  n: number
  grader: GraderFields
  onChange: (patch: Partial<GraderFields>) => void
  onRemove?: () => void
}) {
  const field = `grader-${n}`
  const about = GRADER_KINDS.find((k) => k.kind === grader.kind)?.about
  return (
    <div
      role="group"
      aria-label={`Grader ${n + 1}`}
      className="grid gap-2 rounded-xl border bg-raised p-3"
    >
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <SelectField
            label={`Grader ${n + 1}`}
            value={grader.kind}
            onChange={(kind) => onChange({ kind: kind as GraderKind })}
          >
            {GRADER_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </SelectField>
        </div>
        {onRemove && (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      <Quiet>{about}</Quiet>
      {grader.kind === "exact_match" && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={grader.ignoreCase}
            onChange={(e) => onChange({ ignoreCase: e.target.checked })}
          />
          Ignore case
        </label>
      )}
      {grader.kind === "regex" && (
        <TextField
          name={field}
          label="Pattern"
          value={grader.pattern}
          onChange={(pattern) => onChange({ pattern })}
          hint="Rust regular expression syntax, up to 512 bytes."
        />
      )}
      {grader.kind === "json_schema" && (
        <TextArea
          name={field}
          label="Schema (JSON)"
          value={grader.schema}
          onChange={(schema) => onChange({ schema })}
          hint="Supports type, properties, required, items, enum and the usual limits. A keyword outside that is refused."
        />
      )}
      {grader.kind === "script" && (
        <>
          <TextArea
            name={field}
            label="Command"
            value={grader.argv}
            onChange={(argv) => onChange({ argv })}
            hint="One argument per line, the program first. It runs in /workspace as the agent."
          />
          <TextField
            label="Stops after (seconds)"
            value={grader.timeout}
            onChange={(timeout) => onChange({ timeout })}
            inputMode="decimal"
          />
        </>
      )}
      {grader.kind === "judge" && (
        <TextArea
          name={field}
          label="Rubric"
          value={grader.rubric}
          onChange={(rubric) => onChange({ rubric })}
          tall
          hint="What a good output is, in plain words. The model sees the case and the output."
        />
      )}
    </div>
  )
}

/** Where outputs come from: results imported from elsewhere, or a command run in the company's sandbox. */
function Source({
  fields,
  onChange,
}: {
  fields: SuiteFields
  onChange: (patch: Partial<SuiteFields>) => void
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="text-[11px] text-muted-foreground">Where the outputs come from</legend>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="radio"
          name="source"
          className="mt-0.5"
          checked={fields.source === "imported"}
          onChange={() => onChange({ source: "imported" })}
        />
        <span>
          Results I bring. Run your system anywhere, on your machine or in the customer's CI, and
          import a CSV of its outputs.
        </span>
      </label>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="radio"
          name="source"
          className="mt-0.5"
          checked={fields.source === "command"}
          onChange={() => onChange({ source: "command" })}
        />
        <span>A command run in the company's sandbox, on sample data only for now.</span>
      </label>
      {fields.source === "command" && (
        <>
          <TextArea
            name="target"
            label="Target command"
            value={fields.argv}
            onChange={(argv) => onChange({ argv })}
            hint="One argument per line, the program first. It reads EVAL_CASE and EVAL_INPUT; what it prints is the output."
          />
          <TextField
            label="Stops after (seconds)"
            value={fields.timeout}
            onChange={(timeout) => onChange({ timeout })}
            inputMode="decimal"
          />
        </>
      )}
    </fieldset>
  )
}

// ── A CSV for a suite ──────────────────────────────────────────────────────

type Progress = { sent: number; total: number }

/** How many problems a file's reading lists before "and N more". */
const SHOWN = 8

/** Why a send did not finish, in words. */
function failure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401)
      return "Your session has ended. Sign in again, then send the file again."
    if (error.status === 404 && error.message === error.code)
      return "Evals are not available here, or this suite is gone."
    return reason(error, "suite")
  }
  return "The upload did not finish. Check your connection and try again. The file is still chosen."
}

/**
 * A CSV for a suite: cases to add, or outputs to grade. The file is read here first, so a row the API would refuse
 * is named before anything is sent (the API takes all of a file or none of it); then it is sent as it is. The form
 * closes only when the API has answered.
 */
export function ImportDialog({
  scope,
  suite,
  kind,
  onDone,
  onClose,
}: {
  scope: ProjectScope
  suite: SuiteOut
  kind: "cases" | "results"
  /** Said where the FDE is once the API has accepted the file. */
  onDone: (said: string) => void
  onClose: () => void
}) {
  const client = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [reading, setReading] = useState<CsvReading | ResultsReading | null | "busy">(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const sending = useRef<AbortController | null>(null)
  const results = kind === "results"

  // Leaving stops a send in flight; the API may already have it, so what it holds is read again.
  useEffect(
    () => () => {
      sending.current?.abort()
    },
    [],
  )

  async function choose(chosen: File | null) {
    setFile(chosen)
    setReading(null)
    if (!chosen) return
    if (chosen.size > MAX_CSV_BYTES)
      return setReading({
        rows: 0,
        columns: [],
        problems: [{ row: null, text: "The file is over the 8 MB limit." }],
        without: 0,
      })
    setReading("busy")
    try {
      const text = await readText(chosen)
      setReading(results ? readResults(text, suite) : readCases(text, suite))
    } catch {
      setReading({
        rows: 0,
        columns: [],
        problems: [{ row: null, text: "The file could not be read." }],
      })
    }
  }

  function validate(): Problem | null {
    if (!file) return at("file", "Choose a CSV file.")
    if (reading === "busy" || reading === null) return at("file", "The file is still being read.")
    if (reading.rows === 0 && reading.problems.length === 0)
      return at("file", "The file has a header row and nothing under it.")
    return reading.problems.length > 0
      ? at(
          "file",
          "The API takes a whole file or none of it. Fix the rows listed, then choose the file again.",
        )
      : null
  }

  async function save(): Promise<Problem | null> {
    if (!file) return null
    const controller = new AbortController()
    sending.current = controller
    setProgress({ sent: 0, total: file.size })
    const onProgress = (sent: number, total: number) => setProgress({ sent, total })
    try {
      if (results) {
        const run: EvalRunOut = await api.importResults(
          scope,
          suite.id,
          file,
          onProgress,
          controller.signal,
        )
        await commitRun(client, scope, run)
        onDone(
          `Received the outputs for “${suite.name}”. They are being graded; this page follows the run.`,
        )
      } else {
        const saved = await api.importCases(scope, suite.id, file, onProgress, controller.signal)
        await commitSuite(client, scope, saved)
        const added = saved.cases.length - suite.cases.length
        onDone(
          `Added ${added === 1 ? "1 case" : `${added.toLocaleString("en-GB")} cases`} to “${suite.name}”. It now has ${saved.cases.length.toLocaleString("en-GB")}.`,
        )
      }
      return null
    } catch (error) {
      return at("file", failure(error))
    } finally {
      sending.current = null
      setProgress(null)
    }
  }

  const shown = reading && reading !== "busy" ? reading : null
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <FormDialog
        title={results ? "Import results" : "Add cases"}
        description={
          results
            ? `Choose a CSV of outputs to grade for the suite ${suite.name}.`
            : `Choose a CSV of cases to add to the suite ${suite.name}.`
        }
        save={results ? "Grade these results" : "Add cases"}
        validate={validate}
        onSubmit={save}
        onClose={onClose}
      >
        <Quiet>
          {results
            ? "Outputs produced anywhere, graded here by the suite's graders. Columns: case and output. A case with no row is graded as could not be graded, and counts as not passed."
            : "Columns: input (required), and optionally expected, id and criteria (criterion ids separated by ;). Rows without an id get one."}
        </Quiet>
        {results && suite.graders.some((g) => g.kind === "script" || g.kind === "judge") && (
          <Quiet>
            This suite has a script or a judge, so grading uses the company's sandbox, on sample
            data only.
          </Quiet>
        )}
        <CsvField file={file} onChange={(f) => void choose(f)} />
        {reading === "busy" && <Quiet>Reading the file…</Quiet>}
        {shown && <Reading reading={shown} results={results} suite={suite} />}
        {progress && <SendProgress {...progress} />}
      </FormDialog>
    </Dialog>
  )
}

function CsvField({
  file,
  onChange,
}: {
  file: File | null
  onChange: (file: File | null) => void
}) {
  const problem = useFieldProblem("file")
  return (
    <div className="grid gap-1">
      <Labelled label="CSV file">
        <input
          type="file"
          accept=".csv,text/csv"
          data-field="file"
          className={`${FIELD} cursor-pointer file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-selected file:px-2.5 file:py-1 file:text-xs file:text-foreground`}
          onChange={(event) => onChange(event.target.files?.[0] ?? null)}
          {...problem}
        />
      </Labelled>
      <Quiet>
        {file ? `${file.name} · ${formatBytes(file.size)}` : "A .csv file, up to 8 MB."}
      </Quiet>
    </div>
  )
}

/** What reading the file found: what will be sent, and each row the API would refuse, in words. Text only. */
function Reading({
  reading,
  results,
  suite,
}: {
  reading: CsvReading | ResultsReading
  results: boolean
  suite: SuiteOut
}) {
  const { rows, columns, problems } = reading
  const without = "without" in reading ? reading.without : 0
  return (
    <div className="grid gap-1.5 rounded-xl border bg-raised px-3.5 py-2.5" role="status">
      {rows > 0 || problems.length === 0 ? (
        <p className="text-xs">
          Read {rows.toLocaleString("en-GB")} {rows === 1 ? "row" : "rows"}
          {columns.length > 0 ? ` with the columns ${columns.join(", ")}` : ""}.
          {problems.length === 0 && !results && " Nothing is added until the API accepts the file."}
        </p>
      ) : null}
      {problems.length > 0 && (
        <>
          <p className="flex items-start gap-1.5 text-xs">
            <span
              aria-hidden="true"
              className="mt-1.5 size-1.5 flex-none rounded-full bg-attention"
            />
            {problems.length === 1 ? "1 problem" : `${problems.length} problems`} would make the API
            refuse it. Nothing is imported unless every row is accepted.
          </p>
          <ul className="list-disc pl-4 text-[11px] [overflow-wrap:anywhere] text-soft">
            {problems.slice(0, SHOWN).map((p, i) => (
              <li key={i}>{problemText(p)}</li>
            ))}
          </ul>
          {problems.length > SHOWN && (
            <Quiet>
              And {problems.length - SHOWN} more. Rows are counted below the header row.
            </Quiet>
          )}
          {problems.some((p) => p.row !== null) && problems.length <= SHOWN && (
            <Quiet>Rows are counted below the header row.</Quiet>
          )}
        </>
      )}
      {results && problems.length === 0 && without > 0 && (
        <p className="text-[11px] text-soft">
          {without === suite.cases.length
            ? "No case of the suite has a row."
            : `${without.toLocaleString("en-GB")} of the suite's ${suite.cases.length.toLocaleString("en-GB")} cases have no row. They will be graded as could not be graded.`}
        </p>
      )}
    </div>
  )
}

/** A bar for the bytes that have left, and a line for the wait for the API; the numbers are not read out as they change. */
function SendProgress({ sent, total }: Progress) {
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
          ? "Sent. Waiting for the workspace to check it…"
          : `Sending ${formatBytes(sent)} of ${formatBytes(total)}`}
      </p>
      <p role="status" className="sr-only">
        {done ? "Sent. Checking the file." : "Sending the file."}
      </p>
    </div>
  )
}
