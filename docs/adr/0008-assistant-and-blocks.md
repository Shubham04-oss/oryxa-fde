# 0008: The workspace assistant, blocks and confirmed actions

Status: accepted, 12 November 2026. Adds to `docs/direction.md` section 9. Does not change tenancy
(ADR 0002), the runtime split (ADR 0003) or the coding agent (ADR 0004). Amended 12 November 2026 by
ADR 0009: the assistant's engine runs on Durable Objects in front of the API, reaching data only
through it.

## Context
The founder wants the workspace to be conversation-first and generated per company and per person:
the FDE talks, and the workspace prepares plans, rules, invites and views. A model that can shape
screens and start actions is a new way for things to go wrong. It reads documents, messages and
signals that a customer or a stranger wrote, so it can be steered by text it was never meant to
obey, and a generated screen can show something misleading.

## Decision
- **The assistant has no authority of its own.** It holds no credentials and no role. Everything it
  reads, it reads through the API as the signed-in person, inside that person's `CompanyScope` or
  `ProjectScope`, with every permission check made by `oryxa-authz` as for any other call.
- **A conversation belongs to one company.** Every conversation is bound, when it starts, to one
  company (or one project in it), and that cannot change. It reads only that company's records, and
  a proposal may name only records in that company; the API refuses any other. The home
  conversation that spans companies reads only what the companies list already shows (names, stage,
  next step, counts), never documents, messages or signals, and may propose only opening a
  company's conversation or creating a company. So text planted in one company's material has no
  route to another company or its customer, even though the FDE may see both.
- **It answers with data, never with markup or code.** An answer is text plus a list of typed
  **blocks** from a fixed catalogue the web owns (plan, rules, people, checklist, board, proof,
  suggestion and so on). Each block has a schema; the API validates blocks before sending them and
  the web validates again before rendering. An unknown or malformed block is dropped. Text from the
  model and from people is rendered as text, never as HTML, links are shown only for our own
  routes, and no block loads an image or anything else from another host.
- **It proposes actions; a person confirms them.** A change is a typed **proposal** naming an
  action from a fixed catalogue (create a company, add a task, invite a person, request access, set
  a rule, move a stage and so on) with its exact arguments. The screen shows what will happen in
  plain words, taken from the arguments and not from the model's own description: each record by
  the name the person reads for it through the API, and any text that will be stored or sent in
  full. Nothing runs until the person confirms.
- **A confirmed action is an ordinary API call.** The web calls the existing route with the
  person's session, so validation, permission checks, the audit log and the outbox apply
  unchanged. There is no separate path by which the assistant writes. An action with no API route
  cannot be proposed.
- **Some actions always need their own confirmation.** Inviting a person, granting or requesting
  access, changing a role or a rule for agents, anything sent to a customer, connecting a source or
  adding an outbound host, starting an agent run, and anything that deletes are confirmed one at a
  time, never as part of "approve all". Where an action records a reason under the person's name
  (moving a stage with a checklist item open), the person types the reason; the assistant does not
  supply it.
- **Proactive means it prepares, not that it acts.** Suggestions raised by an event are built by a
  worker from the event's ids and fixed templates. The worker calls no model and reads no content,
  so it needs no person's authority; any wording from the model is produced when a person opens the
  suggestion, under that person's session and limits. A suggestion belongs to the company its event
  came from and opens in that company's conversation. Suggestions are shown to the people who may
  already see the records behind them, checked through `oryxa-authz` when shown, and never to a
  customer role (ADR 0005). A suggestion is a proposal like any other.
- **Everything it reads is untrusted.** Documents, messages, signals and web content are passed to
  the model as data, marked as such, and never as instructions. Because that marking cannot be
  relied on alone, the rules above are the defence: no authority, a fixed set of actions, and a
  person confirming exactly what will run.
- **Per company and per person.** What a company told the workspace in setup (how the work runs,
  the rules, the plan) is stored as that company's records, in AWS with the rest. Layout choices
  for a person are stored for that person. Conversation history is stored in Postgres in AWS as
  that company's data, readable by the person who held the conversation, under the company's key
  once per-company keys exist. The home conversation's history is stored for that person and holds
  only the list-level facts it may read. Context for one company is never put in a prompt for
  another.
- **Data and models.** The assistant runs behind the API. It sees sample data only until
  per-company keys exist (ADR 0003). Prompts and answers are never logged; logs carry ids.
  Which model serves it, and where prompts are processed, is a separate decision recorded before
  any real customer data is sent to one.
- **A plan step is a task.** The plan the assistant proposes is an ordered list of ordinary tasks,
  each tied to a stage and, where it proves something, to a success criterion. The first one not
  done is the project's next step. There is no separate plan record.
- **It is measured.** `oryxa-fde-evals` holds suites for the assistant itself: that a setup
  conversation yields a valid plan with a way to prove each criterion, that blocks validate, that
  it proposes nothing outside the catalogue, that instructions planted in documents and
  messages do not produce a proposal, and that nothing from one company appears in another's. A
  change of prompt or model runs these before it ships.
- **Limits.** Calls to the model are limited per person and per organisation, and a refusal says so
  plainly.

## Consequences
- The web builds the block catalogue and the conversation surface first, on the dev mock, with
  scripted steps (issue #209). The API adds the assistant route, the proposal types and their
  validation after that. Until then nothing calls a model.
- New capability costs two things: a block or an action added to a catalogue, and an eval for it.
  That is deliberate.
- The assistant cannot do anything a person could not do by hand, which keeps the screens in
  `docs/direction.md` section 3 honest: each must still work without it.
- Prompt injection can still waste a person's attention with a bad proposal. It cannot act without
  their confirmation of plainly stated arguments.

## Not decided here
The model and its region; streaming transport; whether the assistant may start hosted agent runs
(ADR 0004 governs those, and for now it may only propose one); memory across conversations beyond
the stored company records.
