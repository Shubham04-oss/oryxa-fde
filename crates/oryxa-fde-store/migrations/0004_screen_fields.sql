-- Fields the web screens show (#42), and reading projects by id for the Today view.

alter table companies add column industry text, add column region text, add column summary text;
alter table projects add column summary text;
alter table stakeholders add column role text not null default 'other'
    check (role in ('sponsor', 'champion', 'user', 'it', 'security', 'other'));
alter table systems add column kind text;

-- Who works the task, which stakeholder at the customer it waits on, and since when it has been
-- waiting on the customer (stamped when the status becomes waiting_on_customer).
alter table tasks
    add column due_on date,
    add column assignee text,
    add column waiting_on text,
    add column waiting_since timestamptz,
    add foreign key (tenant_id, company_id, waiting_on) references stakeholders (tenant_id, company_id, stakeholder_id)
        on delete set null (waiting_on);

-- The Today view starts from the projects SpiceDB says the caller works on, some of them in
-- companies the caller does not work on (an assignee's). A transaction that names those projects
-- in fde.projects may read their rows, and nothing else of their companies.
create function fde_in_projects(tenant text, project text) returns boolean
    language sql stable
    as $$ select tenant = current_setting('fde.tenant', true)
              and project = any (string_to_array(current_setting('fde.projects', true), ',')) $$;
create policy by_project on projects for select to oryxa_fde_app using (fde_in_projects(tenant_id, project_id));
