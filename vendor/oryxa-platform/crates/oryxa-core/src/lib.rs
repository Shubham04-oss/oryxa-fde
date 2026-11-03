//! Shared identity and request-context types. Every tenant-scoped call takes a [`Ctx`].

use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IdError {
    #[error("{kind} must be 1..={max} chars of [a-zA-Z0-9_-], got {value:?}")]
    Invalid {
        kind: &'static str,
        max: usize,
        value: String,
    },
}

/// Ids flow into SpiceDB object ids and log lines, so they stay to a safe charset.
fn validate(kind: &'static str, max: usize, value: String) -> Result<String, IdError> {
    let ok = !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(value)
    } else {
        Err(IdError::Invalid { kind, max, value })
    }
}

macro_rules! id_type {
    ($name:ident, $kind:literal, $max:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                validate($kind, $max, value.into()).map(Self)
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl TryFrom<String> for $name {
            type Error = IdError;
            fn try_from(v: String) -> Result<Self, IdError> {
                Self::new(v)
            }
        }
        impl From<$name> for String {
            fn from(v: $name) -> String {
                v.0
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

// Tenant = WorkOS organization id; user = WorkOS user id (the primary identity key).
id_type!(TenantId, "tenant id", 64);
id_type!(UserId, "user id", 64);
id_type!(AgentId, "agent id", 64);
// Untrusted ids that reach SpiceDB, logs or events are constrained the same way.
id_type!(CapabilityId, "capability id", 128);
id_type!(SessionId, "session id", 128);
id_type!(TraceId, "trace id", 128);
id_type!(GroupId, "group id", 128);
id_type!(WorkspaceId, "workspace id", 128);
id_type!(ConnectionId, "connection id", 128);
id_type!(KbItemId, "kb item id", 128);

/// Hard cap on JSON nesting accepted from callers (tool args, connector payloads).
pub const MAX_JSON_DEPTH: usize = 32;

/// Depth of a JSON value (scalars are 0). Deeply nested input is refused before it is
/// hashed, logged or forwarded.
pub fn json_depth(v: &serde_json::Value) -> usize {
    match v {
        serde_json::Value::Array(a) => 1 + a.iter().map(json_depth).max().unwrap_or(0),
        serde_json::Value::Object(m) => 1 + m.values().map(json_depth).max().unwrap_or(0),
        _ => 0,
    }
}

/// An email WorkOS reported as `email_verified=true`. Only the gateway constructs it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifiedEmail(String);

impl VerifiedEmail {
    /// Caller asserts WorkOS marked this email verified.
    pub fn from_workos_verified(email: impl Into<String>) -> Self {
        Self(email.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for VerifiedEmail {
    // Keep emails out of debug logs.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("VerifiedEmail(<redacted>)")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Personal,
    Workspace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRef {
    pub id: AgentId,
    pub kind: AgentKind,
}

/// Request context. The origin human is always present; agents only ever act for one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ctx {
    pub tenant: TenantId,
    pub user: UserId,
    pub email: VerifiedEmail,
    pub session_id: String,
    /// Agent hops from the origin human outward; empty when the human acts directly.
    pub agent_chain: Vec<AgentRef>,
    pub trace_id: String,
}

impl Ctx {
    /// The agent currently acting, if any.
    pub fn acting_agent(&self) -> Option<&AgentRef> {
        self.agent_chain.last()
    }

    /// The runtime task a task token was minted for (`session_id` = `task:<id>`); `None` for a
    /// human's token. Only the gateway's task-token endpoint mints these.
    pub fn task(&self) -> Option<&str> {
        self.session_id.strip_prefix(TASK_SESSION_PREFIX)
    }
}

/// `Ctx::session_id` prefix that marks a runtime task token.
pub const TASK_SESSION_PREFIX: &str = "task:";

/// JSON with object keys sorted at every level: the one canonical form used for hashing
/// approval arguments and signing events. Needed because serde_json's `preserve_order` is
/// on in this workspace and EventBridge may reorder keys in transit.
pub fn canonical_json(v: &serde_json::Value) -> String {
    fn sort(v: &serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::Object(m) => {
                let mut keys: Vec<_> = m.keys().collect();
                keys.sort();
                serde_json::Value::Object(keys.into_iter().map(|k| (k.clone(), sort(&m[k]))).collect())
            }
            serde_json::Value::Array(a) => serde_json::Value::Array(a.iter().map(sort).collect()),
            other => other.clone(),
        }
    }
    sort(v).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_reject_unsafe_chars() {
        assert!(TenantId::new("org_01HXYZ").is_ok());
        assert!(TenantId::new("").is_err());
        assert!(TenantId::new("a/b").is_err());
        assert!(TenantId::new("a".repeat(65)).is_err());
        assert!(serde_json::from_str::<UserId>("\"bad id\"").is_err());
    }

    #[test]
    fn canonical_json_ignores_key_order_at_every_level() {
        let a: serde_json::Value = serde_json::from_str(r#"{"b":1,"a":{"y":[{"q":1,"p":2}],"x":2}}"#).unwrap();
        let b: serde_json::Value = serde_json::from_str(r#"{"a":{"x":2,"y":[{"p":2,"q":1}]},"b":1}"#).unwrap();
        assert_eq!(canonical_json(&a), canonical_json(&b));
        assert_eq!(canonical_json(&a), r#"{"a":{"x":2,"y":[{"p":2,"q":1}]},"b":1}"#);
    }

    #[test]
    fn json_depth_counts_nesting() {
        assert_eq!(json_depth(&serde_json::json!(1)), 0);
        assert_eq!(json_depth(&serde_json::json!({"a": [1, {"b": 2}]})), 3);
    }

    #[test]
    fn email_never_in_debug() {
        let e = VerifiedEmail::from_workos_verified("a@b.com");
        assert!(!format!("{e:?}").contains("a@b.com"));
    }
}
