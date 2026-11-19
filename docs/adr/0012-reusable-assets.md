# 0012: Reusable assets: versions, bindings, runs and forks

Status: accepted, for a later phase. **Do not build any of it until `docs/plan.md` schedules it;**
until then it is design only, and no issue may cite it as a reason to add a table, route or screen.
Phase 3 in `docs/roadmap.md`. Depends on ADR 0010 (organisations, the tree, roles) and ADR 0011
(types, inputs, resolution, the cost ledger). Amends ADR 0006: a connection belongs to an
organisation and may be narrowed to a node, instead of belonging to a company, and connectors no
longer get a table per vendor.

## Context
The work an FDE carries from one customer to the next is mostly definitions: how a tracker maps onto
work items, how data is pulled and shaped, how a criterion is proven, which stages an engagement
runs, which prompt drafts the weekly update. Before the reset each of these was its own table and
code path, and connectors were tables per vendor (`github_*`, `slack_*`). Nothing could be reused at
a second customer except by copying, and nothing recorded what a copy came from.

## Decision

### One shape for everything reusable
- **The asset kinds are a closed list,** grown only by an ADR: connector configuration, pipeline,
  eval suite, lifecycle template, block layout, prompt. ADR 0013 adds module and plugin.
- **Four tables carry every kind:**

| Table | Holds |
| --- | --- |
| `assets` | An asset: organisation, kind, name, the node it was made at, visibility, who made it |
| `asset_versions` | One immutable version: the spec, its declared inputs (ADR 0011), a content hash of the spec, `forked_from` (the version it was forked from, if any) |
| `bindings` | A version installed at a node, with each input bound to a variable or a value |
| `runs` | One run of a binding: who or what started it, the resolved snapshot (ADR 0011), the exact model release, tokens, cost, status, result |

- **Visibility:** `private` (the node the asset was made at and everything under it) or `shared`
  (the whole organisation). Seeing an asset also needs `view` on a node it is visible at; changing
  it needs `manage` at the node it was made at.
- **A version never changes.** Editing makes a new version. The content hash lets two versions be
  compared and lets a run say exactly what it ran.
- **Each kind has its own spec schema,** validated when a version is saved. This ADR fixes the shape
  they share; a kind's schema is written when the plan schedules that kind.
- **Platform assets.** We ship some assets ourselves (the default lifecycle template, base eval
  graders, starter prompts). They have no organisation, every organisation can read and bind them,
  and none can change them; changing one means forking it.

### Reuse: parameterise first, fork when the structure changes
- **Parameterise.** The same version is bound again at another customer workspace with different
  inputs. This is the normal way to reuse, and it keeps one definition.
- **Fork** when the structure must change. A fork is a new asset whose first version records
  `forked_from`. Lineage is kept, so a screen can show that the upstream asset has newer versions and
  what changed between the version forked and the newest. There is no automatic merge; a person
  copies what they want.
- **Upgrading a binding** to a newer version is an explicit action by someone with `manage` at the
  binding's node. It shows which inputs were added, removed or changed type, and refuses until each is
  bound.

### The hard rule: definitions only
- **An asset version holds only definitions.** Never customer data, never a secret value, never a
  value that only makes sense at one customer. Data and credentials live in the customer workspace:
  in connections, in bindings' inputs, in the records a run reads.
- The spec is checked on save: a field typed `secret` must be a reference, and a binding input of
  kind `connection` must name a connection, not hold one.

### Connectors and connections
- **A connector type is code:** its config schema, its secret schema, the signal kinds it produces
  (ADR 0006), and its fixed hosts. Types are registered in one place.
- **A connection is data:** one organisation's link to one source, optionally narrowed to a node (a
  customer workspace's Jira, a project's channel). It holds config validated against the type's
  schema and secret references only. Connections live in one generic table, and signals in one
  generic table keyed by connection and node.
- **Adding a vendor needs no migration.** It needs a connector type and its tests.
- **A connector configuration asset** is how an organisation reuses a mapping or filter across
  customers. It declares a `connection` input; each binding names the customer's own connection.
- ADR 0006 otherwise stands: generic routes first, no third party holds tokens, hosts fixed per
  connector or vetted per connection, everything inbound is untrusted, writing back is explicit.

### Lifecycle templates and eval suites
- **The eight stages become the default lifecycle template,** a platform asset with the stages and
  their checklists from `docs/direction.md` section 4. A project binds one version of one template.
  An organisation forks it to rename, add, drop or reorder stages and change checklists.
- **An eval suite is an asset:** cases, graders from a fixed list, and the inputs it needs, such as
  the model under test and a dataset connection. The cases' data stays in the customer workspace; the
  suite holds only how to grade. A suite run is a run like any other, with its snapshot and cost.
- **This completes ADR 0011's `after_checks` mode:** the suites bound to a model variable run on a
  candidate release, and it is promoted only when every one passes.

### Not in scope
Any marketplace, and any sharing of assets between organisations. The founder has deferred both to
keep focus. Platform assets are the only assets that cross an organisation's boundary, and they go
one way, from us.

## Consequences
- Tables per feature and per vendor give way to four tables plus a connection and a signal table,
  all keyed by `org_id` with row-level security (ADR 0010).
- Every run is explainable: what version, what inputs, from which layer, which model release, what it
  cost.
- Without merge, a fork that wants upstream fixes is updated by hand. That is accepted until forks
  are common enough to show what a merge would need.
- Each new kind still costs a spec schema, a runner and tests. The shared shape removes the tables
  and lineage work, not that.

## Open questions

| Question | Default |
| --- | --- |
| Does a binding follow new versions of its asset on its own? | No. Upgrades are explicit, as above. |
| May a private asset be made shared later? | Yes, by someone with `manage` at the root node, audited. Shared cannot go back to private while another node binds it. |
