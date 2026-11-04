-- Fencing for the company sandbox (#61): each lease carries a generation that grows whenever a different run takes
-- it. The run sends it with every call that changes the sandbox, and the gateway refuses a generation lower than
-- the highest it has seen, so a run whose lease has passed to another can never touch the next run's container,
-- however late its requests arrive.
alter table agent_sandbox_leases add column generation bigint not null default 1 check (generation > 0);
grant update (generation) on agent_sandbox_leases to oryxa_fde_app;
