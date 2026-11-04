//! Company documents: the metadata of uploaded files (the bytes are in S3) and, once ingested,
//! their text in chunks for full-text and vector search. An upload queues `document.uploaded`.
//! Ingestion stores chunks a batch at a time under the embedding model, so a redelivered event
//! resumes after the last batch; once every chunk is stored the document names that model's set,
//! which is the only one search reads. A document ingested with a model this one replaces is re-embedded the
//! same way, and its old set deleted when the new one is complete.

use oryxa_core::UserId;
use oryxa_fde_core::{CompanyScope, DocumentId};
use oryxa_fde_events::DocumentUploaded;
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, Row};
use time::OffsetDateTime;

use crate::{Actor, CompanyTx, Name, ProjectTx, StoreError, Text, audit, enqueue, id, name, text, unique_violation};

/// The kinds of file ingestion can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContentType {
    Text,
    Markdown,
    Pdf,
    Docx,
}

impl ContentType {
    pub const ALL: [ContentType; 4] = [
        ContentType::Text,
        ContentType::Markdown,
        ContentType::Pdf,
        ContentType::Docx,
    ];

    /// The media type, as uploaded and stored.
    pub fn as_str(self) -> &'static str {
        match self {
            ContentType::Text => "text/plain",
            ContentType::Markdown => "text/markdown",
            ContentType::Pdf => "application/pdf",
            ContentType::Docx => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }
    }

    /// From a `Content-Type` value; parameters such as `charset` are ignored.
    pub fn parse(media_type: &str) -> Option<Self> {
        let essence = media_type.split(';').next().unwrap_or("").trim();
        Self::ALL.into_iter().find(|c| c.as_str().eq_ignore_ascii_case(essence))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentStatus {
    Pending,
    Ingested,
    Failed,
}

impl DocumentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DocumentStatus::Pending => "pending",
            DocumentStatus::Ingested => "ingested",
            DocumentStatus::Failed => "failed",
        }
    }

    fn parse(s: &str) -> Result<Self, StoreError> {
        [
            DocumentStatus::Pending,
            DocumentStatus::Ingested,
            DocumentStatus::Failed,
        ]
        .into_iter()
        .find(|d| d.as_str() == s)
        .ok_or(StoreError::Corrupt("document status"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Document {
    pub id: DocumentId,
    pub name: Name,
    pub content_type: ContentType,
    pub size_bytes: i64,
    /// Hex SHA-256 of the file.
    pub sha256: String,
    pub status: DocumentStatus,
    /// Why ingestion gave up, as a short code.
    pub failure: Option<String>,
    pub chunks: u32,
    /// The model of the chunk set search reads; `None` until ingested.
    pub embedding_model: Option<String>,
    pub uploaded_by: UserId,
    pub created_at: OffsetDateTime,
    pub ingested_at: Option<OffsetDateTime>,
}

impl Document {
    /// Whether ingestion under `model` has work to do: a pending document, or one ingested with a
    /// model `model` replaces. Any other set is left as it is, so while a rolling deploy runs two
    /// models, the old one never swaps a document back. A failed document is never retried.
    pub fn needs(&self, model: &str, replaces: &[String]) -> bool {
        match (self.status, self.embedding_model.as_deref()) {
            (DocumentStatus::Pending, _) | (DocumentStatus::Ingested, None) => true,
            (DocumentStatus::Ingested, Some(m)) => m != model && replaces.iter().any(|r| r == m),
            (DocumentStatus::Failed, _) => false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DocumentIn {
    pub name: Name,
    pub content_type: ContentType,
    pub size_bytes: i64,
    pub sha256: String,
    /// Where the bytes are in S3; under the company's prefix.
    pub blob_key: String,
}

/// One chunk to store: its place in the document, its text and its embedding.
#[derive(Debug, Clone)]
pub struct ChunkIn {
    pub index: u32,
    pub content: Text,
    pub embedding: Vec<f32>,
}

/// A chunk that matched a search, in rank order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkHit {
    pub document: DocumentId,
    pub document_name: Name,
    pub chunk: u32,
    pub content: Text,
}

const DOCUMENT: &str = "document_id, name, content_type, size_bytes, sha256, status, failure, chunks, embedding_model,
    uploaded_by, created_at, ingested_at";
/// The same test as [`Document::needs`], in SQL over `documents`, with the model as `$4` and the
/// models it replaces as `$5`.
const NEEDS: &str = "(status = 'pending' or (status = 'ingested' and (embedding_model is null
    or (embedding_model <> $4 and embedding_model = any ($5)))))";
/// The generation a writer fills: an ingested document's next one, beside the set search reads,
/// or a pending document's own.
const WRITING: &str = "case when status = 'ingested' then chunk_generation + 1 else chunk_generation end";

impl CompanyTx {
    /// Records an uploaded file and queues `document.uploaded` for ingestion. `None` if the
    /// company does not exist.
    pub async fn add_document(
        &mut self,
        id: &DocumentId,
        v: &DocumentIn,
        by: &Actor,
    ) -> Result<Option<Document>, StoreError> {
        let s = self.scope.clone();
        let row = sqlx::query(&format!(
            "insert into documents (tenant_id, company_id, document_id, name, content_type, size_bytes, sha256,
                 blob_key, uploaded_by)
             select $1, $2, $3, $4, $5, $6, $7, $8, $9
             where exists (select 1 from companies where tenant_id = $1 and company_id = $2)
             returning {DOCUMENT}"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(v.name.as_str())
        .bind(v.content_type.as_str())
        .bind(v.size_bytes)
        .bind(&v.sha256)
        .bind(&v.blob_key)
        .bind(by.user.as_str())
        .fetch_optional(&mut *self.tx)
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        let Some(row) = row else { return Ok(None) };
        audit(&mut self.tx, &s, None, by, "document.uploaded", Some(id.as_str())).await?;
        enqueue(&mut self.tx, &s, by, &DocumentUploaded::new(&s, id.clone())).await?;
        document(row).map(Some)
    }

    /// The company's documents, newest first.
    pub async fn documents(&mut self) -> Result<Vec<Document>, StoreError> {
        let s = &self.scope;
        sqlx::query(&format!(
            "select {DOCUMENT} from documents where tenant_id = $1 and company_id = $2
             order by created_at desc, document_id"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(document)
        .collect()
    }

    pub async fn document(&mut self, id: &DocumentId) -> Result<Option<Document>, StoreError> {
        let s = &self.scope;
        sqlx::query(&format!(
            "select {DOCUMENT} from documents where tenant_id = $1 and company_id = $2 and document_id = $3"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?
        .map(document)
        .transpose()
    }

    /// For ingestion: the document and its S3 key, locked until this transaction ends, so two
    /// deliveries of one event cannot both write chunks. `None` if it is not in this company.
    pub async fn lock_document(&mut self, id: &DocumentId) -> Result<Option<(Document, String)>, StoreError> {
        let s = &self.scope;
        sqlx::query(&format!(
            "select {DOCUMENT}, blob_key from documents where tenant_id = $1 and company_id = $2 and document_id = $3
             for update"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?
        .map(|r| {
            let key: String = r.try_get("blob_key")?;
            Ok((document(r)?, key))
        })
        .transpose()
    }

    /// The chunks already stored for the document under `model` in the generation being written, by
    /// index: what an interrupted ingestion wrote before it stopped. Never the set search reads.
    pub async fn stored_chunks(&mut self, id: &DocumentId, model: &str) -> Result<Vec<(u32, Text)>, StoreError> {
        let s = &self.scope;
        sqlx::query(&format!(
            "select chunk_index, content from document_chunks
             where tenant_id = $1 and company_id = $2 and document_id = $3 and embedding_model = $4
                 and generation = (select {WRITING} from documents
                     where tenant_id = $1 and company_id = $2 and document_id = $3)
             order by chunk_index"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(model)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(|r| {
            let i =
                u32::try_from(r.try_get::<i32, _>("chunk_index")?).map_err(|_| StoreError::Corrupt("chunk index"))?;
            Ok((i, text(r.try_get("content")?, "chunk")?))
        })
        .collect()
    }

    /// Deletes the generation being written under `model`, an interrupted set that cannot be
    /// resumed, with the document locked. The set search reads is another generation and stays.
    /// `false`, deleting nothing, if it no longer needs `model`'s chunks: a complete set (another
    /// worker finished it) is never dropped.
    pub async fn drop_chunks(&mut self, id: &DocumentId, model: &str, replaces: &[String]) -> Result<bool, StoreError> {
        let Some(generation) = self.lock_needing(id, model, replaces).await? else {
            return Ok(false);
        };
        let s = &self.scope;
        sqlx::query(
            "delete from document_chunks
             where tenant_id = $1 and company_id = $2 and document_id = $3 and embedding_model = $4
                 and generation = $5",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(model)
        .bind(generation)
        .execute(&mut *self.tx)
        .await?;
        Ok(true)
    }

    /// Stores chunks of a document that still needs `model`'s ([`Document::needs`]), with the
    /// document locked; a chunk already stored is kept. `false`, storing nothing, if it no longer
    /// needs them.
    pub async fn add_chunks(
        &mut self,
        id: &DocumentId,
        model: &str,
        replaces: &[String],
        chunks: &[ChunkIn],
    ) -> Result<bool, StoreError> {
        if chunks
            .iter()
            .any(|c| c.embedding.is_empty() || c.embedding.iter().any(|f| !f.is_finite()))
        {
            return Err(StoreError::Rejected("embedding"));
        }
        let Some(generation) = self.lock_needing(id, model, replaces).await? else {
            return Ok(false);
        };
        let s = self.scope.clone();
        for c in chunks {
            sqlx::query(
                "insert into document_chunks (tenant_id, company_id, document_id, chunk_index, content, embedding,
                     embedding_model, generation)
                 values ($1, $2, $3, $4, $5, $6::vector, $7, $8) on conflict do nothing",
            )
            .bind(s.tenant.as_str())
            .bind(s.company.as_str())
            .bind(id.as_str())
            .bind(i32::try_from(c.index).map_err(|_| StoreError::Rejected("chunk_index"))?)
            .bind(c.content.as_str())
            .bind(vector(&c.embedding))
            .bind(model)
            .bind(generation)
            .execute(&mut *self.tx)
            .await?;
        }
        Ok(true)
    }

    /// Completes ingestion under `model` once chunks `0..count` of the generation being written are
    /// all stored: the document is ingested and names that set, and every other chunk of it,
    /// the set search read until now included, is deleted. `false`, changing nothing, if it no
    /// longer needs `model`'s chunks; `Rejected("chunks_missing")` if some are not stored yet.
    pub async fn finish_chunks(
        &mut self,
        id: &DocumentId,
        model: &str,
        replaces: &[String],
        count: usize,
    ) -> Result<bool, StoreError> {
        let Some(generation) = self.lock_needing(id, model, replaces).await? else {
            return Ok(false);
        };
        let s = self.scope.clone();
        let count = i32::try_from(count).map_err(|_| StoreError::Rejected("chunks"))?;
        let stored: i64 = sqlx::query_scalar(
            "select count(*) from document_chunks
             where tenant_id = $1 and company_id = $2 and document_id = $3 and embedding_model = $4
                 and generation = $6 and chunk_index < $5",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(model)
        .bind(count)
        .bind(generation)
        .fetch_one(&mut *self.tx)
        .await?;
        if stored != i64::from(count) {
            return Err(StoreError::Rejected("chunks_missing"));
        }
        sqlx::query(
            "delete from document_chunks where tenant_id = $1 and company_id = $2 and document_id = $3
                 and not (embedding_model = $4 and generation = $6 and chunk_index < $5)",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(model)
        .bind(count)
        .bind(generation)
        .execute(&mut *self.tx)
        .await?;
        sqlx::query(
            "update documents set status = 'ingested', failure = null, chunks = $5, embedding_model = $4,
                 chunk_generation = $6, ingested_at = now()
             where tenant_id = $1 and company_id = $2 and document_id = $3",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(model)
        .bind(count)
        .bind(generation)
        .execute(&mut *self.tx)
        .await?;
        Ok(true)
    }

    /// Locks the document; if it still needs `model`'s chunks, the generation they go in.
    async fn lock_needing(
        &mut self,
        id: &DocumentId,
        model: &str,
        replaces: &[String],
    ) -> Result<Option<i32>, StoreError> {
        let s = &self.scope;
        let row: Option<(bool, i32)> = sqlx::query_as(&format!(
            "select {NEEDS}, {WRITING} from documents where tenant_id = $1 and company_id = $2 and document_id = $3
             for update"
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(model)
        .bind(replaces)
        .fetch_optional(&mut *self.tx)
        .await?;
        Ok(row.and_then(|(needs, generation)| needs.then_some(generation)))
    }

    /// Marks a pending document failed, with a short code saying why (never its text), and drops
    /// any chunks an interrupted ingestion left.
    pub async fn record_failure(&mut self, id: &DocumentId, why: &'static str) -> Result<(), StoreError> {
        let s = &self.scope;
        let n = sqlx::query(
            "update documents set status = 'failed', failure = $4, chunks = 0, ingested_at = now()
             where tenant_id = $1 and company_id = $2 and document_id = $3 and status = 'pending'",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(why)
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if n != 1 {
            return Err(StoreError::Rejected("document_not_pending"));
        }
        sqlx::query("delete from document_chunks where tenant_id = $1 and company_id = $2 and document_id = $3")
            .bind(s.tenant.as_str())
            .bind(s.company.as_str())
            .bind(id.as_str())
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }

    /// Chunks whose text matches `query` (web search syntax), best first.
    pub async fn search_text(&mut self, query: &str, limit: i64) -> Result<Vec<ChunkHit>, StoreError> {
        search_text(&mut self.tx, &self.scope, query, limit).await
    }

    /// Chunks embedded by `model`, nearest to `embedding` first.
    pub async fn search_vector(
        &mut self,
        embedding: &[f32],
        model: &str,
        limit: i64,
    ) -> Result<Vec<ChunkHit>, StoreError> {
        search_vector(&mut self.tx, &self.scope, embedding, model, limit).await
    }
}

/// The company's documents searched for whoever works on one of its projects.
impl ProjectTx {
    /// `None` if the project is not in this company.
    pub async fn search_text(&mut self, query: &str, limit: i64) -> Result<Option<Vec<ChunkHit>>, StoreError> {
        if !self.exists().await? {
            return Ok(None);
        }
        search_text(&mut self.tx, &self.scope.company, query, limit)
            .await
            .map(Some)
    }

    /// `None` if the project is not in this company.
    pub async fn search_vector(
        &mut self,
        embedding: &[f32],
        model: &str,
        limit: i64,
    ) -> Result<Option<Vec<ChunkHit>>, StoreError> {
        if !self.exists().await? {
            return Ok(None);
        }
        search_vector(&mut self.tx, &self.scope.company, embedding, model, limit)
            .await
            .map(Some)
    }
}

const HIT_COLUMNS: &str = "c.document_id, d.name, c.chunk_index, c.content";
/// A document's chunks that search reads: the complete set of the model it names, never one being
/// written. A document an older worker ingested names no model and holds one set, which is read too,
/// so a deploy of the API and the ingest worker in either order keeps it findable.
const CHUNKS: &str = "document_chunks c join documents d
     on d.tenant_id = c.tenant_id and d.company_id = c.company_id and d.document_id = c.document_id
         and c.generation = d.chunk_generation
         and (d.embedding_model = c.embedding_model or (d.embedding_model is null and d.status = 'ingested'))";

/// A company with at most this many chunks for a model is searched exactly, every chunk compared,
/// so its recall never depends on how large the shared index has grown. A larger company is a
/// large enough share of the index for one raised-budget scan to find its nearest chunks.
const EXACT_SEARCH_MAX: i64 = 20_000;
/// Index entries one HNSW scan may visit; pgvector's default is 20,000.
// ponytail: 200 candidates for a company of 20,000 chunks are within a 100,000-tuple scan until the
// shared index holds about 10M chunks; past that, partition the chunks by tenant.
const HNSW_MAX_SCAN_TUPLES: &str = "100000";

async fn search_text(
    conn: &mut PgConnection,
    s: &CompanyScope,
    query: &str,
    limit: i64,
) -> Result<Vec<ChunkHit>, StoreError> {
    sqlx::query(&format!(
        "select {HIT_COLUMNS} from {CHUNKS}, websearch_to_tsquery('english', $3) q
         where c.tenant_id = $1 and c.company_id = $2 and c.tsv @@ q
         order by ts_rank_cd(c.tsv, q) desc, c.document_id, c.chunk_index limit $4"
    ))
    .bind(s.tenant.as_str())
    .bind(s.company.as_str())
    .bind(query)
    .bind(limit)
    .fetch_all(conn)
    .await?
    .into_iter()
    .map(hit)
    .collect()
}

async fn search_vector(
    conn: &mut PgConnection,
    s: &CompanyScope,
    embedding: &[f32],
    model: &str,
    limit: i64,
) -> Result<Vec<ChunkHit>, StoreError> {
    search_vector_with(conn, s, embedding, model, limit, EXACT_SEARCH_MAX).await
}

/// [`search_vector`] with the exact-search bound as a parameter, so tests reach both paths.
pub(crate) async fn search_vector_with(
    conn: &mut PgConnection,
    s: &CompanyScope,
    embedding: &[f32],
    model: &str,
    limit: i64,
    exact_max: i64,
) -> Result<Vec<ChunkHit>, StoreError> {
    if embedding.is_empty() || embedding.iter().any(|f| !f.is_finite()) {
        return Err(StoreError::Rejected("embedding"));
    }
    // Counted through the company index, and never past the bound.
    let chunks: i64 = sqlx::query_scalar(
        "select count(*) from (select 1 from document_chunks
             where tenant_id = $1 and company_id = $2 and embedding_model = $3 limit $4) x",
    )
    .bind(s.tenant.as_str())
    .bind(s.company.as_str())
    .bind(model)
    .bind(exact_max + 1)
    .fetch_one(&mut *conn)
    .await?;
    let sql = if chunks <= exact_max {
        // Materialised first, so the planner cannot walk the shared index instead. Only ids and
        // distances are ranked; the text is read for the passages returned.
        format!(
            "with mine as materialized (
                 select c.document_id, c.generation, c.chunk_index, c.embedding <=> $4::vector as distance
                 from {CHUNKS}
                 where c.tenant_id = $1 and c.company_id = $2 and c.embedding_model = $3),
             top as (select * from mine order by distance, document_id, chunk_index limit $5)
             select t.document_id, d.name, t.chunk_index, c.content from top t
             join document_chunks c on c.tenant_id = $1 and c.company_id = $2 and c.document_id = t.document_id
                 and c.embedding_model = $3 and c.generation = t.generation and c.chunk_index = t.chunk_index
             join documents d on d.tenant_id = $1 and d.company_id = $2 and d.document_id = t.document_id
             order by t.distance, t.document_id, t.chunk_index"
        )
    } else {
        // Keep scanning past other companies' chunks, within a raised budget; relaxed order is put
        // right by the outer sort.
        sqlx::query(
            "select set_config('hnsw.iterative_scan', 'relaxed_order', true),
                 set_config('hnsw.max_scan_tuples', $1, true), set_config('hnsw.ef_search', $2, true)",
        )
        .bind(HNSW_MAX_SCAN_TUPLES)
        .bind(limit.clamp(40, 1000).to_string())
        .execute(&mut *conn)
        .await?;
        format!(
            "with near as materialized (
                 select {HIT_COLUMNS}, c.embedding <=> $4::vector as distance from {CHUNKS}
                 where c.tenant_id = $1 and c.company_id = $2 and c.embedding_model = $3
                 order by distance limit $5)
             select document_id, name, chunk_index, content from near order by distance, document_id, chunk_index"
        )
    };
    sqlx::query(&sql)
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(model)
        .bind(vector(embedding))
        .bind(limit)
        .fetch_all(conn)
        .await?
        .into_iter()
        .map(hit)
        .collect()
}

/// pgvector's text form, `[0.1,0.2,...]`.
fn vector(v: &[f32]) -> String {
    let parts: Vec<String> = v.iter().map(f32::to_string).collect();
    format!("[{}]", parts.join(","))
}

fn hit(r: PgRow) -> Result<ChunkHit, StoreError> {
    Ok(ChunkHit {
        document: id("document id", DocumentId::new, r.try_get("document_id")?)?,
        document_name: name(r.try_get("name")?, "document name")?,
        chunk: u32::try_from(r.try_get::<i32, _>("chunk_index")?).map_err(|_| StoreError::Corrupt("chunk index"))?,
        content: text(r.try_get("content")?, "chunk")?,
    })
}

fn document(r: PgRow) -> Result<Document, StoreError> {
    let content_type: String = r.try_get("content_type")?;
    Ok(Document {
        id: id("document id", DocumentId::new, r.try_get("document_id")?)?,
        name: name(r.try_get("name")?, "document name")?,
        content_type: ContentType::parse(&content_type).ok_or(StoreError::Corrupt("content type"))?,
        size_bytes: r.try_get("size_bytes")?,
        sha256: r.try_get("sha256")?,
        status: DocumentStatus::parse(r.try_get("status")?)?,
        failure: r.try_get("failure")?,
        chunks: u32::try_from(r.try_get::<i32, _>("chunks")?).map_err(|_| StoreError::Corrupt("chunks"))?,
        embedding_model: r.try_get("embedding_model")?,
        uploaded_by: id("user id", UserId::new, r.try_get("uploaded_by")?)?,
        created_at: r.try_get("created_at")?,
        ingested_at: r.try_get("ingested_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_types_parse_from_a_header_and_round_trip() {
        for c in ContentType::ALL {
            assert_eq!(ContentType::parse(c.as_str()), Some(c));
        }
        assert_eq!(ContentType::parse("text/plain; charset=utf-8"), Some(ContentType::Text));
        assert_eq!(ContentType::parse("TEXT/MARKDOWN"), Some(ContentType::Markdown));
        for bad in ["text/html", "application/zip", "", "application/pdfx"] {
            assert_eq!(ContentType::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_document_needs_chunks_while_pending_or_ingested_with_another_model() {
        let mut d = Document {
            id: DocumentId::new("doc_1").unwrap(),
            name: Name::new("runbook.md").unwrap(),
            content_type: ContentType::Markdown,
            size_bytes: 1,
            sha256: String::new(),
            status: DocumentStatus::Pending,
            failure: None,
            chunks: 0,
            embedding_model: None,
            uploaded_by: UserId::new("alice").unwrap(),
            created_at: OffsetDateTime::UNIX_EPOCH,
            ingested_at: None,
        };
        let replaces_m1 = ["m1".to_owned()];
        assert!(d.needs("m1", &[]));
        d.status = DocumentStatus::Ingested;
        d.embedding_model = Some("m1".into());
        assert!(!d.needs("m1", &[]));
        assert!(d.needs("m2", &replaces_m1), "a model that replaces m1 re-embeds it");
        assert!(!d.needs("m2", &[]), "any other model leaves it as it is");
        // Mid-deploy, the old model does not swap back a document the new one has re-embedded.
        d.embedding_model = Some("m2".into());
        assert!(!d.needs("m1", &[]));
        d.status = DocumentStatus::Failed;
        assert!(!d.needs("m2", &replaces_m1), "a failed document is never retried");
    }

    #[test]
    fn vectors_use_pgvector_text_form() {
        assert_eq!(vector(&[0.5, -1.0, 0.25]), "[0.5,-1,0.25]");
    }
}
