# 0006: Signals and connectors

Status: accepted, 10 November 2026.

## Context
An FDE's tools are chosen by each customer, and they differ from one customer to the next. Our only
inbound integration reads two GitHub events, Slack is outbound only, and Today is built from our
own tasks and access requests. Adding integrations one vendor at a time would never cover the
range, and would make the product depend on whichever vendor came first.

## Decision
- **One model.** Anything that happens outside the product arrives as a **signal** of one of eight
  kinds: conversation, work item, code change, check result, meeting, document, access grant, eval
  result. A connector is only a mapper from one tool onto these kinds. Today, the board, proof and
  the weekly update read signals, never a vendor's shape.
- **Connections belong to a company.** A connection links one customer company (or one of its
  projects) to one source, and every signal carries a `CompanyScope`. A vendor-wide install, such
  as a Slack workspace, is still linked per company before anything is read.
- **Generic routes are first-class**, so no named vendor is required and a customer whose admins
  will not install an app is still covered:
  - a signed inbound webhook per connection;
  - a results upload: JUnit XML or CSV for checks and evals, OpenTelemetry traces later;
  - an iCalendar feed for meetings;
  - a forwarding address for email.
- **Named connectors are built natively**, in `oryxa-fde-integrations`, in this order: Slack inbound
  (messages and mentions in linked channels, including Slack Connect), GitHub widened (review
  requests, check runs, issues), Jira, GitLab. Teams, Azure DevOps and Linear follow demand.
- **No third party holds our customers' tokens.** Hosted integration platforms are out. Tokens stay
  in Secrets Manager with only a reference stored, every connector's hosts join the outbound
  allowlist, and redirects stay off.
- **MCP is for the agent, not for ingestion.** A coding agent may read a customer's tracker through
  an MCP server at run time, under approvals. MCP has no inbound events and ties access to an
  interactive user, so it does not feed signals.
- **A signal stores references, not content.** The row holds the source, kind, external id, state,
  timestamps and a link back. Titles and message text are fetched from the source when shown and
  are not kept, until per-company keys exist (ADR 0003). Events on the bus stay ids only.
- **Everything inbound is untrusted.** A webhook is used only if its signature and age check out;
  a failure drops it. Ids are parsed into types before they reach SQL, SpiceDB or logs. Text from
  a signal is data, never an instruction, wherever an agent or a drafted update reads it.
- **Writing back is explicit.** Posting to a channel or creating an issue happens only on an FDE's
  action or an approved update, never as a side effect of reading.

## Consequences
- The GitHub webhook handler becomes the first connector on the model instead of a special case.
- Today needs a new read that merges signals with tasks and access requests.
- A "needs a reply" item is a conversation signal from a customer person with no answer from the
  vendor within one business day.
- Fetching content on demand costs latency and rate limit. It is the price of holding no customer
  text before per-company keys, and it is revisited when they exist.
