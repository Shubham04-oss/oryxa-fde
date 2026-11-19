# FDE workspace: build plan

The source for every issue in this repo. It holds **only the current phase.** Later phases are in
`docs/roadmap.md` and are not built until they move here. `docs/direction.md` says what the product is
for; decisions live in `docs/adr/`. Last updated 19 November 2026.

## 1. Where we are

Since the reset of 18 November 2026 (#296, #297) the repository is sign-in only: our sign-in screens
and the WorkOS engine behind them (ADR 0007), the session cookie, `/v1/me`, and one table,
`sign_in_limits`. The database role model stays as it is: a runtime login with no privileges of its
own, `SET LOCAL ROLE` in every transaction, forced row-level security. A person in no WorkOS
organisation is refused, and accounts are made only by accepting an invitation.

## 2. Phase 1: the basics

Built to ADR 0010. Nothing from ADRs 0011 to 0013 is built in this phase.

| Ships | |
| --- | --- |
| Organisations | The `organisations` table, kinds `personal` and `organisation`, converting one to the other |
| Sign-up | A self-serve sign-up route and screen that make a personal organisation; a verified person in no organisation is offered one instead of being refused |
| The tree | `nodes` with `ltree` paths: organisation → customer workspace → project, groups where a screen needs them |
| Roles | `admin`, `fde`, `member`, `guest` on nodes, in SpiceDB, inherited down the tree |
| Invitations | Into an organisation, with a role on one node |
| Audit | An audit row for every change, in the change's transaction; outbox rows likewise, unpublished until a consumer exists |
| Isolation | `OrgScope` on every store function, row-level security by organisation, and an isolation suite over every route |
| Web | Sign-up, the organisation switcher, tree navigation, members and invitations |

**Phase 1 is done when,** in dev: a person signs up, verifies their email and lands in their personal
organisation; creates a customer workspace and a project in it; converts to an organisation and
invites a second person as `fde` on that customer workspace; the second person accepts, sees that
subtree and nothing else, and can switch back to their own personal organisation; every step has an
audit row; and the isolation suite covers every route and passes in CI.

**Not in this phase:** moving or deleting nodes, a second organisation for the same person, customer
roles (sponsor, IT admin), the event relay and bus, a screen for the audit log, and everything in
`docs/roadmap.md`.

## 3. Rules for this phase

- One issue, one branch, one PR (`CLAUDE.md`). Issues are worked in the order below; an issue starts
  once every issue it depends on has merged.
- An API issue that changes `openapi.json` regenerates `fde-web/src/lib/api/fde-api.gen.ts` and keeps
  `schemas.ts` in step, in the same PR (`CLAUDE.md`, rule 8).
- From issue 11 on, every API issue that adds a route adds its isolation cases in the same PR; the
  suite fails on a route without them.
- Web issues build on the dev mock first, from the merged `openapi.json`, then on the real API.
- Every store function takes an `OrgScope`; every change writes its audit and outbox rows in its own
  transaction; every permission check goes through `oryxa-authz`.

## 4. Issues, in build order

### 1. `schema: a generic node with roles inherited down the tree`
- **Label:** `lead`. **Paths:** `schema/fde.zed`, `schema/fde.validation.yaml`.
- **Does:** adds the `node` definition of ADR 0010 beside `user` and `workspace`.
- **Done when:** `zed validate` passes with assertions that each role inherits down; an organisation
  admin (via `workspace`) manages every node; a guest has `see` and not `view`; a role on one subtree
  gives nothing on a sibling; another tenant's users get nothing, even with the same names.

### 2. `lead: WorkOS settings for self-serve sign-up`
- **Label:** `lead`. **Paths:** none in the repo, unless a setting differs from ADR 0010.
- **Does:** checks in each environment that the API's WorkOS credential may create users,
  organisations and memberships, and that WorkOS's hosted sign-up, domain membership and just-in-time
  SSO membership stay off.
- **Done when:** the settings for dev and staging are recorded on the issue and match ADR 0010.

### 3. `infra: the database bootstrap creates the ltree extension`
- **Label:** `agent:infra`. **Paths:** `infra/sql/01-bootstrap.sql`.
- **Does:** creates `ltree` in `oryxa_fde` as the RDS master, since the migrator cannot.
- **Done when:** the bootstrap is still safe to re-run, its fail-closed role check still passes, and
  dev has the extension.

### 4. `store: organisations table and the organisation scope`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-store`, `crates/oryxa-fde-api`.
- **Depends on:** 3.
- **Does:** migration `0002` with `organisations` (key: the WorkOS organisation id; kind, name, plan,
  settings, created by and at; one personal organisation per person). `OrgScope`, built only from a
  verified token. Every transaction sets the organisation along with its role, and the table's policy
  compares to it. A signed-in organisation without a row gets one, kind `organisation`, with its WorkOS
  name. `/v1/me` adds the organisation's kind and name.
- **Done when:** live tests show another organisation's row is invisible, and that a transaction with
  no organisation set sees no rows.

### 5. `store: audit log and outbox, written in the change's transaction`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-store`.
- **Depends on:** 4.
- **Does:** `audit_log` (ids, action from a fixed list, actor, time) and `outbox` (ids only), both by
  organisation under row-level security; the runtime roles may insert and read them, never update or
  delete. A store helper writes both inside the caller's transaction.
- **Done when:** tests show an update or delete as a runtime role fails, and a rolled-back change
  leaves neither row.

### 6. `store: the node tree`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-store`.
- **Depends on:** 5.
- **Does:** `nodes` with `ltree` paths (the extension created if missing), `NodeId` and `NodeKind`
  types, the root node made with each organisation (and for rows from issue 4), and store functions to
  create, rename and archive a node and to list a node's children and ancestors. Parent rules and the
  depth limit of ADR 0010.
- **Done when:** a test covers each parent rule, the depth limit, a parent in another organisation
  (refused by the foreign key), and archiving hiding a subtree.

### 7. `api: roles on nodes, applied to SpiceDB by the grant reconciler`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-store`, `crates/oryxa-fde-api`.
- **Depends on:** 1, 6.
- **Does:** `node_roles` as the record of grants; a grant commits its row, then writes the
  relationship under the row's lock; a reconciler as `oryxa_fde_grants` retries pending rows with
  back-off; a removal deletes the relationship before it reports success. The root node's
  `organisation` relation is written with the node. Refuses `admin` on the root node, and mixing staff
  and guest roles.
- **Done when:** live tests show a grant reaching SpiceDB; a grant made while SpiceDB is down is
  applied by the reconciler later; a removal while SpiceDB is down fails and leaves access as it was.

### 8. `api: organisation routes`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-api`, plus the generated web files.
- **Depends on:** 4, 5.
- **Does:** the current organisation; the caller's organisations for the switcher (memberships from
  WorkOS, each row read under its own scope); rename (ours, then WorkOS); convert personal to
  organisation. Admins only for changes; each writes audit and outbox rows.
- **Done when:** tests cover a member refused a rename, a convert back to personal refused with two
  members, and the list showing only the caller's memberships.

### 9. `api: switch organisation`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-api`, plus the generated web files.
- **Depends on:** 8.
- **Does:** a cookie route that refreshes the session for the chosen organisation through WorkOS and
  sets a new session cookie, with the origin check of every cookie route.
- **Done when:** tests show an organisation the caller is not in is refused with no new cookie, and a
  switch issues a fresh cookie scoped to the new organisation.

### 10. `api: node routes`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-api`, plus the generated web files.
- **Depends on:** 6, 7.
- **Does:** create, rename and archive a node (`manage` on its parent or itself); list children and
  ancestors (`see`, with a guest seeing only the allowlist). A node the caller cannot see answers 404.
- **Done when:** tests cover each permission, and that a hidden node and a missing one answer alike.

### 11. `api: the isolation suite over every route`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-api`.
- **Depends on:** 10.
- **Does:** a live test that runs every route in `openapi.json` as someone in another organisation,
  someone with no role on the node, a guest, and each role on a sibling subtree; and a test that drops
  a filter and shows row-level security returns nothing. It fails on any route without cases.
- **Done when:** it passes in CI over the routes of issues 8 to 10, and a test shows an uncovered
  route fails it.

### 12. `api: members and roles routes`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-api`, plus the generated web files.
- **Depends on:** 11.
- **Does:** list a node's members with their roles (`view`; names and addresses read from WorkOS when
  shown, never stored); grant, change and remove a role (`manage`); remove a person from the
  organisation; make or unmake an organisation admin by changing the WorkOS role (admins only).
- **Done when:** tests and isolation cases cover each route, including the staff-or-guest refusal and
  the last admin refused removal.

### 13. `api: a personal organisation for a verified person in none`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-api`, plus the generated web files.
- **Depends on:** 7, 8.
- **Does:** replaces the "no organisation" refusal with a pending step in a sealed cookie; on confirm,
  creates the WorkOS organisation and admin membership, then the `organisations` row (kind `personal`)
  and root node in one transaction, then the session.
- **Done when:** tests cover the Google path, a second personal organisation refused, and a WorkOS
  failure leaving no row and no session.

### 14. `api: self-serve sign-up route`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-api`, `crates/oryxa-fde-store`, plus the
  generated web files.
- **Depends on:** 13.
- **Does:** creates the WorkOS user, takes the person through email verification, then into issue 13's
  step. Every guard of ADR 0007: one answer whether or not the address has an account, the limits
  and ceiling, the origin check, the password never kept or logged.
- **Done when:** tests show the same answer for a new and an existing address, the limits applying,
  and no organisation made before the address is verified.

### 15. `api: invitations into an organisation, with a role on a node`
- **Label:** `agent:api`. **Paths:** `crates/oryxa-fde-store`, `crates/oryxa-fde-api`, plus the
  generated web files.
- **Depends on:** 12.
- **Does:** `invitations`; send (`manage` on the node; a WorkOS invitation as `member`), list and
  revoke; accepting on the existing route grants the role. A person already in the organisation gets
  the role directly. A personal organisation must convert first.
- **Done when:** tests and isolation cases cover sending, revoking, accepting at the invited address
  only, and the personal-organisation refusal.

### 16. `web: sign-up and the create-your-organisation step`
- **Label:** `agent:web`. **Paths:** `fde-web/`.
- **Depends on:** 14.
- **Does:** the sign-up screen and the "create your personal organisation" step, which replaces the
  "you are not in an organisation yet" page.
- **Done when:** both work on the dev mock and in dev, with every state of ADR 0007's screens.

### 17. `web: organisation switcher`
- **Label:** `agent:web`. **Paths:** `fde-web/`.
- **Depends on:** 9.
- **Does:** the switcher in the shell, showing each organisation's name and kind, and converting a
  personal organisation from its settings.
- **Done when:** it works by keyboard and screen reader, on the mock and in dev.

### 18. `web: tree navigation`
- **Label:** `agent:web`. **Paths:** `fde-web/`.
- **Depends on:** 10.
- **Does:** the tree beside the page, with breadcrumbs; create, rename and archive customer
  workspaces and projects where the person may.
- **Done when:** a person sees only what the API returns, actions they may not take are absent, and
  it works on the mock and in dev.

### 19. `web: members and invitations`
- **Label:** `agent:web`. **Paths:** `fde-web/`.
- **Depends on:** 12, 15.
- **Does:** a node's members with their roles; grant, change and remove a role; invite by address
  with a role; the convert step for a personal organisation. Each is confirmed on its own (ADR 0008).
- **Done when:** it works on the mock and in dev, and the Phase 1 pass above runs end to end.

## 5. Risks

- **Lead review is the bottleneck.** Keep PRs to one issue each, and small.
- **Two stores of truth for a grant.** SpiceDB and `node_roles` can disagree while a grant is pending;
  the order in issue 7 makes that disagreement deny, never allow.
- **Sign-up is a new unauthenticated route** that creates WorkOS users. The limits of ADR 0007 and the
  rule that nothing else is made before verification are the defence; issue 14's tests prove them.
