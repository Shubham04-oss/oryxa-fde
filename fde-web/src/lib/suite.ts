import type { components } from "./api/evals.gen"
import type { Command, Grader } from "./api/evals"
import type { Problem } from "./records"
import { at } from "./records"

// The new-suite form's fields and what the API checks of a suite (`oryxa_fde_evals::Suite::check`). The API
// answers a refusal with one code, `invalid_suite`, so the page checks each part first and says which.

export type SuiteBody = components["schemas"]["SuiteIn"]

export const MAX_NAME = 200
export const MAX_GRADERS = 8
const MAX_ARGS = 64
const MAX_ARG_BYTES = 4096
const MAX_RUBRIC_BYTES = 8 * 1024
const MAX_PATTERN_BYTES = 512
const MAX_TIMEOUT = 600
const utf8 = new TextEncoder()
const bytes = (s: string) => utf8.encode(s).length

export type GraderKind = Grader["kind"]

export const GRADER_KINDS: ReadonlyArray<{ kind: GraderKind; label: string; about: string }> = [
  {
    kind: "exact_match",
    label: "Exact match",
    about: "The output equals the case's expected output, ignoring whitespace at the ends.",
  },
  { kind: "regex", label: "Regular expression", about: "The output matches a pattern." },
  {
    kind: "json_schema",
    label: "JSON schema",
    about: "The output is JSON that fits a schema (a strict subset of JSON Schema).",
  },
  {
    kind: "script",
    label: "Script in the sandbox",
    about:
      "A command decides: exit code 0 passes. It reads EVAL_CASE, EVAL_INPUT, EVAL_OUTPUT and EVAL_EXPECTED.",
  },
  {
    kind: "judge",
    label: "Model judge",
    about: "A model grades the output against a rubric you write.",
  },
]

export type GraderFields = {
  kind: GraderKind
  ignoreCase: boolean
  pattern: string
  schema: string
  /** One argument per line. */
  argv: string
  timeout: string
  rubric: string
}

export const blankGrader = (kind: GraderKind = "exact_match"): GraderFields => ({
  kind,
  ignoreCase: false,
  pattern: "",
  schema: "",
  argv: "",
  timeout: "30",
  rubric: "",
})

export type SuiteFields = {
  name: string
  criteria: Array<string>
  graders: Array<GraderFields>
  /** Where outputs come from: a command run in the sandbox, or results imported as a CSV. */
  source: "imported" | "command"
  argv: string
  timeout: string
}

export const suiteFields = (criteria: Array<string> = []): SuiteFields => ({
  name: "",
  criteria,
  graders: [blankGrader()],
  source: "imported",
  argv: "",
  timeout: "30",
})

/** The lines of a command, as its arguments: blank lines are not arguments. */
export const argvOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "")

function commandProblem(argv: Array<string>, timeout: string, what: string): string | null {
  if (argv.length === 0) return `${what} needs a command: one argument per line, the program first.`
  if (argv.length > MAX_ARGS) return `${what} takes at most ${MAX_ARGS} arguments.`
  if (argv.some((a) => bytes(a) > MAX_ARG_BYTES || a.includes("\0")))
    return `An argument of ${what.toLowerCase()} is over 4 KB, or has a null character.`
  const n = Number(timeout.trim())
  if (timeout.trim() === "" || !Number.isInteger(n) || n < 1 || n > MAX_TIMEOUT)
    return `${what} needs a time limit of 1 to ${MAX_TIMEOUT} seconds.`
  return null
}

/** The command a source or a script grader runs, as the API takes it. */
const command = (argv: string, timeout: string): Command => ({
  argv: argvOf(argv),
  timeout_secs: Number(timeout.trim()),
})

function graderProblem(g: GraderFields, n: number): Problem | null {
  const field = `grader-${n}`
  const name = `Grader ${n + 1}`
  switch (g.kind) {
    case "exact_match":
      return null
    case "regex":
      if (g.pattern === "" || bytes(g.pattern) > MAX_PATTERN_BYTES)
        return at(field, `${name} needs a pattern of 1 to ${MAX_PATTERN_BYTES} bytes.`)
      return null
    case "json_schema": {
      let parsed: unknown
      try {
        parsed = JSON.parse(g.schema)
      } catch {
        return at(field, `${name}'s schema is not JSON.`)
      }
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? null
        : at(field, `${name}'s schema must be a JSON object.`)
    }
    case "script": {
      const problem = commandProblem(argvOf(g.argv), g.timeout, `${name}'s script`)
      return problem ? at(field, problem) : null
    }
    case "judge":
      return g.rubric.trim() === "" || bytes(g.rubric) > MAX_RUBRIC_BYTES
        ? at(field, `${name} needs a rubric of 1 to 8,192 bytes.`)
        : null
  }
}

/** What is wrong with the form before it is sent, in words, naming the field it is about. */
export function suiteProblem(f: SuiteFields): Problem | null {
  const name = f.name.trim()
  if (name === "" || [...name].length > MAX_NAME || /\p{Cc}/u.test(name))
    return at("name", "A name is one line, 1 to 200 characters.")
  if (f.criteria.length === 0)
    return at("criteria", "Choose at least one criterion for it to measure.")
  if (f.graders.length === 0) return "Add at least one grader."
  if (f.graders.length > MAX_GRADERS) return `A suite has at most ${MAX_GRADERS} graders.`
  for (const [n, g] of f.graders.entries()) {
    const problem = graderProblem(g, n)
    if (problem) return problem
  }
  if (f.source === "command") {
    const problem = commandProblem(argvOf(f.argv), f.timeout, "The target")
    if (problem) return at("target", problem)
  }
  return null
}

function graderOf(g: GraderFields): Grader {
  switch (g.kind) {
    case "exact_match":
      return { kind: "exact_match", ignore_case: g.ignoreCase }
    case "regex":
      return { kind: "regex", pattern: g.pattern }
    case "json_schema":
      return { kind: "json_schema", schema: JSON.parse(g.schema) as Record<string, unknown> }
    case "script":
      return { kind: "script", ...command(g.argv, g.timeout) }
    case "judge":
      return { kind: "judge", rubric: g.rubric }
  }
}

/** The suite as the API takes it; cases come after, from a CSV. Call after `suiteProblem` said there is none. */
export function suiteBody(f: SuiteFields): SuiteBody {
  return {
    name: f.name.trim(),
    criteria: f.criteria,
    graders: f.graders.map(graderOf),
    target: f.source === "command" ? command(f.argv, f.timeout) : null,
  }
}
