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
  interactive user, so it does not feed signals. Our own MCP server stays read-only.
- **What a signal stores depends on whether the source can be asked again.**
  - *A source we can fetch from* (Slack, GitHub, Jira, GitLab): the row holds the source, kind,
    the source's opaque ids, state and timestamps. Titles and message text are fetched when shown
    and not kept. No URL is stored: a link back is built from the ids when shown, because a stored
    URL can carry a title, a path or a branch name.
  - *A route with nothing to fetch from* (a webhook body, a results file, a forwarded email, a
    pasted note): the content is customer content. It is stored in AWS under the company's prefix
    and encrypted with the company's own key, and such a route can be switched on for a company
    only once that key exists (ADR 0003). Until then these routes take sample data only.
  - Events on the bus stay ids only, for every kind.
- **A feed address is a secret.** A private calendar feed URL grants access by itself, so it goes in
  Secrets Manager and only its reference is stored, like a token.
- **Hosts are fixed per connector, or vetted per connection.** A cloud connector calls only its
  vendor's hosts on the allowlist. A customer-hosted source (their own Jira, GitLab or calendar
  server) is added by a tenant admin as one HTTPS host for one connection, and every request to it
  is refused if the name resolves to a private, loopback or link-local address, checked at request
  time and not only at setup. A source that is reachable only inside a customer's network waits
  for the runner.
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
  text from those sources, and it is revisited once per-company keys exist.
- Per-company keys now gate the generic routes for real data, so they move ahead of the first real
  engagement (`docs/direction.md` section 7).
