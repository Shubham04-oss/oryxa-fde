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
    // Anyone on the vendor's side: a tenant admin or member, or anyone who works on the company,
    // whatever their tenant role. A customer role held by one of them counts for nothing.
    permission staff = workspace->access + work
    permission govern = it_admin - staff
}

definition fde_project {
    relation company: fde_company
    relation assignee: user
    relation guest: user
    relation sponsor: user

    permission work = assignee + company->work
    permission decide = sponsor - work - company->staff
    permission view = work + guest + sponsor
}
```

- **A customer role never implies `work`,** and `work` never implies `govern` or `decide`. An FDE may
  still record that access was granted, and the record says who recorded it. Only an IT admin's
  own action counts as the customer's approval. The same holds for a sponsor's sign-off.
- **The vendor cannot stand in for the customer.** `govern` and `decide` exclude every admin and
  member of the vendor's tenant and everyone who works on the company or the project (lead,
  engineer, assignee), whatever their tenant role. Holding both kinds of role gives the customer's
  powers to no one. The API refuses both directions: a customer role for someone on the vendor's
  side, and a vendor role for someone who holds a customer role.
- **Who may grant a customer role.** A tenant admin records the customer's email domain on the
  company and invites the first IT admin at an address on that domain. A tenant admin may do this
  only while the company has no IT admin, so again if the last one leaves. Otherwise only an
  existing IT admin of the company adds or removes IT admins and sponsors. A change to the
  recorded domain is audited and shown to the customer. `guest` stays as the read-only role. Every grant, removal
  and customer decision is in the audit log with its actor, and the customer's screens show who
  decided what, so a decision made in the customer's name is visible to the customer.
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
- `schema/fde.zed` gains two relations and three permissions; the lead reviews that change, and the
  schema's validation file asserts that a tenant member with a customer relation has neither
  `govern` nor `decide`.
- A dishonest tenant admin can still invite an address they control on a domain they typed in.
  The audit trail and the customer-visible record are the guard; proving ownership of the domain
  comes with sign-in through the customer's identity provider.
- Access requests gain a customer decision (who, when, expiry) distinct from the FDE's record.
- Invites must carry a role, and the API must refuse a customer role any FDE endpoint.
- Approvals for agent actions that touch the customer's systems can later route to the IT admin.
  Until then they stay with the FDE (ADR 0004).
