import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ProjectPage } from "./project-page"
import { api } from "@/lib/api/client"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import type { Stage } from "@/lib/api/schemas"
import { resetMockApi } from "@/dev/mock-api"
import { renderWithRouter } from "@/test/render"
import { installWire, resetWire, wire } from "@/test/wire"

beforeAll(installWire)
afterEach(() => {
  resetWire()
  delete (globalThis as Record<string, unknown>).__fdeMockEvalMs
  delete (globalThis as Record<string, unknown>).__fdeMockEvalsOff
})

const scopeOf = (company: string, project: string) => ({
  company: CompanyId.parse(company),
  project: ProjectId.parse(project),
})
/** Three criteria: met (imported results), not met (runs in the sandbox, one case errored), no result yet. */
const DISPATCH = scopeOf("cmp_kestrel", "prj_kestrel_dispatch")
/** Met but three weeks old; the other criterion has no suite. */
const FORECAST = scopeOf("cmp_lumen", "prj_lumen_forecast")
/** Criteria, and no suite at all. */
const FNOL = scopeOf("cmp_atlas", "prj_atlas_fnol")
/** No criteria. */
const CLAIMS = scopeOf("cmp_kestrel", "prj_kestrel_claims")

const proofCard = () => screen.findByRole("region", { name: "Proof" })
const suites = () => screen.findByRole("region", { name: "Eval suites" })
const criterion = async (text: string) => {
  const card = await proofCard()
  // Wait for the rows: the card reads the suites, the runs and the room first.
  const row = (await within(card).findByText(text)).closest("li")
  if (!row) throw new Error(`no row for ${text}`)
  return row
}
const csv = (text: string, name = "data.csv") => new File([text], name, { type: "text/csv" })
const dialog = (name: string) => screen.findByRole("dialog", { name })
const set = (key: string, value: unknown) => ((globalThis as Record<string, unknown>)[key] = value)

describe("proof for each criterion", () => {
  beforeEach(() => resetMockApi())

  it("says met, with the number against the target, how fresh it is, and where it came from", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const row = await criterion("Plans dispatchers accept with no changes")

    expect(within(row).getByText("Met")).toBeInTheDocument()
    expect(row).toHaveTextContent("0.75 against at least 0.7")
    expect(row).toHaveTextContent("9 of 12 cases passed")
    expect(row).toHaveTextContent(
      "from “Plan acceptance, reviewed by dispatchers”, results imported",
    )
    expect(row).toHaveTextContent(/Measured \d+ \w+ 2026, 5 days ago/)
    // The trend is a few marks, and its values are text.
    expect(row).toHaveTextContent(
      "Recent results, oldest first: 0.58 (7 of 12), 0.67 (8 of 12), 0.75 (9 of 12).",
    )
  })

  it("names the tasks that work towards a criterion, each with its status", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const accepted = await criterion("Plans dispatchers accept with no changes")
    expect(accepted).toHaveTextContent(
      "Tasks towards it: “Replay last month's orders through the planner” (to do), “Run the first planner replay on sample orders” (done).",
    )
    // A criterion no task works towards says nothing about tasks.
    expect(await criterion("Time to a draft plan")).not.toHaveTextContent(/towards it/)
  })

  it("says not met, in words and a dot, when the API's verdict is no", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const row = await criterion("Plans that keep every driver-hours rule")

    expect(within(row).getByText("Not met")).toBeInTheDocument()
    expect(row).toHaveTextContent("0.9 against at least 1")
    expect(row).toHaveTextContent("18 of 20 cases passed")
    expect(row).toHaveTextContent("run in the sandbox")
    // Failing is amber, and not red.
    expect(row.innerHTML).toMatch(/bg-attention/)
    expect(row.innerHTML).not.toMatch(/destructive/)
  })

  it("says plainly that a criterion has no result yet, and what to do", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const row = await criterion("Time to a draft plan")

    expect(within(row).getByText("No result yet")).toBeInTheDocument()
    expect(row).toHaveTextContent("“Time to a first draft” has 10 cases and has not been run.")
    expect(row).toHaveTextContent("Run it, or import results from elsewhere.")
    // At most 2 min, measured by a share from 0 to 1: a Met there would prove nothing, and the row says so (#193).
    expect(row).toHaveTextContent("so every eval result meets this target, whatever it is.")
    expect(
      within(row).getByRole("button", { name: "Run Time to a first draft" }),
    ).toBeInTheDocument()
  })

  it("counts what the API counts in the heading", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const card = await proofCard()
    expect(await within(card).findByText("1 of 3 met")).toBeInTheDocument()
  })

  it("calls out a result that is old, and a criterion nothing measures", async () => {
    renderWithRouter(<ProjectPage scope={FORECAST} />)
    const old = await criterion("Forecasts a buyer can rely on")
    expect(within(old).getByText("Met")).toBeInTheDocument()
    expect(old).toHaveTextContent("Out of date. This result is 20 days old.")

    const none = await criterion("Buyers who find the reasons useful")
    expect(within(none).getByText("No eval suite")).toBeInTheDocument()
    expect(none).toHaveTextContent("Nothing measures this yet.")
    expect(
      within(none).getByRole("button", { name: "New eval suite for this" }),
    ).toBeInTheDocument()
  })

  it("says so for a project where no criterion has a suite", async () => {
    renderWithRouter(<ProjectPage scope={FNOL} />)
    const card = await proofCard()
    await within(card).findAllByText("No eval suite")
    expect(within(card).queryByText("Met")).toBeNull()
    expect(await suites()).toHaveTextContent("No eval suite yet.")
  })

  it("asks for a criterion first when there is none", async () => {
    renderWithRouter(<ProjectPage scope={CLAIMS} />)
    const card = await proofCard()
    expect(card).toHaveTextContent("Add one first")
    expect(within(card).queryByRole("button", { name: "New eval suite" })).toBeNull()
  })

  it("explains a target a pass rate cannot reach, which would otherwise fail without a reason", async () => {
    resetMockApi()
    // A target written as a percentage: the API compares a rate from 0 to 1 with it as written.
    const project = await api.project(FORECAST)
    const l1 = project.scope.criteria.find((c) => c.id === "crt_l1")!
    await api.updateCriterion(
      FORECAST,
      l1.id,
      {
        description: l1.description,
        metric: l1.metric,
        comparator: "at_least",
        target: 85,
        unit: "%",
      },
      l1.version,
    )
    renderWithRouter(<ProjectPage scope={FORECAST} />, { keep: true })
    const row = await criterion("Forecasts a buyer can rely on")
    expect(within(row).getByText("Not met")).toBeInTheDocument()
    expect(row).toHaveTextContent(
      "for now it is compared with 85 as written, so no eval result can meet this target.",
    )
    expect(row).not.toHaveTextContent("Write the target")
  })

  it("says it is not read yet when the API's verdict cannot be read, and offers to try again", async () => {
    wire.refuseReads = {
      ending: "/room/companies/cmp_kestrel/projects/prj_kestrel_dispatch",
      response: Response.json({ error: "unavailable" }, { status: 503 }),
    }
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const card = await proofCard()
    // A 503 is read again twice before it is given up on.
    expect(
      await within(card).findByText(
        "We couldn't read whether the criteria are met.",
        {},
        { timeout: 8_000 },
      ),
    ).toBeInTheDocument()
    expect(within(card).getAllByText("Not read yet")).toHaveLength(3)
    wire.refuseReads = null
    await userEvent.click(within(card).getByRole("button", { name: "Try again" }))
    expect(await within(card).findByText("1 of 3 met")).toBeInTheDocument()
  }, 15_000)
})

describe("where the API serves no evals", () => {
  beforeEach(() => resetMockApi())

  it("says so plainly, with no error, and shows only what the API already holds", async () => {
    set("__fdeMockEvalsOff", true)
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const card = await proofCard()
    expect(
      await within(card).findByText(/Evals are not available in this environment/),
    ).toBeInTheDocument()
    expect(within(card).queryByRole("alert")).toBeNull()
    // The room still says what is met.
    expect(within(card).getByText("Met")).toBeInTheDocument()
    expect(within(card).queryByRole("button", { name: "New eval suite" })).toBeNull()
    expect(screen.queryByRole("region", { name: "Eval suites" })).toBeNull()
  })
})

describe("a run, from start to finish", () => {
  beforeEach(() => resetMockApi())

  it("is shown as running until the API says it has finished, then the criterion takes its result", async () => {
    set("__fdeMockEvalMs", 3_000)
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const row = await criterion("Time to a draft plan")
    await userEvent.click(within(row).getByRole("button", { name: "Run Time to a first draft" }))

    // Accepted, not finished.
    expect(await within(row).findByText(/is being graded/)).toBeInTheDocument()
    expect(wire.sent.map((w) => `${w.method} ${w.path}`)).toContain(
      "POST /companies/cmp_kestrel/projects/prj_kestrel_dispatch/eval-suites/suite_k_speed/runs",
    )
    expect(within(row).getByText("No result yet")).toBeInTheDocument()
    expect(screen.queryByText(/has finished/)).toBeNull()

    // The API finishes it; the page learns on its next read and says so.
    expect(
      await screen.findByText(
        /“Time to a first draft” has finished: \d+ of 10 cases passed\./,
        {},
        { timeout: 8_000 },
      ),
    ).toBeInTheDocument()
    await waitFor(() => expect(within(row).queryByText("No result yet")).toBeNull())
    expect(row).toHaveTextContent(/\d+ of 10 cases passed/)
  }, 15_000)

  it("stops asking when it has finished", async () => {
    set("__fdeMockEvalMs", 0)
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const row = await criterion("Time to a draft plan")
    await userEvent.click(within(row).getByRole("button", { name: "Run Time to a first draft" }))
    await screen.findByText(/has finished/)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const reads = wire.reads.filter((r) => r.includes("/eval-runs/")).length
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(wire.reads.filter((r) => r.includes("/eval-runs/")).length).toBe(reads)
  }, 10_000)

  it("stops asking when the page is left", async () => {
    set("__fdeMockEvalMs", 600_000)
    const view = renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const row = await criterion("Time to a draft plan")
    await userEvent.click(within(row).getByRole("button", { name: "Run Time to a first draft" }))
    await within(row).findByText(/is being graded/)
    view.unmount()
    const reads = wire.reads.filter((r) => r.includes("/eval-runs/")).length
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(wire.reads.filter((r) => r.includes("/eval-runs/")).length).toBe(reads)
  }, 10_000)

  it("says why a run was refused, and runs nothing", async () => {
    wire.refuse = Response.json({ error: "unavailable" }, { status: 503 })
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const row = await criterion("Time to a draft plan")
    await userEvent.click(within(row).getByRole("button", { name: "Run Time to a first draft" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The workspace is briefly unavailable",
    )
    expect(within(row).queryByText(/is being graded/)).toBeNull()
  })
})

describe("the suites, and why a case failed", () => {
  beforeEach(() => resetMockApi())

  it("shows a suite's graders, where its outputs come from, its runs and its latest run's counts", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const card = await suites()
    const item = (await within(card).findByText("Driver-hours rules on sampled plans")).closest(
      "li",
    )!
    expect(item).toHaveTextContent("20 cases")
    expect(item).toHaveTextContent("run in the company's sandbox")
    await userEvent.click(
      within(item).getByRole("button", { name: /Driver-hours rules on sampled plans/ }),
    )

    expect(item).toHaveTextContent("node eval/plan.mjs")
    expect(item).toHaveTextContent("Regular expression")
    expect(item).toHaveTextContent("Script in the sandbox")
    expect(item).toHaveTextContent(
      "python3 eval/hours_check.py (stops after 20s; exit code 0 passes)",
    )
    expect(item).toHaveTextContent("18 passed, 1 failed, 1 could not be graded")
    expect(item).toHaveTextContent(
      "Plans that keep every driver-hours rule: 18 of 20 cases passed (0.9)",
    )
    // Not passed first; the passing cases are behind a button.
    expect(item).toHaveTextContent("2 cases did not pass")
    expect(
      within(item).getByRole("button", { name: "Show the 18 cases that passed" }),
    ).toBeInTheDocument()
  })

  it("shows a failed case with its grader's reason, and renders all of it as text", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const card = await suites()
    const item = (
      await within(card).findByText("Plan acceptance, reviewed by dispatchers")
    ).closest("li")!
    await userEvent.click(
      within(item).getByRole("button", { name: /Plan acceptance, reviewed by dispatchers/ }),
    )
    await userEvent.click(within(item).getByRole("button", { name: /^plan-04/ }))

    // The model's words carry markup and Markdown: shown as the characters they are.
    const reasons = within(item).getAllByText(/<b>Depot 4<\/b>/)
    expect(reasons.length).toBeGreaterThan(0)
    expect(item.querySelector("b")).toBeNull()
    expect(item).toHaveTextContent("Failed: The plan is not ready to send")
    expect(item).toHaveTextContent("Model judge")
    // The input it was given.
    expect(item).toHaveTextContent("Orders for Leeds, Thursday")
  })

  it("names a case that could not be graded, and why there is no output", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const card = await suites()
    const item = (await within(card).findByText("Driver-hours rules on sampled plans")).closest(
      "li",
    )!
    await userEvent.click(
      within(item).getByRole("button", { name: /Driver-hours rules on sampled plans/ }),
    )
    const errored = within(item).getByRole("button", { name: /^hours-15/ })
    expect(errored).toHaveTextContent("Could not be graded")
    await userEvent.click(errored)
    expect(item).toHaveTextContent("Why there is no output")
    expect(item).toHaveTextContent("the target exited with code 1")
  })

  it("folds a long output and opens all of it on request", async () => {
    resetMockApi()
    // An output of a few thousand characters, as a model can give.
    const long = "word ".repeat(1_000)
    set("__fdeMockEvalMs", 0)
    const made = await api.createSuite(DISPATCH, {
      name: "Long outputs",
      criteria: ["crt_k3"],
      graders: [{ kind: "regex", pattern: "word" }],
    })
    const file = csv(`input\n"${"i".repeat(10)}"\n`)
    const withCase = await api.importCases(DISPATCH, made.id, file, () => {})
    const caseId = withCase.cases[0]!.id
    await api.importResults(DISPATCH, made.id, csv(`case,output\n${caseId},"${long}"\n`), () => {})
    renderWithRouter(<ProjectPage scope={DISPATCH} />, { keep: true })
    const card = await suites()
    const item = (await within(card).findByText("Long outputs")).closest("li")!
    await userEvent.click(within(item).getByRole("button", { name: /Long outputs/ }))
    await userEvent.click(
      await within(item).findByRole("button", { name: /Show the 1 case that passed/ }),
    )
    await userEvent.click(within(item).getByRole("button", { name: new RegExp(`^${caseId}`) }))

    const show = within(item).getByRole("button", {
      name: /Show the whole output \(5,000 characters\)/,
    })
    expect(show).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(show)
    expect(within(item).getByRole("button", { name: "Fold the output" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
  })
})

describe("importing results from elsewhere", () => {
  beforeEach(() => resetMockApi())

  async function openImport(kind: "Import results for" | "Add cases to", suite: string) {
    const card = await suites()
    const item = (await within(card).findByText(suite)).closest("li")!
    await userEvent.click(within(item).getByRole("button", { name: new RegExp(`^${suite}`) }))
    await userEvent.click(within(item).getByRole("button", { name: `${kind} ${suite}` }))
    return {
      item,
      box: await dialog(kind === "Import results for" ? "Import results" : "Add cases"),
    }
  }
  const NAME = "Plan acceptance, reviewed by dispatchers"

  it("names every row the API would refuse, sends nothing, and imports nothing", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const { box } = await openImport("Import results for", NAME)
    const rows = ["case,output", "plan-01,fine", "plan-01,again", "plan-99,x", "plan 3,y"].join(
      "\n",
    )
    await userEvent.upload(within(box).getByLabelText("CSV file"), csv(rows, "results.csv"))

    expect(
      await within(box).findByText(/3 problems would make the API refuse it/),
    ).toBeInTheDocument()
    expect(box).toHaveTextContent("Row 2 lists the case “plan-01” twice.")
    expect(box).toHaveTextContent("Row 3 names “plan-99”, which is not a case of this suite.")
    expect(box).toHaveTextContent("Row 4 has a case that is not an id (letters, digits, _ or -).")
    expect(box).toHaveTextContent("Nothing is imported unless every row is accepted.")

    await userEvent.click(within(box).getByRole("button", { name: "Grade these results" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("Fix the rows listed")
    expect(wire.sent.filter((w) => w.path.includes("/results"))).toEqual([])
  })

  it("says what it read, and what it leaves without an output", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const { box } = await openImport("Import results for", NAME)
    const rows = ["case,output", "plan-01,fine", "plan-02,fine"].join("\n")
    await userEvent.upload(within(box).getByLabelText("CSV file"), csv(rows, "results.csv"))
    expect(
      await within(box).findByText(/Read 2 rows with the columns case, output/),
    ).toBeInTheDocument()
    expect(box).toHaveTextContent(
      "10 of the suite's 12 cases have no row. They will be graded as could not be graded.",
    )
    expect(box).toHaveTextContent("grading uses the company's sandbox")
  })

  it("sends the file as text/csv, and shows nothing as imported until the API has accepted it", async () => {
    set("__fdeMockEvalMs", 600_000)
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const { item, box } = await openImport("Import results for", NAME)
    await userEvent.upload(
      within(box).getByLabelText("CSV file"),
      csv(["case,output", "plan-01,fine"].join("\n"), "results.csv"),
    )
    await within(box).findByText(/Read 1 row/)
    wire.hold = new Promise(() => {})
    await userEvent.click(within(box).getByRole("button", { name: "Grade these results" }))
    // On its way: the dialog is open, nothing is in the suite's runs.
    await waitFor(() => expect(wire.sent.length).toBeGreaterThan(0))
    expect(screen.getByRole("dialog", { name: "Import results" })).toBeInTheDocument()
    expect(within(item).queryByText("Running")).toBeNull()
    expect(wire.sent.at(-1)).toMatchObject({
      method: "POST",
      path: "/companies/cmp_kestrel/projects/prj_kestrel_dispatch/eval-suites/suite_k_accept/results",
      body: { contentType: "text/csv", csrf: "1" },
    })
  })

  it("closes once the API accepts it, and the run is running until it says finished", async () => {
    set("__fdeMockEvalMs", 600_000)
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const { item, box } = await openImport("Import results for", NAME)
    await userEvent.upload(
      within(box).getByLabelText("CSV file"),
      csv(["case,output", "plan-01,fine"].join("\n"), "results.csv"),
    )
    await within(box).findByText(/Read 1 row/)
    await userEvent.click(within(box).getByRole("button", { name: "Grade these results" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(await screen.findByText(/Received the outputs for “Plan acceptance/)).toBeInTheDocument()
    expect(within(item).getAllByText("Running").length).toBeGreaterThan(0)
    expect(item).toHaveTextContent("Being graded.")
    expect(item).toHaveTextContent(/imported/)
  })

  it("keeps the file chosen and says why when the API refuses it", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const { box } = await openImport("Import results for", NAME)
    await userEvent.upload(
      within(box).getByLabelText("CSV file"),
      csv(["case,output", "plan-01,fine"].join("\n"), "results.csv"),
    )
    await within(box).findByText(/Read 1 row/)
    wire.refuse = Response.json({ error: "invalid_csv" }, { status: 400 })
    await userEvent.click(within(box).getByRole("button", { name: "Grade these results" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("That file was refused.")
    expect(within(box).getByText(/results\.csv/)).toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Import results" })).toBeInTheDocument()
  })

  it("adds cases, and says how many the API now holds", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const { box } = await openImport("Add cases to", "Time to a first draft")
    await userEvent.upload(
      within(box).getByLabelText("CSV file"),
      csv('input,expected\n"Ghent, peak",ready in 60s\nLeeds,ready in 60s\n', "cases.csv"),
    )
    expect(
      await within(box).findByText(/Read 2 rows with the columns input, expected/),
    ).toBeInTheDocument()
    await userEvent.click(within(box).getByRole("button", { name: "Add cases" }))
    expect(
      await screen.findByText("Added 2 cases to “Time to a first draft”. It now has 12."),
    ).toBeInTheDocument()
  })

  it("names a case id already in the suite before sending anything", async () => {
    renderWithRouter(<ProjectPage scope={DISPATCH} />)
    const { box } = await openImport("Add cases to", "Time to a first draft")
    await userEvent.upload(
      within(box).getByLabelText("CSV file"),
      csv("id,input\nspeed-01,again\n", "cases.csv"),
    )
    expect(await within(box).findByText(/Row 1 uses the id “speed-01”/)).toBeInTheDocument()
    expect(wire.sent).toEqual([])
  })

  it("brings a criterion to its target: import, grade, and the checklist reads again", async () => {
    resetMockApi()
    for (const to of ["scope", "access", "build", "evaluate"] as Array<Stage>)
      await api.moveStage(FORECAST, to, "To test")
    set("__fdeMockEvalMs", 0)
    renderWithRouter(<ProjectPage scope={FORECAST} />, { keep: true })
    // One criterion has no result: the item is open.
    const checklist = await screen.findByRole("region", { name: "To leave Evaluate" })
    expect(checklist).toHaveTextContent("Open: Every criterion meets its target")

    // A suite for it, cases, then results graded by the API.
    await userEvent.click(await screen.findByRole("button", { name: "New eval suite for this" }))
    const create = await dialog("New eval suite")
    await userEvent.type(within(create).getByLabelText("Name"), "Reasons a buyer finds useful")
    await userEvent.selectOptions(
      within(create).getByRole("combobox", { name: "Grader 1" }),
      "regex",
    )
    await userEvent.type(within(create).getByLabelText("Pattern"), "^useful")
    await userEvent.click(within(create).getByRole("button", { name: "Create suite" }))
    await screen.findByText(/Created “Reasons a buyer finds useful”/)

    const list = await suites()
    const item = (await within(list).findByText("Reasons a buyer finds useful")).closest("li")!
    await userEvent.click(
      within(item).getByRole("button", { name: "Add cases to Reasons a buyer finds useful" }),
    )
    const add = await dialog("Add cases")
    await userEvent.upload(
      within(add).getByLabelText("CSV file"),
      csv("id,input\nr1,Store 1\nr2,Store 2\nr3,Store 3\nr4,Store 4\nr5,Store 5\n"),
    )
    await within(add).findByText(/Read 5 rows/)
    await userEvent.click(within(add).getByRole("button", { name: "Add cases" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    await userEvent.click(
      within(item).getByRole("button", { name: "Import results for Reasons a buyer finds useful" }),
    )
    const results = await dialog("Import results")
    await userEvent.upload(
      within(results).getByLabelText("CSV file"),
      csv("case,output\nr1,useful\nr2,useful\nr3,useful\nr4,useful\nr5,not at all\n"),
    )
    await within(results).findByText(/Read 5 rows/)
    await userEvent.click(within(results).getByRole("button", { name: "Grade these results" }))

    // The criterion is met by the API's own rule (4 of 5 against at least 0.8), and the checklist says so.
    const row = await criterion("Buyers who find the reasons useful")
    await waitFor(() => expect(within(row).getByText("Met")).toBeInTheDocument(), {
      timeout: 8_000,
    })
    expect(row).toHaveTextContent("0.8 against at least 0.8")
    expect(row).toHaveTextContent("4 of 5 cases passed")
    expect(await screen.findByText(/Ready to leave Evaluate/)).toBeInTheDocument()
  }, 20_000)
})

describe("a new suite", () => {
  beforeEach(() => resetMockApi())

  async function atBuild() {
    resetMockApi()
    for (const to of ["scope", "access", "build"] as Array<Stage>)
      await api.moveStage(FORECAST, to, "To test")
    renderWithRouter(<ProjectPage scope={FORECAST} />, { keep: true })
    return screen.findByRole("region", { name: "To leave Build" })
  }

  it("is checked before it is sent, naming the field", async () => {
    renderWithRouter(<ProjectPage scope={FORECAST} />)
    await userEvent.click(await screen.findByRole("button", { name: "New eval suite for this" }))
    const box = await dialog("New eval suite")
    await userEvent.click(within(box).getByRole("button", { name: "Create suite" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent(
      "A name is one line, 1 to 200 characters.",
    )
    expect(within(box).getByLabelText("Name")).toHaveAttribute("aria-invalid", "true")
    expect(wire.sent).toEqual([])
  })

  it("starts with the criterion it was opened for ticked, and takes any of the five graders", async () => {
    renderWithRouter(<ProjectPage scope={FORECAST} />)
    await userEvent.click(await screen.findByRole("button", { name: "New eval suite for this" }))
    const box = await dialog("New eval suite")
    expect(
      within(box).getByRole("checkbox", { name: "Buyers who find the reasons useful" }),
    ).toBeChecked()
    expect(
      within(box).getByRole("checkbox", { name: "Forecasts a buyer can rely on" }),
    ).not.toBeChecked()
    const select = within(box).getByRole("combobox", { name: "Grader 1" })
    const kinds = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent)
    expect(kinds).toEqual([
      "Exact match",
      "Regular expression",
      "JSON schema",
      "Script in the sandbox",
      "Model judge",
    ])
  })

  it("is not shown as created until the API has it, then the checklist reads again", async () => {
    const checklist = await atBuild()
    expect(checklist).toHaveTextContent("Open: An eval suite measures every criterion")

    await userEvent.click(await screen.findByRole("button", { name: "New eval suite for this" }))
    const box = await dialog("New eval suite")
    await userEvent.type(within(box).getByLabelText("Name"), "Reasons")
    wire.hold = new Promise(() => {})
    await userEvent.click(within(box).getByRole("button", { name: "Create suite" }))
    await waitFor(() => expect(wire.sent.at(-1)?.method).toBe("POST"))
    expect(screen.getByRole("dialog", { name: "New eval suite" })).toBeInTheDocument()
    // Behind the dialog, which is still open: nothing has changed.
    expect(screen.getByRole("region", { name: "To leave Build", hidden: true })).toBeInTheDocument()
    expect(
      within(screen.getByRole("region", { name: "Eval suites", hidden: true })).queryByText(
        "Reasons",
      ),
    ).toBeNull()
  })

  it("is in the list once created, and the stage no longer lacks an eval suite", async () => {
    await atBuild()
    await userEvent.click(await screen.findByRole("button", { name: "New eval suite for this" }))
    const box = await dialog("New eval suite")
    await userEvent.type(within(box).getByLabelText("Name"), "Reasons")
    await userEvent.click(within(box).getByRole("button", { name: "Create suite" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    expect(await within(await suites()).findByText("Reasons")).toBeInTheDocument()
    expect(await screen.findByText(/Ready to leave Build/)).toBeInTheDocument()
    expect(wire.sent.find((w) => w.path.endsWith("/eval-suites"))?.body).toMatchObject({
      name: "Reasons",
      criteria: ["crt_l2"],
      graders: [{ kind: "exact_match", ignore_case: false }],
      target: null,
    })
  })

  it("keeps what was typed, and says why, when the API refuses it", async () => {
    renderWithRouter(<ProjectPage scope={FORECAST} />)
    await userEvent.click(await screen.findByRole("button", { name: "New eval suite for this" }))
    const box = await dialog("New eval suite")
    await userEvent.type(within(box).getByLabelText("Name"), "Reasons")
    wire.refuse = Response.json({ error: "invalid_suite" }, { status: 400 })
    await userEvent.click(within(box).getByRole("button", { name: "Create suite" }))
    expect(await within(box).findByRole("alert")).toHaveTextContent("That suite was refused.")
    expect(within(box).getByLabelText("Name")).toHaveValue("Reasons")
  })

  it("shows a name that holds markup as the characters it is made of", async () => {
    renderWithRouter(<ProjectPage scope={FORECAST} />)
    await userEvent.click(await screen.findByRole("button", { name: "New eval suite for this" }))
    const box = await dialog("New eval suite")
    const name = "<img src=x onerror=alert(1)> **bold**"
    await userEvent.type(within(box).getByLabelText("Name"), name, { skipClick: false })
    await userEvent.click(within(box).getByRole("button", { name: "Create suite" }))
    const list = await suites()
    expect(await within(list).findByText(name)).toBeInTheDocument()
    expect(list.querySelector("img")).toBeNull()
    expect(list.querySelector("strong")).toBeNull()
  })
})
