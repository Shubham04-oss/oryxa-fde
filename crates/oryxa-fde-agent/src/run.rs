//! An agent run moves queued -> running -> finished or failed. An action on the company's approval list holds it
//! in waiting-for-approval until an FDE decides; a rejection ends it. The API can cancel a run, or end it at its time
//! limit, from any state.
//!
//! The orchestrator applies a run's harness lines and its decisions in one order: a decision is confirmed delivered
//! (or not) before the next line is applied.

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
    /// The harness ended while an approval was still undecided.
    ApprovalUndecided,
    /// An FDE's decision could not be delivered to the harness.
    DecisionUndelivered,
    /// The harness reported an error result.
    HarnessError,
    /// The harness process ended without a result.
    HarnessExited,
    /// Cancelled through the API.
    Cancelled,
    /// The run reached its time limit.
    TimedOut,
    /// The project's agent minutes or model spend ran out.
    OverBudget,
    /// The harness sent output that does not parse or skips a line; nothing after it can be trusted.
    BadOutput,
    /// The sandbox, the checkout or the context pack could not be prepared.
    SetupFailed,
    /// The run store could not keep the transcript or an approval request, so no approval could be decided.
    StoreUnavailable,
}

/// Why the API ends a run itself, besides a cancel or the time limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    OverBudget,
    BadOutput,
    SetupFailed,
    StoreUnavailable,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RunError {
    #[error("the run has not started")]
    NotStarted,
    #[error("the run is already {0:?}")]
    AlreadyStarted(RunState),
    #[error("the run has ended")]
    Ended,
    #[error("expected event {expected}, got {got}")]
    OutOfOrder { expected: u64, got: u64 },
    #[error("an approval is already pending")]
    ApprovalPending,
    #[error("no pending approval {0}")]
    NoSuchApproval(ApprovalId),
    #[error("a decision on {0} is already on its way to the harness")]
    DecisionInFlight(ApprovalId),
    #[error("no decision on {0} is on its way to the harness")]
    NoDecision(ApprovalId),
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
    /// A decision on the pending approval that is on its way to the harness, not yet confirmed delivered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deciding: Option<ApprovalOutcome>,
}

impl AgentRun {
    pub fn new(id: AgentRunId, scope: ProjectScope) -> Self {
        Self {
            id,
            scope,
            state: RunState::Queued,
            next_seq: 0,
            deciding: None,
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
            let next = match (&self.state, &line.event) {
                (RunState::WaitingForApproval { .. }, HarnessEvent::ApprovalRequest { .. }) => {
                    return Err(RunError::ApprovalPending);
                }
                (_, HarnessEvent::ApprovalRequest { id, .. }) => RunState::WaitingForApproval { approval: id.clone() },
                // The harness ended without the FDE's decision (its stdin closed, or it was aborted). Whatever it
                // reports, the action was never approved, so the run cannot have succeeded.
                (RunState::WaitingForApproval { .. }, HarnessEvent::Result { .. }) => RunState::Failed {
                    reason: FailReason::ApprovalUndecided,
                },
                (_, HarnessEvent::Result { outcome, .. }) => match outcome {
                    Outcome::Success => RunState::Finished,
                    Outcome::Error => RunState::Failed {
                        reason: FailReason::HarnessError,
                    },
                    Outcome::Rejected => RunState::Failed {
                        reason: FailReason::ApprovalRejected,
                    },
                    Outcome::Cancelled => RunState::Failed {
                        reason: FailReason::Cancelled,
                    },
                },
                // Output can still arrive while an approval waits, from tool calls already running.
                (state, _) => state.clone(),
            };
            self.set(next);
            Applied::Recorded
        };
        self.next_seq += 1;
        Ok(applied)
    }

    /// Records an FDE's decision on the pending approval and returns the line to send to the harness. The state
    /// changes only when `delivered` confirms the harness has the line; until then a second decision is refused.
    pub fn decide(&mut self, approval: &ApprovalId, outcome: ApprovalOutcome) -> Result<HarnessInput, RunError> {
        self.pending(approval)?;
        if self.deciding.is_some() {
            return Err(RunError::DecisionInFlight(approval.clone()));
        }
        self.deciding = Some(outcome);
        Ok(HarnessInput::ApprovalDecision {
            id: approval.clone(),
            outcome,
        })
    }

    /// The decision reached the harness: an approval resumes the run, a rejection ends it.
    pub fn delivered(&mut self, approval: &ApprovalId) -> Result<(), RunError> {
        self.pending(approval)?;
        let outcome = self
            .deciding
            .take()
            .ok_or_else(|| RunError::NoDecision(approval.clone()))?;
        self.set(match outcome {
            ApprovalOutcome::Approved => RunState::Running,
            ApprovalOutcome::Rejected => RunState::Failed {
                reason: FailReason::ApprovalRejected,
            },
        });
        Ok(())
    }

    /// The decision could not be written to the harness, which still waits. Fails closed: the run ends, and the
    /// caller stops the harness rather than retry into an unknown state.
    pub fn undelivered(&mut self, approval: &ApprovalId) -> Result<(), RunError> {
        self.pending(approval)?;
        if self.deciding.is_none() {
            return Err(RunError::NoDecision(approval.clone()));
        }
        self.set(RunState::Failed {
            reason: FailReason::DecisionUndelivered,
        });
        Ok(())
    }

    /// Cancels the run, whatever it is doing. Returns the line that tells a running harness to stop; if it cannot
    /// be delivered, the caller stops the harness's process.
    pub fn cancel(&mut self) -> Result<HarnessInput, RunError> {
        self.end(FailReason::Cancelled)
    }

    /// The run reached its time limit; ends it like `cancel`.
    pub fn time_out(&mut self) -> Result<HarnessInput, RunError> {
        self.end(FailReason::TimedOut)
    }

    /// Ends the run for `reason`, like `cancel`.
    pub fn stop(&mut self, reason: StopReason) -> Result<HarnessInput, RunError> {
        self.end(match reason {
            StopReason::OverBudget => FailReason::OverBudget,
            StopReason::BadOutput => FailReason::BadOutput,
            StopReason::SetupFailed => FailReason::SetupFailed,
            StopReason::StoreUnavailable => FailReason::StoreUnavailable,
        })
    }

    /// The harness process ended. Without a result first, the run failed.
    pub fn harness_exited(&mut self) {
        if !self.is_ended() {
            self.set(RunState::Failed {
                reason: FailReason::HarnessExited,
            });
        }
    }

    fn pending(&self, approval: &ApprovalId) -> Result<(), RunError> {
        match &self.state {
            RunState::WaitingForApproval { approval: pending } if pending == approval => Ok(()),
            _ => Err(RunError::NoSuchApproval(approval.clone())),
        }
    }

    fn end(&mut self, reason: FailReason) -> Result<HarnessInput, RunError> {
        if self.is_ended() {
            return Err(RunError::Ended);
        }
        self.set(RunState::Failed { reason });
        Ok(HarnessInput::Cancel)
    }

    // A decision in flight belongs to the approval it was made on; leaving that state drops it.
    fn set(&mut self, state: RunState) {
        if !matches!(state, RunState::WaitingForApproval { .. }) {
            self.deciding = None;
        }
        self.state = state;
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
                id: id.clone(),
                outcome: ApprovalOutcome::Approved
            }
        );
        // Still waiting until the harness has the decision.
        assert_eq!(r.state(), &waiting);
        r.delivered(&id).unwrap();
        assert_eq!(r.state(), &RunState::Running);
        r.apply(&result(3, Outcome::Success)).unwrap();
        assert_eq!(r.state(), &RunState::Finished);
    }

    #[test]
    fn a_decision_changes_the_run_only_once_delivered() {
        let mut r = run();
        r.apply(&approval(0, "apr_1")).unwrap();
        let id = ApprovalId::new("apr_1").unwrap();
        let waiting = r.state().clone();
        assert_eq!(r.delivered(&id), Err(RunError::NoDecision(id.clone())));
        r.decide(&id, ApprovalOutcome::Rejected).unwrap();
        assert_eq!(r.state(), &waiting);
        // One decision at a time: a second, even a different one, is refused while the first is on its way.
        assert_eq!(
            r.decide(&id, ApprovalOutcome::Approved),
            Err(RunError::DecisionInFlight(id.clone()))
        );
        r.delivered(&id).unwrap();
        assert_eq!(
            r.state(),
            &RunState::Failed {
                reason: FailReason::ApprovalRejected
            }
        );
    }

    #[test]
    fn an_undelivered_decision_fails_the_run() {
        let mut r = run();
        r.apply(&approval(0, "apr_1")).unwrap();
        let id = ApprovalId::new("apr_1").unwrap();
        assert_eq!(r.undelivered(&id), Err(RunError::NoDecision(id.clone())));
        r.decide(&id, ApprovalOutcome::Approved).unwrap();
        r.undelivered(&id).unwrap();
        assert_eq!(
            r.state(),
            &RunState::Failed {
                reason: FailReason::DecisionUndelivered
            }
        );
        // The approval is gone: a late confirmation or a new decision changes nothing.
        assert_eq!(r.delivered(&id), Err(RunError::NoSuchApproval(id.clone())));
        assert_eq!(
            r.decide(&id, ApprovalOutcome::Approved),
            Err(RunError::NoSuchApproval(id))
        );
    }

    #[test]
    fn a_result_while_waiting_never_finishes_the_run() {
        for outcome in [Outcome::Success, Outcome::Error, Outcome::Rejected, Outcome::Cancelled] {
            let mut r = run();
            r.apply(&approval(0, "apr_1")).unwrap();
            r.apply(&result(1, outcome)).unwrap();
            assert_eq!(
                r.state(),
                &RunState::Failed {
                    reason: FailReason::ApprovalUndecided
                },
                "{outcome:?}"
            );
            let id = ApprovalId::new("apr_1").unwrap();
            assert_eq!(
                r.decide(&id, ApprovalOutcome::Approved),
                Err(RunError::NoSuchApproval(id))
            );
        }
        // Also with a decision on its way: it was never confirmed, so the run did not succeed.
        let mut r = run();
        r.apply(&approval(0, "apr_1")).unwrap();
        let id = ApprovalId::new("apr_1").unwrap();
        r.decide(&id, ApprovalOutcome::Approved).unwrap();
        r.apply(&result(1, Outcome::Success)).unwrap();
        assert_eq!(
            r.state(),
            &RunState::Failed {
                reason: FailReason::ApprovalUndecided
            }
        );
        assert_eq!(r.delivered(&id), Err(RunError::NoSuchApproval(id)));
    }

    #[test]
    fn cancel_and_time_out_end_the_run_from_any_state() {
        let scope = run().scope().clone();
        let queued = || AgentRun::new(AgentRunId::new("run_2").unwrap(), scope.clone());
        let running = run;
        let waiting = || {
            let mut r = run();
            r.apply(&approval(0, "apr_1")).unwrap();
            r
        };
        let deciding = || {
            let mut r = waiting();
            r.decide(&ApprovalId::new("apr_1").unwrap(), ApprovalOutcome::Approved)
                .unwrap();
            r
        };
        for make in [&queued as &dyn Fn() -> AgentRun, &running, &waiting, &deciding] {
            let mut r = make();
            assert_eq!(r.cancel(), Ok(HarnessInput::Cancel));
            assert_eq!(
                r.state(),
                &RunState::Failed {
                    reason: FailReason::Cancelled
                }
            );
            assert_eq!(r.cancel(), Err(RunError::Ended));
            assert_eq!(r.time_out(), Err(RunError::Ended));

            let mut r = make();
            assert_eq!(r.time_out(), Ok(HarnessInput::Cancel));
            assert_eq!(
                r.state(),
                &RunState::Failed {
                    reason: FailReason::TimedOut
                }
            );
        }
        for (reason, failed) in [
            (StopReason::OverBudget, FailReason::OverBudget),
            (StopReason::BadOutput, FailReason::BadOutput),
            (StopReason::SetupFailed, FailReason::SetupFailed),
            (StopReason::StoreUnavailable, FailReason::StoreUnavailable),
        ] {
            let mut r = waiting();
            assert_eq!(r.stop(reason), Ok(HarnessInput::Cancel));
            assert_eq!(r.state(), &RunState::Failed { reason: failed });
            assert_eq!(r.stop(reason), Err(RunError::Ended));
        }
        // A cancelled queued run never starts, and a cancelled one ignores what the harness sends while stopping.
        let mut r = queued();
        r.cancel().unwrap();
        assert!(matches!(r.start(), Err(RunError::AlreadyStarted(_))));
        let mut r = deciding();
        r.cancel().unwrap();
        let id = ApprovalId::new("apr_1").unwrap();
        assert_eq!(r.delivered(&id), Err(RunError::NoSuchApproval(id)));
        assert_eq!(r.apply(&result(1, Outcome::Cancelled)), Ok(Applied::AfterEnd));
        assert_eq!(
            r.state(),
            &RunState::Failed {
                reason: FailReason::Cancelled
            }
        );
    }

    #[test]
    fn finished_runs_cannot_be_cancelled() {
        let mut r = run();
        r.apply(&result(0, Outcome::Success)).unwrap();
        assert_eq!(r.cancel(), Err(RunError::Ended));
        assert_eq!(r.state(), &RunState::Finished);
    }

    #[test]
    fn a_rejected_approval_ends_the_run() {
        let mut r = run();
        r.apply(&approval(0, "apr_1")).unwrap();
        let id = ApprovalId::new("apr_1").unwrap();
        r.decide(&id, ApprovalOutcome::Rejected).unwrap();
        r.delivered(&id).unwrap();
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
        let mut r = run();
        r.apply(&result(0, Outcome::Cancelled)).unwrap();
        assert_eq!(
            r.state(),
            &RunState::Failed {
                reason: FailReason::Cancelled
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
