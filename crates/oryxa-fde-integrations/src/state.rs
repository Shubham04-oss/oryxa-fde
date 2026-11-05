//! The `state` of an install (GitHub App or Slack): who started it, for which tenant, until when,
//! signed with a key from config. The caller also records its id when it is used, so it works once.
//!
//! A state is `<kind>.<id>.<tenant>.<user>.<expires>.<sig>`: ids are `[A-Za-z0-9_-]`, `id` is 16
//! random bytes in hex, `expires` is Unix seconds, and `sig` is the HMAC-SHA256 of the rest.

use std::fmt;

use hmac::{Hmac, Mac};
use sha2::Sha256;
use time::{Duration, OffsetDateTime};

/// How long an install may take between starting it and coming back.
pub const STATE_TTL: Duration = Duration::minutes(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    GitHub,
    Slack,
}

impl InstallKind {
    fn as_str(self) -> &'static str {
        match self {
            InstallKind::GitHub => "github",
            InstallKind::Slack => "slack",
        }
    }
}

/// The key states are signed with, from config. A credential: it stays out of logs.
#[derive(Clone)]
pub struct StateKey(Vec<u8>);

impl StateKey {
    /// `None` for a key shorter than 32 bytes.
    pub fn new(key: impl Into<Vec<u8>>) -> Option<Self> {
        let k = key.into();
        (k.len() >= 32).then_some(Self(k))
    }

    fn sign(&self, data: &str) -> Option<String> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).ok()?;
        mac.update(data.as_bytes());
        Some(hex(&mac.finalize().into_bytes()))
    }
}

impl fmt::Debug for StateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StateKey(<hidden>)")
    }
}

/// A verified state: the caller checks the tenant and user are the caller's, and records the id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallState {
    pub kind: InstallKind,
    pub id: String,
    pub tenant: String,
    pub user: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum StateError {
    #[error("not a state this service signed")]
    Invalid,
    #[error("expired")]
    Expired,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_id(s: &str) -> bool {
    (1..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A new state for `tenant` and `user`, valid for [`STATE_TTL`] from `now`. `None` if either is
/// not an id.
pub fn issue(key: &StateKey, kind: InstallKind, tenant: &str, user: &str, now: OffsetDateTime) -> Option<String> {
    if !is_id(tenant) || !is_id(user) {
        return None;
    }
    let mut id = [0u8; 16];
    getrandom(&mut id)?;
    let expires = (now + STATE_TTL).unix_timestamp();
    let body = format!("{}.{}.{tenant}.{user}.{expires}", kind.as_str(), hex(&id));
    let sig = key.sign(&body)?;
    Some(format!("{body}.{sig}"))
}

fn getrandom(buf: &mut [u8]) -> Option<()> {
    use rand::RngCore;
    rand::rngs::OsRng.try_fill_bytes(buf).ok()
}

/// The state's parts, if it is one this key signed for `kind` and it has not expired.
pub fn verify(key: &StateKey, kind: InstallKind, raw: &str, now: OffsetDateTime) -> Result<InstallState, StateError> {
    let (body, sig) = raw.rsplit_once('.').ok_or(StateError::Invalid)?;
    let expected = key.sign(body).ok_or(StateError::Invalid)?;
    // Constant time: how much of the signature matched says nothing.
    let same =
        sig.len() == expected.len() && sig.bytes().zip(expected.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
    if !same {
        return Err(StateError::Invalid);
    }
    let parts: Vec<&str> = body.split('.').collect();
    let [k, id, tenant, user, expires] = parts[..] else {
        return Err(StateError::Invalid);
    };
    if k != kind.as_str() || id.len() != 32 || !is_id(tenant) || !is_id(user) {
        return Err(StateError::Invalid);
    }
    let expires: i64 = expires.parse().map_err(|_| StateError::Invalid)?;
    if now.unix_timestamp() > expires {
        return Err(StateError::Expired);
    }
    Ok(InstallState {
        kind,
        id: id.to_owned(),
        tenant: tenant.to_owned(),
        user: user.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    const NOW: OffsetDateTime = datetime!(2026-11-05 18:00 UTC);

    fn key() -> StateKey {
        StateKey::new("k".repeat(32)).unwrap()
    }

    #[test]
    fn a_state_is_its_signers_for_its_kind_until_it_expires() {
        let raw = issue(&key(), InstallKind::GitHub, "org_1", "user_1", NOW).unwrap();
        let s = verify(&key(), InstallKind::GitHub, &raw, NOW + Duration::minutes(9)).unwrap();
        assert_eq!(
            (s.tenant.as_str(), s.user.as_str(), s.id.len()),
            ("org_1", "user_1", 32)
        );
        let again = issue(&key(), InstallKind::GitHub, "org_1", "user_1", NOW).unwrap();
        assert_ne!(again, raw, "every state has its own id");

        assert_eq!(
            verify(&key(), InstallKind::GitHub, &raw, NOW + Duration::minutes(11)),
            Err(StateError::Expired)
        );
        assert_eq!(
            verify(&key(), InstallKind::Slack, &raw, NOW),
            Err(StateError::Invalid),
            "a GitHub state is no Slack state"
        );
        let other = StateKey::new("j".repeat(32)).unwrap();
        assert_eq!(verify(&other, InstallKind::GitHub, &raw, NOW), Err(StateError::Invalid));
        // Another tenant or user, or a later expiry, under the same signature: refused.
        for (from, to) in [("org_1", "org_2"), ("user_1", "user_2")] {
            let forged = raw.replacen(from, to, 1);
            assert_eq!(
                verify(&key(), InstallKind::GitHub, &forged, NOW),
                Err(StateError::Invalid)
            );
        }
        let exp = (NOW + STATE_TTL).unix_timestamp().to_string();
        let later = raw.replacen(&exp, &(NOW + Duration::days(9)).unix_timestamp().to_string(), 1);
        assert_eq!(
            verify(&key(), InstallKind::GitHub, &later, NOW),
            Err(StateError::Invalid)
        );
        for bad in ["", "x", "github.a.b.c.d.e", &raw[..raw.len() - 1]] {
            assert_eq!(
                verify(&key(), InstallKind::GitHub, bad, NOW),
                Err(StateError::Invalid),
                "{bad}"
            );
        }
        assert!(issue(&key(), InstallKind::GitHub, "org.1", "user_1", NOW).is_none());
        assert!(StateKey::new("short").is_none());
        assert_eq!(format!("{:?}", key()), "StateKey(<hidden>)");
    }
}
