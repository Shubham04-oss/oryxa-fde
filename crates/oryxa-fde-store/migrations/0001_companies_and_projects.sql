-- Companies, projects, their members, the audit log and the outbox (ADR 0002).
-- Row-level security is the second layer behind the scope filter in every query: each transaction
-- runs as oryxa_fde_app (SET LOCAL ROLE) with fde.tenant and fde.companies set, so a query that
-- forgets its filter still sees nothing. The outbox relay runs as oryxa_fde_relay.

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'oryxa_fde_app') then
        create role oryxa_fde_app nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'oryxa_fde_relay') then
        create role oryxa_fde_relay nologin;
    end if;
end
$$;
-- The login role that runs migrations and the service must be able to SET ROLE to both.
grant oryxa_fde_app, oryxa_fde_relay to current_user;

-- True only for rows of the tenant and companies this transaction was opened for. Unset settings
-- read as NULL or '', which match nothing.
create function fde_in_scope(tenant text, company text) returns boolean
    language sql stable
    as $$ select tenant = current_setting('fde.tenant', true)
              and company = any (string_to_array(current_setting('fde.companies', true), ',')) $$;

create table companies (
    tenant_id  text not null,
    company_id text not null,
    name       text not null,
    created_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, company_id)
);

create table projects (
    tenant_id  text not null,
    company_id text not null,
    -- SpiceDB object ids are "<tenant>|<id>", so a project id is unique per tenant.
    project_id text not null,
    name       text not null,
    stage      text not null default 'discover'
        check (stage in ('discover', 'scope', 'access', 'build', 'evaluate', 'deploy', 'handoff', 'operate')),
    created_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, project_id),
    unique (tenant_id, company_id, project_id),
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id)
);

create table company_members (
    tenant_id  text not null,
    company_id text not null,
    user_id    text not null,
    role       text not null check (role in ('lead', 'engineer')),
    added_by   text not null,
    added_at   timestamptz not null default now(),
    primary key (tenant_id, company_id, user_id),
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id)
);

create table project_assignees (
    tenant_id  text not null,
    company_id text not null,
    project_id text not null,
    user_id    text not null,
    added_by   text not null,
    added_at   timestamptz not null default now(),
    primary key (tenant_id, project_id, user_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

-- Who changed what, as ids only. Append-only for everyone, the owner included.
create table audit_log (
    id         bigint generated always as identity primary key,
    tenant_id  text not null,
    company_id text not null,
    project_id text,
    actor      text not null,
    action     text not null,
    target     text,
    at         timestamptz not null default now()
);

create function audit_log_append_only() returns trigger
    language plpgsql
    as $$ begin raise exception 'audit_log is append-only'; end $$;
create trigger audit_log_no_update before update or delete on audit_log
    for each row execute function audit_log_append_only();
create trigger audit_log_no_truncate before truncate on audit_log
    for each statement execute function audit_log_append_only();

-- Events written in the same transaction as the state change; the relay publishes them in order
-- per group. id is the event id, which the bus uses as the deduplication id.
create table outbox (
    id           text primary key,
    seq          bigint generated always as identity unique,
    tenant_id    text not null,
    company_id   text not null,
    source       text not null,
    detail_type  text not null,
    group_key    text not null,
    detail       text not null,
    created_at   timestamptz not null default now(),
    attempts     int not null default 0,
    available_at timestamptz not null default now(),
    published_at timestamptz,
    dead_at      timestamptz,
    last_error   text
);
create index outbox_pending on outbox (group_key, seq) where published_at is null and dead_at is null;

alter table companies enable row level security;
alter table companies force row level security;
alter table projects enable row level security;
alter table projects force row level security;
alter table company_members enable row level security;
alter table company_members force row level security;
alter table project_assignees enable row level security;
alter table project_assignees force row level security;
alter table audit_log enable row level security;
alter table audit_log force row level security;
alter table outbox enable row level security;
alter table outbox force row level security;

create policy in_scope on companies to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on projects to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on company_members to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on project_assignees to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on audit_log to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on outbox for insert to oryxa_fde_app with check (fde_in_scope(tenant_id, company_id));
-- The relay publishes for every tenant; it can read and mark outbox rows and nothing else.
create policy relay on outbox to oryxa_fde_relay using (true);

grant select, insert, update, delete on companies, projects, company_members, project_assignees to oryxa_fde_app;
grant select, insert on audit_log to oryxa_fde_app;
grant insert on outbox to oryxa_fde_app;
grant select, update, delete on outbox to oryxa_fde_relay;
