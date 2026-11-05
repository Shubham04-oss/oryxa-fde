-- GitHub and Slack (#22). No token or secret is stored here: a tenant's Slack bot token is in
-- Secrets Manager and only its ARN is here, and a GitHub user token is used once and dropped.

-- An install's signed state, recorded when it is used, so it works once.
create table install_states (
    state_id  text primary key check (state_id ~ '^[0-9a-f]{32}$'),
    tenant_id text not null,
    used_at   timestamptz not null default now()
);

-- A GitHub App installation, claimed by the one tenant whose admin proved access to it. Never
-- moved: another tenant's claim is refused.
create table github_installations (
    installation_id bigint primary key check (installation_id > 0),
    tenant_id       text not null,
    claimed_by      text not null,
    claimed_at      timestamptz not null default now(),
    unique (tenant_id, installation_id)
);

-- A repository of a claimed installation, linked to one project. Removing the claim removes it.
create table github_repositories (
    tenant_id       text not null,
    company_id      text not null,
    project_id      text not null,
    installation_id bigint not null,
    repository_id   bigint not null check (repository_id > 0),
    full_name       text not null check (full_name ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
    linked_by       text not null,
    linked_at       timestamptz not null default now(),
    primary key (installation_id, repository_id),
    foreign key (tenant_id, installation_id) references github_installations (tenant_id, installation_id)
        on delete cascade,
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);
create index github_repositories_by_project on github_repositories (tenant_id, company_id, project_id);

-- Each pull request delivery acted on, by its delivery id and by the SHA-256 of its signed body,
-- kept 7 days: the id is not signed, so a captured body replayed under a new id is found by its hash.
create table github_deliveries (
    tenant_id   text not null,
    company_id  text not null,
    project_id  text not null,
    delivery_id text not null check (delivery_id ~ '^[0-9a-f-]{1,64}$'),
    body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
    received_at timestamptz not null default now(),
    primary key (tenant_id, delivery_id),
    unique (tenant_id, body_sha256),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

-- A tenant's Slack workspace: its team and the ARN of the secret holding the bot token. A team
-- belongs to one tenant, as an installation does, so Slack's uninstall acts on that one alone.
create table slack_installations (
    tenant_id    text primary key,
    team_id      text not null unique check (team_id ~ '^[A-Z0-9]{1,32}$'),
    secret_arn   text not null check (secret_arn like 'arn:%'),
    installed_by text not null,
    installed_at timestamptz not null default now()
);

-- The channel a company's approved updates are posted to. Uninstalling removes it.
create table slack_channels (
    tenant_id  text not null,
    company_id text not null,
    channel_id text not null check (channel_id ~ '^[A-Z0-9]{1,32}$'),
    linked_by  text not null,
    linked_at  timestamptz not null default now(),
    primary key (tenant_id, company_id),
    foreign key (tenant_id) references slack_installations (tenant_id) on delete cascade,
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id)
);

-- Each approved update posted once: claimed before it is sent, released if the send fails.
create table slack_posts (
    tenant_id  text not null,
    company_id text not null,
    project_id text not null,
    week       date not null check (extract(isodow from week) = 1),
    claimed_at timestamptz not null default now(),
    posted_at  timestamptz,
    primary key (tenant_id, project_id, week),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

-- An opened pull request lands in the activity next to merged ones.
alter table project_activity drop constraint project_activity_kind_check;
alter table project_activity add constraint project_activity_kind_check
    check (kind in ('agent_run_finished', 'eval_run_finished', 'pull_request_opened', 'pull_request_merged'));

alter table install_states enable row level security;
alter table install_states force row level security;
alter table github_installations enable row level security;
alter table github_installations force row level security;
alter table github_repositories enable row level security;
alter table github_repositories force row level security;
alter table github_deliveries enable row level security;
alter table github_deliveries force row level security;
alter table slack_installations enable row level security;
alter table slack_installations force row level security;
alter table slack_channels enable row level security;
alter table slack_channels force row level security;
alter table slack_posts enable row level security;
alter table slack_posts force row level security;

-- Installations, states and Slack workspaces are the organisation's; links, deliveries and posts
-- are a company's.
create policy in_tenant on install_states to oryxa_fde_app using (fde_in_tenant(tenant_id));
create policy in_tenant on github_installations to oryxa_fde_app using (fde_in_tenant(tenant_id));
create policy in_scope on github_repositories to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on github_deliveries to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_tenant on slack_installations to oryxa_fde_app using (fde_in_tenant(tenant_id));
create policy in_scope on slack_channels to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on slack_posts to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));

-- A webhook names no tenant: the reconciler's role routes it, reading only these keys. Every change
-- is then made under the tenant's or project's own scope.
create policy grants_read on github_installations for select to oryxa_fde_grants using (true);
create policy grants_read on github_repositories for select to oryxa_fde_grants using (true);
create policy grants_read on slack_installations for select to oryxa_fde_grants using (true);
grant select (installation_id, tenant_id) on github_installations to oryxa_fde_grants;
grant select (tenant_id, company_id, project_id, installation_id, repository_id) on github_repositories
    to oryxa_fde_grants;
grant select (tenant_id, team_id) on slack_installations to oryxa_fde_grants;

grant select, insert on install_states to oryxa_fde_app;
grant select, insert, delete on github_installations, github_repositories, github_deliveries to oryxa_fde_app;
grant select, insert, delete on slack_installations, slack_channels to oryxa_fde_app;
grant update (team_id, secret_arn, installed_by, installed_at) on slack_installations to oryxa_fde_app;
grant update (channel_id, linked_by, linked_at) on slack_channels to oryxa_fde_app;
grant select, insert, delete on slack_posts to oryxa_fde_app;
grant update (posted_at) on slack_posts to oryxa_fde_app;
