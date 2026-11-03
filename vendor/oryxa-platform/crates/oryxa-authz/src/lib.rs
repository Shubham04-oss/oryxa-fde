//! Authorization: tenant-guarded SpiceDB client and Cedar guardrails.
//! Schema lives in `/schema/oryxa.zed`; guardrail policies in `/policies`.

pub mod guardrail;
pub mod ids;
pub mod kb;
pub mod spicedb;

pub use guardrail::{GuardrailError, Guardrails};
pub use ids::{ObjectRef, SubjectRef};
pub use kb::{Audience, KbReader, MAX_AUDIENCE, MAX_READER_CHECKS, kb_visible, may_use_connection};
pub use spicedb::{AuthzError, CheckItem, Consistency, Decision, Precondition, Relationship, SpiceDb, Write, ZedToken};
