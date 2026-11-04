-- The lifecycle engine (#19): rules on FDE events, a project's activity feed, the latest eval
-- result of each success criterion, suggestions, and drafted weekly updates. Same row-level
-- security as every company table.

-- A task blocked on an access request of its project is unblocked when the request is granted.
alter table access_requests add unique (tenant_id, company_id, project_id, access_request_id);
alter table tasks add column blocked_by text,
    add foreign key (tenant_id, company_id, project_id, blocked_by)
        references access_requests (tenant_id, company_id, project_id, access_request_id)
        on delete set null (blocked_by);

-- Each event the engine has acted on, written with the rule's own changes: a redelivery finds it
-- and changes nothing.
create table processed_events (
    tenant_id    text not null,
    company_id   text not null,
    event_id     text not null,
    processed_at timestamptz not null default now(),
    primary key (tenant_id, event_id),
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id)
);

-- What happened on a project that is not a record of its own: ids, outcomes and counts only.
create table project_activity (
    tenant_id   text not null,
    company_id  text not null,
    project_id  text not null,
    event_id    text not null,
    kind        text not null check (kind in ('agent_run_finished', 'eval_run_finished', 'pull_request_merged')),
    -- The run's id or the pull request's number.
    subject     text not null,
    outcome     text check (outcome in ('succeeded', 'failed', 'rejected', 'cancelled')),
    passed      int check (passed >= 0),
    failed      int check (failed >= 0),
    occurred_at timestamptz not null,
    primary key (tenant_id, event_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);
create index project_activity_by_project on project_activity (tenant_id, company_id, project_id, occurred_at desc);

-- The latest measured value of each success criterion, from the eval run that measured it. It
-- passes when it meets the criterion's comparator and target.
alter table criteria add unique (tenant_id, company_id, project_id, criterion_id);
create table criterion_results (
    tenant_id    text not null,
    company_id   text not null,
    project_id   text not null,
    criterion_id text not null,
    eval_run_id  text not null,
    value        double precision not null check (value = value and value not in ('Infinity', '-Infinity')),
    measured_at  timestamptz not null default now(),
    primary key (tenant_id, criterion_id),
    foreign key (tenant_id, company_id, project_id, criterion_id)
        references criteria (tenant_id, company_id, project_id, criterion_id) on delete cascade
);

-- Suggestions to the FDE, never acted on by themselves: one open suggestion of each kind.
create table suggestions (
    tenant_id    text not null,
    company_id   text not null,
    project_id   text not null,
    kind         text not null check (kind in ('ready_to_deploy')),
    eval_run_id  text not null,
    raised_at    timestamptz not null default now(),
    dismissed_by text,
    dismissed_at timestamptz,
    primary key (tenant_id, project_id, kind),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

-- One drafted update per project and ISO week (its Monday). Nothing is sent from here: an FDE
-- edits it, then approves or discards it.
create table update_drafts (
    tenant_id  text not null,
    company_id text not null,
    project_id text not null,
    week       date not null check (extract(isodow from week) = 1),
    body       text not null check (length(body) between 1 and 20000),
    status     text not null default 'draft' check (status in ('draft', 'approved', 'discarded')),
    model      text not null,
    drafted_at timestamptz not null default now(),
    edited_by  text,
    edited_at  timestamptz,
    decided_by text,
    decided_at timestamptz,
    primary key (tenant_id, project_id, week),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

alter table processed_events enable row level security;
alter table processed_events force row level security;
alter table project_activity enable row level security;
alter table project_activity force row level security;
alter table criterion_results enable row level security;
alter table criterion_results force row level security;
alter table suggestions enable row level security;
alter table suggestions force row level security;
alter table update_drafts enable row level security;
alter table update_drafts force row level security;

create policy in_scope on processed_events to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on project_activity to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on criterion_results to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on suggestions to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on update_drafts to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));

grant select, insert on processed_events, project_activity to oryxa_fde_app;
grant select, insert, update on criterion_results, suggestions, update_drafts to oryxa_fde_app;

-- The weekly drafts list every project's keys and stage through the role that already reads every
-- project's keys for the grant reconciler; it gains the stage only.
grant select (stage) on projects to oryxa_fde_grants;
