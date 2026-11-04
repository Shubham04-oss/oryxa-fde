//! The rules, one per event the engine consumes. Each runs in one transaction under the event's
//! project scope and first records the event id there, so a redelivered event finds it and
//! changes nothing:
//! - an access request granted unblocks the project's tasks blocked on it;
//! - a finished eval run lands in the activity, and if every success criterion now meets its
//!   target (and the project is not yet deploying), raises a "ready to deploy" suggestion; the
//!   stage itself never moves;
//! - a finished agent run and a merged pull request land in the activity.

use oryxa_core::TenantId;
use oryxa_events::{Event, Verifier, decode};
use oryxa_fde_core::{Stage, TaskId};
use oryxa_fde_events::inbox::{Message, Outcome, refusal};
use oryxa_fde_events::{
    AccessRequestStatusChanged, AccessStatus, AgentRunFinished, EvalRunFinished, PullRequestMerged,
};
use oryxa_fde_store::{ActivityIn, Store, StoreError, SuggestionKind, engine_actor};
use serde::de::DeserializeOwned;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// What a rule did with one event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Applied {
    /// The tasks blocked on the granted access request, now back to do.
    Unblocked(Vec<TaskId>),
    /// Recorded in the project's activity; `suggested` if it raised "ready to deploy".
    Recorded { suggested: bool },
    /// Nothing for the rules to do (an access change other than a grant, say).
    Nothing,
    /// Acted on before: nothing changed.
    Redelivered,
}

/// A verified event: the id the rules act on once, when it happened, and its payload.
#[derive(Debug, Clone)]
pub struct Fact<T> {
    pub event_id: String,
    pub occurred_at: OffsetDateTime,
    pub tenant: TenantId,
    pub data: T,
}

/// Verifies the message as `T`; any failure quarantines it, never acts on it.
pub fn fact<T: Event + DeserializeOwned>(verifier: &Verifier, msg: &Message) -> Result<Fact<T>, Outcome> {
    let v = decode::<T>(verifier, &msg.source, &msg.detail_type, &msg.detail).map_err(|e| {
        tracing::error!(reason = refusal(&e), detail_type = %msg.detail_type, "event refused");
        Outcome::Quarantine
    })?;
    // Verified from here on, so its id can be logged to find it in the bus archive.
    let occurred_at = OffsetDateTime::parse(&v.envelope.occurred_at, &Rfc3339).map_err(|_| {
        tracing::error!(event_id = %v.envelope.event_id, detail_type = %msg.detail_type, "event time unreadable");
        Outcome::Quarantine
    })?;
    Ok(Fact {
        event_id: v.envelope.event_id,
        occurred_at,
        tenant: v.tenant,
        data: v.data,
    })
}

/// Handles one message from the engine's queue. Events the engine has no rule for are not its to
/// act on and are deleted; a store failure that may pass leaves the event for redelivery, and one
/// that would fail the same way again quarantines it (see [`outcome`]).
pub async fn handle(store: &Store, verifier: &Verifier, msg: &Message) -> Outcome {
    let t = msg.detail_type.as_str();
    let (event_id, applied) = if t == AccessRequestStatusChanged::DETAIL_TYPE {
        match fact(verifier, msg) {
            Ok(f) => (f.event_id.clone(), on_access_changed(store, &f).await),
            Err(o) => return o,
        }
    } else if t == EvalRunFinished::DETAIL_TYPE {
        match fact(verifier, msg) {
            Ok(f) => (f.event_id.clone(), on_eval_run(store, &f).await),
            Err(o) => return o,
        }
    } else if t == AgentRunFinished::DETAIL_TYPE {
        match fact(verifier, msg) {
            Ok(f) => (f.event_id.clone(), on_agent_run(store, &f).await),
            Err(o) => return o,
        }
    } else if t == PullRequestMerged::DETAIL_TYPE {
        match fact(verifier, msg) {
            Ok(f) => (f.event_id.clone(), on_pull_request(store, &f).await),
            Err(o) => return o,
        }
    } else {
        return Outcome::Done;
    };
    outcome(t, &event_id, applied)
}

/// A rule's result as the queue's outcome. Only a failure that may pass (the database unreachable
/// or busy) is retried; one of the data is quarantined, and the queue deletes a quarantined
/// message, so it does not hold up the project's FIFO group until the dead-letter queue. The
/// verified event id is logged, to find the event in the bus archive.
pub fn outcome(detail_type: &str, event_id: &str, applied: Result<Applied, StoreError>) -> Outcome {
    match applied {
        Ok(applied) => {
            tracing::info!(detail_type, event_id, ?applied, "lifecycle rule applied");
            Outcome::Done
        }
        Err(e) if e.is_permanent() => {
            tracing::error!(detail_type, event_id, error = %e, "lifecycle rule cannot apply; quarantined");
            Outcome::Quarantine
        }
        Err(e) => {
            tracing::warn!(detail_type, event_id, error = %e, "lifecycle rule failed; will retry");
            Outcome::Retry
        }
    }
}

/// A granted access request unblocks the tasks blocked on it, if the store still has it granted:
/// a grant delivered after a revocation unblocks nothing.
pub async fn on_access_changed(store: &Store, f: &Fact<AccessRequestStatusChanged>) -> Result<Applied, StoreError> {
    let mut tx = store.project(&f.data.scope(&f.tenant)).await?;
    if !tx.first_delivery(&f.event_id).await? {
        return Ok(Applied::Redelivered);
    }
    let applied = if f.data.to == AccessStatus::Granted {
        let by = engine_actor(&f.event_id)?;
        Applied::Unblocked(tx.unblock_tasks_blocked_by(&f.data.access_request, &by).await?)
    } else {
        Applied::Nothing
    };
    tx.commit().await?;
    Ok(applied)
}

/// A finished eval run lands in the activity; if every criterion now meets its target, and the
/// project is not yet at deploy, it raises "ready to deploy".
pub async fn on_eval_run(store: &Store, f: &Fact<EvalRunFinished>) -> Result<Applied, StoreError> {
    let mut tx = store.project(&f.data.scope(&f.tenant)).await?;
    if !tx.first_delivery(&f.event_id).await? {
        return Ok(Applied::Redelivered);
    }
    let what = ActivityIn::EvalRun {
        run: f.data.eval_run.clone(),
        passed: f.data.passed,
        failed: f.data.failed,
    };
    tx.record_activity(&f.event_id, &what, f.occurred_at).await?;
    let before_deploy = tx.get().await?.is_some_and(|p| p.stage < Stage::Deploy);
    let suggested = before_deploy
        && tx.criteria_met().await?
        && tx
            .raise_suggestion(SuggestionKind::ReadyToDeploy, &f.data.eval_run)
            .await?;
    tx.commit().await?;
    Ok(Applied::Recorded { suggested })
}

/// A finished agent run lands in the activity.
pub async fn on_agent_run(store: &Store, f: &Fact<AgentRunFinished>) -> Result<Applied, StoreError> {
    let what = ActivityIn::AgentRun {
        run: f.data.agent_run.clone(),
        outcome: f.data.outcome,
    };
    record(store, f, &f.data.scope(&f.tenant), &what).await
}

/// A merged pull request lands in the activity.
pub async fn on_pull_request(store: &Store, f: &Fact<PullRequestMerged>) -> Result<Applied, StoreError> {
    let what = ActivityIn::PullRequest { number: f.data.number };
    record(store, f, &f.data.scope(&f.tenant), &what).await
}

async fn record<T>(
    store: &Store,
    f: &Fact<T>,
    scope: &oryxa_fde_core::ProjectScope,
    what: &ActivityIn,
) -> Result<Applied, StoreError> {
    let mut tx = store.project(scope).await?;
    if !tx.first_delivery(&f.event_id).await? {
        return Ok(Applied::Redelivered);
    }
    tx.record_activity(&f.event_id, what, f.occurred_at).await?;
    tx.commit().await?;
    Ok(Applied::Recorded { suggested: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_failure_that_may_pass_is_retried() {
        let t = "fde.access-request.status-changed.v1";
        assert_eq!(outcome(t, "evt_1", Ok(Applied::Nothing)), Outcome::Done);
        for permanent in [
            StoreError::Rejected("value"),
            StoreError::Corrupt("task id"),
            StoreError::Conflict,
        ] {
            assert_eq!(outcome(t, "evt_1", Err(permanent)), Outcome::Quarantine);
        }
        assert_eq!(outcome(t, "evt_1", Err(StoreError::Db(sqlx_io()))), Outcome::Retry);
    }

    fn sqlx_io() -> sqlx::Error {
        sqlx::Error::Io(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset"))
    }
}
