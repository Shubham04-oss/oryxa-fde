# 0002: Tenancy, permissions and isolation

Status: accepted, 3 November 2026. Guests and the shared-SpiceDB question can be revisited.

## Decision
- **Tenant** = WorkOS organization = one FDE organisation (a vendor team or a solo FDE).
- **SpiceDB** decides who may act on a company or project, through `oryxa-authz` only. FDE runs its
  own SpiceDB with `schema/fde.zed`, which repeats the platform's `user`, `workspace` and `team`
  definitions and adds:

```
definition fde_company {
    relation workspace: workspace
    relation lead: user
    relation engineer: user | team#member

    permission manage = lead + workspace->manage
    permission work = engineer + manage
}

// Customer people get guest on a project, never on the company.
definition fde_project {
    relation company: fde_company
    relation assignee: user
    relation guest: user

    permission work = assignee + company->work
    permission view = work + guest
}
```

- **SQL** always filters by tenant and company: every store function takes a `CompanyScope` or
  `ProjectScope` from `oryxa-fde-core`.
- **Row-level security** on every FDE table is the second layer. The API sets the tenant and company
  for each transaction; a query that forgets the filter still sees nothing.
- **Isolation suite:** for every endpoint, a user at one company tries to read and change another
  company's data. Any success fails CI.
