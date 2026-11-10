//! Types every FDE crate shares: validated ids, the company and project scopes that every
//! company-scoped call takes, the project stage machine and the checklist to leave each stage.

pub mod checklist;
pub mod ids;
pub mod scope;
pub mod stage;

pub use checklist::Check;
pub use ids::*;
pub use scope::{CompanyScope, ProjectScope};
pub use stage::{Stage, StageError};
