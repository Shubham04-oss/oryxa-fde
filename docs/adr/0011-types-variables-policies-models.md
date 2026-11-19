# 0011: Types, variables, policies and the model catalogue

Status: accepted, for a later phase. **Do not build any of it until `docs/plan.md` schedules it;**
until then it is design only, and no issue may cite it as a reason to add a table, route or screen.
Phase 2 in `docs/roadmap.md`. Depends on ADR 0010 (organisations, the node tree, roles). Replaces the
"layered org, company and project config" of the plan before the reset, and ADR 0009's "a model is
chosen by name in config".

## Context
Before the reset, configuration was a set of keys the code knew by name (a default model, a budget),
layered over organisation, company and project. Every new setting meant new code, the platform owned
the names, and an organisation could neither describe its own settings nor limit what the levels
below it chose. Model choice was a name in config, so "the latest of this family" or "only this
provider" could not be said at all.

The founder wants three things: no hard-coded keys; an organisation that can declare its own settings
and set rules for the levels below; and models treated as structured, versioned data rather than
strings, with what each run used and cost on record.

## Decision

### 1. Types
- **A small fixed set of kinds,** defined in code and changed only by an ADR:

| Group | Kinds |
| --- | --- |
| Primitives | `text`, `number`, `boolean`, `duration`, `money` (amount and currency), `enum` |
| References | `model`, `connection`, `secret`, `asset`, `person`, `node` |
| Composites | `list` (of one type), `record` (named fields, each typed) |

- **An organisation may declare its own types,** built only from these kinds: an `sla` record with a
  response `duration` and a `money` penalty, an `enum` of its own tiers. A declared type is data: a
  name, a kind and a schema, stored per organisation and versioned. It cannot carry code.
- **Constraints come from a fixed list:** required, minimum and maximum, length, one of, and a
  pattern matched by a linear-time engine with a length cap. Nothing else validates a value.
- **References cannot be invented.** An organisation cannot add a reference kind. A reference is
  checked against the thing it names, inside the same organisation, through `oryxa-authz` where a
  permission applies.

### 2. Variables
- **A variable is a named, typed value that an organisation declares at a node.** The platform
  reserves no names. A variable is visible at its node and everything under it. A name already
  declared above on the same path cannot be declared again below it, so a name means one thing along
  any path.
- **Values may be set at the declaring node and at any node under it,** by someone with `manage`
  there. A variable marked `user_settable` also takes a value per person, which applies only to that
  person's own runs.
- **Values are versioned and audited.** Setting a value appends a version (who, when, which node);
  nothing is overwritten. Every change writes an audit row (ADR 0010).
- **A secret is only ever a reference.** A `secret` value is a reference to AWS Secrets Manager. When
  someone enters a key, the API writes it to Secrets Manager under the organisation's prefix and
  stores the reference; the value is never returned, logged or put in an event.

### 3. Inputs and bindings
- **Features and assets declare inputs by type and constraint, never by a global name:**
  `chat_model: model where capabilities ⊇ {tools}`, `escalation: sla`, `budget: money where ≤ 500`.
  An input may carry a default, which is the platform's layer for it.
- **An organisation binds each input** to a variable or to a value. A binding whose variable or value
  fails the input's type or constraint is refused when it is made, and again at resolution if a later
  change breaks it.

### 4. Resolution
- **An input resolves through these layers, each overriding the one before:**

| Order | Layer |
| --- | --- |
| 1 | The platform's default, from the input's declaration |
| 2 | The organisation (the root node) |
| 3 | Each group on the path, top down |
| 4 | The customer workspace |
| 5 | The project |
| 6 | The person's own value, only for a `user_settable` variable |

- **Policies set above restrict everything below.** A policy is set at a node by someone with
  `manage` there, and is either `locked` (one value) or `allowed` (a set, or a constraint). It names
  one variable, or a type and a field of it, in which case it covers every variable and binding of
  that type under the node. Examples: a model vendor's own organisation locks `provider` of every
  `model` to itself; an agency allows `family` ∈ {atlas, nimbus} for every customer workspace.
- **A lower layer cannot loosen a policy.** A value that a policy above refuses is refused when set.
  If a policy is added later, values below that break it stop counting, and resolution reports them
  as overridden by that policy. If nothing left satisfies the policies and the input's constraint,
  the input is unresolved and whatever needs it refuses to run, with a plain reason. It never falls
  back to an unconstrained value.
- **Every resolved value reports where it came from:** the layer, the node, the value's version and
  who set it, and each policy that narrowed it. Screens show this beside the value.
- **Every run snapshots what it resolved.** Whatever records a run stores the resolved values with
  their sources, so the run can be explained and repeated. A later change does not alter a run's
  record.

### 5. Models as a structured type
- **A model reference has five levels:** provider, family, generation, variant, release. Written in
  full: `acme/atlas/5.5/mini@2026-10-01`.
- **A reference may stop early:**

| Written | Resolves to |
| --- | --- |
| `acme/atlas/5.5/mini@2026-10-01` | That release, exactly |
| `acme/atlas/5.5/mini` | The newest release of that variant |
| `acme/atlas/5.5` | The newest release of the generation's default variant |
| `acme/atlas/5.x` | The newest generation in the 5 line, then as above |

  The provider may be left off when exactly one provider the organisation can use offers the family;
  otherwise the reference is refused as ambiguous. "Newest" counts only releases that are available,
  meet the input's constraint and pass every policy that applies.
- **The catalogue is data, not code.** We ship a base list as a data file loaded by a migration and
  readable by every organisation. An organisation adds its own entries: its own endpoint (an API
  style from a fixed list, and one HTTPS host vetted as in ADR 0006), its own key as a `secret`
  reference, and its own prices. Its entries are visible only inside it.
- **Each catalogue entry records capabilities** from a fixed vocabulary (tools, vision, structured
  output, context length and so on) **and prices** per million input and output tokens, with currency
  and the date the price applies from.
- **Runs record the exact release** that a reference resolved to, never the partial reference alone.
- **Release-follow is set per variable** of type `model`, by the organisation:

| Mode | A new matching release is used |
| --- | --- |
| `follow` | From the next run |
| `after_checks` | Once the checks bound to the variable pass on it |
| `pinned` | Only after someone with `manage` approves it |

  Under `after_checks` and `pinned` the variable holds a current release and a candidate, and
  resolution uses the current one until the candidate is promoted, with an audit row. `after_checks`
  needs eval suites, which a later phase adds; until then it is not offered.
- **Out:** choosing a model at run time by price or speed. A model is what resolution says.

### 6. The cost ledger
- **Every model call made for a run adds a ledger entry** against the node it ran at: the run, the
  exact release, input and output tokens, and the cost at the price in force, stored with the entry
  so a later price change does not rewrite it.
- **An organisation sees cost per node and rolls it up the tree,** with `manage` on the node. An agency
  can set its own price per customer workspace (a `money` variable it declares, nothing special) and
  read its margin against cost.
- Billing integration, and our own charges on top, come later.

## Consequences
- New tables, all keyed by `org_id` with row-level security (ADR 0010): types, variables, variable
  values, policies, the catalogue's organisation entries, the ledger. The base catalogue is the one
  set of rows with no organisation, read-only to every runtime role.
- A setting is added by declaring an input on a feature, not by adding a key, so the platform never
  reserves a name an organisation might want.
- A catalogue endpoint's host joins that organisation's outbound allowlist, so an organisation can add
  a model host but never one for another organisation.
- Resolution runs on every run and must be fast; it reads one path of the tree and that path's values
  and policies, and its result is cached only for the length of one request.

## Open questions

| Question | Default |
| --- | --- |
| One currency per organisation, or several? | One, chosen at creation; prices in another currency are converted at the rate on the entry's date and the rate is stored. |
| May a person's own value pick a model? | Only where the organisation marks that model variable `user_settable`, and always inside its policies. |
| How long are superseded variable versions kept? | For the life of the organisation, like audit rows. |
