-- Setting up a company in one call (#225) is retried by the client with the same Idempotency-Key, and
-- must not make a second company. One row per caller and key, written in the transaction that makes the
-- company, so it exists exactly when the company does. The key and the body are kept as SHA-256 hashes:
-- the body's, to refuse the same key reused for a different setup.
create table company_setups (
    tenant_id   text not null,
    user_id     text not null,
    key_sha256  text not null check (key_sha256 ~ '^[0-9a-f]{64}$'),
    body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
    company_id  text not null,
    project_id  text not null,
    created_at  timestamptz not null default now(),
    primary key (tenant_id, user_id, key_sha256)
);

alter table company_setups enable row level security;
alter table company_setups force row level security;
create policy in_tenant on company_setups to oryxa_fde_app
    using (fde_in_tenant(tenant_id)) with check (fde_in_tenant(tenant_id));
grant select, insert on company_setups to oryxa_fde_app;
