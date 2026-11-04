//! Text to vectors. The provider is a trait so the model comes from configuration (Bedrock Titan
//! Text Embeddings v2 by default) and tests use a deterministic fake. Every vector has
//! [`DIMENSIONS`] floats, the size of the `document_chunks.embedding` column.

use aws_sdk_bedrockruntime::primitives::Blob;
use oryxa_fde_store::Text;
use serde_json::{Value, json};

use crate::{BoxFuture, ContextError};

pub const DIMENSIONS: usize = 1024;
pub const TITAN_V2: &str = "amazon.titan-embed-text-v2:0";
/// Bedrock calls in flight at once for one batch.
const CONCURRENCY: usize = 8;

pub trait Embedder: Send + Sync + 'static {
    /// Recorded on each chunk; search compares a query only with chunks of the same model.
    fn model(&self) -> &str;
    /// One vector per text, in order.
    fn embed<'a>(&'a self, texts: &'a [Text]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, ContextError>>;
}

/// Deterministic and offline: each word adds ±1 to a hashed dimension, then the vector is
/// normalised. Texts that share words are close, which is enough to test ranking.
pub struct FakeEmbedder;

impl FakeEmbedder {
    pub fn vector(text: &str) -> Vec<f32> {
        let mut v = vec![0f32; DIMENSIONS];
        for word in text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.chars().count() > 1)
        {
            let h = fnv1a(&word.to_lowercase());
            let sign = if h & 1 == 0 { 1.0 } else { -1.0 };
            v[(h >> 1) as usize % DIMENSIONS] += sign;
        }
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm == 0.0 {
            // A zero vector has no direction; give wordless text a fixed one.
            v[0] = 1.0;
        } else {
            v.iter_mut().for_each(|x| *x /= norm);
        }
        v
    }
}

fn fnv1a(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

impl Embedder for FakeEmbedder {
    fn model(&self) -> &str {
        "fake-hash-v1"
    }

    fn embed<'a>(&'a self, texts: &'a [Text]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, ContextError>> {
        Box::pin(async move { Ok(texts.iter().map(|t| Self::vector(t.as_str())).collect()) })
    }
}

/// Titan Text Embeddings v2 on Bedrock, in the API's own AWS account and region.
pub struct BedrockEmbedder {
    client: aws_sdk_bedrockruntime::Client,
    model: String,
}

impl BedrockEmbedder {
    pub fn new(client: aws_sdk_bedrockruntime::Client, model: impl Into<String>) -> Self {
        Self {
            client,
            model: model.into(),
        }
    }
}

impl Embedder for BedrockEmbedder {
    fn model(&self) -> &str {
        &self.model
    }

    fn embed<'a>(&'a self, texts: &'a [Text]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, ContextError>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(texts.len());
            for batch in texts.chunks(CONCURRENCY) {
                let mut calls = tokio::task::JoinSet::new();
                for (i, t) in batch.iter().enumerate() {
                    let (client, model) = (self.client.clone(), self.model.clone());
                    let body = json!({"inputText": t.as_str(), "dimensions": DIMENSIONS, "normalize": true});
                    calls.spawn(async move {
                        let resp = client
                            .invoke_model()
                            .model_id(model)
                            .content_type("application/json")
                            .accept("application/json")
                            .body(Blob::new(body.to_string()))
                            .send()
                            .await
                            .map_err(|e| ContextError::Embed(e.to_string()))?;
                        Ok::<_, ContextError>((i, titan_vector(resp.body.as_ref())?))
                    });
                }
                let mut got = vec![Vec::new(); batch.len()];
                while let Some(joined) = calls.join_next().await {
                    let (i, v) = joined.map_err(|e| ContextError::Embed(e.to_string()))??;
                    got[i] = v;
                }
                out.extend(got);
            }
            Ok(out)
        })
    }
}

/// The `embedding` of a Titan response, checked for size and finite values.
fn titan_vector(body: &[u8]) -> Result<Vec<f32>, ContextError> {
    let v: Value = serde_json::from_slice(body).map_err(|e| ContextError::Embed(e.to_string()))?;
    let floats: Vec<f32> = v["embedding"]
        .as_array()
        .ok_or_else(|| ContextError::Embed("no embedding in the response".into()))?
        .iter()
        .map(|x| x.as_f64().map(|f| f as f32))
        .collect::<Option<_>>()
        .ok_or_else(|| ContextError::Embed("non-numeric embedding".into()))?;
    if floats.len() != DIMENSIONS || floats.iter().any(|f| !f.is_finite()) {
        return Err(ContextError::Embed(format!(
            "expected {DIMENSIONS} finite floats, got {}",
            floats.len()
        )));
    }
    Ok(floats)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cosine(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[test]
    fn the_fake_is_deterministic_normalised_and_word_based() {
        let a = FakeEmbedder::vector("Refunds over 500 need approval");
        assert_eq!(a, FakeEmbedder::vector("refunds OVER 500 need approval!"));
        assert_eq!(a.len(), DIMENSIONS);
        assert!((cosine(&a, &a) - 1.0).abs() < 1e-5);
        let near = FakeEmbedder::vector("approval for refunds");
        let far = FakeEmbedder::vector("kubernetes pod restarts");
        assert!(cosine(&a, &near) > cosine(&a, &far));
        assert_eq!(
            FakeEmbedder::vector("- !")[0],
            1.0,
            "wordless text still has a direction"
        );
    }

    #[test]
    fn a_titan_response_must_have_the_right_size() {
        let ok = json!({"embedding": vec![0.5; DIMENSIONS]}).to_string();
        assert_eq!(titan_vector(ok.as_bytes()).unwrap().len(), DIMENSIONS);
        for bad in [
            json!({"embedding": vec![0.5; 3]}),
            json!({"embedding": ["x"]}),
            json!({"other": 1}),
        ] {
            assert!(titan_vector(bad.to_string().as_bytes()).is_err(), "{bad}");
        }
    }
}
