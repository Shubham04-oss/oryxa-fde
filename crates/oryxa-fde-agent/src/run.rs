//! An agent run moves queued -> running -> finished or failed. An action on the company's approval list holds it
//! in waiting-for-approval until an FDE decides; a rejection ends it.

use oryxa_fde_core::{AgentRunId, ProjectScope};
use serde::{Deserialize, Serialize};

use crate::event::{ApprovalOutcome, EventLine, HarnessEvent, HarnessInput, Outcome};
use crate::ids::ApprovalId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RunState {
    Queued,
    Running,
    WaitingForApproval { approval: ApprovalId },
    Finished,
    Failed { reason: FailReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailReason {
    /// An FDE rejected an action on the approval list.
    ApprovalRejected,
    /// The harness reported an error result.
    HarnessError,
    /// The harness process ended without a result.
    HarnessExited,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RunError {
    #[error("the run has not started")]
    NotStarted,
    #[error("the run is already {0:?}")]
    AlreadyStarted(RunState),
    #[error("expected event {expected}, got {got}")]
    OutOfOrder { expected: u64, got: u64 },
    #[error("an approval is already pending")]
    ApprovalPending,
    #[error("no pending approval {0}")]
    NoSuchApproval(ApprovalId),
}

/// What `apply` did with a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    Recorded,
    /// Seen before: replays are idempotent.
    Duplicate,
    /// Arrived after the run ended (the harness winding down); kept for the transcript, state unchanged.
    AfterEnd,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRun {
    id: AgentRunId,
    scope: ProjectScope,
    state: RunState,
    next_seq: u64,
}

impl AgentRun {
    pub fn new(id: AgentRunId, scope: ProjectScope) -> Self {
        Self {
            id,
            scope,
            state: RunState::Queued,
            next_seq: 0,
        }
    }

    pub fn id(&self) -> &AgentRunId {
        &self.id
    }

    pub fn scope(&self) -> &ProjectScope {
        &self.scope
    }

    pub fn state(&self) -> &RunState {
        &self.state
    }

    pub fn is_ended(&self) -> bool {
        matches!(self.state, RunState::Finished | RunState::Failed { .. })
    }

    pub fn start(&mut self) -> Result<(), RunError> {
        if self.state != RunState::Queued {
            return Err(RunError::AlreadyStarted(self.state.clone()));
        }
        self.state = RunState::Running;
        Ok(())
    }

    /// Applies the harness's next event line, in `seq` order.
    pub fn apply(&mut self, line: &EventLine) -> Result<Applied, RunError> {
        if self.state == RunState::Queued {
            return Err(RunError::NotStarted);
        }
        if line.seq < self.next_seq {
            return Ok(Applied::Duplicate);
        }
        if line.seq > self.next_seq {
            return Err(RunError::OutOfOrder {
                expected: self.next_seq,
                got: line.seq,
            });
        }
        let applied = if self.is_ended() {
            Applied::AfterEnd
        } else {
            self.state = match (&self.state, &line.event) {
                (RunState::WaitingForApproval { .. }, HarnessEvent::ApprovalRequest { .. }) => {
                    return Err(RunError::ApprovalPending);
                }
                (_, HarnessEvent::ApprovalRequest { id, .. }) => RunState::WaitingForApproval { approval: id.clone() },
                (_, HarnessEvent::Result { outcome, .. }) => match outcome {
                    Outcome::Success => RunState::Finished,
                    Outcome::Error => RunState::Failed {
                        reason: FailReason::HarnessError,
                    },
                    Outcome::Rejected => RunState::Failed {
                        reason: FailReason::ApprovalRejected,
                    },
                },
                // Output can still arrive while an approval waits, from tool calls already running.
                (state, _) => state.clone(),
            };
            Applied::Recorded
        };
        self.next_seq += 1;
        Ok(applied)
    }

    /// Records an FDE's decision on the pending approval and returns the line to send to the harness.
    pub fn decide(&mut self, approval: &ApprovalId, outcome: ApprovalOutcome) -> Result<HarnessInput, RunError> {
        match &self.state {
            RunState::WaitingForApproval { approval: pending } if pending == approval => {}
            _ => return Err(RunError::NoSuchApproval(approval.clone())),
        }
        self.state = match outcome {
            ApprovalOutcome::Approved => RunState::Running,
            ApprovalOutcome::Rejected => RunState::Failed {
                reason: FailReason::ApprovalRejected,
            },
        };
        Ok(HarnessInput::ApprovalDecision {
            id: approval.clone(),
            outcome,
        })
    }

    /// The harness process ended. Without a result first, the run failed.
    pub fn harness_exited(&mut self) {
        if !self.is_ended() {
            self.state = RunState::Failed {
                reason: FailReason::HarnessExited,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use oryxa_core::TenantId;
    use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId};

    use super::*;
    use crate::event::{EVENT_VERSION, Usage};
    use crate::ids::ToolCallId;

    fn run() -> AgentRun {
        let scope = CompanyScope::new(TenantId::new("org_1").unwrap(), CompanyId::new("cmp_1").unwrap())
            .project(ProjectId::new("prj_1").unwrap());
        let mut run = AgentRun::new(AgentRunId::new("run_1").unwrap(), scope);
        run.start().unwrap();
        run
    }

    fn line(seq: u64, event: HarnessEvent) -> EventLine {
        EventLine {
            v: EVENT_VERSION,
            seq,
            event,
        }
    }

    fn message(seq: u64) -> EventLine {
        line(seq, HarnessEvent::Message { text: "working".into() })
    }

    fn approval(seq: u64, id: &str) -> EventLine {
        line(
            seq,
            HarnessEvent::ApprovalRequest {
                id: ApprovalId::new(id).unwrap(),
                tool_call_id: ToolCallId::new("toolu_9").unwrap(),
                action: "deploy".into(),
                title: "Run: wrangler deploy".into(),
                tool: "Bash".into(),
                input: serde_json::json!({ "command": "wrangler deploy" }),
            },
        )
    }

    fn result(seq: u64, outcome: Outcome) -> EventLine {
        line(
            seq,
            HarnessEvent::Result {
                outcome,
                reason: None,
                text: String::new(),
                turns: 1,
                usage: Usage::default(),
            },
        )
    }

    #[test]
    fn starts_once() {
        let mut r = run();
        assert_eq!(r.start(), Err(RunError::AlreadyStarted(RunState::Running)));
        let scope = r.scope().clone();
        let mut queued = AgentRun::new(AgentRunId::new("run_2").unwrap(), scope);
        assert_eq!(queued.apply(&message(0)), Err(RunError::NotStarted));
    }

    #[test]
    fn an_approval_pauses_the_run_until_approved() {
        let mut r = run();
        r.apply(&message(0)).unwrap();
        r.apply(&approval(1, "apr_1")).unwrap();
        let waiting = RunState::WaitingForApproval {
            approval: ApprovalId::new("apr_1").unwrap(),
        };
        assert_eq!(r.state(), &waiting);
        // Other output does not release it, and neither does a second request or a decision on another id.
        r.apply(&message(2)).unwrap();
        assert_eq!(r.state(), &waiting);
        assert_eq!(r.apply(&approval(3, "apr_2")), Err(RunError::ApprovalPending));
        let other = ApprovalId::new("apr_x").unwrap();
        assert_eq!(
            r.decide(&other, ApprovalOutcome::Approved),
            Err(RunError::NoSuchApproval(other))
        );
        assert_eq!(r.state(), &waiting);

        let id = ApprovalId::new("apr_1").unwrap();
        let input = r.decide(&id, ApprovalOutcome::Approved).unwrap();
        assert_eq!(
            input,
            HarnessInput::ApprovalDecision {
                id,
                outcome: ApprovalOutcome::Approved
            }
        );
        assert_eq!(r.state(), &RunState::Running);
        r.apply(&result(3, Outcome::Success)).unwrap();
        assert_eq!(r.state(), &RunState::Finished);
    }

    #[test]
    fn a_rejected_approval_ends_the_run() {
        let mut r = run();
        r.apply(&approval(0, "apr_1")).unwrap();
        let id = ApprovalId::new("apr_1").unwrap();
        r.decide(&id, ApprovalOutcome::Rejected).unwrap();
        let failed = RunState::Failed {
            reason: FailReason::ApprovalRejected,
        };
        assert_eq!(r.state(), &failed);
        assert!(r.is_ended());
        // The harness winds down; nothing it sends restarts the run.
        assert_eq!(r.apply(&message(1)), Ok(Applied::AfterEnd));
        assert_eq!(r.apply(&result(2, Outcome::Success)), Ok(Applied::AfterEnd));
        assert_eq!(r.state(), &failed);
        assert_eq!(
            r.decide(&id, ApprovalOutcome::Approved),
            Err(RunError::NoSuchApproval(id))
        );
    }

    #[test]
    fn replays_are_idempotent_and_gaps_are_refused() {
        let mut r = run();
        r.apply(&message(0)).unwrap();
        assert_eq!(r.apply(&message(0)), Ok(Applied::Duplicate));
        assert_eq!(r.apply(&message(2)), Err(RunError::OutOfOrder { expected: 1, got: 2 }));
        assert_eq!(r.apply(&message(1)), Ok(Applied::Recorded));
    }

    #[test]
    fn results_end_the_run() {
        let mut r = run();
        r.apply(&result(0, Outcome::Error)).unwrap();
        assert_eq!(
            r.state(),
            &RunState::Failed {
                reason: FailReason::HarnessError
            }
        );
        let mut r = run();
        r.apply(&result(0, Outcome::Rejected)).unwrap();
        assert_eq!(
            r.state(),
            &RunState::Failed {
                reason: FailReason::ApprovalRejected
            }
        );
    }

    #[test]
    fn a_harness_that_exits_without_a_result_fails_the_run() {
        let mut r = run();
        r.apply(&message(0)).unwrap();
        r.harness_exited();
        assert_eq!(
            r.state(),
            &RunState::Failed {
                reason: FailReason::HarnessExited
            }
        );
        let mut done = run();
        done.apply(&result(0, Outcome::Success)).unwrap();
        done.harness_exited();
        assert_eq!(done.state(), &RunState::Finished);
    }

    #[test]
    fn state_serialises_with_a_tag() {
        let state = RunState::WaitingForApproval {
            approval: ApprovalId::new("apr_1").unwrap(),
        };
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            r#"{"state":"waiting_for_approval","approval":"apr_1"}"#
        );
    }
}
