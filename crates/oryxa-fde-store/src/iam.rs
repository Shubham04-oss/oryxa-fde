//! RDS IAM database authentication: the task role signs a token that the login presents as its
//! password, over TLS (`verify-full`) against the RDS global CA bundle, which is vendored here and
//! checked against its pinned SHA-256. A token lasts 15 minutes and is checked only when a
//! connection opens, so the pool gets a fresh one every [`REFRESH_EVERY`] for the connections it
//! opens next. Startup fails if no token can be had; nothing falls back to a password or to an
//! unverified connection.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use aws_credential_types::provider::{ProvideCredentials, SharedCredentialsProvider};
use aws_sigv4::http_request::{SignableBody, SignableRequest, SignatureLocation, SigningSettings, sign};
use aws_sigv4::sign::v4;
use sha2::{Digest, Sha256};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};

use crate::{Store, StoreError, migrate_with};

/// How long a token is valid (RDS allows at most 15 minutes).
pub const TOKEN_TTL: Duration = Duration::from_secs(15 * 60);
/// How often the pool gets a new token: well before the last one expires.
pub const REFRESH_EVERY: Duration = Duration::from_secs(10 * 60);
/// How soon to try again after a refresh failed.
const RETRY_AFTER: Duration = Duration::from_secs(30);

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Where tokens come from: RDS signing in production, a fake in tests.
pub trait TokenSource: Send + Sync + 'static {
    fn token(&self) -> BoxFuture<'_, Result<String, StoreError>>;
}

/// The RDS global CA bundle (<https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem>),
/// 114 Amazon RDS root and intermediate CAs.
const RDS_CA_BUNDLE: &[u8] = include_bytes!("../certs/rds-global-bundle.crt");
/// Its SHA-256: a changed file is refused at startup, and by a test before it gets there.
const RDS_CA_BUNDLE_SHA256: &str = "90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b";

/// The vendored bundle, if it is the one pinned.
fn rds_ca_bundle() -> Result<&'static [u8], StoreError> {
    let digest: String = Sha256::digest(RDS_CA_BUNDLE)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if digest == RDS_CA_BUNDLE_SHA256 {
        Ok(RDS_CA_BUNDLE)
    } else {
        Err(StoreError::Config(
            "the vendored RDS CA bundle does not match its pin".into(),
        ))
    }
}

/// How the connection is protected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tls {
    /// `verify-full` against the RDS CA bundle: the only choice outside tests.
    // ponytail: sqlx adds the bundle to webpki's public roots rather than replacing them, so a
    // publicly trusted certificate for the RDS host name would also be accepted.
    Rds,
    /// No TLS, against the local test server only.
    #[cfg(test)]
    Off,
}

/// The database to reach with IAM tokens: `DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_USER`.
#[derive(Debug, Clone)]
pub struct IamConfig {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub tls: Tls,
}

impl IamConfig {
    /// `None` when none of the variables is set (local runs use a URL instead); an error when only
    /// some are, the port is not a number, or the vendored CA bundle is not the pinned one.
    pub fn from_env() -> Result<Option<Self>, StoreError> {
        let vars = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER"];
        let got: Vec<Option<String>> = vars.iter().map(|v| std::env::var(v).ok()).collect();
        if got.iter().all(Option::is_none) {
            return Ok(None);
        }
        let [Some(host), Some(port), Some(database), Some(user)] =
            <[Option<String>; 4]>::try_from(got).map_err(|_| StoreError::Config("DB_* variables".into()))?
        else {
            return Err(StoreError::Config(format!("set all of {} or none", vars.join(", "))));
        };
        rds_ca_bundle()?;
        Ok(Some(Self {
            host,
            port: port.parse().map_err(|_| StoreError::Config("DB_PORT".into()))?,
            database,
            user,
            tls: Tls::Rds,
        }))
    }

    /// Connect options that present `token` as the password, verifying the server's certificate
    /// and host name against the RDS CA bundle.
    pub fn options(&self, token: &str) -> Result<PgConnectOptions, StoreError> {
        let o = PgConnectOptions::new()
            .host(&self.host)
            .port(self.port)
            .database(&self.database)
            .username(&self.user)
            .password(token);
        Ok(match self.tls {
            Tls::Rds => o
                .ssl_mode(PgSslMode::VerifyFull)
                .ssl_root_cert_from_pem(rds_ca_bundle()?.to_vec()),
            #[cfg(test)]
            Tls::Off => o.ssl_mode(PgSslMode::Disable),
        })
    }
}

/// Tokens signed by the task's AWS credentials for one login.
pub struct RdsIam {
    host: String,
    port: u16,
    user: String,
    region: String,
    credentials: SharedCredentialsProvider,
}

impl RdsIam {
    /// With the default AWS credentials and region (the ECS task role).
    pub async fn from_env(cfg: &IamConfig) -> Result<Self, StoreError> {
        let aws = aws_config::load_from_env().await;
        let region = aws
            .region()
            .ok_or_else(|| StoreError::Config("no AWS region".into()))?
            .to_string();
        let credentials = aws
            .credentials_provider()
            .ok_or_else(|| StoreError::Config("no AWS credentials".into()))?;
        Ok(Self::new(cfg, region, credentials))
    }

    pub fn new(cfg: &IamConfig, region: impl Into<String>, credentials: SharedCredentialsProvider) -> Self {
        Self {
            host: cfg.host.clone(),
            port: cfg.port,
            user: cfg.user.clone(),
            region: region.into(),
            credentials,
        }
    }

    /// The RDS auth token: a presigned `connect` URL for the login, without its scheme.
    fn sign_at(&self, credentials: aws_credential_types::Credentials, now: SystemTime) -> Result<String, StoreError> {
        let identity = credentials.into();
        let mut settings = SigningSettings::default();
        settings.signature_location = SignatureLocation::QueryParams;
        settings.expires_in = Some(TOKEN_TTL);
        let params = v4::SigningParams::builder()
            .identity(&identity)
            .region(&self.region)
            .name("rds-db")
            .time(now)
            .settings(settings)
            .build()
            .map_err(|e| StoreError::Config(e.to_string()))?
            .into();
        let url = format!(
            "https://{}:{}/?Action=connect&DBUser={}",
            self.host, self.port, self.user
        );
        let signable = SignableRequest::new("GET", &url, std::iter::empty(), SignableBody::Bytes(&[]))
            .map_err(|e| StoreError::Config(e.to_string()))?;
        let (instructions, _) = sign(signable, &params)
            .map_err(|e| StoreError::Config(e.to_string()))?
            .into_parts();
        let mut req = http::Request::builder()
            .uri(&url)
            .body(())
            .map_err(|e| StoreError::Config(e.to_string()))?;
        instructions.apply_to_request_http1x(&mut req);
        let signed = req.uri().to_string();
        Ok(signed.strip_prefix("https://").unwrap_or(&signed).to_owned())
    }
}

impl TokenSource for RdsIam {
    fn token(&self) -> BoxFuture<'_, Result<String, StoreError>> {
        Box::pin(async move {
            let credentials = self
                .credentials
                .provide_credentials()
                .await
                .map_err(|e| StoreError::Config(format!("AWS credentials: {e}")))?;
            self.sign_at(credentials, SystemTime::now())
        })
    }
}

impl Store {
    /// Connects as `cfg.user` with IAM tokens from `tokens`, and keeps the pool supplied with a
    /// fresh token every `every` for the connections it opens later.
    pub async fn connect_iam(
        cfg: IamConfig,
        tokens: Arc<dyn TokenSource>,
        every: Duration,
    ) -> Result<Self, StoreError> {
        let first = tokens.token().await?;
        let store = Self::connect_with(cfg.options(&first)?).await?;
        let pool = store.pool.clone();
        tokio::spawn(async move {
            let mut wait = every;
            loop {
                tokio::time::sleep(wait).await;
                if pool.is_closed() {
                    return;
                }
                match tokens.token().await.and_then(|t| cfg.options(&t)) {
                    Ok(options) => {
                        pool.set_connect_options(options);
                        wait = every;
                    }
                    Err(e) => {
                        // New connections fail once the last token expires: closed, never open.
                        tracing::error!(error = %e, "database token refresh failed");
                        wait = RETRY_AFTER.min(every);
                    }
                }
            }
        });
        Ok(store)
    }
}

/// Runs the migrations as `cfg.user` (the migrator) with one IAM token.
pub async fn migrate_iam(cfg: &IamConfig, tokens: &dyn TokenSource) -> Result<(), StoreError> {
    let token = tokens.token().await?;
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(cfg.options(&token)?)
        .await?;
    let result = migrate_with(&pool).await;
    pool.close().await;
    result
}

#[cfg(test)]
mod tests {
    use aws_credential_types::Credentials;

    use super::*;

    fn cfg() -> IamConfig {
        IamConfig {
            host: "fde.cluster-x.eu-west-2.rds.amazonaws.com".into(),
            port: 5432,
            database: "oryxa_fde".into(),
            user: "oryxa_fde_api".into(),
            tls: Tls::Rds,
        }
    }

    #[test]
    fn a_token_is_a_presigned_connect_url_for_the_login() {
        let creds = Credentials::new("AKIDEXAMPLE", "secret", Some("session".into()), None, "test");
        let iam = RdsIam::new(&cfg(), "eu-west-2", SharedCredentialsProvider::new(creds.clone()));
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(1_793_800_000);
        let token = iam.sign_at(creds.clone(), at).unwrap();
        assert!(
            token.starts_with("fde.cluster-x.eu-west-2.rds.amazonaws.com:5432/?Action=connect&DBUser=oryxa_fde_api&"),
            "{token}"
        );
        for part in [
            "X-Amz-Algorithm=AWS4-HMAC-SHA256",
            "X-Amz-Expires=900",
            "%2Feu-west-2%2Frds-db%2Faws4_request",
            "X-Amz-Security-Token=session",
            "X-Amz-Signature=",
        ] {
            assert!(token.contains(part), "{part} in {token}");
        }
        assert!(!token.starts_with("https://"));
        // Deterministic for a given time and key; a different key signs differently.
        assert_eq!(iam.sign_at(creds, at).unwrap(), token);
        let other = Credentials::new("AKIDEXAMPLE", "other", Some("session".into()), None, "test");
        assert_ne!(iam.sign_at(other, at).unwrap(), token);
    }

    #[test]
    fn a_token_matches_the_aws_sdk_rds_token_generator() {
        // From aws-sdk-rds 1.159's `auth_token::AuthTokenGenerator`, for the same login, key,
        // session token and time (2026-11-04T13:46:40Z).
        const SDK: &str = "fde.cluster-x.eu-west-2.rds.amazonaws.com:5432/?Action=connect&DBUser=oryxa_fde_api\
            &X-Amz-Algorithm=AWS4-HMAC-SHA256\
            &X-Amz-Credential=AKIDEXAMPLE%2F20261104%2Feu-west-2%2Frds-db%2Faws4_request\
            &X-Amz-Date=20261104T134640Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host\
            &X-Amz-Signature=883300b9ed2b4642a0831dec290100ba186af4f1cf40581f70a648304fd6e11d\
            &X-Amz-Security-Token=session";
        let creds = Credentials::new("AKIDEXAMPLE", "secret", Some("session".into()), None, "test");
        let iam = RdsIam::new(&cfg(), "eu-west-2", SharedCredentialsProvider::new(creds.clone()));
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(1_793_800_000);
        assert_eq!(iam.sign_at(creds, at).unwrap(), SDK);
    }

    #[test]
    fn connections_verify_the_server_against_the_ca_bundle() {
        let o = cfg().options("tok").unwrap();
        assert_eq!(o.get_host(), "fde.cluster-x.eu-west-2.rds.amazonaws.com");
        assert_eq!(
            (o.get_port(), o.get_username(), o.get_database()),
            (5432, "oryxa_fde_api", Some("oryxa_fde"))
        );
        assert!(matches!(o.get_ssl_mode(), PgSslMode::VerifyFull));
    }

    #[test]
    fn the_vendored_bundle_is_the_pinned_rds_bundle() {
        let bundle = rds_ca_bundle().unwrap();
        let pem = std::str::from_utf8(bundle).unwrap();
        assert_eq!(pem.matches("-----BEGIN CERTIFICATE-----").count(), 114);
        assert!(pem.starts_with("-----BEGIN CERTIFICATE-----"));
    }
}
