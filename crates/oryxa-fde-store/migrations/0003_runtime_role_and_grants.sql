-- Review follow-ups to wave 1 (#32).
--
-- Migrations run as their own login, which owns every table. The API's runtime login is only a
-- member of oryxa_fde_runtime, which holds the transaction roles without inheriting them: the login
-- has no privilege of its own, so nothing it runs outside a transaction's SET LOCAL ROLE can read a
-- table, and it can never become the owner. The API refuses to start on a login that could.
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'oryxa_fde_runtime') then
        create role oryxa_fde_runtime nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'oryxa_fde_grants') then
        create role oryxa_fde_grants nologin;
    end if;
end
$$;
grant oryxa_fde_app, oryxa_fde_relay, oryxa_fde_grants to oryxa_fde_runtime with inherit false;

-- SpiceDB grants are written after the row that justifies them commits, under that row's lock, so
-- a revocation (which deletes the row first) is always ordered after them. granted_at stays null
-- until the grant is written; the reconciler (oryxa_fde_grants) retries rows still null. Rows that
-- exist already were granted before their commit, so they start as granted.
alter table companies add column granted_at timestamptz default now();
alter table companies alter column granted_at drop default;
alter table company_members add column granted_at timestamptz default now();
alter table company_members alter column granted_at drop default;
alter table projects add column granted_at timestamptz default now();
alter table projects alter column granted_at drop default;
alter table project_assignees add column granted_at timestamptz default now();
alter table project_assignees alter column granted_at drop default;

-- The reconciler reads ids only (no names or other content), and may only mark a pending row
-- granted. Its reads cover every row because an update's new row must pass the read policy too.
create policy grants_read on companies for select to oryxa_fde_grants using (true);
create policy grants_read on company_members for select to oryxa_fde_grants using (true);
create policy grants_read on projects for select to oryxa_fde_grants using (true);
create policy grants_read on project_assignees for select to oryxa_fde_grants using (true);
create policy grants_mark on companies for update to oryxa_fde_grants
    using (granted_at is null) with check (granted_at is not null);
create policy grants_mark on company_members for update to oryxa_fde_grants
    using (granted_at is null) with check (granted_at is not null);
create policy grants_mark on projects for update to oryxa_fde_grants
    using (granted_at is null) with check (granted_at is not null);
create policy grants_mark on project_assignees for update to oryxa_fde_grants
    using (granted_at is null) with check (granted_at is not null);
grant select (tenant_id, company_id, granted_at), update (granted_at) on companies to oryxa_fde_grants;
grant select (tenant_id, company_id, user_id, role, granted_at), update (granted_at) on company_members
    to oryxa_fde_grants;
grant select (tenant_id, company_id, project_id, granted_at), update (granted_at) on projects to oryxa_fde_grants;
grant select (tenant_id, company_id, project_id, user_id, granted_at), update (granted_at) on project_assignees
    to oryxa_fde_grants;

-- What each scope change set (the item or criterion; for a sign-off, the whole scope), so every
-- version, and above all a signed one, can be rebuilt. Rows from before this migration have none.
alter table scope_changes add column content jsonb;

-- The relay retries a failing row for a day from retry_since; a replay of dead rows restarts it.
alter table outbox add column retry_since timestamptz not null default now();
