//! Where uploaded files live: S3, one prefix per company (ADR 0003), encrypted by the bucket's
//! default, the environment's KMS key in P0. Object keys are built from validated ids only, so none
//! can leave its company's prefix.

use std::collections::HashMap;
use std::sync::Mutex;

use aws_sdk_s3::primitives::ByteStream;
use oryxa_fde_core::{CompanyScope, DocumentId};
use oryxa_fde_store::SnapshotId;

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

/// `<tenant>/<company>/canvas/<snapshot>`: a canvas snapshot too large for Postgres, of the company
/// or of one of its projects.
pub fn canvas_key(s: &CompanyScope, id: &SnapshotId) -> String {
    format!("{}canvas/{id}", company_prefix(s))
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
            // No encryption header: SSE-KMS without a key id would mean the account-wide `aws/s3`
            // key, not the bucket's. ponytail: P1 names each company's key here (ADR 0003).
            self.client
                .put_object()
                .bucket(&self.bucket)
                .key(key)
                .content_type(content_type)
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

    #[tokio::test]
    async fn uploads_leave_encryption_to_the_bucket_key() {
        use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
        let (http, request) = aws_smithy_http_client::test_util::capture_request(None);
        let conf = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("eu-west-2"))
            .credentials_provider(Credentials::new("AKIDTEST", "secret", None, None, "test"))
            .http_client(http)
            .build();
        let blobs = S3Blobs::new(aws_sdk_s3::Client::from_conf(conf), "fde-dev-documents");
        blobs
            .put("org_1/cmp_1/documents/doc_1", b"notes".to_vec(), "text/plain")
            .await
            .unwrap();
        let sent = request.expect_request();
        let headers = sent.headers();
        // Any SSE header would override the bucket's key, and SSE-KMS without a key id is `aws/s3`.
        for h in [
            "x-amz-server-side-encryption",
            "x-amz-server-side-encryption-aws-kms-key-id",
        ] {
            assert_eq!(headers.get(h), None, "{h}");
        }
        assert!(sent.uri().contains("org_1/cmp_1/documents/doc_1"));
    }

    #[test]
    fn a_document_key_stays_under_its_company_prefix() {
        let s = CompanyScope::new(TenantId::new("org_1").unwrap(), CompanyId::new("cmp_1").unwrap());
        let key = document_key(&s, &DocumentId::new("doc_1").unwrap());
        assert_eq!(key, "org_1/cmp_1/documents/doc_1");
        assert!(key.starts_with(&company_prefix(&s)));
        // Ids cannot hold a separator, so no id climbs out of the prefix.
        assert!(DocumentId::new("../x").is_err() && DocumentId::new("a/b").is_err());
        let canvas = canvas_key(&s, &SnapshotId::new("cnv_1").unwrap());
        assert_eq!(canvas, "org_1/cmp_1/canvas/cnv_1");
        assert!(SnapshotId::new("../x").is_err() && SnapshotId::new("a/b").is_err());
    }
}
