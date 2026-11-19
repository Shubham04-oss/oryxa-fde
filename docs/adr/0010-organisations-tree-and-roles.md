# 0010: Organisations, the node tree and roles

Status: accepted, 19 November 2026. Phase 1, the basics (`docs/plan.md`). Depends on ADRs 0001, 0002
and 0007 only; nothing here needs ADR 0011, 0012 or 0013. Amends ADR 0002 (the tenant is the
organisation, and one generic `node` replaces `fde_company` and `fde_project`), ADR 0005 (the vendor's
roles become node roles; the customer roles wait) and ADR 0007 (sign-up is no longer invitation only).

## Context
The reset of 18 November 2026 (#296) left one table, `sign_in_limits`, and a SpiceDB schema with one
`workspace` per tenant. Everything else has to be rebuilt, and the founder wants the basics settled
before anything that sits on them.

The schema before the reset keyed everything by tenant, then company, then project. It had no table
for the tenant itself, so nothing that WorkOS does not hold (kind, plan, settings) had a home, and its
two fixed levels could not express an agency that groups its customers, or an independent FDE who
works alone. A person who is in no WorkOS organisation is refused today (`organisation_of` in
`session.rs`), and the only way to get an account is to accept an invitation.

## Decision

### Organisations
- **Everything belongs to an organisation,** and the product always calls it that. The tenant of
  ADR 0002 is the organisation: one WorkOS organisation, whose id stays the key (`TenantId`). Every
  signed-in call is scoped to the organisation of the verified token, never one named in a request.
- **Two kinds, one thing.** `kind` is `personal` or `organisation`. A personal organisation is made
  for a person when they sign up and has one member. It is an organisation in every other respect:
  it has a tree, it can hold customer workspaces, and it can invite people. Its admin turns it into
  a full organisation by changing `kind` and its name, in one audited update. No data moves, and no
  id changes. It cannot go back to `personal` while it has more than one member.
- **An `organisations` table holds what WorkOS does not:** kind, name, plan, settings, who made it
  and when. WorkOS still holds membership and each member's organisation role. A rename is written
  to our row first, then to WorkOS, so its own organisation choice shows the same name.
- **Organisations that exist before this** (dev only) get their row the first time one of their
  members signs in after the change, as kind `organisation` with the WorkOS name.

### Self-serve sign-up
- **A sign-up route and screen** let a person make an account without an invitation. The API creates
  the WorkOS user through the `AuthKit` trait (ADR 0007), and the person verifies their email on our
  screens. Only once the address is verified does the API create the WorkOS organisation, make the
  person its admin, and write the `organisations` row (kind `personal`, name "Personal") and its root
  node in one transaction. Then it issues the session, as for any sign-in.
- **A verified person in no organisation** (a Google sign-in with no account, or someone whose last
  membership ended) is no longer refused. They are offered the same step, "create your personal
  organisation", with one button, and get no session until it is done.
- **One personal organisation per person** at a time, enforced by a unique index. Phase 1 has no
  route to create a second organisation of either kind.
- **The route keeps every guard of ADR 0007:** the same answer whether or not an address already has
  an account, the limits per address and per client and the overall ceiling, the origin check, the
  password never logged or stored, a pending step only in a sealed `__Host-` cookie.
- **Amends ADR 0007:** "Sign-up is off except with an invitation" now reads: sign-up is our route
  only. WorkOS's own hosted sign-up stays off, as do domain-based membership and just-in-time SSO
  membership.
- **Out of scope:** hosting modes (self-hosted or single-tenant installs). Nothing here plans for
  them.

### The node tree
- **One generic tree per organisation:**

```
organisation (the root node, one per organisation)
└── group            optional, nestable
    └── customer workspace
        └── project
```

| Kind | Parent may be | Notes |
| --- | --- | --- |
| `organisation` | none | Made with the organisation; cannot be archived |
| `group` | `organisation`, `group` | For an agency's teams or regions |
| `customer_workspace` | `organisation`, `group` | One customer firm; what ADR 0002 called a company |
| `project` | `customer_workspace` | One engagement; what ADR 0002 called a project |

- **One `nodes` table:** `org_id`, `node_id`, `parent_id`, `kind`, `name`, `path`, `created_by`,
  `created_at`, `archived_at`. The primary key is `(org_id, node_id)`, and the parent is a foreign key
  on `(org_id, parent_id)`, so a node cannot hang under another organisation's node even by mistake.
- **`path` is a Postgres `ltree`** of node ids from the root, each written as 32 hex characters so
  every id is a valid label. It answers "everything under this node" and "every node above this one"
  with one indexed query. A tree is at most eight levels deep.
- **Node ids are a validated type** (`NodeId`), as are kinds (`NodeKind`); a raw string never reaches
  SQL, SpiceDB, a log or an event.
- **Phase 1 creates, renames and archives nodes.** Archiving hides a node and everything under it
  and keeps the rows. Moving a subtree (one transaction that rewrites the paths and the SpiceDB
  `parent` relation, never across organisations) and deleting for good come later.

### Roles on nodes
- **Four roles,** each held on a node and inherited by everything under it:

| Role | Permission it gives | Means |
| --- | --- | --- |
| `admin` | `manage` | Change the node, create and archive what is under it, grant and remove roles on it |
| `fde` | `work` | Do the work in it (in Phase 1 there is no work yet; later phases add it) |
| `member` | `view` | Read it and everything under it |
| `guest` | `see` | Read only what is shown to people outside the organisation, on that node and under it |

- **One SpiceDB definition** replaces `fde_company` and `fde_project`. The organisation's admins stay
  as they are: the WorkOS role, mirrored onto the `workspace` object on each call as today, and linked
  to the root node:

```
definition node {
    relation organisation: workspace   // the root node only
    relation parent: node
    relation admin: user
    relation fde: user
    relation member: user
    relation guest: user

    permission manage = admin + parent->manage + organisation->manage
    permission work = fde + manage + parent->work
    permission view = member + work + parent->view
    permission see = guest + view + parent->see
}
```

- **An organisation admin is the WorkOS `admin` role,** and nothing else. The API refuses `admin` on
  the root node as a relation; making someone an organisation admin changes their WorkOS role. A
  WorkOS `member` holds nothing on the tree until a role is granted to them.
- **Staff or guest, not both.** A person who holds `admin`, `fde` or `member` anywhere in an
  organisation is staff there; a guest holds only `guest` roles. The API refuses a guest role for
  staff and a staff role for a guest, as ADR 0005 refuses mixing vendor and customer roles. A guest
  is still a WorkOS member of the organisation, since membership decides sign-in (ADR 0007).
- **What a guest sees is an allowlist.** In Phase 1 that is a node's name and kind and the names of
  the nodes under it that they can see. Members, the audit log and settings need `view` or more.
- **SpiceDB decides, through `oryxa-authz` only.** Every check is a SpiceDB check. Object ids are
  `<tenant>|<id>` as `oryxa-authz` writes them, so a relation can never cross organisations.
- **The `node_roles` table is the record, not the decision.** It holds `(org_id, node_id, user_id,
  role, granted_by, granted_at)` so that members can be listed and grants retried. It is never read
  to allow anything. Grants follow the pattern used before the reset: the row commits first, the
  relationship is written after it under the row's lock, and a reconciler running as
  `oryxa_fde_grants` retries rows not yet granted, with back-off. A removal deletes the SpiceDB
  relationship before it reports success, so a failure leaves the call failed and access removed or
  unchanged, never removed in the database and still granted in SpiceDB.
- **Leaving an organisation** removes the WorkOS membership and every node role the person held in it.
- **Names and addresses in a list of members** are read from WorkOS when shown and are not stored.
- **An organisation always keeps one admin.** Removing or demoting the last one is refused.

### Invitations
- **An invitation is into an organisation, with a role on one node.** It needs `manage` on that node.
  The API sends a WorkOS invitation to the organisation as `member` and keeps our own row
  (`invitations`: org, WorkOS invitation id, address, node, role, invited by, state). Accepting it on
  the existing route (ADR 0007, read from the invitation and never from the request) grants that role.
- **A person already in the organisation** gets the role directly, without an invitation.
- **A personal organisation** must become an organisation before its first invitation; the invite
  screen offers that in the same step.
- The address is kept in the invitation row, which is the organisation's data. It never goes in a
  log, an event or the audit row.

### Isolation
- **SQL always filters by organisation.** Every store function takes an `OrgScope`, built only from a
  verified token's `TenantId`.
- **Row-level security is the second layer.** Every table carries `org_id`. The store sets the
  organisation for each transaction (`set local`) along with the transaction role, and each table's
  policy compares to it. With the setting missing a policy matches nothing, so a query that forgets
  its filter, or runs outside a scope, sees no rows.
- **A node the caller cannot see answers 404,** the same as one that does not exist, so ids from
  another organisation, or from a subtree the caller has no role in, reveal nothing.
- **The organisation switcher** lists the caller's memberships as WorkOS reports them for the
  verified user. For each, it reads the name and kind under that organisation's own scope. Ids never
  come from the request. Switching refreshes the session for the chosen organisation through WorkOS
  and issues a new session cookie; it is refused unless WorkOS confirms the membership.
- **The isolation suite** runs every route, in CI, as: someone in another organisation; someone in
  the same organisation with no role on the node; a guest; each role on a sibling subtree. Any read or
  change that succeeds fails the build. The suite reads the route list from `openapi.json` and fails
  when a route has no cases, so a new route cannot skip it. A second test drops a filter on purpose
  and shows row-level security returns nothing.

### Audit and events
- **Every change in this ADR writes an audit row in the same transaction:** organisation created,
  renamed or converted; node created, renamed or archived; role granted, changed or removed;
  invitation sent, revoked or accepted; member removed. A row holds ids, the action from a fixed
  list, the actor and the time, never an address or a name. The runtime roles may insert and read
  audit rows, never update or delete them.
- **Every change also writes an outbox row** in the same transaction, ids only, as `CLAUDE.md`
  requires. Phase 1 has no consumer, so nothing publishes them yet. The relay, which signs and
  publishes through `oryxa-events`, arrives with the first consumer, and sends what has built up.

## Consequences
- `schema/fde.zed` gains `node` and its validation cases; that is a lead change. `fde_company` and
  `fde_project` do not come back.
- The `ltree` extension must exist before the migration. The infra bootstrap creates it as the RDS
  master, and the migration creates it only if missing, for local and CI databases.
- The API gains organisation, node, role, invitation, sign-up and switch routes, and the web gains
  the sign-up screen, the switcher, the tree and the members screen. That is `docs/plan.md`.
- Mirroring the WorkOS role onto `workspace` stays as it is, so a demotion still stops writes at once.
- ADR 0005's sponsor and IT admin become relations on `node` when the customer side is scheduled, on
  `customer_workspace` and `project` nodes, with the same rule that the vendor's side cannot hold
  them. Until then `guest` is the only role for someone outside the organisation.
- Self-serve sign-up opens an unauthenticated route that creates WorkOS users and organisations. The
  limits of ADR 0007 apply, and the organisation is made only after the address is verified, so an
  unverified address creates a user and nothing else.

## Open questions
Each has the default we build on until the lead decides otherwise.

| Question | Default |
| --- | --- |
| Does a customer firm live as a node in the deploying organisation's tree, or as its own organisation that grants access? | A node: a `customer_workspace` in the deploying organisation's tree. Revisit with the customer portal. |
| Are groups nestable? | Yes, in the model and the schema. Phase 1 may ship organisation → customer workspace → project only, with groups added when a screen needs them. |
| May a personal organisation own customer workspaces? | Yes. |
