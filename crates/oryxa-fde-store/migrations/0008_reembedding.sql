-- Re-embedding and resumable ingestion (#50). A document's chunks are keyed by model and
-- generation, so a new set is written beside the one search reads, a batch at a time; a redelivery
-- resumes after the last batch stored. Search reads only the set the document names, which moves
-- to the new set once every chunk is written, and the old set is deleted then.

alter table documents add column embedding_model text;

-- FORCE row-level security applies to the owner too, and no policy names the migrator: lift it for
-- the backfill only, inside this migration's transaction.
alter table documents no force row level security;
alter table document_chunks no force row level security;
update documents d set embedding_model = (
    select min(c.embedding_model) from document_chunks c
    where c.tenant_id = d.tenant_id and c.document_id = d.document_id)
where d.status = 'ingested';
alter table documents force row level security;
alter table document_chunks force row level security;

-- A set is also numbered: a document already ingested gets its new set (another model, or the same
-- one chunked anew) in the next generation, beside the set search reads, which it names.
alter table document_chunks add column generation int not null default 0 check (generation >= 0);
alter table documents add column chunk_generation int not null default 0 check (chunk_generation >= 0);

alter table document_chunks drop constraint document_chunks_pkey;
alter table document_chunks add primary key (tenant_id, document_id, embedding_model, generation, chunk_index);

-- Ingestion drops an interrupted set it cannot resume, and the old model's set once replaced.
grant delete on document_chunks to oryxa_fde_app;
