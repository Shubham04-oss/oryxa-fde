-- Planning records (#20): canvas snapshots, shape links, comment threads and meeting notes. Each
-- belongs to a company, or to one project of it (project_id set). Same row-level security as
-- every company table; the realtime Worker reads and writes canvases through the API only.

-- Every save is a new version. A small snapshot is stored inline; a larger one is in S3 under the
-- company's prefix, and its checksum is verified when it is read back.
create table canvas_versions (
    tenant_id   text not null,
    company_id  text not null,
    project_id  text,
    version     int not null check (version > 0),
    snapshot_id text not null,
    size_bytes  int not null check (size_bytes > 0),
    sha256      text not null,
    content     bytea,
    blob_key    text,
    saved_by    text not null,
    saved_at    timestamptz not null default now(),
    check (num_nonnulls(content, blob_key) = 1),
    primary key (tenant_id, snapshot_id),
    unique nulls not distinct (tenant_id, company_id, project_id, version),
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

-- One link per shape on a canvas, to exactly one record of the same company; removing the record
-- removes the link. Ids are unique per tenant, so these keys add no constraint, only the company
-- for the foreign keys below.
alter table scope_items add unique (tenant_id, company_id, item_id);
alter table access_requests add unique (tenant_id, company_id, access_request_id);
create table canvas_links (
    tenant_id         text not null,
    company_id        text not null,
    project_id        text,
    shape_id          text not null,
    stakeholder_id    text,
    scope_item_id     text,
    access_request_id text,
    linked_by         text not null,
    linked_at         timestamptz not null default now(),
    check (num_nonnulls(stakeholder_id, scope_item_id, access_request_id) = 1),
    unique nulls not distinct (tenant_id, company_id, project_id, shape_id),
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id),
    foreign key (tenant_id, company_id, stakeholder_id)
        references stakeholders (tenant_id, company_id, stakeholder_id) on delete cascade,
    foreign key (tenant_id, company_id, scope_item_id)
        references scope_items (tenant_id, company_id, item_id) on delete cascade,
    foreign key (tenant_id, company_id, access_request_id)
        references access_requests (tenant_id, company_id, access_request_id) on delete cascade
);

-- A thread is about one subject (a record or a canvas shape) and keeps its comments when the
-- subject goes. A project thread can be promoted to the decisions log, once.
create table threads (
    tenant_id    text not null,
    company_id   text not null,
    project_id   text,
    thread_id    text not null,
    subject_kind text not null check (subject_kind in ('stakeholder', 'system', 'document', 'task', 'decision',
        'access_request', 'scope_item', 'criterion', 'meeting_note', 'shape')),
    subject_id   text not null,
    decision_id  text,
    created_by   text not null,
    created_at   timestamptz not null default now(),
    check (decision_id is null or project_id is not null),
    primary key (tenant_id, thread_id),
    unique (tenant_id, company_id, thread_id),
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id),
    foreign key (tenant_id, decision_id) references decisions (tenant_id, decision_id)
);
create index threads_subject on threads (tenant_id, company_id, subject_kind, subject_id);

create table thread_comments (
    tenant_id  text not null,
    company_id text not null,
    thread_id  text not null,
    comment_id text not null,
    body       text not null,
    author     text not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, comment_id),
    foreign key (tenant_id, company_id, thread_id) references threads (tenant_id, company_id, thread_id)
);
create index thread_comments_thread on thread_comments (tenant_id, thread_id, created_at);

-- Who was there: the customer's stakeholders (removing one removes them from the note) and the
-- workspace's users.
create table meeting_notes (
    tenant_id  text not null,
    company_id text not null,
    project_id text,
    note_id    text not null,
    title      text not null,
    held_on    date not null,
    body       text not null,
    attendees  text[] not null default '{}',
    created_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, note_id),
    unique (tenant_id, company_id, note_id),
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id)
);

create table meeting_note_stakeholders (
    tenant_id      text not null,
    company_id     text not null,
    note_id        text not null,
    stakeholder_id text not null,
    primary key (tenant_id, note_id, stakeholder_id),
    foreign key (tenant_id, company_id, note_id)
        references meeting_notes (tenant_id, company_id, note_id) on delete cascade,
    foreign key (tenant_id, company_id, stakeholder_id)
        references stakeholders (tenant_id, company_id, stakeholder_id) on delete cascade
);

alter table canvas_versions enable row level security;
alter table canvas_versions force row level security;
alter table canvas_links enable row level security;
alter table canvas_links force row level security;
alter table threads enable row level security;
alter table threads force row level security;
alter table thread_comments enable row level security;
alter table thread_comments force row level security;
alter table meeting_notes enable row level security;
alter table meeting_notes force row level security;
alter table meeting_note_stakeholders enable row level security;
alter table meeting_note_stakeholders force row level security;

create policy in_scope on canvas_versions to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on canvas_links to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on threads to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on thread_comments to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on meeting_notes to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on meeting_note_stakeholders to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));

-- Versions and comments are append-only; a thread changes only when promoted.
grant select, insert on canvas_versions, thread_comments to oryxa_fde_app;
grant select, insert, delete on canvas_links, meeting_note_stakeholders to oryxa_fde_app;
grant select, insert on threads to oryxa_fde_app;
grant update (decision_id) on threads to oryxa_fde_app;
grant select, insert, delete on meeting_notes to oryxa_fde_app;
grant update (title, held_on, body, attendees, updated_at) on meeting_notes to oryxa_fde_app;
