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
    let exp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() + 300;
    let mut claims = json!({ "sub": user, "sid": "session_1", "role": role, "iss": ISS, "exp": exp });
    if let Some(org) = org {
        claims["org_id"] = json!(org);
    }
    let mut header = Header::new(Algorithm::RS256);
    header.kid = Some(KID.into());
    encode(&header, &claims, &keys().encoding).unwrap()
}
