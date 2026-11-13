-- Assistant conversations (#237, ADR 0008 and 0009): the record behind the Durable Object's working copy.
-- A conversation belongs to one person and one scope, set when it is made and never changed: one company
-- (and maybe one project in it), or the person's home. Sample data only until per-company keys exist and
-- ADR 0009's residency choice is recorded.

-- Who holds it and where it is bound: ids and times only, no content, so it is read at tenant level to
-- find a conversation's scope before its content is opened under that scope.
create table assistant_conversations (
    tenant_id       text not null,
    conversation_id text not null,
    user_id         text not null,
    company_id      text,
    project_id      text,
    created_at      timestamptz not null default now(),
    last_active_at  timestamptz not null default now(),
    primary key (tenant_id, conversation_id),
    -- A project only within a company.
    check (project_id is null or company_id is not null)
);
create index assistant_conversations_by_person on assistant_conversations (tenant_id, user_id, last_active_at desc);

-- The scope never changes after the conversation is made.
create function fde_keep_conversation_scope() returns trigger
    language plpgsql
    set search_path = pg_catalog
as $$
begin
    if (new.tenant_id, new.user_id, new.company_id, new.project_id)
        is distinct from (old.tenant_id, old.user_id, old.company_id, old.project_id) then
        raise exception 'a conversation''s person and scope cannot change';
    end if;
    return new;
end
$$;
create trigger assistant_conversations_scope before update on assistant_conversations
    for each row execute function fde_keep_conversation_scope();

-- Its finished turns, in order: what the person said, the assistant's text, its blocks and proposals
-- (with each proposal's state) as the Worker checked them. A company's conversation's turns are that
-- company's data, under its row policy; a home conversation's hold list-level facts only.
create table assistant_turns (
    tenant_id       text not null,
    conversation_id text not null,
    company_id      text,
    n               integer not null check (n between 1 and 50),
    turn_id         text not null check (turn_id ~ '^t_[A-Za-z0-9_-]{1,64}$'),
    said            text not null check (char_length(said) between 1 and 2000),
    reply           text not null check (char_length(reply) <= 8000),
    blocks          jsonb not null check (jsonb_typeof(blocks) = 'array'),
    proposals       jsonb not null check (jsonb_typeof(proposals) = 'array'),
    notice          text check (notice is null or notice in ('tool_limit', 'reply_limit', 'timed_out', 'failed')),
    state           text not null check (state in ('done', 'failed')),
    created_at      timestamptz not null default now(),
    primary key (tenant_id, conversation_id, n),
    unique (tenant_id, conversation_id, turn_id),
    foreign key (tenant_id, conversation_id)
        references assistant_conversations (tenant_id, conversation_id) on delete cascade
);

alter table assistant_conversations enable row level security;
alter table assistant_conversations force row level security;
alter table assistant_turns enable row level security;
alter table assistant_turns force row level security;
create policy in_tenant on assistant_conversations to oryxa_fde_app
    using (fde_in_tenant(tenant_id)) with check (fde_in_tenant(tenant_id));
create policy in_scope on assistant_turns to oryxa_fde_app
    using (case when company_id is null then fde_in_tenant(tenant_id) else fde_in_scope(tenant_id, company_id) end)
    with check (case when company_id is null then fde_in_tenant(tenant_id) else fde_in_scope(tenant_id, company_id) end);
grant select, insert, delete on assistant_conversations to oryxa_fde_app;
grant update (last_active_at) on assistant_conversations to oryxa_fde_app;
grant select, insert, delete on assistant_turns to oryxa_fde_app;
