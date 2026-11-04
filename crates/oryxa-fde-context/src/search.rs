//! Hybrid search over a company's chunks: full-text (Postgres `websearch_to_tsquery`) and vector
//! (pgvector cosine distance) each rank candidates, and reciprocal rank fusion merges the two
//! lists, so a passage that both find comes first and one that only one finds still shows.

use std::collections::HashMap;
use std::fmt;

use oryxa_fde_core::{CompanyScope, DocumentId, ProjectScope};
use oryxa_fde_store::{ChunkHit, Name, Store, Text};

use crate::{Context, ContextError};

/// The usual constant for reciprocal rank fusion: a hit at rank r scores 1 / (K + r).
pub const RRF_K: f64 = 60.0;
pub const MAX_QUERY_CHARS: usize = 500;
pub const MAX_RESULTS: usize = 50;

/// A search query: customer text, so it is bounded and kept out of `Debug` output.
#[derive(Clone, PartialEq, Eq)]
pub struct SearchQuery(String);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("a query must be 1..={MAX_QUERY_CHARS} characters with no control characters")]
pub struct QueryError;

impl SearchQuery {
    pub fn new(raw: impl AsRef<str>) -> Result<Self, QueryError> {
        let v = raw.as_ref().trim();
        let chars = v.chars().count();
        if (1..=MAX_QUERY_CHARS).contains(&chars) && !v.chars().any(char::is_control) {
            Ok(Self(v.to_owned()))
        } else {
            Err(QueryError)
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SearchQuery {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SearchQuery(<{} chars>)", self.0.chars().count())
    }
}

/// One passage found, best first.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub document: DocumentId,
    pub document_name: Name,
    pub chunk: u32,
    pub content: Text,
    /// Fused score; only its order means anything.
    pub score: f64,
}

/// Merges ranked lists by reciprocal rank fusion and keeps the best `limit`. Ties keep the order
/// in which a passage was first seen, so the result is deterministic.
pub fn fuse(lists: &[Vec<ChunkHit>], limit: usize) -> Vec<Hit> {
    let mut scores: HashMap<(DocumentId, u32), (f64, usize)> = HashMap::new();
    let mut seen: Vec<&ChunkHit> = Vec::new();
    for list in lists {
        for (rank, hit) in list.iter().enumerate() {
            let key = (hit.document.clone(), hit.chunk);
            let first = seen.len();
            let entry = scores.entry(key).or_insert_with(|| {
                seen.push(hit);
                (0.0, first)
            });
            entry.0 += 1.0 / (RRF_K + rank as f64 + 1.0);
        }
    }
    let mut hits: Vec<(f64, usize, &ChunkHit)> = seen
        .iter()
        .map(|h| {
            let (score, order) = scores[&(h.document.clone(), h.chunk)];
            (score, order, *h)
        })
        .collect();
    hits.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)));
    hits.into_iter()
        .take(limit)
        .map(|(score, _, h)| Hit {
            document: h.document.clone(),
            document_name: h.document_name.clone(),
            chunk: h.chunk,
            content: h.content.clone(),
            score,
        })
        .collect()
}

/// Candidates each method contributes before fusion.
fn pool(limit: usize) -> i64 {
    (limit.clamp(1, MAX_RESULTS) * 4) as i64
}

/// Searches one company's documents. The caller has checked `work` on the company.
pub async fn search_company(
    ctx: &Context,
    store: &Store,
    scope: &CompanyScope,
    query: &SearchQuery,
    limit: usize,
) -> Result<Vec<Hit>, ContextError> {
    let embedding = embed_query(ctx, query).await?;
    let mut tx = store.company(scope).await?;
    let text = tx.search_text(query.as_str(), pool(limit)).await?;
    let near = tx.search_vector(&embedding, ctx.embedder.model(), pool(limit)).await?;
    tx.commit().await?;
    Ok(fuse(&[text, near], limit.clamp(1, MAX_RESULTS)))
}

/// Searches the documents of the project's company, for whoever works on the project. The caller
/// has checked `work` on the project; `None` if the project is not in that company.
pub async fn search_project(
    ctx: &Context,
    store: &Store,
    scope: &ProjectScope,
    query: &SearchQuery,
    limit: usize,
) -> Result<Option<Vec<Hit>>, ContextError> {
    let embedding = embed_query(ctx, query).await?;
    let mut tx = store.project(scope).await?;
    let Some(text) = tx.search_text(query.as_str(), pool(limit)).await? else {
        return Ok(None);
    };
    let near = tx
        .search_vector(&embedding, ctx.embedder.model(), pool(limit))
        .await?
        .unwrap_or_default();
    tx.commit().await?;
    Ok(Some(fuse(&[text, near], limit.clamp(1, MAX_RESULTS))))
}

async fn embed_query(ctx: &Context, query: &SearchQuery) -> Result<Vec<f32>, ContextError> {
    let text = Text::new(query.as_str()).map_err(|_| ContextError::Embed("query".into()))?;
    ctx.embedder
        .embed(std::slice::from_ref(&text))
        .await?
        .pop()
        .ok_or_else(|| ContextError::Embed("no vector for the query".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(doc: &str, chunk: u32) -> ChunkHit {
        ChunkHit {
            document: DocumentId::new(doc).unwrap(),
            document_name: Name::new(doc).unwrap(),
            chunk,
            content: Text::new(format!("{doc} {chunk}")).unwrap(),
        }
    }

    fn keys(hits: &[Hit]) -> Vec<(String, u32)> {
        hits.iter().map(|h| (h.document.to_string(), h.chunk)).collect()
    }

    #[test]
    fn a_passage_both_methods_find_ranks_first() {
        let text = vec![hit("a", 0), hit("b", 0), hit("c", 0)];
        let near = vec![hit("d", 0), hit("c", 0), hit("e", 0)];
        let got = fuse(&[text, near], 10);
        assert_eq!(got[0].document.as_str(), "c");
        assert!((got[0].score - (1.0 / 63.0 + 1.0 / 62.0)).abs() < 1e-12);
        // Then the two top-ranked singles in the order first seen, then the rest.
        assert_eq!(
            keys(&got),
            [
                ("c".into(), 0),
                ("a".into(), 0),
                ("d".into(), 0),
                ("b".into(), 0),
                ("e".into(), 0)
            ]
        );
    }

    #[test]
    fn chunks_of_one_document_are_separate_hits_and_limit_applies() {
        let got = fuse(&[vec![hit("a", 0), hit("a", 1), hit("a", 2)]], 2);
        assert_eq!(keys(&got), [("a".into(), 0), ("a".into(), 1)]);
        assert!(fuse(&[vec![], vec![]], 5).is_empty());
    }

    #[test]
    fn queries_are_bounded_and_printable() {
        assert_eq!(SearchQuery::new("  refund policy ").unwrap().as_str(), "refund policy");
        for bad in ["", "   ", "a\nb", &"x".repeat(MAX_QUERY_CHARS + 1)] {
            assert_eq!(SearchQuery::new(bad), Err(QueryError), "{bad:?}");
        }
        assert_eq!(
            format!("{:?}", SearchQuery::new("secret").unwrap()),
            "SearchQuery(<6 chars>)"
        );
    }
}
