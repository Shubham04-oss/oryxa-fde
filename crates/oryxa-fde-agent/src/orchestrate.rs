//! Drives one run from queued to ended, in one task, so its harness lines and the FDE's decisions are applied in a
//! single order (as `AgentRun` requires):
//!
//! 1. Wait for the company's sandbox (one run at a time, across API tasks), then reserve the run's part of the
//!    project's budget. A heartbeat keeps both until the run's end is recorded. A run that cannot renew its hold
//!    while it still has it destroys the sandbox and ends; one whose hold has lapsed, or is someone else's, ends
//!    and leaves the sandbox alone, since another run may already have been given it.
//! 2. Build the context pack, destroy whatever container the sandbox still has and start a fresh one, check out the
//!    repository, write the pack and check the digest read back, then start the harness on it.
//! 3. Apply the harness's lines; store the transcript and approval requests, and stream lines live. Decisions and
//!    cancels arrive through the store. The run stops at its time limit or when its budget runs out.
//! 4. Put a finished run's work on a branch with a draft pull request, then record the end and its
//!    `agent_run.finished` event together.
//!
//! Everything fails closed: a store, gateway or digest failure stops the run; a harness that does not stop when
//! told to, a grant that does not close, or a lost hold on the sandbox has the sandbox destroyed.
//!
//! A run whose API task stops (a deploy) is ended by [`sweep`] on any task once its heartbeat has lapsed.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use oryxa_fde_core::{AgentRunId, CompanyScope, ProjectScope};
use oryxa_fde_events::RunOutcome;
use time::OffsetDateTime;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep, sleep_until, timeout};

use crate::context::ContextPack;
use crate::event::{ApprovalOutcome, HarnessEvent, HarnessInput, ToolStatus, parse_line};
use crate::gateway::{Exec, HarnessProcess, ProcessEvent, Sandbox};
use crate::git::{self, Delivery};
use crate::ids::{ApprovalId, ToolCallId};
use crate::live::LiveOutput;
use crate::run::{Applied, FailReason, RunState, StopReason};
use crate::service::{Deps, Remaining, Runs};
use crate::store::{ApprovalRecord, RunRecord, RunStore, Spend};

const LIVE_QUEUE: usize = 1024;
const SWEEP_BATCH: u32 = 100;
/// A sandbox that will not stop is asked this many times, waiting a poll interval, then twice that, between.
const STOP_ATTEMPTS: u32 = 3;
const LIVE_BATCH: usize = 100;

pub(crate) async fn drive<D: Deps>(runs: Arc<Runs<D>>, scope: ProjectScope, id: AgentRunId) {
    let record = match runs.store.run(&scope, &id).await {
        Ok(Some(record)) => record,
        Ok(None) => return,
        Err(e) => {
            tracing::error!(error = %e, run = %id, "could not load the run to start it");
            return;
        }
    };
    let mut driver = Driver {
        runs: runs.clone(),
        scope,
        record,
        exec: None,
        actions: BTreeSet::new(),
        grants: BTreeMap::new(),
        started: None,
        heartbeat: None,
        hold: watch::channel(Hold::Held).1,
    };
    driver.run().await;
    // Runs on this task that wait for the sandbox try again now.
    runs.changed();
}

/// The heartbeat's task, stopped when the driver lets it go or is itself dropped (a panic, an abort), so a lease
/// never outlives the run that holds it.
struct Heartbeat(JoinHandle<()>);

impl Drop for Heartbeat {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// What became of a run's hold on the company's sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hold {
    Held,
    /// It could not be renewed while still held, so the run destroyed the sandbox.
    Destroyed,
    /// It lapsed or is someone else's: the sandbox may be another run's now, so the run leaves it alone.
    Gone,
}

/// Keeps the run's hold on the company's sandbox and its budget reservation while the driver works. A renewal
/// never outlasts the hold it would extend. If the store cannot renew it while it is still held, the sandbox is
/// destroyed (bounded by the same time); once it has lapsed or the store says it is someone else's, the sandbox is
/// left alone.
fn hold_sandbox<D: Deps>(
    runs: Arc<Runs<D>>,
    scope: ProjectScope,
    run: AgentRunId,
    mut until: Instant,
    hold: watch::Sender<Hold>,
) -> Heartbeat {
    Heartbeat(tokio::spawn(async move {
        let lease = runs.config.lease;
        loop {
            sleep(lease / 4).await;
            let asked = Instant::now();
            let left = until.saturating_duration_since(asked);
            let renewed = if left.is_zero() {
                None
            } else {
                timeout(left, runs.store.renew_sandbox(&scope, &run, lease)).await.ok()
            };
            let left = until.saturating_duration_since(Instant::now());
            match renewed {
                Some(Ok(true)) => {
                    until = asked + lease;
                    continue;
                }
                Some(Err(_)) if left > lease / 4 => continue,
                Some(Err(_)) | None if !left.is_zero() => {
                    tracing::error!(run = %run, "could not renew the company's sandbox; destroying it");
                    let _ = hold.send(Hold::Destroyed);
                    match timeout(left, runs.sandbox.stop(&scope.company)).await {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => tracing::error!(error = %e, run = %run, "could not stop the sandbox"),
                        Err(_) => tracing::error!(run = %run, "stopping the sandbox outlasted the hold"),
                    }
                    return;
                }
                _ => {}
            }
            tracing::error!(run = %run, "lost the company's sandbox; leaving it alone");
            let _ = hold.send(Hold::Gone);
            return;
        }
    }))
}

/// Ends runs whose API task stopped (a deploy) before they did, in any tenant: those whose heartbeat has lapsed,
/// never one that is still driven, whatever its state reads. Each fails as `interrupted` (or keeps the end its
/// model already reached) and its use up to its last heartbeat is counted. Returns how many it ended.
///
/// Its harness, if any, cancels itself once its stdin closes with the API task, and the next run destroys the
/// container before starting.
pub(crate) async fn sweep<D: Deps>(runs: &Runs<D>) -> usize {
    let lapsed = match runs.store.lapsed(SWEEP_BATCH).await {
        Ok(lapsed) => lapsed,
        Err(e) => {
            tracing::error!(error = %e, "could not look for interrupted runs");
            return 0;
        }
    };
    let mut ended = 0;
    for (scope, id) in lapsed {
        let mut record = match runs.store.run(&scope, &id).await {
            Ok(Some(record)) => record,
            Ok(None) => continue,
            Err(e) => {
                tracing::error!(error = %e, run = %id, "could not load an interrupted run");
                continue;
            }
        };
        record.run.interrupted();
        record.ended_at = Some(OffsetDateTime::now_utc());
        let outcome = outcome(record.run.state(), &record.delivery);
        let usd_micros = runs.config.pricing.cost(record.usage);
        match runs.store.settle_lapsed(&record, usd_micros, outcome).await {
            Ok(true) => {
                tracing::warn!(run = %id, "ended a run whose API task stopped");
                close_grants(runs, &scope, &id).await;
                ended += 1;
            }
            Ok(false) => {}
            Err(e) => tracing::error!(error = %e, run = %id, "could not end an interrupted run"),
        }
    }
    if ended > 0 {
        runs.changed();
    }
    ended
}

/// Closes the grants an ended run's approved actions may have left open. Each closes only the grant its own
/// approval opened, so another run's is never touched; one that will not close expires on its own.
async fn close_grants<D: Deps>(runs: &Runs<D>, scope: &ProjectScope, run: &AgentRunId) {
    let approvals = match runs.store.approvals(scope, run).await {
        Ok(approvals) => approvals,
        Err(e) => {
            tracing::error!(error = %e, run = %run, "could not read an interrupted run's approvals");
            return;
        }
    };
    let approved = approvals.iter().filter(|a| {
        a.decision
            .as_ref()
            .is_some_and(|d| d.outcome == ApprovalOutcome::Approved)
    });
    for a in approved {
        if let Err(e) = runs.sandbox.close_grant(&scope.company, &a.action, &a.id).await {
            tracing::error!(error = %e, run = %run, "could not close an interrupted run's grant");
        }
    }
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
    /// Renews the run's hold on the sandbox from when it is given until its end is recorded.
    heartbeat: Option<Heartbeat>,
    /// What became of that hold.
    hold: watch::Receiver<Hold>,
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
        match self.take_turn().await {
            Ok(true) => {}
            Ok(false) => {
                let _ = self.record.run.cancel();
                return self.finish().await;
            }
            Err(()) => {
                let _ = self.record.run.stop(StopReason::StoreUnavailable);
                return self.finish().await;
            }
        }
        let config = &self.runs.config;
        let reserved = self
            .runs
            .store
            .reserve(&self.scope, self.id(), config.default_budget, config.max_run)
            .await;
        let left = match reserved {
            Ok(left) => left,
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

    /// Waits for the company's sandbox, keeping the queued run alive in the store; `Ok(false)` if it was cancelled
    /// meanwhile. Once given, a heartbeat keeps it.
    async fn take_turn(&mut self) -> Result<bool, ()> {
        let mut changes = self.runs.watch();
        let lease = self.runs.config.lease;
        loop {
            match self.runs.store.cancel_requested(&self.scope, self.id()).await {
                Ok(false) => {}
                Ok(true) => return Ok(false),
                Err(_) => return Err(()),
            }
            let asked = Instant::now();
            match self.runs.store.take_sandbox(&self.scope, self.id(), lease).await {
                Ok(true) => {
                    let (tx, rx) = watch::channel(Hold::Held);
                    self.hold = rx;
                    self.heartbeat = Some(hold_sandbox(
                        self.runs.clone(),
                        self.scope.clone(),
                        self.id().clone(),
                        asked + lease,
                        tx,
                    ));
                    return Ok(true);
                }
                Ok(false) => {}
                Err(_) => return Err(()),
            }
            tokio::select! {
                () = sleep(self.runs.config.poll) => {}
                Ok(()) = changes.changed() => {}
            }
        }
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
        // A fresh container for every run: nothing an earlier run left (a harness orphaned by a deploy, or whatever
        // its agent left running) survives into this one. A sandbox that will not stop is never reused.
        runs.sandbox.stop(&company).await.map_err(|_| "sandbox")?;
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
        let mut hold = self.hold.clone();
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
                        self.sandbox_lost(&hold).await;
                        self.record.run.harness_exited();
                        break;
                    }
                    None => {
                        // The stream was lost and the harness may still run: stop it the hard way.
                        tracing::warn!(run = %self.id(), "lost the harness's output");
                        self.sandbox_lost(&hold).await;
                        self.record.run.harness_exited();
                        self.hard_stop().await;
                        break;
                    }
                },
                Ok(()) = hold.changed() => self.sandbox_lost(&hold).await,
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
                // The approved call returned: its hosts close now, so nothing after it can use them. If they cannot be
                // closed, the sandbox goes instead.
                if let Some((action, approval)) = self.grants.remove(id)
                    && !self.close_grant(&action, &approval).await
                {
                    // Kept, so the run's end tries it again if the sandbox will not stop either.
                    self.grants.insert(id.clone(), (action, approval));
                    return self.grant_not_closed().await;
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

    /// An approved action's hosts could not be closed: the run fails (even one the harness had finished) and the
    /// sandbox is destroyed, without asking the harness first.
    async fn grant_not_closed(&mut self) {
        self.record.run.grant_not_closed();
        self.save().await;
        self.hard_stop().await;
    }

    /// If the heartbeat lost the sandbox, the run ends for that reason. A destroyed sandbox took the harness and the
    /// grants with it; a sandbox that may be another run's is left alone, and the harness is only told to stop.
    async fn sandbox_lost(&mut self, hold: &watch::Receiver<Hold>) {
        let hold = *hold.borrow();
        if self.record.run.is_ended() {
            return;
        }
        match hold {
            Hold::Held => {}
            Hold::Destroyed => {
                let _ = self.record.run.stop(StopReason::StoreUnavailable);
                self.save().await;
                self.exec = None;
                self.grants.clear();
            }
            Hold::Gone => self.stop(Stop::Reason(StopReason::StoreUnavailable)).await,
        }
    }

    fn holds_sandbox(&self) -> bool {
        *self.hold.borrow() == Hold::Held
    }

    /// Destroys the company's sandbox: the harness and everything the agent left running go with it. Retried a few
    /// times; if it still runs, its grants stay listed so the run's end closes them one by one, and the next run to
    /// take the sandbox destroys it before starting, or does not start.
    async fn hard_stop(&mut self) {
        self.exec = None;
        if *self.hold.borrow() == Hold::Gone {
            // The sandbox may be another run's by now: its next holder destroys it before starting.
            tracing::warn!(run = %self.id(), "not stopping a sandbox this run no longer holds");
            return;
        }
        let mut wait = self.runs.config.poll;
        for attempt in 1..=STOP_ATTEMPTS {
            match self.runs.sandbox.stop(self.company()).await {
                Ok(()) => {
                    // Grants are closed when the sandbox stops.
                    self.grants.clear();
                    return;
                }
                Err(e) => tracing::error!(error = %e, run = %self.id(), attempt, "could not stop the sandbox"),
            }
            if attempt < STOP_ATTEMPTS {
                sleep(wait).await;
                wait *= 2;
            }
        }
    }

    async fn save(&mut self) {
        if let Err(e) = self.runs.store.update(&self.record).await {
            tracing::error!(error = %e, run = %self.id(), "could not save the run");
        }
    }

    async fn close_grant(&self, action: &str, approval: &ApprovalId) -> bool {
        match self.runs.sandbox.close_grant(self.company(), action, approval).await {
            Ok(()) => true,
            Err(e) => {
                tracing::error!(error = %e, run = %self.id(), "could not close a grant");
                false
            }
        }
    }

    async fn finish(&mut self) {
        // Calls that never returned (the run was stopped) lose their hosts too; if they cannot, the sandbox goes.
        let mut closed = true;
        for (action, approval) in std::mem::take(&mut self.grants).into_values() {
            closed &= self.close_grant(&action, &approval).await;
        }
        if !closed {
            self.grant_not_closed().await;
        }
        if closed && self.record.run.state() == &RunState::Finished && self.holds_sandbox() {
            self.record.delivery = self.deliver().await;
        }
        // The end lets the sandbox go, so the heartbeat stops before it is recorded.
        drop(self.heartbeat.take());
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
/// stopped is `Cancelled`; a finished run whose work was not delivered `Failed`.
fn outcome(state: &RunState, delivery: &Delivery) -> RunOutcome {
    match (state, delivery) {
        // Finished but never delivered (its sandbox was lost, or its API task stopped): nothing came of it.
        (RunState::Finished, Delivery::Failed | Delivery::None) => RunOutcome::Failed,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finished_run_succeeds_only_once_delivered() {
        let pr = Delivery::PullRequest(crate::git::PullRequest {
            number: 7,
            url: "https://github.com/sample-org/status-page/pull/7".into(),
        });
        assert_eq!(outcome(&RunState::Finished, &pr), RunOutcome::Succeeded);
        assert_eq!(
            outcome(&RunState::Finished, &Delivery::NoChanges),
            RunOutcome::Succeeded
        );
        assert_eq!(outcome(&RunState::Finished, &Delivery::Failed), RunOutcome::Failed);
        assert_eq!(outcome(&RunState::Finished, &Delivery::None), RunOutcome::Failed);
        let failed = |reason| RunState::Failed { reason };
        assert_eq!(
            outcome(&failed(FailReason::ApprovalRejected), &Delivery::None),
            RunOutcome::Rejected
        );
        assert_eq!(
            outcome(&failed(FailReason::OverBudget), &Delivery::None),
            RunOutcome::Cancelled
        );
        assert_eq!(
            outcome(&failed(FailReason::Interrupted), &Delivery::None),
            RunOutcome::Failed
        );
    }
}
