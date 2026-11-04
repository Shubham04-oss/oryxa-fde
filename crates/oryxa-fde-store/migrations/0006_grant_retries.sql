-- The grant reconciler backs off rows whose grant keeps failing, so they cannot crowd out the rest
-- (#44). It may record a failed try as well as a written grant, on rows still pending only.

alter table companies add column grant_attempts int not null default 0, add column grant_retry_at timestamptz;
alter table company_members add column grant_attempts int not null default 0, add column grant_retry_at timestamptz;
alter table projects add column grant_attempts int not null default 0, add column grant_retry_at timestamptz;
alter table project_assignees add column grant_attempts int not null default 0, add column grant_retry_at timestamptz;

drop policy grants_mark on companies;
drop policy grants_mark on company_members;
drop policy grants_mark on projects;
drop policy grants_mark on project_assignees;
create policy grants_mark on companies for update to oryxa_fde_grants using (granted_at is null) with check (true);
create policy grants_mark on company_members for update to oryxa_fde_grants using (granted_at is null) with check (true);
create policy grants_mark on projects for update to oryxa_fde_grants using (granted_at is null) with check (true);
create policy grants_mark on project_assignees for update to oryxa_fde_grants using (granted_at is null) with check (true);

grant select (grant_attempts, grant_retry_at), update (grant_attempts, grant_retry_at)
    on companies, company_members, projects, project_assignees to oryxa_fde_grants;
