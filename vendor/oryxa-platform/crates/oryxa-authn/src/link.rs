//! Rules for linking a Slack/Teams identity to a WorkOS user. Linking is the only way a
//! chat user gets an identity in Oryxa, so every rule here fails closed.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Stable chat-platform key. Slack: Grid id beats workspace id; Teams: tenant + Entra object id.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "platform", rename_all = "snake_case")]
pub enum ChatIdentity {
    Slack { org: String, user: String },
    Teams { tenant: String, aad_object_id: String },
}

impl ChatIdentity {
    /// Slack: pass `enterprise_id` / `enterprise_user.id` when on Grid, else `team_id` / `id`.
    pub fn slack(enterprise: Option<(&str, &str)>, team_id: &str, user_id: &str) -> Self {
        let (org, user) = enterprise.unwrap_or((team_id, user_id));
        Self::Slack {
            org: org.into(),
            user: user.into(),
        }
    }
}

/// What the edge adapter learned about the chat user (Slack `users.info`, Teams member + Graph).
#[derive(Debug, Clone, Default)]
pub struct ChatProfile {
    pub email: Option<String>,
    pub is_bot: bool,
    pub deleted: bool,
    /// Slack guest/stranger, Teams guest.
    pub external: bool,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LinkError {
    #[error("WorkOS email is not verified")]
    WorkosEmailUnverified,
    #[error("chat profile has no email")]
    NoChatEmail,
    #[error("chat email does not match the WorkOS email")]
    EmailMismatch,
    #[error("bots, deleted and external users are not linked")]
    Excluded,
}

/// Decide whether `profile` may link to the WorkOS user with `workos_email`.
pub fn link_decision(workos_email: &str, workos_email_verified: bool, profile: &ChatProfile) -> Result<(), LinkError> {
    if profile.is_bot || profile.deleted || profile.external {
        return Err(LinkError::Excluded);
    }
    if !workos_email_verified {
        return Err(LinkError::WorkosEmailUnverified);
    }
    let chat = profile.email.as_deref().ok_or(LinkError::NoChatEmail)?;
    // Chat payloads are outside input; RFC 5321 caps an address at 320 octets.
    if chat.len() > 320 || workos_email.len() > 320 {
        return Err(LinkError::EmailMismatch);
    }
    // ponytail: case-insensitive whole-string match only; no alias or proxyAddresses
    // resolution. Add per-tenant alias rules if UPN != mail tenants show up.
    if chat.eq_ignore_ascii_case(workos_email) {
        Ok(())
    } else {
        Err(LinkError::EmailMismatch)
    }
}

/// Stored on each link; a different hash later means the email changed or was reused,
/// so the link must be invalidated and re-verified.
pub fn email_hash(email: &str) -> String {
    let digest = Sha256::digest(email.to_ascii_lowercase().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(email: &str) -> ChatProfile {
        ChatProfile {
            email: Some(email.into()),
            ..Default::default()
        }
    }

    #[test]
    fn link_rules() {
        assert_eq!(link_decision("Jane@Acme.com", true, &profile("jane@acme.com")), Ok(()));
        assert_eq!(
            link_decision("jane@acme.com", false, &profile("jane@acme.com")),
            Err(LinkError::WorkosEmailUnverified)
        );
        assert_eq!(
            link_decision("jane@acme.com", true, &profile("j.doe@acme.com")),
            Err(LinkError::EmailMismatch)
        );
        assert_eq!(
            link_decision("jane@acme.com", true, &ChatProfile::default()),
            Err(LinkError::NoChatEmail)
        );
        let guest = ChatProfile {
            external: true,
            ..profile("jane@acme.com")
        };
        assert_eq!(link_decision("jane@acme.com", true, &guest), Err(LinkError::Excluded));
    }

    #[test]
    fn slack_prefers_grid_ids_and_hash_is_case_insensitive() {
        assert_eq!(
            ChatIdentity::slack(Some(("E1", "W1")), "T1", "U1"),
            ChatIdentity::Slack {
                org: "E1".into(),
                user: "W1".into()
            }
        );
        assert_eq!(
            ChatIdentity::slack(None, "T1", "U1"),
            ChatIdentity::Slack {
                org: "T1".into(),
                user: "U1".into()
            }
        );
        assert_eq!(email_hash("A@B.com"), email_hash("a@b.com"));
        assert_ne!(email_hash("a@b.com"), email_hash("c@b.com"));
    }
}
