-- The weekly digest (#21): an approved update is emailed to the project's sponsors. A stakeholder's
-- email is customer data: it stays here and in the mail sent to it, never in SpiceDB, events or
-- logs. Unsubscribing stamps the stakeholder; changing their address clears it.
alter table stakeholders
    add column email text check (email is null or (length(email) between 3 and 254 and email !~ '\s')),
    add column digest_opt_out_at timestamptz;

-- One row per update and recipient, claimed before the mail is sent, so a recipient gets each
-- update once whichever copy of the service sends it. A claim holds the SHA-256 of the secret in
-- that mail's unsubscribe link, never the secret; a failed send may be claimed again, up to a few
-- times and not while another claim may still be sending.
create table digest_deliveries (
    tenant_id          text not null,
    company_id         text not null,
    project_id         text not null,
    week               date not null check (extract(isodow from week) = 1),
    stakeholder_id     text not null,
    unsubscribe_sha256 text not null,
    attempts           int not null default 1 check (attempts > 0),
    claimed_at         timestamptz not null default now(),
    sent_at            timestamptz,
    primary key (tenant_id, project_id, week, stakeholder_id),
    foreign key (tenant_id, company_id, project_id) references projects (tenant_id, company_id, project_id),
    foreign key (tenant_id, company_id, stakeholder_id)
        references stakeholders (tenant_id, company_id, stakeholder_id) on delete cascade
);

alter table digest_deliveries enable row level security;
alter table digest_deliveries force row level security;
create policy in_scope on digest_deliveries to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));

grant select, insert on digest_deliveries to oryxa_fde_app;
grant update (unsubscribe_sha256, attempts, claimed_at, sent_at) on digest_deliveries to oryxa_fde_app;
