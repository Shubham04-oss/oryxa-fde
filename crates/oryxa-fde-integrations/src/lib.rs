//! GitHub and Slack. [`github`] checks a GitHub App webhook delivery before anything of it is used:
//! its signature, then that it is a pull request opened or merged, recently. [`outbound`] is the one
//! way out to their APIs, limited to an explicit host allowlist. [`github_api`] and [`slack`] are the
//! calls made, and [`secrets`] keeps each tenant's Slack bot token in Secrets Manager; [`state`]
//! signs the state an install carries.

pub mod github;
pub mod github_api;
pub mod outbound;
pub mod secrets;
pub mod slack;
pub mod state;
