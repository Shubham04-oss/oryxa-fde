//! Event signatures. The publisher signs `source`, `detail-type` and the canonical detail JSON
//! (keys sorted, `sig` excluded), so EventBridge reordering keys cannot break a signature.
//! Each key id is bound to one source: the gateway's key cannot sign identity events.
//! Consumers verify before handling and reject stale or future-dated signatures.

use std::collections::HashMap;
use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::pkcs8::{DecodePrivateKey, DecodePublicKey};
use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::Encoded;

const DOMAIN: &str = "oryxa-event-v1";
pub const MAX_AGE: Duration = Duration::from_secs(24 * 3600);
const MAX_SKEW: Duration = Duration::from_secs(300);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SignError {
    #[error("invalid key: {0}")]
    Key(String),
    #[error("detail is not a JSON object")]
    NotObject,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum VerifyError {
    #[error("unsigned event")]
    Unsigned,
    #[error("malformed signature")]
    Malformed,
    #[error("unknown key id {0}")]
    UnknownKey(String),
    #[error("key {kid} may not sign for source {claimed}")]
    WrongSource { kid: String, claimed: String },
    #[error("bad signature")]
    BadSignature,
    #[error("signature too old or from the future")]
    Stale,
}

fn message(source: &str, detail_type: &str, detail: &Value) -> Vec<u8> {
    format!(
        "{DOMAIN}\0{source}\0{detail_type}\0{}",
        oryxa_core::canonical_json(detail)
    )
    .into_bytes()
}

fn parse_object(detail: &str) -> Option<serde_json::Map<String, Value>> {
    match serde_json::from_str(detail).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

#[derive(Clone)]
pub struct Signer {
    kid: String,
    key: SigningKey,
}

impl Signer {
    /// `pem`: PKCS#8 Ed25519 private key (from Secrets Manager).
    // ponytail: in-process key. Move to KMS-held keys (sign via API) before external consumers exist.
    pub fn from_pkcs8_pem(kid: impl Into<String>, pem: &str) -> Result<Self, SignError> {
        let key = SigningKey::from_pkcs8_pem(pem).map_err(|e| SignError::Key(e.to_string()))?;
        Ok(Self { kid: kid.into(), key })
    }

    pub fn sign(&self, entry: &mut Encoded) -> Result<(), SignError> {
        self.sign_at(entry, OffsetDateTime::now_utc())
    }

    fn sign_at(&self, entry: &mut Encoded, now: OffsetDateTime) -> Result<(), SignError> {
        let mut detail = parse_object(&entry.detail).ok_or(SignError::NotObject)?;
        detail.remove("sig");
        detail.insert(
            "signed_at".into(),
            Value::String(now.format(&Rfc3339).unwrap_or_default()),
        );
        let detail = Value::Object(detail);
        let sig = self.key.sign(&message(&entry.source, &entry.detail_type, &detail));
        let mut detail = match detail {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        detail.insert(
            "sig".into(),
            Value::String(format!(
                "ed25519:{}:{}",
                self.kid,
                URL_SAFE_NO_PAD.encode(sig.to_bytes())
            )),
        );
        entry.detail = Value::Object(detail).to_string();
        Ok(())
    }
}

/// Trusted public keys, each bound to the one source it may sign for.
#[derive(Default)]
pub struct Verifier {
    keys: HashMap<String, (String, VerifyingKey)>,
}

impl Verifier {
    pub fn trust(
        mut self,
        kid: impl Into<String>,
        source: impl Into<String>,
        public_pem: &str,
    ) -> Result<Self, SignError> {
        let key = VerifyingKey::from_public_key_pem(public_pem).map_err(|e| SignError::Key(e.to_string()))?;
        self.keys.insert(kid.into(), (source.into(), key));
        Ok(self)
    }

    /// Returns the verified detail (with `sig` removed) for the handler to use.
    pub fn verify(&self, source: &str, detail_type: &str, detail: &str) -> Result<Value, VerifyError> {
        self.verify_at(source, detail_type, detail, OffsetDateTime::now_utc())
    }

    fn verify_at(
        &self,
        source: &str,
        detail_type: &str,
        detail: &str,
        now: OffsetDateTime,
    ) -> Result<Value, VerifyError> {
        let mut obj = parse_object(detail).ok_or(VerifyError::Malformed)?;
        let sig = match obj.remove("sig") {
            Some(Value::String(s)) if !s.is_empty() => s,
            // Unsigned envelopes still carry `"sig": ""` (proto defaults are always emitted).
            Some(Value::String(_)) | None => return Err(VerifyError::Unsigned),
            _ => return Err(VerifyError::Malformed),
        };
        let mut parts = sig.splitn(3, ':');
        let (Some("ed25519"), Some(kid), Some(b64)) = (parts.next(), parts.next(), parts.next()) else {
            return Err(VerifyError::Malformed);
        };
        let (allowed, key) = self.keys.get(kid).ok_or_else(|| VerifyError::UnknownKey(kid.into()))?;
        if allowed != source {
            return Err(VerifyError::WrongSource {
                kid: kid.into(),
                claimed: source.into(),
            });
        }
        let bytes = URL_SAFE_NO_PAD.decode(b64).map_err(|_| VerifyError::Malformed)?;
        let sig = Signature::from_slice(&bytes).map_err(|_| VerifyError::Malformed)?;
        let detail = Value::Object(obj);
        key.verify(&message(source, detail_type, &detail), &sig)
            .map_err(|_| VerifyError::BadSignature)?;

        let signed_at = detail
            .get("signed_at")
            .and_then(Value::as_str)
            .and_then(|s| OffsetDateTime::parse(s, &Rfc3339).ok())
            .ok_or(VerifyError::Malformed)?;
        let age = now - signed_at;
        if age > MAX_AGE || -age > MAX_SKEW {
            return Err(VerifyError::Stale);
        }
        Ok(detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{encode, new_envelope, v1};
    use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
    use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};

    fn keypair() -> (String, String) {
        let k = SigningKey::generate(&mut rand::rngs::OsRng);
        (
            k.to_pkcs8_pem(LineEnding::LF).unwrap().to_string(),
            k.verifying_key().to_public_key_pem(LineEnding::LF).unwrap(),
        )
    }

    fn entry() -> Encoded {
        let data = v1::ToolAuthorizationDecided {
            capability: "jira_create".into(),
            allowed: true,
            ..Default::default()
        };
        encode(
            &v1::Envelope {
                tenant: "org_1".into(),
                ..new_envelope()
            },
            &data,
        )
        .unwrap()
    }

    #[test]
    fn round_trip_survives_key_reordering() {
        let (private, public) = keypair();
        let signer = Signer::from_pkcs8_pem("gw-1", &private).unwrap();
        let verifier = Verifier::default().trust("gw-1", "oryxa.gateway", &public).unwrap();
        let mut e = entry();
        signer.sign(&mut e).unwrap();

        // EventBridge may reorder keys; reverse them to prove it doesn't matter.
        let obj = parse_object(&e.detail).unwrap();
        let reordered = Value::Object(obj.into_iter().rev().collect()).to_string();
        let detail = verifier.verify(&e.source, &e.detail_type, &reordered).unwrap();
        assert_eq!(detail["data"]["capability"], "jira_create");
        assert!(detail.get("sig").is_none());
    }

    #[test]
    fn tampering_forgery_and_staleness_are_rejected() {
        let (private, public) = keypair();
        let signer = Signer::from_pkcs8_pem("gw-1", &private).unwrap();
        let verifier = Verifier::default().trust("gw-1", "oryxa.gateway", &public).unwrap();
        let mut e = entry();
        signer.sign(&mut e).unwrap();

        let tampered = e.detail.replace(r#""allowed":true"#, r#""allowed":false"#);
        assert_ne!(tampered, e.detail);
        assert_eq!(
            verifier.verify(&e.source, &e.detail_type, &tampered),
            Err(VerifyError::BadSignature)
        );
        assert_eq!(
            verifier.verify(&e.source, "identity.user.deleted.v1", &e.detail),
            Err(VerifyError::BadSignature),
            "detail-type is signed"
        );
        assert!(matches!(
            verifier.verify("oryxa.identity", &e.detail_type, &e.detail),
            Err(VerifyError::WrongSource { .. })
        ));
        assert_eq!(
            verifier.verify(&e.source, &e.detail_type, &entry().detail),
            Err(VerifyError::Unsigned)
        );

        let (other_private, _) = keypair();
        let mut forged = entry();
        Signer::from_pkcs8_pem("gw-1", &other_private)
            .unwrap()
            .sign(&mut forged)
            .unwrap();
        assert_eq!(
            verifier.verify(&forged.source, &forged.detail_type, &forged.detail),
            Err(VerifyError::BadSignature)
        );

        let mut old = entry();
        signer
            .sign_at(&mut old, OffsetDateTime::now_utc() - Duration::from_secs(25 * 3600))
            .unwrap();
        assert_eq!(
            verifier.verify(&old.source, &old.detail_type, &old.detail),
            Err(VerifyError::Stale)
        );
    }

    #[test]
    fn decode_validates_after_verifying() {
        use crate::{DecodeError, decode};
        let (private, public) = keypair();
        let signer = Signer::from_pkcs8_pem("gw-1", &private).unwrap();
        let verifier = Verifier::default().trust("gw-1", "oryxa.gateway", &public).unwrap();
        let signed = |envelope: v1::Envelope, data: serde_json::Value| {
            let detail = serde_json::json!({ "data": data }).as_object().unwrap().clone();
            let mut obj = serde_json::to_value(&envelope).unwrap().as_object().unwrap().clone();
            obj.extend(detail);
            let mut e = Encoded {
                source: "oryxa.gateway".into(),
                detail_type: "gateway.tool-authorization.decided.v1".into(),
                group: "org_1".into(),
                event_id: envelope.event_id.clone(),
                detail: Value::Object(obj).to_string(),
            };
            signer.sign(&mut e).unwrap();
            e
        };
        let good = v1::Envelope {
            tenant: "org_1".into(),
            ..new_envelope()
        };

        let e = signed(
            good.clone(),
            serde_json::json!({"capability": "jira_create", "allowed": true}),
        );
        let ok = decode::<v1::ToolAuthorizationDecided>(&verifier, &e.source, &e.detail_type, &e.detail).unwrap();
        assert_eq!(
            (ok.tenant.as_str(), ok.data.capability.as_str(), ok.data.allowed),
            ("org_1", "jira_create", true)
        );

        // Wrong payload type for the detail-type the handler expects.
        assert!(matches!(
            decode::<v1::AgentDelegated>(&verifier, &e.source, &e.detail_type, &e.detail),
            Err(DecodeError::WrongType { .. })
        ));
        // Signed but hostile envelope or payload values are still refused.
        let e = signed(
            v1::Envelope {
                tenant: "org/../2".into(),
                ..new_envelope()
            },
            serde_json::json!({}),
        );
        assert!(matches!(
            decode::<v1::ToolAuthorizationDecided>(&verifier, &e.source, &e.detail_type, &e.detail),
            Err(DecodeError::Envelope(_))
        ));
        let e = signed(
            v1::Envelope {
                event_id: "evt_<script>".into(),
                ..good.clone()
            },
            serde_json::json!({}),
        );
        assert!(matches!(
            decode::<v1::ToolAuthorizationDecided>(&verifier, &e.source, &e.detail_type, &e.detail),
            Err(DecodeError::Envelope(_))
        ));
        let e = signed(good, serde_json::json!({"allowed": "yes"}));
        assert!(matches!(
            decode::<v1::ToolAuthorizationDecided>(&verifier, &e.source, &e.detail_type, &e.detail),
            Err(DecodeError::Payload(_))
        ));
    }
}
