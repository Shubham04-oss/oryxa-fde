//! Authentication: WorkOS access-token verification, the internal context token,
//! and the rules for linking Slack/Teams identities to a WorkOS user.

pub mod internal;
pub mod link;
pub mod workos_jwt;

pub use internal::{InternalTokenError, InternalTokenIssuer, InternalTokenVerifier, TASK_TTL};
pub use link::{ChatIdentity, ChatProfile, LinkError, email_hash, link_decision};
pub use workos_jwt::{AccessTokenVerifier, JwtError, KeySource, SessionClaims};
