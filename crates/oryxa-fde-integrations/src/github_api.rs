//! Calls to GitHub as our GitHub App. Three questions are asked, each needed before the database
//! changes:
//! - which installations a user who just installed the App can reach, through their one-time OAuth
//!   code; the user token is used once here and dropped;
//! - which repositories an installation holds, through one installation token for every page;
//! - whether an installation is still active, through an App JWT.
//!
//! The App JWT is RS256, signed with `aws-lc-rs` (constant time) and never with the `rsa` crate,
//! which `deny.toml` admits only for public-key use (RUSTSEC-2023-0071).

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;

use aws_lc_rs::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde_json::json;
use time::OffsetDateTime;

use crate::outbound::{Outbound, OutboundError};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Most pages of a user's installations read (100 each).
const MAX_PAGES: u32 = 10;
/// Most pages of an installation's repositories read (100 each).
// ponytail: past 3,000 repositories in one installation, the rest cannot be linked, and a removal
// of one of them unlinks it (the safe way round).
const MAX_REPOSITORY_PAGES: u32 = 30;

#[derive(Debug, thiserror::Error)]
pub enum GitHubError {
    #[error("GitHub refused the code or credentials")]
    Refused,
    #[error("GitHub answered {0}")]
    Status(u16),
    #[error("unreadable answer from GitHub")]
    Unreadable,
    #[error("{0}")]
    Outbound(#[from] OutboundError),
    #[error("the App key cannot sign")]
    Key,
}

impl From<reqwest::Error> for GitHubError {
    fn from(e: reqwest::Error) -> Self {
        GitHubError::Outbound(OutboundError::Http(e))
    }
}

/// What the service asks GitHub. A trait so tests use a fake.
pub trait GitHub: Send + Sync + 'static {
    /// Where an admin installs the App, carrying the signed install state.
    fn install_url(&self, state: &str) -> String;
    /// The installations the user behind a one-time OAuth `code` can reach.
    fn user_installations<'a>(&'a self, code: &'a str) -> BoxFuture<'a, Result<Vec<u64>, GitHubError>>;
    /// The repositories in the installation, by id, with their `owner/name`. This is membership:
    /// `GET /repositories/{id}` answers for any public repository, in the installation or not.
    fn installation_repositories<'a>(
        &'a self,
        installation: u64,
    ) -> BoxFuture<'a, Result<HashMap<u64, String>, GitHubError>>;
    /// Whether the installation still exists and is not suspended.
    fn installation_active<'a>(&'a self, installation: u64) -> BoxFuture<'a, Result<bool, GitHubError>>;
}

/// Adds one page of `GET /installation/repositories` to `into`; whether it was the last.
fn add_repositories(into: &mut HashMap<u64, String>, page: &[u8]) -> Result<bool, GitHubError> {
    #[derive(Deserialize)]
    struct Page {
        total_count: u64,
        repositories: Vec<Repo>,
    }
    #[derive(Deserialize)]
    struct Repo {
        id: u64,
        full_name: String,
    }
    let p: Page = serde_json::from_slice(page).map_err(|_| GitHubError::Unreadable)?;
    let last = p.repositories.len() < 100;
    into.extend(p.repositories.into_iter().map(|r| (r.id, r.full_name)));
    Ok(last || into.len() as u64 >= p.total_count)
}

/// Our GitHub App, from config.
pub struct GitHubApp {
    app_id: u64,
    slug: String,
    key: RsaKeyPair,
    client_id: String,
    client_secret: String,
    http: Outbound,
}

impl fmt::Debug for GitHubApp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GitHubApp")
            .field("app_id", &self.app_id)
            .field("slug", &self.slug)
            .finish_non_exhaustive()
    }
}

/// The DER inside a PEM block, PKCS#1 (`RSA PRIVATE KEY`, as GitHub issues it) or PKCS#8.
fn private_key(pem: &str) -> Option<RsaKeyPair> {
    let pkcs1 = pem.contains("BEGIN RSA PRIVATE KEY");
    let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).map(str::trim).collect();
    let der = STANDARD.decode(b64).ok()?;
    if pkcs1 {
        RsaKeyPair::from_der(&der).ok()
    } else {
        RsaKeyPair::from_pkcs8(&der).ok()
    }
}

impl GitHubApp {
    /// `None` if the slug is not a GitHub App slug or the key is not an RSA private key.
    pub fn new(
        app_id: u64,
        slug: &str,
        private_key_pem: &str,
        client_id: &str,
        client_secret: &str,
        http: Outbound,
    ) -> Option<Self> {
        let slug_ok = (1..=100).contains(&slug.len()) && slug.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !slug_ok || client_id.is_empty() || client_secret.is_empty() {
            return None;
        }
        Some(Self {
            app_id,
            slug: slug.to_owned(),
            key: private_key(private_key_pem)?,
            client_id: client_id.to_owned(),
            client_secret: client_secret.to_owned(),
            http,
        })
    }

    /// A JWT that authenticates as the App for nine minutes (GitHub allows ten), issued a minute
    /// early against clock drift.
    pub fn jwt(&self, now: OffsetDateTime) -> Result<String, GitHubError> {
        let iat = now.unix_timestamp() - 60;
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let claims =
            URL_SAFE_NO_PAD.encode(json!({"iat": iat, "exp": iat + 600, "iss": self.app_id.to_string()}).to_string());
        let signing_input = format!("{header}.{claims}");
        let mut sig = vec![0u8; self.key.public_modulus_len()];
        self.key
            .sign(
                &RSA_PKCS1_SHA256,
                &aws_lc_rs::rand::SystemRandom::new(),
                signing_input.as_bytes(),
                &mut sig,
            )
            .map_err(|_| GitHubError::Key)?;
        Ok(format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(sig)))
    }

    fn api(&self, method: Method, path: &str) -> Result<reqwest::RequestBuilder, GitHubError> {
        Ok(self
            .http
            .request(method, &format!("https://api.github.com{path}"))?
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28"))
    }

    async fn installation_token(&self, installation: u64) -> Result<String, GitHubError> {
        #[derive(Deserialize)]
        struct Token {
            token: String,
        }
        let resp = self
            .api(
                Method::POST,
                &format!("/app/installations/{installation}/access_tokens"),
            )?
            .bearer_auth(self.jwt(OffsetDateTime::now_utc())?)
            .send()
            .await?;
        match resp.status() {
            StatusCode::CREATED => Ok(resp.json::<Token>().await.map_err(|_| GitHubError::Unreadable)?.token),
            StatusCode::NOT_FOUND | StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED => Err(GitHubError::Refused),
            s => Err(GitHubError::Status(s.as_u16())),
        }
    }
}

impl GitHub for GitHubApp {
    fn install_url(&self, state: &str) -> String {
        format!("https://github.com/apps/{}/installations/new?state={state}", self.slug)
    }

    fn user_installations<'a>(&'a self, code: &'a str) -> BoxFuture<'a, Result<Vec<u64>, GitHubError>> {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Exchanged {
                access_token: Option<String>,
            }
            let exchanged: Exchanged = self
                .http
                .request(Method::POST, "https://github.com/login/oauth/access_token")?
                .header("Accept", "application/json")
                .form(&[
                    ("client_id", self.client_id.as_str()),
                    ("client_secret", self.client_secret.as_str()),
                    ("code", code),
                ])
                .send()
                .await?
                .json()
                .await
                .map_err(|_| GitHubError::Unreadable)?;
            // A bad or spent code answers 200 with an `error` and no token.
            let token = exchanged.access_token.ok_or(GitHubError::Refused)?;
            #[derive(Deserialize)]
            struct Page {
                installations: Vec<Installation>,
            }
            #[derive(Deserialize)]
            struct Installation {
                id: u64,
            }
            let mut ids = Vec::new();
            for page in 1..=MAX_PAGES {
                let resp = self
                    .api(Method::GET, &format!("/user/installations?per_page=100&page={page}"))?
                    .bearer_auth(&token)
                    .send()
                    .await?;
                if resp.status() == StatusCode::UNAUTHORIZED {
                    return Err(GitHubError::Refused);
                }
                if !resp.status().is_success() {
                    return Err(GitHubError::Status(resp.status().as_u16()));
                }
                let p: Page = resp.json().await.map_err(|_| GitHubError::Unreadable)?;
                let last = p.installations.len() < 100;
                ids.extend(p.installations.into_iter().map(|i| i.id));
                if last {
                    break;
                }
            }
            Ok(ids)
        })
    }

    fn installation_repositories<'a>(
        &'a self,
        installation: u64,
    ) -> BoxFuture<'a, Result<HashMap<u64, String>, GitHubError>> {
        Box::pin(async move {
            // One token for every page.
            let token = self.installation_token(installation).await?;
            let mut repositories = HashMap::new();
            for page in 1..=MAX_REPOSITORY_PAGES {
                let resp = self
                    .api(
                        Method::GET,
                        &format!("/installation/repositories?per_page=100&page={page}"),
                    )?
                    .bearer_auth(&token)
                    .send()
                    .await?;
                if !resp.status().is_success() {
                    return Err(GitHubError::Status(resp.status().as_u16()));
                }
                if add_repositories(&mut repositories, &resp.bytes().await?)? {
                    break;
                }
            }
            Ok(repositories)
        })
    }

    fn installation_active<'a>(&'a self, installation: u64) -> BoxFuture<'a, Result<bool, GitHubError>> {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Installation {
                suspended_at: Option<String>,
            }
            let resp = self
                .api(Method::GET, &format!("/app/installations/{installation}"))?
                .bearer_auth(self.jwt(OffsetDateTime::now_utc())?)
                .send()
                .await?;
            match resp.status() {
                StatusCode::OK => Ok(resp
                    .json::<Installation>()
                    .await
                    .map_err(|_| GitHubError::Unreadable)?
                    .suspended_at
                    .is_none()),
                StatusCode::NOT_FOUND => Ok(false),
                s => Err(GitHubError::Status(s.as_u16())),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use aws_lc_rs::encoding::AsDer;
    use aws_lc_rs::rsa::KeySize;
    use aws_lc_rs::signature::{KeyPair, RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey};
    use time::macros::datetime;

    use super::*;

    fn pem(der: &[u8]) -> String {
        let b64 = STANDARD.encode(der);
        let body: Vec<String> = b64
            .as_bytes()
            .chunks(64)
            .map(|c| String::from_utf8(c.to_vec()).unwrap())
            .collect();
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            body.join("\n")
        )
    }

    #[test]
    fn the_app_jwt_is_rs256_by_the_app_key_for_nine_minutes() {
        let key = RsaKeyPair::generate(KeySize::Rsa2048).unwrap();
        let public = key.public_key().as_ref().to_vec();
        let der = AsDer::<aws_lc_rs::encoding::Pkcs8V1Der>::as_der(&key).unwrap();
        let app = GitHubApp::new(
            42,
            "oryxa-fde",
            &pem(der.as_ref()),
            "Iv1.abc",
            "secret",
            Outbound::new().unwrap(),
        )
        .unwrap();
        let now = datetime!(2026-11-05 18:00 UTC);
        let jwt = app.jwt(now).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(header, json!({"alg": "RS256", "typ": "JWT"}));
        let iat = now.unix_timestamp() - 60;
        assert_eq!(claims, json!({"iat": iat, "exp": iat + 600, "iss": "42"}));
        let sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        let signed = format!("{}.{}", parts[0], parts[1]);
        UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, &public)
            .verify(signed.as_bytes(), &sig)
            .unwrap();
        assert_eq!(
            app.install_url("st"),
            "https://github.com/apps/oryxa-fde/installations/new?state=st"
        );
        assert!(!format!("{app:?}").contains("secret"));

        for (slug, key) in [
            ("bad slug", pem(der.as_ref())),
            (
                "oryxa-fde",
                "-----BEGIN PRIVATE KEY-----\nnotbase64!\n-----END PRIVATE KEY-----".into(),
            ),
            ("oryxa-fde", pem(b"not a key")),
        ] {
            assert!(GitHubApp::new(42, slug, &key, "Iv1.abc", "s", Outbound::new().unwrap()).is_none());
        }
    }

    #[test]
    fn an_installations_repositories_are_read_page_by_page() {
        let page = |from: u64, n: u64, total: u64| {
            let repos: Vec<_> = (from..from + n)
                .map(|id| json!({"id": id, "full_name": format!("acme/r{id}"), "private": false}))
                .collect();
            serde_json::to_vec(&json!({"total_count": total, "repositories": repos})).unwrap()
        };
        let mut got = HashMap::new();
        assert!(!add_repositories(&mut got, &page(1, 100, 150)).unwrap(), "more to come");
        assert!(add_repositories(&mut got, &page(101, 50, 150)).unwrap());
        assert_eq!((got.len(), got.get(&150).map(String::as_str)), (150, Some("acme/r150")));
        // A full last page ends on the count, not on one more empty page.
        let mut exact = HashMap::new();
        assert!(add_repositories(&mut exact, &page(1, 100, 100)).unwrap());
        for bad in [
            &b"{}"[..],
            br#"{"total_count":1,"repositories":[{"id":"1"}]}"#,
            b"not json",
        ] {
            assert!(matches!(
                add_repositories(&mut HashMap::new(), bad),
                Err(GitHubError::Unreadable)
            ));
        }
    }
}
