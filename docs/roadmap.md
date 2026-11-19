# Roadmap

What comes after the current phase. **Nothing on this page is built until `docs/plan.md` moves it
in,** as issues with labels, paths and a done-when. Until then a phase here is a direction, not work:
no issue, branch or PR may cite this page or ADRs 0011 to 0013 as a reason to add a table, route,
service or screen. Last updated 19 November 2026.

Phase 1, the basics (organisations, the node tree, roles, invitations, audit, isolation), is in
`docs/plan.md`. The phases below are in order: each rests on the ones before it, never on a later one.

## Phase 2: types, variables, policies and models

ADR 0011.

- The fixed type kinds, and an organisation's own types built from them.
- Variables declared at any node, with versioned, audited values; secrets as references only.
- Inputs declared by type and constraint, and bindings refused when they fail.
- Resolution down the tree, policies that lock or narrow, and where each value came from.
- The model catalogue as data: the base list, an organisation's own endpoints and prices,
  capabilities, structured references and release-follow (`follow` and `pinned`; `after_checks` waits
  for phase 3).
- The cost ledger per run and node, with margin per customer workspace.
- The event relay and bus, if a consumer needs them by then.

## Phase 3: assets, bindings, runs and forks

ADR 0012.

- `assets`, `asset_versions`, `bindings`, `runs`, with lineage for forks.
- Connector types in code and generic connections; signals in one table (ADR 0006's kinds).
- The default lifecycle template (the eight stages), and forking it.
- Eval suites as assets, and `after_checks` release-follow on top of them.

## Phase 4: personal workspaces

ADR 0013, first half.

- The block catalogue and block descriptions rendered from any source.
- Record types: ours, connector-filled, and a person's own.
- Rules with a fixed action list, no loops, rate limits and cost caps.
- Modules as assets; our own features rebuilt as modules.
- A person's workspace of pages, private by default, and job profiles as starting layouts.

## Phase 5: the plugin runner

ADR 0013, second half.

- The plugin runner service (wasmtime), the WIT host interface, manifests, limits and the
  proposed-action rule for shared writes.
- The isolated build step and the authoring flow: write, build, check, preview, install.
- Then connector adapters, ETL transform steps and eval graders as components.

## Decided earlier, not yet in a phase

These ADRs still stand, but no phase above schedules them. They come back through a plan update that
says where they fit.

| ADR | What |
| --- | --- |
| 0003, 0004 | Sandboxes and the coding agent |
| 0005 | The customer's sponsor and IT admin roles, as `node` relations (ADR 0010) |
| 0008, 0009 | The workspace assistant |

## Not planned

Not in any phase, and not to be designed for:

- A marketplace, or any sharing of assets between organisations.
- Hosting modes: self-hosted or single-tenant installs.
- Plugin UI in a sandboxed iframe on a separate origin.
- Choosing a model at run time by price or speed.
