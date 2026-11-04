-- Run once per environment as the RDS master user in database oryxa_fde, through the db-admin task:
--   infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql
-- Safe to re-run. Creates no passwords: every login uses IAM database auth (rds_iam).

-- pgvector for context search. RDS ships it; only the master (rds_superuser) may create it.
create extension if not exists vector;

-- Three logins, each reachable from one task role only (infra/envs/dev/main.tf):
--   oryxa_fde_migrator runs the store's migrations as a one-off task, so it owns the FDE tables.
--   oryxa_fde_api is the API at runtime. It owns nothing and may only SET LOCAL ROLE to
--     oryxa_fde_app or oryxa_fde_relay per transaction, so it can never become the owner and turn
--     row-level security off.
--   spicedb is SpiceDB's login.
-- oryxa_fde_app and oryxa_fde_relay are made here so neither login needs CREATEROLE.
select 'create role oryxa_fde_migrator login'
where not exists (select from pg_roles where rolname = 'oryxa_fde_migrator') \gexec
select 'create role oryxa_fde_api login'
where not exists (select from pg_roles where rolname = 'oryxa_fde_api') \gexec
select 'create role oryxa_fde_app nologin'
where not exists (select from pg_roles where rolname = 'oryxa_fde_app') \gexec
select 'create role oryxa_fde_relay nologin'
where not exists (select from pg_roles where rolname = 'oryxa_fde_relay') \gexec
select 'create role spicedb login'
where not exists (select from pg_roles where rolname = 'spicedb') \gexec

grant rds_iam to oryxa_fde_migrator, oryxa_fde_api, spicedb;

-- The migrator creates the schema; migration 0001 re-grants app and relay to its own login, which
-- needs the admin option.
grant usage, create on schema public to oryxa_fde_migrator;
grant oryxa_fde_app, oryxa_fde_relay to oryxa_fde_migrator with admin option;

-- The API may switch to app and relay but inherits neither, so a query outside a scoped
-- transaction reads no table at all.
grant oryxa_fde_app, oryxa_fde_relay to oryxa_fde_api with inherit false, set true;

-- SpiceDB's datastore, reachable by its owner only. The RDS master is not a superuser: it takes
-- the spicedb role just long enough to create the database and close it to everyone else.
grant spicedb to current_user;
select 'create database spicedb owner spicedb'
where not exists (select from pg_database where datname = 'spicedb') \gexec
set role spicedb;
revoke connect on database spicedb from public;
reset role;
revoke spicedb from current_user;

-- The FDE database: the master (owner), the migrator and the API only.
revoke connect on database oryxa_fde from public;
grant connect on database oryxa_fde to oryxa_fde_migrator, oryxa_fde_api;

-- Fail closed: stop if the API login could act as an owner or skip row-level security, for example
-- after an earlier bootstrap made it the table owner.
do $$
begin
    if exists (
        select from pg_roles r
        where r.rolname = 'oryxa_fde_api'
          and (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls
               or pg_has_role(r.oid, 'oryxa_fde_migrator', 'member')
               or pg_has_role(r.oid, current_user, 'member')
               or has_schema_privilege(r.oid, 'public', 'create')
               or exists (select from pg_class c where c.relowner = r.oid)
               or exists (select from pg_auth_members m where m.member = r.oid and m.admin_option))
    ) then
        raise exception 'oryxa_fde_api could act as the table owner; revoke its extra grants first';
    end if;
end
$$;
