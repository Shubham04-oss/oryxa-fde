# Product direction

What the product is for, who uses it, and how it should feel to work in. `docs/plan.md` says what to
build and in what order; the ADRs record decisions; this page is the reason behind both. Set by the
founder and the lead on 10 November 2026. Section 9, how the workspace feels and adapts, was added
on 12 November 2026 and takes precedence where it and section 3 differ on what a screen looks like.

## 1. The idea

A forward deployed engineer (FDE) works across several customers at once, and **each customer
dictates the tools**: one runs Slack, Jira and GitHub, the next Teams, Azure DevOps and ServiceNow.
The FDE is the only thing connecting them, which is why context switching is the complaint
practitioners raise most.

So the product does not replace those tools. It is **the one place that stays the same across
customers**: it holds the engagement record (what was agreed, who granted what, what was proven,
what happens next), reads the customer's tools into one view of the day, and writes updates back
to where the customer already is.

Three rules follow:

1. **The engagement record is ours; work items are theirs.** We own scope, criteria, access,
   decisions, proof and handoff. We mirror issues, pull requests and messages, and never ask a
   customer to move them.
2. **Organise by the FDE's day, not by the database.** A screen answers "what do I do now?" before
   it shows records.
3. **No single vendor is required.** Everything works from generic inputs (a webhook, a forwarded
   email, an uploaded results file). A named integration only makes it smoother.

## 2. Three tiers of user

| Tier | Who | What they need | Surface |
| --- | --- | --- | --- |
| Vendor organisation | Admins and managers at the company that buys the product | Every engagement by stage and health, who is on what, seats, policies, billing | Admin console |
| FDE | The vendor's engineers | Run every customer and project day to day | The workspace |
| Customer | The **sponsor**, who must show the engagement worked, and the **IT admin**, who grants access and answers for what is deployed | Sponsor: outcome against baseline, milestones, decisions to make. IT admin: who has access, what was deployed, evidence | Customer portal |

The customer portal is the smallest of the three and the part competitors lack. Roles and sign-in
are in ADR 0005.

## 3. The FDE's loop, and the screen for each part

| When | The FDE needs to | Screen | Today in the code |
| --- | --- | --- | --- |
| Morning | See what needs them across all customers and act on it | **Today**, an inbox: needs a reply, blocked, due, waiting on the customer, approvals, failing checks, engagements with no next step. Each row acts in place (reply, done, unblock, nudge, approve) | Lists our tasks and access requests; rows only link away |
| Any time | Capture without leaving what they are doing | **Jump to** (Ctrl K) also creates: a task, a decision, an access request, a note | Navigates only |
| In an engagement | Know what this stage needs and what is next | **Engagement page that follows the stage**: the stage's checklist, the next step with its owner and date, then the records behind it | A stack of read-only cards; a stage moves one step at a time, with no other conditions |
| Planning work | Order and move work | **Board**: tasks as a kanban, with mirrored issues from the customer's tracker beside ours | Tasks exist with five statuses; no board, no ordering |
| After a call | Turn talk into commitments | **Notes**: a meeting note becomes tasks and decisions; a glossary of the customer's terms | Notes exist; they cannot create tasks |
| Chasing | Get access and answers out of the customer | **Access** with owner, scope and days waiting; a nudge goes to the customer's channel or the IT admin's screen | Tracker exists; no nudge, no customer side |
| Building | Use a coding agent with the project's context | **Agent runs**: in our sandbox on sample data, recorded here; or the FDE's own agent on real systems, reading context from the MCP server | Sandbox runs and review screen exist; MCP server exists, not connected |
| Proving | Show each criterion is met | **Proof**: each criterion with its baseline, current value, target and trend, from results run anywhere | Evals exist; no screen; results only from our sandbox or CSV |
| Friday | Tell the customer and the manager where things stand | **Weekly update**: drafted from the week's activity, edited, sent to the customer's channel and digest | Drafting and sending exist; no screen |
| At the end | Leave the customer able to run it | **Handoff**: a checklist that must be complete, a retro, follow-ups | A stage only |

## 4. What an engagement holds

The eight stages in `oryxa-fde-core` stay. Three things are added to them.

**A next step, always.** Every active project has one next step with an owner and a date. A project
without one shows on Today and on the manager's view. Practitioners put it bluntly: an engagement
with no next step is closed.

**Scope as an agreement, not a note.** The outcome, each success criterion with a measured baseline
and a target, milestones, what is out of scope, assumptions and an acceptance date. A change after
sign-off is a recorded change request that the sponsor accepts. A missing baseline and a vague
"done" are the two most common reasons value cannot be shown later.

**A checklist to leave each stage.**

| Leaving | Needs |
| --- | --- |
| Discover | Stakeholders named, a customer owner named, discovery notes |
| Scope | Scope signed off, an out-of-scope list, a baseline and target on every criterion |
| Access | Every required access request granted or waived |
| Build | The milestone's tasks done, an eval suite for each criterion |
| Evaluate | Every criterion meets its target |
| Deploy | The deployment recorded with its approval |
| Handoff | Handoff document, a named customer owner, follow-on work as tasks, a retro |

A checklist guides; it does not trap. An FDE may move on with an item open by giving a reason,
which goes in the audit log and shows to the manager. Real engagements are ambiguous, and a tool
that blocks gets worked around.

## 5. Signals and connectors

Today reads only our own tables, and the only inbound integration is GitHub's "pull request opened
or merged". The fix is not more GitHub. It is one model that any tool maps onto (ADR 0006):

| Signal | Examples of where it comes from |
| --- | --- |
| Conversation | Slack and Slack Connect, Teams, forwarded email |
| Work item | Jira, Linear, Azure Boards, GitHub and GitLab issues, ServiceNow |
| Code change | GitHub, GitLab, Azure DevOps, Bitbucket |
| Check result | Any CI, by webhook or a JUnit file |
| Meeting | Any calendar, by an iCalendar feed; notes pasted or sent in |
| Document | Confluence, Notion, SharePoint, Drive, by link |
| Access grant | Our access tracker; the customer's approval |
| Eval result | Our sandbox, a CSV or JUnit upload, an OpenTelemetry trace |

Every signal belongs to one company, and a connection is set up per customer company, because the
customer chooses the tools. The generic routes (webhook, forwarded email, calendar feed, file
upload) come first so a customer whose admins refuse to install anything is still covered.

## 6. The coding agent

FDEs already build with coding agents; the product gives the agent the engagement's context. Two
modes:

- **Hosted:** a run in the company's sandbox, on sample data only (ADR 0003), recorded in full.
- **Own machine:** the FDE's own agent works on real customer systems under the access the
  customer granted. It reads the project's context from our MCP server, which stays read-only. We
  record no transcript of it. What it produces comes back the way any work does: a pull request as
  a code change, test and eval results as an upload.

The embedded agent is mostly OpenCode, with the Claude Agent SDK as the second harness behind the
same adapter (ADR 0004). OpenCode is switched on once it passes the recorded-session,
hostile-repository and egress tests, and becomes the default after an eval comparison.

## 7. Milestones

| Milestone | Scope | Done when |
| --- | --- | --- |
| **M1. It runs** | Deploy dev; fix the seams between components (session on agent routes, the API's environment, worker deploys, gateway route and secrets) | One scripted pass in dev: sign in, company, project, scope, document search, agent run, eval, customer room |
| **M2. The FDE's day** | Today as an inbox, the engagement page with checklists and next step, the board, notes to tasks, proof, the weekly update, capture from Jump to; the signal model with Slack inbound, GitHub widened, the inbound webhook and results upload; per-company keys | With per-company keys in place, the founder runs one real engagement in it for two weeks with no other tracker |
| **M3. The customer side, and paying** | IT admin and sponsor screens, invites, billing, Jira and GitLab connectors, the calendar feed and forwarded email, the admin console | A design partner's customer uses the portal, and the partner pays |

No real customer data enters the product before per-company keys exist (ADR 0003). M2 is built and
tried on sample data; the real engagement starts when the keys are in.

Not yet: approvals that route to the customer's IT admin, the canvas, the runner in customer
clouds, versioned config, Teams and Azure DevOps connectors, a trust-centre or questionnaire tool,
session recording, an ROI calculator, new API surface that no screen uses.

## 8. Evidence, and its limits

This direction rests on the founder's account of the work and on a research pass on 10 November
2026. The research read public handbooks, talks and vendor documentation. PostHog's FDE handbook
supplied most of the detail on cadence, lifecycle and handoff; Ramp's and Kepler's talks supplied
intake, scoping and what goes wrong; Microsoft, Google and AWS identity documentation supplied the
IT admin's expectations. Tool prevalence comes from a general developer survey, a weak proxy.
Nothing solid was found on what sponsors want to see or on how long security reviews take.

Treat sections 3 to 5 as a well-founded starting point, and correct them from the first real
engagement run in the product.

## 9. How it feels: a conversation that builds the workspace

Set by the founder on 12 November 2026. Sections 3 to 5 say what the FDE needs; this section says
how they get it. The records, stages and permission rules above do not change.

**One place to talk.** The FDE's main surface is a conversation with the workspace: what is wrong,
what needs planning, what to do next. They say what they want and the workspace prepares it. The
screens in section 3 remain as views the conversation opens and fills, not as the way in.

**It speaks first.** When something happens (a company is created, a customer asks for a service to
be connected, a check fails, an engagement has no next step) the workspace proposes what to do, and
the FDE approves, changes or dismisses it.

**Plan first, and adaptive.** A new company or project starts as a short brief built in
conversation: what is being delivered, how the work will run, the rules for it, who to invite. From
that the workspace proposes a plan as an ordered sequence of steps, and the FDE reorders and edits
it. The sequence is theirs: the first step may be a call with the sponsor rather than build work. The eight
stages stay as the backbone and the plan's steps hang off them, so the lifecycle is still managed
(next step, stage checklists, handoff) however the FDE chose to begin.

**Generated from our own blocks.** Each company and each person gets a workspace arranged for
them. The workspace arranges and fills a fixed set of our building blocks (plan, rules, people,
checklist, board, proof, suggestion and so on). It never writes markup or code for a screen. How it
is allowed to act is in ADR 0008.

**A person confirms.** Anything the workspace proposes that creates or changes a record, invites
someone, grants access or sets a rule takes effect only when a person confirms it, and runs with
that person's own permissions.

**Evals are part of the plan, not a separate tool.** Every success criterion in a plan comes with
how it will be proven: a baseline, a target and an eval suite or an uploaded result. Proof shows in
the conversation and on the engagement, a criterion is never shown as met on a claim alone (an FDE
may still move on with it open by giving a reason, as section 4 says), and the workspace's own
proposals are measured too (ADR 0008).

**Clear, decluttered, premium.** Usability comes first.

- One primary action in a view. Few things on screen; the rest is a step away, not on the page.
- Navigation is obvious and light: where am I, what needs me, how do I get back.
- A considered colour theme in light and dark, a clear type scale, generous spacing, quiet motion
  that respects the reduced-motion setting.
- Every control has its hover, focus, pressed, disabled, empty and loading states.
- Keyboard and screen-reader use work everywhere.
- Built on TanStack Start, with well-kept open-source components (Base UI, the shadcn pieces,
  Tailwind tokens) and Pikaicons' free, MIT-licensed set behind one icon entry point. Paid icon
  files never enter this public repository.

The same treatment reaches the customer portal later, in a simpler form.
