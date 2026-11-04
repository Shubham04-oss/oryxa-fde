-- Once, as the RDS master in database oryxa_fde, only on a database that the first bootstrap let
-- oryxa_fde_api own (it migrated at startup). Run it between two runs of 01-bootstrap.sql, before
-- the first deploy of the non-owner API (#39); infra/README.md, Database logins, has the order:
--   infra/scripts/run-task.sh sql infra/sql/02-api-owns-nothing.sql
-- Safe to re-run, and does nothing on a database that never had that bootstrap.

-- REASSIGN OWNED needs the master to hold both roles' privileges; it holds them for this step only.
grant oryxa_fde_api, oryxa_fde_migrator to current_user;
reassign owned by oryxa_fde_api to oryxa_fde_migrator;
revoke oryxa_fde_api, oryxa_fde_migrator from current_user;

-- The first bootstrap's grants. CASCADE also drops what the API granted onward with that admin
-- option (migration 0001 granted both roles to its own login).
revoke create on schema public from oryxa_fde_api;
revoke oryxa_fde_app, oryxa_fde_relay from oryxa_fde_api cascade;
