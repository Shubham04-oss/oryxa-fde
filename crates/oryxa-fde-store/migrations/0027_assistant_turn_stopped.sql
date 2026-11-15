-- A turn the person stopped (the assistant Worker's stop route, ADR 0009's 15 November amendment) ends
-- with the notice `stopped`. 0025 has shipped, so its check is replaced here rather than edited.
alter table assistant_turns drop constraint assistant_turns_notice_check;
alter table assistant_turns add constraint assistant_turns_notice_check
    check (notice is null or notice in ('tool_limit', 'reply_limit', 'timed_out', 'failed', 'stopped'));
