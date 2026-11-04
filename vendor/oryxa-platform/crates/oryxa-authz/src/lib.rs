//! Authorization: tenant-guarded SpiceDB client and Cedar guardrails.
//! Schema lives in `/schema/oryxa.zed`; guardrail policies in `/policies`.

pub mod connection;
pub mod guardrail;
pub mod ids;
pub mod spicedb;

pub use connection::may_use_connection;
pub use guardrail::{GuardrailError, Guardrails};
pub use ids::{ObjectRef, SubjectRef};
pub use spicedb::{AuthzError, CheckItem, Consistency, Decision, Precondition, Relationship, SpiceDb, Write, ZedToken};
