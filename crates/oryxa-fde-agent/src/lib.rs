//! Agent runs under a `ProjectScope`: the run model, the context pack written into the sandbox before the agent
//! starts, and the event format the harness emits, shaped on the Agent Client Protocol so other harnesses can
//! plug in later.
//!
//! Harness events carry agent output (text, commands, paths) for the review screen. They are not bus events and
//! must never be published through `oryxa-events`.

pub mod context;
pub mod event;
pub mod ids;
pub mod run;

pub use context::{
    AgentConfig, ApprovalRule, CONTEXT_PACK_PATH, ContextError, ContextPack, ContextSource, Criterion, Decision,
    InMemoryContext, ProjectContext,
};
pub use event::{
    ApprovalOutcome, EventError, EventLine, FileChange, HarnessEvent, HarnessInput, Outcome, PlanEntry, PlanStatus,
    ToolKind, ToolStatus, Usage, parse_line,
};
pub use ids::{ApprovalId, ToolCallId};
pub use run::{AgentRun, Applied, FailReason, RunError, RunState};
