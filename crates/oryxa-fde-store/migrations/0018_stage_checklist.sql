-- A project may move on from a stage with checklist items open if the FDE gives a reason (#105).
-- The stage-change audit row keeps the reason and the open items' keys. The reason is the one
-- free-text field in the audit log; it stays in Postgres and never reaches events or logs.
alter table audit_log
    add column reason text check (char_length(reason) between 1 and 500),
    add column open_items text[],
    add constraint audit_log_reason_with_open_items check ((reason is null) = (open_items is null));
