-- A plan step is a task (ADR 0008, #224): a task names the stage it belongs to; a success criterion
-- carries its measured baseline and how it will be proven; a company names one main contact.
-- Additive only: every new column is optional or defaults, so existing rows and writers are unchanged.

-- One of the eight stages of oryxa-fde-core, or none (tasks from before this have none).
alter table tasks add column stage text check (stage is null or stage in
    ('discover', 'scope', 'access', 'build', 'evaluate', 'deploy', 'handoff', 'operate'));

-- The value measured before the work, in the target's unit; and how it will be proven (an eval
-- suite, an uploaded result), short text, never markup.
alter table criteria add column baseline double precision
    check (baseline is null or baseline not in ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8));
alter table criteria add column proof text check (proof is null or char_length(proof) between 1 and 500);

-- At most one main contact per company.
alter table stakeholders add column main_contact boolean not null default false;
create unique index stakeholders_one_main_contact on stakeholders (tenant_id, company_id) where main_contact;
