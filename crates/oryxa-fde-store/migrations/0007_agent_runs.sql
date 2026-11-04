-- Agent runs (#28): each run, its transcript, the approvals it asked for, each project's agent budget and what its
-- runs used, and which run holds each company's sandbox. Written by oryxa-fde-agent through `ProjectTx`
-- (src/runs.rs); a run's end, its use and its agent-run.finished event commit together.
--
-- Runs are driven by whichever API task started them. That task keeps `alive_until` ahead of now while it lives;
-- a run's budget reservation counts only while it does, and its sandbox lease lapses with it.
--
-- `state` is the agent's run state machine as oryxa-fde-agent serialises it; the other columns are what lists,
-- decisions, cancels and budgets need. A run, its approvals and its events always belong to a project of its
-- company (the foreign keys), and row-level security limits every row to the transaction's scope.

create table agent_runs (
    tenant_id        text not null,
    company_id       text not null,
    project_id       text not null,
    run_id           text not null,
    -- The FDE's task: their text, never in events or logs.
    task             text not null,
    repository       jsonb not null,
    created_by       text not null,
    request_id       text not null,
    created_at       timestamptz not null default now(),
    started_at       timestamptz,
    ended_at         timestamptz,
    state            jsonb not null,
    input_tokens     bigint not null default 0 check (input_tokens >= 0),
    output_tokens    bigint not null default 0 check (output_tokens >= 0),
    delivery         jsonb not null,
    cancel_requested boolean not null default false,
    alive_until      timestamptz not null default now(),
    -- What the run may use, held against the project's budget from its start until it ends.
    reserved_seconds    bigint not null default 0 check (reserved_seconds >= 0),
    reserved_usd_micros bigint not null default 0 check (reserved_usd_micros >= 0),
    primary key (tenant_id, run_id),
    unique (tenant_id, company_id, project_id, run_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);
create index agent_runs_by_project on agent_runs (tenant_id, project_id, created_at desc);

-- The harness's event lines, in order; a replayed line is the same row. JSON as text: jsonb refuses \u0000,
-- which agent output can hold.
create table agent_run_events (
    tenant_id  text not null,
    company_id text not null,
    project_id text not null,
    run_id     text not null,
    seq        bigint not null check (seq >= 0),
    line       text not null,
    primary key (tenant_id, run_id, seq),
    foreign key (tenant_id, company_id, project_id, run_id)
        references agent_runs (tenant_id, company_id, project_id, run_id)
);

-- An action on the approval list the run asked to take, with the tool's full input; decided once.
create table agent_approvals (
    tenant_id    text not null,
    company_id   text not null,
    project_id   text not null,
    run_id       text not null,
    approval_id  text not null,
    tool_call_id text not null,
    action       text not null,
    title        text not null,
    tool         text not null,
    -- JSON as text, like event lines.
    input        text not null,
    requested_at timestamptz not null default now(),
    decision     text check (decision in ('approved', 'rejected')),
    decided_by   text,
    decided_at   timestamptz,
    check ((decision is null) = (decided_by is null) and (decision is null) = (decided_at is null)),
    primary key (tenant_id, run_id, approval_id),
    foreign key (tenant_id, company_id, project_id, run_id)
        references agent_runs (tenant_id, company_id, project_id, run_id)
);

-- A project's budget (null: the service's default) and what its ended runs used.
create table agent_budgets (
    tenant_id        text not null,
    company_id       text not null,
    project_id       text not null,
    minutes          integer check (minutes >= 0),
    spend_usd_micros bigint check (spend_usd_micros >= 0),
    used_seconds     bigint not null default 0 check (used_seconds >= 0),
    used_usd_micros  bigint not null default 0 check (used_usd_micros >= 0),
    updated_at       timestamptz not null default now(),
    primary key (tenant_id, project_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

-- One run at a time on a company's sandbox: the agent or eval run holding it, until the lease expires or is let go.
create table agent_sandbox_leases (
    tenant_id  text not null,
    company_id text not null,
    holder     text not null,
    expires_at timestamptz not null,
    primary key (tenant_id, company_id),
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id)
);

alter table agent_runs enable row level security;
alter table agent_runs force row level security;
alter table agent_run_events enable row level security;
alter table agent_run_events force row level security;
alter table agent_approvals enable row level security;
alter table agent_approvals force row level security;
alter table agent_budgets enable row level security;
alter table agent_budgets force row level security;
alter table agent_sandbox_leases enable row level security;
alter table agent_sandbox_leases force row level security;

create policy in_scope on agent_runs to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on agent_run_events to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on agent_approvals to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on agent_budgets to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on agent_sandbox_leases to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));

-- The runtime login reaches these only through oryxa_fde_app (0003). Nothing is deleted: a run's record stays.
-- Updates are limited to the columns that change after a row is written.
grant select, insert on agent_runs, agent_approvals, agent_budgets, agent_run_events, agent_sandbox_leases
    to oryxa_fde_app;
grant update (started_at, ended_at, state, input_tokens, output_tokens, delivery, cancel_requested, alive_until,
    reserved_seconds, reserved_usd_micros) on agent_runs to oryxa_fde_app;
grant update (decision, decided_by, decided_at) on agent_approvals to oryxa_fde_app;
grant update (minutes, spend_usd_micros, used_seconds, used_usd_micros, updated_at) on agent_budgets to oryxa_fde_app;
grant update (holder, expires_at) on agent_sandbox_leases to oryxa_fde_app;
