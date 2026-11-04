-- Company documents and their searchable chunks (#18). The file itself is in S3 under the
-- company's prefix; Postgres keeps its metadata and, once ingested, its text in chunks with a
-- full-text vector and an embedding. Same row-level security as every company table.

-- The bootstrap creates the extension as the master; this is a no-op once it exists.
create extension if not exists vector;

create table documents (
    tenant_id    text not null,
    company_id   text not null,
    document_id  text not null,
    name         text not null,
    content_type text not null
        check (content_type in ('text/plain', 'text/markdown', 'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
    size_bytes   bigint not null check (size_bytes > 0),
    sha256       text not null,
    blob_key     text not null,
    status       text not null default 'pending' check (status in ('pending', 'ingested', 'failed')),
    -- Why ingestion gave up, as a short code (never document text).
    failure      text,
    chunks       int not null default 0,
    uploaded_by  text not null,
    created_at   timestamptz not null default now(),
    ingested_at  timestamptz,
    primary key (tenant_id, document_id),
    unique (tenant_id, company_id, document_id),
    foreign key (tenant_id, company_id) references companies (tenant_id, company_id)
);

-- Embeddings are 1024 floats (Titan Text Embeddings v2); a chunk records its model so search
-- compares a query only with chunks embedded by the same one.
create table document_chunks (
    tenant_id       text not null,
    company_id      text not null,
    document_id     text not null,
    chunk_index     int not null check (chunk_index >= 0),
    content         text not null,
    tsv             tsvector generated always as (to_tsvector('english', content)) stored,
    embedding       vector(1024) not null,
    embedding_model text not null,
    created_at      timestamptz not null default now(),
    primary key (tenant_id, document_id, chunk_index),
    foreign key (tenant_id, company_id, document_id) references documents (tenant_id, company_id, document_id)
);
create index document_chunks_tsv on document_chunks using gin (tsv);
create index document_chunks_embedding on document_chunks using hnsw (embedding vector_cosine_ops);
create index document_chunks_company on document_chunks (tenant_id, company_id);

alter table documents enable row level security;
alter table documents force row level security;
alter table document_chunks enable row level security;
alter table document_chunks force row level security;

create policy in_scope on documents to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));
create policy in_scope on document_chunks to oryxa_fde_app using (fde_in_scope(tenant_id, company_id));

grant select, insert, update on documents to oryxa_fde_app;
grant select, insert on document_chunks to oryxa_fde_app;
