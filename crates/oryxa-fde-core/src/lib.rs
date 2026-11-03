//! Types every FDE crate shares: validated ids, the company and project scopes that every
//! company-scoped call takes, and the project stage machine.

pub mod ids;
pub mod scope;
pub mod stage;

pub use ids::*;
pub use scope::{CompanyScope, ProjectScope};
pub use stage::{Stage, StageError};
