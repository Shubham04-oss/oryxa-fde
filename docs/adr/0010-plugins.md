# 0010: A small core, and everything else a plugin

Status: proposed, 17 November 2026. Waits for the founder's yes. Changes how `docs/plan.md` section 4
is organised and how a project's stages are held. Does not change tenancy (ADR 0002), the runtime
split (ADR 0003), customer roles (ADR 0005) or the rules for the assistant (ADR 0008, ADR 0009).

## Context
The product was built as one fixed shape. Every project has the same eight stages, in the same
order, held as one enum in `oryxa-fde-core`. Evals, agent runs, the customer room, the canvas and
each connector are always present, and each is wired by hand into the API's routes, the web's
navigation, the assistant's catalogues and the lifecycle rules.

Engagements are not one shape. One FDE proves a model with evals and never deploys anything.
Another ships to a customer's cloud and needs deployments and a handoff, and no canvas. The founder
wants the workspace generated per company (`docs/direction.md` section 9), and a fixed shape can
only be hidden per company, never fitted.

Some of the seams already exist: connectors map onto signals (ADR 0006), the assistant answers from
catalogues of blocks and actions (ADR 0008), and the agent harness, the models and the embedder sit
behind adapters. What is missing is one place that says which parts exist, and which of them a
company uses.

## Decision
- **A small core that is always on.** Sign-in and sessions, organisations, companies, projects and
  people, permissions, the store's tenant and company isolation, the outbox and the event trail, the
  audit log, tasks, the home screen, the conversation with its confirm-before-change rule, and the
  plugin registry itself. A plugin cannot replace, wrap or switch off any of these.
- **Everything else is a plugin.** A plugin is one capability a company may or may not use. The
  first set, from what is built: scope and success criteria, access tracker, documents and search,
  evals, agent runs, deployments, handoff, customer room, weekly update, canvas, meeting notes, and
  one plugin per connector (GitHub, Slack, the inbound webhook, the results upload). New
  capabilities arrive as plugins, never as additions to the core.
- **A plugin is described by a manifest.** The manifest is data, checked when the service starts,
  and it is the only way a plugin reaches the rest of the product. It names:
  - an id, a name a person reads, and a version;
  - the plugins it needs (evals needs scope, because a result is compared with a criterion);
  - the stages and checklist items it adds to a project;
  - its API routes and the permissions they check;
  - its events;
  - what it gives the assistant: read tools, blocks and proposed actions;
  - what it gives the web: screens, navigation entries, and the kinds of item it puts on home;
  - its lifecycle rules;
  - its settings and their schema.
- **Plugins are ours, and compiled in.** A plugin is code in this repo: a module in the crate that
  owns it, a folder in `fde-web/`, entries in the assistant's catalogues. Nothing is loaded at run
  time and nobody outside Oryxa can add one. The registry is a fixed list in code.
- **Switched on in layers.** An organisation sets a default set, a company may change it, and a
  project may change it again. The choice is stored as rows in Postgres with the company's other
  records. Switching is an ordinary API call with a permission check, an audit entry and an event.
  An unknown plugin id, or an error reading the choice, means off.
- **Off means absent, not deleted.** When a plugin is off for a project its routes answer exactly
  as a missing route does, its screens and navigation are not sent, its items leave home, its rules
  do not run, and the assistant is given none of its tools, blocks or actions; the API refuses a
  proposal that names one. Its tables stay, with their data and their isolation, and switching the
  plugin back on shows the data again. Migrations run for every plugin whether or not anyone uses
  it, so there is one database shape.
- **A project's stages come from its plugins.** The enum of eight stages is replaced by an ordered
  path built for each project from the stages its plugins add, in an order the registry fixes. A
  project with no deployments plugin has no deploy stage. The rule for moving stays: forward by one
  along the project's own path, or back to any earlier stage. A plugin cannot be switched off while
  the project stands in a stage that only it provides.
- **The setup conversation proposes the set.** From what the person says about how the work runs,
  the assistant proposes which plugins to switch on, as one proposal the person confirms, with each
  plugin named in plain words. Presets ("prove it with evals", "build and hand off") are named sets
  of plugins and nothing more.
- **Permissions stay one schema.** `schema/fde.zed` holds the relations for every plugin. A plugin
  being on never grants anything; it only decides whether its routes exist. A route still makes its
  own check through `oryxa-authz`.
- **Later: plugins written by others.** Not now, and not before a real engagement has run. The
  manifest is the contract they would use, so a plugin must reach data only through declared routes
  and never through another plugin's tables. An outside plugin would run out of process, behind
  that contract, with its own review before it is listed. That needs its own ADR.

## How we get there
No rewrite. Each step is one small PR, and `main` keeps working at every step because every existing
company starts with every plugin on.

1. The registry, the manifest type, the stored choice, the route that reads it, and the gate that
   makes an off plugin's routes answer as missing. Evals is the first plugin through it.
2. The web reads the set and builds navigation, screens and home from it. The assistant builds its
   catalogues from it.
3. Stages per project, replacing the enum.
4. The remaining capabilities move behind manifests one at a time. Connectors follow ADR 0006
   unchanged and gain a manifest.
5. The setup conversation proposes the set.

## Consequences
- A new capability costs a manifest, its code, an eval for what it gives the assistant, and a row in
  the isolation suite for the off state. It no longer costs edits across the core.
- The isolation suite grows: every plugin route is checked on, off, and off for one project while on
  for another in the same company.
- The stage change touches `oryxa-fde-core`, the store, the API and the web together, and is the
  one risky step. It gets its own PR and a migration that maps every existing project onto the full
  path.
- Screens can no longer assume a neighbour exists. The project page is laid out from the set, which
  the redesign should take as given.
- Billing can later charge by plugin. Billing itself is the organisation's and stays in the core.
- Work that only tidies an always-on feature (follow-up issues on the canvas, the customer room and
  the like) waits until that feature is a plugin, unless it fixes a fault.
