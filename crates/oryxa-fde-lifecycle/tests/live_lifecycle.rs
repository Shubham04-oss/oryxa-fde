//! The lifecycle engine against a real Postgres (see `oryxa_fde_store::testing`):
//!   DATABASE_URL=postgres://postgres:oryxa@localhost:55432/oryxa_fde cargo test -p oryxa-fde-lifecycle -- --ignored
//! Events are signed as the relay signs them and handed over as SQS delivers them. Drafts use a
//! fake model that echoes what it was given.

use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
use oryxa_core::{TenantId, UserId};
use oryxa_events::{Event, Signer, Verifier, encode, new_envelope};
use oryxa_fde_core::{
    AccessRequestId, AgentRunId, CompanyId, CompanyScope, CriterionId, DecisionId, EvalRunId, ProjectId, ProjectScope,
    Stage, TaskId,
};
use oryxa_fde_events::inbox::{Message, Outcome};
use oryxa_fde_events::{
    AccessRequestStatusChanged, AccessStatus, AgentRunFinished, EvalRunFinished, PullRequestMerged, RunOutcome,
};
use oryxa_fde_lifecycle::drafts::{DraftLimits, Drafted, Drafter, EchoDrafter, draft_due, draft_week};
use oryxa_fde_lifecycle::rules::handle;
use oryxa_fde_store::{
    AccessRequestIn, ActivityIn, Actor, CompanyIn, Comparator, CriterionIn, DecisionIn, Name, ProjectIn, Store,
    StoreError, SuggestionKind, TaskIn, TaskStatus, Text, UpdateStatus, new_id, testing, week_of,
};
use serde::Serialize;
use time::{Duration, OffsetDateTime};

fn actor() -> Actor {
    Actor {
        user: UserId::new("alice").unwrap(),
        request_id: new_id("req"),
    }
}

fn keys() -> (Signer, Verifier) {
    let k = SigningKey::generate(&mut rand::rngs::OsRng);
    let signer = Signer::from_pkcs8_pem("fde-1", &k.to_pkcs8_pem(LineEnding::LF).unwrap()).unwrap();
    let public = k.verifying_key().to_public_key_pem(LineEnding::LF).unwrap();
    let verifier = Verifier::default()
        .trust("fde-1", oryxa_fde_events::SOURCE, &public)
        .unwrap();
    (signer, verifier)
}

/// `data` for `tenant`, signed as the relay signs it, as SQS delivers it.
fn message<T: Event + Serialize>(signer: &Signer, tenant: &TenantId, data: &T) -> Message {
    let mut envelope = new_envelope();
    envelope.tenant = tenant.to_string();
    let mut e = encode(&envelope, data).unwrap();
    signer.sign(&mut e).unwrap();
    Message {
        source: e.source,
        detail_type: e.detail_type,
        detail: e.detail,
    }
}

async fn project_in(store: &Store, c: &CompanyScope, p: ProjectId, name: &str) -> ProjectScope {
    let mut tx = store.company(c).await.unwrap();
    if tx.get().await.unwrap().is_none() {
        let v = CompanyIn {
            name: Name::new("Acme").unwrap(),
            industry: None,
            region: None,
            summary: None,
        };
        tx.create(&v, &actor()).await.unwrap();
    }
    tx.commit().await.unwrap();
    let s = c.project(p);
    let mut tx = store.project(&s).await.unwrap();
    let v = ProjectIn {
        name: Name::new(name).unwrap(),
        summary: None,
    };
    tx.create(&v, &actor()).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    s
}

async fn project(store: &Store, t: &TenantId) -> ProjectScope {
    let c = CompanyScope::new(t.clone(), CompanyId::new(new_id("cmp")).unwrap());
    project_in(store, &c, ProjectId::new(new_id("prj")).unwrap(), "Support RAG").await
}

async fn access(store: &Store, p: &ProjectScope, what: &str) -> AccessRequestId {
    let id = AccessRequestId::new(new_id("acc")).unwrap();
    let v = AccessRequestIn {
        description: Text::new(what).unwrap(),
        system: None,
        owner: None,
        status: AccessStatus::Requested,
    };
    let mut tx = store.project(p).await.unwrap();
    tx.add_access_request(&id, &v, &actor()).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    id
}

/// Sets the request's status in the store, as an FDE does.
async fn set_status(store: &Store, p: &ProjectScope, id: &AccessRequestId, status: AccessStatus) {
    let mut tx = store.project(p).await.unwrap();
    let current = tx
        .access_requests()
        .await
        .unwrap()
        .into_iter()
        .find(|a| &a.id == id)
        .unwrap();
    let v = AccessRequestIn {
        description: current.description,
        system: None,
        owner: None,
        status,
    };
    tx.update_access_request(id, &v, &actor()).await.unwrap().unwrap();
    tx.commit().await.unwrap();
}

fn task_in(title: &str, status: TaskStatus, blocked_by: Option<&AccessRequestId>) -> TaskIn {
    TaskIn {
        title: Name::new(title).unwrap(),
        status,
        blocker: (status == TaskStatus::Blocked).then(|| Text::new("needs access").unwrap()),
        due_on: None,
        assignee: None,
        waiting_on: None,
        blocked_by: blocked_by.cloned(),
    }
}

async fn add_task(store: &Store, p: &ProjectScope, v: &TaskIn) -> TaskId {
    let id = TaskId::new(new_id("tsk")).unwrap();
    let mut tx = store.project(p).await.unwrap();
    tx.add_task(&id, v, &actor()).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    id
}

async fn task_state(store: &Store, p: &ProjectScope, id: &TaskId) -> (TaskStatus, bool, Option<AccessRequestId>) {
    let mut tx = store.project(p).await.unwrap();
    let t = tx.tasks().await.unwrap().into_iter().find(|t| &t.id == id).unwrap();
    (t.status, t.blocker.is_some(), t.blocked_by)
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_granted_access_request_unblocks_only_the_tasks_blocked_on_it() {
    let store = testing::store().await;
    let (signer, verifier) = keys();
    let t = TenantId::new(new_id("org")).unwrap();
    let p = project(&store, &t).await;
    let (vpn, db) = (
        access(&store, &p, "VPN").await,
        access(&store, &p, "Read replica").await,
    );
    let on_vpn = add_task(&store, &p, &task_in("Index tickets", TaskStatus::Blocked, Some(&vpn))).await;
    let on_db = add_task(&store, &p, &task_in("Load history", TaskStatus::Blocked, Some(&db))).await;
    let loose = add_task(&store, &p, &task_in("Wait on legal", TaskStatus::Blocked, None)).await;
    let open = add_task(&store, &p, &task_in("Write runbook", TaskStatus::Todo, None)).await;

    set_status(&store, &p, &vpn, AccessStatus::Granted).await;
    let granted = message(
        &signer,
        &t,
        &AccessRequestStatusChanged::new(&p, vpn.clone(), AccessStatus::InProgress, AccessStatus::Granted),
    );
    assert_eq!(handle(&store, &verifier, &granted).await, Outcome::Done);
    assert_eq!(task_state(&store, &p, &on_vpn).await, (TaskStatus::Todo, false, None));
    assert_eq!(
        task_state(&store, &p, &on_db).await,
        (TaskStatus::Blocked, true, Some(db.clone()))
    );
    assert_eq!(task_state(&store, &p, &loose).await.0, TaskStatus::Blocked);
    assert_eq!(task_state(&store, &p, &open).await.0, TaskStatus::Todo);

    // Blocked again by an FDE, the redelivered grant changes nothing.
    let mut tx = store.project(&p).await.unwrap();
    tx.update_task(
        &on_vpn,
        &task_in("Index tickets", TaskStatus::Blocked, Some(&vpn)),
        &actor(),
    )
    .await
    .unwrap()
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(handle(&store, &verifier, &granted).await, Outcome::Done);
    assert_eq!(task_state(&store, &p, &on_vpn).await.0, TaskStatus::Blocked);
    // Revoked since, a grant the relay delivers late (another event of the same grant) unblocks
    // nothing either: the store says the request is no longer granted.
    set_status(&store, &p, &vpn, AccessStatus::Revoked).await;
    let late = message(
        &signer,
        &t,
        &AccessRequestStatusChanged::new(&p, vpn.clone(), AccessStatus::InProgress, AccessStatus::Granted),
    );
    assert_eq!(handle(&store, &verifier, &late).await, Outcome::Done);
    assert_eq!(task_state(&store, &p, &on_vpn).await.0, TaskStatus::Blocked);

    // A change that is not a grant unblocks nothing.
    let denied = message(
        &signer,
        &t,
        &AccessRequestStatusChanged::new(&p, db.clone(), AccessStatus::Requested, AccessStatus::Denied),
    );
    assert_eq!(handle(&store, &verifier, &denied).await, Outcome::Done);
    assert_eq!(task_state(&store, &p, &on_db).await.0, TaskStatus::Blocked);

    // The same access request id granted in another company, or another tenant, is not this one.
    set_status(&store, &p, &db, AccessStatus::Granted).await;
    let other = project(&store, &t).await;
    let elsewhere = project(&store, &TenantId::new(new_id("org")).unwrap()).await;
    for s in [&other, &elsewhere] {
        let m = message(
            &signer,
            s.tenant(),
            &AccessRequestStatusChanged::new(s, db.clone(), AccessStatus::InProgress, AccessStatus::Granted),
        );
        assert_eq!(handle(&store, &verifier, &m).await, Outcome::Done);
    }
    assert_eq!(task_state(&store, &p, &on_db).await.0, TaskStatus::Blocked);

    // Signed by another key, or tampered with: never acted on.
    let (forger, _) = keys();
    let forged = message(
        &forger,
        &t,
        &AccessRequestStatusChanged::new(&p, db.clone(), AccessStatus::InProgress, AccessStatus::Granted),
    );
    assert_eq!(handle(&store, &verifier, &forged).await, Outcome::Quarantine);
    let mut tampered = denied.clone();
    tampered.detail = tampered.detail.replace("\"denied\"", "\"granted\"");
    assert_eq!(handle(&store, &verifier, &tampered).await, Outcome::Quarantine);
    assert_eq!(task_state(&store, &p, &on_db).await.0, TaskStatus::Blocked);

    // A task can be blocked only on an access request of its own project, and only while blocked.
    let mut tx = store.project(&other).await.unwrap();
    let foreign = tx
        .add_task(
            &TaskId::new(new_id("tsk")).unwrap(),
            &task_in("Theirs", TaskStatus::Blocked, Some(&db)),
            &actor(),
        )
        .await;
    assert!(matches!(foreign, Err(StoreError::Missing("blocked_by"))), "{foreign:?}");
    drop(tx);
    let mut tx = store.project(&p).await.unwrap();
    let not_blocked = tx
        .add_task(
            &TaskId::new(new_id("tsk")).unwrap(),
            &task_in("Open", TaskStatus::Todo, Some(&db)),
            &actor(),
        )
        .await;
    assert!(matches!(
        not_blocked,
        Err(StoreError::Rejected("blocked_by_needs_blocked"))
    ));
}

async fn criterion(store: &Store, p: &ProjectScope, comparator: Comparator, target: f64) -> CriterionId {
    let id = CriterionId::new(new_id("crt")).unwrap();
    let v = CriterionIn {
        description: Text::new("Answers grounded in the runbook").unwrap(),
        metric: Name::new("accuracy").unwrap(),
        comparator,
        target,
        unit: None,
    };
    let mut tx = store.project(p).await.unwrap();
    tx.add_criterion(&id, &v, &actor()).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    id
}

async fn measured(store: &Store, p: &ProjectScope, results: &[(&CriterionId, f64)]) -> EvalRunId {
    let run = EvalRunId::new(new_id("evr")).unwrap();
    let mut tx = store.project(p).await.unwrap();
    for (c, v) in results {
        assert!(tx.record_criterion_result(c, &run, *v).await.unwrap());
    }
    tx.commit().await.unwrap();
    run
}

async fn suggested(store: &Store, p: &ProjectScope) -> Vec<(SuggestionKind, EvalRunId)> {
    let mut tx = store.project(p).await.unwrap();
    tx.suggestions()
        .await
        .unwrap()
        .into_iter()
        .map(|s| (s.kind, s.eval_run))
        .collect()
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn every_criterion_passing_suggests_ready_to_deploy_and_never_moves_the_stage() {
    let store = testing::store().await;
    let (signer, verifier) = keys();
    let t = TenantId::new(new_id("org")).unwrap();
    let p = project(&store, &t).await;
    let accuracy = criterion(&store, &p, Comparator::AtLeast, 0.9).await;
    let latency = criterion(&store, &p, Comparator::AtMost, 2.0).await;
    let eval = |run: &EvalRunId| message(&signer, &t, &EvalRunFinished::new(&p, run.clone(), 40, 2));

    // One criterion short: recorded, no suggestion.
    let run1 = measured(&store, &p, &[(&accuracy, 0.95), (&latency, 3.1)]).await;
    assert_eq!(handle(&store, &verifier, &eval(&run1)).await, Outcome::Done);
    assert!(suggested(&store, &p).await.is_empty());
    // Both met, exactly at the target too: suggested, once.
    let run2 = measured(&store, &p, &[(&latency, 2.0)]).await;
    assert_eq!(handle(&store, &verifier, &eval(&run2)).await, Outcome::Done);
    assert_eq!(
        suggested(&store, &p).await,
        [(SuggestionKind::ReadyToDeploy, run2.clone())]
    );
    let run3 = measured(&store, &p, &[(&latency, 1.5)]).await;
    assert_eq!(handle(&store, &verifier, &eval(&run3)).await, Outcome::Done);
    assert_eq!(
        suggested(&store, &p).await,
        [(SuggestionKind::ReadyToDeploy, run2.clone())]
    );
    // Dismissed, the next passing run raises it again; its redelivery changes nothing.
    let mut tx = store.project(&p).await.unwrap();
    assert!(
        tx.dismiss_suggestion(SuggestionKind::ReadyToDeploy, &actor())
            .await
            .unwrap()
    );
    assert!(
        !tx.dismiss_suggestion(SuggestionKind::ReadyToDeploy, &actor())
            .await
            .unwrap()
    );
    tx.commit().await.unwrap();
    let run4 = measured(&store, &p, &[(&latency, 1.2)]).await;
    let m4 = eval(&run4);
    assert_eq!(handle(&store, &verifier, &m4).await, Outcome::Done);
    assert_eq!(
        suggested(&store, &p).await,
        [(SuggestionKind::ReadyToDeploy, run4.clone())]
    );
    let mut tx = store.project(&p).await.unwrap();
    assert!(
        tx.dismiss_suggestion(SuggestionKind::ReadyToDeploy, &actor())
            .await
            .unwrap()
    );
    tx.commit().await.unwrap();
    assert_eq!(handle(&store, &verifier, &m4).await, Outcome::Done);
    assert!(suggested(&store, &p).await.is_empty(), "a redelivery raises nothing");
    // Every run is in the activity once, and the stage never moved.
    let mut tx = store.project(&p).await.unwrap();
    let runs: Vec<EvalRunId> = tx
        .activity(50)
        .await
        .unwrap()
        .into_iter()
        .filter_map(|a| match a.what {
            ActivityIn::EvalRun {
                run,
                passed: 40,
                failed: 2,
            } => Some(run),
            _ => None,
        })
        .collect();
    assert_eq!(runs.len(), 4);
    assert_eq!(tx.get().await.unwrap().unwrap().stage, Stage::Discover);
    // Another project's criterion takes no result here.
    let other = project(&store, &t).await;
    let theirs = criterion(&store, &other, Comparator::AtLeast, 0.5).await;
    assert!(!tx.record_criterion_result(&theirs, &run4, 1.0).await.unwrap());
    drop(tx);

    // A project with no criteria, or already deploying, is never suggested to deploy.
    let none = project(&store, &t).await;
    let run = EvalRunId::new(new_id("evr")).unwrap();
    let m = message(&signer, &t, &EvalRunFinished::new(&none, run, 1, 0));
    assert_eq!(handle(&store, &verifier, &m).await, Outcome::Done);
    assert!(suggested(&store, &none).await.is_empty());
    let deploying = project(&store, &t).await;
    let c = criterion(&store, &deploying, Comparator::AtLeast, 0.5).await;
    let run = measured(&store, &deploying, &[(&c, 0.9)]).await;
    let mut tx = store.project(&deploying).await.unwrap();
    for stage in [
        Stage::Scope,
        Stage::Access,
        Stage::Build,
        Stage::Evaluate,
        Stage::Deploy,
    ] {
        tx.change_stage(stage, &actor()).await.unwrap().unwrap();
    }
    tx.commit().await.unwrap();
    let m = message(&signer, &t, &EvalRunFinished::new(&deploying, run, 1, 0));
    assert_eq!(handle(&store, &verifier, &m).await, Outcome::Done);
    assert!(suggested(&store, &deploying).await.is_empty());
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn agent_runs_and_merged_pull_requests_land_in_the_activity_once() {
    let store = testing::store().await;
    let (signer, verifier) = keys();
    let t = TenantId::new(new_id("org")).unwrap();
    let p = project(&store, &t).await;
    let run = AgentRunId::new(new_id("run")).unwrap();
    let finished = message(
        &signer,
        &t,
        &AgentRunFinished::new(&p, run.clone(), RunOutcome::Succeeded),
    );
    let merged = message(&signer, &t, &PullRequestMerged::new(&p, 42));
    for m in [&finished, &merged, &finished, &merged] {
        assert_eq!(handle(&store, &verifier, m).await, Outcome::Done);
    }
    let mut tx = store.project(&p).await.unwrap();
    let mut got: Vec<ActivityIn> = tx.activity(10).await.unwrap().into_iter().map(|a| a.what).collect();
    got.sort_by_key(|a| format!("{a:?}"));
    assert_eq!(
        got,
        [
            ActivityIn::AgentRun {
                run,
                outcome: RunOutcome::Succeeded
            },
            ActivityIn::PullRequest { number: 42 },
        ]
    );
    drop(tx);
    // Events the engine has no rule for are not its to act on.
    let other = message(&signer, &t, &oryxa_fde_events::ProjectCreated::new(&p));
    assert_eq!(handle(&store, &verifier, &other).await, Outcome::Done);
}

/// Backdates the project's records to `at`, as if made then; read as the owner.
async fn made_at(p: &ProjectScope, at: OffsetDateTime) {
    let owner = testing::admin().await;
    for (table, columns) in [
        ("tasks", "updated_at = $3, done_at = $3"),
        ("decisions", "created_at = $3"),
    ] {
        sqlx::query(&format!(
            "update {table} set {columns} where tenant_id = $1 and project_id = $2"
        ))
        .bind(p.tenant().as_str())
        .bind(p.project.as_str())
        .bind(at)
        .execute(&owner)
        .await
        .unwrap();
    }
}

async fn busy_week(store: &Store, p: &ProjectScope, word: &str, at: OffsetDateTime) {
    add_task(store, p, &task_in(&format!("{word} task done"), TaskStatus::Done, None)).await;
    let mut tx = store.project(p).await.unwrap();
    let v = DecisionIn {
        title: Name::new(format!("{word} decision")).unwrap(),
        rationale: Text::new("Because").unwrap(),
        decided_by: Name::new("Sam").unwrap(),
        decided_at: at,
    };
    tx.record_decision(&DecisionId::new(new_id("dec")).unwrap(), &v, &actor())
        .await
        .unwrap()
        .unwrap();
    tx.record_activity(&new_id("evt"), &ActivityIn::PullRequest { number: 7 }, at)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    made_at(p, at).await;
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_weekly_draft_holds_its_own_project_only_and_waits_for_an_fde() {
    let store = testing::store().await;
    let t = TenantId::new(new_id("org")).unwrap();
    let today = OffsetDateTime::now_utc().date();
    let monday = week_of(today) - Duration::weeks(1);
    let in_week = monday.with_hms(10, 0, 0).unwrap().assume_utc() + Duration::days(2);
    // A and B share a tenant; C is in another tenant under the same company and project ids as A.
    let a = project(&store, &t).await;
    let b = project(&store, &t).await;
    let c = project_in(
        &store,
        &CompanyScope::new(TenantId::new(new_id("org")).unwrap(), a.company.company.clone()),
        a.project.clone(),
        "Support RAG",
    )
    .await;
    busy_week(&store, &a, "Alpha", in_week).await;
    busy_week(&store, &b, "Bravo", in_week).await;
    busy_week(&store, &c, "Charlie", in_week).await;

    assert_eq!(
        draft_week(&store, &EchoDrafter, &a, monday, &limits()).await.unwrap(),
        Drafted::Drafted
    );
    let mut tx = store.project(&a).await.unwrap();
    let draft = tx.update_draft(monday).await.unwrap().unwrap();
    let body = draft.body.as_str();
    assert!(
        body.contains("Alpha task done") && body.contains("Alpha decision") && body.contains("#7"),
        "{body}"
    );
    assert!(!body.contains("Bravo") && !body.contains("Charlie"), "{body}");
    assert_eq!((draft.status, draft.model.as_str()), (UpdateStatus::Draft, "echo"));
    drop(tx);
    // Drafted once; a week with nothing in it gets none.
    assert_eq!(
        draft_week(&store, &EchoDrafter, &a, monday, &limits()).await.unwrap(),
        Drafted::Exists
    );
    let quiet = project(&store, &t).await;
    assert_eq!(
        draft_week(&store, &EchoDrafter, &quiet, monday, &limits())
            .await
            .unwrap(),
        Drafted::Quiet
    );
    // The weekly job drafts the rest, each from its own project.
    draft_due(&store, &EchoDrafter, today, &limits()).await.unwrap();
    for (s, own) in [(&b, "Bravo"), (&c, "Charlie")] {
        let mut tx = store.project(s).await.unwrap();
        let body = tx.update_draft(monday).await.unwrap().unwrap().body.as_str().to_owned();
        assert!(body.contains(own), "{body}");
        for other in ["Alpha", "Bravo", "Charlie"].iter().filter(|o| *o != &own) {
            assert!(!body.contains(other), "{own}'s draft holds {other}: {body}");
        }
    }

    // Edited, then approved: final. Nothing is sent; it is only marked approved.
    let mut tx = store.project(&a).await.unwrap();
    let edited = oryxa_fde_store::UpdateBody::new("Done this week: Alpha.").unwrap();
    let after = tx.edit_update_draft(monday, &edited, &actor()).await.unwrap().unwrap();
    assert_eq!(
        (after.body.as_str(), after.edited_by.is_some()),
        ("Done this week: Alpha.", true)
    );
    let approved = tx.decide_update_draft(monday, true, &actor()).await.unwrap().unwrap();
    assert_eq!(approved.status, UpdateStatus::Approved);
    assert!(matches!(
        tx.edit_update_draft(monday, &edited, &actor()).await,
        Err(StoreError::Rejected("update_decided"))
    ));
    assert!(matches!(
        tx.decide_update_draft(monday, false, &actor()).await,
        Err(StoreError::Rejected("update_decided"))
    ));
    assert!(
        tx.decide_update_draft(monday + Duration::weeks(1), true, &actor())
            .await
            .unwrap()
            .is_none()
    );
}

fn limits() -> DraftLimits {
    DraftLimits::default()
}

/// A model that counts its calls and fails or hangs.
struct Broken {
    calls: std::sync::atomic::AtomicU32,
    hang: bool,
}

impl Drafter for Broken {
    fn model(&self) -> &str {
        "broken"
    }

    fn draft<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<String, oryxa_fde_lifecycle::LifecycleError>> + Send + 'a>,
    > {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let hang = self.hang;
        Box::pin(async move {
            if hang {
                std::future::pending::<()>().await;
            }
            Err(oryxa_fde_lifecycle::LifecycleError::Model("stopped: refusal".into()))
        })
    }
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn model_calls_are_capped_timed_and_made_by_one_drafter_at_a_time() {
    let store = testing::store().await;
    let t = TenantId::new(new_id("org")).unwrap();
    let monday = week_of(OffsetDateTime::now_utc().date()) - Duration::weeks(1);
    let in_week = monday.with_hms(10, 0, 0).unwrap().assume_utc() + Duration::days(2);

    // A model that keeps refusing gets three calls for the week, then none.
    let p = project(&store, &t).await;
    busy_week(&store, &p, "Alpha", in_week).await;
    let refusing = Broken {
        calls: Default::default(),
        hang: false,
    };
    for _ in 0..3 {
        assert!(draft_week(&store, &refusing, &p, monday, &limits()).await.is_err());
    }
    assert_eq!(
        draft_week(&store, &refusing, &p, monday, &limits()).await.unwrap(),
        Drafted::GaveUp
    );
    assert_eq!(refusing.calls.load(std::sync::atomic::Ordering::SeqCst), 3);
    // Next week is a week of its own.
    let next = monday + Duration::weeks(1);
    let mut tx = store.project(&p).await.unwrap();
    assert!(tx.claim_update_attempt(next, 3).await.unwrap());
    drop(tx);

    // A model that never answers is cut off at the deadline, and the call still counts.
    let q = project(&store, &t).await;
    busy_week(&store, &q, "Bravo", in_week).await;
    let hanging = Broken {
        calls: Default::default(),
        hang: true,
    };
    let quick = DraftLimits {
        timeout: std::time::Duration::from_millis(200),
        attempts: 1,
    };
    let started = std::time::Instant::now();
    let err = draft_week(&store, &hanging, &q, monday, &quick).await.unwrap_err();
    assert!(err.to_string().contains("timed out"), "{err}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(
        draft_week(&store, &hanging, &q, monday, &quick).await.unwrap(),
        Drafted::GaveUp
    );

    // While another copy holds the project's week, this one skips it and calls nothing; after,
    // it drafts.
    let r = project(&store, &t).await;
    busy_week(&store, &r, "Charlie", in_week).await;
    let held = store.lock_drafting(&r, monday).await.unwrap().unwrap();
    assert!(store.lock_drafting(&r, monday).await.unwrap().is_none());
    assert_eq!(
        draft_week(&store, &EchoDrafter, &r, monday, &limits()).await.unwrap(),
        Drafted::Busy
    );
    held.release().await.unwrap();
    assert_eq!(
        draft_week(&store, &EchoDrafter, &r, monday, &limits()).await.unwrap(),
        Drafted::Drafted
    );

    // A project in operation gets no more weekly updates, and no call.
    let s = project(&store, &t).await;
    busy_week(&store, &s, "Delta", in_week).await;
    let mut tx = store.project(&s).await.unwrap();
    for stage in [
        Stage::Scope,
        Stage::Access,
        Stage::Build,
        Stage::Evaluate,
        Stage::Deploy,
        Stage::Handoff,
        Stage::Operate,
    ] {
        tx.change_stage(stage, &actor()).await.unwrap().unwrap();
    }
    tx.commit().await.unwrap();
    let counting = Broken {
        calls: Default::default(),
        hang: false,
    };
    assert_eq!(
        draft_week(&store, &counting, &s, monday, &limits()).await.unwrap(),
        Drafted::Operating
    );
    assert_eq!(counting.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn the_week_lists_the_tasks_that_moved_to_done_in_it_not_those_only_touched() {
    let store = testing::store().await;
    let t = TenantId::new(new_id("org")).unwrap();
    let monday = week_of(OffsetDateTime::now_utc().date()) - Duration::weeks(1);
    let in_week = monday.with_hms(10, 0, 0).unwrap().assume_utc() + Duration::days(2);
    let p = project(&store, &t).await;
    // Done two weeks before, then edited during the week: touched, not done in it.
    let old = add_task(&store, &p, &task_in("Done long ago", TaskStatus::Done, None)).await;
    made_at(&p, in_week - Duration::weeks(2)).await;
    let mut tx = store.project(&p).await.unwrap();
    tx.update_task(
        &old,
        &task_in("Done long ago, renamed", TaskStatus::Done, None),
        &actor(),
    )
    .await
    .unwrap()
    .unwrap();
    tx.commit().await.unwrap();
    let owner = testing::admin().await;
    sqlx::query("update tasks set updated_at = $3 where tenant_id = $1 and task_id = $2")
        .bind(t.as_str())
        .bind(old.as_str())
        .bind(in_week)
        .execute(&owner)
        .await
        .unwrap();
    // Moved to done during the week.
    let fresh = add_task(&store, &p, &task_in("Done this week", TaskStatus::Done, None)).await;
    sqlx::query("update tasks set updated_at = $3, done_at = $3 where tenant_id = $1 and task_id = $2")
        .bind(t.as_str())
        .bind(fresh.as_str())
        .bind(in_week)
        .execute(&owner)
        .await
        .unwrap();
    let mut tx = store.project(&p).await.unwrap();
    let facts = tx.week_facts(monday).await.unwrap().unwrap();
    let done: Vec<&str> = facts.done.iter().map(|n| n.as_str()).collect();
    assert_eq!(done, ["Done this week"]);
}
