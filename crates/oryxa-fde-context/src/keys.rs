//! Per-company KMS keys (ADR 0003's amendment; `infra/README.md`, "Company keys"). A provisioning
//! step outside the API makes one key per company, aliased `alias/oryxa-fde-<env>/companies/<company>`.
//! Here: the alias prefix from config, validated at startup, and whether a company has its key,
//! answered from `kms:DescribeKey` on its alias and failing closed.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use aws_sdk_kms::error::ProvideErrorMetadata;
use aws_sdk_kms::types::{KeyState, KeyUsageType};
use oryxa_fde_core::CompanyScope;

use crate::{BoxFuture, ContextError};

/// The config variable: infra's output `company_key_alias_arn_prefix`. Unset, no company key is
/// named and every file is under the environment key (sample data only).
pub const PREFIX_VAR: &str = "COMPANY_KEY_ALIAS_ARN_PREFIX";

/// How long a yes is believed. A key disabled or scheduled for deletion meanwhile costs at most
/// the writes of this window, which KMS refuses.
const YES_FOR: Duration = Duration::from_secs(60);
/// How long a no (or a failed check) is believed: a key just provisioned is used within this.
const NO_FOR: Duration = Duration::from_secs(5);
/// The longest a check waits on KMS before it answers no.
const DESCRIBE_TIMEOUT: Duration = Duration::from_secs(3);
/// Companies remembered at once; past it expired answers go, then all of them.
const MAX_CACHED: usize = 10_000;

/// `arn:<partition>:kms:<region>:<account>:alias/oryxa-fde-<env>/companies/`, the only shape the
/// bucket policy lets a write name. Parsed once at startup, so a typo stops the process instead of
/// naming a key that does not exist on every write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanyKeyPrefix {
    arn: String,
    region: String,
}

impl CompanyKeyPrefix {
    pub fn parse(raw: &str) -> Result<Self, ContextError> {
        let bad = || {
            ContextError::Config(format!(
                "{PREFIX_VAR} is not arn:aws:kms:<region>:<account>:alias/oryxa-fde-<env>/companies/"
            ))
        };
        let parts: Vec<&str> = raw.splitn(6, ':').collect();
        let [arn, partition, service, region, account, resource] = parts[..] else {
            return Err(bad());
        };
        let env = resource
            .strip_prefix("alias/oryxa-fde-")
            .and_then(|r| r.strip_suffix("/companies/"))
            .ok_or_else(bad)?;
        let word = |s: &str| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !s.starts_with('-')
                && !s.ends_with('-')
        };
        let ok = arn == "arn"
            && matches!(partition, "aws" | "aws-cn" | "aws-us-gov")
            && service == "kms"
            && word(region)
            && account.len() == 12
            && account.bytes().all(|b| b.is_ascii_digit())
            && word(env);
        if !ok {
            return Err(bad());
        }
        Ok(Self {
            arn: raw.to_owned(),
            region: region.to_owned(),
        })
    }

    pub fn region(&self) -> &str {
        &self.region
    }

    /// The alias ARN of the company's key. The company is a validated id (`[A-Za-z0-9_-]`), so the
    /// alias cannot leave the companies' namespace.
    pub fn alias(&self, s: &CompanyScope) -> String {
        format!("{}{}", self.arn, s.company)
    }
}

/// The prefix from its config value, if set: checked against the Region the AWS clients use, since
/// KMS answers for an alias only in its own Region.
pub fn prefix_from(raw: Option<&str>, region: Option<&str>) -> Result<Option<CompanyKeyPrefix>, ContextError> {
    let Some(raw) = raw else { return Ok(None) };
    let prefix = CompanyKeyPrefix::parse(raw)?;
    if region != Some(prefix.region()) {
        return Err(ContextError::Config(format!(
            "{PREFIX_VAR} names Region {}, but AWS_REGION is {}",
            prefix.region(),
            region.unwrap_or("not set")
        )));
    }
    Ok(Some(prefix))
}

/// Whether a company has its own key. ADR 0006's generic inbound routes and any route that stores
/// customer content ask this first; the web reads it at `GET /v1/companies/{company}/key`.
pub trait CompanyKeys: Send + Sync + 'static {
    /// True only when the company's key exists, is enabled and encrypts. Every doubt is false.
    fn has_key<'a>(&'a self, s: &'a CompanyScope) -> BoxFuture<'a, bool>;
}

/// Company keys not configured: no company has one, and files are under the environment key.
pub struct NoCompanyKeys;

impl CompanyKeys for NoCompanyKeys {
    fn has_key<'a>(&'a self, _: &'a CompanyScope) -> BoxFuture<'a, bool> {
        Box::pin(async { false })
    }
}

/// In memory, for tests: the companies given a key.
#[derive(Default)]
pub struct FakeCompanyKeys(Mutex<HashSet<CompanyScope>>);

impl FakeCompanyKeys {
    pub fn give(&self, s: &CompanyScope) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(s.clone());
    }

    pub fn take(&self, s: &CompanyScope) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(s);
    }
}

impl CompanyKeys for FakeCompanyKeys {
    fn has_key<'a>(&'a self, s: &'a CompanyScope) -> BoxFuture<'a, bool> {
        Box::pin(async move { self.0.lock().unwrap_or_else(|e| e.into_inner()).contains(s) })
    }
}

/// Answers, per company, until they expire. Keyed by the whole scope, so one company's answer is
/// never another's.
#[derive(Default)]
struct Answers(Mutex<HashMap<CompanyScope, (bool, Instant)>>);

impl Answers {
    fn get(&self, s: &CompanyScope, now: Instant) -> Option<bool> {
        let map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        map.get(s).filter(|(_, until)| now < *until).map(|(yes, _)| *yes)
    }

    fn put(&self, s: &CompanyScope, yes: bool, now: Instant) {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= MAX_CACHED {
            map.retain(|_, (_, until)| now < *until);
            if map.len() >= MAX_CACHED {
                map.clear();
            }
        }
        map.insert(s.clone(), (yes, now + if yes { YES_FOR } else { NO_FOR }));
    }
}

/// From KMS: `DescribeKey` on the company's alias, which each key's policy lets the API's role call.
pub struct KmsCompanyKeys {
    kms: aws_sdk_kms::Client,
    prefix: CompanyKeyPrefix,
    answers: Answers,
}

impl KmsCompanyKeys {
    pub fn new(kms: aws_sdk_kms::Client, prefix: CompanyKeyPrefix) -> Self {
        Self {
            kms,
            prefix,
            answers: Answers::default(),
        }
    }

    async fn describe(&self, s: &CompanyScope) -> bool {
        let call = self.kms.describe_key().key_id(self.prefix.alias(s)).send();
        match tokio::time::timeout(DESCRIBE_TIMEOUT, call).await {
            Ok(Ok(out)) => out.key_metadata().is_some_and(|m| {
                m.key_state() == Some(&KeyState::Enabled) && m.key_usage() == Some(&KeyUsageType::EncryptDecrypt)
            }),
            // The usual answer for a company not provisioned yet.
            Ok(Err(e)) if e.code() == Some("NotFoundException") => false,
            Ok(Err(e)) => {
                tracing::warn!(tenant = %s.tenant, company = %s.company, code = ?e.code(), "company key check failed; no key");
                false
            }
            Err(_) => {
                tracing::warn!(tenant = %s.tenant, company = %s.company, "company key check timed out; no key");
                false
            }
        }
    }
}

impl CompanyKeys for KmsCompanyKeys {
    fn has_key<'a>(&'a self, s: &'a CompanyScope) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            if let Some(yes) = self.answers.get(s, Instant::now()) {
                return yes;
            }
            let yes = self.describe(s).await;
            self.answers.put(s, yes, Instant::now());
            yes
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use aws_smithy_types::body::SdkBody;
    use oryxa_core::TenantId;
    use oryxa_fde_core::CompanyId;

    use super::*;

    const PREFIX: &str = "arn:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/companies/";

    fn scope(tenant: &str, company: &str) -> CompanyScope {
        CompanyScope::new(TenantId::new(tenant).unwrap(), CompanyId::new(company).unwrap())
    }

    #[test]
    fn the_prefix_takes_only_the_alias_namespace_infra_makes() {
        let p = CompanyKeyPrefix::parse(PREFIX).unwrap();
        assert_eq!(p.region(), "eu-west-2");
        assert_eq!(
            p.alias(&scope("org_1", "cmp_1")),
            "arn:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/companies/cmp_1"
        );
        for bad in [
            "",
            "arn:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/companies",
            "arn:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/",
            "arn:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/companies/cmp_1",
            "arn:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-/companies/",
            "arn:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/x/companies/",
            "arn:aws:kms:eu-west-2:123456789012:key/oryxa-fde-dev/companies/",
            "arn:aws:kms:eu-west-2:12345678901:alias/oryxa-fde-dev/companies/",
            "arn:aws:kms:eu-west-2:12345678901a:alias/oryxa-fde-dev/companies/",
            "arn:aws:kms::123456789012:alias/oryxa-fde-dev/companies/",
            "arn:aws:s3:eu-west-2:123456789012:alias/oryxa-fde-dev/companies/",
            "arn:evil:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/companies/",
            "ARN:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/companies/",
            "arn:aws:kms:EU-west-2:123456789012:alias/oryxa-fde-dev/companies/",
            " arn:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/companies/",
            "arn:aws:kms:eu-west-2:123456789012:alias/oryxa-fde-dev/companies/ ",
            "alias/oryxa-fde-dev/companies/",
        ] {
            assert!(CompanyKeyPrefix::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn startup_takes_no_prefix_or_a_valid_one_in_the_clients_region() {
        assert_eq!(prefix_from(None, Some("eu-west-2")).unwrap(), None);
        assert!(prefix_from(Some(PREFIX), Some("eu-west-2")).unwrap().is_some());
        assert!(
            prefix_from(Some(""), Some("eu-west-2")).is_err(),
            "set but empty stops startup"
        );
        assert!(prefix_from(Some("alias/x"), Some("eu-west-2")).is_err());
        assert!(prefix_from(Some(PREFIX), Some("ap-south-1")).is_err());
        assert!(prefix_from(Some(PREFIX), None).is_err());
    }

    #[test]
    fn answers_expire_and_are_kept_per_company() {
        let answers = Answers::default();
        let (a, b, a_elsewhere) = (
            scope("org_1", "cmp_a"),
            scope("org_1", "cmp_b"),
            scope("org_2", "cmp_a"),
        );
        let t = Instant::now();
        answers.put(&a, true, t);
        assert_eq!(answers.get(&a, t + YES_FOR - Duration::from_millis(1)), Some(true));
        assert_eq!(answers.get(&a, t + YES_FOR), None, "a yes lasts at most a minute");
        assert_eq!(answers.get(&b, t), None, "another company's answer is not this one's");
        assert_eq!(answers.get(&a_elsewhere, t), None, "nor the same id in another tenant");
        answers.put(&b, false, t);
        assert_eq!(answers.get(&b, t + NO_FOR - Duration::from_millis(1)), Some(false));
        assert_eq!(answers.get(&b, t + NO_FOR), None, "a no lasts a few seconds");
    }

    #[test]
    fn the_cache_stays_bounded() {
        let answers = Answers::default();
        let t = Instant::now();
        for i in 0..MAX_CACHED + 5 {
            answers.put(&scope("org_1", &format!("cmp_{i}")), true, t);
        }
        assert!(answers.0.lock().unwrap().len() <= MAX_CACHED);
    }

    /// A KMS client answering every call with `status` and `body`; counts calls and keeps the
    /// key ids asked for.
    fn kms(status: u16, body: &'static str) -> (aws_sdk_kms::Client, Arc<AtomicUsize>, Arc<Mutex<Vec<String>>>) {
        use aws_sdk_kms::config::{BehaviorVersion, Credentials, Region, retry::RetryConfig};
        let (calls, asked) = (Arc::new(AtomicUsize::new(0)), Arc::new(Mutex::new(Vec::new())));
        let (c, k) = (calls.clone(), asked.clone());
        let http = aws_smithy_http_client::test_util::infallible_client_fn(move |req: http::Request<SdkBody>| {
            c.fetch_add(1, Ordering::SeqCst);
            let sent: serde_json::Value = serde_json::from_slice(req.body().bytes().unwrap_or_default()).unwrap();
            k.lock()
                .unwrap()
                .push(sent["KeyId"].as_str().unwrap_or_default().to_owned());
            http::Response::builder()
                .status(status)
                .header("content-type", "application/x-amz-json-1.1")
                .body(SdkBody::from(body))
                .unwrap()
        });
        let conf = aws_sdk_kms::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("eu-west-2"))
            .credentials_provider(Credentials::new("AKIDTEST", "secret", None, None, "test"))
            .retry_config(RetryConfig::disabled())
            .http_client(http)
            .build();
        (aws_sdk_kms::Client::from_conf(conf), calls, asked)
    }

    fn keys(client: aws_sdk_kms::Client) -> KmsCompanyKeys {
        KmsCompanyKeys::new(client, CompanyKeyPrefix::parse(PREFIX).unwrap())
    }

    const ENABLED: &str =
        r#"{"KeyMetadata":{"KeyId":"k-1","KeyState":"Enabled","KeyUsage":"ENCRYPT_DECRYPT","Enabled":true}}"#;

    #[tokio::test]
    async fn an_enabled_key_is_a_yes_asked_once_a_minute_and_per_company() {
        let (client, calls, asked) = kms(200, ENABLED);
        let keys = keys(client);
        let (a, b) = (scope("org_1", "cmp_a"), scope("org_1", "cmp_b"));
        assert!(keys.has_key(&a).await);
        assert!(keys.has_key(&a).await);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "the second answer is cached");
        assert!(keys.has_key(&b).await);
        assert_eq!(calls.load(Ordering::SeqCst), 2, "another company is asked for itself");
        assert_eq!(
            *asked.lock().unwrap(),
            [format!("{PREFIX}cmp_a"), format!("{PREFIX}cmp_b")],
            "each check names its own company's alias"
        );
    }

    #[tokio::test]
    async fn every_other_answer_is_no() {
        for (status, body) in [
            (400, r#"{"__type":"NotFoundException","message":"alias not found"}"#),
            (400, r#"{"__type":"AccessDeniedException","message":"no"}"#),
            (400, r#"{"__type":"ThrottlingException","message":"slow down"}"#),
            (500, r#"{"__type":"KMSInternalException","message":"oops"}"#),
            (
                200,
                r#"{"KeyMetadata":{"KeyId":"k-1","KeyState":"Disabled","KeyUsage":"ENCRYPT_DECRYPT"}}"#,
            ),
            (
                200,
                r#"{"KeyMetadata":{"KeyId":"k-1","KeyState":"PendingDeletion","KeyUsage":"ENCRYPT_DECRYPT"}}"#,
            ),
            (
                200,
                r#"{"KeyMetadata":{"KeyId":"k-1","KeyState":"Enabled","KeyUsage":"SIGN_VERIFY"}}"#,
            ),
            (200, r#"{"KeyMetadata":{"KeyId":"k-1"}}"#),
            (200, r#"{}"#),
            (200, r#"not json"#),
        ] {
            let (client, calls, _) = kms(status, body);
            let keys = keys(client);
            let s = scope("org_1", "cmp_a");
            assert!(!keys.has_key(&s).await, "{status} {body}");
            let asked = calls.load(Ordering::SeqCst);
            assert!(!keys.has_key(&s).await);
            assert_eq!(calls.load(Ordering::SeqCst), asked, "a no is cached too: {body}");
        }
    }

    #[tokio::test]
    async fn the_fakes_answer_as_told() {
        let s = scope("org_1", "cmp_a");
        assert!(!NoCompanyKeys.has_key(&s).await);
        let fake = FakeCompanyKeys::default();
        assert!(!fake.has_key(&s).await);
        fake.give(&s);
        assert!(fake.has_key(&s).await);
        assert!(!fake.has_key(&scope("org_2", "cmp_a")).await);
        fake.take(&s);
        assert!(!fake.has_key(&s).await);
    }
}
