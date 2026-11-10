// Eval suites, runs and results for the dev mock (mock-api.ts), typed from evals.gen.ts so they follow the evals spec,
// with the API's rules (crates/oryxa-fde-agent/src/evals.rs, crates/oryxa-fde-evals): a run is `running` until its
// report is recorded; a case's outcome comes from every grader's verdict (errored beats failed beats passed); a
// criterion's value is `passed / total` over the cases that measure it, and a run in which none does leaves the last
// value alone; a CSV of results is graded as a run, and a case with no output errors. Sample data only: every case,
// plan and reason here is invented.

import { parseCsv } from "../lib/eval-csv"
import type { components } from "../lib/api/evals.gen"

type S = components["schemas"]
type Suite = S["SuiteOut"]
type Run = S["EvalRunOut"]
type Case = S["Case"]
type Grader = S["Grader"]
type Verdict = S["Verdict"]
type CaseResult = S["CaseResult"]

export type MockEvals = {
  /** Newest first, as the API lists them. */
  suites: Array<Suite>
  /** Newest first. */
  runs: Array<Run>
  /** Runs the mock is still running: when they finish, and the outputs imported for them (null: the target makes them). */
  waiting: Record<string, { finishAt: number; outputs: Record<string, string> | null }>
  /** The API's `criterion_results`: the latest value of each criterion that has one. */
  results: Record<string, { value: number; at: string; run: string }>
}

export const emptyEvals = (): MockEvals => ({ suites: [], runs: [], waiting: {}, results: {} })

const ago = (days: number, hours = 0) =>
  new Date(Date.now() - (days * 24 + hours) * 3_600_000).toISOString()

/** How long a run the mock starts takes, in ms. `globalThis.__fdeMockEvalMs` sets it (a long one keeps it running). */
export function evalMs(): number {
  const set = (globalThis as Record<string, unknown>).__fdeMockEvalMs
  if (typeof set === "number") return set
  return import.meta.env.MODE === "test" ? 0 : 5_000
}

// ── Grading ────────────────────────────────────────────────────────────────

const passed: Verdict = { verdict: "passed" }

/** One grader's verdict, as simply as the API's rules allow: enough to see passes, failures and errors. */
export function grade(grader: Grader, c: Case, output: string): Verdict {
  switch (grader.kind) {
    case "exact_match": {
      if (c.expected == null)
        return { verdict: "errored", reason: "the case has no expected output" }
      const same = grader.ignore_case
        ? c.expected.trim().toLowerCase() === output.trim().toLowerCase()
        : c.expected.trim() === output.trim()
      return same ? passed : { verdict: "failed", reason: "differs from the expected output" }
    }
    case "regex":
      try {
        return new RegExp(grader.pattern).test(output)
          ? passed
          : { verdict: "failed", reason: "does not match the pattern" }
      } catch {
        return { verdict: "errored", reason: "the pattern does not compile" }
      }
    case "json_schema":
      try {
        const value: unknown = JSON.parse(output)
        const type = (grader.schema as { type?: unknown }).type
        const ok =
          type === "object"
            ? typeof value === "object" && value !== null && !Array.isArray(value)
            : true
        return ok ? passed : { verdict: "failed", reason: `/: expected ${String(type)}` }
      } catch {
        return { verdict: "failed", reason: "the output is not JSON" }
      }
    case "script":
      return /exit 1|FAIL/.test(output)
        ? { verdict: "failed", reason: "the script exited with code 1" }
        : passed
    case "judge":
      return /not acceptable|over the limit|overloaded/i.test(output)
        ? { verdict: "failed", reason: `The plan is not ready to send: ${output.slice(0, 200)}` }
        : { verdict: "passed", score: 0.9 }
  }
}

function resultOf(suite: Suite, c: Case, output: string | null, error?: string): CaseResult {
  if (output === null)
    return {
      case: c.id,
      output: null,
      outcome: "errored",
      verdicts: [],
      error: error ?? "no output",
    }
  const verdicts = suite.graders.map((g) => grade(g, c, output))
  const outcome = verdicts.some((v) => v.verdict === "errored")
    ? "errored"
    : verdicts.every((v) => v.verdict === "passed")
      ? "passed"
      : "failed"
  return { case: c.id, output, outcome, verdicts, error: null }
}

/** The report of a run of `suite` that produced `outputs` (by case; null where nothing was produced). */
export function reportOf(
  suite: Suite,
  outputs: Record<string, string | null>,
  errors: Record<string, string> = {},
): NonNullable<Run["report"]> {
  const cases = suite.cases.map((c) =>
    resultOf(
      suite,
      c,
      outputs[c.id] ?? null,
      errors[c.id] ?? "no output was imported for this case",
    ),
  )
  const criteria = suite.criteria.map((criterion) => {
    const measuring = suite.cases.flatMap((c, i) =>
      (c.criteria?.length ? c.criteria.includes(criterion) : true) ? [cases[i]!] : [],
    )
    const ok = measuring.filter((r) => r.outcome === "passed").length
    return {
      criterion,
      passed: ok,
      total: measuring.length,
      rate: measuring.length === 0 ? 0 : ok / measuring.length,
    }
  })
  return {
    cases,
    criteria,
    passed: cases.filter((r) => r.outcome === "passed").length,
    failed: cases.filter((r) => r.outcome === "failed").length,
    errored: cases.filter((r) => r.outcome === "errored").length,
  }
}

// ── The criterion's value, and finishing runs ──────────────────────────────

/** Records a finished run's rates as the criteria's latest values: only criteria some case measured. */
function record(evals: MockEvals, run: Run) {
  for (const rate of run.report?.criteria ?? [])
    if (rate.total > 0)
      evals.results[rate.criterion] = {
        value: rate.rate,
        at: run.ended_at ?? run.created_at,
        run: run.id,
      }
}

/** Finishes the runs whose time has come. Worked out when something reads, so no timer runs. */
export function settle(evals: MockEvals, now = Date.now()) {
  for (const [id, wait] of Object.entries(evals.waiting)) {
    if (wait.finishAt > now) continue
    delete evals.waiting[id]
    const run = evals.runs.find((r) => r.id === id)
    const suite = run && evals.suites.find((s) => s.id === run.suite)
    if (!run || !suite) continue
    const outputs: Record<string, string | null> = wait.outputs ?? simulate(suite)
    run.report = reportOf(suite, outputs, {})
    run.state = "finished"
    run.ended_at = new Date(wait.finishAt).toISOString()
    record(evals, run)
  }
}

/** What a suite's target would print for each case: the expected output, altered for every fourth case. */
function simulate(suite: Suite): Record<string, string> {
  return Object.fromEntries(
    suite.cases.map((c, i) => [
      c.id,
      i % 4 === 3 ? `${c.expected ?? "plan"} (not acceptable)` : (c.expected ?? "PLAN ok"),
    ]),
  )
}

/** The latest value of a criterion, or undefined before any run measured it. */
export const valueOf = (evals: MockEvals, criterion: string) => evals.results[criterion]

/** Whether some suite measures the criterion. */
export const measured = (evals: MockEvals, criterion: string) =>
  evals.suites.some((s) => s.criteria.includes(criterion))

// ── Seeds ──────────────────────────────────────────────────────────────────

const named = (
  prefix: string,
  rows: Array<[string, string | null]>,
  criteria: Array<string> = [],
): Array<Case> =>
  rows.map(([input, expected], i) => ({
    id: `${prefix}-${String(i + 1).padStart(2, "0")}`,
    input,
    expected,
    criteria,
  }))

let seeded = 0

/** A finished run of the suite whose cases got these outputs (null: the target made none), `days` ago. */
function finished(
  evals: MockEvals,
  suite: Suite,
  days: number,
  outputs: Record<string, string | null>,
  options: { imported: boolean; errors?: Record<string, string> },
): Run {
  const at = ago(days)
  const run: Run = {
    id: `eval_seed${++seeded}`,
    suite: suite.id,
    state: "finished",
    imported: options.imported,
    created_by: "usr_riya",
    created_at: at,
    ended_at: new Date(Date.parse(at) + 90_000).toISOString(),
    report: reportOf(suite, outputs, options.errors),
  }
  evals.runs.unshift(run)
  record(evals, run)
  return run
}

/** Outputs for every case that pass, except the named ones (a case id to its output, null for none). */
const outputsFor = (
  suite: Suite,
  ok: (c: Case) => string,
  except: Record<string, string | null> = {},
) => Object.fromEntries(suite.cases.map((c) => [c.id, c.id in except ? except[c.id]! : ok(c)]))

const add = (evals: MockEvals, s: Suite) => {
  evals.suites.unshift(s)
  return s
}

/** Seeds for the projects that have evals; the rest start with none. */
export function seedEvals(): Record<string, MockEvals> {
  const all: Record<string, MockEvals> = {}

  // Kestrel's dispatch project: one criterion met from imported results, one not met from runs in the sandbox, one
  // with a suite that has not been run.
  const k = emptyEvals()
  const accept = add(k, {
    id: "suite_k_accept",
    name: "Plan acceptance, reviewed by dispatchers",
    criteria: ["crt_k1"],
    target: null,
    graders: [
      {
        kind: "judge",
        rubric:
          "A dispatcher could send this plan without changes: every load has a driver, each assignment has a one-line explanation, and no hours rule is broken.",
      },
    ],
    cases: named(
      "plan",
      [
        "Leeds, Monday",
        "Leeds, Tuesday",
        "Leeds, Wednesday",
        "Leeds, Thursday",
        "Leeds, Friday",
        "Leeds, Saturday",
        "Ghent, Monday",
        "Ghent, Tuesday",
        "Ghent, Wednesday",
        "Ghent, Thursday",
        "Ghent, Friday",
        "Ghent, Saturday",
      ].map((day): [string, null] => [`Orders for ${day}`, null]),
    ),
  })
  const plan = (c: Case) =>
    `Plan for ${c.input.replace("Orders for ", "")}: every load has a driver and a reason.`
  finished(
    k,
    accept,
    21,
    outputsFor(accept, plan, {
      "plan-02": "Plan for Leeds, Tuesday: Load 4 is not acceptable, the driver is over the limit.",
      "plan-04":
        "Plan for Leeds, Thursday: <b>Depot 4</b> is overloaded; two loads have no driver.",
      "plan-06": "Plan for Leeds, Saturday: not acceptable, no explanation lines.",
      "plan-08": "Plan for Ghent, Tuesday: Load 2 is overloaded.",
      "plan-10": "Plan for Ghent, Thursday: not acceptable.",
    }),
    { imported: true },
  )
  finished(
    k,
    accept,
    14,
    outputsFor(accept, plan, {
      "plan-04":
        "Plan for Leeds, Thursday: <b>Depot 4</b> is overloaded; two loads have no driver.",
      "plan-06": "Plan for Leeds, Saturday: not acceptable, no explanation lines.",
      "plan-10": "Plan for Ghent, Thursday: not acceptable.",
      "plan-11": "Plan for Ghent, Friday: Load 1 is over the limit.",
    }),
    { imported: true },
  )
  finished(
    k,
    accept,
    5,
    outputsFor(accept, plan, {
      "plan-04":
        "Plan for Leeds, Thursday: <b>Depot 4</b> is overloaded; two loads have no driver.",
      "plan-06": "Plan for Leeds, Saturday: not acceptable, no explanation lines.",
      "plan-10": "Plan for Ghent, Thursday: not acceptable, **bold** reasons are missing.",
    }),
    { imported: true },
  )

  const hours = add(k, {
    id: "suite_k_hours",
    name: "Driver-hours rules on sampled plans",
    criteria: ["crt_k2"],
    target: { argv: ["node", "eval/plan.mjs"], timeout_secs: 60 },
    graders: [
      { kind: "regex", pattern: "^PLAN " },
      { kind: "script", argv: ["python3", "eval/hours_check.py"], timeout_secs: 20 },
    ],
    cases: named(
      "hours",
      Array.from({ length: 20 }, (_, i): [string, string | null] => [
        `Sampled plan ${i + 1}`,
        null,
      ]),
    ),
  })
  const sampled = (c: Case) => `PLAN ${c.input}: all drivers within 9h.`
  finished(
    k,
    hours,
    8,
    outputsFor(hours, sampled, {
      "hours-03": "PLAN Sampled plan 3: FAIL driver D-07 at 9h 20m",
      "hours-06": "PLAN Sampled plan 6: FAIL driver D-02 at 9h 05m",
      "hours-09": "PLAN Sampled plan 9: FAIL driver D-11 at 9h 40m",
      "hours-13": "PLAN Sampled plan 13: FAIL driver D-07 at 9h 10m",
      "hours-17": "PLAN Sampled plan 17: FAIL driver D-04 at 9h 15m",
    }),
    { imported: false },
  )
  finished(
    k,
    hours,
    3,
    outputsFor(hours, sampled, {
      "hours-07": "PLAN Sampled plan 7: FAIL driver D-07 at 9h 20m",
      "hours-15": null,
    }),
    { imported: false, errors: { "hours-15": "the target exited with code 1" } },
  )

  add(k, {
    id: "suite_k_speed",
    name: "Time to a first draft",
    criteria: ["crt_k3"],
    target: { argv: ["node", "eval/draft.mjs"], timeout_secs: 120 },
    graders: [{ kind: "regex", pattern: "^ready in [0-9]+s$" }],
    cases: named(
      "speed",
      ["Leeds", "Ghent"].flatMap((depot) =>
        ["light", "typical", "heavy", "peak", "holiday"].map((day): [string, string | null] => [
          `${depot}, ${day} day`,
          "ready in 90s",
        ]),
      ),
    ),
  })
  all.prj_kestrel_dispatch = k

  // Lumen's forecast: met, but the result is three weeks old; the second criterion has no suite.
  const l = emptyEvals()
  const error = add(l, {
    id: "suite_l_error",
    name: "Forecast within tolerance, fresh produce",
    criteria: ["crt_l1"],
    target: null,
    graders: [{ kind: "regex", pattern: "^within tolerance" }],
    cases: named(
      "fc",
      Array.from({ length: 25 }, (_, i): [string, string | null] => [
        `Store ${String(i + 1).padStart(2, "0")}, bananas`,
        null,
      ]),
    ),
  })
  finished(
    l,
    error,
    20,
    outputsFor(error, () => "within tolerance (under 10%)", {
      "fc-07": "outside tolerance (17%)",
      "fc-19": "outside tolerance (24%)",
    }),
    { imported: true },
  )
  all.prj_lumen_forecast = l

  // Cobalt's outage summaries (operating): both criteria met, by one suite whose cases split between them.
  const c = emptyEvals()
  const summaries = add(c, {
    id: "suite_c_summaries",
    name: "Morning summary checks",
    criteria: ["crt_c1", "crt_c2"],
    target: null,
    graders: [{ kind: "exact_match" }],
    cases: [
      ...named(
        "ontime",
        ["Mon", "Tue", "Wed", "Thu", "Fri"].map((d): [string, string] => [
          `Summary ready by 7am on ${d}`,
          "yes",
        ]),
        ["crt_c1"],
      ),
      ...named(
        "facts",
        ["Mon", "Tue", "Wed", "Thu"].map((d): [string, string] => [
          `Facts match the log on ${d}`,
          "yes",
        ]),
        ["crt_c2"],
      ),
    ],
  })
  finished(
    c,
    summaries,
    3,
    outputsFor(summaries, () => "yes"),
    { imported: true },
  )
  all.prj_cobalt_outage = c

  // Cobalt's field search (deploying): one criterion, met by a run in the sandbox.
  const f = emptyEvals()
  const search = add(f, {
    id: "suite_f_search",
    name: "Right procedure in the top three",
    criteria: ["crt_f1"],
    target: { argv: ["node", "eval/search.mjs"], timeout_secs: 120 },
    graders: [{ kind: "exact_match", ignore_case: true }],
    cases: named(
      "q",
      Array.from({ length: 50 }, (_, i): [string, string] => [
        `Question ${i + 1}`,
        `procedure-${i + 1}`,
      ]),
    ),
  })
  finished(
    f,
    search,
    6,
    outputsFor(search, (x) => x.expected ?? "", {
      "q-12": "procedure-99",
      "q-31": "procedure-98",
      "q-44": "procedure-97",
    }),
    { imported: false },
  )
  all.prj_cobalt_field = f

  return all
}

// ── Routes ─────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => Response.json(structuredClone(body), { status })
const refuse = (status: number, error: string) => Response.json({ error }, { status })

const ID = /^[A-Za-z0-9_-]{1,128}$/
let created = 0
const utf8 = new TextEncoder()
const bytes = (s: string) => utf8.encode(s).length

function checkSuite(body: unknown, criteria: ReadonlyArray<string>): Suite | null {
  const b = body as Partial<S["SuiteIn"]> | null
  if (!b || typeof b.name !== "string") return null
  const name = b.name.trim()
  if (name === "" || [...name].length > 200 || /\p{Cc}/u.test(name)) return null
  if (
    !Array.isArray(b.criteria) ||
    b.criteria.length === 0 ||
    b.criteria.some((c) => !criteria.includes(c))
  )
    return null
  if (!Array.isArray(b.graders) || b.graders.length === 0 || b.graders.length > 8) return null
  const command = (c: S["Command"]) =>
    c.argv.length >= 1 &&
    c.argv.length <= 64 &&
    c.argv[0] !== "" &&
    c.timeout_secs >= 1 &&
    c.timeout_secs <= 600
  if (b.target && !command(b.target)) return null
  for (const g of b.graders) {
    if (g.kind === "regex") {
      try {
        new RegExp(g.pattern)
      } catch {
        return null
      }
      if (g.pattern === "" || bytes(g.pattern) > 512) return null
    }
    if (g.kind === "script" && !command(g)) return null
    if (g.kind === "judge" && (g.rubric.trim() === "" || bytes(g.rubric) > 8192)) return null
    if (g.kind === "json_schema" && typeof g.schema !== "object") return null
  }
  return {
    id: `suite_new${++created}`,
    name,
    criteria: b.criteria,
    target: b.target ?? null,
    graders: b.graders,
    cases: [],
  }
}

type Ctx = {
  /** The ids of the project's success criteria. */
  criteria: ReadonlyArray<string>
  user: string
}

/** `eval-suites`, `eval-runs` and what hangs off them, for one project. `rest` is the path after the project id. */
export async function evalRoutes(
  evals: MockEvals,
  collection: string,
  rest: ReadonlyArray<string>,
  method: string,
  request: Request,
  ctx: Ctx,
): Promise<Response | null> {
  settle(evals)
  const [id, action] = rest
  if (collection === "eval-suites") {
    if (id === undefined) {
      if (method === "GET") return json(evals.suites)
      if (method !== "POST") return null
      const made = checkSuite(await request.json().catch(() => null), ctx.criteria)
      if (!made) return refuse(400, "invalid_suite")
      evals.suites.unshift(made)
      return json(made, 201)
    }
    const found = evals.suites.find((s) => s.id === id)
    if (action === undefined) {
      if (method !== "GET") return null
      return found ? json(found) : refuse(404, "not_found")
    }
    if (method !== "POST") return null
    if (!found) return refuse(404, "not_found")
    if (action === "runs") {
      if (!found.target) return refuse(409, "rejected_no_target")
      return launch(evals, found, null, ctx.user)
    }
    const text = await request.text()
    if (action === "cases") return addCases(found, text)
    if (action === "results") return importResults(evals, found, text, ctx.user)
    return null
  }
  if (collection === "eval-runs" && method === "GET") {
    if (id === undefined) return json(evals.runs)
    const run = evals.runs.find((r) => r.id === id)
    return run ? json(run) : refuse(404, "not_found")
  }
  return null
}

function launch(
  evals: MockEvals,
  target: Suite,
  outputs: Record<string, string> | null,
  user: string,
) {
  if (target.cases.length === 0) return refuse(409, "rejected_no_cases")
  const run: Run = {
    id: `eval_new${++created}`,
    suite: target.id,
    state: "running",
    imported: outputs !== null,
    created_by: user,
    created_at: new Date().toISOString(),
    ended_at: null,
    report: null,
  }
  evals.runs.unshift(run)
  evals.waiting[run.id] = { finishAt: Date.now() + evalMs(), outputs }
  // A run that takes no time is finished when it is first read; the answer to the start is still `running`.
  return json(run, 202)
}

/** A CSV of rows by column name, or the API's refusal: a whole file is taken or none of it. */
function table(
  text: string,
  known: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
): { rows: Array<Record<string, string>> } | { refusal: Response } {
  const bad = { refusal: refuse(400, "invalid_csv") }
  if (bytes(text) > 8 * 1024 * 1024) return bad
  const parsed = parseCsv(text)
  const head = parsed?.[0]
  if (!parsed || !head) return bad
  const columns = head.map((h) => h.trim().toLowerCase())
  if (columns.some((c) => !known.includes(c)) || required.some((c) => !columns.includes(c)))
    return bad
  const records = parsed.slice(1)
  if (records.length > 10_000 || records.some((r) => r.length !== columns.length)) return bad
  return { rows: records.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]!]))) }
}

function addCases(suite: Suite, text: string) {
  const read = table(text, ["id", "input", "expected", "criteria"], ["input"])
  if ("refusal" in read) return read.refusal
  const added: Array<Case> = []
  for (const row of read.rows) {
    const id = (row.id ?? "").trim() || `case_new${++created}`
    const criteria = (row.criteria ?? "")
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean)
    if (!ID.test(id) || criteria.some((c) => !ID.test(c))) return refuse(400, "invalid_csv")
    added.push({
      id,
      input: row.input ?? "",
      expected: row.expected ? row.expected : null,
      criteria,
    })
  }
  const all = [...suite.cases, ...added]
  if (
    all.length > 10_000 ||
    new Set(all.map((c) => c.id)).size !== all.length ||
    added.some((c) => (c.criteria ?? []).some((k) => !suite.criteria.includes(k)))
  )
    return refuse(400, "invalid_cases")
  suite.cases = all
  return json(suite)
}

function importResults(evals: MockEvals, suite: Suite, text: string, user: string) {
  const read = table(text, ["case", "output"], ["case", "output"])
  if ("refusal" in read) return read.refusal
  const outputs: Record<string, string> = {}
  const known = new Set(suite.cases.map((c) => c.id))
  for (const row of read.rows) {
    const id = (row.case ?? "").trim()
    if (!ID.test(id) || id in outputs) return refuse(400, "invalid_csv")
    if (!known.has(id)) return refuse(400, "invalid_case")
    outputs[id] = row.output ?? ""
  }
  return launch(evals, suite, outputs, user)
}
