//! Ids that `oryxa-fde-core` does not have yet, with the same rules as its ids.
// ponytail: requested for oryxa-fde-core on #3; switch these imports to core once they land there.

use std::fmt;

use oryxa_core::IdError;
use oryxa_fde_core::MAX_ID_LEN;
use serde::{Deserialize, Serialize};

macro_rules! id_type {
    ($name:ident, $kind:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                let value = value.into();
                let ok = !value.is_empty()
                    && value.len() <= MAX_ID_LEN
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
                if ok {
                    Ok(Self(value))
                } else {
                    Err(IdError::Invalid {
                        kind: $kind,
                        max: MAX_ID_LEN,
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

id_type!(ScopeItemId, "scope item id");
id_type!(SecurityAnswerId, "security answer id");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_rules_as_core_ids() {
        assert!(ScopeItemId::new("itm_01J-x").is_ok());
        for bad in ["", "a|b", "a b", "a/b", "é", "a\n"] {
            assert!(ScopeItemId::new(bad).is_err(), "{bad:?}");
            assert!(SecurityAnswerId::new(bad).is_err(), "{bad:?}");
        }
        assert!(SecurityAnswerId::new("a".repeat(MAX_ID_LEN + 1)).is_err());
        assert!(serde_json::from_str::<ScopeItemId>("\"not|ok\"").is_err());
    }
}
