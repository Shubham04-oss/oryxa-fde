//! Where uploaded files live: S3, one prefix per company (ADR 0003), encrypted with KMS. Object
//! keys are built from validated ids only, so none can leave its company's prefix.

use std::collections::HashMap;
use std::sync::Mutex;

use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::ServerSideEncryption;
use oryxa_fde_core::{CompanyScope, DocumentId};

use crate::{BoxFuture, ContextError, MAX_DOCUMENT_BYTES};

pub trait BlobStore: Send + Sync + 'static {
    fn put<'a>(
        &'a self,
        key: &'a str,
        bytes: Vec<u8>,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<(), ContextError>>;
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Vec<u8>, ContextError>>;
}

/// `<tenant>/<company>/`: everything of one company.
pub fn company_prefix(s: &CompanyScope) -> String {
    format!("{}/{}/", s.tenant, s.company)
}

/// `<tenant>/<company>/documents/<document>`.
pub fn document_key(s: &CompanyScope, id: &DocumentId) -> String {
    format!("{}documents/{id}", company_prefix(s))
}

pub struct S3Blobs {
    client: aws_sdk_s3::Client,
    bucket: String,
}

impl S3Blobs {
    pub fn new(client: aws_sdk_s3::Client, bucket: impl Into<String>) -> Self {
        Self {
            client,
            bucket: bucket.into(),
        }
    }
}

impl BlobStore for S3Blobs {
    fn put<'a>(
        &'a self,
        key: &'a str,
        bytes: Vec<u8>,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<(), ContextError>> {
        Box::pin(async move {
            // ponytail: the environment's KMS key, as ADR 0003 says for P0; P1 names the company's key.
            self.client
                .put_object()
                .bucket(&self.bucket)
                .key(key)
                .content_type(content_type)
                .server_side_encryption(ServerSideEncryption::AwsKms)
                .body(ByteStream::from(bytes))
                .send()
                .await
                .map_err(|e| ContextError::Blob(e.to_string()))?;
            Ok(())
        })
    }

    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Vec<u8>, ContextError>> {
        Box::pin(async move {
            let out = self
                .client
                .get_object()
                .bucket(&self.bucket)
                .key(key)
                .send()
                .await
                .map_err(|e| ContextError::Blob(e.to_string()))?;
            if out.content_length.unwrap_or(0) > MAX_DOCUMENT_BYTES as i64 {
                return Err(ContextError::Blob("object over the document size limit".into()));
            }
            let bytes = out
                .body
                .collect()
                .await
                .map_err(|e| ContextError::Blob(e.to_string()))?;
            Ok(bytes.into_bytes().to_vec())
        })
    }
}

/// In memory, for tests and local runs.
#[derive(Default)]
pub struct MemoryBlobs(Mutex<HashMap<String, Vec<u8>>>);

impl MemoryBlobs {
    pub fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }
}

impl BlobStore for MemoryBlobs {
    fn put<'a>(&'a self, key: &'a str, bytes: Vec<u8>, _: &'a str) -> BoxFuture<'a, Result<(), ContextError>> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key.to_owned(), bytes);
            Ok(())
        })
    }

    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Vec<u8>, ContextError>> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(key)
                .cloned()
                .ok_or_else(|| ContextError::Blob(format!("no object {key}")))
        })
    }
}

#[cfg(test)]
mod tests {
    use oryxa_core::TenantId;
    use oryxa_fde_core::CompanyId;

    use super::*;

    #[test]
    fn a_document_key_stays_under_its_company_prefix() {
        let s = CompanyScope::new(TenantId::new("org_1").unwrap(), CompanyId::new("cmp_1").unwrap());
        let key = document_key(&s, &DocumentId::new("doc_1").unwrap());
        assert_eq!(key, "org_1/cmp_1/documents/doc_1");
        assert!(key.starts_with(&company_prefix(&s)));
        // Ids cannot hold a separator, so no id climbs out of the prefix.
        assert!(DocumentId::new("../x").is_err() && DocumentId::new("a/b").is_err());
    }
}
