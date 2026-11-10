import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, api } from "./client"
import type { SuiteId } from "./evals"
import { CompanyId, ProjectId } from "./schemas"
import { resetMockApi } from "@/dev/mock-api"

// The dev mock answers the eval routes and the room with the API's rules (crates/oryxa-fde-agent/src/evals.rs,
// crates/oryxa-fde-evals, crates/oryxa-fde-store/src/engine.rs), so the screens are tried against what the API says.

const company = CompanyId.parse("cmp_kestrel")
const scope = { company, project: ProjectId.parse("prj_kestrel_dispatch") }
const forecast = {
  company: CompanyId.parse("cmp_lumen"),
  project: ProjectId.parse("prj_lumen_forecast"),
}
const csv = (text: string) => new File([text], "data.csv", { type: "text/csv" })
const none = () => {}

async function code(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ApiError)
  return (error as ApiError).code
}

const SPEED = "suite_k_speed" as SuiteId
const ACCEPT = "suite_k_accept" as SuiteId

describe("the mock's evals", () => {
  beforeEach(() => resetMockApi())
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as Record<string, unknown>).__fdeMockEvalMs
    delete (globalThis as Record<string, unknown>).__fdeMockEvalsOff
  })

  it("lists a project's suites and runs, newest first, and a suite with its cases", async () => {
    const suites = await api.evalSuites(scope)
    expect(suites.map((s) => s.id)).toEqual([SPEED, "suite_k_hours", ACCEPT])
    const runs = await api.evalRuns(scope)
    expect(runs.every((r) => r.state === "finished" && r.report)).toBe(true)
    expect(Date.parse(runs[0]!.created_at)).toBeGreaterThan(Date.parse(runs.at(-1)!.created_at))
    expect((await api.evalRun(scope, runs[0]!.id)).id).toBe(runs[0]!.id)
    expect(await code(api.evalRun(scope, "eval_nope" as never))).toBe("not_found")
  })

  it("keeps errored cases out of the pass rate: a case with no output counts as not passed", async () => {
    // The hours suite's latest run has one case whose target failed.
    const runs = await api.evalRuns(scope)
    const latest = runs.find((r) => r.suite === "suite_k_hours")!
    expect(latest.report).toMatchObject({ passed: 18, failed: 1, errored: 1 })
    expect(latest.report!.criteria).toEqual([
      { criterion: "crt_k2", passed: 18, total: 20, rate: 0.9 },
    ])
    expect(latest.report!.cases.find((c) => c.outcome === "errored")).toMatchObject({
      output: null,
      error: "the target exited with code 1",
      verdicts: [],
    })
  })

  it("says whether each criterion is met, the API's way: the value against the target on the criterion's side", async () => {
    const room = await api.room(scope)
    const by = Object.fromEntries(room.criteria.map((c) => [c.criterion.id, c]))
    expect(by.crt_k1).toMatchObject({ latest: 0.75, passing: true })
    // 0.9 of a target of at least 1.
    expect(by.crt_k2).toMatchObject({ latest: 0.9, passing: false })
    expect(by.crt_k3).toMatchObject({ latest: null, passing: null })
    expect(room.criteria_passing).toBe(1)
    // The stage checklist's "every criterion meets its target" is the same rule.
    const items = (await api.stageChecklist(scope)).items
    expect(items.find((i) => i.key === "criteria_have_evals")?.met).toBe(true)
  })

  it("creates a suite for the project's own criteria only, and takes no other kind of refusal quietly", async () => {
    const good = { name: "Tone", criteria: ["crt_k3"], graders: [{ kind: "exact_match" as const }] }
    const made = await api.createSuite(scope, good)
    expect(made).toMatchObject({ name: "Tone", criteria: ["crt_k3"], target: null, cases: [] })
    expect((await api.evalSuites(scope))[0]!.id).toBe(made.id)
    for (const bad of [
      { ...good, criteria: ["crt_elsewhere"] },
      { ...good, criteria: [] },
      { ...good, name: "  " },
      { ...good, graders: [] },
      { ...good, graders: [{ kind: "regex" as const, pattern: "(" }] },
      { ...good, graders: [{ kind: "judge" as const, rubric: " " }] },
      { ...good, target: { argv: [], timeout_secs: 10 } },
      { ...good, target: { argv: ["x"], timeout_secs: 601 } },
    ])
      expect(await code(api.createSuite(scope, bad))).toBe("invalid_suite")
  })

  it("adds cases from a CSV, all or none, and gives ids to rows without one", async () => {
    const before = (await api.evalSuites(scope)).find((s) => s.id === SPEED)!
    const saved = await api.importCases(
      scope,
      SPEED,
      csv('input,expected\n"Leeds, night",ready in 60s\nGhent,\n'),
      none,
    )
    expect(saved.cases).toHaveLength(before.cases.length + 2)
    expect(saved.cases.at(-2)).toMatchObject({ input: "Leeds, night", expected: "ready in 60s" })
    expect(saved.cases.at(-1)).toMatchObject({ input: "Ghent", expected: null })
    expect(new Set(saved.cases.map((c) => c.id)).size).toBe(saved.cases.length)
    // A row short of a value: the whole file is refused, and nothing of it is added.
    expect(
      await code(api.importCases(scope, SPEED, csv("input,expected\nfine,ok\na\n"), none)),
    ).toBe("invalid_csv")
    expect((await api.evalSuites(scope)).find((s) => s.id === SPEED)!.cases).toHaveLength(
      before.cases.length + 2,
    )
  })

  it("refuses cases with a taken id or a criterion the suite does not measure", async () => {
    expect(await code(api.importCases(scope, SPEED, csv("id,input\nspeed-01,again\n"), none))).toBe(
      "invalid_cases",
    )
    expect(await code(api.importCases(scope, SPEED, csv("input,criteria\na,crt_k1\n"), none))).toBe(
      "invalid_cases",
    )
    expect(await code(api.importCases(scope, SPEED, csv("input,mood\na,b\n"), none))).toBe(
      "invalid_csv",
    )
    expect(
      await code(api.importCases(scope, "suite_nope" as SuiteId, csv("input\na\n"), none)),
    ).toBe("not_found")
  })

  it("starts a run only for a suite with a target and cases, and answers while it is still running", async () => {
    // The accept suite takes imported results: it has no target.
    expect(await code(api.startEvalRun(scope, ACCEPT))).toBe("rejected_no_target")
    const empty = await api.createSuite(scope, {
      name: "Empty",
      criteria: ["crt_k3"],
      graders: [{ kind: "exact_match" }],
      target: { argv: ["node", "x.mjs"], timeout_secs: 10 },
    })
    expect(await code(api.startEvalRun(scope, empty.id))).toBe("rejected_no_cases")
    ;(globalThis as Record<string, unknown>).__fdeMockEvalMs = 60_000
    const run = await api.startEvalRun(scope, SPEED)
    expect(run).toMatchObject({ suite: SPEED, state: "running", imported: false })
    expect(run.report ?? null).toBeNull()
    expect((await api.evalRun(scope, run.id)).state).toBe("running")
  })

  it("finishes a run only when its time has come, then records the report and the criterion's value", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    ;(globalThis as Record<string, unknown>).__fdeMockEvalMs = 5_000
    const run = await api.startEvalRun(scope, SPEED)
    vi.advanceTimersByTime(4_000)
    expect((await api.evalRun(scope, run.id)).state).toBe("running")
    expect(
      (await api.room(scope)).criteria.find((c) => c.criterion.id === "crt_k3")?.latest,
    ).toBeNull()
    vi.advanceTimersByTime(2_000)
    const done = await api.evalRun(scope, run.id)
    expect(done.state).toBe("finished")
    expect(done.report!.cases).toHaveLength(10)
    const rate = done.report!.criteria[0]!
    expect(rate).toMatchObject({ criterion: "crt_k3", total: 10 })
    expect((await api.room(scope)).criteria.find((c) => c.criterion.id === "crt_k3")?.latest).toBe(
      rate.rate,
    )
  })

  it("grades imported results as a run: a case with no row is errored and counts as not passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    ;(globalThis as Record<string, unknown>).__fdeMockEvalMs = 1_000
    const rows = ["case,output", "plan-01,fine", "plan-02,fine"].join("\n")
    const run = await api.importResults(scope, ACCEPT, csv(rows), none)
    expect(run).toMatchObject({ state: "running", imported: true })
    vi.advanceTimersByTime(2_000)
    const done = await api.evalRun(scope, run.id)
    expect(done.report).toMatchObject({ passed: 2, failed: 0, errored: 10 })
    expect(done.report!.criteria).toEqual([
      { criterion: "crt_k1", passed: 2, total: 12, rate: 2 / 12 },
    ])
    const k1 = (await api.room(scope)).criteria.find((c) => c.criterion.id === "crt_k1")!
    expect(k1).toMatchObject({ latest: 2 / 12, passing: false })
  })

  it("takes results for the suite's own cases only, once each", async () => {
    expect(await code(api.importResults(scope, ACCEPT, csv("case,output\nnope,x\n"), none))).toBe(
      "invalid_case",
    )
    expect(
      await code(
        api.importResults(scope, ACCEPT, csv("case,output\nplan-01,a\nplan-01,b\n"), none),
      ),
    ).toBe("invalid_csv")
    expect(await code(api.importResults(scope, ACCEPT, csv("case,out\nplan-01,a\n"), none))).toBe(
      "invalid_csv",
    )
    const bare = await api.createSuite(scope, {
      name: "Bare",
      criteria: ["crt_k3"],
      graders: [{ kind: "exact_match" }],
    })
    expect(await code(api.importResults(scope, bare.id, csv("case,output\n"), none))).toBe(
      "rejected_no_cases",
    )
  })

  it("answers 404 to every eval route where the API serves none, and still answers the room", async () => {
    ;(globalThis as Record<string, unknown>).__fdeMockEvalsOff = true
    expect((await code(api.evalSuites(scope))) satisfies string).toBe("http_404")
    expect(await code(api.evalRuns(scope))).toBe("http_404")
    expect(await code(api.importResults(scope, ACCEPT, csv("case,output\n"), none))).toBe(
      "http_404",
    )
    expect((await api.room(scope)).criteria).toHaveLength(3)
  })

  it("gives a project with no suite no value, and a result through the API's checklist once it is met", async () => {
    const room = await api.room(forecast)
    expect(
      room.criteria.map((c) => [c.criterion.id, c.latest === null ? null : c.passing]),
    ).toEqual([
      ["crt_l1", true],
      ["crt_l2", null],
    ])
    expect((await api.evalSuites(forecast)).every((s) => !s.criteria.includes("crt_l2"))).toBe(true)
  })
})
