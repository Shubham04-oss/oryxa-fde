-- Evals (#29): suites of cases linked to a project's success criteria, eval runs, and their results per case and
-- per criterion. Written by oryxa-fde-evals through `ProjectTx` (src/evals.rs); a run's results and its
-- eval-run.finished event commit together.
--
-- `definition` holds what the evals crate defines (target, graders) as it serialises it; case text and outputs
-- are sample data and stay here, never in events or logs. JSON that may hold \u0000 is kept as text.
--
-- After 0010, whose key on criteria (tenant, company, project, criterion) the suites' criteria reference.

create table eval_suites (
    tenant_id  text not null,
    company_id text not null,
    project_id text not null,
    suite_id   text not null,
    name       text not null,
    definition jsonb not null,
    created_by text not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, suite_id),
    unique (tenant_id, company_id, project_id, suite_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

create table eval_cases (
    tenant_id  text not null,
    company_id text not null,
    project_id text not null,
    suite_id   text not null,
    case_id    text not null,
    position   bigint generated always as identity,
    input      text not null,
    expected   text,
    criteria   text[] not null default '{}',
    primary key (tenant_id, suite_id, case_id),
    foreign key (tenant_id, company_id, project_id, suite_id)
        references eval_suites (tenant_id, company_id, project_id, suite_id)
);

-- The success criteria a suite measures: each one of the suite's project, and gone from the suite with the
-- criterion. A case's own `criteria` narrow these.
create table eval_suite_criteria (
    tenant_id    text not null,
    company_id   text not null,
    project_id   text not null,
    suite_id     text not null,
    criterion_id text not null,
    position     integer not null,
    primary key (tenant_id, suite_id, criterion_id),
    foreign key (tenant_id, company_id, project_id, suite_id)
        references eval_suites (tenant_id, company_id, project_id, suite_id) on delete cascade,
    foreign key (tenant_id, company_id, project_id, criterion_id)
        references criteria (tenant_id, company_id, project_id, criterion_id) on delete cascade
);

create table eval_runs (
    tenant_id  text not null,
    company_id text not null,
    project_id text not null,
    run_id     text not null,
    suite_id   text not null,
    imported   boolean not null,
    created_by text not null,
    request_id text not null,
    created_at timestamptz not null default now(),
    ended_at   timestamptz,
    passed     integer check (passed >= 0),
    failed     integer check (failed >= 0),
    errored    integer check (errored >= 0),
    check ((ended_at is null) = (passed is null) and (ended_at is null) = (failed is null)
        and (ended_at is null) = (errored is null)),
    primary key (tenant_id, run_id),
    unique (tenant_id, company_id, project_id, run_id),
    foreign key (tenant_id, company_id, project_id, suite_id)
        references eval_suites (tenant_id, company_id, project_id, suite_id)
);
create index eval_runs_by_project on eval_runs (tenant_id, project_id, created_at desc);

create table eval_case_results (
    tenant_id  text not null,
    company_id text not null,
    project_id text not null,
    run_id     text not null,
    case_id    text not null,
    position   integer not null,
    outcome    text not null check (outcome in ('passed', 'failed', 'errored')),
    output     text,
    -- Each grader's verdict, as JSON text.
    verdicts   text not null,
    error      text,
    primary key (tenant_id, run_id, case_id),
    foreign key (tenant_id, company_id, project_id, run_id)
        references eval_runs (tenant_id, company_id, project_id, run_id)
);

-- A criterion's result in a run: what the customer room's pass rates are made of.
create table eval_criterion_results (
    tenant_id    text not null,
    company_id   text not null,
    project_id   text not null,
    run_id       text not null,
    criterion_id text not null,
    position     integer not null,
    passed       integer not null check (passed >= 0),
    total        integer not null check (total >= passed),
    primary key (tenant_id, run_id, criterion_id),
    foreign key (tenant_id, company_id, project_id, run_id)
        references eval_runs (tenant_id, company_id, project_id, run_id)
);

alter table eval_suites enable row level security;
alter table eval_suites force row level security;
alter table eval_cases enable row level security;
alter table eval_cases force row level security;
alter table eval_suite_criteria enable row level security;
alter table eval_suite_criteria force row level security;
alter table eval_runs enable row level security;
alter table eval_runs force row level security;
alter table eval_case_results enable row level security;
alter table eval_case_results force row level security;
alter table eval_criterion_results enable row level security;
alter table eval_criterion_results force row level security;

create policy in_scope on eval_suites to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on eval_cases to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on eval_suite_criteria to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on eval_runs to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on eval_case_results to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on eval_criterion_results to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));

-- The runtime login reaches these only through oryxa_fde_app (0003). Results are written once and never changed; a
-- run's own record only gains its end.
grant select, insert on eval_suites, eval_cases, eval_suite_criteria, eval_runs, eval_case_results,
    eval_criterion_results to oryxa_fde_app;
grant update (ended_at, passed, failed, errored) on eval_runs to oryxa_fde_app;
