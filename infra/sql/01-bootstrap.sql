-- Run once per environment as the RDS master user in database oryxa_fde, through the db-admin task:
--   infra/scripts/run-task.sh sql infra/sql/01-bootstrap.sql
-- Safe to re-run. Creates no passwords: every login uses IAM database auth (rds_iam).

-- pgvector for context search. RDS ships it; only the master (rds_superuser) may create it.
create extension if not exists vector;

-- oryxa_fde_api: the API's login. oryxa_fde_schema: owns every FDE table. The API may switch to
-- it to migrate (set role) but does not inherit it, so at run time it holds only what is granted
-- and row-level security applies to it. spicedb: SpiceDB's login, for its own database below.
select 'create role oryxa_fde_api login'
where not exists (select from pg_roles where rolname = 'oryxa_fde_api') \gexec
select 'create role oryxa_fde_schema nologin'
where not exists (select from pg_roles where rolname = 'oryxa_fde_schema') \gexec
select 'create role spicedb login'
where not exists (select from pg_roles where rolname = 'spicedb') \gexec

grant rds_iam to oryxa_fde_api, spicedb;
grant usage, create on schema public to oryxa_fde_schema;
grant oryxa_fde_schema to oryxa_fde_api with inherit false, set true;

-- SpiceDB's datastore, reachable by its owner only. The RDS master is not a superuser: it takes
-- the spicedb role just long enough to create the database and close it to everyone else.
grant spicedb to current_user;
select 'create database spicedb owner spicedb'
where not exists (select from pg_database where datname = 'spicedb') \gexec
set role spicedb;
revoke connect on database spicedb from public;
reset role;
revoke spicedb from current_user;

-- The FDE database: the master (owner) and the API only.
revoke connect on database oryxa_fde from public;
grant connect on database oryxa_fde to oryxa_fde_api;
