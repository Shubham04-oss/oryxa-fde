-- Run once per environment as the RDS master user in database oryxa_fde, through the db-admin task:
--   infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql
-- Safe to re-run. Creates no passwords: every login uses IAM database auth (rds_iam).

-- pgvector for context search. RDS ships it; only the master (rds_superuser) may create it.
create extension if not exists vector;

-- Logins, each reachable from one task role only (infra/envs/dev/main.tf):
--   oryxa_fde_migrator runs the store's migrations as a one-off task (`oryxa-fde-ops migrate`), so
--     it owns the FDE tables.
--   oryxa_fde_api is the API at runtime. It is a member of oryxa_fde_runtime only, owns nothing and
--     can never reach the owner, so it can never turn row-level security off.
--   spicedb is SpiceDB's login.
-- The NOLOGIN roles are made here, so no login needs CREATEROLE: oryxa_fde_app and oryxa_fde_relay
-- are what each transaction takes (SET LOCAL ROLE), oryxa_fde_grants is the SpiceDB grant
-- reconciler's, and migration 0003 grants all three to oryxa_fde_runtime without inheritance.
select 'create role oryxa_fde_migrator login nosuperuser nocreaterole nocreatedb nobypassrls'
where not exists (select from pg_roles where rolname = 'oryxa_fde_migrator') \gexec
select 'create role oryxa_fde_api login nosuperuser nocreaterole nocreatedb nobypassrls'
where not exists (select from pg_roles where rolname = 'oryxa_fde_api') \gexec
select format('create role %I nologin', r)
from unnest(array['oryxa_fde_app', 'oryxa_fde_relay', 'oryxa_fde_grants', 'oryxa_fde_runtime']) as r
where not exists (select from pg_roles where rolname = r) \gexec
select 'create role spicedb login'
where not exists (select from pg_roles where rolname = 'spicedb') \gexec

grant rds_iam to oryxa_fde_migrator, oryxa_fde_api, spicedb;

-- The migrator creates the schema and grants the transaction roles onward: migration 0001 to its
-- own login, migration 0003 to oryxa_fde_runtime. Both need the admin option.
grant usage, create on schema public to oryxa_fde_migrator;
grant oryxa_fde_app, oryxa_fde_relay, oryxa_fde_grants to oryxa_fde_migrator with admin option;

-- The API: oryxa_fde_runtime and nothing else, so it reaches the transaction roles only through
-- that role, which inherits none of them.
grant usage on schema public to oryxa_fde_api;
grant oryxa_fde_runtime to oryxa_fde_api;

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

-- Fail closed: stop if the API login, or any role it can reach by SET ROLE or inheritance, could
-- act as an owner, create roles or skip row-level security. On a database an earlier bootstrap
-- left with the API as owner, run infra/sql/02-api-owns-nothing.sql first.
do $$
declare
    bad text;
begin
    select string_agg(format('%s (%s)', r.rolname, why), ', ' order by r.rolname) into bad
    from pg_roles r
    cross join lateral (values
        (r.rolsuper, 'superuser'),
        (r.rolcreaterole, 'createrole'),
        (r.rolcreatedb, 'createdb'),
        (r.rolbypassrls, 'bypassrls'),
        (r.rolname in ('oryxa_fde_migrator', current_user) or r.rolname like 'pg\_%', 'owner or predefined role'),
        (r.oid = (select datdba from pg_database where datname = current_database()), 'owns the database'),
        (exists (select from pg_class c where c.relowner = r.oid), 'owns a relation'),
        (exists (select from pg_namespace n where n.nspowner = r.oid), 'owns a schema'),
        (has_schema_privilege(r.oid, 'public', 'create'), 'create on public'),
        (exists (select from pg_auth_members m where m.member = r.oid and m.admin_option), 'admin option')
    ) as v(failed, why)
    where pg_has_role('oryxa_fde_api', r.oid, 'member') and v.failed;
    if bad is not null then
        raise exception 'oryxa_fde_api can reach a role with owner powers: %', bad;
    end if;
end
$$;
