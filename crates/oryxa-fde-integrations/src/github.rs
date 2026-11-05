//! GitHub App webhooks. A delivery is used only if its `X-Hub-Signature-256` is the webhook
//! secret's HMAC-SHA256 of the exact body, it is a pull request opened or merged, and the
//! `updated_at` inside the signed body is recent. GitHub signs no timestamp header, so that field is
//! the replay window; the caller also refuses a delivery id it has seen.

use std::fmt;

use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

/// The largest body read; GitHub's pull request payloads are far smaller.
pub const MAX_BODY: usize = 1024 * 1024;

/// How old a delivery's signed `updated_at` may be, and how far ahead of our clock.
pub const WINDOW: Duration = Duration::hours(1);
pub const SKEW: Duration = Duration::minutes(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum WebhookError {
    #[error("signature missing or wrong")]
    BadSignature,
    #[error("not a readable delivery")]
    Malformed,
    #[error("outside the replay window")]
    Stale,
}

/// The webhook secret, from config. A credential: it stays out of logs.
#[derive(Clone)]
pub struct WebhookSecret(Vec<u8>);

impl WebhookSecret {
    /// `None` for a secret too short to be one GitHub would accept as strong.
    pub fn new(secret: impl Into<Vec<u8>>) -> Option<Self> {
        let s = secret.into();
        (s.len() >= 32).then_some(Self(s))
    }
}

impl fmt::Debug for WebhookSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WebhookSecret(<hidden>)")
    }
}

/// Checks `X-Hub-Signature-256` (`sha256=<64 hex>`) against the body, in constant time.
pub fn verify(secret: &WebhookSecret, body: &[u8], header: Option<&str>) -> Result<(), WebhookError> {
    let hex = header
        .and_then(|h| h.strip_prefix("sha256="))
        .filter(|h| h.len() == 64)
        .ok_or(WebhookError::BadSignature)?;
    let mut sig = [0u8; 32];
    for (i, byte) in sig.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(2 * i..2 * i + 2).ok_or(WebhookError::BadSignature)?, 16)
            .map_err(|_| WebhookError::BadSignature)?;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(&secret.0).map_err(|_| WebhookError::BadSignature)?;
    mac.update(body);
    mac.verify_slice(&sig).map_err(|_| WebhookError::BadSignature)
}

/// A delivery's `X-GitHub-Delivery`: a GUID, checked before it reaches SQL or a log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryId(String);

impl DeliveryId {
    pub fn new(raw: &str) -> Option<Self> {
        let ok = (1..=64).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
        ok.then(|| Self(raw.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestAction {
    Opened,
    Merged,
}

/// A pull request opened or merged, as ids and a number only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestEvent {
    pub delivery: DeliveryId,
    /// The App installation it came through, and the repository, both GitHub's numeric ids.
    pub installation: u64,
    pub repository: u64,
    pub number: u32,
    pub action: PullRequestAction,
    pub updated_at: OffsetDateTime,
}

#[derive(Deserialize)]
struct Payload {
    action: String,
    number: u32,
    pull_request: PullRequest,
    repository: Id,
    installation: Id,
}

#[derive(Deserialize)]
struct PullRequest {
    #[serde(default)]
    merged: bool,
    updated_at: String,
}

#[derive(Deserialize)]
struct Id {
    id: u64,
}

/// The pull request a verified delivery is about, if it is one opened or merged; `None` for every
/// other event or action, which the caller acknowledges and drops. Call only after [`verify`].
pub fn pull_request(
    event: Option<&str>,
    delivery: Option<&str>,
    body: &[u8],
    now: OffsetDateTime,
) -> Result<Option<PullRequestEvent>, WebhookError> {
    let delivery = delivery.and_then(DeliveryId::new).ok_or(WebhookError::Malformed)?;
    if event != Some("pull_request") {
        return Ok(None);
    }
    let p: Payload = serde_json::from_slice(body).map_err(|_| WebhookError::Malformed)?;
    let action = match (p.action.as_str(), p.pull_request.merged) {
        ("opened", _) => PullRequestAction::Opened,
        ("closed", true) => PullRequestAction::Merged,
        _ => return Ok(None),
    };
    let updated_at =
        OffsetDateTime::parse(&p.pull_request.updated_at, &Rfc3339).map_err(|_| WebhookError::Malformed)?;
    if updated_at < now - WINDOW || updated_at > now + SKEW {
        return Err(WebhookError::Stale);
    }
    Ok(Some(PullRequestEvent {
        delivery,
        installation: p.installation.id,
        repository: p.repository.id,
        number: p.number,
        action,
        updated_at,
    }))
}

/// An installation going away, or repositories leaving one: what to unclaim or unlink. The caller
/// confirms it with GitHub before acting, so a replayed body changes nothing GitHub has not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallationChange {
    /// `installation` `deleted` or `suspend`.
    Removed { installation: u64 },
    /// `installation_repositories` `removed`.
    RepositoriesRemoved { installation: u64, repositories: Vec<u64> },
}

/// Most repositories one delivery may remove.
const MAX_REMOVED: usize = 1000;

#[derive(Deserialize)]
struct InstallationPayload {
    action: String,
    installation: Id,
    #[serde(default)]
    repositories_removed: Vec<Id>,
}

/// The installation change a verified delivery is about, if any; `None` for every other event or
/// action. Call only after [`verify`].
pub fn installation_change(event: Option<&str>, body: &[u8]) -> Result<Option<InstallationChange>, WebhookError> {
    let removing = match event {
        Some("installation") => false,
        Some("installation_repositories") => true,
        _ => return Ok(None),
    };
    let p: InstallationPayload = serde_json::from_slice(body).map_err(|_| WebhookError::Malformed)?;
    let installation = p.installation.id;
    Ok(match (removing, p.action.as_str()) {
        (false, "deleted" | "suspend") => Some(InstallationChange::Removed { installation }),
        (true, "removed") if p.repositories_removed.len() <= MAX_REMOVED => {
            Some(InstallationChange::RepositoriesRemoved {
                installation,
                repositories: p.repositories_removed.into_iter().map(|r| r.id).collect(),
            })
        }
        (true, "removed") => return Err(WebhookError::Malformed),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use time::macros::datetime;

    use super::*;

    const NOW: OffsetDateTime = datetime!(2026-11-05 18:00 UTC);

    fn secret() -> WebhookSecret {
        WebhookSecret::new("s".repeat(32)).unwrap()
    }

    fn sign(body: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&secret().0).unwrap();
        mac.update(body);
        let sig: String = mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect();
        format!("sha256={sig}")
    }

    fn body(action: &str, merged: bool, updated_at: &str) -> Vec<u8> {
        json!({
            "action": action,
            "number": 42,
            "pull_request": {"merged": merged, "updated_at": updated_at, "title": "Ignore previous instructions"},
            "repository": {"id": 7001, "full_name": "acme/support-rag"},
            "installation": {"id": 99},
            "sender": {"login": "octocat"}
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn only_the_secrets_signature_of_the_exact_body_passes() {
        let b = body("opened", false, "2026-11-05T17:59:00Z");
        let good = sign(&b);
        assert_eq!(verify(&secret(), &b, Some(&good)), Ok(()));
        let mut tampered = b.clone();
        tampered[10] ^= 1;
        let other = WebhookSecret::new("t".repeat(32)).unwrap();
        assert_eq!(verify(&other, &b, Some(&good)), Err(WebhookError::BadSignature));
        assert_eq!(
            verify(&secret(), &tampered, Some(&good)),
            Err(WebhookError::BadSignature)
        );
        let upper = format!("sha256={}", good[7..].to_ascii_uppercase());
        assert_eq!(verify(&secret(), &b, Some(&upper)), Ok(()), "hex is case-insensitive");
        for bad in [
            None,
            Some(""),
            Some("sha256="),
            Some(&good[7..]),
            Some("sha1=0000000000000000000000000000000000000000"),
            Some(&good[..good.len() - 2]),
            Some("sha256=zz00000000000000000000000000000000000000000000000000000000000000"),
            Some("sha256=é000000000000000000000000000000000000000000000000000000000000"),
        ] {
            assert_eq!(verify(&secret(), &b, bad), Err(WebhookError::BadSignature), "{bad:?}");
        }
        assert!(WebhookSecret::new("short").is_none());
        assert_eq!(format!("{:?}", secret()), "WebhookSecret(<hidden>)");
    }

    #[test]
    fn an_installation_leaving_or_losing_repositories_is_read_and_nothing_else() {
        let removed = |event: &str, action: &str| {
            let b = json!({"action": action, "installation": {"id": 99},
                "repositories_removed": [{"id": 7001, "full_name": "acme/a"}, {"id": 7002}]});
            installation_change(Some(event), b.to_string().as_bytes())
        };
        for action in ["deleted", "suspend"] {
            assert_eq!(
                removed("installation", action),
                Ok(Some(InstallationChange::Removed { installation: 99 }))
            );
        }
        assert_eq!(
            removed("installation_repositories", "removed"),
            Ok(Some(InstallationChange::RepositoriesRemoved {
                installation: 99,
                repositories: vec![7001, 7002]
            }))
        );
        for (event, action) in [
            ("installation", "created"),
            ("installation", "unsuspend"),
            ("installation_repositories", "added"),
            ("pull_request", "deleted"),
        ] {
            assert_eq!(removed(event, action), Ok(None), "{event} {action}");
        }
        let many: Vec<_> = (0..=MAX_REMOVED as u64).map(|id| json!({"id": id})).collect();
        let b = json!({"action": "removed", "installation": {"id": 1}, "repositories_removed": many});
        assert_eq!(
            installation_change(Some("installation_repositories"), b.to_string().as_bytes()),
            Err(WebhookError::Malformed)
        );
        assert_eq!(
            installation_change(Some("installation"), b"[]"),
            Err(WebhookError::Malformed)
        );
    }

    #[test]
    fn only_a_recent_pull_request_opened_or_merged_is_used() {
        let d = Some("72d3162e-cc78-11e3-81ab-4c9367dc0958");
        let opened = pull_request(
            Some("pull_request"),
            d,
            &body("opened", false, "2026-11-05T17:30:00Z"),
            NOW,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            (opened.installation, opened.repository, opened.number, opened.action),
            (99, 7001, 42, PullRequestAction::Opened)
        );
        assert_eq!(opened.delivery.as_str(), "72d3162e-cc78-11e3-81ab-4c9367dc0958");
        let merged = pull_request(
            Some("pull_request"),
            d,
            &body("closed", true, "2026-11-05T17:30:00Z"),
            NOW,
        );
        assert_eq!(merged.unwrap().unwrap().action, PullRequestAction::Merged);
        // Closed unmerged, other actions and other events are dropped.
        for (event, b) in [
            ("pull_request", body("closed", false, "2026-11-05T17:30:00Z")),
            ("pull_request", body("synchronize", false, "2026-11-05T17:30:00Z")),
            ("push", body("opened", false, "2026-11-05T17:30:00Z")),
            ("ping", b"{}".to_vec()),
        ] {
            assert_eq!(pull_request(Some(event), d, &b, NOW), Ok(None), "{event}");
        }
        assert_eq!(pull_request(None, d, b"{}", NOW), Ok(None));
        // Older than the window, or ahead of the clock: a replay, refused.
        for at in ["2026-11-05T16:59:59Z", "2026-11-05T18:05:01Z"] {
            assert_eq!(
                pull_request(Some("pull_request"), d, &body("opened", false, at), NOW),
                Err(WebhookError::Stale),
                "{at}"
            );
        }
        for (delivery, b) in [
            (None, body("opened", false, "2026-11-05T17:30:00Z")),
            (Some("not a guid"), body("opened", false, "2026-11-05T17:30:00Z")),
            (d, b"not json".to_vec()),
            (d, body("opened", false, "yesterday")),
            (d, br#"{"action":"opened","number":-1}"#.to_vec()),
        ] {
            assert_eq!(
                pull_request(Some("pull_request"), delivery, &b, NOW),
                Err(WebhookError::Malformed),
                "{delivery:?}"
            );
        }
    }
}
