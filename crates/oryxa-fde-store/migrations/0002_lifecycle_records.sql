-- Lifecycle records: stakeholders and systems on the company; scope, success criteria, sign-off,
-- access requests, tasks and decisions on the project; security answers per organisation.
-- Same row-level security as 0001: company records by tenant and company, the security answer
-- library by tenant.

-- Bumped by every change to a project's scope items or criteria; a sign-off pins one version.
alter table projects add column scope_version int not null default 0;

create function fde_in_tenant(tenant text) returns boolean
    language sql stable
    as $$ select tenant = current_setting('fde.tenant', true) $$;

-- Organisation-level changes (the security answer library) are audited with no company.
alter table audit_log alter column company_id drop not null;
create policy in_tenant on audit_log to oryxa_fde_app using (company_id is null and fde_in_tenant(tenant_id));

create table stakeholders (
    tenant_id      text not null,
    company_id     text not null,
    stakeholder_id text not null,
    name           text not null,
    title          text,
    created_by     text not null,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    primary key (tenant_id, stakeholder_id),
    unique (tenant_id, company_id, stakeholder_id),
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id)
);

create table systems (
    tenant_id   text not null,
    company_id  text not null,
    system_id   text not null,
    name        text not null,
    description text,
    created_by  text not null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    primary key (tenant_id, system_id),
    unique (tenant_id, company_id, system_id),
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id)
);

create table scope_items (
    tenant_id   text not null,
    company_id  text not null,
    project_id  text not null,
    item_id     text not null,
    kind        text not null check (kind in ('in', 'out')),
    description text not null,
    created_by  text not null,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    primary key (tenant_id, item_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

create table criteria (
    tenant_id    text not null,
    company_id   text not null,
    project_id   text not null,
    criterion_id text not null,
    description  text not null,
    metric       text not null,
    comparator   text not null check (comparator in ('at_least', 'at_most')),
    target       double precision not null,
    unit         text,
    created_by   text not null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    primary key (tenant_id, criterion_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

-- What changed in the scope, version by version. Append-only for the app.
create table scope_changes (
    id         bigint generated always as identity primary key,
    tenant_id  text not null,
    company_id text not null,
    project_id text not null,
    version    int not null,
    actor      text not null,
    action     text not null,
    target     text not null,
    at         timestamptz not null default now(),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

-- The customer's sign-off of one scope version, recorded by an FDE. A signed stakeholder cannot be
-- deleted.
create table scope_signoffs (
    tenant_id      text not null,
    company_id     text not null,
    project_id     text not null,
    version        int not null,
    stakeholder_id text not null,
    recorded_by    text not null,
    signed_at      timestamptz not null default now(),
    primary key (tenant_id, project_id, version),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id),
    foreign key (tenant_id, company_id, stakeholder_id) references stakeholders (tenant_id, company_id, stakeholder_id)
);

create table access_requests (
    tenant_id         text not null,
    company_id        text not null,
    project_id        text not null,
    access_request_id text not null,
    description       text not null,
    system_id         text,
    owner_id          text,
    status            text not null
        check (status in ('requested', 'in_progress', 'granted', 'denied', 'revoked')),
    requested_by      text not null,
    requested_at      timestamptz not null default now(),
    status_changed_at timestamptz not null default now(),
    granted_at        timestamptz,
    updated_at        timestamptz not null default now(),
    primary key (tenant_id, access_request_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id),
    foreign key (tenant_id, company_id, system_id) references systems (tenant_id, company_id, system_id)
        on delete set null (system_id),
    foreign key (tenant_id, company_id, owner_id) references stakeholders (tenant_id, company_id, stakeholder_id)
        on delete set null (owner_id)
);

create table security_answers (
    tenant_id  text not null,
    answer_id  text not null,
    question   text not null,
    answer     text not null,
    created_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, answer_id)
);

create table tasks (
    tenant_id  text not null,
    company_id text not null,
    project_id text not null,
    task_id    text not null,
    title      text not null,
    status     text not null
        check (status in ('todo', 'in_progress', 'waiting_on_customer', 'blocked', 'done')),
    blocker    text,
    created_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, task_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

-- Who decided what, when and why. Append-only for the app.
create table decisions (
    tenant_id   text not null,
    company_id  text not null,
    project_id  text not null,
    decision_id text not null,
    title       text not null,
    rationale   text not null,
    decided_by  text not null,
    decided_at  timestamptz not null,
    recorded_by text not null,
    created_at  timestamptz not null default now(),
    primary key (tenant_id, decision_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

alter table stakeholders enable row level security;
alter table stakeholders force row level security;
alter table systems enable row level security;
alter table systems force row level security;
alter table scope_items enable row level security;
alter table scope_items force row level security;
alter table criteria enable row level security;
alter table criteria force row level security;
alter table scope_changes enable row level security;
alter table scope_changes force row level security;
alter table scope_signoffs enable row level security;
alter table scope_signoffs force row level security;
alter table access_requests enable row level security;
alter table access_requests force row level security;
alter table security_answers enable row level security;
alter table security_answers force row level security;
alter table tasks enable row level security;
alter table tasks force row level security;
alter table decisions enable row level security;
alter table decisions force row level security;

create policy in_scope on stakeholders to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on systems to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on scope_items to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on criteria to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on scope_changes to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on scope_signoffs to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on access_requests to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_tenant on security_answers to oryxa_fde_app using (fde_in_tenant(tenant_id));
create policy in_scope on tasks to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on decisions to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));

grant select, insert, update, delete
    on stakeholders, systems, scope_items, criteria, access_requests, security_answers, tasks to oryxa_fde_app;
grant select, insert on scope_changes, scope_signoffs, decisions to oryxa_fde_app;
