-- Share links for one project (#21). A link holds the SHA-256 of its secret, never the secret, and
-- an expiry; revoking it stamps the time. Whoever redeems a live link (a customer person signed in
-- to the tenant) gets SpiceDB's `guest` on that project, written after the row commits, as for
-- assignees, and retried by the reconciler until written.

create table share_links (
    tenant_id     text not null,
    company_id    text not null,
    project_id    text not null,
    link_id       text not null,
    secret_sha256 text not null,
    expires_at    timestamptz not null,
    revoked_at    timestamptz,
    created_by    text not null,
    created_at    timestamptz not null default now(),
    -- The API allows 1 to 90 days; the database holds it to that too.
    check (expires_at > created_at and expires_at <= created_at + interval '90 days'),
    primary key (tenant_id, link_id),
    unique (tenant_id, company_id, project_id, link_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

create table share_link_guests (
    tenant_id      text not null,
    company_id     text not null,
    project_id     text not null,
    link_id        text not null,
    user_id        text not null,
    redeemed_at    timestamptz not null default now(),
    granted_at     timestamptz,
    grant_attempts int not null default 0,
    grant_retry_at timestamptz,
    primary key (tenant_id, link_id, user_id),
    foreign key (tenant_id, company_id, project_id, link_id)
        references share_links (tenant_id, company_id, project_id, link_id) on delete cascade
);
create index share_link_guests_by_user on share_link_guests (tenant_id, company_id, project_id, user_id);

alter table share_links enable row level security;
alter table share_links force row level security;
alter table share_link_guests enable row level security;
alter table share_link_guests force row level security;

create policy in_scope on share_links to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on share_link_guests to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
-- The reconciler reads every tenant's pending guests, as it does assignees, and marks them.
create policy grants_read on share_link_guests for select to oryxa_fde_grants using (true);
create policy grants_read on share_links for select to oryxa_fde_grants using (true);
create policy grants_mark on share_link_guests for update to oryxa_fde_grants
    using (granted_at is null) with check (true);

grant select, insert on share_links to oryxa_fde_app;
grant update (revoked_at) on share_links to oryxa_fde_app;
grant select, insert, delete on share_link_guests to oryxa_fde_app;
grant update (granted_at) on share_link_guests to oryxa_fde_app;
grant select (tenant_id, company_id, project_id, link_id, user_id, granted_at, grant_attempts, grant_retry_at),
    update (granted_at, grant_attempts, grant_retry_at) on share_link_guests to oryxa_fde_grants;
-- Whether a link is live, for the guests it reads; never the secret.
grant select (tenant_id, link_id, expires_at, revoked_at) on share_links to oryxa_fde_grants;
