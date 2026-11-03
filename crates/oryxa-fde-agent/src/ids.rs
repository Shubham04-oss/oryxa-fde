//! Ids the harness mints. They reach the API's tables, logs and the review screen, so they follow the platform's
//! id rules and error type.

use std::fmt;

use oryxa_core::IdError;
use serde::{Deserialize, Serialize};

const MAX_LEN: usize = 128;

// ponytail: same rule as oryxa-fde-core's private id_type!; move these ids there if events or SpiceDB need them.
macro_rules! agent_id {
    ($name:ident, $kind:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                let value = value.into();
                let ok = !value.is_empty()
                    && value.len() <= MAX_LEN
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
                if ok {
                    Ok(Self(value))
                } else {
                    Err(IdError::Invalid {
                        kind: $kind,
                        max: MAX_LEN,
                        value,
                    })
                }
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

agent_id!(ToolCallId, "tool call id");
agent_id!(ApprovalId, "approval id");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_harness_ids_and_refuses_unsafe_ones() {
        assert!(ToolCallId::new("toolu_01ABCdef-9").is_ok());
        assert!(ApprovalId::new("apr_0").is_ok());
        for bad in ["", "a b", "a|b", "a/b", "é", "a\n"] {
            assert!(ToolCallId::new(bad).is_err(), "{bad:?} must be refused");
        }
        assert!(ApprovalId::new("a".repeat(MAX_LEN + 1)).is_err());
        assert!(serde_json::from_str::<ApprovalId>("\"not|ok\"").is_err());
    }
}
