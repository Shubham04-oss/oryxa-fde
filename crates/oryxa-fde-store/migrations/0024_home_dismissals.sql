-- Home suggestions a person dismissed (#227, ADR 0008). A suggestion is built on each read from ids and
-- fixed templates, so nothing of it is stored but this: who dismissed which one, and a hash of the facts
-- (the ids behind it) at the time. When the facts change, the hash no longer matches and it shows again.
create table home_dismissals (
    tenant_id     text not null,
    user_id       text not null,
    suggestion_id text not null check (suggestion_id ~ '^[a-z_]{1,32}(\.[A-Za-z0-9_-]{1,128})?$'),
    facts_sha256  text not null check (facts_sha256 ~ '^[0-9a-f]{64}$'),
    dismissed_at  timestamptz not null default now(),
    primary key (tenant_id, user_id, suggestion_id)
);

alter table home_dismissals enable row level security;
alter table home_dismissals force row level security;
create policy in_tenant on home_dismissals to oryxa_fde_app
    using (fde_in_tenant(tenant_id)) with check (fde_in_tenant(tenant_id));
grant select, insert, update on home_dismissals to oryxa_fde_app;
