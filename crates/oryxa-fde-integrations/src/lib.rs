//! GitHub and Slack. [`github`] checks a GitHub App webhook delivery before anything of it is used:
//! its signature, then that it is a pull request opened or merged, recently. [`outbound`] is the one
//! way out to their APIs, limited to an explicit host allowlist.

pub mod github;
pub mod github_api;
pub mod outbound;
pub mod slack;
pub mod state;
