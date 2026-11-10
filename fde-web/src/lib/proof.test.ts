import { describe, expect, it } from "vitest"
import type { EvalRunOut, RoomCriterion, SuiteOut } from "./api/evals"
import type { CriterionOut } from "./api/schemas"
import {
  STALE_DAYS,
  TREND_POINTS,
  counts,
  countsText,
  freshness,
  graderDetail,
  graderName,
  proofs,
  runnable,
  scaleNote,
  splitCases,
  targetText,
  trendText,
  valueText,
  verdictText,
} from "./proof"

const NOW = new Date("2026-11-10T12:00:00Z")
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

const criterion = (id: string, over: Partial<CriterionOut> = {}): CriterionOut =>
  ({
    id,
    description: `Criterion ${id}`,
    metric: "pass rate",
    comparator: "at_least",
    target: 0.7,
    unit: null,
    updated_at: days(60),
    ...over,
  }) as CriterionOut

const suite = (id: string, criteria: Array<string>, over: Partial<SuiteOut> = {}): SuiteOut =>
  ({
    id,
    name: `Suite ${id}`,
    criteria,
    target: null,
    graders: [{ kind: "exact_match" }],
    cases: [],
    ...over,
  }) as SuiteOut

const run = (
  id: string,
  suiteId: string,
  ago: number,
  rates: Array<[string, number, number]>,
  over: Partial<EvalRunOut> = {},
): EvalRunOut =>
  ({
    id,
    suite: suiteId,
    state: "finished",
    imported: true,
    created_by: "usr_1",
    created_at: days(ago),
    ended_at: days(ago),
    report: {
      cases: [],
      criteria: rates.map(([key, passed, total]) => ({
        criterion: key,
        passed,
        total,
        rate: total === 0 ? 0 : passed / total,
      })),
      passed: 0,
      failed: 0,
      errored: 0,
    },
    ...over,
  }) as EvalRunOut

const verdict = (
  c: CriterionOut,
  latest: number | null,
  passing: boolean | null,
  at = 1,
): RoomCriterion => ({
  criterion: c,
  latest,
  passing,
  measured_at: latest === null ? null : days(at),
})

describe("the states of a criterion", () => {
  const k = criterion("crt_a")

  it("is met only when the API says so, whatever the number looks like", () => {
    const s = suite("s1", ["crt_a"])
    const r = run("e1", "s1", 1, [["crt_a", 8, 10]])
    // 0.8 is above 0.7, but the verdict is the API's: false says not met.
    expect(proofs([k], [verdict(k, 0.8, false)], [s], [r], NOW)[0]!.status).toBe("not_met")
    expect(proofs([k], [verdict(k, 0.8, true)], [s], [r], NOW)[0]!.status).toBe("met")
  })

  it("has no result yet when a suite measures it and nothing has finished", () => {
    const [p] = proofs([k], [verdict(k, null, null)], [suite("s1", ["crt_a"])], [], NOW)
    expect(p!.status).toBe("no_result")
    expect(p!.value).toBeNull()
    expect(p!.suites.map((s) => s.id)).toEqual(["s1"])
  })

  it("has no suite when nothing measures it", () => {
    const [p] = proofs([k], [verdict(k, null, null)], [suite("s1", ["crt_other"])], [], NOW)
    expect(p!.status).toBe("no_suite")
  })

  it("is not read yet while the API's verdict has not come", () => {
    expect(proofs([k], undefined, [], [], NOW)[0]!.status).toBe("unknown")
  })

  it("names a running run of a suite that measures it, and keeps the last finished value", () => {
    const s = suite("s1", ["crt_a"])
    const going = run("e2", "s1", 0, [], { state: "running", report: null, ended_at: null })
    const [p] = proofs(
      [k],
      [verdict(k, 0.8, true)],
      [s],
      [going, run("e1", "s1", 3, [["crt_a", 8, 10]])],
      NOW,
    )
    expect(p!.running?.id).toBe("e2")
    expect(p!.status).toBe("met")
  })
})

describe("where a result came from and how it moved", () => {
  const k = criterion("crt_a")
  const s = suite("s1", ["crt_a"])
  const runs = [
    run("e3", "s1", 1, [["crt_a", 9, 12]]),
    run("e2", "s1", 7, [["crt_a", 8, 12]]),
    run("e1", "s1", 14, [["crt_a", 7, 12]]),
  ]

  it("takes the run that ended when the value was measured, at the API's value, as the source", () => {
    const [p] = proofs([k], [verdict(k, 0.75, true)], [s], runs, NOW)
    expect(p!.source).toMatchObject({ run: "e3", passed: 9, total: 12, imported: true })
    expect(p!.trend.map((t) => t.run)).toEqual(["e1", "e2", "e3"])
  })

  it("does not claim a source the API's value does not match", () => {
    const [p] = proofs([k], [verdict(k, 0.5, false)], [s], runs, NOW)
    expect(p!.source).toBeNull()
  })

  it("tells two runs with the same rate apart by when the value was measured", () => {
    const same = [run("e5", "s1", 2, [["crt_a", 6, 8]]), ...runs]
    // 6 of 8 and 9 of 12 are both 0.75; the API measured it when e3 ended, not e5.
    const [p] = proofs([k], [verdict(k, 0.75, true, 1)], [s], same, NOW)
    expect(p!.source).toMatchObject({ run: "e3", passed: 9, total: 12 })
    const [q] = proofs([k], [verdict(k, 0.75, true, 2)], [s], same, NOW)
    expect(q!.source).toMatchObject({ run: "e5", passed: 6, total: 8 })
  })

  it("claims no source when no run ended when the value was measured, even at the same rate", () => {
    // The runs list is older than the verdict: a newer run measured 0.75 too.
    const [p] = proofs([k], [verdict(k, 0.75, true, 0)], [s], runs, NOW)
    expect(p!.source).toBeNull()
  })

  it("leaves out a run in which no case measured the criterion: the API keeps the last value", () => {
    const [p] = proofs(
      [k],
      [verdict(k, 0.75, true)],
      [s],
      [run("e4", "s1", 0, [["crt_a", 0, 0]]), ...runs],
      NOW,
    )
    expect(p!.trend.map((t) => t.run)).toEqual(["e1", "e2", "e3"])
    expect(p!.source?.run).toBe("e3")
  })

  it("shows only the most recent few results, oldest first", () => {
    const many = Array.from({ length: TREND_POINTS + 4 }, (_, i) =>
      run(`e${i}`, "s1", i + 1, [["crt_a", 6, 12]]),
    )
    const [p] = proofs([k], [verdict(k, 0.5, false)], [s], many, NOW)
    expect(p!.trend).toHaveLength(TREND_POINTS)
    expect(p!.trend[0]!.run).toBe(`e${TREND_POINTS - 1}`)
    expect(p!.trend.at(-1)!.run).toBe("e0")
  })

  it("keeps the runs of other suites out of the trend", () => {
    const other = run("x1", "s9", 1, [["crt_a", 1, 12]])
    const [p] = proofs([k], [verdict(k, 0.75, true)], [s], [other, ...runs], NOW)
    expect(p!.trend.map((t) => t.run)).not.toContain("x1")
  })

  it("says every value in text", () => {
    const [p] = proofs([k], [verdict(k, 0.75, true)], [s], runs, NOW)
    expect(trendText(p!.trend)).toBe(
      "Recent results, oldest first: 0.58 (7 of 12), 0.67 (8 of 12), 0.75 (9 of 12).",
    )
    expect(trendText([])).toBe("No earlier results.")
  })
})

describe("how fresh a result is", () => {
  const s = suite("s1", ["crt_a"])
  const r = (ago: number) => run("e1", "s1", ago, [["crt_a", 9, 10]])

  it("is out of date once it is old, and says how old", () => {
    const k = criterion("crt_a")
    expect(
      proofs([k], [verdict(k, 0.9, true, STALE_DAYS - 1)], [s], [r(1)], NOW)[0]!.stale,
    ).toBeNull()
    expect(proofs([k], [verdict(k, 0.9, true, STALE_DAYS)], [s], [r(1)], NOW)[0]!.stale).toBe(
      `This result is ${STALE_DAYS} days old.`,
    )
  })

  it("is out of date when the criterion changed after it was measured", () => {
    const k = criterion("crt_a", { updated_at: days(2) })
    expect(proofs([k], [verdict(k, 0.9, true, 5)], [s], [r(5)], NOW)[0]!.stale).toBe(
      "The criterion was changed after this was measured.",
    )
  })

  it("says nothing of a criterion with no result", () => {
    const k = criterion("crt_a", { updated_at: days(2) })
    expect(proofs([k], [verdict(k, null, null)], [s], [], NOW)[0]!.stale).toBeNull()
  })

  it("is worded by day, from the API's timestamp", () => {
    expect(freshness(days(0), NOW)).toBe("Measured today")
    expect(freshness(days(1), NOW)).toMatch(/^Measured \d+ \w+ 2026, yesterday$/)
    expect(freshness(days(6), NOW)).toMatch(/, 6 days ago$/)
  })
})

describe("a target a pass rate cannot reach", () => {
  // ponytail: until the API compares in the criterion's own unit (#193).
  it("is called out, without asking for the target to be rewritten", () => {
    expect(scaleNote({ comparator: "at_least", target: 70 })).toBe(
      "An eval result is the share of cases that passed, from 0 to 1, and for now it is compared with 70 as written, so no eval result can meet this target.",
    )
    expect(scaleNote({ comparator: "at_most", target: -1 })).toMatch(/so no eval result can meet/)
    expect(scaleNote({ comparator: "at_least", target: 1 })).toBeNull()
    expect(scaleNote({ comparator: "at_least", target: 0.7 })).toBeNull()
    expect(scaleNote({ comparator: "at_most", target: 0.2 })).toBeNull()
  })

  it("says so when every pass rate meets the target, so a Met there is not read as proof", () => {
    // "At most 2 min": a share from 0 to 1 is always at most 2.
    expect(scaleNote({ comparator: "at_most", target: 2 })).toBe(
      "An eval result is the share of cases that passed, from 0 to 1, and for now it is compared with 2 as written, so every eval result meets this target, whatever it is.",
    )
    expect(scaleNote({ comparator: "at_least", target: 0 })).toMatch(/every eval result meets/)
  })

  it("shows on a criterion that has a result or a suite, not on one nothing measures", () => {
    const k = criterion("crt_a", { target: 70, unit: "%" })
    const s = suite("s1", ["crt_a"])
    expect(proofs([k], [verdict(k, 0.9, false)], [s], [], NOW)[0]!.scale).toMatch(
      /no eval result can meet this target/,
    )
    expect(proofs([k], [verdict(k, null, null)], [], [], NOW)[0]!.scale).toBeNull()
  })
})

describe("words", () => {
  it("writes numbers and targets as the API holds them", () => {
    expect(valueText(0.74)).toBe("0.74")
    expect(valueText(1)).toBe("1")
    expect(valueText(0.6667)).toBe("0.67")
    expect(targetText({ comparator: "at_least", target: 0.7, unit: null })).toBe("at least 0.7")
    expect(targetText({ comparator: "at_most", target: 2, unit: "min" })).toBe("at most 2 min")
    expect(targetText({ comparator: "at_least", target: 90, unit: "%" })).toBe("at least 90%")
  })

  it("names the five graders and says what each checks, as text", () => {
    expect(graderName({ kind: "exact_match", ignore_case: true })).toBe(
      "Exact match, ignoring case",
    )
    expect(graderName({ kind: "regex", pattern: "^a" })).toBe("Regular expression")
    expect(graderName({ kind: "json_schema", schema: {} })).toBe("JSON schema")
    expect(graderName({ kind: "script", argv: ["a"], timeout_secs: 5 })).toBe(
      "Script in the sandbox",
    )
    expect(graderName({ kind: "judge", rubric: "r" })).toBe("Model judge")
    expect(graderDetail({ kind: "regex", pattern: "<b>^a</b>" })).toBe("<b>^a</b>")
    expect(graderDetail({ kind: "script", argv: ["python3", "g.py"], timeout_secs: 10 })).toBe(
      "python3 g.py (stops after 10s; exit code 0 passes)",
    )
    expect(graderDetail({ kind: "json_schema", schema: { type: "object" } })).toBe(
      '{"type":"object"}',
    )
  })

  it("says what a verdict says, with the grader's reason", () => {
    expect(verdictText({ verdict: "passed" })).toBe("Passed")
    expect(verdictText({ verdict: "passed", score: 0.9 })).toBe("Passed, score 0.9")
    expect(verdictText({ verdict: "failed", reason: "differs" })).toBe("Failed: differs")
    expect(verdictText({ verdict: "errored", reason: "no model" })).toBe(
      "Could not decide: no model",
    )
  })

  it("counts a run's cases as the API reports them", () => {
    const r = run("e1", "s1", 1, [], {
      report: { cases: [], criteria: [], passed: 31, failed: 8, errored: 3 },
    })
    expect(counts(r)).toEqual({ passed: 31, failed: 8, errored: 3, cases: 0 })
    expect(countsText(counts(r)!)).toBe("31 passed, 8 failed, 3 could not be graded")
    expect(counts({ report: null })).toBeNull()
  })

  it("lists the cases that did not pass before those that did", () => {
    const r = run("e1", "s1", 1, [])
    r.report!.cases = [
      { case: "a", outcome: "passed", verdicts: [] },
      { case: "b", outcome: "failed", verdicts: [] },
      { case: "c", outcome: "errored", verdicts: [] },
    ]
    const { notPassed, passed } = splitCases(r.report!)
    expect(notPassed.map((c) => c.case)).toEqual(["b", "c"])
    expect(passed.map((c) => c.case)).toEqual(["a"])
  })

  it("can run a suite only with a target and some cases", () => {
    const c = { id: "a", input: "i" }
    expect(runnable({ target: null, cases: [c] })).toMatch(/no target command/)
    expect(runnable({ target: { argv: ["x"], timeout_secs: 5 }, cases: [] })).toMatch(/no cases/)
    expect(runnable({ target: { argv: ["x"], timeout_secs: 5 }, cases: [c] })).toBeNull()
  })
})
