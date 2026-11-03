//! FDE ids. Same rules as the platform's ids (they reach SpiceDB, SQL, logs and events), and the
//! same error type, so callers handle one kind of id failure.

use std::fmt;

use oryxa_core::IdError;
use serde::{Deserialize, Serialize};

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

// ponytail: mirrors oryxa-core's private id_type! macro; switch to it if the platform exports it.
macro_rules! id_type {
    ($name:ident, $kind:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                validate($kind, MAX_ID_LEN, value.into()).map(Self)
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

/// Longest id accepted. SpiceDB object ids are `<tenant>|<id>`, and the tenant takes up to 64.
pub const MAX_ID_LEN: usize = 128;

id_type!(CompanyId, "company id");
id_type!(ProjectId, "project id");
id_type!(StakeholderId, "stakeholder id");
id_type!(SystemId, "system id");
id_type!(CriterionId, "success criterion id");
id_type!(AccessRequestId, "access request id");
id_type!(TaskId, "task id");
id_type!(DecisionId, "decision id");
id_type!(DocumentId, "document id");
id_type!(AgentRunId, "agent run id");
id_type!(EvalRunId, "eval run id");
id_type!(ShareLinkId, "share link id");

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn accepts_the_safe_charset() {
        assert_eq!(CompanyId::new("cmp_01J-x").unwrap().as_str(), "cmp_01J-x");
    }

    #[test]
    fn rejects_empty_long_and_unsafe_ids() {
        assert!(ProjectId::new("").is_err());
        assert!(ProjectId::new("a".repeat(MAX_ID_LEN + 1)).is_err());
        for bad in ["a|b", "a b", "a/b", "a:b", "é", "a\n"] {
            assert!(ProjectId::new(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn serde_validates_on_the_way_in() {
        assert!(serde_json::from_str::<CompanyId>("\"ok_1\"").is_ok());
        assert!(serde_json::from_str::<CompanyId>("\"not|ok\"").is_err());
    }

    proptest! {
        #[test]
        fn valid_ids_round_trip(s in "[a-zA-Z0-9_-]{1,128}") {
            let id = TaskId::new(s.clone()).unwrap();
            prop_assert_eq!(String::from(id), s);
        }
    }
}
