// A stand-in for the FDE API, for `pnpm dev:mock` and the tests only, so every screen can be
// clicked through with no backend. It answers the spec's routes in the browser, typed from
// fde-api.gen.ts so it follows the spec. It keeps the API's rules the screens depend on: a
// session, only the FDE's own companies (anything else is a 403, as the API answers), and the
// stage machine. src/lib/api/client.ts loads it only in a dev build with VITE_FDE_MOCK_API=1;
// mock-excluded.test.ts proves a production build leaves it out.
//
// Sample data only: every company, person and system here is invented.

import type { z } from "zod"
import type { Transport, UploadRequest } from "../lib/api/client"
import type { components } from "../lib/api/fde-api.gen"
import { STAGES } from "../lib/api/schemas"
import type { Me, Stage } from "../lib/api/schemas"
import { nextStepOf } from "../lib/board"
import { canMove } from "../lib/stage"
import { localDay } from "../lib/time"
import { documentReads, documentSearch, documentUpload, seedDocuments } from "./mock-documents"
import { readText } from "../lib/eval-csv"
import { emptyEvals, evalRoutes, seedEvals, settle, valueOf, measured } from "./mock-evals"
import type { MockEvals } from "./mock-evals"
import { runRoutes, seedRuns } from "./mock-runs"
import { resetMockSignIn, signInRoutes } from "./mock-sign-in"

type S = components["schemas"]

/** What the production-build test looks for. Logged once so it is never tree-shaken away. */
export const MOCK_MARKER = "fde-dev-mock-api"
if (import.meta.env.MODE !== "test") console.info(`[${MOCK_MARKER}] answering from sample data`)

// Kept for the tab, so a reload stays signed in. Delete it to see sign-in again.
const SESSION_KEY = "fde.mock.session"

const RIYA = "usr_riya"
const JONAH = "usr_jonah"
const SAM = "usr_sam"
const AURELIA = "usr_aurelia"
const QUILL = "usr_quill"

/**
 * The organisation's people as WorkOS has them (invented): a name or none, and the membership's role.
 * A guest is not one of its own people, so `/v1/people` leaves them out. Names are looked up when an
 * answer is written, as the API does, so a member or an assignee carries the name of the moment.
 */
const DIRECTORY: ReadonlyArray<{
  id: string
  name: string | null
  role: "admin" | "member" | "guest"
}> = [
  { id: RIYA, name: "Riya Kapoor", role: "admin" },
  { id: JONAH, name: "Jonah Ade", role: "member" },
  { id: "usr_sam", name: "Sam Okafor", role: "member" },
  { id: "usr_tomoko", name: "Tomoko Hale", role: "member" },
  {
    id: "usr_aurelia",
    name: "Aurelia Montgomery-Featherstonehaugh de la Cruz Vandermeer-Okonkwo",
    role: "member",
  },
  // WorkOS has neither a first nor a last name for them.
  { id: "usr_quill", name: null, role: "member" },
  { id: "usr_visitor", name: "Visiting Auditor", role: "guest" },
]

/**
 * Dev and test only, like everything here: `globalThis.__fdeMockPeople = "unavailable"` makes WorkOS
 * unreachable (`/v1/people` answers 503 and members and assignees carry no names, as the API fails soft),
 * and `"forbidden"` makes `/v1/people` answer 403, as it does to a guest.
 */
const peopleSwitch = () => (globalThis as Record<string, unknown>).__fdeMockPeople

/** A user's name as an answer carries it: none when WorkOS cannot be reached. */
const nameOf = (user: string) =>
  peopleSwitch() === "unavailable" ? null : (DIRECTORY.find((p) => p.id === user)?.name ?? null)

/** `GET /v1/people`: the organisation's own people by name, the unnamed last, ids breaking ties. */
function peopleList() {
  if (peopleSwitch() === "unavailable") return refuse(503, "unavailable")
  if (peopleSwitch() === "forbidden") return refuse(403, "forbidden")
  const key = (p: (typeof DIRECTORY)[number]) =>
    [p.name === null ? 1 : 0, p.name?.toLowerCase() ?? "", p.id] as const
  const list = DIRECTORY.filter((p) => p.role !== "guest").sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || (x[2] < y[2] ? -1 : 1)
  })
  return json(list.map((p): S["PersonOut"] => ({ id: p.id, name: p.name })))
}

/** `days` (and `hours`) ago, as the API writes an instant. */
const ago = (days: number, hours = 0) =>
  new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString()

/** `n` days from today, as `YYYY-MM-DD`. */
function day(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return localDay(d)
}

const person = (
  id: string,
  name: string,
  title: string | null,
  role: S["StakeholderPart"],
  main_contact = false,
): S["StakeholderOut"] => ({ id, name, title, role, main_contact, updated_at: ago(30), version: 1 })

const system = (
  id: string,
  name: string,
  kind: string | null,
  description: string | null,
): S["SystemOut"] => ({ id, name, kind, description, updated_at: ago(30), version: 1 })

const member = (user: string, role: S["MemberRole"]): S["MemberOut"] => ({
  user,
  role,
  added_at: ago(90),
})

/** A task last changed `daysAgo`; `due` is in days from today, and a wait began `waitingDays` ago. */
function task(
  id: string,
  title: string,
  status: S["TaskState"],
  daysAgo: number,
  extra: {
    due?: number
    assignee?: string
    blocker?: string
    blockedBy?: string
    waitingOn?: string
    waitingDays?: number
    criterion?: string
    stage?: Stage
  } = {},
): S["TaskOut"] {
  return {
    id,
    title,
    status,
    blocker: extra.blocker ?? null,
    due_on: extra.due === undefined ? null : day(extra.due),
    assignee: extra.assignee ?? null,
    waiting_on: extra.waitingOn ?? null,
    waiting_since: extra.waitingDays === undefined ? null : ago(extra.waitingDays),
    blocked_by: extra.blockedBy ?? null,
    criterion: extra.criterion ?? null,
    stage: extra.stage ?? null,
    created_at: ago(daysAgo + 10),
    updated_at: ago(daysAgo),
    version: 1,
  }
}

/** An access request asked for `asked` days ago and, unless still open, settled `settled` days ago. */
function access(
  id: string,
  description: string,
  systemId: string | null,
  owner: string | null,
  status: S["AccessState"],
  asked: number,
  settled = 0,
): S["AccessRequestOut"] {
  const open = status === "requested" || status === "in_progress"
  return {
    id,
    description,
    system: systemId,
    owner,
    status,
    requested_at: ago(asked),
    status_changed_at: ago(open ? asked : settled),
    // A revoked request had been granted: the API counts its days to that grant, a few days after it was asked.
    granted_at: status === "granted" ? ago(settled) : status === "revoked" ? ago(asked - 3) : null,
    days_waiting: open ? asked : status === "revoked" ? 3 : asked - settled,
    version: 1,
  }
}

/** A discussion about `subject`, promoted to `decisionId`. */
function thread(
  id: string,
  subject: S["SubjectRef"],
  decisionId: string,
  daysAgo: number,
): S["ThreadOut"] {
  return {
    id,
    subject,
    created_by: RIYA,
    created_at: ago(daysAgo + 2),
    last_comment_at: ago(daysAgo),
    comments: 3,
    decision: decisionId,
  }
}

const inScope = (id: string, description: string): S["ScopeItemOut"] => ({
  id,
  kind: "in",
  description,
  updated_at: ago(30),
  version: 1,
})
const outOfScope = (id: string, description: string): S["ScopeItemOut"] => ({
  id,
  kind: "out",
  description,
  updated_at: ago(30),
  version: 1,
})

function criterion(
  id: string,
  description: string,
  metric: string,
  comparator: S["TargetComparator"],
  target: number,
  unit: string | null,
  proven: { baseline?: number; proof?: string } = {},
): S["CriterionOut"] {
  return {
    id,
    description,
    metric,
    comparator,
    target,
    unit,
    baseline: proven.baseline ?? null,
    proof: proven.proof ?? null,
    updated_at: ago(30),
    version: 1,
  }
}

/** A scope; `signedOff` names who signed it, and whether it changed since (`current: false`). */
function scope(
  items: Array<S["ScopeItemOut"]>,
  criteria: Array<S["CriterionOut"]>,
  signedOff?: { by: string; daysAgo: number; current: boolean },
): S["ScopeOut"] {
  const version = items.length + criteria.length
  return {
    version,
    items,
    criteria,
    signed_off: signedOff?.current ?? false,
    sign_off: signedOff
      ? {
          version: signedOff.current ? version : version - 1,
          stakeholder: signedOff.by,
          recorded_by: RIYA,
          signed_at: ago(signedOff.daysAgo),
        }
      : null,
  }
}

function decision(
  id: string,
  title: string,
  rationale: string,
  decidedBy: string,
  daysAgo: number,
): S["DecisionOut"] {
  return {
    id,
    title,
    rationale,
    decided_by: decidedBy,
    decided_at: ago(daysAgo),
    recorded_by: RIYA,
    created_at: ago(daysAgo),
  }
}

/** A meeting note held `daysAgo`; the longer ones are written out in full, as an FDE would. */
function note(
  id: string,
  title: string,
  daysAgo: number,
  body: string,
  who: { stakeholders?: Array<string>; attendees?: Array<string> } = {},
): S["MeetingNoteOut"] {
  return {
    id,
    title,
    held_on: day(-daysAgo),
    body,
    stakeholders: who.stakeholders ?? [],
    attendees: who.attendees ?? [RIYA],
    created_by: RIYA,
    created_at: ago(daysAgo),
    updated_at: ago(daysAgo),
  }
}

/** `n` short check-in notes, for a project whose notes the screens do not dwell on. */
const checkIns = (prefix: string, n: number, stakeholder: string) =>
  Array.from({ length: n }, (_, i) =>
    note(
      `${prefix}${i + 1}`,
      i === n - 1 ? "Kickoff call" : `Check-in ${n - 1 - i}`,
      (n - i) * 9,
      i === n - 1
        ? "Agreed the goal, who signs off and how often we talk.\nNext: list the systems and name an owner for each."
        : "Short call. Nothing blocked; the next steps are on the board.",
      { stakeholders: [stakeholder] },
    ),
  )

type Records = {
  scope: S["ScopeOut"]
  access: Array<S["AccessRequestOut"]>
  tasks: Array<S["TaskOut"]>
  decisions: Array<S["DecisionOut"]>
  /** Discussions that were promoted to a decision, by the decision they ended in. */
  threads?: Array<S["ThreadOut"]>
  /** Meeting notes on the project. */
  notes: Array<S["MeetingNoteOut"]>
  /** Eval suites and runs, and the latest value each criterion has (mock-evals.ts). */
  evals: MockEvals
}

type CompanySeed = {
  company: S["CompanyOut"]
  /** Meeting notes on the company itself: the stage checklist does not count them. */
  notes: Array<S["MeetingNoteOut"]>
  members: Array<S["MemberOut"]>
  stakeholders: Array<S["StakeholderOut"]>
  systems: Array<S["SystemOut"]>
}

function company(
  id: string,
  name: string,
  industry: string,
  region: string,
  summary: string,
  days: number,
): S["CompanyOut"] {
  return { id, name, industry, region, summary, created_at: ago(days), updated_at: ago(days) }
}

function project(
  id: string,
  companyId: string,
  name: string,
  stage: Stage,
  hours: number,
  summary: string,
): S["ProjectOut"] {
  return {
    id,
    company: companyId,
    name,
    stage,
    summary,
    created_at: ago(60),
    updated_at: ago(0, hours),
  }
}

/** A project with nothing written in it yet. A function, so no two projects share an array. */
const emptyRecords = (): Records => ({
  scope: scope([], []),
  access: [],
  tasks: [],
  decisions: [],
  notes: [],
  evals: emptyEvals(),
})

function seed() {
  const companies: Array<CompanySeed> = [
    {
      company: company(
        "cmp_kestrel",
        "Kestrel Freight",
        "Logistics",
        "EU (Frankfurt)",
        "A regional freight carrier with 14 depots. Wants dispatchers to plan in minutes.",
        80,
      ),
      notes: [
        note(
          "mtg_kc1",
          "Quarterly review with Kestrel leadership",
          12,
          "Mara wants one number for the board: minutes saved per depot per week.\nTomas will not open the telematics feed before the security review in January.\nGeneral point for every project: the customer reads results on Fridays.",
          { stakeholders: ["stk_k1", "stk_k3"], attendees: [RIYA, JONAH] },
        ),
      ],
      members: [member(RIYA, "lead"), member(JONAH, "engineer")],
      stakeholders: [
        person("stk_k1", "Mara Lindqvist", "Head of operations", "sponsor", true),
        person("stk_k2", "Ines Moreau", "Dispatch lead, Ghent", "champion"),
        person("stk_k3", "Tomas Becker", "Data platform manager", "it"),
        person("stk_k4", "Lea Novak", "Information security", "security"),
      ],
      systems: [
        system("sys_k1", "Planning database", "PostgreSQL", "Read replica only; nightly refresh."),
        system("sys_k2", "Depot rules", "Spreadsheet", "One sheet per depot, kept by dispatch."),
        system("sys_k3", "Telematics", "Vendor API", "Refused for now; see decisions."),
      ],
    },
    {
      company: company(
        "cmp_brightwater",
        "Brightwater Clinics",
        "Healthcare",
        "UK (London)",
        "A network of outpatient clinics. Referral intake is slow and done by hand.",
        50,
      ),
      notes: [],
      members: [member(JONAH, "lead"), member(RIYA, "engineer")],
      stakeholders: [
        person("stk_b1", "Dr Helen Achebe", "Medical director", "sponsor"),
        person("stk_b2", "Owen Price", "Integration engineer", "it"),
        person("stk_b3", "Sana Qureshi", null, "security"),
      ],
      systems: [
        system("sys_b1", "Intake form", "Internal web app", "Staging API only in this phase."),
        system("sys_b2", "Clinic directory", "Export", null),
      ],
    },
    {
      company: company(
        "cmp_lumen",
        "Lumen Grocers",
        "Retail",
        "US (Virginia)",
        "A grocery chain of 220 stores. Fresh produce waste is the target.",
        70,
      ),
      notes: [],
      // A long name and no name at all, as WorkOS can have them.
      members: [
        member(RIYA, "lead"),
        member(SAM, "engineer"),
        member(AURELIA, "engineer"),
        member(QUILL, "engineer"),
      ],
      stakeholders: [
        person("stk_l1", "Carlos Mendes", "VP supply chain", "sponsor"),
        person("stk_l2", "Priya Raman", "Fresh produce buyer", "champion"),
        person("stk_l3", "Wen Zhao", "Analytics engineer", "it"),
      ],
      systems: [
        system("sys_l1", "Sales history", "Data warehouse", "Three years, daily, per store."),
        system("sys_l2", "Weather feed", "Vendor API", "On the outbound allowlist."),
      ],
    },
    {
      company: company(
        "cmp_atlas",
        "Atlas Mutual",
        "Insurance",
        "US (Ohio)",
        "A mutual insurer. Call handlers miss fields on the first notice of a claim.",
        20,
      ),
      notes: [],
      members: [member(JONAH, "lead"), member(RIYA, "engineer")],
      stakeholders: [
        person("stk_a1", "Grace Holm", "Claims director", "other"),
        person("stk_a2", "Daniel Osei", "Contact centre manager", "champion"),
      ],
      systems: [system("sys_a1", "Call recordings", "Object storage", "Redacted copies only.")],
    },
    {
      company: company(
        "cmp_cobalt",
        "Cobalt Grid",
        "Energy",
        "India (Mumbai)",
        "A power distributor. Two projects: one in operation, one rolling out to crews.",
        150,
      ),
      // The organisation admin reaches it without being a member.
      notes: [],
      members: [member(JONAH, "lead")],
      stakeholders: [
        person("stk_c1", "Arjun Nair", "Chief operating officer", "sponsor"),
        person("stk_c2", "Meera Iyer", "IT operations lead", "it"),
        person("stk_c3", "Ravi Desai", "Field crew supervisor", "user"),
      ],
      systems: [
        system("sys_c1", "Outage log", "Internal database", "Read only."),
        system("sys_c2", "Crew phones", "Mobile device management", null),
      ],
    },
  ]

  const projects: Array<{ project: S["ProjectOut"]; records: Records }> = [
    {
      project: project(
        "prj_kestrel_dispatch",
        "cmp_kestrel",
        "Dispatch copilot",
        "build",
        2,
        "Drafts load plans for dispatchers from open orders, driver hours and depot rules.",
      ),
      records: {
        evals: emptyEvals(),
        notes: [
          note(
            "mtg_kd1",
            "Dispatcher workshop, Leeds depot",
            4,
            [
              "Went through a real morning: orders arrive by 05:30 and the plan has to be out by 06:15.",
              "",
              "What Ines said:",
              "- Drivers hate being re-planned after they have clocked on.",
              "- The depot rules sheet is the real source of truth; the planning database is often a day behind.",
              "- A plan she cannot explain to a driver in one sentence goes in the bin.",
              "",
              "Agreed in the room:",
              "We pilot at Leeds and Ghent only, plans stay drafts and nothing goes to drivers directly.",
              "",
              "Actions:",
              "- [ ] Send Ines the explanation format for review",
              "- [ ] Ask Tomas for a read replica of the planning database",
              "- Mara to confirm who signs off the pilot plan",
            ].join("\n"),
            { stakeholders: ["stk_k1", "stk_k2"], attendees: [RIYA, JONAH] },
          ),
          note(
            "mtg_kd2",
            "Data access call with IT",
            19,
            "Tomas can give a read replica, refreshed nightly. Telematics is a separate approval and he thinks it will be refused.\nWe agreed to start without it and revisit after the pilot.",
            { stakeholders: ["stk_k3"] },
          ),
        ],
        scope: scope(
          [
            inScope("itm_k1", "Draft next-day load plans for the two pilot depots"),
            inScope("itm_k2", "Explain each assignment in one line a dispatcher can check"),
            inScope("itm_k3", "Read orders and driver hours from the planning database"),
            outOfScope("itm_k4", "Changing the planning database"),
            outOfScope("itm_k5", "Live re-routing during the day"),
          ],
          [
            criterion(
              "crt_k1",
              "Plans dispatchers accept with no changes",
              "share of sampled plans accepted unchanged",
              "at_least",
              0.7,
              null,
              {
                baseline: 0.42,
                proof: "The plan acceptance eval suite, on last month's orders",
              },
            ),
            criterion(
              "crt_k2",
              "Plans that keep every driver-hours rule",
              "share of sampled plans within the rules",
              "at_least",
              1,
              null,
              { baseline: 0.9 },
            ),
            criterion("crt_k3", "Time to a draft plan", "minutes per depot", "at_most", 2, "min", {
              baseline: 45,
              proof: "Timed by the dispatchers at both pilot depots for a week",
            }),
          ],
          { by: "stk_k1", daysAgo: 21, current: true },
        ),
        access: [
          access(
            "acc_k1",
            "Read replica of the planning database",
            "sys_k1",
            "stk_k3",
            "granted",
            18,
            15,
          ),
          access("acc_k2", "Depot rules, read only", "sys_k2", "stk_k2", "in_progress", 6),
          access("acc_k3", "Telematics export", "sys_k3", "stk_k3", "denied", 9, 5),
        ],
        tasks: [
          task("tsk_k1", "Load depot rules into the context pack", "in_progress", 1, {
            due: 1,
            assignee: RIYA,
            criterion: "crt_k2",
            stage: "build",
          }),
          task("tsk_k2", "Replay last month's orders through the planner", "todo", 2, {
            due: 0,
            assignee: RIYA,
            criterion: "crt_k1",
            stage: "build",
          }),
          task("tsk_k3", "Add driver-hours checks to the eval suite", "todo", 3, {
            due: -2,
            assignee: JONAH,
            criterion: "crt_k2",
            stage: "evaluate",
          }),
          task("tsk_k4", "Agree the telematics alternative", "blocked", 3, {
            due: -1,
            assignee: RIYA,
            blocker: "Telematics export refused by the customer's security team",
            blockedBy: "acc_k3",
            stage: "access",
          }),
          task("tsk_k5", "Dispatcher feedback session", "waiting_on_customer", 4, {
            due: 3,
            assignee: RIYA,
            waitingOn: "stk_k1",
            waitingDays: 4,
          }),
          task("tsk_k6", "Set up the sandbox with sample orders", "done", 12, {
            due: -12,
            assignee: JONAH,
          }),
          task("tsk_k7", "Sign the data processing terms with the customer", "done", 20, {
            assignee: RIYA,
          }),
          task("tsk_k8", "Pick the two pilot depots", "done", 16, { assignee: JONAH }),
          task("tsk_k9", "Write the first depot rules summary", "done", 9, { assignee: RIYA }),
          task("tsk_k10", "Run the first planner replay on sample orders", "done", 6, {
            assignee: JONAH,
            criterion: "crt_k1",
          }),
          task("tsk_k11", "Share the pilot plan with the dispatchers", "done", 3, {
            assignee: RIYA,
          }),
        ],
        decisions: [
          decision(
            "dec_k1",
            "Pilot at Leeds and Ghent depots only",
            "They have the cleanest order data and dispatchers who volunteered.",
            "Mara Lindqvist",
            24,
          ),
          decision(
            "dec_k2",
            "Plans are drafts, never sent to drivers directly",
            "Dispatchers stay accountable for every plan.",
            "Riya Kapoor",
            20,
          ),
          decision(
            "dec_k3",
            "Leave the telematics export out of the pilot",
            "Security refused it for now. The pilot works from the planning database alone.\nRevisit when the vendor API is approved.",
            "Tomas Becker",
            4,
          ),
        ],
        threads: [thread("thr_k1", { kind: "access_request", id: "acc_k3" }, "dec_k3", 4)],
      },
    },
    {
      project: project(
        "prj_kestrel_claims",
        "cmp_kestrel",
        "Damage claims triage",
        "discover",
        30,
        "Sort incoming damage claims by likely cause and route them to the right team.",
      ),
      records: {
        ...emptyRecords(),
        tasks: [
          task("tsk_kc1", "Interview the claims team lead", "waiting_on_customer", 1, {
            due: 2,
            assignee: RIYA,
            waitingOn: "stk_k2",
            waitingDays: 1,
          }),
          task("tsk_kc2", "Collect twenty anonymised sample claims", "todo", 1, {
            due: 5,
            assignee: RIYA,
          }),
        ],
      },
    },
    {
      project: project(
        "prj_bw_referrals",
        "cmp_brightwater",
        "Referral intake",
        "access",
        5,
        "Reads referral letters and fills the intake form for the clinic's coordinators.",
      ),
      records: {
        evals: emptyEvals(),
        notes: checkIns("mtg_bw", 1, "stk_b1"),
        scope: scope(
          [
            inScope("itm_b1", "Extract patient-free fields from synthetic referral letters"),
            inScope("itm_b2", "Suggest the receiving clinic and urgency"),
            outOfScope("itm_b3", "Real patient records until the runner exists"),
            outOfScope("itm_b4", "Clinical advice"),
          ],
          [
            criterion(
              "crt_b1",
              "Fields extracted correctly",
              "fields correct on the 300-letter synthetic set",
              "at_least",
              95,
              "%",
            ),
            criterion(
              "crt_b2",
              "Urgency matches a coordinator",
              "agreement with coordinators",
              "at_least",
              90,
              "%",
            ),
          ],
          // Changed since the sponsor signed it, so it needs signing again.
          { by: "stk_b1", daysAgo: 8, current: false },
        ),
        access: [
          access("acc_b1", "Synthetic referral letters", null, "stk_b2", "granted", 7, 6),
          access("acc_b2", "Intake form API, staging", "sys_b1", "stk_b2", "requested", 5),
          access("acc_b3", "Clinic directory export", "sys_b2", "stk_b3", "in_progress", 11),
        ],
        tasks: [
          task("tsk_b1", "Answer the security questionnaire", "in_progress", 1, {
            due: 0,
            assignee: JONAH,
          }),
          task("tsk_b2", "Map intake form fields", "todo", 2, { due: -3, assignee: JONAH }),
          task("tsk_b3", "Staging credentials for the intake API", "blocked", 1, {
            due: 2,
            assignee: JONAH,
            blocker: "Waiting for the intake API access request",
            blockedBy: "acc_b2",
          }),
        ],
        decisions: [
          decision(
            "dec_b1",
            "Synthetic letters only in this phase",
            "No patient data leaves the clinic before the runner is in their cloud.",
            "Dr Helen Achebe",
            10,
          ),
        ],
      },
    },
    {
      project: project(
        "prj_lumen_forecast",
        "cmp_lumen",
        "Store demand forecasts",
        "evaluate",
        1,
        "Daily demand forecasts for fresh produce in forty stores, with reasons a buyer reads.",
      ),
      records: {
        evals: emptyEvals(),
        notes: checkIns("mtg_lm", 3, "stk_l1"),
        scope: scope(
          [
            inScope("itm_l1", "Fresh produce in forty pilot stores"),
            inScope("itm_l2", "A daily forecast with three reasons a buyer reads"),
            outOfScope("itm_l3", "Automatic ordering"),
            outOfScope("itm_l4", "Promotions planning"),
          ],
          [
            criterion(
              "crt_l1",
              "Forecasts a buyer can rely on",
              "share of forecasts within tolerance",
              "at_least",
              0.85,
              null,
            ),
            criterion(
              "crt_l2",
              "Buyers who find the reasons useful",
              "share of reviewed forecasts with reasons rated useful",
              "at_least",
              0.8,
              null,
            ),
          ],
          { by: "stk_l1", daysAgo: 40, current: true },
        ),
        access: [
          access(
            "acc_l1",
            "Sales history warehouse, read only",
            "sys_l1",
            "stk_l3",
            "granted",
            45,
            41,
          ),
        ],
        tasks: [
          task("tsk_l1", "Rewrite reasons in buyers' words", "in_progress", 1, {
            due: 1,
            assignee: RIYA,
          }),
          task("tsk_l2", "Buyer review of week 3 forecasts", "waiting_on_customer", 7, {
            due: -1,
            assignee: AURELIA,
            waitingOn: "stk_l2",
            waitingDays: 7,
          }),
          task("tsk_l3", "Publish eval results to the customer room", "todo", 2, {
            due: 0,
            assignee: RIYA,
          }),
        ],
        decisions: [
          decision(
            "dec_l1",
            "Measure with MAPE, not RMSE",
            "Buyers compare stores of very different sizes.",
            "Carlos Mendes",
            38,
          ),
        ],
      },
    },
    {
      project: project(
        "prj_atlas_fnol",
        "cmp_atlas",
        "First notice of loss assistant",
        "scope",
        50,
        "Helps call handlers capture a claim's first notice in one pass.",
      ),
      records: {
        evals: emptyEvals(),
        notes: checkIns("mtg_at", 1, "stk_a2"),
        scope: scope(
          [
            inScope("itm_a1", "Home claims by phone"),
            inScope("itm_a2", "A checklist that adapts to the loss type"),
            outOfScope("itm_a3", "Motor claims"),
            outOfScope("itm_a4", "Fraud scoring"),
          ],
          [
            criterion(
              "crt_a1",
              "Calls with every required field",
              "calls with every required field",
              "at_least",
              98,
              "%",
            ),
            criterion(
              "crt_a2",
              "Average handling time",
              "change from the baseline",
              "at_most",
              -15,
              "%",
            ),
          ],
        ),
        access: [access("acc_a1", "Redacted call recordings", "sys_a1", "stk_a2", "requested", 3)],
        tasks: [
          task("tsk_a1", "Scope sign-off meeting", "waiting_on_customer", 2, {
            due: 4,
            assignee: JONAH,
            waitingOn: "stk_a1",
            waitingDays: 2,
          }),
          task("tsk_a2", "Draft the loss-type checklist", "in_progress", 2, {
            due: 6,
            assignee: JONAH,
          }),
        ],
        decisions: [],
      },
    },
    {
      project: project(
        "prj_cobalt_outage",
        "cmp_cobalt",
        "Outage report summaries",
        "operate",
        20,
        "Summarises overnight outage reports for the morning operations call.",
      ),
      records: {
        evals: emptyEvals(),
        notes: checkIns("mtg_co", 2, "stk_c1"),
        scope: scope(
          [
            inScope("itm_c1", "Overnight reports from the outage log"),
            inScope("itm_c2", "A one-page summary by 7am"),
            outOfScope("itm_c3", "Customer notifications"),
          ],
          [
            criterion(
              "crt_c1",
              "Summaries ready by 7am",
              "share of weekdays with the summary on time",
              "at_least",
              1,
              null,
            ),
            criterion(
              "crt_c2",
              "Facts that match the log",
              "share of spot checks that match the log",
              "at_least",
              1,
              null,
            ),
          ],
          { by: "stk_c1", daysAgo: 120, current: true },
        ),
        access: [
          access("acc_c1", "Outage log, read only", "sys_c1", "stk_c2", "granted", 130, 125),
        ],
        tasks: [
          // Every task done: in Operate with nothing next, so Today lists it as having no next step.
          task("tsk_c1", "Monthly accuracy spot check", "done", 1, { due: -1, assignee: JONAH }),
          task("tsk_c2", "Handoff notes for the operations team", "done", 30, {
            due: -30,
            assignee: RIYA,
          }),
        ],
        decisions: [
          decision(
            "dec_c1",
            "Operations owns the summary from this month",
            "Handoff complete; the FDE keeps a monthly check.",
            "Arjun Nair",
            14,
          ),
        ],
      },
    },
    {
      project: project(
        "prj_cobalt_field",
        "cmp_cobalt",
        "Field crew handbook search",
        "deploy",
        8,
        "Lets field crews search safety procedures from a phone, offline-first.",
      ),
      records: {
        evals: emptyEvals(),
        notes: checkIns("mtg_cf", 2, "stk_c2"),
        scope: scope(
          [
            inScope("itm_f1", "The 2026 safety handbook"),
            inScope("itm_f2", "Search on crew phones"),
            outOfScope("itm_f3", "Older handbooks"),
            outOfScope("itm_f4", "Writing new procedures"),
          ],
          [
            criterion(
              "crt_f1",
              "Right procedure in the top three",
              "share of questions answered in the top three",
              "at_least",
              0.92,
              null,
            ),
          ],
          { by: "stk_c1", daysAgo: 60, current: true },
        ),
        access: [
          access(
            "acc_f1",
            "Mobile device management enrolment",
            "sys_c2",
            "stk_c2",
            "in_progress",
            9,
          ),
          access("acc_f2", "Crew roster export", null, "stk_c3", "revoked", 30, 2),
        ],
        tasks: [
          task("tsk_f1", "Roll out to the north depot crews", "blocked", 4, {
            due: -4,
            assignee: JONAH,
            blocker: "Mobile device management access still in progress",
            blockedBy: "acc_f1",
          }),
          task("tsk_f2", "Crew training video", "in_progress", 1, { due: 7, assignee: JONAH }),
        ],
        decisions: [],
      },
    },
  ]

  const me: z.input<typeof Me> = {
    user: { id: RIYA, name: "Riya Kapoor" },
    organisation: { id: "org_northlight", name: "Northlight FDE" },
    role: "admin",
  }
  // Who is assigned to a project is read from the company's team until someone changes it.
  const assignees: Record<string, Array<S["AssigneeOut"]>> = {}
  // A workspace with no company yet, to see the first minute: `globalThis.__fdeMockNoCompanies = true`
  // before the app loads (`pnpm shots` does), or `resetMockApi({ empty: true })`.
  if ((globalThis as Record<string, unknown>).__fdeMockNoCompanies === true) {
    companies.length = 0
    projects.length = 0
  }
  // Eval suites and runs for the projects that have them; the rest have none.
  const evals = seedEvals()
  for (const p of projects) p.records.evals = evals[p.project.id] ?? p.records.evals
  // Setups by caller and `Idempotency-Key`: the body's bytes and what they made.
  const setups: Record<string, { json: string; company: string; project: string }> = {}
  return {
    me,
    companies,
    projects,
    runs: seedRuns(),
    assignees,
    documents: seedDocuments(),
    setups,
  }
}

let state = seed()

/**
 * Tests only: fresh sample data, signed in or out. `engineer: true` signs in as an engineer, not an
 * organisation admin: only the companies they are on, and only what a lead or engineer may change.
 * `empty: true` leaves no company.
 */
export function resetMockApi({
  signedIn = true,
  engineer = false,
  empty = false,
}: { signedIn?: boolean; engineer?: boolean; empty?: boolean } = {}) {
  state = seed()
  homeDismissed = new Map()
  if (empty) {
    state.companies.length = 0
    state.projects.length = 0
  }
  if (engineer) state.me = { ...state.me, role: "member" }
  setSession(signedIn)
  resetMockSignIn()
}

function setSession(on: boolean) {
  try {
    if (on) sessionStorage.setItem(SESSION_KEY, "1")
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // Blocked storage: the mock session lasts until the next load.
  }
}

function hasSession() {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1"
  } catch {
    return false
  }
}

const LATENCY_MS = import.meta.env.MODE === "test" ? 0 : 150

/** An answer as the API writes it: JSON, and a copy, so callers never share mock state. */
const json = (body: unknown, status = 200) => Response.json(structuredClone(body), { status })
const refuse = (status: number, error: string) => Response.json({ error }, { status })
/** A body the API's JSON extractor cannot read: a 422 with axum's plain-text reason, no error code. */
const unreadable = (why: string) =>
  new Response(`Failed to deserialize the JSON body into the target type: ${why}`, {
    status: 422,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })

// ── Versions ───────────────────────────────────────────────────────────────
// What the API does with the `version` of a whole-record save (#172): every change moves a record's
// version on, whoever makes it (the API's trigger, so an engine-style change such as unblocking
// counts); a save that names a version the record has left is a 409 `stale_version` with the record
// as it stands; one that changes nothing answers with the record unchanged; and a create names none.

type Versioned = { version?: number }

/**
 * The version a save names: none, a number, or the 400 for a bad one. A create names none, and a
 * version is a whole number from 0.
 */
function claimed(body: { version?: unknown }, adding: boolean): number | undefined | Response {
  const v = body.version
  if (v === undefined || v === null) return undefined
  if (adding || typeof v !== "number" || !Number.isInteger(v) || v < 0)
    return refuse(400, "invalid_version")
  return v
}

/** The same record, changed by something: one version on. */
const bump = <T extends Versioned>(record: T, change: Partial<T>): T => ({
  ...record,
  ...change,
  version: (record.version ?? 0) + 1,
})

/** The 409 for a save made on a version the record has left, with the record as it stands. */
const refuseStale = (current: unknown) => json({ error: "stale_version", current }, 409)

/** Whether the fields named are the same on both: a missing one is none. */
const sameFields = <T>(a: T, b: T, keys: ReadonlyArray<keyof T>) =>
  keys.every((key) => (a[key] ?? null) === (b[key] ?? null))

/**
 * Dev and test only, like everything here: `globalThis.__fdeMockSomeoneElse = true` makes someone
 * else change the record a versioned save is about, once, just before that save is checked, so the
 * save finds it moved on and is refused as stale. An object is the change to make (fields of the
 * record, or for a sign-off the item they add); `true` makes a small default one. Not set in a
 * production build, which has no mock.
 */
function someoneElse(): Record<string, unknown> | null {
  const g = globalThis as Record<string, unknown>
  const wanted = g.__fdeMockSomeoneElse
  if (!wanted) return null
  delete g.__fdeMockSomeoneElse
  return wanted === true ? {} : (wanted as Record<string, unknown>)
}

const projectsOf = (companyId: string) =>
  state.projects.filter((p) => p.project.company === companyId)

/** A project as the API reads it: `next_step` is worked out from its tasks on every read. */
const projectOut = (p: { project: S["ProjectOut"]; records: Records }): S["ProjectOut"] => ({
  ...p.project,
  next_step: nextStepOf(p.records.tasks),
})

/** The caller's role at a company: a member's, or `admin` for an organisation admin who is not one. */
function roleAt(c: CompanySeed): S["CallerRole"] | null {
  const own = c.members.find((m) => m.user === state.me.user.id)?.role
  return own ?? (state.me.role === "admin" ? "admin" : null)
}

/** The API's `manage` (a company's lead, or an organisation admin) and `work` (any member, or an admin). */
const mayManage = (c: CompanySeed) => roleAt(c) === "admin" || roleAt(c) === "lead"
const mayWork = (c: CompanySeed) => roleAt(c) !== null

/** `GET /v1/companies`: each company with the caller's role and its project summaries. */
function companyList(): Array<S["CompanySummaryOut"]> {
  return state.companies
    .filter((c) => roleAt(c) !== null)
    .map((c) => ({
      ...c.company,
      role: roleAt(c),
      projects: projectsOf(c.company.id).map(({ project: p }) => ({
        id: p.id,
        name: p.name,
        stage: p.stage,
      })),
    }))
}

/**
 * `GET /v1/today`: tasks not done and access not granted, with names to show them by, and the projects
 * with no next step (every task done, or none).
 */
function today(): S["TodayOut"] {
  const mine = state.companies.filter((c) => roleAt(c) !== null)
  const projects_without_next_step = mine.flatMap((c) =>
    projectsOf(c.company.id)
      .filter((p) => nextStepOf(p.records.tasks) === null)
      .map(({ project: p }) => ({
        company: { id: c.company.id, name: c.company.name },
        project: { id: p.id, name: p.name },
      })),
  )
  const items = state.companies
    .filter((c) => roleAt(c) !== null)
    .flatMap((c) =>
      projectsOf(c.company.id).flatMap(({ project: p, records }) => {
        const where = {
          company: { id: c.company.id, name: c.company.name },
          project: { id: p.id, name: p.name },
        }
        const name = (id: string | null | undefined) =>
          c.stakeholders.find((s) => s.id === id)?.name ?? null
        return [
          ...records.tasks
            .filter((t) => t.status !== "done")
            .map((t): S["TodayItemOut"] => ({ kind: "task", task: t, ...where })),
          ...records.access
            .filter((a) => a.status !== "granted")
            .map((a): S["TodayItemOut"] => ({
              kind: "access_request",
              access: a,
              owner: name(a.owner),
              ...where,
            })),
        ]
      }),
    )
  return { items, projects_without_next_step }
}

type HomeSuggestion = S["HomeSuggestionOut"] & { facts: string }

/**
 * `GET /v1/home`'s suggestions before dismissals, built from Today's facts as the API builds them
 * (`home.rs`): what is due across every project, then per project access waiting, blocked tasks and
 * no next step, in that order, the more pressing first. `facts` is the kind and its sorted ids.
 */
function homeSuggestions(): Array<HomeSuggestion> {
  const { items, projects_without_next_step = [] } = today()
  const now = day(0)
  const due = items.flatMap((i) =>
    i.kind === "task" && i.task.due_on && i.task.due_on <= now ? [i.task.id] : [],
  )
  const facts = (kind: string, ids: Array<string>) => [kind, ...[...ids].sort()].join("\n")
  const all: Array<HomeSuggestion & { weight: [number, number] }> = []
  if (due.length > 0)
    all.push({
      id: "due_today",
      kind: "due_today",
      count: due.length,
      route: "/today",
      facts: facts("due_today", due),
      weight: [due.length, 0],
    })
  type Place = { company: S["NamedOut"]; project: S["NamedOut"] }
  const places = new Map<string, Place>()
  for (const p of [...items, ...projects_without_next_step]) places.set(p.project.id, p)
  for (const where of places.values()) {
    const here = items.filter((i) => i.project.id === where.project.id)
    const one = (
      kind: S["HomeKind"],
      ids: Array<string>,
      weight: [number, number],
      days?: number,
    ) =>
      all.push({
        id: `${kind}.${where.project.id}`,
        kind,
        count: ids.length,
        days: days ?? null,
        company: where.company,
        project: where.project,
        route: `/companies/${where.company.id}/projects/${where.project.id}`,
        facts: facts(kind, ids),
        weight,
      })
    const waiting = here.flatMap((i) =>
      i.kind === "access_request" && ["requested", "in_progress"].includes(i.access.status)
        ? [i.access]
        : [],
    )
    if (waiting.length > 0) {
      const longest = Math.max(...waiting.map((a) => a.days_waiting))
      one(
        "access_waiting",
        waiting.map((a) => a.id),
        [longest, waiting.length],
        longest,
      )
    }
    const blocked = here.flatMap((i) =>
      i.kind === "task" && i.task.status === "blocked" ? [i.task.id] : [],
    )
    if (blocked.length > 0) one("blocked_tasks", blocked, [blocked.length, 0])
    if (projects_without_next_step.some((p) => p.project.id === where.project.id))
      one("no_next_step", [where.project.id], [0, 0])
  }
  const rank: Array<S["HomeKind"]> = [
    "due_today",
    "access_waiting",
    "blocked_tasks",
    "no_next_step",
  ]
  const name = (s: HomeSuggestion) => `${s.company?.name ?? ""}\n${s.project?.name ?? ""}`
  return all
    .sort(
      (a, b) =>
        rank.indexOf(a.kind) - rank.indexOf(b.kind) ||
        b.weight[0] - a.weight[0] ||
        b.weight[1] - a.weight[1] ||
        name(a).localeCompare(name(b)),
    )
    .map(({ weight: _, ...s }) => s)
}

/** This person's dismissed home suggestions: id to the facts it was dismissed with. */
let homeDismissed = new Map<string, string>()

/** `GET /v1/home`: at most five, a dismissed one hidden until its facts change. */
function home(): S["HomeOut"] {
  const all = homeSuggestions()
  // A dismissal whose suggestion has gone is forgotten, so it shows again if it comes back.
  for (const id of homeDismissed.keys()) if (!all.some((s) => s.id === id)) homeDismissed.delete(id)
  const suggestions = all
    .filter((s) => homeDismissed.get(s.id) !== s.facts)
    .slice(0, 5)
    .map(({ facts: _, ...s }) => s)
  return { suggestions }
}

/** `POST /v1/home/suggestions/{id}/dismiss`: only a suggestion the person has now. */
function dismissHome(id: string) {
  const found = homeSuggestions().find((s) => s.id === id)
  if (!found) return refuse(404, "not_found")
  homeDismissed.set(id, found.facts)
  return new Response(null, { status: 204 })
}

const TASK_FIELDS = [
  "title",
  "status",
  "blocker",
  "due_on",
  "assignee",
  "waiting_on",
  "blocked_by",
  "criterion",
  "stage",
] as const
const TASK_STATES = ["todo", "in_progress", "waiting_on_customer", "blocked", "done"] as const
let taskCount = 0

// A plain string of 1 to `max` characters, as the API's `Name` and `Text` types take it (no control
// character by Rust's `char::is_control`: C0, DEL and C1; text keeps newlines and tabs).
const plain = (value: unknown, max: number, lines: boolean) =>
  typeof value === "string" &&
  [...value.trim()].length >= 1 &&
  [...value.trim()].length <= max &&
  // eslint-disable-next-line no-control-regex
  !(lines ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(
    value.trim(),
  )

/** `POST`, `PUT` and `DELETE` on a project's tasks, with the checks the API makes on a task. */
async function taskRoutes(
  method: string,
  taskId: string | undefined,
  found: CompanySeed,
  records: Records,
  request: Request,
) {
  const tasks = records.tasks
  const at = taskId === undefined ? -1 : tasks.findIndex((t) => t.id === taskId)
  if (method === "DELETE" && taskId !== undefined) {
    if (at < 0) return refuse(404, "not_found")
    tasks.splice(at, 1)
    return new Response(null, { status: 204 })
  }
  const adding = method === "POST" && taskId === undefined
  if (!adding && !(method === "PUT" && taskId !== undefined)) return null
  const body = (await request.json().catch(() => null)) as Partial<S["TaskBody"]> | null
  if (!body) return refuse(400, "invalid")
  // The API's body does not deserialize with a stage that is not one of the eight: axum's 422, in plain text.
  const stage = body.stage ?? null
  if (stage !== null && !STAGES.includes(stage)) return unreadable("stage: unknown variant")
  const version = claimed(body, adding)
  if (version instanceof Response) return version
  const status = TASK_STATES.find((one) => one === body.status)
  if (!plain(body.title, 200, false)) return refuse(400, "invalid_title")
  if (!status) return refuse(400, "invalid_status")
  // A place is next to one task: never both sides.
  if (body.before != null && body.after != null) return refuse(400, "invalid_place")
  const blocker = body.blocker ?? null
  if (blocker !== null && !plain(blocker, 4000, true)) return refuse(400, "invalid_blocker")
  const due = body.due_on ?? null
  if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return refuse(400, "invalid_due_on")
  const assignee = body.assignee ?? null
  if (assignee !== null && !worksOn(found, records, assignee))
    return refuse(400, "invalid_assignee")
  const waitingOn = body.waiting_on ?? null
  if (waitingOn !== null && !found.stakeholders.some((x) => x.id === waitingOn))
    return refuse(400, "invalid_waiting_on")
  const blockedBy = body.blocked_by ?? null
  if (status === "blocked" && blocker === null) return refuse(409, "rejected_blocker_required")
  if (blockedBy !== null && status !== "blocked")
    return refuse(409, "rejected_blocked_by_needs_blocked")
  // The API takes only an access request of this project; one that is missing or another's is a 400.
  if (blockedBy !== null && !records.access.some((a) => a.id === blockedBy))
    return refuse(400, "invalid_blocked_by")
  if (!adding && at < 0) return refuse(404, "not_found")

  const now = new Date().toISOString()
  let before = adding ? undefined : tasks[at]
  if (before && version !== undefined) {
    const other = someoneElse()
    if (other) {
      const to =
        (other.status as S["TaskState"] | undefined) ??
        (before.status === "in_progress" ? "todo" : "in_progress")
      // Someone moved it: what the old status held (a blocker, a person it waited on) goes with it.
      before = tasks[at] = bump(before, {
        blocker: to === "blocked" ? (before.blocker ?? "Blocked by a teammate") : null,
        blocked_by: null,
        waiting_on: to === "waiting_on_customer" ? before.waiting_on : null,
        waiting_since: to === "waiting_on_customer" ? (before.waiting_since ?? now) : null,
        ...other,
        status: to,
        updated_at: now,
      })
    }
    if (version !== before.version) return refuseStale(before)
  }
  // Checked after the version, as the API's store does: one of this project's own criteria.
  const towards = body.criterion ?? null
  if (towards !== null && !records.scope.criteria.some((c) => c.id === towards))
    return refuse(400, "invalid_criterion")
  // The anchor is another task of this project, with the status this one will have.
  const side = body.before != null ? "before" : body.after != null ? "after" : null
  const anchorId = body.before ?? body.after ?? null
  if (side) {
    const anchor = tasks.find((t) => t.id === anchorId)
    if (!anchor || anchor.id === before?.id || anchor.status !== status)
      return refuse(400, `invalid_${side}`)
  }
  // Whether it already stands there: no place named, or right beside the anchor in its own column.
  let atPlace = side === null
  if (side && before?.status === status) {
    const column = tasks.filter((t) => t.status === status)
    const self = column.findIndex((t) => t.id === before.id)
    const next = column.findIndex((t) => t.id === anchorId)
    atPlace = side === "after" ? self === next + 1 : self === next - 1
  }
  const saved: S["TaskOut"] = {
    id: before?.id ?? `tsk_new${++taskCount}`,
    title: body.title!.trim(),
    status,
    blocker: blocker?.trim() ?? null,
    due_on: due,
    assignee,
    waiting_on: waitingOn,
    // The API keeps the first time a task started waiting.
    waiting_since: status === "waiting_on_customer" ? (before?.waiting_since ?? now) : null,
    blocked_by: blockedBy,
    criterion: towards,
    // Left out, it is cleared, as every other replaced field is.
    stage,
    created_at: before?.created_at ?? now,
    updated_at: now,
    version: (before?.version ?? 0) + 1,
  }
  // A save that changes nothing, where it already stands, is not a change: the task is answered as it
  // is, version and all. A repeated move is one.
  if (before && atPlace && sameFields(before, saved, TASK_FIELDS)) return json(before)
  // The array is the project's order. A place puts it beside its anchor; without one, a new task or a
  // change of status goes to the end, and any other save keeps its place.
  if (before && atPlace && before.status === status) {
    tasks[at] = saved
  } else {
    if (before) tasks.splice(at, 1)
    const anchor = tasks.findIndex((t) => t.id === anchorId)
    if (side) tasks.splice(side === "after" ? anchor + 1 : anchor, 0, saved)
    else tasks.push(saved)
  }
  return json(saved, adding ? 201 : 200)
}

const ACCESS_FIELDS = ["description", "system", "owner", "status"] as const
let accessCount = 0
let decisionCount = 0
const ACCESS_STATES = ["requested", "in_progress", "granted", "denied", "revoked"] as const

/** `PUT` on an access request: the API replaces it, stamps a status change and sets or clears `granted_at`. */
async function accessRoutes(
  method: string,
  id: string | undefined,
  found: CompanySeed,
  records: Records,
  request: Request,
) {
  const adding = method === "POST" && id === undefined
  if (!adding && !(method === "PUT" && id !== undefined)) return null
  const body = (await request.json().catch(() => null)) as Partial<S["AccessRequestBody"]> | null
  if (!body) return refuse(400, "invalid")
  const version = claimed(body, adding)
  if (version instanceof Response) return version
  const status = ACCESS_STATES.find((one) => one === body.status)
  if (!status) return refuse(400, "invalid_status")
  if (!plain(body.description, 4000, true)) return refuse(400, "invalid_description")
  const owner = body.owner ?? null
  if (owner !== null && !found.stakeholders.some((x) => x.id === owner))
    return refuse(400, "invalid_owner")
  const systemId = body.system ?? null
  if (systemId !== null && !found.systems.some((x) => x.id === systemId))
    return refuse(400, "invalid_system")
  if (adding) {
    // A request starts as requested or in progress: a status change is what reports it settled.
    if (status !== "requested" && status !== "in_progress")
      return refuse(409, "rejected_initial_status")
    const now = new Date().toISOString()
    const created: S["AccessRequestOut"] = {
      id: `acc_new${++accessCount}`,
      description: body.description!.trim(),
      system: systemId,
      owner,
      status,
      requested_at: now,
      status_changed_at: now,
      granted_at: null,
      days_waiting: 0,
      version: 1,
    }
    records.access.push(created)
    return json(created, 201)
  }
  if (id === undefined) return null
  const at = records.access.findIndex((a) => a.id === id)
  let before = records.access[at]
  if (!before) return refuse(404, "not_found")

  const now = new Date().toISOString()
  /** The request replaced by `content`: a status change stamps the clock and sets or clears `granted_at`. */
  const replaced = (
    from: S["AccessRequestOut"],
    content: Pick<S["AccessRequestOut"], "description" | "system" | "owner" | "status">,
  ): S["AccessRequestOut"] => {
    const changed = from.status !== content.status
    const open = content.status === "requested" || content.status === "in_progress"
    const changedAt = changed ? now : from.status_changed_at
    const grantedAt = !changed
      ? from.granted_at
      : content.status === "granted"
        ? now
        : open
          ? null
          : from.granted_at
    return {
      id,
      ...content,
      requested_at: from.requested_at,
      status_changed_at: changedAt,
      granted_at: grantedAt,
      days_waiting: Math.floor(
        (Date.parse(open ? now : (grantedAt ?? changedAt)) - Date.parse(from.requested_at)) /
          86_400_000,
      ),
      version: (from.version ?? 0) + 1,
    }
  }
  if (version !== undefined) {
    const other = someoneElse()
    if (other) {
      const to =
        (other.status as S["AccessState"] | undefined) ??
        (before.status === "in_progress" ? "requested" : "in_progress")
      before = records.access[at] = replaced(before, { ...before, ...other, status: to })
    }
    if (version !== before.version) return refuseStale(before)
  }
  const content = {
    description: body.description!.trim(),
    system: systemId,
    owner,
    status,
  }
  const saved = replaced(before, content)
  // A save that changes nothing is not a change: the request is answered as it is, version and all.
  if (sameFields(before, saved, ACCESS_FIELDS)) return json(before)
  const changed = before.status !== status
  records.access[at] = saved
  // The API's rules put the tasks blocked on a request that is granted back to do, a moment later.
  // Each is a change to the task, so its version moves on.
  if (changed && status === "granted")
    records.tasks.forEach((t, i) => {
      if (t.blocked_by !== id) return
      records.tasks[i] = bump(t, {
        status: "todo",
        blocker: null,
        blocked_by: null,
        updated_at: now,
      })
    })
  return json(saved)
}

/** `POST` on a project's decisions: the log is append-only, so there is no `PUT` or `DELETE`. */
async function decisionRoutes(
  method: string,
  id: string | undefined,
  records: Records,
  request: Request,
) {
  if (method !== "POST" || id !== undefined) return null
  const body = (await request.json().catch(() => null)) as Partial<S["DecisionBody"]> | null
  if (!body) return refuse(400, "invalid")
  if (!plain(body.title, 200, false)) return refuse(400, "invalid_title")
  if (!plain(body.rationale, 4000, true)) return refuse(400, "invalid_rationale")
  if (!plain(body.decided_by, 200, false)) return refuse(400, "invalid_decided_by")
  const at = body.decided_at ?? null
  // RFC 3339, as the API parses it.
  if (at !== null && !(/^\d{4}-\d{2}-\d{2}T/.test(at) && !Number.isNaN(Date.parse(at))))
    return refuse(400, "invalid_decided_at")
  const now = new Date().toISOString()
  const saved: S["DecisionOut"] = {
    id: `dec_new${++decisionCount}`,
    title: body.title!.trim(),
    rationale: body.rationale!.trim(),
    decided_by: body.decided_by!.trim(),
    decided_at: at === null ? now : new Date(at).toISOString(),
    recorded_by: state.me.user.id,
    created_at: now,
  }
  records.decisions.push(saved)
  return json(saved, 201)
}

let noteCount = 0
// A note's words: 1 to 20,000 characters once trimmed, no control character (C0 or C1) but newline and tab.
// eslint-disable-next-line no-control-regex
const NOTE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
const MAX_PEOPLE = 50

/** The latest meeting first, a note written later first among one day's. */
const latestFirst = (list: Array<S["MeetingNoteOut"]>) =>
  [...list].sort(
    (a, b) =>
      b.held_on.localeCompare(a.held_on) ||
      Date.parse(b.created_at) - Date.parse(a.created_at) ||
      a.id.localeCompare(b.id),
  )

/** Whether a user works on the company: a member of it, or an organisation admin (who reaches every company). */
const worksAt = (found: CompanySeed, user: unknown) =>
  found.members.some((m) => m.user === user) ||
  (user === state.me.user.id && state.me.role === "admin")

/** Whether a user works on a project: on its company, or assigned to it (the API's `fde_project.work`). */
function worksOn(found: CompanySeed, records: Records, user: unknown) {
  if (worksAt(found, user)) return true
  const p = state.projects.find((x) => x.records === records)
  return p !== undefined && assigneesOf(found, p.project.id).some((a) => a.user === user)
}

/**
 * A company's or a project's meeting notes, with the API's rules: a `PUT` replaces the whole note, the
 * fields are checked one by one in the API's order, each attendee must work on the company and each
 * stakeholder must be in it. All of it needs `work`, which the caller has here.
 */
async function noteRoutes(
  method: string,
  id: string | undefined,
  found: CompanySeed,
  notes: Array<S["MeetingNoteOut"]>,
  request: Request,
  records?: Records,
) {
  const at = id === undefined ? -1 : notes.findIndex((n) => n.id === id)
  if (method === "GET") {
    if (id === undefined) return json(latestFirst(notes))
    return at < 0 ? refuse(404, "not_found") : json(notes[at])
  }
  if (method === "DELETE" && id !== undefined) {
    if (at < 0) return refuse(404, "not_found")
    notes.splice(at, 1)
    return noContent()
  }
  const adding = method === "POST" && id === undefined
  if (!adding && !(method === "PUT" && id !== undefined)) return null
  const b = await readBody(request)
  if (!b) return refuse(400, "invalid")
  const people = (value: unknown) =>
    Array.isArray(value) && value.every((x) => typeof x === "string") ? value : []
  const stakeholders = people(b.stakeholders)
  const attendees = people(b.attendees)
  if (stakeholders.length > MAX_PEOPLE) return refuse(400, "invalid_stakeholders")
  if (attendees.length > MAX_PEOPLE) return refuse(400, "invalid_attendees")
  if (!plain(b.title, 200, false)) return refuse(400, "invalid_title")
  const heldOn = typeof b.held_on === "string" ? b.held_on : ""
  if (!/^\d{4}-\d{2}-\d{2}$/.test(heldOn) || Number.isNaN(Date.parse(heldOn)))
    return refuse(400, "invalid_held_on")
  const text = typeof b.body === "string" ? b.body.trim() : ""
  if ([...text].length < 1 || [...text].length > 20_000 || NOTE_CONTROL.test(text))
    return refuse(400, "invalid_body")
  // On a project, its assignees work there too.
  const works = (user: unknown) => (records ? worksOn(found, records, user) : worksAt(found, user))
  if (!attendees.every(works)) return refuse(400, "invalid_attendees")
  if (!stakeholders.every((one) => found.stakeholders.some((x) => x.id === one)))
    return refuse(400, "invalid_stakeholders")
  if (!adding && at < 0) return refuse(404, "not_found")

  const now = new Date().toISOString()
  const before = adding ? undefined : notes[at]
  const saved: S["MeetingNoteOut"] = {
    id: before?.id ?? `mtg_new${++noteCount}`,
    title: (b.title as string).trim(),
    held_on: heldOn,
    body: text,
    stakeholders: [...new Set(stakeholders)].sort(),
    attendees: [...new Set(attendees)].sort(),
    created_by: before?.created_by ?? state.me.user.id,
    created_at: before?.created_at ?? now,
    updated_at: now,
  }
  if (before) notes[at] = saved
  else notes.push(saved)
  return json(saved, adding ? 201 : 200)
}

/** The log as the API lists it: the newest decision first. */
const newestFirst = (list: Array<S["DecisionOut"]>) =>
  [...list].sort(
    (a, b) => Date.parse(b.decided_at) - Date.parse(a.decided_at) || a.id.localeCompare(b.id),
  )

const noContent = () => new Response(null, { status: 204 })
const readBody = async (request: Request) =>
  (await request.json().catch(() => null)) as Record<string, unknown> | null
/** A field that may be left out or null, but is refused when it is there and wrong. */
const badOptional = (value: unknown, max: number, lines: boolean) =>
  value !== undefined && value !== null && !plain(value, max, lines)
const trimmed = (value: unknown) => (typeof value === "string" ? value.trim() || null : null)
// The API's address rule in short: one @, a dotted domain, no spaces, 254 characters at most.
const validEmail = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === "string" &&
    value.trim().length <= 254 &&
    /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim()))
const STAKEHOLDER_FIELDS = ["name", "role", "title", "email"] as const
const SYSTEM_FIELDS = ["name", "kind", "description"] as const
const PARTS = ["sponsor", "champion", "user", "it", "security", "other"] as const
let recordCount = 0

/** `POST /v1/companies`: any member of the organisation may; the caller becomes its lead. */
async function createCompany(request: Request) {
  const b = await readBody(request)
  if (!b) return refuse(400, "invalid")
  if (!plain(b.name, 200, false)) return refuse(400, "invalid_name")
  if (badOptional(b.industry, 200, false)) return refuse(400, "invalid_industry")
  if (badOptional(b.region, 200, false)) return refuse(400, "invalid_region")
  if (badOptional(b.summary, 4000, true)) return refuse(400, "invalid_summary")
  const now = new Date().toISOString()
  const created: CompanySeed = {
    company: {
      id: `cmp_new${++recordCount}`,
      name: (b.name as string).trim(),
      industry: trimmed(b.industry),
      region: trimmed(b.region),
      summary: trimmed(b.summary),
      created_at: now,
      updated_at: now,
    },
    notes: [],
    members: [{ user: state.me.user.id, role: "lead", added_at: now }],
    stakeholders: [],
    systems: [],
  }
  state.companies.push(created)
  return json(created.company, 201)
}

// ── Setup in one call ──────────────────────────────────────────────────────
// `POST /v1/companies/setup` (#246, `setup.rs`): every part checked by its own route's rules and
// made by its own route here, all or nothing, with the `Idempotency-Key` claimed by caller and key.

const MAX_SETUP = { stakeholders: 20, scope_items: 30, criteria: 20, plan: 30 } as const
const SETUP_KEY = /^[A-Za-z0-9_-]{1,128}$/

type Fields = Record<string, unknown>
const isObject = (v: unknown): v is Fields =>
  typeof v === "object" && v !== null && !Array.isArray(v)
/** Only `allowed` keys: the API's bodies deny unknown fields at every level. */
const only = (v: unknown, allowed: ReadonlyArray<string>): v is Fields =>
  isObject(v) && Object.keys(v).every((k) => allowed.includes(k))
const isText = (v: unknown) => typeof v === "string"
const maybe = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || v === null || ok(v)
const isIndex = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0
const isVersion = (v: unknown) => maybe(v, (x) => typeof x === "number" && Number.isInteger(x))
const listOf = (v: unknown, each: (x: unknown) => boolean) =>
  v === undefined || (Array.isArray(v) && v.every(each))

/**
 * Whether serde would read the body at all: the right keys and types at every level, and enums it
 * knows. Anything else is the API's 400 `invalid_body`, before any part's own rules.
 */
type SetupShape = {
  company: Fields
  project: Fields
  stakeholders?: Array<Fields>
  main_contact?: number | null
  scope_items?: Array<Fields>
  criteria?: Array<Fields>
  plan?: Array<Fields>
}

function setupShape(b: unknown): b is SetupShape {
  const top = [
    "company",
    "project",
    "stakeholders",
    "main_contact",
    "scope_items",
    "criteria",
    "plan",
  ]
  if (!only(b, top) || !isObject(b.company) || !isObject(b.project)) return false
  const companyIn = b.company
  const projectIn = b.project
  return (
    only(companyIn, ["name", "industry", "region", "summary"]) &&
    isText(companyIn.name) &&
    ["industry", "region", "summary"].every((k) => maybe(companyIn[k], isText)) &&
    only(projectIn, ["name", "summary"]) &&
    isText(projectIn.name) &&
    maybe(projectIn.summary, isText) &&
    listOf(
      b.stakeholders,
      (s) =>
        only(s, ["name", "role", "title", "email", "version"]) &&
        isText(s.name) &&
        (s.role === undefined || PARTS.some((p) => p === s.role)) &&
        maybe(s.title, isText) &&
        maybe(s.email, isText) &&
        isVersion(s.version),
    ) &&
    maybe(b.main_contact, isIndex) &&
    listOf(
      b.scope_items,
      (i) =>
        only(i, ["kind", "description", "version"]) &&
        KINDS.some((k) => k === i.kind) &&
        isText(i.description) &&
        isVersion(i.version),
    ) &&
    listOf(
      b.criteria,
      (c) =>
        only(c, [
          "description",
          "metric",
          "comparator",
          "target",
          "unit",
          "baseline",
          "proof",
          "version",
        ]) &&
        isText(c.description) &&
        isText(c.metric) &&
        COMPARATORS.some((x) => x === c.comparator) &&
        typeof c.target === "number" &&
        maybe(c.unit, isText) &&
        maybe(c.baseline, (x) => typeof x === "number") &&
        maybe(c.proof, isText) &&
        isVersion(c.version),
    ) &&
    listOf(
      b.plan,
      (t) =>
        only(t, ["title", "stage", "due_on", "criterion"]) &&
        isText(t.title) &&
        maybe(t.stage, (x) => STAGES.some((st) => st === x)) &&
        maybe(t.due_on, isText) &&
        maybe(t.criterion, isIndex),
    )
  )
}

/** A body for one of the mock's own routes, as that route would be sent it. */
const asRequest = (body: unknown) =>
  new Request("http://mock.invalid/", { method: "POST", body: JSON.stringify(body) })

/** The setup as it stands: the company, its first project, its people, the scope and the plan. */
function setupOut(companyId: string, projectId: string): S["SetupOut"] | null {
  const found = state.companies.find((c) => c.company.id === companyId)
  const p = state.projects.find((x) => x.project.id === projectId)
  if (!found || !p) return null
  return {
    company: found.company,
    project: projectOut(p),
    stakeholders: found.stakeholders,
    scope: p.records.scope,
    plan: p.records.tasks,
  }
}

/** Takes back a company the mock made, and its project: everything a setup makes is inside them. */
function takeBack(companyId: string | null, projectId: string | null) {
  const c = state.companies.findIndex((x) => x.company.id === companyId)
  if (c >= 0) state.companies.splice(c, 1)
  const p = state.projects.findIndex((x) => x.project.id === projectId)
  if (p >= 0) state.projects.splice(p, 1)
  if (projectId) delete state.assignees[projectId]
}

/**
 * Makes what the setup describes through each part's own route, in order. Answers the first refusal,
 * having taken back everything it made: nothing is left of a refused setup.
 */
async function makeSetup(b: SetupShape): Promise<Response | { company: string; project: string }> {
  const made = { company: null as string | null, project: null as string | null }
  const undo = () => takeBack(made.company, made.project)
  // A route that does not answer a `POST` (null) never happens here; it would be the API's 404.
  const step = async (answered: Response | null) => {
    const reply = answered ?? refuse(404, "not_found")
    if (reply.ok) return { id: (await reply.json<{ id: string }>()).id }
    undo()
    return reply
  }
  const madeCompany = await step(await createCompany(asRequest(b.company)))
  if (madeCompany instanceof Response) return madeCompany
  made.company = madeCompany.id
  const found = state.companies.find((c) => c.company.id === madeCompany.id)!
  const people: Array<string> = []
  for (const s of b.stakeholders ?? []) {
    const added = await step(await stakeholderRoutes("POST", undefined, found, asRequest(s)))
    if (added instanceof Response) return added
    people.push(added.id)
  }
  if (typeof b.main_contact === "number") {
    const set = await mainContactRoute(found, asRequest({ stakeholder: people[b.main_contact] }))
    if (!set.ok) {
      undo()
      return set
    }
  }
  const madeProject = await step(
    await projectWrites("POST", undefined, found, asRequest(b.project)),
  )
  if (madeProject instanceof Response) return madeProject
  made.project = madeProject.id
  const p = state.projects.find((x) => x.project.id === madeProject.id)!
  const { scope: scopeOf, tasks } = p.records
  for (const item of b.scope_items ?? []) {
    const added = await step(
      await scopeRoutes("POST", ["items"], found, scopeOf, tasks, asRequest(item)),
    )
    if (added instanceof Response) return added
  }
  const criteria: Array<string> = []
  for (const c of b.criteria ?? []) {
    const added = await step(
      await scopeRoutes("POST", ["criteria"], found, scopeOf, tasks, asRequest(c)),
    )
    if (added instanceof Response) return added
    criteria.push(added.id)
  }
  for (const t of b.plan ?? []) {
    const planned = {
      title: t.title,
      status: "todo",
      stage: t.stage ?? null,
      due_on: t.due_on ?? null,
      criterion: typeof t.criterion === "number" ? criteria[t.criterion] : null,
    }
    const added = await step(
      await taskRoutes("POST", undefined, found, p.records, asRequest(planned)),
    )
    if (added instanceof Response) return added
  }
  return { company: madeCompany.id, project: madeProject.id }
}

/**
 * `POST /v1/companies/setup`, in the API's order: the key, the body's shape, the lists' limits and the
 * places they name, then each part by its own route. Then the claim: a key used before with the same
 * bytes answers that setup with 200 and makes nothing new, and with other bytes is a 409.
 */
async function setUp(request: Request) {
  // Dev and test only: `globalThis.__fdeMockRefuseSetup = "forbidden"` refuses the next setup once with
  // that code: a 403 for `forbidden`, a 400 for any other (the forms catch those before they are sent).
  const g = globalThis as Record<string, unknown>
  const refused = g.__fdeMockRefuseSetup
  if (typeof refused === "string") {
    delete g.__fdeMockRefuseSetup
    return refuse(refused === "forbidden" ? 403 : 400, refused)
  }
  const key = request.headers.get("idempotency-key")
  if (key === null || !SETUP_KEY.test(key)) return refuse(400, "invalid_idempotency_key")
  const raw = await request.text()
  let b: unknown
  try {
    b = JSON.parse(raw)
  } catch {
    return refuse(400, "invalid_body")
  }
  if (!setupShape(b)) return refuse(400, "invalid_body")
  for (const list of ["stakeholders", "scope_items", "criteria", "plan"] as const)
    if ((b[list]?.length ?? 0) > MAX_SETUP[list]) return refuse(400, `invalid_${list}`)
  if (typeof b.main_contact === "number" && b.main_contact >= (b.stakeholders?.length ?? 0))
    return refuse(400, "invalid_main_contact")
  if (
    (b.plan ?? []).some(
      (t) => typeof t.criterion === "number" && t.criterion >= (b.criteria?.length ?? 0),
    )
  )
    return refuse(400, "invalid_criterion")
  // ponytail: the API checks every part before it writes, the mock as it makes each one, so with two
  // parts wrong the mock may name another one first. Each part's own rules are the same.
  const claim = `${state.me.user.id}\u0000${key}`
  const earlier = state.setups[claim]
  const made = await makeSetup(b)
  if (made instanceof Response) return made
  if (earlier) {
    // The claim is checked once the body is known good, as the API does; this one makes nothing.
    takeBack(made.company, made.project)
    if (earlier.json !== raw) return refuse(409, "rejected_idempotency_key_reused")
    // What it made is shown only to someone who may still see it.
    const found = state.companies.find((c) => c.company.id === earlier.company)
    if (!found || !mayWork(found)) return refuse(403, "forbidden")
    return json(setupOut(earlier.company, earlier.project))
  }
  state.setups[claim] = { json: raw, company: made.company, project: made.project }
  return json(setupOut(made.company, made.project), 201)
}

/** `PATCH`: a field left out stays, `null` clears it (a name cannot be cleared). */
async function patchCompany(found: CompanySeed, request: Request) {
  if (!mayManage(found)) return refuse(403, "forbidden")
  const b = await readBody(request)
  if (!b || Object.keys(b).some((k) => !["name", "industry", "region", "summary"].includes(k)))
    return refuse(400, "invalid")
  if (b.name !== undefined && b.name !== null && !plain(b.name, 200, false))
    return refuse(400, "invalid_name")
  if (badOptional(b.industry, 200, false)) return refuse(400, "invalid_industry")
  if (badOptional(b.region, 200, false)) return refuse(400, "invalid_region")
  if (badOptional(b.summary, 4000, true)) return refuse(400, "invalid_summary")
  const c = found.company
  if (typeof b.name === "string") c.name = b.name.trim()
  if (b.industry !== undefined) c.industry = trimmed(b.industry)
  if (b.region !== undefined) c.region = trimmed(b.region)
  if (b.summary !== undefined) c.summary = trimmed(b.summary)
  c.updated_at = new Date().toISOString()
  return json(c)
}

/**
 * `POST` and `PATCH` on a company's projects. A new project starts at Discover. Creating one is the
 * API's `manage`; changing one is the project's `work` (the caller already has it here).
 */
async function projectWrites(
  method: string,
  projectId: string | undefined,
  found: CompanySeed,
  request: Request,
) {
  if (method === "POST" && !mayManage(found)) return refuse(403, "forbidden")
  const b = await readBody(request)
  if (!b) return refuse(400, "invalid")
  const now = new Date().toISOString()
  if (method === "POST") {
    if (!plain(b.name, 200, false)) return refuse(400, "invalid_name")
    if (badOptional(b.summary, 4000, true)) return refuse(400, "invalid_summary")
    if (Object.keys(b).some((k) => !["name", "summary"].includes(k))) return refuse(400, "invalid")
    const created: S["ProjectOut"] = {
      id: `prj_new${++recordCount}`,
      company: found.company.id,
      name: (b.name as string).trim(),
      stage: "discover",
      summary: trimmed(b.summary),
      created_at: now,
      updated_at: now,
    }
    state.projects.push({ project: created, records: emptyRecords() })
    // The API assigns no one to a new project; a lead or admin reaches it without.
    state.assignees[created.id] = []
    return json({ ...created, next_step: null }, 201)
  }
  const p = projectsOf(found.company.id).find((x) => x.project.id === projectId)
  if (!p) return refuse(404, "not_found")
  if (Object.keys(b).some((k) => !["name", "summary"].includes(k))) return refuse(400, "invalid")
  if (b.name !== undefined && b.name !== null && !plain(b.name, 200, false))
    return refuse(400, "invalid_name")
  if (badOptional(b.summary, 4000, true)) return refuse(400, "invalid_summary")
  if (typeof b.name === "string") p.project.name = b.name.trim()
  if (b.summary !== undefined) p.project.summary = trimmed(b.summary)
  p.project.updated_at = now
  return json(projectOut(p))
}

let scopeCount = 0
const KINDS = ["in", "out"] as const
const ITEM_FIELDS = ["kind", "description"] as const
const CRITERION_FIELDS = [
  "description",
  "metric",
  "comparator",
  "target",
  "unit",
  "baseline",
  "proof",
] as const
const COMPARATORS = ["at_least", "at_most"] as const

/** Every change to the items or criteria moves the version on, and the last sign-off no longer covers it. */
function bumped(current: S["ScopeOut"]) {
  current.version += 1
  current.signed_off = current.sign_off?.version === current.version
}

/**
 * A project's scope writes, with the API's rules: each item and criterion on its own, a `PUT` that
 * replaces it, the record's version and the scope's bumped by every change (a save that changes nothing
 * is not one), a stale record version refused, one sign-off per version, and no sign-off of an empty scope. All of them need `work`, which the caller has here.
 */
async function scopeRoutes(
  method: string,
  rest: Array<string>,
  found: CompanySeed,
  current: S["ScopeOut"],
  tasks: Array<S["TaskOut"]>,
  request: Request,
) {
  const [collection, id] = rest
  const now = new Date().toISOString()
  if (collection === "sign-offs" && method === "POST" && id === undefined) {
    const body = await readBody(request)
    if (!body || typeof body.stakeholder !== "string") return refuse(400, "invalid")
    const version = claimed(body, false)
    if (version instanceof Response) return version
    // The version is checked first: a scope that moved on since it was read is never signed.
    if (version !== undefined) {
      const other = someoneElse()
      if (other) {
        current.items.push({
          id: `itm_new${++scopeCount}`,
          kind: "in",
          description:
            typeof other.description === "string"
              ? other.description
              : "Added by a teammate while this was open.",
          updated_at: now,
          version: 1,
        })
        bumped(current)
      }
      if (version !== current.version) return refuseStale(current)
    }
    if (current.items.length === 0 && current.criteria.length === 0)
      return refuse(409, "rejected_empty_scope")
    if (!found.stakeholders.some((x) => x.id === body.stakeholder))
      return refuse(400, "invalid_stakeholder")
    if (current.sign_off?.version === current.version) return refuse(409, "conflict")
    const signed: S["SignOffOut"] = {
      version: current.version,
      stakeholder: body.stakeholder,
      recorded_by: state.me.user.id,
      signed_at: now,
    }
    current.sign_off = signed
    current.signed_off = true
    return json(signed, 201)
  }
  if (collection !== "items" && collection !== "criteria") return null
  const list: Array<{ id: string }> = collection === "items" ? current.items : current.criteria
  const at = id === undefined ? -1 : list.findIndex((x) => x.id === id)
  if (method === "DELETE" && id !== undefined) {
    if (at < 0) return refuse(404, "not_found")
    list.splice(at, 1)
    bumped(current)
    // Removing a criterion unlinks its tasks (`on delete set null`), a change to each: their versions move on.
    if (collection === "criteria")
      tasks.forEach((t, i) => {
        if (t.criterion === id) tasks[i] = bump(t, { criterion: null })
      })
    return noContent()
  }
  const adding = method === "POST" && id === undefined
  if (!adding && !(method === "PUT" && id !== undefined)) return null
  const body = await readBody(request)
  if (!body) return refuse(400, "invalid")
  const version = claimed(body, adding)
  if (version instanceof Response) return version
  if (!plain(body.description, 4000, true)) return refuse(400, "invalid_description")
  let saved: S["ScopeItemOut"] | S["CriterionOut"]
  if (collection === "items") {
    const kind = KINDS.find((k) => k === body.kind)
    if (!kind) return refuse(400, "invalid_kind")
    saved = {
      id: id ?? `itm_new${++scopeCount}`,
      kind,
      description: (body.description as string).trim(),
      updated_at: now,
      version: 1,
    }
  } else {
    const comparator = COMPARATORS.find((c) => c === body.comparator)
    if (!plain(body.metric, 200, false)) return refuse(400, "invalid_metric")
    if (!comparator) return refuse(400, "invalid_comparator")
    if (typeof body.target !== "number" || !Number.isFinite(body.target))
      return refuse(400, "invalid_target")
    if (body.unit !== undefined && body.unit !== null && !plain(body.unit, 200, false))
      return refuse(400, "invalid_unit")
    // Both are cleared when left out, as the API's `PUT` does. A baseline that is not a number does not
    // deserialize (axum's 422); a proof is 1 to 500 characters once trimmed, newline and tab allowed.
    const baseline = body.baseline ?? null
    if (baseline !== null && typeof baseline !== "number") return unreadable("baseline")
    const proof = body.proof ?? null
    if (proof !== null && typeof proof !== "string") return unreadable("proof")
    if (proof !== null && !plain(proof, 500, true)) return refuse(400, "invalid_proof")
    saved = {
      id: id ?? `crt_new${++scopeCount}`,
      description: (body.description as string).trim(),
      metric: (body.metric as string).trim(),
      comparator,
      target: body.target,
      unit: typeof body.unit === "string" ? body.unit.trim() : null,
      baseline,
      proof: proof?.trim() ?? null,
      updated_at: now,
      version: 1,
    }
  }
  if (!adding && at < 0) return refuse(404, "not_found")
  if (!adding) {
    let before = list[at] as S["ScopeItemOut"] & S["CriterionOut"]
    if (version !== undefined) {
      const other = someoneElse()
      if (other) {
        // Someone else's change moves the record's version and the scope's.
        const change: Partial<typeof before> =
          collection === "items"
            ? { description: `${before.description} (edited by a teammate)` }
            : { target: before.target + 5 }
        before = list[at] = { ...bump(before, change), ...other, updated_at: now } as typeof before
        bumped(current)
      }
      if (version !== before.version) return refuseStale(before)
    }
    saved.version = (before.version ?? 0) + 1
    // A save that changes nothing is not a change: the record is answered as it is, and the scope's
    // version and its sign-off stand.
    if (
      sameFields(
        before,
        saved as typeof before,
        collection === "items" ? ITEM_FIELDS : CRITERION_FIELDS,
      )
    )
      return json(before)
  }
  if (adding) list.push(saved)
  else list[at] = saved
  bumped(current)
  return json(saved, adding ? 201 : 200)
}

/** `POST`, `PUT` and `DELETE` on a company's stakeholders: the API's `work`, and its checks. */
async function stakeholderRoutes(
  method: string,
  id: string | undefined,
  found: CompanySeed,
  request: Request,
) {
  if (!mayWork(found)) return refuse(403, "forbidden")
  const at = id === undefined ? -1 : found.stakeholders.findIndex((x) => x.id === id)
  if (method === "DELETE" && id !== undefined) {
    if (at < 0) return refuse(404, "not_found")
    // The API refuses once they have signed off a scope.
    if (projectsOf(found.company.id).some((p) => p.records.scope.sign_off?.stakeholder === id))
      return refuse(409, "conflict")
    found.stakeholders.splice(at, 1)
    // What named them is left naming no one.
    // (An `on delete set null` is a change to the record, so its version moves on.)
    for (const { records } of projectsOf(found.company.id)) {
      records.access.forEach((a, i) => {
        if (a.owner === id) records.access[i] = bump(a, { owner: null })
      })
      records.tasks.forEach((t, i) => {
        if (t.waiting_on === id) records.tasks[i] = bump(t, { waiting_on: null })
      })
    }
    return noContent()
  }
  const adding = method === "POST" && id === undefined
  if (!adding && !(method === "PUT" && id !== undefined)) return null
  const b = await readBody(request)
  if (!b) return refuse(400, "invalid")
  const version = claimed(b, adding)
  if (version instanceof Response) return version
  if (!plain(b.name, 200, false)) return refuse(400, "invalid_name")
  if (badOptional(b.title, 200, false)) return refuse(400, "invalid_title")
  if (!validEmail(b.email)) return refuse(400, "invalid_email")
  const role = b.role === undefined ? "other" : PARTS.find((one) => one === b.role)
  if (!role) return refuse(400, "invalid_role")
  let before = adding ? undefined : found.stakeholders[at]
  if (!adding && !before) return refuse(404, "not_found")
  if (before && version !== undefined) {
    const other = someoneElse()
    if (other)
      before = found.stakeholders[at] = bump(before, {
        title: "Changed by a teammate",
        ...other,
        updated_at: new Date().toISOString(),
      })
    if (version !== before.version) return refuseStale(before)
  }
  const email = trimmed(b.email)
  const saved: S["StakeholderOut"] = {
    id: before?.id ?? `stk_new${++recordCount}`,
    name: (b.name as string).trim(),
    role,
    title: trimmed(b.title),
    email,
    // A new address is subscribed again; the same one keeps what its owner chose.
    digest_unsubscribed_at:
      email === (before?.email ?? null) ? (before?.digest_unsubscribed_at ?? null) : null,
    // Not part of the record's body: only `PUT .../main-contact` changes it.
    main_contact: before?.main_contact ?? false,
    updated_at: new Date().toISOString(),
    version: (before?.version ?? 0) + 1,
  }
  // A save that changes nothing is not a change: the stakeholder is answered as it is, version and all.
  if (before && sameFields(before, saved, STAKEHOLDER_FIELDS)) return json(before)
  if (before) found.stakeholders[at] = saved
  else found.stakeholders.push(saved)
  return json(saved, adding ? 201 : 200)
}

/**
 * `PUT .../main-contact`: one of the company's stakeholders, or none. Only the rows that change are
 * written, so only their versions move on. The body is `{ stakeholder }` and nothing else.
 */
async function mainContactRoute(found: CompanySeed, request: Request) {
  const b = await readBody(request)
  if (!b || Object.keys(b).some((k) => k !== "stakeholder")) return unreadable("stakeholder")
  const id = b.stakeholder ?? null
  if (id !== null && typeof id !== "string") return unreadable("stakeholder")
  if (id !== null && !found.stakeholders.some((x) => x.id === id))
    return refuse(400, "invalid_stakeholder")
  const now = new Date().toISOString()
  found.stakeholders.forEach((x, i) => {
    const is = x.id === id
    if (Boolean(x.main_contact) !== is)
      found.stakeholders[i] = bump(x, { main_contact: is, updated_at: now })
  })
  return json({ stakeholder: found.stakeholders.find((x) => x.id === id) ?? null })
}

/** `POST`, `PUT` and `DELETE` on a company's systems. */
async function systemRoutes(
  method: string,
  id: string | undefined,
  found: CompanySeed,
  request: Request,
) {
  if (!mayWork(found)) return refuse(403, "forbidden")
  const at = id === undefined ? -1 : found.systems.findIndex((x) => x.id === id)
  if (method === "DELETE" && id !== undefined) {
    if (at < 0) return refuse(404, "not_found")
    found.systems.splice(at, 1)
    for (const { records } of projectsOf(found.company.id))
      records.access.forEach((a, i) => {
        if (a.system === id) records.access[i] = bump(a, { system: null })
      })
    return noContent()
  }
  const adding = method === "POST" && id === undefined
  if (!adding && !(method === "PUT" && id !== undefined)) return null
  const b = await readBody(request)
  if (!b) return refuse(400, "invalid")
  const version = claimed(b, adding)
  if (version instanceof Response) return version
  if (!plain(b.name, 200, false)) return refuse(400, "invalid_name")
  if (badOptional(b.kind, 200, false)) return refuse(400, "invalid_kind")
  if (badOptional(b.description, 4000, true)) return refuse(400, "invalid_description")
  let before = adding ? undefined : found.systems[at]
  if (!adding && !before) return refuse(404, "not_found")
  if (before && version !== undefined) {
    const other = someoneElse()
    if (other)
      before = found.systems[at] = bump(before, {
        description: "Changed by a teammate.",
        ...other,
        updated_at: new Date().toISOString(),
      })
    if (version !== before.version) return refuseStale(before)
  }
  const saved: S["SystemOut"] = {
    id: before?.id ?? `sys_new${++recordCount}`,
    name: (b.name as string).trim(),
    kind: trimmed(b.kind),
    description: trimmed(b.description),
    updated_at: new Date().toISOString(),
    version: (before?.version ?? 0) + 1,
  }
  // A save that changes nothing is not a change: the system is answered as it is, version and all.
  if (before && sameFields(before, saved, SYSTEM_FIELDS)) return json(before)
  if (before) found.systems[at] = saved
  else found.systems.push(saved)
  return json(saved, adding ? 201 : 200)
}

/** `PUT` and `DELETE` on a company's members: the API's `manage`. */
async function memberRoutes(
  method: string,
  user: string | undefined,
  found: CompanySeed,
  request: Request,
) {
  if (user === undefined || (method !== "PUT" && method !== "DELETE")) return null
  if (!mayManage(found)) return refuse(403, "forbidden")
  const at = found.members.findIndex((m) => m.user === user)
  if (method === "DELETE") {
    if (at < 0) return refuse(404, "not_found")
    found.members.splice(at, 1)
    // They no longer work on the company's projects.
    for (const { project: p } of projectsOf(found.company.id)) {
      const list = state.assignees[p.id]
      if (list) state.assignees[p.id] = list.filter((a) => a.user !== user)
    }
    return noContent()
  }
  const b = await readBody(request)
  const role = b && (b.role === "lead" || b.role === "engineer" ? b.role : null)
  if (!role) return refuse(400, "invalid_role")
  // The API adds only the organisation's own people.
  if (!DIRECTORY.some((p) => p.id === user && p.role !== "guest")) return refuse(404, "not_found")
  if (at >= 0) found.members[at] = { ...found.members[at]!, role }
  else found.members.push({ user, role, added_at: new Date().toISOString() })
  return noContent()
}

/** Who is assigned to a project: its own list once changed, else the company's team. */
function assigneesOf(found: CompanySeed, projectId: string) {
  return (state.assignees[projectId] ??= found.members.map((m) => ({
    user: m.user,
    added_at: m.added_at,
  })))
}

/** `GET`, `PUT` and `DELETE` on a project's assignees. Reading is `work`, changing is `manage`. */
function assigneeRoutes(
  method: string,
  user: string | undefined,
  found: CompanySeed,
  projectId: string,
) {
  const list = assigneesOf(found, projectId)
  if (method === "GET" && user === undefined)
    return json(list.map((a) => ({ ...a, name: nameOf(a.user) })))
  if (user === undefined) return null
  if (!mayManage(found)) return refuse(403, "forbidden")
  const at = list.findIndex((a) => a.user === user)
  if (method === "DELETE") {
    if (at < 0) return refuse(404, "not_found")
    list.splice(at, 1)
    return noContent()
  }
  if (method !== "PUT") return null
  if (!found.members.some((m) => m.user === user)) return refuse(404, "not_found")
  if (at < 0) list.push({ user, added_at: new Date().toISOString() })
  return noContent()
}

/**
 * What leaves each stage, as `oryxa_fde_core::Check` lists it, with its words. `met` judges the
 * project's records the way `oryxa-fde-store` does (checklist.rs), so the mock refuses what the
 * API refuses: the same rules on invented data.
 */
const CHECKS: Record<
  string,
  { stage: Stage; label: string; met: (c: CompanySeed, r: Records) => boolean }
> = {
  stakeholders_named: {
    stage: "discover",
    label: "Stakeholders named",
    met: (c) => c.stakeholders.length > 0,
  },
  discovery_notes: {
    stage: "discover",
    label: "A meeting note on the project",
    met: (_, r) => r.notes.length > 0,
  },
  scope_signed_off: {
    stage: "scope",
    label: "Scope signed off, and unchanged since",
    // A sign-off covers the scope only while nothing changed after it.
    met: (_, r) => r.scope.sign_off?.version === r.scope.version,
  },
  out_of_scope_listed: {
    stage: "scope",
    label: "What is out of scope is listed",
    met: (_, r) => r.scope.items.some((i) => i.kind === "out"),
  },
  criteria_have_targets: {
    stage: "scope",
    label: "Success criteria set, each with a target",
    // Every criterion has a target (it is required), so this needs one to exist.
    met: (_, r) => r.scope.criteria.length > 0,
  },
  access_granted: {
    stage: "access",
    label: "Every access request granted",
    // Vacuously met with no requests: a project may need no access.
    met: (_, r) => r.access.every((a) => a.status === "granted"),
  },
  criteria_have_evals: {
    stage: "build",
    label: "An eval suite measures every criterion",
    met: (_, r) =>
      r.scope.criteria.length > 0 && r.scope.criteria.every((k) => measured(r.evals, k.id)),
  },
  criteria_met: {
    stage: "evaluate",
    label: "Every criterion meets its target",
    met: (_, r) =>
      r.scope.criteria.length > 0 &&
      r.scope.criteria.every((k) => {
        const value = valueOf(r.evals, k.id)?.value
        return (
          value !== undefined &&
          (k.comparator === "at_least" ? value >= k.target : value <= k.target)
        )
      }),
  },
}

/** The checklist to leave `stage`; empty for a stage with nothing to check yet. */
function checklist(
  stage: Stage,
  found: CompanySeed,
  records: Records,
): Array<S["ChecklistItemOut"]> {
  // A run that has had its time finishes now, as the API would have recorded it.
  settle(records.evals)
  return Object.entries(CHECKS)
    .filter(([, check]) => check.stage === stage)
    .map(([key, check]) => ({ key, label: check.label, met: check.met(found, records) }))
}

/** A reason is 1 to 500 characters once trimmed, with no control character (C0 or C1) but newline and tab. */
// eslint-disable-next-line no-control-regex
const REASON_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
function validReason(value: unknown) {
  if (typeof value !== "string") return false
  const v = value.trim()
  const n = [...v].length
  return n >= 1 && n <= 500 && !REASON_CONTROL.test(v)
}

/**
 * `PUT .../stage`: one stage forward, or back to an earlier one. A forward move with checks of the
 * current stage open needs a `reason` (409 with the open items without one); a move back, or one
 * with nothing open, ignores it. A reason that is not valid is a 400 whenever it is sent.
 */
async function stageMove(
  p: { project: S["ProjectOut"]; records: Records },
  found: CompanySeed,
  request: Request,
) {
  const body = (await request.json().catch(() => null)) as Partial<S["StageBody"]> | null
  const to = STAGES.find((stage) => stage === body?.stage)
  if (!to) return refuse(400, "invalid_stage")
  if (body?.reason !== undefined && body.reason !== null && !validReason(body.reason))
    return refuse(400, "invalid_reason")
  const from = p.project.stage
  if (!canMove(from, to)) return refuse(409, "rejected_stage_transition")
  const open =
    STAGES.indexOf(to) > STAGES.indexOf(from)
      ? checklist(from, found, p.records).filter((item) => !item.met)
      : []
  if (open.length > 0 && body?.reason == null) {
    // The refusal is what makes a stale page read again, so its stale read ends here.
    delete (globalThis as Record<string, unknown>).__fdeMockStaleChecklist
    return Response.json({ error: "rejected_checklist_open", open }, { status: 409 })
  }
  p.project.stage = to
  p.project.updated_at = new Date().toISOString()
  return json(projectOut(p))
}

/** Answers a request to `/api/v1/companies/...`, given the path's parts after `companies`. */
async function companyRoutes(method: string, parts: Array<string>, request: Request) {
  const [companyId, collection, projectId, record, ...rest] = parts
  if (companyId === "setup" && collection === undefined && method === "POST") return setUp(request)
  if (companyId === undefined) {
    if (method === "POST") return createCompany(request)
    return method === "GET" ? json(companyList()) : null
  }
  // The API checks permission before it looks: anything not the FDE's is a 403.
  const found = state.companies.find((c) => c.company.id === companyId)
  if (!found || !mayWork(found)) return refuse(403, "forbidden")
  if (method === "GET" && collection === undefined) return json(found.company)
  if (method === "PATCH" && collection === undefined) return patchCompany(found, request)
  if (collection === "stakeholders" && method !== "GET")
    return stakeholderRoutes(method, projectId, found, request)
  if (collection === "main-contact" && method === "PUT" && projectId === undefined)
    return mainContactRoute(found, request)
  if (collection === "systems" && method !== "GET")
    return systemRoutes(method, projectId, found, request)
  if (collection === "members" && method !== "GET")
    return memberRoutes(method, projectId, found, request)
  if (collection === "meeting-notes")
    return noteRoutes(method, projectId, found, found.notes, request)
  // A company's documents: `projectId` is the document's id here. Uploading is a body that is a file, so the
  // mock's `upload` answers it; a `POST` that gets this far is not one.
  const documents = (state.documents[companyId] ??= [])
  if (collection === "documents" && method === "GET") return documentReads(documents, projectId)
  if (collection === "search" && method === "GET")
    return documentSearch(documents, new URL(request.url))
  if (collection === "projects" && method === "POST" && projectId === undefined)
    return projectWrites(method, undefined, found, request)
  if (collection === "projects" && method === "PATCH" && record === undefined)
    return projectWrites(method, projectId, found, request)
  if (method === "GET" && projectId === undefined) {
    if (collection === "members")
      return json(found.members.map((m) => ({ ...m, name: nameOf(m.user) })))
    if (collection === "stakeholders") return json(found.stakeholders)
    if (collection === "systems") return json(found.systems)
    if (collection === "projects") return json(projectsOf(companyId).map(projectOut))
    return null
  }
  if (collection !== "projects" || projectId === undefined) return null
  const p = projectsOf(companyId).find((x) => x.project.id === projectId)
  if (!p) return refuse(403, "forbidden")
  if (record === "agent-runs")
    return runRoutes((state.runs[projectId] ??= []), method, rest, request, state.me.user.id)
  if (record === "eval-suites" || record === "eval-runs") {
    // Where the API has no sandbox gateway it mounts no eval routes, so they answer 404 with nothing in it.
    if ((globalThis as Record<string, unknown>).__fdeMockEvalsOff === true)
      return new Response(null, { status: 404 })
    return evalRoutes(p.records.evals, record, rest, method, request, {
      criteria: p.records.scope.criteria.map((c) => c.id),
      user: state.me.user.id,
    })
  }
  if (record === "assignees") return assigneeRoutes(method, rest[0], found, projectId)
  if (record === "meeting-notes")
    return noteRoutes(method, rest[0], found, p.records.notes, request, p.records)
  if (method === "GET") {
    if (record === "stage-checklist") {
      const items = checklist(p.project.stage, found, p.records)
      // Dev and test only: `globalThis.__fdeMockStaleChecklist = true` reads every item as met, as a page
      // does that has not heard of a change made elsewhere, so the stale-view refusal can be seen. It ends
      // with that refusal, as a re-read would.
      const stale = (globalThis as Record<string, unknown>).__fdeMockStaleChecklist === true
      return json({
        stage: p.project.stage,
        items: stale ? items.map((i) => ({ ...i, met: true })) : items,
      })
    }
    if (record === undefined) return json(projectOut(p))
    if (record === "scope") return json(p.records.scope)
    if (record === "access-requests") return json(p.records.access)
    if (record === "tasks") {
      // In the project's order; `?criterion=` keeps the tasks linked to that criterion.
      const linked = new URL(request.url).searchParams.get("criterion")
      return json(
        linked === null ? p.records.tasks : p.records.tasks.filter((t) => t.criterion === linked),
      )
    }
    if (record === "decisions") return json(newestFirst(p.records.decisions))
    if (record === "threads") return json(p.records.threads ?? [])
    // The company's lists, read through the project, as assignees do.
    if (record === "stakeholders") return json(found.stakeholders)
    if (record === "systems") return json(found.systems)
    return null
  }
  if (record === "scope")
    return scopeRoutes(method, rest, found, p.records.scope, p.records.tasks, request)
  if (record === "tasks") return taskRoutes(method, rest[0], found, p.records, request)
  if (record === "access-requests") return accessRoutes(method, rest[0], found, p.records, request)
  if (record === "decisions") return decisionRoutes(method, rest[0], p.records, request)
  if (method === "PUT" && record === "stage") return stageMove(p, found, request)
  return null
}

async function answer(request: Request): Promise<Response> {
  if (LATENCY_MS) await new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
  const { pathname } = new URL(request.url)
  const { method } = request
  if (pathname === "/auth/logout" && method === "POST") {
    setSession(false)
    resetMockSignIn()
    return new Response(null, { status: 204 })
  }
  const signedIn = await signInRoutes(pathname, method, request, setSession)
  if (signedIn) return signedIn
  if (!pathname.startsWith("/api/v1/")) return refuse(404, "not_found")
  if (!hasSession()) return refuse(401, "unauthorized")
  // Dev and test only, like everything here: `globalThis.__fdeMockFailWrites = true` makes every write
  // answer 503, so the failed-save states can be seen and tested. A production build has no mock.
  if (method !== "GET" && (globalThis as Record<string, unknown>).__fdeMockFailWrites === true)
    return refuse(503, "unavailable")
  const [root, ...parts] = pathname.slice("/api/v1/".length).split("/")
  if (method === "GET" && parts.length === 0 && root === "me") return json(state.me)
  if (method === "GET" && parts.length === 0 && root === "people") return peopleList()
  if (method === "GET" && parts.length === 0 && root === "today") return json(today())
  if (method === "GET" && parts.length === 0 && root === "home") return json(home())
  if (method === "POST" && root === "home" && parts.length === 3 && parts[0] === "suggestions")
    return parts[2] === "dismiss"
      ? dismissHome(decodeURIComponent(parts[1]!))
      : refuse(404, "not_found")
  if (method === "GET" && root === "room" && parts[0] === "companies" && parts[2] === "projects")
    return roomRead(parts[1], parts[3])
  const answered = root === "companies" ? await companyRoutes(method, parts, request) : null
  return answered ?? refuse(404, "not_found")
}

/** An FDE who works on the project reads its room: each criterion with the API's latest value and verdict. */
function roomRead(companyId: string | undefined, projectId: string | undefined) {
  const found = state.companies.find((c) => c.company.id === companyId)
  if (!found || !mayWork(found)) return refuse(403, "forbidden")
  const p = projectsOf(found.company.id).find((x) => x.project.id === projectId)
  if (!p) return refuse(404, "not_found")
  settle(p.records.evals)
  const { scope: agreed } = p.records
  const criteria = agreed.criteria.map((c) => {
    const result = valueOf(p.records.evals, c.id)
    return {
      criterion: c,
      latest: result?.value ?? null,
      // The API's rule: the value meets the target on the criterion's side of it (`criterion_results`).
      passing: result
        ? c.comparator === "at_least"
          ? result.value >= c.target
          : result.value <= c.target
        : null,
      measured_at: result?.at ?? null,
    }
  })
  return json({
    project: p.project.id,
    name: p.project.name,
    stage: p.project.stage,
    progress: STAGES.indexOf(p.project.stage) + 1,
    stages: STAGES.length,
    criteria,
    criteria_passing: criteria.filter((c) => c.passing === true).length,
    scope_awaits_sign_off: agreed.items.length > 0 && agreed.sign_off?.version !== agreed.version,
    questions: [],
    latest_update: null,
  })
}

/** The path of an upload, `/api/v1/companies/{id}/documents`, or null for anything else. */
const uploadTarget = (url: URL) =>
  /^\/api\/v1\/companies\/([^/]+)\/documents$/.exec(url.pathname)?.[1] ?? null

/** How the mock answers an upload: the API's checks, in its order, on a file it has been handed. */
async function uploadAnswer({ url, headers, body }: UploadRequest): Promise<Response> {
  if (LATENCY_MS) await new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
  const target = new URL(url)
  const csv =
    /^\/api\/v1\/companies\/([^/]+)\/projects\/([^/]+)\/eval-suites\/([^/]+)\/(cases|results)$/.exec(
      target.pathname,
    )
  if (csv) return csvAnswer(csv, body)
  const id = uploadTarget(target)
  if (id === null) return refuse(404, "not_found")
  if (!hasSession()) return refuse(401, "unauthorized")
  if ((globalThis as Record<string, unknown>).__fdeMockFailWrites === true)
    return refuse(503, "unavailable")
  const found = state.companies.find((c) => c.company.id === decodeURIComponent(id))
  if (!found || !mayWork(found)) return refuse(403, "forbidden")
  const documents = (state.documents[found.company.id] ??= [])
  const contentType = new Headers(headers).get("content-type") ?? ""
  return documentUpload(documents, target, contentType, body, state.me.user.id)
}

/** A CSV for an eval suite's cases or results: what the API does with a file it has been handed. */
async function csvAnswer(parts: RegExpExecArray, body: Blob): Promise<Response> {
  if (!hasSession()) return refuse(401, "unauthorized")
  if ((globalThis as Record<string, unknown>).__fdeMockFailWrites === true)
    return refuse(503, "unavailable")
  const [, companyId, projectId, suite, to] = parts.map((x) => decodeURIComponent(x))
  const found = state.companies.find((c) => c.company.id === companyId)
  if (!found || !mayWork(found)) return refuse(403, "forbidden")
  const p = projectsOf(found.company.id).find((x) => x.project.id === projectId)
  if (!p) return refuse(403, "forbidden")
  if ((globalThis as Record<string, unknown>).__fdeMockEvalsOff === true)
    return new Response(null, { status: 404 })
  if (body.size > 8 * 1024 * 1024) return refuse(413, "payload_too_large")
  const request = new Request("https://mock.invalid/", {
    method: "POST",
    body: await readText(body),
  })
  const answered = await evalRoutes(
    p.records.evals,
    "eval-suites",
    [suite!, to!],
    "POST",
    request,
    {
      criteria: p.records.scope.criteria.map((c) => c.id),
      user: state.me.user.id,
    },
  )
  return answered ?? refuse(404, "not_found")
}

export const mockApi: Transport = {
  fetch: answer,
  /**
   * Sends in steps with a pause between, so the progress bar can be seen; a test gets it in one go. A
   * file cannot go through `fetch`, which has no body a jsdom test can build, so it is handed over as it is.
   */
  async upload(request) {
    // Dev and test only: `globalThis.__fdeMockStallUpload = true` sends 60% of the file and then waits,
    // so the progress bar can be looked at. Cancelling the upload ends it.
    if ((globalThis as Record<string, unknown>).__fdeMockStallUpload === true) {
      request.onProgress(Math.round(request.body.size * 0.6), request.body.size)
      return new Promise<Response>((_, reject) =>
        request.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The upload was cancelled.", "AbortError")),
          { once: true },
        ),
      )
    }
    const steps = import.meta.env.MODE === "test" ? 1 : 6
    for (let sent = 1; sent <= steps; sent++) {
      if (request.signal?.aborted) throw new DOMException("The upload was cancelled.", "AbortError")
      if (steps > 1) await new Promise((resolve) => setTimeout(resolve, 140))
      request.onProgress(Math.round((request.body.size * sent) / steps), request.body.size)
    }
    if (request.signal?.aborted) throw new DOMException("The upload was cancelled.", "AbortError")
    return uploadAnswer(request)
  },
  async signIn() {
    setSession(true)
  },
  /** Google, on the mock: it comes back at once, signed in. */
  async leave() {
    setSession(true)
  },
}
