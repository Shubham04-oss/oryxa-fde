import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { RunPage } from "./run-page"
import { ActiveRunsCard, RunsCard } from "./runs"
import { AgentRunId } from "@/lib/api/runs"
import { CompanyId, ProjectId } from "@/lib/api/schemas"
import { renderWithRouter } from "@/test/render"

const dispatch = {
  company: CompanyId.parse("cmp_kestrel"),
  project: ProjectId.parse("prj_kestrel_dispatch"),
}
const forecasts = {
  company: CompanyId.parse("cmp_lumen"),
  project: ProjectId.parse("prj_lumen_forecast"),
}
const referrals = {
  company: CompanyId.parse("cmp_brightwater"),
  project: ProjectId.parse("prj_bw_referrals"),
}

function renderRun(scope: typeof dispatch, run: string) {
  return renderWithRouter(<RunPage scope={scope} runId={AgentRunId.parse(run)} />)
}

/** The run's state, as the Task card shows it. */
const runState = () => within(screen.getByRole("region", { name: "Task" })).getAllByText(/./)

describe("RunPage", () => {
  it("shows a run waiting for approval with exactly what would run, and approves it", async () => {
    renderRun(dispatch, "run_k2")

    const waiting = await screen.findByRole("region", { name: "Waiting for approval" })
    expect(
      within(waiting).getByText("Push agent/run_k2 to kestrel-freight/dispatch-copilot"),
    ).toBeInTheDocument()
    // The full input, not only the title.
    expect(
      within(waiting).getByText(/"command": "git push origin agent\/run_k2"/),
    ).toBeInTheDocument()
    expect(within(waiting).getByText("Waiting for you")).toBeInTheDocument()

    await userEvent.click(within(waiting).getByRole("button", { name: "Approve" }))

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Waiting for approval" })).toBeNull(),
    )
    const decided = screen.getByRole("region", { name: "Decided approvals" })
    expect(within(decided).getByText(/^Approved/)).toBeInTheDocument()
    expect(runState().map((n) => n.textContent)).toContain("Running")
  })

  it("rejects only once the FDE confirms, and the run stops", async () => {
    renderRun(dispatch, "run_k2")
    const waiting = await screen.findByRole("region", { name: "Waiting for approval" })

    await userEvent.click(within(waiting).getByRole("button", { name: "Reject…" }))
    expect(within(waiting).getByText("Reject this action? The run stops.")).toBeInTheDocument()
    await userEvent.click(within(waiting).getByRole("button", { name: "Keep waiting" }))
    expect(within(waiting).getByRole("button", { name: "Approve" })).toBeInTheDocument()

    await userEvent.click(within(waiting).getByRole("button", { name: "Reject…" }))
    await userEvent.click(within(waiting).getByRole("button", { name: "Reject" }))

    expect(await screen.findByText("An action was rejected.")).toBeInTheDocument()
    expect(runState().map((n) => n.textContent)).toContain("Failed")
    expect(within(screen.getByRole("region", { name: "Decided approvals" })).getByText(/^Rejected/))
  })

  it("shows what a finished run did: plan, files, tests and its pull request", async () => {
    renderRun(dispatch, "run_k1")

    const link = await screen.findByRole("link", { name: "Pull request #42" })
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/kestrel-freight/dispatch-copilot/pull/42",
    )
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
    const files = screen.getByRole("region", { name: "Files changed" })
    expect(within(files).getByText("src/context/depot_rules.ts")).toBeInTheDocument()
    expect(within(files).getByText("Created")).toBeInTheDocument()
    const commands = screen.getByRole("region", { name: "Tests and commands" })
    expect(within(commands).getByText("$ npm test")).toBeInTheDocument()
    expect(within(commands).getByText("Passed")).toBeInTheDocument()
    expect(screen.getByText(/Opened a pull request\.$/)).toBeInTheDocument()
    // A finished run cannot be cancelled.
    expect(screen.queryByRole("button", { name: "Cancel…" })).toBeNull()
  })

  it("shows a queued run with nothing claimed yet", async () => {
    renderRun(referrals, "run_b1")

    expect(await screen.findByText("Queued")).toBeInTheDocument()
    expect(screen.getByText("No plan yet.")).toBeInTheDocument()
    expect(screen.getByText("No files changed yet.")).toBeInTheDocument()
    expect(screen.getByText("No commands run yet.")).toBeInTheDocument()
  })

  it("shows a failed run, why it failed, and the decision that stopped it", async () => {
    renderRun(forecasts, "run_l1")

    expect(await screen.findByText("An action was rejected.")).toBeInTheDocument()
    const decided = screen.getByRole("region", { name: "Decided approvals" })
    expect(within(decided).getByText(/npm run deploy -- --env production/)).toBeInTheDocument()
    expect(within(decided).queryByRole("button")).toBeNull()
  })

  it("cancels a running run only once the FDE confirms", async () => {
    renderRun(forecasts, "run_l2")
    await screen.findByText("Running")
    expect(screen.getByText("Checking for new output every few seconds.")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Cancel…" }))
    await userEvent.click(screen.getByRole("button", { name: "Cancel run" }))

    expect(await screen.findByText("Cancelled.")).toBeInTheDocument()
  })

  it("says a run that is not there is not available", async () => {
    renderRun(dispatch, "run_nope")

    expect(await screen.findByText("This run is not available.")).toBeInTheDocument()
  })
})

describe("RunsCard", () => {
  it("lists a project's runs, newest first, and starts a task from its repository", async () => {
    const { router } = renderWithRouter(<RunsCard scope={dispatch} />)

    const list = await screen.findByRole("list", { name: "Agent runs" })
    expect(
      within(list)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([
      expect.stringContaining("Add driver-hours checks"),
      expect.stringContaining("Load the depot rules"),
    ])

    await userEvent.click(screen.getByRole("button", { name: "Start a task" }))
    const form = screen.getByRole("form", { name: "Start a task" })
    // From the latest run's repository.
    expect(within(form).getByLabelText("GitHub owner")).toHaveValue("kestrel-freight")
    await userEvent.click(within(form).getByRole("button", { name: "Start" }))
    expect(within(form).getByRole("alert")).toHaveTextContent("Describe the task")

    await userEvent.type(within(form).getByLabelText("What should the agent do?"), "Add a README.")
    await userEvent.click(within(form).getByRole("button", { name: "Start" }))

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/companies/cmp_kestrel/projects/prj_kestrel_dispatch/runs/run_new_3",
      ),
    )
  })

  it("names the repository part the API would refuse, before sending", async () => {
    renderWithRouter(<RunsCard scope={dispatch} />)
    await userEvent.click(await screen.findByRole("button", { name: "Start a task" }))
    const form = screen.getByRole("form", { name: "Start a task" })

    await userEvent.type(within(form).getByLabelText("What should the agent do?"), "Anything")
    await userEvent.clear(within(form).getByLabelText("From branch"))
    await userEvent.type(within(form).getByLabelText("From branch"), "-oops")
    await userEvent.click(within(form).getByRole("button", { name: "Start" }))

    expect(within(form).getByRole("alert")).toHaveTextContent("The branch name")
  })
})

describe("ActiveRunsCard", () => {
  it("lists the runs that may still need the FDE across companies, waiting for approval first", async () => {
    renderWithRouter(<ActiveRunsCard />)

    const list = await screen.findByRole("list", { name: "Agent runs" })
    const rows = within(list).getAllByRole("link")
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(
        /^Add driver-hours checks.*Kestrel Freight · Dispatch copilot.*Waiting for approval$/,
      ),
      expect.stringMatching(/Referral intake.*Queued$/),
      expect.stringMatching(/Lumen Grocers · Store demand forecasts.*Running$/),
    ])
  })
})
