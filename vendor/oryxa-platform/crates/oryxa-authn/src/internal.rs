//! Short-lived internal context token (EdDSA). Minted by the gateway after it has
//! verified the WorkOS token; every downstream service verifies it and gets a `Ctx`.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use oryxa_core::Ctx;
use serde::{Deserialize, Serialize};

const AUDIENCE: &str = "oryxa-internal";
const ISSUER: &str = "oryxa-gateway";
/// Upper bound regardless of configuration: these tokens are never revocable.
const MAX_TTL: Duration = Duration::from_secs(300);
/// Runtime task tokens (`Ctx::task`): longer than the 13-minute run cap so a run never outlives its
/// token. Lead decision on #129; renewal stays #42.
pub const TASK_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, thiserror::Error)]
pub enum InternalTokenError {
    #[error("invalid key: {0}")]
    Key(jsonwebtoken::errors::Error),
    #[error("token rejected: {0:?}")]
    Rejected(jsonwebtoken::errors::ErrorKind),
    #[error("could not sign token: {0}")]
    Sign(jsonwebtoken::errors::Error),
}

#[derive(Serialize, Deserialize)]
struct Claims {
    iss: String,
    aud: String,
    iat: u64,
    exp: u64,
    ctx: Ctx,
}

pub struct InternalTokenIssuer {
    key: EncodingKey,
    kid: String,
    ttl: Duration,
}

impl InternalTokenIssuer {
    /// `private_pem` is a PKCS#8 Ed25519 key (from Secrets Manager). TTL is capped at 5 minutes.
    pub fn new(private_pem: &[u8], kid: impl Into<String>, ttl: Duration) -> Result<Self, InternalTokenError> {
        Ok(Self {
            key: EncodingKey::from_ed_pem(private_pem).map_err(InternalTokenError::Key)?,
            kid: kid.into(),
            ttl: ttl.min(MAX_TTL),
        })
    }

    /// The issuer for runtime task tokens: [`TASK_TTL`], only for the gateway's task-token endpoint.
    pub fn for_tasks(private_pem: &[u8], kid: impl Into<String>) -> Result<Self, InternalTokenError> {
        Ok(Self {
            ttl: TASK_TTL,
            ..Self::new(private_pem, kid, MAX_TTL)?
        })
    }

    pub fn mint(&self, ctx: &Ctx) -> Result<String, InternalTokenError> {
        let iat = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let claims = Claims {
            iss: ISSUER.into(),
            aud: AUDIENCE.into(),
            iat,
            exp: iat + self.ttl.as_secs(),
            ctx: ctx.clone(),
        };
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(self.kid.clone());
        encode(&header, &claims, &self.key).map_err(InternalTokenError::Sign)
    }
}

pub struct InternalTokenVerifier {
    key: DecodingKey,
    validation: Validation,
}

impl InternalTokenVerifier {
    pub fn new(public_pem: &[u8]) -> Result<Self, InternalTokenError> {
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.set_audience(&[AUDIENCE]);
        validation.set_issuer(&[ISSUER]);
        validation.set_required_spec_claims(&["exp", "iss", "aud"]);
        validation.leeway = 5;
        Ok(Self {
            key: DecodingKey::from_ed_pem(public_pem).map_err(InternalTokenError::Key)?,
            validation,
        })
    }

    pub fn verify(&self, token: &str) -> Result<Ctx, InternalTokenError> {
        decode::<Claims>(token, &self.key, &self.validation)
            .map(|d| d.claims.ctx)
            .map_err(|e| InternalTokenError::Rejected(e.into_kind()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey, spki::der::pem::LineEnding};
    use oryxa_core::{AgentId, AgentKind, AgentRef, TenantId, UserId, VerifiedEmail};

    fn keys() -> (String, String) {
        let sk = SigningKey::generate(&mut rand::rngs::OsRng);
        let private = sk.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
        let public = sk.verifying_key().to_public_key_pem(LineEnding::LF).unwrap();
        (private, public)
    }

    fn ctx() -> Ctx {
        Ctx {
            tenant: TenantId::new("org_1").unwrap(),
            user: UserId::new("user_1").unwrap(),
            email: VerifiedEmail::from_workos_verified("a@acme.com"),
            session_id: "session_1".into(),
            agent_chain: vec![AgentRef {
                id: AgentId::new("agent_1").unwrap(),
                kind: AgentKind::Personal,
            }],
            trace_id: "t1".into(),
        }
    }

    #[test]
    fn round_trip_and_rejects_foreign_key() {
        let (private, public) = keys();
        let issuer = InternalTokenIssuer::new(private.as_bytes(), "k1", Duration::from_secs(60)).unwrap();
        let token = issuer.mint(&ctx()).unwrap();
        assert_eq!(
            InternalTokenVerifier::new(public.as_bytes())
                .unwrap()
                .verify(&token)
                .unwrap(),
            ctx()
        );

        let (_, other_public) = keys();
        assert!(
            InternalTokenVerifier::new(other_public.as_bytes())
                .unwrap()
                .verify(&token)
                .is_err()
        );
    }

    #[test]
    fn ttl_is_capped() {
        let (private, _) = keys();
        let issuer = InternalTokenIssuer::new(private.as_bytes(), "k1", Duration::from_secs(86_400)).unwrap();
        assert_eq!(issuer.ttl, MAX_TTL);
        assert_eq!(
            InternalTokenIssuer::for_tasks(private.as_bytes(), "k1").unwrap().ttl,
            TASK_TTL
        );
    }
}
