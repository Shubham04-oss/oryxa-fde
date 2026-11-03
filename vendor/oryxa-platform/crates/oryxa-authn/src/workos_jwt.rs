//! Verifies WorkOS AuthKit access tokens (RS256 JWTs) against the client's JWKS.
//! Only the gateway uses this; downstream services trust the internal token instead.

use std::sync::Arc;

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;
use workos::helpers::{JwkSet, JwksHelper};

#[derive(Debug, thiserror::Error)]
pub enum JwtError {
    #[error("malformed or unsigned token")]
    Malformed,
    #[error("algorithm must be RS256")]
    WrongAlgorithm,
    #[error("no matching signing key")]
    UnknownKey,
    #[error("token rejected: {0:?}")]
    Rejected(jsonwebtoken::errors::ErrorKind),
    #[error("could not load signing keys: {0}")]
    Keys(String),
}

/// Claims we rely on from an AuthKit access token.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SessionClaims {
    /// WorkOS user id.
    pub sub: String,
    /// Session id, used for revocation.
    pub sid: String,
    pub org_id: Option<String>,
    pub role: Option<String>,
    pub exp: u64,
}

/// Source of signing keys; `refresh` is called once when a `kid` is unknown (key rotation).
pub trait KeySource: Send + Sync {
    fn keys(&self) -> impl Future<Output = Result<Arc<JwkSet>, String>> + Send;
    fn refresh(&self) -> impl Future<Output = Result<Arc<JwkSet>, String>> + Send;
}

impl KeySource for JwksHelper {
    async fn keys(&self) -> Result<Arc<JwkSet>, String> {
        self.fetch().await.map_err(|e| e.to_string())
    }
    async fn refresh(&self) -> Result<Arc<JwkSet>, String> {
        JwksHelper::refresh(self).await.map_err(|e| e.to_string())
    }
}

pub struct AccessTokenVerifier<K> {
    keys: K,
    issuer: String,
}

impl<K: KeySource> AccessTokenVerifier<K> {
    /// `issuer` is `https://api.workos.com/` or the custom auth domain; it is pinned.
    pub fn new(keys: K, issuer: impl Into<String>) -> Self {
        Self {
            keys,
            issuer: issuer.into(),
        }
    }

    pub async fn verify(&self, token: &str) -> Result<SessionClaims, JwtError> {
        let header = decode_header(token).map_err(|_| JwtError::Malformed)?;
        if header.alg != Algorithm::RS256 {
            return Err(JwtError::WrongAlgorithm);
        }
        let kid = header.kid.ok_or(JwtError::Malformed)?;

        let set = self.keys.keys().await.map_err(JwtError::Keys)?;
        let key = match find_key(&set, &kid) {
            Some(k) => k,
            None => {
                let set = self.keys.refresh().await.map_err(JwtError::Keys)?;
                find_key(&set, &kid).ok_or(JwtError::UnknownKey)?
            }
        };

        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.issuer]);
        validation.set_required_spec_claims(&["exp", "iss", "sub"]);
        // AuthKit tokens carry no `aud`; the per-client JWKS pins the environment.
        validation.validate_aud = false;
        validation.leeway = 30;

        decode::<SessionClaims>(token, &key, &validation)
            .map(|d| d.claims)
            .map_err(|e| JwtError::Rejected(e.into_kind()))
    }
}

fn find_key(set: &JwkSet, kid: &str) -> Option<DecodingKey> {
    let jwk = set.keys.iter().find(|k| k.kid.as_deref() == Some(kid))?;
    if jwk.kty.as_deref() != Some("RSA") || jwk.alg.as_deref().is_some_and(|a| a != "RS256") {
        return None;
    }
    let n = jwk.other.get("n")?.as_str()?;
    let e = jwk.other.get("e")?.as_str()?;
    DecodingKey::from_rsa_components(n, e).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use jsonwebtoken::{EncodingKey, Header, encode};
    use rsa::pkcs1::EncodeRsaPrivateKey;
    use rsa::traits::PublicKeyParts;
    use serde_json::json;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    const ISS: &str = "https://api.workos.com/";

    struct TestKeys {
        current: Mutex<Arc<JwkSet>>,
        after_refresh: Arc<JwkSet>,
    }
    impl KeySource for TestKeys {
        async fn keys(&self) -> Result<Arc<JwkSet>, String> {
            Ok(self.current.lock().unwrap().clone())
        }
        async fn refresh(&self) -> Result<Arc<JwkSet>, String> {
            *self.current.lock().unwrap() = self.after_refresh.clone();
            Ok(self.after_refresh.clone())
        }
    }

    fn keypair(kid: &str) -> (EncodingKey, JwkSet) {
        let key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
        let pem = key.to_pkcs1_pem(Default::default()).unwrap();
        let jwk = json!({
            "kid": kid, "kty": "RSA", "alg": "RS256",
            "n": URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),
            "e": URL_SAFE_NO_PAD.encode(key.e().to_bytes_be()),
        });
        let set: JwkSet = serde_json::from_value(json!({ "keys": [jwk] })).unwrap();
        (EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap(), set)
    }

    fn now() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    fn token(enc: &EncodingKey, kid: &str, iss: &str, exp: u64) -> String {
        let mut h = Header::new(Algorithm::RS256);
        h.kid = Some(kid.into());
        let claims = json!({ "sub": "user_1", "sid": "session_1", "org_id": "org_1", "iss": iss, "exp": exp });
        encode(&h, &claims, enc).unwrap()
    }

    fn verifier(set: JwkSet, after: JwkSet) -> AccessTokenVerifier<TestKeys> {
        let keys = TestKeys {
            current: Mutex::new(Arc::new(set)),
            after_refresh: Arc::new(after),
        };
        AccessTokenVerifier::new(keys, ISS)
    }

    #[tokio::test]
    async fn accepts_valid_and_rejects_bad_tokens() {
        let (enc, set) = keypair("k1");
        let v = verifier(set.clone(), set);

        let claims = v.verify(&token(&enc, "k1", ISS, now() + 300)).await.unwrap();
        assert_eq!((claims.sub.as_str(), claims.sid.as_str()), ("user_1", "session_1"));

        assert!(matches!(
            v.verify(&token(&enc, "k1", ISS, now() - 600)).await,
            Err(JwtError::Rejected(_))
        ));
        assert!(matches!(
            v.verify(&token(&enc, "k1", "https://evil/", now() + 300)).await,
            Err(JwtError::Rejected(_))
        ));
        assert!(matches!(v.verify("not.a.jwt").await, Err(JwtError::Malformed)));

        let hs = encode(
            &Header::new(Algorithm::HS256),
            &json!({"sub":"x","iss":ISS,"exp":now()+300}),
            &EncodingKey::from_secret(b"s"),
        )
        .unwrap();
        assert!(matches!(v.verify(&hs).await, Err(JwtError::WrongAlgorithm)));
    }

    #[tokio::test]
    async fn refreshes_once_on_key_rotation() {
        let (_, old) = keypair("old");
        let (enc, new) = keypair("new");
        let v = verifier(old.clone(), new);
        assert!(v.verify(&token(&enc, "new", ISS, now() + 300)).await.is_ok());

        let (stranger, _) = keypair("stranger");
        let v = verifier(old.clone(), old);
        assert!(matches!(
            v.verify(&token(&stranger, "stranger", ISS, now() + 300)).await,
            Err(JwtError::UnknownKey)
        ));
    }
}
