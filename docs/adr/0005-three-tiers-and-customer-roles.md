# 0005: Three tiers of user, and the customer's roles

Status: accepted, 10 November 2026. Amends the guest rule in ADR 0002.

## Context
ADR 0002 gives a customer person one role: a read-only `guest` on a project, "never on the
company". That serves the sponsor reading the customer room. It leaves out the customer's IT and
security people, who grant the vendor's engineers access and answer for what is deployed. Access
and security review is where engagements stall most, and today the customer cannot act in the
product at all. `docs/direction.md` section 2 names three tiers: the vendor organisation, its FDEs,
and the customer.

## Decision
- **Vendor organisation** stays the tenant (ADR 0002). Its admins get an admin console over every
  company: engagements by stage and health, people, seats, policies, billing, audit.
- **FDEs** keep `work` on a company or project, as today.
- **The customer gets two roles**, both narrower than `work`:
  - **Sponsor**, on a project: reads the customer room and decides. Signs off scope, accepts a
    change request, approves a milestone.
  - **IT admin**, on the company: governs. Sees who holds which access and until when, approves,
    denies or revokes an access request, sees the deployment and change log, and downloads evidence.

```
definition fde_company {
    relation workspace: workspace
    relation lead: user
    relation engineer: user | team#member
    relation it_admin: user

    permission manage = lead + workspace->manage
    permission work = engineer + manage
    permission govern = it_admin
}

definition fde_project {
    relation company: fde_company
    relation assignee: user
    relation guest: user
    relation sponsor: user

    permission work = assignee + company->work
    permission decide = sponsor
    permission view = work + guest + sponsor
}
```

- **A customer role never implies `work`,** and `work` never implies `govern` or `decide`. An FDE may
  still record that access was granted, and the record says who recorded it. Only an IT admin's
  own action counts as the customer's approval. The same holds for a sponsor's sign-off.
- **What the customer sees is an allowlist.** The customer screens read their own endpoints, which
  return named fields only, as the customer room does. Internal tasks, threads, notes, agent
  transcripts and Today are never reachable with `govern`, `decide` or `view`. The isolation suite
  covers both roles on every endpoint.
- **Sign-in, for now:** a customer person is a user in the vendor's tenant, invited with an
  explicit customer role, as ADR 0002 already assumes for guests. A sponsor who only reads can use
  the weekly digest and share links without an account.
- **Later, and not built yet:** sign-in through the customer's own identity provider, so their
  offboarding follows their directory; and one customer identity across several vendors.

## Consequences
- `schema/fde.zed` gains two relations and two permissions; the lead reviews that change.
- Access requests gain a customer decision (who, when, expiry) distinct from the FDE's record.
- Invites must carry a role, and the API must refuse a customer role any FDE endpoint.
- Approvals for agent actions that touch the customer's systems can later route to the IT admin.
  Until then they stay with the FDE (ADR 0004).
