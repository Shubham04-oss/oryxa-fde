//! Where uploaded files live: S3, one prefix per company (ADR 0003). Object keys are built from
//! validated ids only, so none can leave its company's prefix. A write names the company's own KMS
//! key when company keys are configured and the company has one; otherwise the bucket's default
//! applies, the environment key, which holds sample data only.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use aws_sdk_s3::error::ProvideErrorMetadata;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::ServerSideEncryption;
use oryxa_fde_core::{CompanyScope, DocumentId};
use oryxa_fde_store::SnapshotId;

use crate::keys::{CompanyKeyPrefix, CompanyKeys};
use crate::{BoxFuture, ContextError, MAX_DOCUMENT_BYTES};

pub trait BlobStore: Send + Sync + 'static {
    /// Writes one company object. [`ContextError::KeyUnavailable`] when the company's key refused
    /// it: nothing was stored, and trying again will not help.
    fn put<'a>(
        &'a self,
        object: &'a CompanyObject,
        bytes: Vec<u8>,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<(), ContextError>>;
    /// Reads an object by the key stored with its row. [`ContextError::KeyUnavailable`] when S3 or
    /// KMS refused it: the key is missing, disabled or scheduled for deletion, or this role may not
    /// use it.
    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Vec<u8>, ContextError>>;
}

/// One object of one company: its key in the bucket and the company it belongs to. The fields are
/// private and [`document_key`] and [`canvas_key`] are the only ways to make one, each from a single
/// scope, so a write's key prefix and the company key it names are always the same company's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanyObject {
    scope: CompanyScope,
    key: String,
}

impl CompanyObject {
    fn new(s: &CompanyScope, kind: &str, id: &str) -> Self {
        Self {
            scope: s.clone(),
            key: format!("{}{kind}/{id}", company_prefix(s)),
        }
    }

    /// The object's key in the bucket, as stored with its row.
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn scope(&self) -> &CompanyScope {
        &self.scope
    }

    /// The alias ARN of the key this object is written under, from the object's own scope.
    pub fn key_alias(&self, prefix: &CompanyKeyPrefix) -> String {
        prefix.alias(&self.scope)
    }
}

/// `<tenant>/<company>/`: everything of one company.
pub fn company_prefix(s: &CompanyScope) -> String {
    format!("{}/{}/", s.tenant, s.company)
}

/// `<tenant>/<company>/documents/<document>`.
pub fn document_key(s: &CompanyScope, id: &DocumentId) -> CompanyObject {
    CompanyObject::new(s, "documents", id.as_str())
}

/// `<tenant>/<company>/canvas/<snapshot>`: a canvas snapshot too large for Postgres, of the company
/// or of one of its projects.
pub fn canvas_key(s: &CompanyScope, id: &SnapshotId) -> CompanyObject {
    CompanyObject::new(s, "canvas", id.as_str())
}

/// S3's error codes for a company key that cannot be used: absent, disabled, pending deletion, or
/// not this role's. A write refused by the bucket policy (a company key required, none named) is
/// `AccessDenied` too. None of them is helped by a retry.
fn key_refused(code: Option<&str>) -> bool {
    matches!(
        code,
        Some("AccessDenied" | "KMS.DisabledException" | "KMS.KMSInvalidStateException" | "KMS.NotFoundException")
    )
}

pub struct S3Blobs {
    client: aws_sdk_s3::Client,
    bucket: String,
    /// Set when company keys are configured (`COMPANY_KEY_ALIAS_ARN_PREFIX`).
    keys: Option<(CompanyKeyPrefix, Arc<dyn CompanyKeys>)>,
}

impl S3Blobs {
    pub fn new(client: aws_sdk_s3::Client, bucket: impl Into<String>) -> Self {
        Self {
            client,
            bucket: bucket.into(),
            keys: None,
        }
    }

    /// Writes name a company's key under `prefix` whenever `keys` says the company has one.
    pub fn with_company_keys(mut self, prefix: CompanyKeyPrefix, keys: Arc<dyn CompanyKeys>) -> Self {
        self.keys = Some((prefix, keys));
        self
    }
}

impl BlobStore for S3Blobs {
    fn put<'a>(
        &'a self,
        object: &'a CompanyObject,
        bytes: Vec<u8>,
        content_type: &'a str,
    ) -> BoxFuture<'a, Result<(), ContextError>> {
        Box::pin(async move {
            let mut put = self
                .client
                .put_object()
                .bucket(&self.bucket)
                .key(object.key())
                .content_type(content_type)
                .body(ByteStream::from(bytes));
            // With no company key, no encryption header: SSE-KMS without a key id would mean the
            // account-wide `aws/s3` key, not the bucket's environment key.
            if let Some((prefix, keys)) = &self.keys
                && keys.has_key(object.scope()).await
            {
                // No Bucket Key, so S3 gives KMS the object's ARN as the encryption context, which
                // the company key's policy pins to the company's prefix. No caller context is sent.
                put = put
                    .server_side_encryption(ServerSideEncryption::AwsKms)
                    .ssekms_key_id(object.key_alias(prefix))
                    .bucket_key_enabled(false);
            }
            put.send().await.map_err(|e| {
                if self.keys.is_some() && key_refused(e.code()) {
                    let s = object.scope();
                    tracing::warn!(tenant = %s.tenant, company = %s.company, code = ?e.code(), "write refused: no usable company key");
                    ContextError::KeyUnavailable
                } else {
                    ContextError::Blob(e.to_string())
                }
            })?;
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
                .map_err(|e| {
                    if key_refused(e.code()) {
                        tracing::warn!(code = ?e.code(), "read refused: the object's key cannot be used");
                        ContextError::KeyUnavailable
                    } else {
                        ContextError::Blob(e.to_string())
                    }
                })?;
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
pub struct MemoryBlobs {
    objects: Mutex<HashMap<String, (CompanyScope, Vec<u8>)>>,
    /// Set: as S3 under `require_company_keys`, a company without a usable key can neither write
    /// nor read its objects.
    required: Option<Arc<dyn CompanyKeys>>,
}

impl MemoryBlobs {
    /// The bucket as it is once company keys are required, with `keys` saying who has one.
    pub fn requiring_company_keys(keys: Arc<dyn CompanyKeys>) -> Self {
        Self {
            objects: Mutex::default(),
            required: Some(keys),
        }
    }

    pub fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .objects
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    async fn usable(&self, s: &CompanyScope) -> Result<(), ContextError> {
        match &self.required {
            Some(keys) if !keys.has_key(s).await => Err(ContextError::KeyUnavailable),
            _ => Ok(()),
        }
    }
}

impl BlobStore for MemoryBlobs {
    fn put<'a>(
        &'a self,
        object: &'a CompanyObject,
        bytes: Vec<u8>,
        _: &'a str,
    ) -> BoxFuture<'a, Result<(), ContextError>> {
        Box::pin(async move {
            self.usable(object.scope()).await?;
            self.objects
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(object.key().to_owned(), (object.scope().clone(), bytes));
            Ok(())
        })
    }

    fn get<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Result<Vec<u8>, ContextError>> {
        Box::pin(async move {
            let found = self.objects.lock().unwrap_or_else(|e| e.into_inner()).get(key).cloned();
            let (scope, bytes) = found.ok_or_else(|| ContextError::Blob(format!("no object {key}")))?;
            self.usable(&scope).await?;
            Ok(bytes)
        })
    }
}

#[cfg(test)]
mod tests {
    use aws_sdk_s3::config::http::HttpRequest;
    use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region, retry::RetryConfig};
    use aws_smithy_types::body::SdkBody;
    use oryxa_core::TenantId;
    use oryxa_fde_core::CompanyId;

    use super::*;
    use crate::keys::FakeCompanyKeys;

    const PREFIX: &str = "arn:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/companies/";
    const SSE: [&str; 4] = [
        "x-amz-server-side-encryption",
        "x-amz-server-side-encryption-aws-kms-key-id",
        "x-amz-server-side-encryption-bucket-key-enabled",
        "x-amz-server-side-encryption-context",
    ];

    fn scope(tenant: &str, company: &str) -> CompanyScope {
        CompanyScope::new(TenantId::new(tenant).unwrap(), CompanyId::new(company).unwrap())
    }

    fn s3(http: aws_sdk_s3::config::SharedHttpClient) -> aws_sdk_s3::Client {
        let conf = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("eu-west-2"))
            .credentials_provider(Credentials::new("AKIDTEST", "secret", None, None, "test"))
            .retry_config(RetryConfig::disabled())
            .http_client(http)
            .build();
        aws_sdk_s3::Client::from_conf(conf)
    }

    /// The bucket with company keys configured, and the companies given one.
    fn keyed(blobs: S3Blobs, with_key: &[&CompanyScope]) -> S3Blobs {
        let keys = Arc::new(FakeCompanyKeys::default());
        for s in with_key {
            keys.give(s);
        }
        blobs.with_company_keys(CompanyKeyPrefix::parse(PREFIX).unwrap(), keys)
    }

    /// Writes `object` and returns the request S3 got.
    async fn sent(blobs: impl FnOnce(aws_sdk_s3::Client) -> S3Blobs, object: &CompanyObject) -> HttpRequest {
        let (http, request) = aws_smithy_http_client::test_util::capture_request(None);
        blobs(s3(aws_sdk_s3::config::SharedHttpClient::new(http)))
            .put(object, b"notes".to_vec(), "text/plain")
            .await
            .unwrap();
        request.expect_request()
    }

    fn doc(s: &CompanyScope) -> CompanyObject {
        document_key(s, &DocumentId::new("doc_1").unwrap())
    }

    #[tokio::test]
    async fn without_company_keys_uploads_leave_encryption_to_the_bucket_key() {
        let s = scope("org_1", "cmp_1");
        let sent = sent(|c| S3Blobs::new(c, "fde-dev-documents"), &doc(&s)).await;
        // Any SSE header would override the bucket's key, and SSE-KMS without a key id is `aws/s3`.
        for h in SSE {
            assert_eq!(sent.headers().get(h), None, "{h}");
        }
        assert!(sent.uri().contains("org_1/cmp_1/documents/doc_1"));
    }

    #[tokio::test]
    async fn a_company_with_a_key_is_written_under_it_without_a_bucket_key_or_a_context() {
        let s = scope("org_1", "cmp_1");
        let sent = sent(|c| keyed(S3Blobs::new(c, "fde-dev-documents"), &[&s]), &doc(&s)).await;
        let h = |name: &str| sent.headers().get(name).map(str::to_owned);
        assert_eq!(h("x-amz-server-side-encryption").as_deref(), Some("aws:kms"));
        assert_eq!(
            h("x-amz-server-side-encryption-aws-kms-key-id").as_deref(),
            Some("arn:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/companies/cmp_1")
        );
        assert_eq!(
            h("x-amz-server-side-encryption-bucket-key-enabled").as_deref(),
            Some("false")
        );
        // S3 adds the object's ARN itself; a context from the caller could try to choose it.
        assert_eq!(h("x-amz-server-side-encryption-context"), None);
        assert!(sent.uri().contains("org_1/cmp_1/documents/doc_1"));
    }

    #[tokio::test]
    async fn a_company_without_a_key_names_none_and_gets_the_bucket_default() {
        let (s, other) = (scope("org_1", "cmp_1"), scope("org_1", "cmp_2"));
        let sent = sent(|c| keyed(S3Blobs::new(c, "fde-dev-documents"), &[&other]), &doc(&s)).await;
        for h in SSE {
            assert_eq!(
                sent.headers().get(h),
                None,
                "{h}: another company's key is never borrowed"
            );
        }
    }

    #[tokio::test]
    async fn a_write_names_the_key_of_the_company_whose_prefix_it_writes_under() {
        let (a, b, b_elsewhere) = (
            scope("org_1", "cmp_a"),
            scope("org_1", "cmp_b"),
            scope("org_2", "cmp_b"),
        );
        let snapshot = SnapshotId::new("cnv_1").unwrap();
        for s in [&a, &b, &b_elsewhere] {
            for object in [doc(s), canvas_key(s, &snapshot)] {
                assert!(object.key().starts_with(&company_prefix(s)));
                assert_eq!(object.scope(), s);
                let all = [&a, &b, &b_elsewhere];
                let sent = sent(|c| keyed(S3Blobs::new(c, "fde-dev-documents"), &all), &object).await;
                let alias = sent
                    .headers()
                    .get("x-amz-server-side-encryption-aws-kms-key-id")
                    .unwrap();
                assert_eq!(alias, format!("{PREFIX}{}", s.company));
                assert!(sent.uri().contains(object.key()), "{}", sent.uri());
                // The company in the path is the company in the alias.
                assert_eq!(object.key().split('/').nth(1), alias.rsplit('/').next());
            }
        }
        // The answer is per tenant and company: the same company id in another tenant, with no key
        // of its own, names none.
        let sent = sent(
            |c| keyed(S3Blobs::new(c, "fde-dev-documents"), &[&b]),
            &doc(&b_elsewhere),
        )
        .await;
        assert_eq!(sent.headers().get("x-amz-server-side-encryption-aws-kms-key-id"), None);
    }

    /// S3 answering every request with `status` and an error `code`.
    fn refusing(status: u16, code: &'static str) -> aws_sdk_s3::Client {
        s3(aws_smithy_http_client::test_util::infallible_client_fn(move |_| {
            http::Response::builder()
                .status(status)
                .header("content-type", "application/xml")
                .body(SdkBody::from(format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Error><Code>{code}</Code><Message>no</Message></Error>"
                )))
                .unwrap()
        }))
    }

    #[tokio::test]
    async fn a_refused_key_is_a_permanent_error_and_anything_else_is_not() {
        let s = scope("org_1", "cmp_1");
        let put = |blobs: S3Blobs| {
            let object = doc(&s);
            async move { blobs.put(&object, b"x".to_vec(), "text/plain").await }
        };
        // The bucket requires a company key and none was named.
        let keyless = keyed(S3Blobs::new(refusing(403, "AccessDenied"), "b"), &[]);
        assert!(matches!(put(keyless).await, Err(ContextError::KeyUnavailable)));
        // The key was named but has since been disabled, scheduled for deletion or deleted.
        for code in [
            "KMS.DisabledException",
            "KMS.KMSInvalidStateException",
            "KMS.NotFoundException",
        ] {
            let named = keyed(S3Blobs::new(refusing(400, code), "b"), &[&scope("org_1", "cmp_1")]);
            assert!(matches!(put(named).await, Err(ContextError::KeyUnavailable)), "{code}");
        }
        // A passing failure stays one; and without company keys nothing changes.
        let flaky = keyed(S3Blobs::new(refusing(503, "SlowDown"), "b"), &[]);
        assert!(matches!(put(flaky).await, Err(ContextError::Blob(_))));
        let unconfigured = S3Blobs::new(refusing(403, "AccessDenied"), "b");
        assert!(matches!(put(unconfigured).await, Err(ContextError::Blob(_))));

        // Reads: the role may not use the key, or the key is disabled or going.
        for (status, code) in [
            (403, "AccessDenied"),
            (400, "KMS.DisabledException"),
            (400, "KMS.KMSInvalidStateException"),
        ] {
            let blobs = S3Blobs::new(refusing(status, code), "b");
            assert!(
                matches!(
                    blobs.get("org_1/cmp_1/documents/doc_1").await,
                    Err(ContextError::KeyUnavailable)
                ),
                "{code}"
            );
        }
        let blobs = S3Blobs::new(refusing(500, "InternalError"), "b");
        assert!(matches!(
            blobs.get("org_1/cmp_1/documents/doc_1").await,
            Err(ContextError::Blob(_))
        ));
    }

    #[tokio::test]
    async fn the_memory_bucket_requiring_keys_stores_nothing_for_a_company_without_one() {
        let keys = Arc::new(FakeCompanyKeys::default());
        let blobs = MemoryBlobs::requiring_company_keys(keys.clone());
        let s = scope("org_1", "cmp_1");
        assert!(matches!(
            blobs.put(&doc(&s), b"x".to_vec(), "text/plain").await,
            Err(ContextError::KeyUnavailable)
        ));
        assert!(blobs.keys().is_empty());
        keys.give(&s);
        blobs.put(&doc(&s), b"x".to_vec(), "text/plain").await.unwrap();
        assert_eq!(blobs.get(doc(&s).key()).await.unwrap(), b"x");
        // Offboarded: its key is gone, and so are its files.
        keys.take(&s);
        assert!(matches!(
            blobs.get(doc(&s).key()).await,
            Err(ContextError::KeyUnavailable)
        ));
    }

    #[test]
    fn a_document_key_stays_under_its_company_prefix() {
        let s = scope("org_1", "cmp_1");
        let key = doc(&s);
        assert_eq!(key.key(), "org_1/cmp_1/documents/doc_1");
        assert!(key.key().starts_with(&company_prefix(&s)));
        // Ids cannot hold a separator, so no id climbs out of the prefix.
        assert!(DocumentId::new("../x").is_err() && DocumentId::new("a/b").is_err());
        let canvas = canvas_key(&s, &SnapshotId::new("cnv_1").unwrap());
        assert_eq!(canvas.key(), "org_1/cmp_1/canvas/cnv_1");
        assert!(SnapshotId::new("../x").is_err() && SnapshotId::new("a/b").is_err());
    }
}
