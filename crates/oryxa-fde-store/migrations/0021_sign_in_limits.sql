-- Sign-in limits (ADR 0007, #204): fixed-window counters for the API's unauthenticated sign-in routes,
-- per address, per client and one ceiling across all of them. A bucket is a keyed hash made by the API
-- (never an address or a client's IP) and a counter that cannot be read or written refuses the attempt.
-- No tenant: nobody is signed in yet. Only the API reaches it, as oryxa_fde_relay, the one transaction
-- role no worker holds.
-- ponytail: a dedicated role needs the bootstrap (infra/sql) to create it, since the migrator cannot.
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
