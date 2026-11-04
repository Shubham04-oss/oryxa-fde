//! Drives one run from queued to ended, in one task, so its harness lines and the FDE's decisions are applied in a
//! single order (as `AgentRun` requires):
//!
//! 1. Wait for the company's sandbox (one run at a time), then check the project's budget.
//! 2. Build the context pack, start the sandbox, check out the repository, write the pack and check the digest
//!    read back, then start the harness on it.
//! 3. Apply the harness's lines; store the transcript and approval requests, and stream lines live. Decisions and
//!    cancels arrive through the store. The run stops at its time limit or when its budget runs out.
//! 4. Put a finished run's work on a branch with a draft pull request, then record the end and its
//!    `agent_run.finished` event together.
//!
//! Everything fails closed: a store, gateway or digest failure stops the run, and a harness that does not stop
//! when told to has its sandbox destroyed.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use oryxa_fde_core::{AgentRunId, CompanyScope, ProjectScope};
use oryxa_fde_events::RunOutcome;
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};

use crate::context::ContextPack;
use crate::event::{ApprovalOutcome, HarnessEvent, HarnessInput, ToolStatus, parse_line};
use crate::gateway::{Exec, HarnessProcess, ProcessEvent, Sandbox};
use crate::git::{self, Delivery};
use crate::ids::{ApprovalId, ToolCallId};
use crate::live::LiveOutput;
use crate::run::{Applied, FailReason, RunState, StopReason};
use crate::service::{Deps, Remaining, Runs, remaining};
use crate::store::{ApprovalRecord, RunRecord, RunStore, Spend};

const LIVE_QUEUE: usize = 1024;
const LIVE_BATCH: usize = 100;

pub(crate) async fn drive<D: Deps>(runs: Arc<Runs<D>>, scope: ProjectScope, id: AgentRunId) {
    let slot = runs.company_slot(&scope.company);
    let _turn = slot.lock().await;
    let record = match runs.store.run(&scope, &id).await {
        Ok(Some(record)) => record,
        Ok(None) => return,
        Err(e) => {
            tracing::error!(error = %e, run = %id, "could not load the run to start it");
            return;
        }
    };
    let mut driver = Driver {
        runs,
        scope,
        record,
        exec: None,
        actions: BTreeSet::new(),
        grants: BTreeMap::new(),
        started: None,
    };
    driver.run().await;
}

/// How the run's own task ends it, besides the harness's result.
#[derive(Debug, Clone, Copy)]
enum Stop {
    Cancel,
    TimeLimit,
    Reason(StopReason),
}

struct Driver<D: Deps> {
    runs: Arc<Runs<D>>,
    scope: ProjectScope,
    record: RunRecord,
    /// The harness's exec id, for its stdin.
    exec: Option<String>,
    /// The actions on the run's approval list.
    actions: BTreeSet<String>,
    /// Hosts opened for an approved tool call, by that call: closed as soon as it returns.
    grants: BTreeMap<ToolCallId, (String, ApprovalId)>,
    started: Option<Instant>,
}

impl<D: Deps> Driver<D> {
    fn company(&self) -> &CompanyScope {
        &self.scope.company
    }

    fn id(&self) -> &AgentRunId {
        self.record.run.id()
    }

    async fn run(&mut self) {
        if self.record.run.is_ended() {
            return;
        }
        match self.runs.store.cancel_requested(&self.scope, self.id()).await {
            Ok(false) => {}
            Ok(true) => {
                let _ = self.record.run.cancel();
                return self.finish().await;
            }
            Err(_) => {
                let _ = self.record.run.stop(StopReason::StoreUnavailable);
                return self.finish().await;
            }
        }
        let left = match self.runs.budget(&self.scope).await {
            Ok((budget, spent)) => remaining(budget, spent),
            Err(_) => {
                let _ = self.record.run.stop(StopReason::StoreUnavailable);
                return self.finish().await;
            }
        };
        let Some(left) = left else {
            let _ = self.record.run.stop(StopReason::OverBudget);
            return self.finish().await;
        };
        let limit = Duration::from_secs(left.seconds).min(self.runs.config.max_run);
        match self.prepare(limit).await {
            Ok(process) => self.watch(process, left, limit).await,
            Err(step) => {
                tracing::warn!(run = %self.id(), step, "run setup failed");
                let _ = self.record.run.stop(StopReason::SetupFailed);
            }
        }
        self.finish().await;
    }

    /// Builds and writes the pack, prepares the sandbox and starts the harness. Errors name the step only.
    async fn prepare(&mut self, limit: Duration) -> Result<HarnessProcess, &'static str> {
        let runs = self.runs.clone();
        let company = self.company().clone();
        let pack = ContextPack::build(
            &runs.context,
            self.id().clone(),
            self.scope.clone(),
            self.record.task.clone(),
        )
        .await
        .map_err(|_| "context")?;
        self.actions = pack.config.approvals.iter().map(|r| r.action.clone()).collect();
        // Every action on the approval list must have its hosts held at the gateway, or approving it would gate
        // nothing an obfuscated command or a background process could not reach anyway.
        let held = runs
            .sandbox
            .held_actions(&company)
            .await
            .map_err(|_| "outbound policy")?;
        if !self.actions.is_subset(&held) {
            return Err("approval action without a held host");
        }
        let pack = pack.encode().map_err(|_| "context")?;
        runs.sandbox.start(&company).await.map_err(|_| "sandbox")?;
        for step in git::prepare(&self.record.repository) {
            let out = runs.sandbox.exec(&company, step).await.map_err(|_| "checkout")?;
            if !out.ok() {
                return Err("checkout");
            }
        }
        let on_disk = runs
            .sandbox
            .write_pack(&company, self.id(), pack.bytes.clone())
            .await
            .map_err(|_| "context pack")?;
        pack.check_written(&on_disk).map_err(|_| "context pack digest")?;
        self.record.run.start().map_err(|_| "start")?;
        self.record.started_at = Some(OffsetDateTime::now_utc());
        runs.store.update(&self.record).await.map_err(|_| "store")?;
        // The gateway's own limit is the hard stop if this task is gone.
        let hard_limit = limit + runs.config.grace + runs.config.grace;
        let process = runs
            .sandbox
            .start_harness(&company, self.id(), &pack.sha256, hard_limit)
            .await
            .map_err(|_| "harness")?;
        self.exec = Some(process.exec.clone());
        self.started = Some(Instant::now());
        Ok(process)
    }

    async fn watch(&mut self, mut process: HarnessProcess, left: Remaining, limit: Duration) {
        let live = live_forwarder(self.runs.clone(), self.scope.clone(), self.id().clone());
        let started = self.started.unwrap_or_else(Instant::now);
        let over_budget = Duration::from_secs(left.seconds) <= self.runs.config.max_run;
        let deadline = sleep_until(started + limit);
        tokio::pin!(deadline);
        let mut changes = self.runs.watch();
        let mut poll = tokio::time::interval(self.runs.config.poll);
        let mut stopping: Option<Instant> = None;
        loop {
            let grace = async {
                match stopping {
                    Some(at) => sleep_until(at + self.runs.config.grace).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                biased;
                event = process.output.recv() => match event {
                    Some(ProcessEvent::Line(line)) => self.line(&line, &live, left).await,
                    Some(ProcessEvent::Invalid) => self.stop(Stop::Reason(StopReason::BadOutput)).await,
                    Some(ProcessEvent::Exited { .. }) => {
                        self.record.run.harness_exited();
                        break;
                    }
                    None => {
                        // The stream was lost and the harness may still run: stop it the hard way.
                        tracing::warn!(run = %self.id(), "lost the harness's output");
                        self.record.run.harness_exited();
                        self.hard_stop().await;
                        break;
                    }
                },
                () = &mut deadline, if !self.record.run.is_ended() => {
                    let why = if over_budget { Stop::Reason(StopReason::OverBudget) } else { Stop::TimeLimit };
                    self.stop(why).await;
                }
                () = grace => {
                    tracing::warn!(run = %self.id(), "the harness did not stop in time");
                    self.record.run.harness_exited();
                    self.hard_stop().await;
                    break;
                }
                Ok(()) = changes.changed() => self.requests().await,
                _ = poll.tick() => self.requests().await,
            }
            if self.record.run.is_ended() && stopping.is_none() {
                stopping = Some(Instant::now());
            }
        }
        // Keep what the run model ended with.
        self.save().await;
    }

    async fn line(&mut self, raw: &str, live: &mpsc::Sender<String>, left: Remaining) {
        let Ok(line) = parse_line(raw) else {
            return self.stop(Stop::Reason(StopReason::BadOutput)).await;
        };
        let before = self.record.run.state().clone();
        let applied = match self.record.run.apply(&line) {
            Ok(Applied::Duplicate) => return,
            Ok(applied) => applied,
            Err(_) => return self.stop(Stop::Reason(StopReason::BadOutput)).await,
        };
        // Without its transcript and approval requests, nobody could review or decide the run: stop it.
        if self
            .runs
            .store
            .append_event(&self.scope, self.id(), &line)
            .await
            .is_err()
        {
            return self.stop(Stop::Reason(StopReason::StoreUnavailable)).await;
        }
        // Live output is best effort and never holds the run up.
        let _ = live.try_send(raw.to_owned());
        let mut save = self.record.run.state() != &before;
        match line.event {
            // Only actions on the run's own approval list can ever be granted.
            HarnessEvent::ApprovalRequest { ref action, .. } if !self.actions.contains(action) => {
                return self.stop(Stop::Reason(StopReason::BadOutput)).await;
            }
            HarnessEvent::ToolCall {
                ref id,
                status: ToolStatus::Completed | ToolStatus::Failed,
                ..
            } if self.grants.contains_key(id) => {
                // The approved call returned: its hosts close now, so nothing after it can use them.
                if let Some((action, approval)) = self.grants.remove(id) {
                    self.close_grant(&action, &approval).await;
                }
            }
            HarnessEvent::ApprovalRequest {
                id,
                tool_call_id,
                action,
                title,
                tool,
                input,
            } if applied == Applied::Recorded => {
                let approval = ApprovalRecord {
                    id,
                    run: self.id().clone(),
                    tool_call_id,
                    action,
                    title,
                    tool,
                    input,
                    requested_at: OffsetDateTime::now_utc(),
                    decision: None,
                };
                if self.runs.store.add_approval(&self.scope, &approval).await.is_err() {
                    return self.stop(Stop::Reason(StopReason::StoreUnavailable)).await;
                }
            }
            HarnessEvent::Usage { usage } | HarnessEvent::Result { usage, .. } => {
                self.record.usage = self.record.usage.max(usage);
                save = true;
                if self.runs.config.pricing.cost(self.record.usage) >= left.usd_micros && !self.record.run.is_ended() {
                    return self.stop(Stop::Reason(StopReason::OverBudget)).await;
                }
            }
            _ => {}
        }
        if save {
            self.save().await;
        }
    }

    /// Acts on what the store holds for this run: a cancel, or the decision on the approval it waits for.
    async fn requests(&mut self) {
        if self.record.run.is_ended() {
            return;
        }
        match self.runs.store.cancel_requested(&self.scope, self.id()).await {
            Ok(false) => {}
            Ok(true) => return self.stop(Stop::Cancel).await,
            Err(_) => return self.stop(Stop::Reason(StopReason::StoreUnavailable)).await,
        }
        let RunState::WaitingForApproval { approval } = self.record.run.state().clone() else {
            return;
        };
        let approvals = match self.runs.store.approvals(&self.scope, self.id()).await {
            Ok(list) => list,
            Err(_) => return self.stop(Stop::Reason(StopReason::StoreUnavailable)).await,
        };
        let Some(pending) = approvals.into_iter().find(|a| a.id == approval) else {
            // The request was stored before the run could wait on it; its absence means the store lost it.
            return self.stop(Stop::Reason(StopReason::StoreUnavailable)).await;
        };
        let Some(decided) = pending.decision else {
            return;
        };
        let Ok(input) = self.record.run.decide(&approval, decided.outcome) else {
            return;
        };
        let company = self.company().clone();
        if decided.outcome == ApprovalOutcome::Approved {
            if !self.actions.contains(&pending.action) {
                let _ = self.record.run.undelivered(&approval);
                return self.hard_stop().await;
            }
            let opened = self
                .runs
                .sandbox
                .open_grant(
                    &company,
                    &pending.action,
                    &approval,
                    self.id(),
                    self.runs.config.grant_ttl,
                )
                .await;
            if opened.is_err() {
                // Without its hosts the approved action would fail half-way; refuse it instead.
                let _ = self.record.run.undelivered(&approval);
                return self.hard_stop().await;
            }
            self.grants
                .insert(pending.tool_call_id, (pending.action, approval.clone()));
        }
        if self.deliver_input(input).await {
            let _ = self.record.run.delivered(&approval);
            self.save().await;
        } else {
            let _ = self.record.run.undelivered(&approval);
            self.hard_stop().await;
        }
    }

    async fn stop(&mut self, why: Stop) {
        let input = match why {
            Stop::Cancel => self.record.run.cancel(),
            Stop::TimeLimit => self.record.run.time_out(),
            Stop::Reason(reason) => self.record.run.stop(reason),
        };
        let Ok(input) = input else {
            return;
        };
        self.save().await;
        if self.exec.is_some() && !self.deliver_input(input).await {
            self.hard_stop().await;
        }
    }

    async fn deliver_input(&self, input: HarnessInput) -> bool {
        let Some(exec) = &self.exec else {
            return false;
        };
        self.runs
            .sandbox
            .write_stdin(self.company(), exec, input.to_line())
            .await
            .is_ok()
    }

    /// Destroys the company's sandbox: the harness and everything the agent left running go with it.
    async fn hard_stop(&mut self) {
        if let Err(e) = self.runs.sandbox.stop(self.company()).await {
            tracing::error!(error = %e, run = %self.id(), "could not stop the sandbox");
        }
        self.exec = None;
        // Grants are closed when the sandbox stops.
        self.grants.clear();
    }

    async fn save(&mut self) {
        if let Err(e) = self.runs.store.update(&self.record).await {
            tracing::error!(error = %e, run = %self.id(), "could not save the run");
        }
    }

    async fn close_grant(&self, action: &str, approval: &ApprovalId) {
        if let Err(e) = self.runs.sandbox.close_grant(self.company(), action, approval).await {
            tracing::warn!(error = %e, run = %self.id(), "could not close a grant; it expires on its own");
        }
    }

    async fn finish(&mut self) {
        // Calls that never returned (the run was stopped) lose their hosts too.
        for (action, approval) in std::mem::take(&mut self.grants).into_values() {
            self.close_grant(&action, &approval).await;
        }
        if self.record.run.state() == &RunState::Finished {
            self.record.delivery = self.deliver().await;
        }
        self.record.ended_at = Some(OffsetDateTime::now_utc());
        let seconds = self
            .started
            .map(|s| s.elapsed().as_secs_f64().ceil() as u64)
            .unwrap_or(0);
        let used = Spend {
            seconds,
            usd_micros: self.runs.config.pricing.cost(self.record.usage),
        };
        let outcome = outcome(self.record.run.state(), &self.record.delivery);
        if let Err(e) = self.runs.store.finish(&self.record, used, outcome).await {
            tracing::error!(error = %e, run = %self.id(), "could not record the run's end");
        }
    }

    /// Puts the work on the run's branch and opens a draft pull request. Steps are logged by name only.
    async fn deliver(&self) -> Delivery {
        let steps = git::deliver(&self.record.repository, self.id(), &self.record.task);
        let company = self.company();
        let ok = |step: &'static str, exec: Exec| async move {
            match self.runs.sandbox.exec(company, exec).await {
                Ok(out) => Some(out),
                Err(e) => {
                    tracing::warn!(error = %e, run = %self.id(), step, "delivery failed");
                    None
                }
            }
        };
        let fail = |step: &'static str| {
            tracing::warn!(run = %self.id(), step, "delivery failed");
            Delivery::Failed
        };
        for (step, exec) in [("checkout", steps.checkout), ("stage", steps.stage)] {
            if !ok(step, exec).await.is_some_and(|o| o.ok()) {
                return fail(step);
            }
        }
        match ok("diff", steps.has_staged).await.and_then(|o| o.exit_code) {
            Some(0) => {}
            Some(1) => {
                if !ok("commit", steps.commit).await.is_some_and(|o| o.ok()) {
                    return fail("commit");
                }
            }
            _ => return fail("diff"),
        }
        match ok("ahead", steps.ahead).await.as_ref().and_then(git::commits_ahead) {
            Some(0) => return Delivery::NoChanges,
            Some(_) => {}
            None => return fail("ahead"),
        }
        if !ok("push", steps.push).await.is_some_and(|o| o.ok()) {
            return fail("push");
        }
        match ok("pull request", steps.pull_request)
            .await
            .and_then(|o| git::created_pull_request(&self.record.repository, &o))
        {
            Some(pr) => Delivery::PullRequest(pr),
            None => fail("pull request"),
        }
    }
}

/// How a run ended, in `agent-run.finished`'s terms: a rejected approval is `Rejected`; a run an FDE or its budget
/// stopped is `Cancelled`; a finished run whose work could not be delivered `Failed`.
fn outcome(state: &RunState, delivery: &Delivery) -> RunOutcome {
    match (state, delivery) {
        (RunState::Finished, Delivery::Failed) => RunOutcome::Failed,
        (RunState::Finished, _) => RunOutcome::Succeeded,
        (
            RunState::Failed {
                reason: FailReason::ApprovalRejected,
            },
            _,
        ) => RunOutcome::Rejected,
        (
            RunState::Failed {
                reason: FailReason::Cancelled | FailReason::OverBudget,
            },
            _,
        ) => RunOutcome::Cancelled,
        _ => RunOutcome::Failed,
    }
}

/// Sends the run's lines to live output from their own task, in batches, dropping them if it falls behind.
fn live_forwarder<D: Deps>(runs: Arc<Runs<D>>, scope: ProjectScope, run: AgentRunId) -> mpsc::Sender<String> {
    let (tx, mut rx) = mpsc::channel::<String>(LIVE_QUEUE);
    tokio::spawn(async move {
        while let Some(first) = rx.recv().await {
            let mut batch = vec![first];
            while batch.len() < LIVE_BATCH {
                match rx.try_recv() {
                    Ok(line) => batch.push(line),
                    Err(_) => break,
                }
            }
            if runs.live.publish(&scope, &run, batch).await.is_err() {
                tracing::warn!(run = %run, "live output failed");
            }
        }
    });
    tx
}
