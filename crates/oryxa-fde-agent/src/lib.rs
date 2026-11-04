//! Agent runs under a `ProjectScope`: the run model, the context pack written into the sandbox before the agent
//! starts, the event format the harness emits (shaped on the Agent Client Protocol so other harnesses can plug in
//! later), and the run service that drives runs through the sandbox gateway, with its API.
//!
//! Harness events carry agent output (text, commands, paths) for the review screen. They are not bus events and
//! must never be published through `oryxa-events`; the only bus event a run causes is `AgentRunFinished`, ids only.

pub mod access;
pub mod api;
pub mod context;
pub mod evals;
pub mod event;
pub mod gateway;
pub mod git;
pub mod ids;
pub mod live;
mod orchestrate;
pub mod pg;
pub mod prod;
pub mod project_context;
pub mod run;
pub mod service;
pub mod store;

pub use context::{
    AgentConfig, ApprovalRule, ContextError, ContextPack, ContextSource, Criterion, Decision, EncodedPack,
    InMemoryContext, ProjectContext,
};
pub use event::{
    ApprovalOutcome, EventError, EventLine, FileChange, HarnessEvent, HarnessInput, Outcome, PlanEntry, PlanStatus,
    ToolKind, ToolStatus, Usage, parse_line,
};
pub use ids::{ApprovalId, ToolCallId};
pub use run::{AgentRun, Applied, FailReason, RunError, RunState, StopReason};
