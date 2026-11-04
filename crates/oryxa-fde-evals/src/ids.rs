//! Ids of suites and cases. They reach the API's tables, logs and the customer room, so they follow the
//! platform's id rules and error type.

use std::fmt;

use oryxa_core::IdError;
use serde::{Deserialize, Serialize};

const MAX_LEN: usize = 128;

// ponytail: same rule as oryxa-fde-core's private id_type!; move these ids there if events or SpiceDB need them.
macro_rules! eval_id {
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

eval_id!(SuiteId, "eval suite id");
eval_id!(CaseId, "eval case id");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_follow_the_platform_rule() {
        assert!(SuiteId::new("suite_01").is_ok());
        for bad in ["", "a b", "a|b", "../x", "é"] {
            assert!(CaseId::new(bad).is_err(), "{bad:?}");
        }
        assert!(serde_json::from_str::<CaseId>("\"x|y\"").is_err());
    }
}
