-- A save does not overwrite a newer edit (#117). Each record a whole-record PUT replaces carries a
-- version; a save names the version it read, and a stale one is refused. The trigger bumps the
-- version on every update of the row, so no write path can forget: the store's own saves, the
-- lifecycle engine unblocking a task, a digest unsubscribe, or a referenced row's delete setting
-- a column to null. A save that changes nothing issues no update, so it keeps the version.
alter table tasks add column version integer not null default 1;
alter table access_requests add column version integer not null default 1;
alter table stakeholders add column version integer not null default 1;
alter table systems add column version integer not null default 1;
alter table scope_items add column version integer not null default 1;
alter table criteria add column version integer not null default 1;

create function fde_bump_version() returns trigger
    language plpgsql
    set search_path = pg_catalog
as $$
begin
    new.version := old.version + 1;
    return new;
end
$$;

create trigger tasks_version before update on tasks for each row execute function fde_bump_version();
create trigger access_requests_version before update on access_requests
    for each row execute function fde_bump_version();
create trigger stakeholders_version before update on stakeholders for each row execute function fde_bump_version();
create trigger systems_version before update on systems for each row execute function fde_bump_version();
create trigger scope_items_version before update on scope_items for each row execute function fde_bump_version();
create trigger criteria_version before update on criteria for each row execute function fde_bump_version();
