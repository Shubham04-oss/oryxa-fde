//! Against the real WorkOS staging JWKS (needs WORKOS_API_KEY + WORKOS_CLIENT_ID):
//!   set -a; . ~/.config/oryxa/workos-staging.env; set +a; cargo test -p oryxa-authn -- --ignored
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use oryxa_authn::{AccessTokenVerifier, JwtError, KeySource};
use rsa::pkcs1::EncodeRsaPrivateKey;
use serde_json::json;
use workos::helpers::JwksHelper;

const ISS: &str = "https://api.workos.com/";

fn exp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 300
}

#[tokio::test]
#[ignore = "needs WorkOS staging credentials"]
async fn real_jwks_parse_and_forgeries_are_rejected() {
    let client = workos::Client::builder()
        .api_key(std::env::var("WORKOS_API_KEY").unwrap())
        .client_id(std::env::var("WORKOS_CLIENT_ID").unwrap())
        .build();
    let keys = JwksHelper::from_client(&client);
    let set = KeySource::keys(&keys).await.expect("staging JWKS reachable");
    let real_kid = set.keys[0].kid.clone().expect("kid");
    let verifier = AccessTokenVerifier::new(keys, ISS);

    // Forged with our own RSA key but claiming WorkOS's real kid: signature must fail.
    let attacker = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048).unwrap();
    let enc = EncodingKey::from_rsa_pem(attacker.to_pkcs1_pem(Default::default()).unwrap().as_bytes()).unwrap();
    let claims = json!({ "sub": "user_x", "sid": "session_x", "org_id": "org_x", "iss": ISS, "exp": exp() });
    let mut h = Header::new(Algorithm::RS256);
    h.kid = Some(real_kid.clone());
    let forged = encode(&h, &claims, &enc).unwrap();
    assert!(
        matches!(verifier.verify(&forged).await, Err(JwtError::Rejected(_))),
        "forged token with real kid"
    );

    // Unknown kid: refreshes once from WorkOS, still unknown.
    h.kid = Some("kid_does_not_exist".into());
    let unknown = encode(&h, &claims, &enc).unwrap();
    assert!(matches!(verifier.verify(&unknown).await, Err(JwtError::UnknownKey)));

    // Algorithm swap (HS256 with the public key as secret) is refused before any key lookup.
    let mut hs = Header::new(Algorithm::HS256);
    hs.kid = Some(real_kid);
    let swapped = encode(&hs, &claims, &EncodingKey::from_secret(b"public-key-as-secret")).unwrap();
    assert!(matches!(verifier.verify(&swapped).await, Err(JwtError::WrongAlgorithm)));
}
