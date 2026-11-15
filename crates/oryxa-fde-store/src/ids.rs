//! Ids of the planning records (#20), with the same rules as `oryxa_fde_core`'s ids: they reach
//! SQL, S3 keys and audit rows, so only `[a-zA-Z0-9_-]`, at most 128 bytes.

use std::fmt;

use oryxa_core::IdError;
use oryxa_fde_core::MAX_ID_LEN;

fn validate(kind: &'static str, value: String) -> Result<String, IdError> {
    let ok = !value.is_empty()
        && value.len() <= MAX_ID_LEN
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(value)
    } else {
        Err(IdError::Invalid {
            kind,
            max: MAX_ID_LEN,
            value,
        })
    }
}

// ponytail: mirrors oryxa_fde_core's id_type!, which core does not export; these move to core when
// the lead next changes it.
macro_rules! id_type {
    ($name:ident, $kind:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                validate($kind, value.into()).map(Self)
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
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id_type!(SnapshotId, "canvas snapshot id");
id_type!(ShapeId, "canvas shape id");
id_type!(ThreadId, "thread id");
id_type!(CommentId, "comment id");
id_type!(MeetingNoteId, "meeting note id");
id_type!(ConversationId, "conversation id");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_take_the_core_charset_only() {
        assert_eq!(ShapeId::new("Xy_3-kQ9").unwrap().as_str(), "Xy_3-kQ9");
        for bad in ["", "a/b", "../x", "a b", "a:b", "é", "a\n"] {
            assert!(ShapeId::new(bad).is_err(), "{bad:?}");
            assert!(ThreadId::new(bad).is_err(), "{bad:?}");
        }
        assert!(MeetingNoteId::new("a".repeat(MAX_ID_LEN)).is_ok());
        assert!(MeetingNoteId::new("a".repeat(MAX_ID_LEN + 1)).is_err());
    }
}
