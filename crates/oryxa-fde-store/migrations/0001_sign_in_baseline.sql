-- The baseline after the reset to sign-in (#296). It replaces every earlier migration, so a database
-- that ran them must be recreated before this one runs; only the dev database ever ran them, and it
-- holds sample data only.
--
-- Migrations run as their own login, which owns every table. The API's runtime login is only a
-- member of oryxa_fde_runtime, which holds the transaction roles without inheriting them: the login
-- has no privilege of its own, so nothing it runs outside a transaction's SET LOCAL ROLE can read a
-- table, and it can never become the owner. The API refuses to start on a login that could. The
-- roles are the ones the infra bootstrap makes (infra/sql); they are made here too, for a database
-- set up without it (local runs and the live tests).
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'oryxa_fde_app') then
        create role oryxa_fde_app nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'oryxa_fde_relay') then
        create role oryxa_fde_relay nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'oryxa_fde_grants') then
        create role oryxa_fde_grants nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'oryxa_fde_runtime') then
        create role oryxa_fde_runtime nologin;
    end if;
end
$$;
-- The migrating login must be able to SET ROLE to both transaction roles.
grant oryxa_fde_app, oryxa_fde_relay to current_user;
grant oryxa_fde_app, oryxa_fde_relay, oryxa_fde_grants to oryxa_fde_runtime with inherit false;

-- Sign-in limits (ADR 0007, #204): fixed-window counters for the API's unauthenticated sign-in routes,
-- per address, per client and one ceiling across all of them. A bucket is a keyed hash made by the API
-- (never an address or a client's IP) and a counter that cannot be read or written refuses the attempt.
-- No tenant: nobody is signed in yet. Only the API reaches it, as oryxa_fde_relay, the one transaction
-- role no worker holds.
create table sign_in_limits (
    bucket       text primary key check (bucket ~ '^[a-z_]{1,32}:[0-9a-f]{0,64}$'),
    window_start timestamptz not null,
    hits         integer not null check (hits > 0)
);
-- Lapsed windows are swept a few rows at a time by each hit.
create index sign_in_limits_window on sign_in_limits (window_start);

alter table sign_in_limits enable row level security;
alter table sign_in_limits force row level security;
create policy sign_in on sign_in_limits to oryxa_fde_relay using (true) with check (true);
grant select, insert, update, delete on sign_in_limits to oryxa_fde_relay;
