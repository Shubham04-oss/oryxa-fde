# FDE workspace: build plan

The source for every issue in this repo. `docs/direction.md` says what the product is for and how
it should work; decisions live in `docs/adr/`; this file says what to build and in what order.
Last updated 10 November 2026.

## 1. The product

A forward deployed engineer (FDE) logs in and sees every customer company they work with. Each
company is an isolated environment with one or more projects. A project moves through discover,
scope, access, build, evaluate, deploy, handoff and operate. The workspace holds the customer's
context, the agreed scope and success criteria, the access tracker, a coding agent in a sandbox per
company, evals tied to the criteria, a customer room the customer can read, and the handoff.

Two ways in: vendor teams (an OpenAI-style FDE org buys seats) and independent FDEs (self-serve).
A separate self-efficiency product comes later and is out of scope here.

## 2. What comes from the platform, and what is ours

| From the platform base (`vendor/oryxa-platform`) | Ours |
| --- | --- |
| `oryxa-core`: tenant and user ids, `Ctx` | `oryxa-fde-core`: FDE ids, scopes, stage machine |
| `oryxa-authn`: WorkOS token verification, internal tokens | Sign-in flow for `fde-web` and session handling in `oryxa-fde-api` |
| `oryxa-authz`: tenant-guarded SpiceDB client, Cedar guardrails | `schema/fde.zed` and the permission checks in every endpoint |
| `oryxa-events`: envelope, signing, EventBridge v2 publisher, `decode` | `oryxa-fde-events` types, the outbox and the consumers |

Everything else is built here, following ADR 0003 for where it runs.

## 3. Architecture

```
Browser -> Cloudflare (DNS, WAF, Turnstile) -> fde-web on Workers
  -> private link (Workers VPC or Tunnel) -> internal ALB -> oryxa-fde-api (Rust, Axum) on ECS Fargate
  -> Postgres (RDS, pgvector) scoped by tenant + company, SpiceDB via oryxa-authz
  -> outbox -> EventBridge v2 bus oryxa-fde-<env> -> FIFO subscribers -> SQS FIFO + DLQ -> consumers

Agent run: oryxa-fde-api -> sandbox gateway Worker -> Cloudflare Sandbox for the company
  -> the harness (OpenCode or the Claude Agent SDK, ADR 0004) with the context pack; every
     outbound request through the outbound handler (allowlist, secrets added there)
  -> branch, PR, eval run -> events -> lifecycle engine
Live updates: Durable Objects (presence, agent output, notifications)
```

Customer data at rest lives only in AWS (Postgres, S3). Durable Objects and sandboxes keep state in
memory or in Git and S3.

## 4. Repo layout

```
crates/oryxa-fde-core/       ids, scopes, stage machine (lead)
crates/oryxa-fde-events/     FDE event types on oryxa-events (api)
crates/oryxa-fde-store/      tables, migrations, row-level security, outbox, queries (api)
crates/oryxa-fde-api/        HTTP API, sign-in, permission checks (api)
crates/oryxa-fde-agent/      agent runs, context pack, harness events, approvals (agent)
crates/oryxa-fde-context/    documents, ingestion consumer, search (api, wave 2)
crates/oryxa-fde-mcp/        read-only MCP server for coding agents (api, wave 2)
crates/oryxa-fde-lifecycle/  lifecycle engine consumer and drafted updates (api, wave 2)
crates/oryxa-fde-evals/      eval suites, runner, graders (agent, wave 2)
schema/fde.zed               SpiceDB schema (lead)
fde-web/                     web app (web)
sandbox/                     sandbox gateway Worker, outbound handler, base image, harness adapter (agent)
infra/                       OpenTofu for AWS and Cloudflare (infra)
vendor/oryxa-platform/       the platform base, synced by script only
```

## 5. P0 scope

| Area | Ships | Done when |
| --- | --- | --- |
| Accounts and structure | WorkOS sign-in, organisations as tenants, invites, roles, companies, projects, Today view, quick switch | An FDE with five companies sees what needs them today on one screen |
| Isolation | `schema/fde.zed`, `CompanyScope` on every query, row-level security, isolation suite over every endpoint | The suite covers every endpoint and passes |
| Config | Layered org, company and project config with versions; secret references only | A model change at org level reaches every project not pinned to an older version |
| Context | Company profile, stakeholders, systems, document upload, ingestion, keyword and vector search | Search finds the right passage in a design partner's documents |
| MCP server | Read-only tools for context, scope, decisions and tasks | A coding agent answers about one company and cannot reach another |
| Lifecycle | Stages, scope with criteria and sign-off, access tracker, security answers, tasks, blockers, decisions, reassignment | A live engagement runs in it for a month without another tracker |
| Lifecycle engine | Rules on approvals, eval results, merged PRs and agent runs; drafted weekly updates | Most weekly updates go out with light edits |
| Planning | Canvas with templates and linked shapes, live sessions, comments, meeting notes | A partner runs a discovery workshop on it with a customer |
| Customer room | Share link, guest view, status, eval trends, weekly digest, export | A sponsor reads it without a call to explain it |
| Agent | Sandbox per company on sample data, the harness adapter with the Claude Agent SDK and then OpenCode (ADR 0004), context pack, background runs, review screen, approvals, hidden secrets, allowlist, budgets | An FDE runs tasks at three companies at once and merges the results |
| Evals | Suite format, runner in the sandbox, graders, links to criteria, CSV import | Each criterion shows a pass rate the customer can see |
| Billing | Free and Pro, agent-hour and AI-credit meters, Stripe | The first design partners pay |

Not in P0: the runner in customer clouds, real customer data in a sandbox, harnesses beyond those in
ADR 0004, handoff pack and ownership transfer, Team plan, enterprise sign-on and regions,
self-efficiency.

## 6. Workstreams

Every item is one issue, one branch, one PR. The lead reviews and merges.

**Wave 0 (done in the first commit):** scaffold, vendored base, `oryxa-fde-core`, this plan, ADRs, CI.

**Wave 1 (parallel, disjoint paths)**

| Stream | Label | Issues, in order |
| --- | --- | --- |
| API | `agent:api` | Schema and events; store and API for organisations, members, companies and projects; lifecycle records (scope, criteria, access, tasks, decisions) |
| Web | `agent:web` | Shell, sign-in and the company and project screens on a mock API |
| Agent | `agent:agent` | Sandbox gateway and outbound handler; harness adapter and context pack |
| Infra | `agent:infra` | Dev environment in OpenTofu for AWS and Cloudflare |

**Wave 2 (after wave 1 merges): finish P0.** Each stream works its issues in order.

| Stream | Label | Issues, in order |
| --- | --- | --- |
| API | `agent:api` | Context and MCP server; lifecycle engine and drafted updates; customer room API and weekly digest; GitHub and Slack links; billing |
| Web | `agent:web` | Web app on the real API; customer room screens; canvas and discussion with the `realtime/` Worker; agent run review screen |
| Agent | `agent:agent` | Agent runs end to end (orchestration, approvals, budgets); evals; Bedrock IAM signing in the outbound handler |
| Infra | `agent:infra` | Build and deploy pipelines for the API, Workers and web app |

**Wave 3 (from 10 November): make it run, then the FDE's day.** Waves 1 and 2 built most of the
P0 backend; nothing is deployed and the web app shows a small part of it. `docs/direction.md`
section 7 sets three milestones, and each stream now works toward them in order. New API surface
waits until a screen uses it. The canvas, versioned config and billing move behind M2.

From 12 November the M2 screens are reached through a conversation-first workspace
(`docs/direction.md` section 9, ADR 0008): the web builds the block catalogue and the conversation
surface on the dev mock first, then the API adds the assistant route and proposal types.

| Stream | M1. It runs | M2. The FDE's day | M3. The customer side, and paying |
| --- | --- | --- | --- |
| API | The session reaches agent and eval routes | Next step and stage checklists; scope as an agreement with baselines; task order and links; the signal model, Slack inbound, GitHub widened, inbound webhook and results upload; Today over signals | Customer roles (ADR 0005), invites, billing, Jira and GitLab, calendar feed and forwarded email |
| Web | Fixes found by the first deploy | Today as an inbox; the engagement page by stage; the board; notes to tasks; proof; the weekly update; create from Jump to | IT admin and sponsor screens; the admin console |
| Agent | Production secret resolver; outbound policy written through the API; the GitHub token limited to checkout and delivery | OpenCode behind the harness adapter, gated by tests (ADR 0004); the MCP server connected for the FDE's own agent, read-only | Fixes from the first real engagement |
| Infra | The API's environment contract; deploys for the workers; reachable gateway and realtime | Per-company keys (before any real customer data); the inbound webhook route | Inbound email; a production environment |

## 7. Open decisions

| Decision | Default until the lead decides | ADR |
| --- | --- | --- |
| Shared or own SpiceDB and bus | Own, named `oryxa-fde-<env>` | 0002, 0003 |
| Customer people | Decided: sponsor and IT admin roles, users in the vendor's tenant for now | 0005 |
| First AWS region | Decided with design partners; dev in the region the platform uses | 0003 |
| Canvas library | Excalidraw, since tldraw needs a paid production licence | wave 2 |
| Product name and domain | `fde-web` placeholder | none |

## 8. Risks

- **Lead review is the bottleneck.** Four streams open PRs at once. Keep PRs small.
- **Vendored base drift.** Platform fixes reach us only when the lead re-syncs. Re-sync after the
  platform's coworker removal (oryxa-platform#161) merges.
- **Cloudflare Sandbox residency.** Confirm containers can be pinned to a region before putting
  any customer sample data in them.
- **Prompt injection.** Everything the agent reads is untrusted; approvals and the allowlist limit damage.
