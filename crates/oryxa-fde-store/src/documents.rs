//! Company documents: the metadata of uploaded files (the bytes are in S3) and, once ingested,
//! their text in chunks for full-text and vector search. An upload queues `document.uploaded`;
//! ingestion writes every chunk and marks the document ingested in one transaction, so a
//! redelivered event finds it ingested and adds nothing.

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
    pub uploaded_by: UserId,
    pub created_at: OffsetDateTime,
    pub ingested_at: Option<OffsetDateTime>,
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

const DOCUMENT: &str = "document_id, name, content_type, size_bytes, sha256, status, failure, chunks, uploaded_by,
    created_at, ingested_at";

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

    /// Stores every chunk of a pending document and marks it ingested. Call with the document
    /// locked ([`CompanyTx::lock_document`]); a document that is not pending is refused.
    pub async fn record_chunks(&mut self, id: &DocumentId, model: &str, chunks: &[ChunkIn]) -> Result<(), StoreError> {
        if chunks
            .iter()
            .any(|c| c.embedding.is_empty() || c.embedding.iter().any(|f| !f.is_finite()))
        {
            return Err(StoreError::Rejected("embedding"));
        }
        // Settled first: a document that is not pending gets no chunks at all.
        self.settle(id, DocumentStatus::Ingested, None, chunks.len()).await?;
        let s = self.scope.clone();
        for c in chunks {
            sqlx::query(
                "insert into document_chunks (tenant_id, company_id, document_id, chunk_index, content, embedding,
                     embedding_model)
                 values ($1, $2, $3, $4, $5, $6::vector, $7)",
            )
            .bind(s.tenant.as_str())
            .bind(s.company.as_str())
            .bind(id.as_str())
            .bind(i32::try_from(c.index).map_err(|_| StoreError::Rejected("chunk_index"))?)
            .bind(c.content.as_str())
            .bind(vector(&c.embedding))
            .bind(model)
            .execute(&mut *self.tx)
            .await?;
        }
        Ok(())
    }

    /// Marks a pending document failed, with a short code saying why (never its text).
    pub async fn record_failure(&mut self, id: &DocumentId, why: &'static str) -> Result<(), StoreError> {
        self.settle(id, DocumentStatus::Failed, Some(why), 0).await
    }

    async fn settle(
        &mut self,
        id: &DocumentId,
        status: DocumentStatus,
        failure: Option<&str>,
        chunks: usize,
    ) -> Result<(), StoreError> {
        let s = &self.scope;
        let n = sqlx::query(
            "update documents set status = $4, failure = $5, chunks = $6, ingested_at = now()
             where tenant_id = $1 and company_id = $2 and document_id = $3 and status = 'pending'",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(status.as_str())
        .bind(failure)
        .bind(i32::try_from(chunks).map_err(|_| StoreError::Rejected("chunks"))?)
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if n == 1 {
            Ok(())
        } else {
            Err(StoreError::Rejected("document_not_pending"))
        }
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

const HIT: &str = "c.document_id, d.name, c.chunk_index, c.content from document_chunks c
     join documents d on d.tenant_id = c.tenant_id and d.company_id = c.company_id and d.document_id = c.document_id";

async fn search_text(
    conn: &mut PgConnection,
    s: &CompanyScope,
    query: &str,
    limit: i64,
) -> Result<Vec<ChunkHit>, StoreError> {
    sqlx::query(&format!(
        "select {HIT}, websearch_to_tsquery('english', $3) q
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
    if embedding.is_empty() || embedding.iter().any(|f| !f.is_finite()) {
        return Err(StoreError::Rejected("embedding"));
    }
    // Keep scanning the index past other companies' chunks until `limit` of this one's are found.
    sqlx::query("set local hnsw.iterative_scan = relaxed_order")
        .execute(&mut *conn)
        .await?;
    sqlx::query(&format!(
        "select {HIT}
         where c.tenant_id = $1 and c.company_id = $2 and c.embedding_model = $3
         order by c.embedding <=> $4::vector, c.document_id, c.chunk_index limit $5"
    ))
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
    fn vectors_use_pgvector_text_form() {
        assert_eq!(vector(&[0.5, -1.0, 0.25]), "[0.5,-1,0.25]");
    }
}
