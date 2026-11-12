//! Test WorkOS: one RSA key per test binary, a JWKS holding it, and AuthKit-shaped tokens.

#![allow(dead_code)] // each test binary uses a different part

use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use oryxa_authn::{AccessTokenVerifier, KeySource};
use rsa::pkcs1::EncodeRsaPrivateKey;
use rsa::traits::PublicKeyParts;
use serde_json::json;
use workos::helpers::JwkSet;

pub const ISS: &str = "https://api.workos.com/";
const KID: &str = "test-key";

struct Keys {
    encoding: EncodingKey,
    set: Arc<JwkSet>,
}

fn keys() -> &'static Keys {
    static KEYS: OnceLock<Keys> = OnceLock::new();
    KEYS.get_or_init(|| {
        let key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
        let pem = key.to_pkcs1_pem(Default::default()).unwrap();
        let jwk = json!({
            "kid": KID, "kty": "RSA", "alg": "RS256",
            "n": URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),
            "e": URL_SAFE_NO_PAD.encode(key.e().to_bytes_be()),
        });
        Keys {
            encoding: EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(),
            set: Arc::new(serde_json::from_value(json!({ "keys": [jwk] })).unwrap()),
        }
    })
}

pub struct TestKeys;

impl KeySource for TestKeys {
    async fn keys(&self) -> Result<Arc<JwkSet>, String> {
        Ok(keys().set.clone())
    }
    async fn refresh(&self) -> Result<Arc<JwkSet>, String> {
        Ok(keys().set.clone())
    }
}

pub fn verifier() -> AccessTokenVerifier<TestKeys> {
    AccessTokenVerifier::new(TestKeys, ISS)
}

/// An access token as AuthKit issues it. `org` is the WorkOS organization (the tenant).
pub fn token(org: Option<&str>, user: &str, role: &str) -> String {
    token_for(org, user, role, 300)
}

/// A token that expires `secs` from now (in the past when negative).
pub fn token_for(org: Option<&str>, user: &str, role: &str, secs: i64) -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
    let exp = (now + secs) as u64;
    let mut claims = json!({ "sub": user, "sid": "session_1", "role": role, "iss": ISS, "exp": exp });
    if let Some(org) = org {
        claims["org_id"] = json!(org);
    }
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(KID.into());
    encode(&header, &claims, &keys().encoding).unwrap()
}

/// AuthKit without WorkOS: checks the PKCE verifier against the challenge it was given, and signs
/// in whoever `who` names next.
#[derive(Default)]
pub struct FakeAuthKit {
    /// (organization, user, role) the next code exchange signs in.
    pub who: std::sync::Mutex<(Option<String>, String, String)>,
    /// The next refreshes fail for good (`invalid_grant`).
    pub refresh_fails: std::sync::atomic::AtomicBool,
    /// The next refreshes fail for now (WorkOS down), with a 300 ms `Retry-After`.
    pub refresh_unavailable: std::sync::atomic::AtomicBool,
    /// Refreshes asked for, whatever their outcome.
    pub refreshes: std::sync::atomic::AtomicUsize,
    /// The next revokes fail (WorkOS down).
    pub revoke_fails: std::sync::atomic::AtomicBool,
    pub revoked: std::sync::Mutex<Vec<String>>,
    /// Each organisation's people, as WorkOS lists its memberships.
    pub people: std::sync::Mutex<std::collections::HashMap<String, Vec<oryxa_fde_api::Person>>>,
    /// The next people lookups fail (WorkOS down).
    pub people_fail: std::sync::atomic::AtomicBool,
    /// People lookups asked for, whatever their outcome.
    pub people_lookups: std::sync::atomic::AtomicUsize,
    challenges: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// The client each password sign-in named to WorkOS.
    pub clients: std::sync::Mutex<Vec<oryxa_fde_api::Client>>,
    /// Addresses an account was created for.
    pub created: std::sync::Mutex<Vec<String>>,
}

type Fut<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

impl oryxa_fde_api::AuthKit for FakeAuthKit {
    fn authorization_url(&self, state: &str, code_challenge: &str, redirect_uri: &str) -> Result<String, String> {
        self.challenges
            .lock()
            .unwrap()
            .insert(state.to_owned(), code_challenge.to_owned());
        Ok(format!(
            "https://auth.fake/authorize?state={state}&redirect_uri={redirect_uri}"
        ))
    }

    fn exchange_code<'a>(
        &'a self,
        code: &'a str,
        code_verifier: &'a str,
    ) -> Fut<'a, Result<oryxa_fde_api::Tokens, String>> {
        Box::pin(async move {
            let state = code.strip_prefix("code-").ok_or("bad code")?;
            let challenge = self.challenges.lock().unwrap().remove(state).ok_or("unknown code")?;
            if workos::helpers::pkce::generate_code_challenge(code_verifier) != challenge {
                return Err("PKCE verifier does not match".into());
            }
            let (org, user, role) = self.who.lock().unwrap().clone();
            Ok(oryxa_fde_api::Tokens {
                access_token: token(org.as_deref(), &user, &role),
                refresh_token: format!("refresh|{}|{user}|{role}", org.unwrap_or_default()),
            })
        })
    }

    fn refresh<'a>(
        &'a self,
        refresh_token: &'a str,
        organisation: &'a str,
    ) -> Fut<'a, Result<oryxa_fde_api::Tokens, oryxa_fde_api::RefreshError>> {
        Box::pin(async move {
            use oryxa_fde_api::RefreshError;
            self.refreshes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.refresh_fails.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(RefreshError::Refused("invalid_grant".into()));
            }
            if self.refresh_unavailable.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(RefreshError::Unavailable {
                    why: "503 from WorkOS".into(),
                    retry_after: Some(std::time::Duration::from_millis(300)),
                });
            }
            let parts: Vec<&str> = refresh_token.split('|').collect();
            let [_, org, user, role] = parts[..] else {
                return Err(RefreshError::Refused("bad refresh token".into()));
            };
            assert_eq!(org, organisation, "refresh names the session's organisation");
            Ok(oryxa_fde_api::Tokens {
                access_token: token(Some(org), user, role),
                refresh_token: refresh_token.to_owned(),
            })
        })
    }

    fn revoke<'a>(&'a self, session_id: &'a str) -> Fut<'a, Result<(), String>> {
        Box::pin(async move {
            if self.revoke_fails.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("workos is down".into());
            }
            self.revoked.lock().unwrap().push(session_id.to_owned());
            Ok(())
        })
    }

    fn user_name<'a>(&'a self, user: &'a str) -> Fut<'a, Result<String, String>> {
        Box::pin(async move { Ok(format!("Name of {user}")) })
    }

    fn organisation_name<'a>(&'a self, organisation: &'a str) -> Fut<'a, Result<String, String>> {
        Box::pin(async move { Ok(format!("Org {organisation}")) })
    }

    fn people<'a>(&'a self, organisation: &'a str) -> Fut<'a, Result<Vec<oryxa_fde_api::Person>, String>> {
        Box::pin(async move {
            self.people_lookups.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.people_fail.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("workos is down".into());
            }
            Ok(self
                .people
                .lock()
                .unwrap()
                .get(organisation)
                .cloned()
                .unwrap_or_default())
        })
    }

    /// `right password` signs in whoever `who` names; anything else is refused.
    fn sign_in_with_password<'a>(
        &'a self,
        _: &'a str,
        password: &'a str,
        client: &'a oryxa_fde_api::Client,
    ) -> Fut<'a, oryxa_fde_api::Attempt> {
        Box::pin(async move {
            self.clients.lock().unwrap().push(client.clone());
            if password != "right password" {
                return oryxa_fde_api::Attempt::Refused;
            }
            let (org, user, role) = self.who.lock().unwrap().clone();
            oryxa_fde_api::Attempt::SignedIn(oryxa_fde_api::Tokens {
                access_token: token(org.as_deref(), &user, &role),
                refresh_token: format!("refresh|{}|{user}|{role}", org.unwrap_or_default()),
            })
        })
    }

    fn verify_email<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a oryxa_fde_api::Client,
    ) -> Fut<'a, oryxa_fde_api::Attempt> {
        Box::pin(async { oryxa_fde_api::Attempt::Refused })
    }

    fn choose_organisation<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a oryxa_fde_api::Client,
    ) -> Fut<'a, oryxa_fde_api::Attempt> {
        Box::pin(async { oryxa_fde_api::Attempt::Refused })
    }

    /// Sends nothing, and says so, whatever the address.
    fn send_code<'a>(&'a self, _: &'a str, client: &'a oryxa_fde_api::Client) -> Fut<'a, oryxa_fde_api::Sent> {
        Box::pin(async move {
            self.clients.lock().unwrap().push(client.clone());
            oryxa_fde_api::Sent::Sent
        })
    }

    /// `000000` signs in whoever `who` names; anything else is refused.
    fn sign_in_with_code<'a>(
        &'a self,
        _: &'a str,
        code: &'a str,
        client: &'a oryxa_fde_api::Client,
    ) -> Fut<'a, oryxa_fde_api::Attempt> {
        Box::pin(async move {
            self.clients.lock().unwrap().push(client.clone());
            if code != "000000" {
                return oryxa_fde_api::Attempt::Refused;
            }
            let (org, user, role) = self.who.lock().unwrap().clone();
            oryxa_fde_api::Attempt::SignedIn(oryxa_fde_api::Tokens {
                access_token: token(org.as_deref(), &user, &role),
                refresh_token: format!("refresh|{}|{user}|{role}", org.unwrap_or_default()),
            })
        })
    }

    fn resend_verification<'a>(&'a self, _: &'a str) -> Fut<'a, oryxa_fde_api::Sent> {
        Box::pin(async { oryxa_fde_api::Sent::Sent })
    }

    /// `invite-ok` is an open invitation for `invited@example.com`; any other token names none.
    fn invitation<'a>(&'a self, token: &'a str) -> Fut<'a, Result<Option<oryxa_fde_api::Invitation>, String>> {
        Box::pin(async move {
            Ok((token == "invite-ok").then(|| oryxa_fde_api::Invitation {
                email: "invited@example.com".into(),
                organisation: None,
                pending: true,
            }))
        })
    }

    fn has_account<'a>(&'a self, _: &'a str) -> Fut<'a, Result<bool, String>> {
        Box::pin(async { Ok(false) })
    }

    fn create_account<'a>(
        &'a self,
        email: &'a str,
        _: &'a str,
        _: (Option<&'a str>, Option<&'a str>),
        _: &'a oryxa_fde_api::Client,
    ) -> Fut<'a, oryxa_fde_api::Created> {
        Box::pin(async move {
            self.created.lock().unwrap().push(email.to_owned());
            oryxa_fde_api::Created::Created
        })
    }

    /// Signs in whoever `who` names, accepting the invitation.
    fn accept_with_password<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a str,
        _: &'a oryxa_fde_api::Client,
    ) -> Fut<'a, oryxa_fde_api::Attempt> {
        Box::pin(async move {
            let (org, user, role) = self.who.lock().unwrap().clone();
            oryxa_fde_api::Attempt::SignedIn(oryxa_fde_api::Tokens {
                access_token: token(org.as_deref(), &user, &role),
                refresh_token: format!("refresh|{}|{user}|{role}", org.unwrap_or_default()),
            })
        })
    }

    fn send_password_reset<'a>(&'a self, _: &'a str) -> Fut<'a, oryxa_fde_api::Sent> {
        Box::pin(async { oryxa_fde_api::Sent::Sent })
    }

    /// `reset-ok` resets; any other token is refused.
    fn reset_password<'a>(&'a self, token: &'a str, _: &'a str) -> Fut<'a, oryxa_fde_api::Reset> {
        Box::pin(async move {
            if token == "reset-ok" {
                oryxa_fde_api::Reset::Done
            } else {
                oryxa_fde_api::Reset::Refused("invalid_token".into())
            }
        })
    }
}
