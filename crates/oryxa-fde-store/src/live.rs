//! Against a real Postgres. Start one, then run:
//!   docker run --rm -e POSTGRES_PASSWORD=oryxa -e POSTGRES_DB=oryxa_fde -p 55432:5432 pgvector/pgvector:pg17
//!   DATABASE_URL=postgres://postgres:oryxa@localhost:55432/oryxa_fde cargo test -p oryxa-fde-store -- --ignored
//! Each test uses fresh tenant ids, so runs never see each other's rows. The store connects as a
//! fresh runtime login (`testing::store`); `DATABASE_URL`'s login is the owner (`testing::admin`).

use std::time::Duration;

use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
use oryxa_events::{Encoded, MemoryPublisher, PublishError, Publisher, Signer, Verifier, decode};
use oryxa_fde_core::{ScopeItemId, SecurityAnswerId};
use oryxa_fde_events::{CompanyCreated, ProjectCreated};
use std::sync::Arc;

use sqlx::Row;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

use super::*;
use crate::relay::{dispatch_once, replay_dead};
use crate::testing::{self, admin};
use sqlx::Acquire;

async fn store() -> Store {
    crate::testing::store().await
}

fn company_in(name: &str) -> CompanyIn {
    CompanyIn {
        name: Name::new(name).unwrap(),
        industry: None,
        region: None,
        summary: None,
    }
}

fn project_in(name: &str) -> ProjectIn {
    ProjectIn {
        name: Name::new(name).unwrap(),
        summary: None,
    }
}

fn tenant() -> TenantId {
    TenantId::new(new_id("org")).unwrap()
}

fn actor(user: &str) -> Actor {
    Actor {
        user: UserId::new(user).unwrap(),
        request_id: new_id("req"),
    }
}

fn scope(t: &TenantId, company: &str) -> CompanyScope {
    CompanyScope::new(t.clone(), CompanyId::new(company).unwrap())
}

async fn create_company(store: &Store, s: &CompanyScope) {
    let mut tx = store.company(s).await.unwrap();
    tx.create(&company_in("Acme"), &actor("alice")).await.unwrap();
    tx.commit().await.unwrap();
}

fn keys() -> (Signer, Verifier) {
    let k = SigningKey::generate(&mut rand::rngs::OsRng);
    let signer = Signer::from_pkcs8_pem("fde-1", &k.to_pkcs8_pem(LineEnding::LF).unwrap()).unwrap();
    let public = k.verifying_key().to_public_key_pem(LineEnding::LF).unwrap();
    (
        signer,
        Verifier::default()
            .trust("fde-1", oryxa_fde_events::SOURCE, &public)
            .unwrap(),
    )
}

/// Outbox rows of one tenant as (id, detail_type, group, published), oldest first, read as the relay.
async fn outbox(store: &Store, t: &TenantId) -> Vec<(String, String, String, bool)> {
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("set local role oryxa_fde_relay")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("select id, detail_type, group_key, published_at is not null as published from outbox where tenant_id = $1 order by seq")
        .bind(t.as_str())
        .fetch_all(&mut *tx)
        .await
        .unwrap()
        .into_iter()
        .map(|r| (r.get("id"), r.get("detail_type"), r.get("group_key"), r.get("published")))
        .collect()
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn row_level_security_limits_every_query_to_the_scope() {
    let store = store().await;
    let (t1, t2) = (tenant(), tenant());
    let shared = new_id("cmp");
    let (a, b) = (scope(&t1, &new_id("cmp")), scope(&t1, &new_id("cmp")));
    for s in [&a, &b, &scope(&t1, &shared), &scope(&t2, &shared)] {
        create_company(&store, s).await;
    }

    let mut tx = store.company(&a).await.unwrap();
    // No WHERE clause at all: only the scope's company is visible.
    let ids: Vec<String> = sqlx::query_scalar("select company_id from companies")
        .fetch_all(tx.conn())
        .await
        .unwrap();
    assert_eq!(ids, [a.company.as_str()]);
    let members: i64 = sqlx::query_scalar("select count(*) from company_members")
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(members, 1);
    let audits: Vec<String> = sqlx::query_scalar("select company_id from audit_log")
        .fetch_all(tx.conn())
        .await
        .unwrap();
    assert_eq!(audits, [a.company.as_str()]);
    let changed = sqlx::query("update companies set name = 'x'")
        .execute(tx.conn())
        .await
        .unwrap()
        .rows_affected();
    assert_eq!(changed, 1, "an unfiltered update reaches only the scope's row");
    drop(tx);

    // Writing a row for another company or tenant is refused by the policy's check.
    for (t, c) in [(&t1, b.company.as_str()), (&t2, a.company.as_str())] {
        let mut tx = store.company(&a).await.unwrap();
        let r =
            sqlx::query("insert into companies (tenant_id, company_id, name, created_by) values ($1, $2, 'x', 'u')")
                .bind(t.as_str())
                .bind(c)
                .execute(tx.conn())
                .await;
        assert!(r.is_err(), "insert for {t}/{c} must be refused");
    }

    // The same company id in two tenants: each scope sees only its own tenant's row.
    let mut tx = store.company(&scope(&t1, &shared)).await.unwrap();
    let tenants: Vec<String> = sqlx::query_scalar("select tenant_id from companies")
        .fetch_all(tx.conn())
        .await
        .unwrap();
    assert_eq!(tenants, [t1.as_str()]);
    // The app role cannot read the outbox at all; only the relay can.
    assert!(sqlx::query("select 1 from outbox").fetch_all(tx.conn()).await.is_err());
    drop(tx);

    // The app role with no scope set sees nothing.
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("set local role oryxa_fde_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar("select count(*) from companies")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(n, 0);

    // The store's own reads agree.
    assert!(store.company(&b).await.unwrap().get().await.unwrap().is_some());
    let listed = store.companies(&[a.clone(), b.clone()]).await.unwrap();
    assert_eq!(listed.len(), 2);
    assert!(matches!(
        store.companies(&[a.clone(), scope(&t2, &shared)]).await,
        Err(StoreError::MixedTenants)
    ));
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn audit_log_is_append_only_even_for_the_owner() {
    let store = store().await;
    let owner = admin().await;
    let t = tenant();
    create_company(&store, &scope(&t, &new_id("cmp"))).await;
    for sql in [
        "update audit_log set action = 'x' where tenant_id = $1",
        "delete from audit_log where tenant_id = $1",
    ] {
        let r = sqlx::query(sql).bind(t.as_str()).execute(&owner).await;
        assert!(r.is_err(), "{sql} must fail");
    }
    let rows: i64 = sqlx::query_scalar("select count(*) from audit_log where tenant_id = $1")
        .bind(t.as_str())
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(rows, 1);
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn state_changes_and_their_events_commit_or_roll_back_together() {
    let store = store().await;
    let t = tenant();
    let c = scope(&t, &new_id("cmp"));

    // Rolled back: neither the company nor its event exists.
    let mut tx = store.company(&c).await.unwrap();
    tx.create(&company_in("Acme"), &actor("alice")).await.unwrap();
    drop(tx);
    assert!(store.company(&c).await.unwrap().get().await.unwrap().is_none());
    assert!(outbox(&store, &t).await.is_empty());

    // Committed: both, with the scope's event group.
    create_company(&store, &c).await;
    let p = c.project(ProjectId::new(new_id("prj")).unwrap());
    let mut tx = store.project(&p).await.unwrap();
    let project = tx.create(&project_in("RAG"), &actor("alice")).await.unwrap().unwrap();
    assert_eq!(project.stage, oryxa_fde_core::Stage::Discover);
    tx.commit().await.unwrap();

    let rows = outbox(&store, &t).await;
    let summary: Vec<_> = rows.iter().map(|(_, d, g, _)| (d.as_str(), g.as_str())).collect();
    assert_eq!(
        summary,
        [
            ("fde.company.created.v1", c.event_group().as_str()),
            ("fde.project.created.v1", p.event_group().as_str()),
        ]
    );
    assert!(rows.iter().all(|(id, ..)| id.starts_with("evt_")));

    // A project in a company that does not exist is not created.
    let ghost = scope(&t, &new_id("cmp")).project(ProjectId::new(new_id("prj")).unwrap());
    let mut tx = store.project(&ghost).await.unwrap();
    assert!(tx.create(&project_in("x"), &actor("alice")).await.unwrap().is_none());
}

/// The relay sends every tenant's rows, so relay tests take turns to see only their own sends.
static RELAY_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Fails every send for one group, succeeds for the rest.
struct FailGroup {
    group: String,
    ok: MemoryPublisher,
}

impl Publisher for FailGroup {
    async fn send(&self, entry: Encoded) -> Result<(), PublishError> {
        if entry.group == self.group {
            return Err(PublishError::Bus("down".into()));
        }
        self.ok.send(entry).await
    }
}

/// Rows the relay would send now: due, and not held back by an earlier row of their group.
const DUE: &str = "select id from outbox o
     where published_at is null and dead_at is null and available_at <= now()
       and not exists (
           select 1 from outbox e
           where e.group_key = o.group_key and e.seq < o.seq
             and e.published_at is null and e.dead_at is null and e.available_at > now())";

/// Runs the relay until none of `t`'s rows can go out now (due and not held back by its group).
async fn drain<P: Publisher>(store: &Store, signer: &Signer, publisher: &P, t: &TenantId) {
    let owner = admin().await;
    for _ in 0..100 {
        dispatch_once(store, signer, publisher, 50).await.unwrap();
        let due: i64 = sqlx::query_scalar(&format!("select count(*) from ({DUE} and tenant_id = $1) due"))
            .bind(t.as_str())
            .fetch_one(&owner)
            .await
            .unwrap();
        if due == 0 {
            return;
        }
    }
    panic!("relay did not drain");
}

/// Asks the relay to stop while it sends a row of `group`, as a SIGTERM in the middle of a round.
struct StopDuringSend {
    group: String,
    stop: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    ok: Arc<MemoryPublisher>,
}

impl Publisher for StopDuringSend {
    async fn send(&self, entry: Encoded) -> Result<(), PublishError> {
        if entry.group == self.group
            && let Some(stop) = self.stop.lock().unwrap().take()
        {
            let _ = stop.send(());
        }
        self.ok.send(entry).await
    }
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_relay_asked_to_stop_mid_round_commits_the_round_and_then_returns() {
    let _turn = RELAY_TESTS.lock().await;
    let store = store().await;
    let (signer, _) = keys();
    let t = tenant();
    let c = scope(&t, &new_id("cmp"));
    create_company(&store, &c).await;
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let publisher = StopDuringSend {
        group: c.event_group(),
        stop: std::sync::Mutex::new(Some(stop)),
        ok: Arc::default(),
    };
    let sent = publisher.ok.clone();
    let run = crate::relay::run(store.clone(), signer, publisher, async {
        let _ = stopped.await;
    });
    tokio::time::timeout(Duration::from_secs(30), run)
        .await
        .expect("the relay returns once its round is done");
    // The row whose send asked to stop was still committed as published, and sent once.
    let rows = outbox(&store, &t).await;
    assert_eq!(rows.len(), 1);
    assert!(rows[0].3, "published");
    let ours = sent.sent().into_iter().filter(|e| e.group == c.event_group()).count();
    assert_eq!(ours, 1);
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn relay_signs_and_publishes_in_order_with_the_row_id_and_scope_group() {
    let _turn = RELAY_TESTS.lock().await;
    let store = store().await;
    let owner = admin().await;
    let (signer, verifier) = keys();
    let t = tenant();
    let c = scope(&t, &new_id("cmp"));
    create_company(&store, &c).await;
    // Two more events in the company's group, so order within a group is visible.
    let mut tx = store.company(&c).await.unwrap();
    for _ in 0..2 {
        enqueue(tx.conn(), &c, &actor("alice"), &CompanyCreated::new(&c))
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let p = c.project(ProjectId::new(new_id("prj")).unwrap());
    let mut tx = store.project(&p).await.unwrap();
    tx.create(&project_in("RAG"), &actor("alice")).await.unwrap();
    tx.commit().await.unwrap();
    let rows = outbox(&store, &t).await;
    let company_rows: Vec<&String> = rows.iter().filter(|r| r.2 == c.event_group()).map(|r| &r.0).collect();
    assert_eq!(company_rows.len(), 3);

    // The company group's bus is down: its first row fails and holds the other two back; the
    // project group is unaffected.
    let down = FailGroup {
        group: c.event_group(),
        ok: MemoryPublisher::default(),
    };
    drain(&store, &signer, &down, &t).await;
    let sent: Vec<Encoded> = down
        .ok
        .sent()
        .into_iter()
        .filter(|e| e.group.starts_with(t.as_str()))
        .collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].group, p.event_group());
    let got = decode::<ProjectCreated>(&verifier, &sent[0].source, &sent[0].detail_type, &sent[0].detail).unwrap();
    assert_eq!(got.data.scope(&got.tenant), p);
    let (attempts, error): (i32, String) = sqlx::query_as("select attempts, last_error from outbox where id = $1")
        .bind(company_rows[0])
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!((attempts, error.as_str()), (1, "eventbridge: down"));

    // Backoff over, bus back: the group goes out in its original order, each with its row id as
    // the event id (the bus deduplication id) and a valid signature.
    sqlx::query("update outbox set available_at = now() where tenant_id = $1")
        .bind(t.as_str())
        .execute(&owner)
        .await
        .unwrap();
    let up = MemoryPublisher::default();
    drain(&store, &signer, &up, &t).await;
    let sent: Vec<Encoded> = up.sent().into_iter().filter(|e| e.group == c.event_group()).collect();
    assert_eq!(sent.iter().map(|e| &e.event_id).collect::<Vec<_>>(), company_rows);
    for e in &sent {
        let got = decode::<CompanyCreated>(&verifier, &e.source, &e.detail_type, &e.detail).unwrap();
        assert_eq!(
            (got.tenant.as_str(), got.envelope.event_id.as_str()),
            (t.as_str(), e.event_id.as_str())
        );
        assert_eq!(got.data.scope(&got.tenant), c);
    }
    assert!(
        outbox(&store, &t).await.iter().all(|r| r.3),
        "every row is marked published"
    );
    // Nothing is sent twice.
    let again = MemoryPublisher::default();
    drain(&store, &signer, &again, &t).await;
    assert!(again.sent().iter().all(|e| !e.group.starts_with(t.as_str())));
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_row_that_keeps_failing_goes_dead_after_a_day_and_can_be_replayed() {
    let _turn = RELAY_TESTS.lock().await;
    let store = store().await;
    let owner = admin().await;
    let (signer, _) = keys();
    let t = tenant();
    let c = scope(&t, &new_id("cmp"));
    create_company(&store, &c).await;
    let mut tx = store.company(&c).await.unwrap();
    enqueue(tx.conn(), &c, &actor("alice"), &CompanyCreated::new(&c))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let rows = outbox(&store, &t).await;
    let down = FailGroup {
        group: c.event_group(),
        ok: MemoryPublisher::default(),
    };
    let dead = |id: String| {
        let owner = owner.clone();
        async move {
            sqlx::query_scalar::<_, bool>("select dead_at is not null from outbox where id = $1")
                .bind(id)
                .fetch_one(&owner)
                .await
                .unwrap()
        }
    };

    // Many failures within a day: still retried, never dead.
    sqlx::query("update outbox set attempts = 500, retry_since = now() - interval '23 hours' where id = $1")
        .bind(&rows[0].0)
        .execute(&owner)
        .await
        .unwrap();
    drain(&store, &signer, &down, &t).await;
    assert!(!dead(rows[0].0.clone()).await);
    let wait: f64 =
        sqlx::query_scalar("select extract(epoch from available_at - now())::float8 from outbox where id = $1")
            .bind(&rows[0].0)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(wait <= relay::MAX_BACKOFF.as_secs_f64() + 1.0, "backoff {wait}s");

    // Failing for over a day: dead, and its group is no longer held back.
    sqlx::query("update outbox set available_at = now(), retry_since = now() - interval '25 hours' where id = $1")
        .bind(&rows[0].0)
        .execute(&owner)
        .await
        .unwrap();
    drain(&store, &signer, &down, &t).await;
    assert!(dead(rows[0].0.clone()).await);
    let up = MemoryPublisher::default();
    sqlx::query("update outbox set available_at = now() where tenant_id = $1")
        .bind(t.as_str())
        .execute(&owner)
        .await
        .unwrap();
    drain(&store, &signer, &up, &t).await;
    let published: Vec<bool> = outbox(&store, &t).await.into_iter().map(|r| r.3).collect();
    assert_eq!(published, [false, true]);

    // A replay puts it back in line with a fresh day of retries, and it goes out.
    assert_eq!(
        replay_dead(&store, Some(&tenant())).await.unwrap(),
        0,
        "other tenants untouched"
    );
    assert_eq!(replay_dead(&store, Some(&t)).await.unwrap(), 1);
    assert!(!dead(rows[0].0.clone()).await);
    drain(&store, &signer, &up, &t).await;
    let published: Vec<bool> = outbox(&store, &t).await.into_iter().map(|r| r.3).collect();
    assert_eq!(published, [true, true]);
    assert_eq!(
        replay_dead(&store, Some(&t)).await.unwrap(),
        0,
        "a published row is never replayed"
    );
}

/// Never answers.
struct Hang;

impl Publisher for Hang {
    async fn send(&self, _: Encoded) -> Result<(), PublishError> {
        std::future::pending().await
    }
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_send_that_never_returns_times_out_and_ends_the_batch() {
    let _turn = RELAY_TESTS.lock().await;
    let store = store().await;
    let (signer, _) = keys();
    let owner = admin().await;
    for _ in 0..2 {
        create_company(&store, &scope(&tenant(), &new_id("cmp"))).await;
    }
    // The relay serves every tenant, so the row it tries first may be any test's.
    let first: String = sqlx::query_scalar(&format!("{DUE} order by seq limit 1"))
        .fetch_one(&owner)
        .await
        .unwrap();
    let stats = relay::dispatch(&store, &signer, &Hang, 50, std::time::Duration::from_millis(200))
        .await
        .unwrap();
    assert_eq!(
        (stats.published, stats.failed, stats.dead),
        (0, 1, 0),
        "one try, then the batch stops"
    );
    let error: String = sqlx::query_scalar("select last_error from outbox where id = $1")
        .bind(&first)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(error, "send timed out after 200ms");
}

/// Outbox payloads of one tenant with a given detail type, oldest first.
async fn payloads(store: &Store, t: &TenantId, detail_type: &str) -> Vec<serde_json::Value> {
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("set local role oryxa_fde_relay")
        .execute(&mut *tx)
        .await
        .unwrap();
    let details: Vec<String> =
        sqlx::query_scalar("select detail from outbox where tenant_id = $1 and detail_type = $2 order by seq")
            .bind(t.as_str())
            .bind(detail_type)
            .fetch_all(&mut *tx)
            .await
            .unwrap();
    details
        .iter()
        .map(|d| serde_json::from_str::<serde_json::Value>(d).unwrap()["data"].clone())
        .collect()
}

/// A tenant with one company and one project in it.
async fn project_world(store: &Store) -> (TenantId, ProjectScope) {
    let t = tenant();
    let c = scope(&t, &new_id("cmp"));
    create_company(store, &c).await;
    let p = c.project(ProjectId::new(new_id("prj")).unwrap());
    let mut tx = store.project(&p).await.unwrap();
    tx.create(&project_in("RAG"), &actor("alice")).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    (t, p)
}

async fn add_stakeholder(store: &Store, c: &CompanyScope) -> oryxa_fde_core::StakeholderId {
    let id = oryxa_fde_core::StakeholderId::new(new_id("stk")).unwrap();
    let mut tx = store.company(c).await.unwrap();
    let v = StakeholderIn {
        name: Name::new("Sam Sponsor").unwrap(),
        title: Some(Name::new("VP Engineering").unwrap()),
        role: StakeholderRole::Sponsor,
        email: None,
    };
    tx.add_stakeholder(&id, &v, &actor("alice")).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    id
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn stage_changes_write_their_event_in_the_same_transaction() {
    use oryxa_fde_core::{Stage, StageError};
    let store = store().await;
    let (t, p) = project_world(&store).await;
    let changed = "fde.project.stage-changed.v1";

    // Rolled back: the stage and the event both stay as they were.
    let why = Reason::new("discovery happened on a call").unwrap();
    let mut tx = store.project(&p).await.unwrap();
    tx.change_stage(Stage::Scope, Some(&why), &actor("alice"))
        .await
        .unwrap()
        .unwrap();
    drop(tx);
    let mut tx = store.project(&p).await.unwrap();
    assert_eq!(tx.get().await.unwrap().unwrap().stage, Stage::Discover);
    assert!(payloads(&store, &t, changed).await.is_empty());

    // Skipping ahead is refused by the stage machine.
    assert!(matches!(
        tx.change_stage(Stage::Build, Some(&why), &actor("alice")).await,
        Err(StoreError::Stage(StageError::Skip { .. }))
    ));
    drop(tx);

    let mut tx = store.project(&p).await.unwrap();
    let moved = tx
        .change_stage(Stage::Scope, Some(&why), &actor("alice"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(moved.stage, Stage::Scope);
    tx.commit().await.unwrap();
    let events = payloads(&store, &t, changed).await;
    assert_eq!(events.len(), 1);
    assert_eq!(
        (
            events[0]["project"].as_str(),
            events[0]["from"].as_str(),
            events[0]["to"].as_str()
        ),
        (Some(p.project.as_str()), Some("discover"), Some("scope"))
    );
    let rows = outbox(&store, &t).await;
    assert_eq!(rows.last().unwrap().2, p.event_group());
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn sign_off_pins_a_scope_version_and_writes_its_event_in_the_same_transaction() {
    let store = store().await;
    let (t, p) = project_world(&store).await;
    let signed = "fde.scope.signed-off.v1";
    let sam = add_stakeholder(&store, &p.company).await;
    let by = actor("alice");

    let mut tx = store.project(&p).await.unwrap();
    assert!(matches!(
        tx.sign_off(&sam, &by).await,
        Err(StoreError::Rejected("empty_scope"))
    ));
    drop(tx);

    let mut tx = store.project(&p).await.unwrap();
    let item = ScopeItemId::new(new_id("itm")).unwrap();
    let v = ScopeItemIn {
        kind: ScopeKind::In,
        description: Text::new("Answer tier-1 support tickets").unwrap(),
    };
    tx.add_scope_item(&item, &v, &by).await.unwrap().unwrap();
    let crit = oryxa_fde_core::CriterionId::new(new_id("crt")).unwrap();
    let c = CriterionIn {
        description: Text::new("Answers are correct").unwrap(),
        metric: Name::new("accuracy").unwrap(),
        comparator: Comparator::AtLeast,
        target: 90.0,
        unit: Some(Name::new("%").unwrap()),
    };
    tx.add_criterion(&crit, &c, &by).await.unwrap().unwrap();
    let unknown = oryxa_fde_core::StakeholderId::new("stk_nobody").unwrap();
    assert!(matches!(
        tx.sign_off(&unknown, &by).await,
        Err(StoreError::Missing("stakeholder"))
    ));
    tx.commit().await.unwrap();

    // Rolled back: no sign-off and no event.
    let mut tx = store.project(&p).await.unwrap();
    tx.sign_off(&sam, &by).await.unwrap().unwrap();
    drop(tx);
    assert!(payloads(&store, &t, signed).await.is_empty());

    let mut tx = store.project(&p).await.unwrap();
    let s = tx.sign_off(&sam, &by).await.unwrap().unwrap();
    assert_eq!((s.version, &s.stakeholder), (2, &sam));
    tx.commit().await.unwrap();
    let events = payloads(&store, &t, signed).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["version"], 2);

    // The same version cannot be signed twice; a change makes the sign-off stale.
    let mut tx = store.project(&p).await.unwrap();
    assert!(matches!(tx.sign_off(&sam, &by).await, Err(StoreError::Conflict)));
    drop(tx);
    let mut tx = store.project(&p).await.unwrap();
    tx.remove_criterion(&crit, &by).await.unwrap();
    let scope = tx.scope_of_work().await.unwrap().unwrap();
    assert_eq!((scope.version, scope.sign_off.unwrap().version), (3, 2));
    assert_eq!((scope.items.len(), scope.criteria.len()), (1, 0));
    let log: Vec<(u32, String)> = tx
        .scope_changes()
        .await
        .unwrap()
        .into_iter()
        .map(|c| (c.version, c.action))
        .collect();
    assert_eq!(
        log,
        [
            (1, "item_added".into()),
            (2, "criterion_added".into()),
            (2, "signed_off".into()),
            (3, "criterion_removed".into())
        ]
    );
    // The log keeps what each change set, so the signed version can be rebuilt after it changed.
    let changes = tx.scope_changes().await.unwrap();
    let signed = changes[2].content.clone().unwrap();
    assert_eq!(signed["stakeholder"], sam.as_str());
    assert_eq!(signed["items"][0]["description"], "Answer tier-1 support tickets");
    assert_eq!(
        (
            signed["criteria"][0]["metric"].as_str(),
            signed["criteria"][0]["target"].as_f64()
        ),
        (Some("accuracy"), Some(90.0))
    );
    let removed = changes[3].content.clone().unwrap();
    assert_eq!(
        (removed["id"].as_str(), removed["unit"].as_str()),
        (Some(crit.as_str()), Some("%"))
    );
    assert_eq!(changes[0].content.clone().unwrap()["kind"], "in");
    tx.commit().await.unwrap();

    // A stakeholder who signed cannot be deleted.
    let mut tx = store.company(&p.company).await.unwrap();
    assert!(matches!(
        tx.remove_stakeholder(&sam, &by).await,
        Err(StoreError::Conflict)
    ));
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn access_status_changes_write_their_event_in_the_same_transaction() {
    use oryxa_fde_events::AccessStatus;
    let store = store().await;
    let (t, p) = project_world(&store).await;
    let changed = "fde.access-request.status-changed.v1";
    let owner = add_stakeholder(&store, &p.company).await;
    let by = actor("alice");
    let id = oryxa_fde_core::AccessRequestId::new(new_id("acc")).unwrap();
    let mut v = AccessRequestIn {
        description: Text::new("Read-only Zendesk API token").unwrap(),
        system: None,
        owner: Some(owner),
        status: AccessStatus::Requested,
    };

    let mut tx = store.project(&p).await.unwrap();
    // A request starts open: created settled, it would never report its status change.
    for settled in [AccessStatus::Granted, AccessStatus::Denied, AccessStatus::Revoked] {
        let early = AccessRequestIn {
            status: settled,
            ..v.clone()
        };
        assert!(matches!(
            tx.add_access_request(&id, &early, &by).await,
            Err(StoreError::Rejected("initial_status"))
        ));
    }
    let ghost = AccessRequestIn {
        owner: Some(oryxa_fde_core::StakeholderId::new("stk_ghost").unwrap()),
        ..v.clone()
    };
    assert!(matches!(
        tx.add_access_request(&id, &ghost, &by).await,
        Err(StoreError::Missing("owner"))
    ));
    drop(tx);
    let mut tx = store.project(&p).await.unwrap();
    let r = tx.add_access_request(&id, &v, &by).await.unwrap().unwrap();
    assert_eq!(
        (r.status, r.days_waiting, r.granted_at),
        (AccessStatus::Requested, 0, None)
    );
    tx.commit().await.unwrap();
    assert!(
        payloads(&store, &t, changed).await.is_empty(),
        "creating is not a status change"
    );

    // Three days later the customer grants it, in a transaction that is rolled back first.
    sqlx::query(
        "update access_requests set requested_at = now() - interval '3 days 1 hour' where access_request_id = $1",
    )
    .bind(id.as_str())
    .execute(&admin().await)
    .await
    .unwrap();
    v.status = AccessStatus::Granted;
    let mut tx = store.project(&p).await.unwrap();
    tx.update_access_request(&id, &v, &by).await.unwrap().unwrap();
    drop(tx);
    assert!(payloads(&store, &t, changed).await.is_empty());

    let mut tx = store.project(&p).await.unwrap();
    let r = tx.update_access_request(&id, &v, &by).await.unwrap().unwrap();
    assert_eq!((r.status, r.days_waiting), (AccessStatus::Granted, 3));
    assert!(r.granted_at.is_some());
    // Same status again: no new event.
    tx.update_access_request(&id, &v, &by).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    let events = payloads(&store, &t, changed).await;
    assert_eq!(events.len(), 1);
    assert_eq!(
        (
            events[0]["access_request"].as_str(),
            events[0]["from"].as_str(),
            events[0]["to"].as_str()
        ),
        (Some(id.as_str()), Some("requested"), Some("granted"))
    );

    // Asked for again: waiting restarts counting from the original request.
    v.status = AccessStatus::InProgress;
    let mut tx = store.project(&p).await.unwrap();
    let r = tx.update_access_request(&id, &v, &by).await.unwrap().unwrap();
    assert_eq!((r.granted_at, r.days_waiting), (None, 3));
    tx.commit().await.unwrap();
    assert_eq!(payloads(&store, &t, changed).await.len(), 2);
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn row_level_security_covers_every_lifecycle_table() {
    let store = store().await;
    let by = actor("alice");
    // Two projects in two companies of one tenant, each with one of every record, plus a
    // security answer in this tenant and another.
    let (t, a) = project_world(&store).await;
    let b = {
        let c = scope(&t, &new_id("cmp"));
        create_company(&store, &c).await;
        let p = c.project(ProjectId::new(new_id("prj")).unwrap());
        let mut tx = store.project(&p).await.unwrap();
        tx.create(&project_in("B"), &by).await.unwrap().unwrap();
        tx.commit().await.unwrap();
        p
    };
    for p in [&a, &b] {
        let stakeholder = add_stakeholder(&store, &p.company).await;
        let mut tx = store.company(&p.company).await.unwrap();
        let with_email = StakeholderIn {
            name: Name::new("Sam Sponsor").unwrap(),
            title: None,
            role: StakeholderRole::Sponsor,
            email: Some(EmailAddress::new("sam@acme.example").unwrap()),
        };
        tx.update_stakeholder(&stakeholder, &with_email, &by)
            .await
            .unwrap()
            .unwrap();
        let sys = oryxa_fde_core::SystemId::new(new_id("sys")).unwrap();
        let v = SystemIn {
            name: Name::new("Zendesk").unwrap(),
            kind: Some(Name::new("Ticketing").unwrap()),
            description: None,
        };
        tx.add_system(&sys, &v, &by).await.unwrap().unwrap();
        tx.commit().await.unwrap();
        let mut tx = store.project(p).await.unwrap();
        let item = ScopeItemIn {
            kind: ScopeKind::Out,
            description: Text::new("Voice support").unwrap(),
        };
        tx.add_scope_item(&ScopeItemId::new(new_id("itm")).unwrap(), &item, &by)
            .await
            .unwrap()
            .unwrap();
        let crit = CriterionIn {
            description: Text::new("Fast").unwrap(),
            metric: Name::new("p95 latency").unwrap(),
            comparator: Comparator::AtMost,
            target: 2.0,
            unit: Some(Name::new("s").unwrap()),
        };
        let criterion = oryxa_fde_core::CriterionId::new(new_id("crt")).unwrap();
        tx.add_criterion(&criterion, &crit, &by).await.unwrap().unwrap();
        tx.sign_off(&stakeholder, &by).await.unwrap().unwrap();
        // A share link a guest redeemed, the project's sponsor, and the week's digest claimed for them.
        let link = oryxa_fde_core::ShareLinkId::new(new_id("shr")).unwrap();
        tx.create_share_link(&link, &"ab".repeat(32), 7, &by)
            .await
            .unwrap()
            .unwrap();
        tx.redeem_share_link(&link, &"ab".repeat(32), &UserId::new("guest_1").unwrap(), &by)
            .await
            .unwrap();
        tx.add_project_sponsor(&stakeholder, &by).await.unwrap().unwrap();
        let monday = time::macros::date!(2026 - 11 - 02);
        tx.add_update_draft(monday, &UpdateBody::new("Done this week").unwrap(), "echo")
            .await
            .unwrap();
        tx.decide_update_draft(monday, true, &by).await.unwrap().unwrap();
        assert!(tx.claim_digest(monday, &stakeholder).await.unwrap().is_some());
        let access = AccessRequestIn {
            description: Text::new("Zendesk token").unwrap(),
            system: Some(sys),
            owner: Some(stakeholder),
            status: oryxa_fde_events::AccessStatus::Requested,
        };
        tx.add_access_request(
            &oryxa_fde_core::AccessRequestId::new(new_id("acc")).unwrap(),
            &access,
            &by,
        )
        .await
        .unwrap()
        .unwrap();
        let task = TaskIn {
            title: Name::new("Index tickets").unwrap(),
            status: TaskStatus::WaitingOnCustomer,
            blocker: None,
            due_on: None,
            assignee: None,
            waiting_on: None,
            blocked_by: None,
        };
        tx.add_task(&oryxa_fde_core::TaskId::new(new_id("tsk")).unwrap(), &task, &by)
            .await
            .unwrap()
            .unwrap();
        let decision = DecisionIn {
            title: Name::new("Use Bedrock").unwrap(),
            rationale: Text::new("Data stays in their AWS account").unwrap(),
            decided_by: Name::new("Sam Sponsor").unwrap(),
            decided_at: time::OffsetDateTime::now_utc(),
        };
        tx.record_decision(&oryxa_fde_core::DecisionId::new(new_id("dec")).unwrap(), &decision, &by)
            .await
            .unwrap()
            .unwrap();
        // An agent run with its transcript, an approval, the project's budget and the company's sandbox lease.
        let run = AgentRunRow {
            id: oryxa_fde_core::AgentRunId::new(new_id("run")).unwrap(),
            task: "Add a /healthz endpoint.".into(),
            repository: serde_json::json!({ "owner": "sample-org", "name": "status-page", "base": "main" }),
            created_by: by.user.clone(),
            request_id: new_id("req"),
            created_at: time::OffsetDateTime::now_utc(),
            started_at: None,
            ended_at: None,
            state: serde_json::json!({ "state": "queued" }),
            input_tokens: 0,
            output_tokens: 0,
            delivery: serde_json::json!({ "status": "none" }),
        };
        tx.create_agent_run(&run, &by).await.unwrap();
        tx.append_agent_event(&run.id, 0, "{}").await.unwrap();
        let approval = AgentApprovalRow {
            run: run.id.clone(),
            id: "apr_1".into(),
            tool_call_id: "toolu_1".into(),
            action: "deploy".into(),
            title: "Run: npx wrangler deploy".into(),
            tool: "Bash".into(),
            input: "{}".into(),
            requested_at: time::OffsetDateTime::now_utc(),
            decision: None,
        };
        tx.add_agent_approval(&approval).await.unwrap();
        tx.set_agent_budget(AgentBudget::default(), &by).await.unwrap();
        assert!(
            tx.take_agent_sandbox(&run.id, std::time::Duration::from_secs(60))
                .await
                .unwrap()
                .is_some()
        );
        // An eval suite measuring the criterion, with one case, and a finished run of it.
        let suite = EvalSuiteRow {
            id: new_id("suite"),
            name: "Latency".into(),
            criteria: vec![criterion.clone()],
            definition: serde_json::json!({ "graders": [] }),
            created_by: by.user.clone(),
            created_at: time::OffsetDateTime::now_utc(),
            cases: vec![EvalCaseRow {
                id: "case_1".into(),
                input: "Sample ticket".into(),
                expected: None,
                criteria: vec![],
            }],
        };
        tx.create_eval_suite(&suite, &by).await.unwrap();
        let eval = EvalRunRow {
            id: oryxa_fde_core::EvalRunId::new(new_id("eval")).unwrap(),
            suite: suite.id.clone(),
            imported: true,
            created_by: by.user.clone(),
            request_id: new_id("req"),
            created_at: time::OffsetDateTime::now_utc(),
            ended_at: None,
            results: None,
        };
        tx.create_eval_run(&eval, &by).await.unwrap();
        let results = EvalResults {
            cases: vec![EvalCaseResultRow {
                case: "case_1".into(),
                outcome: "passed".into(),
                output: Some("ok".into()),
                verdicts: "[]".into(),
                error: None,
            }],
            criteria: vec![(criterion, EvalCriterionRow { passed: 1, total: 1 })],
            passed: 1,
            failed: 0,
            errored: 0,
        };
        tx.finish_eval_run(&eval.id, &results, &by).await.unwrap();
        tx.commit().await.unwrap();
    }
    let t2 = tenant();
    for tenant in [&t, &t2] {
        let mut tx = store.organisation(tenant).await.unwrap();
        let v = SecurityAnswerIn {
            question: Text::new("Do you encrypt data at rest?").unwrap(),
            answer: Text::new("Yes, AES-256 with KMS").unwrap(),
        };
        tx.add_security_answer(&SecurityAnswerId::new(new_id("ans")).unwrap(), &v, &by)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }

    // In A's transaction an unfiltered query sees exactly A's one row in every table.
    let mut tx = store.company(&a.company).await.unwrap();
    for table in [
        "stakeholders",
        "systems",
        "scope_items",
        "criteria",
        "scope_signoffs",
        "access_requests",
        "tasks",
        "decisions",
        "agent_runs",
        "agent_run_events",
        "agent_approvals",
        "agent_budgets",
        "agent_sandbox_leases",
        "eval_suites",
        "eval_suite_criteria",
        "eval_cases",
        "eval_runs",
        "eval_case_results",
        "eval_criterion_results",
        "share_links",
        "share_link_guests",
        "project_sponsors",
        "digest_deliveries",
    ] {
        let companies: Vec<String> = sqlx::query_scalar(&format!("select company_id from {table}"))
            .fetch_all(tx.conn())
            .await
            .unwrap();
        assert_eq!(companies, [a.company.company.as_str()], "{table}");
    }
    let versions: Vec<i32> = sqlx::query_scalar("select distinct version from scope_changes")
        .fetch_all(tx.conn())
        .await
        .unwrap();
    assert!(!versions.is_empty());
    let changes_elsewhere: i64 = sqlx::query_scalar("select count(*) from scope_changes where company_id <> $1")
        .bind(a.company.company.as_str())
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(changes_elsewhere, 0);
    // The org library is the tenant's, whichever company the transaction is for; never another tenant's.
    let tenants: Vec<String> = sqlx::query_scalar("select tenant_id from security_answers")
        .fetch_all(tx.conn())
        .await
        .unwrap();
    assert_eq!(tenants, [t.as_str()]);
    // Decisions, the scope change log, agent transcripts and eval results are append-only for the app; an agent
    // run's record, an approval's request and an eval run's record (but its end) never change once written.
    for sql in [
        "update decisions set title = 'x'",
        "delete from scope_changes",
        "update scope_signoffs set version = 9",
        "update agent_run_events set line = '{}'",
        "delete from agent_runs",
        "update agent_runs set task = 'x'",
        "update agent_runs set created_by = 'x'",
        "update agent_approvals set input = '{}'",
        "update agent_approvals set action = 'x'",
        "update agent_budgets set company_id = 'x'",
        "update agent_sandbox_leases set company_id = 'x'",
        "update eval_suites set definition = '{}'",
        "delete from eval_suites",
        "update eval_suite_criteria set criterion_id = 'x'",
        "delete from eval_suite_criteria",
        "update eval_cases set input = 'x'",
        "update eval_runs set suite_id = 'x'",
        "update eval_runs set created_by = 'x'",
        "delete from eval_runs",
        "update eval_case_results set outcome = 'passed'",
        "update eval_criterion_results set passed = 9",
    ] {
        let mut sp = tx.conn().begin().await.unwrap();
        assert!(sqlx::query(sql).execute(&mut *sp).await.is_err(), "{sql}");
    }
    drop(tx);

    let mut org = store.organisation(&t2).await.unwrap();
    assert_eq!(org.security_answers().await.unwrap().len(), 1);
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn the_runtime_login_owns_nothing_and_holds_nothing_outside_a_role() {
    let owner = admin().await;
    // The owner (here the container's superuser) is refused as the runtime login.
    match Store::connect(&testing::database_url()).await {
        Err(StoreError::Privileged(why)) => assert!(why.contains("(superuser)"), "{why}"),
        other => panic!("the owner must be refused: {:?}", other.err()),
    }

    let store = store().await;
    create_company(&store, &scope(&tenant(), &new_id("cmp"))).await;
    let mut conn = store.pool.acquire().await.unwrap();
    // Outside a transaction's role it can read nothing...
    for sql in [
        "select count(*) from companies",
        "select count(*) from outbox",
        "select count(*) from audit_log",
        "select count(*) from company_members",
        "select count(*) from agent_runs",
        "select count(*) from agent_run_events",
        "select count(*) from agent_approvals",
        "select count(*) from agent_budgets",
        "select count(*) from agent_sandbox_leases",
        "select count(*) from eval_suites",
        "select count(*) from eval_suite_criteria",
        "select count(*) from eval_cases",
        "select count(*) from eval_runs",
        "select count(*) from eval_case_results",
        "select count(*) from eval_criterion_results",
    ] {
        assert!(sqlx::query(sql).execute(&mut *conn).await.is_err(), "{sql}");
    }
    // ...and it can neither become the owner nor make a role.
    let table_owner: String =
        sqlx::query_scalar("select tableowner::text from pg_tables where tablename = 'companies'")
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(
        sqlx::query(&format!("set role \"{table_owner}\""))
            .execute(&mut *conn)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("create role fde_should_not_exist")
            .execute(&mut *conn)
            .await
            .is_err()
    );
    drop(conn);

    // A login that could switch to the owner is refused, even with no other power.
    let login = new_id("fde_rt");
    let password = new_id("pw");
    for sql in [
        format!("create role {login} login password '{password}'"),
        format!("grant oryxa_fde_runtime to {login}"),
        format!("grant \"{table_owner}\" to {login}"),
    ] {
        sqlx::query(&sql).execute(&owner).await.unwrap();
    }
    let options = testing::database_url()
        .parse::<PgConnectOptions>()
        .unwrap()
        .username(&login)
        .password(&password);
    match Store::connect_with(options).await {
        Err(StoreError::Privileged(why)) => assert!(why.contains("owns"), "{why}"),
        other => panic!("a member of the owner must be refused: {:?}", other.err()),
    }
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_grant_waits_for_a_revocation_in_flight_and_then_finds_nothing() {
    let store = store().await;
    let t = tenant();
    let c = scope(&t, &new_id("cmp"));
    create_company(&store, &c).await;
    let bob = UserId::new("bob").unwrap();
    let row = GrantRow::Member(c.clone(), bob.clone());
    let mut tx = store.company(&c).await.unwrap();
    tx.set_member(&bob, Role::Engineer, &actor("alice")).await.unwrap();
    // Not committed yet: there is nothing to grant.
    assert!(store.lock_grant(&row).await.unwrap().is_none());
    tx.commit().await.unwrap();
    // The grant follows the row as it is now.
    let mut tx = store.company(&c).await.unwrap();
    tx.set_member(&bob, Role::Lead, &actor("alice")).await.unwrap();
    tx.commit().await.unwrap();
    let pending = store.lock_grant(&row).await.unwrap().unwrap();
    assert_eq!(pending.grant(), &Grant::Member(c.clone(), bob.clone(), Role::Lead));
    pending.done().await.unwrap();

    // A revocation in flight holds the row, so a grant waits for it...
    let mut revoke = store.company(&c).await.unwrap();
    revoke.remove_member(&bob, &actor("alice")).await.unwrap();
    let waiting = {
        let (store, row) = (store.clone(), row.clone());
        tokio::spawn(async move { store.lock_grant(&row).await.unwrap().map(|g| g.grant().clone()) })
    };
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(!waiting.is_finished(), "the grant must wait for the revocation");
    revoke.commit().await.unwrap();
    // ...and once the revocation commits it finds no row, so it grants nothing.
    assert_eq!(waiting.await.unwrap(), None);
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn grants_stay_pending_for_the_reconciler_until_written() {
    let store = store().await;
    let t = tenant();
    let c = scope(&t, &new_id("cmp"));
    create_company(&store, &c).await;
    let p = c.project(ProjectId::new(new_id("prj")).unwrap());
    let carol = UserId::new("carol").unwrap();
    let mut tx = store.project(&p).await.unwrap();
    tx.create(&project_in("RAG"), &actor("alice")).await.unwrap().unwrap();
    tx.assign(&carol, &actor("alice")).await.unwrap();
    tx.commit().await.unwrap();
    // Leftovers of other runs come first, so take plenty and keep this tenant's.
    let mine = |grants: &[Grant]| -> Vec<Grant> { grants.iter().filter(|g| g.tenant() == &t).cloned().collect() };

    // A grant the API is writing right now is skipped, not waited for.
    let held = store.lock_grant(&GrantRow::Company(c.clone())).await.unwrap().unwrap();
    let pending = store.pending_grants(&t, 10_000).await.unwrap();
    assert_eq!(
        mine(pending.grants()),
        [
            Grant::Member(c.clone(), UserId::new("alice").unwrap(), Role::Lead),
            Grant::ProjectCompany(p.clone()),
            Grant::Assignee(p.clone(), carol.clone()),
        ]
    );
    drop(pending);
    held.done().await.unwrap();

    // Marked grants are done; the rest stay until marked.
    let mut pending = store.pending_grants(&t, 10_000).await.unwrap();
    let left = mine(pending.grants());
    assert_eq!(left.len(), 3);
    pending.mark(&left[0]).await.unwrap();
    pending.mark(&left[2]).await.unwrap();
    pending.commit().await.unwrap();
    let pending = store.pending_grants(&t, 10_000).await.unwrap();
    assert_eq!(mine(pending.grants()), [Grant::ProjectCompany(p.clone())]);
}

fn task_in(title: &str, status: TaskStatus) -> TaskIn {
    TaskIn {
        title: Name::new(title).unwrap(),
        status,
        blocker: (status == TaskStatus::Blocked).then(|| Text::new("waiting on IT").unwrap()),
        due_on: None,
        assignee: None,
        waiting_on: None,
        blocked_by: None,
    }
}

async fn add_project(store: &Store, c: &CompanyScope, name: &str) -> ProjectScope {
    let p = c.project(ProjectId::new(new_id("prj")).unwrap());
    let mut tx = store.project(&p).await.unwrap();
    tx.create(&project_in(name), &actor("alice")).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    p
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn the_today_view_reads_exactly_the_projects_it_names() {
    use oryxa_fde_core::{AccessRequestId, TaskId};
    use oryxa_fde_events::AccessStatus;
    let store = store().await;
    let by = actor("alice");
    let t = tenant();
    let c = scope(&t, &new_id("cmp"));
    create_company(&store, &c).await;
    let (p1, p2) = (
        add_project(&store, &c, "Mine").await,
        add_project(&store, &c, "Not mine").await,
    );
    let owner = add_stakeholder(&store, &c).await;
    for p in [&p1, &p2] {
        let mut tx = store.project(p).await.unwrap();
        for (title, status) in [("Open", TaskStatus::Todo), ("Closed", TaskStatus::Done)] {
            tx.add_task(&TaskId::new(new_id("tsk")).unwrap(), &task_in(title, status), &by)
                .await
                .unwrap()
                .unwrap();
        }
        let access = AccessRequestIn {
            description: Text::new("VPN").unwrap(),
            system: None,
            owner: Some(owner.clone()),
            status: AccessStatus::Requested,
        };
        tx.add_access_request(&AccessRequestId::new(new_id("acc")).unwrap(), &access, &by)
            .await
            .unwrap()
            .unwrap();
        tx.commit().await.unwrap();
    }
    let other = scope(&tenant(), &new_id("cmp"));
    create_company(&store, &other).await;
    let elsewhere = add_project(&store, &other, "Other tenant").await;

    // Only ids of this tenant resolve; another tenant's project id is not found.
    let scopes = store
        .project_scopes(&t, &[p1.project.clone(), elsewhere.project.clone()])
        .await
        .unwrap();
    assert_eq!(scopes, std::slice::from_ref(&p1));

    // One project named: its open task and its unsettled request, nothing of the other project.
    let items = store.today(&scopes).await.unwrap();
    assert_eq!(items.len(), 2);
    for item in &items {
        match item {
            TodayItem::Task { task, project, company } => {
                assert_eq!(
                    (task.title.as_str(), &project.id, project.name.as_str()),
                    ("Open", &p1.project, "Mine")
                );
                assert_eq!(company.id, c.company);
            }
            TodayItem::AccessRequest { owner, project, .. } => {
                assert_eq!(
                    (owner.as_ref().map(Name::as_str), &project.id),
                    (Some("Sam Sponsor"), &p1.project)
                );
            }
        }
    }
    assert!(matches!(
        store.today(&[p1.clone(), elsewhere.clone()]).await,
        Err(StoreError::MixedTenants)
    ));

    // The by-project policy reads the named projects' rows, and nothing else of their company.
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("set local role oryxa_fde_app")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("select set_config('fde.tenant', $1, true), set_config('fde.projects', $2, true)")
        .bind(t.as_str())
        .bind(p1.project.as_str())
        .execute(&mut *tx)
        .await
        .unwrap();
    let projects: Vec<String> = sqlx::query_scalar("select project_id from projects")
        .fetch_all(&mut *tx)
        .await
        .unwrap();
    assert_eq!(projects, [p1.project.as_str()]);
    for table in ["companies", "tasks", "access_requests", "stakeholders"] {
        let n: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    // Read-only: naming a project does not let a transaction change it.
    let changed = sqlx::query("update projects set name = 'x'")
        .execute(&mut *tx)
        .await
        .unwrap()
        .rows_affected();
    assert_eq!(changed, 0);
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_task_records_since_when_it_waits_on_the_customer() {
    use oryxa_fde_core::TaskId;
    let store = store().await;
    let by = actor("alice");
    let (t, p) = project_world(&store).await;
    let sam = add_stakeholder(&store, &p.company).await;
    let id = TaskId::new(new_id("tsk")).unwrap();
    let mut v = task_in("Get sample data", TaskStatus::Todo);
    v.due_on = Some(time::macros::date!(2026 - 11 - 20));
    v.assignee = Some(UserId::new("bob").unwrap());
    let mut tx = store.project(&p).await.unwrap();
    let task = tx.add_task(&id, &v, &by).await.unwrap().unwrap();
    assert_eq!((task.due_on, task.waiting_since), (v.due_on, None));

    v.status = TaskStatus::WaitingOnCustomer;
    v.waiting_on = Some(sam.clone());
    let waiting = tx.update_task(&id, &v, &by).await.unwrap().unwrap();
    let since = waiting.waiting_since.expect("stamped when it starts waiting");
    assert_eq!(waiting.waiting_on.as_ref(), Some(&sam));
    // Still waiting: the start stays put.
    v.title = Name::new("Get the sample data").unwrap();
    let still = tx.update_task(&id, &v, &by).await.unwrap().unwrap();
    assert_eq!(still.waiting_since, Some(since));
    // No longer waiting: cleared.
    v.status = TaskStatus::InProgress;
    let moving = tx.update_task(&id, &v, &by).await.unwrap().unwrap();
    assert_eq!(moving.waiting_since, None);
    tx.commit().await.unwrap();

    // The stakeholder it waits on must be this company's.
    let other = scope(&t, &new_id("cmp"));
    create_company(&store, &other).await;
    let theirs = add_stakeholder(&store, &other).await;
    v.waiting_on = Some(theirs);
    let mut tx = store.project(&p).await.unwrap();
    assert!(matches!(
        tx.update_task(&id, &v, &by).await,
        Err(StoreError::Missing("waiting_on"))
    ));
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn company_summaries_carry_the_callers_role_and_projects() {
    let store = store().await;
    let t = tenant();
    let (a, b) = (scope(&t, &new_id("cmp")), scope(&t, &new_id("cmp")));
    for s in [&a, &b] {
        create_company(&store, s).await;
    }
    add_project(&store, &a, "RAG").await;
    let mut tx = store.company(&b).await.unwrap();
    tx.set_member(&UserId::new("bob").unwrap(), Role::Engineer, &actor("alice"))
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let summaries = store
        .company_summaries(&[a.clone(), b.clone()], &UserId::new("bob").unwrap())
        .await
        .unwrap();
    let got: Vec<(Option<Role>, usize)> = summaries
        .iter()
        .map(|s| {
            let role = s.role;
            (role, s.projects.len())
        })
        .collect();
    // Both are "Acme"; ordered by name, then id.
    let by_id: std::collections::BTreeMap<&str, (Option<Role>, usize)> =
        summaries.iter().map(|s| s.company.id.as_str()).zip(got).collect();
    assert_eq!(by_id[a.company.as_str()], (None, 1));
    assert_eq!(by_id[b.company.as_str()], (Some(Role::Engineer), 0));
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn row_level_security_covers_documents_and_chunks() {
    let store = store().await;
    let by = actor("alice");
    let t = tenant();
    let (a, b) = (scope(&t, &new_id("cmp")), scope(&t, &new_id("cmp")));
    let other_tenant = scope(&tenant(), &new_id("cmp"));
    for s in [&a, &b, &other_tenant] {
        create_company(&store, s).await;
        let id = oryxa_fde_core::DocumentId::new(new_id("doc")).unwrap();
        let v = DocumentIn {
            name: Name::new("runbook.md").unwrap(),
            content_type: ContentType::Markdown,
            size_bytes: 5,
            sha256: "00".repeat(32),
            blob_key: format!("{}/{}/documents/{id}", s.tenant, s.company),
        };
        let chunk = ChunkIn {
            index: 0,
            content: Text::new("Refunds over 500 need approval").unwrap(),
            embedding: vec![0.5; 1024],
        };
        let mut tx = store.company(s).await.unwrap();
        tx.add_document(&id, &v, &by).await.unwrap().unwrap();
        assert!(
            tx.add_chunks(&id, "fake", &[], std::slice::from_ref(&chunk))
                .await
                .unwrap()
        );
        assert!(tx.finish_chunks(&id, "fake", &[], 1).await.unwrap());
        tx.commit().await.unwrap();
        // Ingested under this model: more chunks for it are refused, and nothing is written.
        let mut tx = store.company(s).await.unwrap();
        assert!(!tx.add_chunks(&id, "fake", &[], &[chunk]).await.unwrap());
    }

    // No WHERE clause: A's transaction sees A's document and chunk only.
    let mut tx = store.company(&a).await.unwrap();
    for table in ["documents", "document_chunks"] {
        let companies: Vec<String> = sqlx::query_scalar(&format!("select company_id from {table}"))
            .fetch_all(tx.conn())
            .await
            .unwrap();
        assert_eq!(companies, [a.company.as_str()], "{table}");
    }
    // Writing a document for another company is refused by the policy.
    let mut sp = tx.conn().begin().await.unwrap();
    let r = sqlx::query(
        "insert into documents (tenant_id, company_id, document_id, name, content_type, size_bytes, sha256, blob_key,
             uploaded_by) values ($1, $2, 'doc_x', 'x', 'text/plain', 1, 'x', 'x', 'u')",
    )
    .bind(b.tenant.as_str())
    .bind(b.company.as_str())
    .execute(&mut *sp)
    .await;
    assert!(r.is_err());
    drop(sp);
    // The app may delete chunks (ingestion replaces sets), but only its own company's.
    let deleted = sqlx::query("delete from document_chunks where company_id <> $1")
        .bind(a.company.as_str())
        .execute(tx.conn())
        .await
        .unwrap()
        .rows_affected();
    assert_eq!(deleted, 0);
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_patch_reads_its_row_locked_so_concurrent_changes_are_not_lost() {
    let store = store().await;
    let c = scope(&tenant(), &new_id("cmp"));
    create_company(&store, &c).await;
    let mut first = store.company(&c).await.unwrap();
    first.get_for_update().await.unwrap().unwrap();
    // A second read-modify-write waits for the first to finish.
    let second = {
        let (store, c) = (store.clone(), c.clone());
        tokio::spawn(async move {
            let mut tx = store.company(&c).await.unwrap();
            let current = tx.get_for_update().await.unwrap().unwrap();
            tx.commit().await.unwrap();
            current.name
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!second.is_finished(), "the second PATCH waits for the first");
    let mut v = CompanyIn::from(first.get().await.unwrap().unwrap());
    v.name = Name::new("Renamed").unwrap();
    first.update(&v, &actor("alice")).await.unwrap();
    first.commit().await.unwrap();
    // It then reads the first PATCH's result, not the row as it was before.
    assert_eq!(second.await.unwrap().as_str(), "Renamed");
}

/// Hands out the given tokens in order, then the last one again.
struct Tokens(std::sync::Mutex<Vec<String>>);

impl iam::TokenSource for Tokens {
    fn token(&self) -> iam::BoxFuture<'_, Result<String, StoreError>> {
        Box::pin(async move {
            let mut left = self.0.lock().unwrap();
            match left.len() {
                0 => Err(StoreError::Config("no token".into())),
                1 => Ok(left[0].clone()),
                _ => Ok(left.remove(0)),
            }
        })
    }
}

/// The test server's host, port and database, for IAM-style options.
fn server() -> (String, u16, String) {
    let o = testing::database_url().parse::<PgConnectOptions>().unwrap();
    (
        o.get_host().to_owned(),
        o.get_port(),
        o.get_database().unwrap_or("oryxa_fde").to_owned(),
    )
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn iam_tokens_connect_and_are_refreshed_before_they_expire() {
    let owner = admin().await;
    let login = new_id("fde_iam");
    let (first, second) = (new_id("tok"), new_id("tok"));
    for sql in [
        format!("create role {login} login password '{first}'"),
        format!("grant oryxa_fde_runtime to {login}"),
    ] {
        sqlx::query(&sql).execute(&owner).await.unwrap();
    }
    let (host, port, database) = server();
    let cfg = iam::IamConfig {
        host,
        port,
        database,
        user: login.clone(),
        tls: iam::Tls::Off,
    };

    // No token at startup: refused, never a fallback.
    let none: Arc<dyn iam::TokenSource> = Arc::new(Tokens(std::sync::Mutex::new(Vec::new())));
    assert!(
        Store::connect_iam(cfg.clone(), none, Duration::from_secs(60))
            .await
            .is_err()
    );

    let tokens: Arc<dyn iam::TokenSource> =
        Arc::new(Tokens(std::sync::Mutex::new(vec![first.clone(), second.clone()])));
    let store = Store::connect_iam(cfg.clone(), tokens, Duration::from_millis(200))
        .await
        .unwrap();
    create_company(&store, &scope(&tenant(), &new_id("cmp"))).await;

    // The token rotates (as RDS tokens expire); after a refresh, new connections use the new one.
    sqlx::query(&format!("alter role {login} password '{second}'"))
        .execute(&owner)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    let held = store.pool.acquire().await.unwrap();
    let opened: Vec<_> = futures_join(&store, 2).await;
    assert!(
        opened.iter().all(Result::is_ok),
        "new connections use the refreshed token"
    );
    drop(held);
    // The old token no longer opens anything: the refresh is what kept the pool working.
    let stale = <sqlx::PgConnection as sqlx::Connection>::connect_with(&cfg.options(&first).unwrap()).await;
    assert!(stale.is_err());
}

/// Opens `n` more connections at once, so the pool must dial new ones.
async fn futures_join(store: &Store, n: usize) -> Vec<Result<sqlx::pool::PoolConnection<sqlx::Postgres>, sqlx::Error>> {
    let mut held = Vec::new();
    for _ in 0..n {
        held.push(store.pool.acquire().await);
    }
    held
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_login_that_reaches_any_owner_power_is_refused() {
    let owner = admin().await;
    for (power, grant) in [
        ("createdb", "nologin createdb"),
        ("bypassrls", "nologin bypassrls"),
        ("admin option", "nologin"),
    ] {
        let (login, role, password) = (new_id("fde_rt"), new_id("fde_reach"), new_id("pw"));
        let mut setup = vec![
            format!("create role {role} {grant}"),
            format!("create role {login} login password '{password}'"),
            format!("grant oryxa_fde_runtime to {login}"),
            format!("grant {role} to {login}"),
        ];
        if power == "admin option" {
            // Reachable, and able to hand a role on: refused like ownership.
            setup.push(format!("grant oryxa_fde_app to {role} with admin option"));
        }
        for sql in setup {
            sqlx::query(&sql).execute(&owner).await.unwrap();
        }
        let options = testing::database_url()
            .parse::<PgConnectOptions>()
            .unwrap()
            .username(&login)
            .password(&password);
        match Store::connect_with(options).await {
            Err(StoreError::Privileged(why)) => assert!(why.contains(power), "{power}: {why}"),
            other => panic!("{power} must be refused: {:?}", other.err()),
        }
    }
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_grant_that_keeps_failing_backs_off_and_the_rest_go_through() {
    let store = store().await;
    let owner = admin().await;
    let t = tenant();
    let c = scope(&t, &new_id("cmp"));
    create_company(&store, &c).await;
    let mine = |grants: &[Grant]| -> Vec<Grant> { grants.iter().filter(|g| g.tenant() == &t).cloned().collect() };
    let workspace = Grant::CompanyWorkspace(c.clone());

    let mut pending = store.pending_grants(&t, 10_000).await.unwrap();
    assert!(mine(pending.grants()).contains(&workspace));
    pending.mark_failed(&workspace).await.unwrap();
    pending.commit().await.unwrap();
    // Backing off: not taken again yet; the member's grant still is.
    let pending = store.pending_grants(&t, 10_000).await.unwrap();
    assert_eq!(
        mine(pending.grants()),
        [Grant::Member(c.clone(), UserId::new("alice").unwrap(), Role::Lead)]
    );
    drop(pending);
    let (attempts, wait): (i32, f64) = sqlx::query_as(
        "select grant_attempts, extract(epoch from grant_retry_at - now())::float8 from companies
         where tenant_id = $1 and company_id = $2",
    )
    .bind(t.as_str())
    .bind(c.company.as_str())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(attempts, 1);
    assert!((0.0..=2.5).contains(&wait), "first wait about 2 s, got {wait}");
    // Its wait over, it is taken again, and a second failure waits longer.
    sqlx::query("update companies set grant_retry_at = now() - interval '1 second' where tenant_id = $1")
        .bind(t.as_str())
        .execute(&owner)
        .await
        .unwrap();
    let mut pending = store.pending_grants(&t, 10_000).await.unwrap();
    assert!(mine(pending.grants()).contains(&workspace));
    pending.mark_failed(&workspace).await.unwrap();
    pending.commit().await.unwrap();
    let wait: f64 = sqlx::query_scalar(
        "select extract(epoch from grant_retry_at - now())::float8 from companies where tenant_id = $1",
    )
    .bind(t.as_str())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert!((2.5..=4.5).contains(&wait), "second wait about 4 s, got {wait}");
}

/// Runs a psql script the way `psql -f` would for what the bootstrap uses: statements end with
/// `;` outside `$$` blocks, and `\gexec` runs each value the query returns.
async fn run_psql(conn: &mut sqlx::PgConnection, script: &str) {
    let mut buf = String::new();
    for line in script.lines() {
        if buf.is_empty() && (line.trim().is_empty() || line.trim_start().starts_with("--")) {
            continue;
        }
        let gexec = line.trim_end().ends_with("\\gexec");
        buf.push_str(line.trim_end().trim_end_matches("\\gexec"));
        buf.push('\n');
        let in_block = buf.matches("$$").count() % 2 == 1;
        if gexec {
            let rows: Vec<String> = sqlx::query_scalar(&buf).fetch_all(&mut *conn).await.unwrap();
            for sql in rows {
                sqlx::raw_sql(&sql).execute(&mut *conn).await.unwrap();
            }
            buf.clear();
        } else if !in_block && line.trim_end().ends_with(';') {
            sqlx::raw_sql(&buf)
                .execute(&mut *conn)
                .await
                .unwrap_or_else(|e| panic!("{buf}: {e}"));
            buf.clear();
        }
    }
    assert!(buf.trim().is_empty(), "unterminated: {buf}");
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn the_bootstrap_makes_every_role_and_the_migrator_needs_no_other() {
    const BOOTSTRAP: &str = include_str!("../../../infra/sql/01-bootstrap.sql");
    let _turn = BOOTSTRAP_TESTS.lock().await;
    // Roles are cluster-wide and other tests make the real ones, so every role of the bootstrap
    // and the migrations takes a name of this run's own: the bootstrap meets none of them made.
    let prefix = new_id("b").replace('_', "").to_lowercase();
    let fresh = |sql: &str| sql.replace("oryxa_fde_", &format!("{prefix}_"));
    let role = |name: &str| format!("{prefix}_{name}");
    let base = testing::database_url().parse::<PgConnectOptions>().unwrap();
    // A superuser that has run nothing: no migrations before the bootstrap.
    let mut superuser = <sqlx::PgConnection as sqlx::Connection>::connect_with(&base)
        .await
        .unwrap();
    let ours = format!("{prefix}\\_%");
    assert!(roles_like(&mut superuser, &ours).await.is_empty());
    // A database of its own: the bootstrap closes the database it runs in to everyone else.
    let db = new_id("fde_boot");
    sqlx::query(&format!("create database {db}"))
        .execute(&mut superuser)
        .await
        .unwrap();
    // RDS gives every database the rds_iam role; plain Postgres needs it made.
    sqlx::query("do $$ begin if not exists (select from pg_roles where rolname = 'rds_iam') then create role rds_iam nologin; end if; end $$")
        .execute(&mut superuser)
        .await
        .unwrap();
    let mut master = <sqlx::PgConnection as sqlx::Connection>::connect_with(&base.clone().database(&db))
        .await
        .unwrap();
    run_psql(
        &mut master,
        &fresh(&BOOTSTRAP.replace("on database oryxa_fde", &format!("on database {db}"))),
    )
    .await;
    let made = roles_like(&mut master, &ours).await;
    assert_eq!(
        made,
        ["api", "app", "grants", "migrator", "relay", "runtime"].map(role),
        "the bootstrap makes every role"
    );

    // IAM in production; passwords here, set for this run.
    let (migrator_pw, api_pw) = (new_id("pw"), new_id("pw"));
    for sql in [
        format!("alter role {} password '{migrator_pw}'", role("migrator")),
        format!("alter role {} password '{api_pw}'", role("api")),
    ] {
        sqlx::query(&sql).execute(&mut master).await.unwrap();
    }
    let createrole: bool =
        sqlx::query_scalar("select bool_or(rolcreaterole or rolsuper) from pg_roles where rolname = any ($1)")
            .bind([role("migrator"), role("api")])
            .fetch_one(&mut master)
            .await
            .unwrap();
    assert!(!createrole, "neither login may create roles");

    // The migrations, under the same names, as the migrator: with no CREATEROLE, they run only if
    // every role they need is already there, and they make none.
    let dir = std::env::temp_dir().join(new_id("fde_migrations"));
    std::fs::create_dir(&dir).unwrap();
    for entry in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations")).unwrap() {
        let path = entry.unwrap().path();
        let sql = std::fs::read_to_string(&path).unwrap();
        std::fs::write(dir.join(path.file_name().unwrap()), fresh(&sql)).unwrap();
    }
    let migrations = sqlx::migrate::Migrator::new(dir.as_path()).await.unwrap();
    let as_migrator = base
        .clone()
        .database(&db)
        .username(&role("migrator"))
        .password(&migrator_pw);
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(as_migrator)
        .await
        .unwrap();
    migrations.run(&pool).await.unwrap();
    pool.close().await;
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(
        roles_like(&mut master, &ours).await,
        made,
        "the migrations made no role"
    );

    // The runtime login passes the store's owner check, and reaches tables only through the app role.
    let as_api = base.clone().database(&db).username(&role("api")).password(&api_pw);
    Store::connect_with(as_api.clone()).await.unwrap().pool.close().await;
    let mut api = <sqlx::PgConnection as sqlx::Connection>::connect_with(&as_api)
        .await
        .unwrap();
    for refused in [
        format!("set role {}", role("migrator")),
        "select 1 from companies".to_owned(),
    ] {
        assert!(sqlx::query(&refused).execute(&mut api).await.is_err(), "{refused}");
    }
    let mut tx = sqlx::Connection::begin(&mut api).await.unwrap();
    sqlx::query(&format!("set local role {}", role("app")))
        .execute(&mut *tx)
        .await
        .unwrap();
    let visible: i64 = sqlx::query_scalar("select count(*) from companies")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(visible, 0, "no scope set: row-level security shows nothing");
    tx.rollback().await.unwrap();
    drop(api);

    // A role the login reaches that owns the function behind every row-level policy: refused.
    sqlx::query(&format!("alter function fde_in_scope owner to {}", role("app")))
        .execute(&mut master)
        .await
        .unwrap();
    match Store::connect_with(as_api).await {
        Err(StoreError::Privileged(why)) => assert!(why.contains("owns a function"), "{why}"),
        other => panic!("a reachable function owner must be refused: {:?}", other.err()),
    }

    drop(master);
    sqlx::query(&format!("drop database {db} with (force)"))
        .execute(&mut superuser)
        .await
        .unwrap();
    for name in made.iter().rev() {
        sqlx::query(&format!("drop owned by {name}"))
            .execute(&mut superuser)
            .await
            .unwrap();
        sqlx::query(&format!("drop role {name}"))
            .execute(&mut superuser)
            .await
            .unwrap();
    }
}

/// The names of the roles matching `pattern` (a `like` pattern), in order.
async fn roles_like(conn: &mut sqlx::PgConnection, pattern: &str) -> Vec<String> {
    sqlx::query_scalar("select rolname::text from pg_roles where rolname like $1 order by rolname")
        .bind(pattern)
        .fetch_all(conn)
        .await
        .unwrap()
}

/// The bootstrap's roles are cluster-wide, so its tests take turns.
static BOOTSTRAP_TESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn tasks_and_decisions_page_in_order_from_a_cursor_in_the_project() {
    use oryxa_fde_core::{DecisionId, TaskId};
    let store = store().await;
    let by = actor("alice");
    let c = scope(&tenant(), &new_id("cmp"));
    create_company(&store, &c).await;
    let (p, other) = (
        add_project(&store, &c, "Paged").await,
        add_project(&store, &c, "Other").await,
    );
    // One transaction: every task has the same created_at, so the id breaks the tie.
    let mut tx = store.project(&p).await.unwrap();
    let mut tasks: Vec<String> = Vec::new();
    for i in 0..5 {
        let id = TaskId::new(new_id("tsk")).unwrap();
        tx.add_task(&id, &task_in(&format!("Task {i}"), TaskStatus::Todo), &by)
            .await
            .unwrap()
            .unwrap();
        tasks.push(id.to_string());
    }
    tasks.sort();
    // Two decisions share a time, so paging crosses a tie in the descending order too.
    let base = time::OffsetDateTime::now_utc().replace_nanosecond(0).unwrap();
    let mut decisions: Vec<(time::OffsetDateTime, String)> = Vec::new();
    for days in [3, 1, 1, 0, 2] {
        let id = DecisionId::new(new_id("dec")).unwrap();
        let at = base - time::Duration::days(days);
        let v = DecisionIn {
            title: Name::new("Decided").unwrap(),
            rationale: Text::new("Because").unwrap(),
            decided_by: Name::new("Customer").unwrap(),
            decided_at: at,
        };
        tx.record_decision(&id, &v, &by).await.unwrap().unwrap();
        decisions.push((at, id.to_string()));
    }
    decisions.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let decisions: Vec<String> = decisions.into_iter().map(|(_, id)| id).collect();
    tx.commit().await.unwrap();

    let mut tx = store.project(&p).await.unwrap();
    let (mut seen, mut after, mut pages) = (Vec::new(), None::<TaskId>, 0);
    loop {
        let page = tx.tasks_page(after.as_ref(), 2).await.unwrap();
        assert!(page.items.len() <= 2);
        seen.extend(page.items.iter().map(|t| t.id.to_string()));
        pages += 1;
        if !page.more {
            break;
        }
        after = page.items.last().map(|t| t.id.clone());
    }
    assert_eq!((seen, pages), (tasks.clone(), 3));
    let (mut seen, mut after) = (Vec::new(), None::<DecisionId>);
    loop {
        let page = tx.decisions_page(after.as_ref(), 2).await.unwrap();
        seen.extend(page.items.iter().map(|d| d.id.to_string()));
        if !page.more {
            break;
        }
        after = page.items.last().map(|d| d.id.clone());
    }
    assert_eq!(seen, decisions);
    // A full last page says nothing follows.
    let all = tx.tasks_page(None, 5).await.unwrap();
    assert_eq!((all.items.len(), all.more), (5, false));
    // A cursor that is not this project's is refused, never read as "from the start".
    let unknown = TaskId::new(new_id("tsk")).unwrap();
    assert!(matches!(
        tx.tasks_page(Some(&unknown), 2).await,
        Err(StoreError::Missing("after"))
    ));
    tx.commit().await.unwrap();
    let mut tx = store.project(&other).await.unwrap();
    let theirs = TaskId::new(&tasks[0]).unwrap();
    assert!(matches!(
        tx.tasks_page(Some(&theirs), 2).await,
        Err(StoreError::Missing("after"))
    ));
    let theirs = DecisionId::new(&decisions[0]).unwrap();
    assert!(matches!(
        tx.decisions_page(Some(&theirs), 2).await,
        Err(StoreError::Missing("after"))
    ));
}

/// A unit vector along `axis`, the size of the embedding column.
fn axis(axis: usize) -> Vec<f32> {
    let mut v = vec![0.0; 1024];
    v[axis] = 1.0;
    v
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_small_company_finds_all_its_chunks_among_many_tenants() {
    let store = store().await;
    let admin = admin().await;
    // Forty other tenants, fifty chunks each, spread over sixteen dimensions: the shared index is
    // full of them, and a scan that stops early never reaches the small company's chunks.
    let run = new_id("bulk");
    sqlx::query(
        "insert into companies (tenant_id, company_id, name, created_by)
         select $1 || '_' || g, 'cmp_bulk', 'Bulk', 'alice' from generate_series(1, 40) g",
    )
    .bind(&run)
    .execute(&admin)
    .await
    .unwrap();
    sqlx::query(
        "insert into documents (tenant_id, company_id, document_id, name, content_type, size_bytes, sha256, blob_key,
             uploaded_by, status, chunks, embedding_model, ingested_at)
         select tenant_id, company_id, 'doc_bulk', 'bulk.md', 'text/markdown', 1, 'x', 'x', 'alice', 'ingested', 50,
             'fake', now()
         from companies where tenant_id like $1 || '\\_%'",
    )
    .bind(&run)
    .execute(&admin)
    .await
    .unwrap();
    sqlx::query(
        "insert into document_chunks (tenant_id, company_id, document_id, chunk_index, content, embedding,
             embedding_model)
         select d.tenant_id, d.company_id, d.document_id, i, 'bulk',
             ('[' || array_to_string(array(select random() + 0 * i from generate_series(1, 16)), ',')
                 || repeat(',0', 1008) || ']')::vector, 'fake'
         from documents d, generate_series(0, 49) i where d.tenant_id like $1 || '\\_%'",
    )
    .bind(&run)
    .execute(&admin)
    .await
    .unwrap();

    // The small company: three chunks in the same region, but nearly at right angles to the query
    // (axis 0), so they rank behind almost every chunk of the other tenants.
    let by = actor("alice");
    let small = scope(&tenant(), &new_id("cmp"));
    create_company(&store, &small).await;
    let id = oryxa_fde_core::DocumentId::new(new_id("doc")).unwrap();
    let v = DocumentIn {
        name: Name::new("runbook.md").unwrap(),
        content_type: ContentType::Markdown,
        size_bytes: 5,
        sha256: "00".repeat(32),
        blob_key: format!("{}/{}/documents/{id}", small.tenant, small.company),
    };
    let chunks: Vec<ChunkIn> = (0..3)
        .map(|i| ChunkIn {
            index: i,
            content: Text::new(format!("Passage {i}")).unwrap(),
            embedding: {
                let mut v = axis(0);
                v[0] = 0.05;
                v[1..16].fill(1.0);
                v[5 + i as usize] = 3.0;
                v
            },
        })
        .collect();
    let mut tx = store.company(&small).await.unwrap();
    tx.add_document(&id, &v, &by).await.unwrap().unwrap();
    assert!(tx.add_chunks(&id, "fake", &[], &chunks).await.unwrap());
    assert!(tx.finish_chunks(&id, "fake", &[], chunks.len()).await.unwrap());
    tx.commit().await.unwrap();

    let mut tx = store.company(&small).await.unwrap();
    // As at scale: the planner walks the shared index in distance order (no sort of the company's
    // rows), and the index has grown far past what one scan visits.
    for setting in [
        "set local enable_sort = off",
        "set local enable_bitmapscan = off",
        "set local enable_seqscan = off",
        "set local hnsw.max_scan_tuples = 1",
        "set local hnsw.ef_search = 1",
    ] {
        sqlx::query(setting).execute(tx.conn()).await.unwrap();
    }
    let hits = tx.search_vector(&axis(0), "fake", 40).await.unwrap();
    let mut got: Vec<u32> = hits.iter().map(|h| h.chunk).collect();
    got.sort();
    assert_eq!(
        got,
        [0, 1, 2],
        "every chunk of the small company, however full the shared index"
    );
    // A company over the exact bound walks the shared index, with a scan budget raised past the
    // one set above: here it still reaches every chunk.
    let hits = crate::documents::search_vector_with(tx.conn(), &small, &axis(0), "fake", 40, 0)
        .await
        .unwrap();
    let mut got: Vec<u32> = hits.iter().map(|h| h.chunk).collect();
    got.sort();
    assert_eq!(got, [0, 1, 2]);
    // Best first, on both paths: the query along axis 6 ranks chunk 1 first.
    let hits = tx.search_vector(&axis(6), "fake", 40).await.unwrap();
    assert_eq!(hits[0].chunk, 1);
    let hits = crate::documents::search_vector_with(tx.conn(), &small, &axis(6), "fake", 40, 0)
        .await
        .unwrap();
    assert_eq!(hits[0].chunk, 1);
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn search_reads_only_a_documents_complete_set_while_it_is_re_embedded() {
    let store = store().await;
    let admin = admin().await;
    let by = actor("alice");
    let s = scope(&tenant(), &new_id("cmp"));
    create_company(&store, &s).await;
    let id = oryxa_fde_core::DocumentId::new(new_id("doc")).unwrap();
    let v = DocumentIn {
        name: Name::new("runbook.md").unwrap(),
        content_type: ContentType::Markdown,
        size_bytes: 5,
        sha256: "00".repeat(32),
        blob_key: format!("{}/{}/documents/{id}", s.tenant, s.company),
    };
    let chunk = |i: u32| ChunkIn {
        index: i,
        content: Text::new(format!("Refunds over 500 need approval, part {i}")).unwrap(),
        embedding: axis(i as usize),
    };
    let mut tx = store.company(&s).await.unwrap();
    tx.add_document(&id, &v, &by).await.unwrap().unwrap();
    // A pending document's first batch is stored, but search sees none of it yet.
    assert!(tx.add_chunks(&id, "m1", &[], &[chunk(0)]).await.unwrap());
    assert!(tx.search_text("refunds", 10).await.unwrap().is_empty());
    assert!(tx.search_vector(&axis(0), "m1", 10).await.unwrap().is_empty());
    assert!(matches!(
        tx.finish_chunks(&id, "m1", &[], 2).await,
        Err(StoreError::Rejected("chunks_missing"))
    ));
    // The same chunk again is kept as it is; with the last one, the set is complete.
    assert!(tx.add_chunks(&id, "m1", &[], &[chunk(0), chunk(1)]).await.unwrap());
    assert!(tx.finish_chunks(&id, "m1", &[], 2).await.unwrap());
    let doc = tx.document(&id).await.unwrap().unwrap();
    assert_eq!(
        (doc.status, doc.chunks, doc.embedding_model.as_deref()),
        (DocumentStatus::Ingested, 2, Some("m1"))
    );
    assert_eq!(tx.search_vector(&axis(0), "m1", 10).await.unwrap().len(), 2);
    // A complete set is never dropped, whoever asks.
    assert!(!tx.drop_chunks(&id, "m1", &[]).await.unwrap());
    assert_eq!(tx.search_vector(&axis(0), "m1", 10).await.unwrap().len(), 2);
    tx.commit().await.unwrap();

    // Re-embedded under m2, which replaces m1: until its set is complete, search reads m1's, once.
    let from_m1 = ["m1".to_owned()];
    let mut tx = store.company(&s).await.unwrap();
    assert!(tx.document(&id).await.unwrap().unwrap().needs("m2", &from_m1));
    // A model that does not replace m1 leaves the document alone.
    assert!(!tx.add_chunks(&id, "m2", &[], &[chunk(0)]).await.unwrap());
    assert!(tx.add_chunks(&id, "m2", &from_m1, &[chunk(0)]).await.unwrap());
    assert_eq!(
        tx.search_text("refunds", 10).await.unwrap().len(),
        2,
        "no duplicates from m2"
    );
    assert!(tx.search_vector(&axis(0), "m2", 10).await.unwrap().is_empty());
    assert_eq!(tx.stored_chunks(&id, "m2").await.unwrap().len(), 1);
    assert!(tx.add_chunks(&id, "m2", &from_m1, &[chunk(1)]).await.unwrap());
    assert!(tx.finish_chunks(&id, "m2", &from_m1, 2).await.unwrap());
    assert_eq!(tx.search_vector(&axis(0), "m2", 10).await.unwrap().len(), 2);
    assert!(tx.search_vector(&axis(0), "m1", 10).await.unwrap().is_empty());
    // Done under m2: nothing more is taken for it.
    assert!(!tx.add_chunks(&id, "m2", &from_m1, &[chunk(2)]).await.unwrap());
    assert!(!tx.finish_chunks(&id, "m2", &from_m1, 2).await.unwrap());
    // Mid-deploy, a worker still on m1 never swaps the document back.
    assert!(!tx.add_chunks(&id, "m1", &[], &[chunk(0)]).await.unwrap());
    assert!(!tx.finish_chunks(&id, "m1", &[], 2).await.unwrap());
    tx.commit().await.unwrap();
    let models: Vec<(String, i64)> = sqlx::query_as(
        "select embedding_model, count(*) from document_chunks where document_id = $1 group by embedding_model",
    )
    .bind(id.as_str())
    .fetch_all(&admin)
    .await
    .unwrap();
    assert_eq!(models, [("m2".to_owned(), 2)], "m1's set is gone");

    // A pending document that fails drops what an interrupted run stored, and takes no more.
    let failed = oryxa_fde_core::DocumentId::new(new_id("doc")).unwrap();
    let mut tx = store.company(&s).await.unwrap();
    tx.add_document(&failed, &v, &by).await.unwrap().unwrap();
    assert!(tx.add_chunks(&failed, "m2", &[], &[chunk(0)]).await.unwrap());
    tx.record_failure(&failed, "checksum").await.unwrap();
    assert!(tx.stored_chunks(&failed, "m2").await.unwrap().is_empty());
    assert!(!tx.add_chunks(&failed, "m2", &[], &[chunk(0)]).await.unwrap());
    tx.commit().await.unwrap();
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_document_an_older_worker_ingested_stays_findable() {
    let store = store().await;
    let admin = admin().await;
    let by = actor("alice");
    let s = scope(&tenant(), &new_id("cmp"));
    create_company(&store, &s).await;
    let id = oryxa_fde_core::DocumentId::new(new_id("doc")).unwrap();
    let v = DocumentIn {
        name: Name::new("runbook.md").unwrap(),
        content_type: ContentType::Markdown,
        size_bytes: 5,
        sha256: "00".repeat(32),
        blob_key: format!("{}/{}/documents/{id}", s.tenant, s.company),
    };
    let mut tx = store.company(&s).await.unwrap();
    tx.add_document(&id, &v, &by).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    // As an ingest worker from before re-embedding left it: ingested, one set, no model named.
    sqlx::query(&format!(
        "insert into document_chunks (tenant_id, company_id, document_id, chunk_index, content, embedding,
             embedding_model)
         values ($1, $2, $3, 0, 'Refunds over 500 need approval', '[1{}]'::vector, 'm1')",
        ",0".repeat(1023)
    ))
    .bind(s.tenant.as_str())
    .bind(s.company.as_str())
    .bind(id.as_str())
    .execute(&admin)
    .await
    .unwrap();
    sqlx::query("update documents set status = 'ingested', chunks = 1 where tenant_id = $1 and document_id = $2")
        .bind(s.tenant.as_str())
        .bind(id.as_str())
        .execute(&admin)
        .await
        .unwrap();
    let mut tx = store.company(&s).await.unwrap();
    assert_eq!(tx.search_text("refunds", 10).await.unwrap().len(), 1);
    assert_eq!(tx.search_vector(&axis(0), "m1", 10).await.unwrap().len(), 1);
    // A pending document's partial set stays unsearched.
    let pending = oryxa_fde_core::DocumentId::new(new_id("doc")).unwrap();
    tx.add_document(&pending, &v, &by).await.unwrap().unwrap();
    let chunk = ChunkIn {
        index: 0,
        content: Text::new("Refunds pending").unwrap(),
        embedding: axis(0),
    };
    assert!(tx.add_chunks(&pending, "m1", &[], &[chunk]).await.unwrap());
    assert_eq!(tx.search_text("refunds", 10).await.unwrap().len(), 1);
    // And an interrupted set is dropped, under the document's lock.
    assert!(tx.drop_chunks(&pending, "m1", &[]).await.unwrap());
    assert!(tx.stored_chunks(&pending, "m1").await.unwrap().is_empty());
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_document_chunked_anew_keeps_its_searchable_set_until_the_new_one_is_complete() {
    let store = store().await;
    let admin = admin().await;
    let by = actor("alice");
    let s = scope(&tenant(), &new_id("cmp"));
    create_company(&store, &s).await;
    let id = oryxa_fde_core::DocumentId::new(new_id("doc")).unwrap();
    let v = DocumentIn {
        name: Name::new("runbook.md").unwrap(),
        content_type: ContentType::Markdown,
        size_bytes: 5,
        sha256: "00".repeat(32),
        blob_key: format!("{}/{}/documents/{id}", s.tenant, s.company),
    };
    let mut tx = store.company(&s).await.unwrap();
    tx.add_document(&id, &v, &by).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    // An older worker's set: two chunks under m1, no model named on the document.
    for (i, text) in ["Refunds over 500", "need approval"].iter().enumerate() {
        sqlx::query(&format!(
            "insert into document_chunks (tenant_id, company_id, document_id, chunk_index, content, embedding,
                 embedding_model)
             values ($1, $2, $3, $4, $5, '[1{}]'::vector, 'm1')",
            ",0".repeat(1023)
        ))
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(id.as_str())
        .bind(i as i32)
        .bind(*text)
        .execute(&admin)
        .await
        .unwrap();
    }
    sqlx::query("update documents set status = 'ingested', chunks = 2 where tenant_id = $1 and document_id = $2")
        .bind(s.tenant.as_str())
        .bind(id.as_str())
        .execute(&admin)
        .await
        .unwrap();
    let found = async |tx: &mut CompanyTx| -> Vec<String> {
        let mut hits: Vec<String> = tx
            .search_vector(&axis(0), "m1", 10)
            .await
            .unwrap()
            .into_iter()
            .map(|h| h.content.as_str().to_owned())
            .collect();
        hits.sort();
        hits
    };
    let old = vec!["Refunds over 500".to_owned(), "need approval".to_owned()];

    // This worker chunks it differently under the same model: nothing of the old set is "stored"
    // for it to resume, and dropping its interrupted set leaves the old set alone.
    let mut tx = store.company(&s).await.unwrap();
    assert!(tx.stored_chunks(&id, "m1").await.unwrap().is_empty());
    let new_chunk = |i: u32, t: &str| ChunkIn {
        index: i,
        content: Text::new(t).unwrap(),
        embedding: axis(0),
    };
    assert!(
        tx.add_chunks(&id, "m1", &[], &[new_chunk(0, "Refunds over 500 need approval")])
            .await
            .unwrap()
    );
    assert_eq!(
        found(&mut tx).await,
        old,
        "the old set alone, while the new one is written"
    );
    assert_eq!(tx.search_text("refunds", 10).await.unwrap().len(), 1);
    assert!(tx.drop_chunks(&id, "m1", &[]).await.unwrap());
    assert_eq!(found(&mut tx).await, old, "dropping the new set keeps the old one");
    // Written again in full, then finished: the new set replaces the old.
    let batch = [
        new_chunk(0, "Refunds over 500 need approval"),
        new_chunk(1, "from the support lead"),
    ];
    assert!(tx.add_chunks(&id, "m1", &[], &batch[..1]).await.unwrap());
    assert!(matches!(
        tx.finish_chunks(&id, "m1", &[], 2).await,
        Err(StoreError::Rejected("chunks_missing"))
    ));
    assert_eq!(found(&mut tx).await, old);
    assert!(tx.add_chunks(&id, "m1", &[], &batch[1..]).await.unwrap());
    assert!(tx.finish_chunks(&id, "m1", &[], 2).await.unwrap());
    assert_eq!(
        found(&mut tx).await,
        ["Refunds over 500 need approval", "from the support lead"]
    );
    let left: i64 = sqlx::query_scalar("select count(*) from document_chunks where document_id = $1")
        .bind(id.as_str())
        .fetch_one(tx.conn())
        .await
        .unwrap();
    assert_eq!(left, 2, "the old set is gone");
    // Named now, it needs nothing more from m1.
    assert!(!tx.drop_chunks(&id, "m1", &[]).await.unwrap());
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn the_lifecycle_tables_are_scoped_and_the_reconcilers_role_reads_project_keys_only() {
    let store = store().await;
    let by = actor("alice");
    let (t, a) = project_world(&store).await;
    let b = {
        let c = scope(&t, &new_id("cmp"));
        create_company(&store, &c).await;
        add_project(&store, &c, "B").await
    };
    let monday = crate::week_of(time::OffsetDateTime::now_utc().date());
    for p in [&a, &b] {
        let criterion = oryxa_fde_core::CriterionId::new(new_id("crt")).unwrap();
        let run = oryxa_fde_core::EvalRunId::new(new_id("evr")).unwrap();
        let mut tx = store.project(p).await.unwrap();
        let v = CriterionIn {
            description: Text::new("Fast").unwrap(),
            metric: Name::new("p95").unwrap(),
            comparator: Comparator::AtMost,
            target: 2.0,
            unit: None,
        };
        tx.add_criterion(&criterion, &v, &by).await.unwrap().unwrap();
        let event = new_id("evt");
        assert!(tx.first_delivery(&event).await.unwrap());
        tx.record_activity(
            &event,
            &ActivityIn::PullRequest { number: 1 },
            time::OffsetDateTime::now_utc(),
        )
        .await
        .unwrap();
        assert!(tx.record_criterion_result(&criterion, &run, 1.5).await.unwrap());
        assert!(tx.raise_suggestion(SuggestionKind::ReadyToDeploy, &run).await.unwrap());
        assert!(tx.claim_update_attempt(monday, 3).await.unwrap());
        let body = UpdateBody::new("Done this week").unwrap();
        assert!(tx.add_update_draft(monday, &body, "echo").await.unwrap());
        tx.commit().await.unwrap();
    }

    // In A's transaction an unfiltered query sees only A's rows.
    let mut tx = store.company(&a.company).await.unwrap();
    for table in [
        "processed_events",
        "project_activity",
        "criterion_results",
        "suggestions",
        "update_drafts",
        "update_draft_attempts",
    ] {
        let companies: Vec<String> = sqlx::query_scalar(&format!("select distinct company_id from {table}"))
            .fetch_all(tx.conn())
            .await
            .unwrap();
        assert_eq!(companies, [a.company.company.as_str()], "{table}");
    }
    // Updates reach only the columns they are for.
    for sql in [
        "update update_drafts set model = 'x'",
        "update update_drafts set week = week + 7",
        "update suggestions set kind = 'x'",
        "update criterion_results set criterion_id = 'x'",
        "update update_draft_attempts set week = week + 7",
        "update project_activity set subject = 'x'",
        "delete from processed_events",
    ] {
        let mut sp = tx.conn().begin().await.unwrap();
        assert!(sqlx::query(sql).execute(&mut *sp).await.is_err(), "{sql}");
    }
    drop(tx);

    // The reconciler's role, which reads every tenant, reads a project's keys and nothing else.
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("set local role oryxa_fde_grants")
        .execute(&mut *tx)
        .await
        .unwrap();
    let keys: i64 =
        sqlx::query_scalar("select count(*) from (select tenant_id, company_id, project_id from projects) k")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert!(keys >= 2);
    for column in ["stage", "name", "summary"] {
        let mut sp = (&mut *tx).begin().await.unwrap();
        let read = sqlx::query(&format!("select {column} from projects limit 1"))
            .execute(&mut *sp)
            .await;
        assert!(read.is_err(), "the grants role reads projects.{column}");
    }
    drop(tx);
    // The weekly list is every project's keys, read that way.
    let listed = store.projects_for_weekly_updates().await.unwrap();
    assert!(listed.contains(&a) && listed.contains(&b));
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_broken_constraint_is_permanent_and_a_dead_connection_is_not() {
    let store = store().await;
    let (_, p) = project_world(&store).await;
    let mut tx = store.project(&p).await.unwrap();
    // A check the store does not map itself: a week that is not a Monday.
    let broken = sqlx::query(
        "insert into update_draft_attempts (tenant_id, company_id, project_id, week, attempts)
         values ($1, $2, $3, date '2026-11-03', 1)",
    )
    .bind(p.company.tenant.as_str())
    .bind(p.company.company.as_str())
    .bind(p.project.as_str())
    .execute(&mut *tx.tx)
    .await
    .map_err(StoreError::from)
    .unwrap_err();
    assert!(broken.is_permanent(), "{broken:?}");
    drop(tx);
    let gone = Store::connect("postgres://nobody:x@127.0.0.1:1/none")
        .await
        .err()
        .unwrap();
    assert!(!gone.is_permanent(), "{gone:?}");
}

fn snapshot_in(bytes: &[u8]) -> SnapshotIn {
    use sha2::Digest;
    SnapshotIn {
        id: SnapshotId::new(new_id("cnv")).unwrap(),
        size_bytes: bytes.len() as u32,
        sha256: sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect(),
        body: SnapshotBody::Inline(bytes.to_vec()),
    }
}

async fn add_item(store: &Store, p: &ProjectScope) -> ScopeItemId {
    let id = ScopeItemId::new(new_id("itm")).unwrap();
    let mut tx = store.project(p).await.unwrap();
    let v = ScopeItemIn {
        kind: ScopeKind::In,
        description: Text::new("Tier-1 tickets").unwrap(),
    };
    tx.add_scope_item(&id, &v, &actor("alice")).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    id
}

fn note_in(stakeholders: Vec<oryxa_fde_core::StakeholderId>) -> MeetingNoteIn {
    MeetingNoteIn {
        title: Name::new("Discovery workshop").unwrap(),
        held_on: time::macros::date!(2026 - 11 - 02),
        body: NoteText::new("Refunds over 500 need the support lead.\nNext: API token.").unwrap(),
        stakeholders,
        attendees: vec![UserId::new("alice").unwrap()],
    }
}

/// One of every planning record at the company and at its project.
async fn planning_records(store: &Store, p: &ProjectScope) {
    let by = actor("alice");
    let stakeholder = add_stakeholder(store, &p.company).await;
    let item = add_item(store, p).await;
    for (mut tx, target, subject) in [
        (
            PlanTx::from(store.company(&p.company).await.unwrap()),
            LinkTarget::Stakeholder(stakeholder.clone()),
            Subject::Stakeholder(stakeholder.clone()),
        ),
        (
            PlanTx::from(store.project(p).await.unwrap()),
            LinkTarget::ScopeItem(item.clone()),
            Subject::ScopeItem(item.clone()),
        ),
    ] {
        tx.save_canvas(0, &snapshot_in(br#"{"elements":[]}"#), &by)
            .await
            .unwrap()
            .unwrap();
        let shape = ShapeId::new("shape-1").unwrap();
        tx.link_shape(&shape, &target, &by).await.unwrap().unwrap();
        let first = (
            &CommentId::new(new_id("cmt")).unwrap(),
            &Text::new("Who owns this?").unwrap(),
        );
        tx.start_thread(&ThreadId::new(new_id("thr")).unwrap(), &subject, first, &by)
            .await
            .unwrap()
            .unwrap();
        tx.add_meeting_note(
            &MeetingNoteId::new(new_id("mtg")).unwrap(),
            &note_in(vec![stakeholder.clone()]),
            &by,
        )
        .await
        .unwrap()
        .unwrap();
        tx.commit().await.unwrap();
    }
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn row_level_security_covers_canvases_threads_and_notes() {
    let store = store().await;
    let (t, a) = project_world(&store).await;
    let b = {
        let c = scope(&t, &new_id("cmp"));
        create_company(&store, &c).await;
        add_project(&store, &c, "B").await
    };
    planning_records(&store, &a).await;
    planning_records(&store, &b).await;

    // In A's transaction an unfiltered query sees only A's rows: the company's and the project's.
    let mut tx = store.company(&a.company).await.unwrap();
    for table in [
        "canvas_versions",
        "canvas_links",
        "threads",
        "thread_comments",
        "meeting_notes",
        "meeting_note_stakeholders",
    ] {
        let companies: Vec<String> = sqlx::query_scalar(&format!("select distinct company_id from {table}"))
            .fetch_all(tx.conn())
            .await
            .unwrap();
        assert_eq!(companies, [a.company.company.as_str()], "{table}");
    }
    // Saved versions and comments never change; a thread changes only by promotion.
    for sql in [
        "update canvas_versions set version = 9",
        "update canvas_versions set content = 'x'",
        "delete from canvas_versions",
        "update thread_comments set body = 'x'",
        "delete from thread_comments",
        "update threads set subject_id = 'x'",
        "delete from threads",
    ] {
        let mut sp = tx.conn().begin().await.unwrap();
        assert!(sqlx::query(sql).execute(&mut *sp).await.is_err(), "{sql}");
    }
    drop(tx);

    // Each place reads its own records only: the company's are not the project's.
    let mut company = PlanTx::from(store.company(&a.company).await.unwrap());
    let mut project = PlanTx::from(store.project(&a).await.unwrap());
    for tx in [&mut company, &mut project] {
        assert_eq!(tx.canvas_versions().await.unwrap().len(), 1);
        assert_eq!(tx.canvas_links().await.unwrap().len(), 1);
        assert_eq!(tx.threads(None).await.unwrap().len(), 1);
        assert_eq!(tx.meeting_notes().await.unwrap().len(), 1);
    }
    let company_link = &company.canvas_links().await.unwrap()[0];
    assert!(matches!(company_link.target, LinkTarget::Stakeholder(_)));
    let project_link = &project.canvas_links().await.unwrap()[0];
    assert!(matches!(project_link.target, LinkTarget::ScopeItem(_)));
    // B's project under A's company is nothing.
    let mut cross = PlanTx::from(store.project(&a.company.project(b.project.clone())).await.unwrap());
    assert!(cross.canvas().await.unwrap().is_none());
    assert!(cross.threads(None).await.unwrap().is_empty());
    assert!(cross.meeting_notes().await.unwrap().is_empty());
    let by = actor("alice");
    assert!(cross.save_canvas(0, &snapshot_in(b"{}"), &by).await.unwrap().is_none());
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_canvas_saves_only_on_top_of_its_latest_version() {
    let store = store().await;
    let (_, p) = project_world(&store).await;
    let by = actor("alice");
    let mut tx = PlanTx::from(store.company(&p.company).await.unwrap());
    assert_eq!(tx.canvas_head().await.unwrap(), 0);
    assert!(tx.canvas().await.unwrap().is_none());
    let one = tx
        .save_canvas(0, &snapshot_in(b"{\"v\":1}"), &by)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(one.version, 1);
    tx.commit().await.unwrap();
    // A stale base, and one from the future, are both refused; neither leaves a gap.
    for base in [0, 5] {
        let mut sp = PlanTx::from(store.company(&p.company).await.unwrap());
        let stale = sp.save_canvas(base, &snapshot_in(b"{}"), &by).await;
        assert!(matches!(stale, Err(StoreError::Conflict)), "{base}: {stale:?}");
    }
    let mut tx = PlanTx::from(store.company(&p.company).await.unwrap());
    let two = tx
        .save_canvas(1, &snapshot_in(b"{\"v\":2}"), &by)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(two.version, 2);
    tx.commit().await.unwrap();

    // Two editors saving on top of the same version: one wins, the other conflicts.
    let mut first = PlanTx::from(store.company(&p.company).await.unwrap());
    let mut second = PlanTx::from(store.company(&p.company).await.unwrap());
    first
        .save_canvas(2, &snapshot_in(b"{\"v\":3}"), &by)
        .await
        .unwrap()
        .unwrap();
    let racing = tokio::spawn(async move {
        let r = second.save_canvas(2, &snapshot_in(b"{\"v\":3b}"), &by).await;
        (r, second)
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    first.commit().await.unwrap();
    let (lost, _) = racing.await.unwrap();
    assert!(matches!(lost, Err(StoreError::Conflict)), "{lost:?}");

    let mut tx = PlanTx::from(store.company(&p.company).await.unwrap());
    let latest = tx.canvas().await.unwrap().unwrap();
    assert_eq!(latest.meta.version, 3);
    assert_eq!(latest.body, SnapshotBody::Inline(b"{\"v\":3}".to_vec()));
    let old = tx.canvas_version(1).await.unwrap().unwrap();
    assert_eq!(old.body, SnapshotBody::Inline(b"{\"v\":1}".to_vec()));
    assert!(tx.canvas_version(4).await.unwrap().is_none());
    let versions: Vec<u32> = tx.canvas_versions().await.unwrap().iter().map(|m| m.version).collect();
    assert_eq!(versions, [3, 2, 1]);
    // The project's canvas is another canvas.
    let mut project = PlanTx::from(store.project(&p).await.unwrap());
    assert_eq!(project.canvas_head().await.unwrap(), 0);
    // A large snapshot is stored by its S3 key.
    let big = SnapshotIn {
        body: SnapshotBody::Blob(format!("{}/{}/canvas/cnv_1", p.company.tenant, p.company.company)),
        ..snapshot_in(b"{}")
    };
    project.save_canvas(0, &big, &actor("alice")).await.unwrap().unwrap();
    assert_eq!(project.canvas().await.unwrap().unwrap().body, big.body);
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_shape_links_only_to_a_record_of_its_place_and_goes_with_the_record() {
    let store = store().await;
    let (t, p) = project_world(&store).await;
    let other = add_project(&store, &p.company, "Other").await;
    let elsewhere = {
        let c = scope(&t, &new_id("cmp"));
        create_company(&store, &c).await;
        c
    };
    let by = actor("alice");
    let stakeholder = add_stakeholder(&store, &p.company).await;
    let foreign = add_stakeholder(&store, &elsewhere).await;
    let item = add_item(&store, &p).await;
    let other_item = add_item(&store, &other).await;
    let shape = ShapeId::new("shape-1").unwrap();

    let mut tx = PlanTx::from(store.project(&p).await.unwrap());
    for refused in [
        LinkTarget::ScopeItem(other_item.clone()),
        LinkTarget::Stakeholder(foreign.clone()),
        LinkTarget::AccessRequest(oryxa_fde_core::AccessRequestId::new("acc_missing").unwrap()),
    ] {
        let r = tx.link_shape(&shape, &refused, &by).await;
        assert!(matches!(r, Err(StoreError::Missing("target"))), "{refused:?}: {r:?}");
        tx = PlanTx::from(store.project(&p).await.unwrap());
    }
    tx.link_shape(&shape, &LinkTarget::ScopeItem(item.clone()), &by)
        .await
        .unwrap()
        .unwrap();
    // Linking again replaces the link.
    let replaced = tx
        .link_shape(&shape, &LinkTarget::Stakeholder(stakeholder.clone()), &by)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replaced.target, LinkTarget::Stakeholder(stakeholder.clone()));
    assert_eq!(tx.canvas_links().await.unwrap().len(), 1);
    tx.link_shape(&ShapeId::new("shape-2").unwrap(), &LinkTarget::ScopeItem(item), &by)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    // The company's canvas may link a scope item of any of its projects.
    let mut company = PlanTx::from(store.company(&p.company).await.unwrap());
    company
        .link_shape(&shape, &LinkTarget::ScopeItem(other_item), &by)
        .await
        .unwrap()
        .unwrap();
    company.commit().await.unwrap();

    // Removing the stakeholder removes its link; it is not refused as still in use.
    let mut records = store.company(&p.company).await.unwrap();
    assert!(records.remove_stakeholder(&stakeholder, &by).await.unwrap());
    records.commit().await.unwrap();
    let mut tx = PlanTx::from(store.project(&p).await.unwrap());
    let shapes: Vec<String> = tx
        .canvas_links()
        .await
        .unwrap()
        .into_iter()
        .map(|l| l.shape.to_string())
        .collect();
    assert_eq!(shapes, ["shape-2"]);
    assert!(tx.unlink_shape(&ShapeId::new("shape-2").unwrap(), &by).await.unwrap());
    assert!(!tx.unlink_shape(&ShapeId::new("shape-2").unwrap(), &by).await.unwrap());
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_thread_is_about_a_record_of_its_place_and_promotes_once() {
    let store = store().await;
    let (_, p) = project_world(&store).await;
    let other = add_project(&store, &p.company, "Other").await;
    let by = actor("alice");
    let stakeholder = add_stakeholder(&store, &p.company).await;
    let item = add_item(&store, &p).await;
    let other_item = add_item(&store, &other).await;
    let document = oryxa_fde_core::DocumentId::new(new_id("doc")).unwrap();
    {
        let mut tx = store.company(&p.company).await.unwrap();
        let v = DocumentIn {
            name: Name::new("policy.txt").unwrap(),
            content_type: ContentType::Text,
            size_bytes: 5,
            sha256: "00".into(),
            blob_key: "k".into(),
        };
        tx.add_document(&document, &v, &by).await.unwrap().unwrap();
        tx.commit().await.unwrap();
    }
    let first = |text: &str| (CommentId::new(new_id("cmt")).unwrap(), Text::new(text).unwrap());
    let start = async |tx: &mut PlanTx, subject: Subject| {
        let (c, body) = first("Opening question");
        tx.start_thread(&ThreadId::new(new_id("thr")).unwrap(), &subject, (&c, &body), &by)
            .await
    };

    // A project thread: on the project's records and the company's people and systems, never on
    // the company's documents or another project's records.
    let mut tx = PlanTx::from(store.project(&p).await.unwrap());
    for refused in [
        Subject::Document(document.clone()),
        Subject::ScopeItem(other_item.clone()),
    ] {
        let r = start(&mut tx, refused.clone()).await;
        assert!(matches!(r, Err(StoreError::Missing("subject"))), "{refused:?}: {r:?}");
    }
    let on_item = start(&mut tx, Subject::ScopeItem(item.clone())).await.unwrap().unwrap();
    start(&mut tx, Subject::Stakeholder(stakeholder.clone()))
        .await
        .unwrap()
        .unwrap();
    start(&mut tx, Subject::Shape(ShapeId::new("shape-1").unwrap()))
        .await
        .unwrap()
        .unwrap();
    let (c, body) = first("Agreed: tier-1 only");
    tx.comment(&on_item.id, &c, &body, &by).await.unwrap().unwrap();
    let only_item = tx.threads(Some(&Subject::ScopeItem(item.clone()))).await.unwrap();
    assert_eq!(only_item.len(), 1);
    assert_eq!(
        (only_item[0].id.clone(), only_item[0].comments),
        (on_item.id.clone(), 2)
    );
    let comments = tx.comments(&on_item.id).await.unwrap().unwrap();
    assert_eq!(
        comments.iter().map(|c| c.body.as_str()).collect::<Vec<_>>(),
        ["Opening question", "Agreed: tier-1 only"]
    );
    tx.commit().await.unwrap();

    // A company thread: on the company's records, never on a project's.
    let mut company = PlanTx::from(store.company(&p.company).await.unwrap());
    let r = start(&mut company, Subject::ScopeItem(item.clone())).await;
    assert!(matches!(r, Err(StoreError::Missing("subject"))), "{r:?}");
    company = PlanTx::from(store.company(&p.company).await.unwrap());
    start(&mut company, Subject::Document(document)).await.unwrap().unwrap();
    // The project's threads are not the company's.
    assert_eq!(company.threads(None).await.unwrap().len(), 1);
    assert!(company.thread(&on_item.id).await.unwrap().is_none());
    let (c, body) = first("Not here");
    assert!(company.comment(&on_item.id, &c, &body, &by).await.unwrap().is_none());
    company.commit().await.unwrap();

    // Promotion records the decision, with the opening comment as its rationale, once.
    let promote = PromoteIn {
        title: Name::new("Tier-1 only").unwrap(),
        rationale: None,
        decided_by: Name::new("Sam Sponsor").unwrap(),
        decided_at: time::OffsetDateTime::now_utc(),
    };
    let mut tx = store.project(&p).await.unwrap();
    let decision = oryxa_fde_core::DecisionId::new(new_id("dec")).unwrap();
    let recorded = tx
        .promote_thread(&on_item.id, &decision, &promote, &by)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recorded.rationale.as_str(), "Opening question");
    let again = tx
        .promote_thread(
            &on_item.id,
            &oryxa_fde_core::DecisionId::new(new_id("dec")).unwrap(),
            &promote,
            &by,
        )
        .await;
    assert!(
        matches!(again, Err(StoreError::Rejected("already_promoted"))),
        "{again:?}"
    );
    tx.commit().await.unwrap();
    let mut tx = PlanTx::from(store.project(&p).await.unwrap());
    assert_eq!(tx.thread(&on_item.id).await.unwrap().unwrap().decision, Some(decision));
    // Another project's thread cannot be promoted from here.
    let mut elsewhere = store.project(&other).await.unwrap();
    let missing = elsewhere
        .promote_thread(
            &on_item.id,
            &oryxa_fde_core::DecisionId::new(new_id("dec")).unwrap(),
            &promote,
            &by,
        )
        .await
        .unwrap();
    assert!(missing.is_none());
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_meeting_note_names_people_of_its_company_only() {
    let store = store().await;
    let (t, p) = project_world(&store).await;
    let elsewhere = {
        let c = scope(&t, &new_id("cmp"));
        create_company(&store, &c).await;
        c
    };
    let by = actor("alice");
    let sam = add_stakeholder(&store, &p.company).await;
    let pat = add_stakeholder(&store, &p.company).await;
    let foreign = add_stakeholder(&store, &elsewhere).await;
    let id = MeetingNoteId::new(new_id("mtg")).unwrap();

    let mut tx = PlanTx::from(store.project(&p).await.unwrap());
    let r = tx
        .add_meeting_note(&id, &note_in(vec![sam.clone(), foreign]), &by)
        .await;
    assert!(matches!(r, Err(StoreError::Missing("stakeholders"))), "{r:?}");
    tx = PlanTx::from(store.project(&p).await.unwrap());
    let added = tx
        .add_meeting_note(&id, &note_in(vec![sam.clone(), pat.clone(), sam.clone()]), &by)
        .await
        .unwrap()
        .unwrap();
    let mut both = vec![sam.clone(), pat.clone()];
    both.sort();
    assert_eq!(added.stakeholders, both);
    let mut changed = note_in(vec![pat.clone()]);
    changed.title = Name::new("Workshop, revised").unwrap();
    let updated = tx.update_meeting_note(&id, &changed, &by).await.unwrap().unwrap();
    assert_eq!(
        (updated.title.as_str(), updated.stakeholders.clone()),
        ("Workshop, revised", vec![pat.clone()])
    );
    tx.commit().await.unwrap();
    // The company's notes are not the project's.
    let mut company = PlanTx::from(store.company(&p.company).await.unwrap());
    assert!(company.meeting_note(&id).await.unwrap().is_none());
    assert!(company.update_meeting_note(&id, &changed, &by).await.unwrap().is_none());
    assert!(!company.remove_meeting_note(&id, &by).await.unwrap());
    drop(company);

    // Removing a stakeholder takes them off the note.
    let mut records = store.company(&p.company).await.unwrap();
    assert!(records.remove_stakeholder(&pat, &by).await.unwrap());
    records.commit().await.unwrap();
    let mut tx = PlanTx::from(store.project(&p).await.unwrap());
    assert!(tx.meeting_note(&id).await.unwrap().unwrap().stakeholders.is_empty());
    assert!(tx.remove_meeting_note(&id, &by).await.unwrap());
    assert!(tx.meeting_notes().await.unwrap().is_empty());
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_guest_grant_is_pending_only_while_its_link_is_live() {
    let store = store().await;
    let admin = admin().await;
    let by = actor("alice");
    let (t, p) = project_world(&store).await;
    let b = {
        let c = scope(&t, &new_id("cmp"));
        create_company(&store, &c).await;
        add_project(&store, &c, "B").await
    };
    let guest = UserId::new("guest_1").unwrap();
    let link = oryxa_fde_core::ShareLinkId::new(new_id("shr")).unwrap();
    let mut tx = store.project(&p).await.unwrap();
    tx.create_share_link(&link, &"ab".repeat(32), 1, &by)
        .await
        .unwrap()
        .unwrap();
    // The table holds a link to 1 to 90 days, whatever writes it.
    for days in [0, 91] {
        let other = oryxa_fde_core::ShareLinkId::new(new_id("shr")).unwrap();
        assert!(
            tx.create_share_link(&other, &"cd".repeat(32), days, &by).await.is_err(),
            "{days}"
        );
    }

    // The wrong secret is refused; the right one makes a guest whose grant is pending.
    assert_eq!(
        tx.redeem_share_link(&link, &"cd".repeat(32), &guest, &by)
            .await
            .unwrap(),
        Redeemed::Refused
    );
    let Redeemed::Guest(row) = tx
        .redeem_share_link(&link, &"ab".repeat(32), &guest, &by)
        .await
        .unwrap()
    else {
        panic!("not redeemed");
    };
    assert!(tx.live_guest(&guest).await.unwrap());
    tx.commit().await.unwrap();
    // Another company's link with the same id is not this one.
    let mut other = store.project(&b).await.unwrap();
    assert_eq!(
        other
            .redeem_share_link(&link, &"ab".repeat(32), &guest, &by)
            .await
            .unwrap(),
        Redeemed::Refused
    );
    drop(other);

    let pending = store.pending_grants(&t, 10).await.unwrap();
    let expected = Grant::Guest(p.clone(), guest.clone(), link.clone());
    assert!(pending.grants().contains(&expected), "{:?}", pending.grants());
    drop(pending);
    assert_eq!(
        store.lock_grant(&row).await.unwrap().map(|g| g.grant().clone()),
        Some(expected.clone())
    );

    // Expired, it justifies nothing: not pending, not lockable, not live.
    sqlx::query("update share_links set created_at = now() - interval '1 day', expires_at = now() - interval '1 second' where link_id = $1")
        .bind(link.as_str())
        .execute(&admin)
        .await
        .unwrap();
    let pending = store.pending_grants(&t, 10).await.unwrap();
    assert!(!pending.grants().contains(&expected));
    drop(pending);
    assert!(store.lock_grant(&row).await.unwrap().is_none());
    let mut tx = store.project(&p).await.unwrap();
    assert!(!tx.live_guest(&guest).await.unwrap());
    // Revoked: its guests are gone, and they are no one's guest any more.
    assert_eq!(
        tx.revoke_share_link(&link, &by).await.unwrap(),
        Some(vec![guest.clone()])
    );
    assert_eq!(tx.share_links().await.unwrap()[0].guests, 0);
    tx.commit().await.unwrap();

    // Row-level security: B's transaction sees none of it.
    let mut tx = store.company(&b.company).await.unwrap();
    for table in ["share_links", "share_link_guests"] {
        let n: i64 = sqlx::query_scalar(&format!("select count(*) from {table}"))
            .fetch_one(tx.conn())
            .await
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    drop(tx);
    // The reconciler's role reads whether a link is live, never its secret.
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("set local role oryxa_fde_grants")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(
        sqlx::query("select secret_sha256 from share_links")
            .execute(&mut *tx)
            .await
            .is_err()
    );
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn only_an_open_project_thread_puts_a_question_to_the_customer() {
    let store = store().await;
    let (_, p) = project_world(&store).await;
    planning_records(&store, &p).await;
    let by = actor("alice");
    let question = Name::new("Who approves refunds?").unwrap();

    // A company thread has no room to show a question in.
    let mut tx = PlanTx::from(store.company(&p.company).await.unwrap());
    let company_thread = tx.threads(None).await.unwrap().remove(0).id;
    assert!(matches!(
        tx.ask_customer(&company_thread, Some(&question), &by).await,
        Err(StoreError::Rejected("not_a_project_thread"))
    ));
    drop(tx);

    let mut tx = PlanTx::from(store.project(&p).await.unwrap());
    let thread = tx.threads(None).await.unwrap().remove(0).id;
    assert!(
        tx.ask_customer(&company_thread, Some(&question), &by)
            .await
            .unwrap()
            .is_none()
    );
    let asked = tx.ask_customer(&thread, Some(&question), &by).await.unwrap().unwrap();
    let (q, at) = asked.customer_question.clone().unwrap();
    assert_eq!(q, question);
    // Asking the same again keeps when it was asked.
    let again = tx.ask_customer(&thread, Some(&question), &by).await.unwrap().unwrap();
    assert_eq!(again.customer_question.unwrap().1, at);
    tx.commit().await.unwrap();
    let mut tx = store.project(&p).await.unwrap();
    assert_eq!(tx.customer_questions().await.unwrap(), vec![(question.clone(), at)]);

    // Promoted, the thread is a decision and asks nothing more.
    let v = PromoteIn {
        title: Name::new("Sam approves").unwrap(),
        rationale: None,
        decided_by: Name::new("Sam").unwrap(),
        decided_at: time::OffsetDateTime::now_utc(),
    };
    let decision = oryxa_fde_core::DecisionId::new(new_id("dec")).unwrap();
    tx.promote_thread(&thread, &decision, &v, &by).await.unwrap().unwrap();
    assert!(tx.customer_questions().await.unwrap().is_empty());
    let mut tx = PlanTx::from(tx);
    assert_eq!(tx.thread(&thread).await.unwrap().unwrap().customer_question, None);
    assert!(matches!(
        tx.ask_customer(&thread, Some(&question), &by).await,
        Err(StoreError::Rejected("already_promoted"))
    ));
    assert!(matches!(
        tx.ask_customer(&thread, None, &by).await,
        Err(StoreError::Rejected("already_promoted"))
    ));
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_share_link_lives_one_to_ninety_days_whatever_writes_it() {
    let store = store().await;
    let (t, p) = project_world(&store).await;
    let link = oryxa_fde_core::ShareLinkId::new(new_id("shr")).unwrap();
    let mut tx = store.project(&p).await.unwrap();
    let made = tx
        .create_share_link(&link, &"ab".repeat(32), 90, &actor("alice"))
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    assert!(made.expires_at > made.created_at + time::Duration::days(89));
    // Even the owner cannot stretch it, or end it before it began.
    let owner = admin().await;
    for set in ["created_at + interval '91 days'", "created_at"] {
        let changed = sqlx::query(&format!(
            "update share_links set expires_at = {set} where tenant_id = $1 and link_id = $2"
        ))
        .bind(t.as_str())
        .bind(link.as_str())
        .execute(&owner)
        .await;
        assert!(changed.is_err(), "{set}");
    }
}

/// A fresh GitHub id, unique in this run.
fn gh_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    (1_000_000 + u64::from(rand::random::<u32>())) * 1000 + NEXT.fetch_add(1, Ordering::SeqCst)
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn github_and_slack_links_stay_in_their_scope_and_routing_reads_only_keys() {
    let store = store().await;
    let by = actor("alice");
    let (t1, pa) = project_world(&store).await;
    let pb = {
        let c = scope(&t1, &new_id("cmp"));
        create_company(&store, &c).await;
        add_project(&store, &c, "B").await
    };
    let (t2, pc) = project_world(&store).await;
    let (i1, i2) = (gh_id(), gh_id());
    let (r1, r2, r3) = (gh_id(), gh_id(), gh_id());
    let name = |n: &str| RepositoryName::new(n).unwrap();

    // Claims: one organisation each, never moved.
    let mut org1 = store.organisation(&t1).await.unwrap();
    assert_eq!(org1.claim_github_installation(i1, &by).await.unwrap(), Claimed::Claimed);
    org1.commit().await.unwrap();
    let mut org2 = store.organisation(&t2).await.unwrap();
    assert_eq!(org2.claim_github_installation(i2, &by).await.unwrap(), Claimed::Claimed);
    assert_eq!(org2.claim_github_installation(i2, &by).await.unwrap(), Claimed::Already);
    assert_eq!(org2.claim_github_installation(i1, &by).await.unwrap(), Claimed::Taken);
    org2.commit().await.unwrap();

    // Links: under the organisation's own installations, one project per repository.
    let link = async |p: &ProjectScope, i: u64, r: u64| {
        let mut tx = store.project(p).await.unwrap();
        let got = tx.link_github_repository(i, r, &name("acme/rag"), &by).await;
        tx.commit().await.unwrap();
        got
    };
    assert!(link(&pa, i1, r1).await.unwrap().is_some());
    assert!(link(&pb, i1, r3).await.unwrap().is_some());
    assert!(link(&pc, i2, r2).await.unwrap().is_some());
    assert!(matches!(link(&pb, i1, r1).await, Err(StoreError::Conflict)));
    assert!(matches!(
        link(&pa, i2, gh_id()).await,
        Err(StoreError::Missing("installation"))
    ));

    // Slack: a workspace each, a channel for A. Team ids are unique in the database the tests
    // share, as a team is one organisation's.
    let team = || SlackTeamId::new(&format!("T{}", new_id("x")[2..14].to_uppercase())).unwrap();
    let team1 = team();
    let mut org1 = store.organisation(&t1).await.unwrap();
    assert_eq!(
        org1.set_slack_installation(&team1, "arn:aws:secretsmanager:x:1:secret:s1", &by)
            .await
            .unwrap(),
        None
    );
    org1.commit().await.unwrap();
    // Another organisation can't take a team that is claimed.
    let mut org2 = store.organisation(&t2).await.unwrap();
    assert!(matches!(
        org2.set_slack_installation(&team1, "arn:aws:secretsmanager:x:1:secret:s2", &by)
            .await,
        Err(StoreError::Rejected("slack_team_claimed"))
    ));
    drop(org2);
    let mut org2 = store.organisation(&t2).await.unwrap();
    org2.lock_slack_team(&team1).await.unwrap();
    org2.set_slack_installation(&team(), "arn:aws:secretsmanager:x:1:secret:s2", &by)
        .await
        .unwrap();
    org2.commit().await.unwrap();
    let mut ca = store.company(&pa.company).await.unwrap();
    // A channel needs its name as Slack has it; the link reads back with the workspace's team.
    assert!(matches!(
        ca.set_slack_channel(&SlackChannelId::new("C0001").unwrap(), "", &by)
            .await,
        Err(StoreError::Missing("channel_name"))
    ));
    let linked = ca
        .set_slack_channel(&SlackChannelId::new("C0001").unwrap(), "acme-rollout", &by)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((linked.name.as_str(), &linked.team), ("acme-rollout", &team1));
    ca.commit().await.unwrap();

    // Deliveries: once by delivery id, once by body.
    let mut tx = store.project(&pa).await.unwrap();
    let body = "a".repeat(64);
    assert!(tx.record_pull_request("d-1", &body, 7, false).await.unwrap());
    assert!(!tx.record_pull_request("d-1", &"b".repeat(64), 7, false).await.unwrap());
    assert!(
        !tx.record_pull_request("d-2", &body, 7, false).await.unwrap(),
        "a replayed body"
    );
    assert!(tx.record_pull_request("d-3", &"c".repeat(64), 7, true).await.unwrap());
    tx.commit().await.unwrap();
    let events: Vec<String> = outbox(&store, &t1).await.into_iter().map(|(_, d, _, _)| d).collect();
    assert_eq!(
        events
            .iter()
            .filter(|d| d.starts_with("fde.pull-request"))
            .collect::<Vec<_>>(),
        ["fde.pull-request.opened.v1", "fde.pull-request.merged.v1"]
    );

    // Row-level security: a company's transaction sees its links and deliveries only, an
    // organisation's its own claims and workspace only.
    let mut tx = store.company(&pa.company).await.unwrap();
    for table in ["github_repositories", "github_deliveries", "slack_channels"] {
        let companies: Vec<String> = sqlx::query_scalar(&format!("select distinct company_id from {table}"))
            .fetch_all(tx.conn())
            .await
            .unwrap();
        assert_eq!(companies, [pa.company.company.as_str()], "{table}");
    }
    for table in ["github_installations", "slack_installations"] {
        let tenants: Vec<String> = sqlx::query_scalar(&format!("select distinct tenant_id from {table}"))
            .fetch_all(tx.conn())
            .await
            .unwrap();
        assert_eq!(tenants, [t1.as_str()], "{table}");
    }
    drop(tx);

    // Routing reads the keys, across tenants, and nothing else.
    assert_eq!(store.github_route(i1, r1).await.unwrap(), Some(pa.clone()));
    assert_eq!(store.github_route(i2, r2).await.unwrap(), Some(pc.clone()));
    assert_eq!(store.github_route(i2, r1).await.unwrap(), None);
    assert_eq!(store.github_installation_tenant(i2).await.unwrap(), Some(t2.clone()));
    assert_eq!(store.slack_team_tenant(&team1).await.unwrap(), Some(t1.clone()));
    assert_eq!(store.slack_team_tenant(&team()).await.unwrap(), None);
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("set local role oryxa_fde_grants")
        .execute(&mut *tx)
        .await
        .unwrap();
    for sql in [
        "select full_name from github_repositories",
        "select claimed_by from github_installations",
        "select secret_arn from slack_installations",
        "select channel_id from slack_channels",
        "select body_sha256 from github_deliveries",
        "delete from github_repositories",
    ] {
        let mut sp = (&mut *tx).begin().await.unwrap();
        assert!(sqlx::query(sql).execute(&mut *sp).await.is_err(), "{sql}");
    }
    drop(tx);

    // An approved update is posted once: claimed, released on a failure that may pass, then marked.
    let monday = time::macros::date!(2026 - 11 - 02);
    let mut tx = store.project(&pa).await.unwrap();
    assert!(tx.slack_post(monday).await.unwrap().is_none(), "no update yet");
    tx.add_update_draft(monday, &UpdateBody::new("Done: tickets").unwrap(), "echo")
        .await
        .unwrap();
    assert!(tx.slack_post(monday).await.unwrap().is_none(), "a draft is not posted");
    tx.decide_update_draft(monday, true, &by).await.unwrap().unwrap();
    let post = tx.slack_post(monday).await.unwrap().unwrap();
    assert_eq!(
        (post.channel.as_str(), post.secret_arn.as_str()),
        ("C0001", "arn:aws:secretsmanager:x:1:secret:s1")
    );
    assert!(tx.claim_slack_post(monday).await.unwrap());
    assert!(!tx.claim_slack_post(monday).await.unwrap());
    tx.finish_slack_post(monday, false).await.unwrap();
    assert!(tx.claim_slack_post(monday).await.unwrap(), "released");
    tx.finish_slack_post(monday, true).await.unwrap();
    tx.finish_slack_post(monday, false).await.unwrap();
    assert!(!tx.claim_slack_post(monday).await.unwrap(), "posted is final");
    tx.commit().await.unwrap();
    let events: Vec<String> = outbox(&store, &t1).await.into_iter().map(|(_, d, _, _)| d).collect();
    assert!(events.contains(&"fde.update.approved.v1".to_owned()));
    // B's project has no channel: nothing to post.
    let mut tx = store.project(&pb).await.unwrap();
    tx.add_update_draft(monday, &UpdateBody::new("B").unwrap(), "echo")
        .await
        .unwrap();
    tx.decide_update_draft(monday, true, &by).await.unwrap().unwrap();
    assert!(tx.slack_post(monday).await.unwrap().is_none());
    drop(tx);

    // Install states: each id once, in any organisation.
    let id = "0123456789abcdef0123456789abcdef";
    let mut org1 = store.organisation(&t1).await.unwrap();
    assert!(org1.use_install_state(id).await.unwrap());
    assert!(!org1.use_install_state(id).await.unwrap());
    assert!(!org1.use_install_state("not-hex").await.unwrap());
    org1.commit().await.unwrap();

    // Unclaiming unlinks that installation's repositories only; uninstalling Slack its channels.
    let mut org1 = store.organisation(&t1).await.unwrap();
    assert!(org1.unclaim_github_installation(i1, &by).await.unwrap());
    assert!(!org1.unclaim_github_installation(i2, &by).await.unwrap(), "not ours");
    assert_eq!(
        org1.remove_slack_installation(&by).await.unwrap().as_deref(),
        Some("arn:aws:secretsmanager:x:1:secret:s1")
    );
    org1.commit().await.unwrap();
    assert_eq!(store.github_route(i1, r1).await.unwrap(), None);
    assert_eq!(store.github_route(i1, r3).await.unwrap(), None);
    assert_eq!(store.github_route(i2, r2).await.unwrap(), Some(pc.clone()));
    let mut ca = store.company(&pa.company).await.unwrap();
    assert!(ca.slack_channel().await.unwrap().is_none());
    assert!(matches!(
        ca.set_slack_channel(&SlackChannelId::new("C0001").unwrap(), "acme-rollout", &by)
            .await,
        Err(StoreError::Missing("slack"))
    ));
}

/// The open checks of the project's current stage, by key.
async fn open_checks(store: &Store, p: &ProjectScope) -> (oryxa_fde_core::Stage, Vec<&'static str>) {
    let mut tx = store.project(p).await.unwrap();
    let (stage, items) = tx.stage_checklist().await.unwrap().unwrap();
    (stage, items.iter().filter(|i| !i.met).map(|i| i.check.key()).collect())
}

/// The project's stage-change audit rows as (to, reason, open items), oldest first.
async fn stage_audits(p: &ProjectScope) -> Vec<(String, Option<String>, Option<Vec<String>>)> {
    sqlx::query(
        "select target, reason, open_items from audit_log
         where tenant_id = $1 and project_id = $2 and action = 'project.stage_changed' order by id",
    )
    .bind(p.company.tenant.as_str())
    .bind(p.project.as_str())
    .fetch_all(&admin().await)
    .await
    .unwrap()
    .into_iter()
    .map(|r| (r.get("target"), r.get("reason"), r.get("open_items")))
    .collect()
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn each_stage_checklist_item_is_worked_out_from_the_records_and_an_open_one_needs_a_reason() {
    use oryxa_fde_core::{AccessRequestId, Check, CriterionId, Stage};
    use oryxa_fde_events::AccessStatus;
    let store = store().await;
    let (t, p) = project_world(&store).await;
    let by = actor("alice");
    let why = Reason::new("Customer confirmed by email").unwrap();
    let step = async |to: Stage, reason: Option<&Reason>| {
        let mut tx = store.project(&p).await.unwrap();
        let moved = tx.change_stage(to, reason, &by).await;
        if moved.is_ok() {
            tx.commit().await.unwrap();
        }
        moved.map(|m| m.unwrap().stage)
    };

    // Discover: stakeholders, then a note on this project (one at the company does not count).
    assert_eq!(
        open_checks(&store, &p).await,
        (Stage::Discover, vec!["stakeholders_named", "discovery_notes"])
    );
    assert!(matches!(
        step(Stage::Scope, None).await,
        Err(StoreError::ChecklistOpen(open)) if open == [Check::StakeholdersNamed, Check::DiscoveryNotes]
    ));
    let sam = add_stakeholder(&store, &p.company).await;
    let mut company = PlanTx::from(store.company(&p.company).await.unwrap());
    let note = MeetingNoteId::new(new_id("mtg")).unwrap();
    company
        .add_meeting_note(&note, &note_in(vec![]), &by)
        .await
        .unwrap()
        .unwrap();
    company.commit().await.unwrap();
    assert_eq!(open_checks(&store, &p).await.1, ["discovery_notes"]);
    let mut project = PlanTx::from(store.project(&p).await.unwrap());
    let note = MeetingNoteId::new(new_id("mtg")).unwrap();
    project
        .add_meeting_note(&note, &note_in(vec![]), &by)
        .await
        .unwrap()
        .unwrap();
    project.commit().await.unwrap();
    assert!(open_checks(&store, &p).await.1.is_empty());
    // Nothing open: the move behaves as before, and a reason given anyway is not kept.
    assert_eq!(step(Stage::Scope, Some(&why)).await.unwrap(), Stage::Scope);

    // Scope: criteria with targets, an out-of-scope item, and a sign-off of the current version.
    assert_eq!(
        open_checks(&store, &p).await.1,
        ["scope_signed_off", "out_of_scope_listed", "criteria_have_targets"]
    );
    let mut tx = store.project(&p).await.unwrap();
    let crit = CriterionId::new(new_id("crt")).unwrap();
    let c = CriterionIn {
        description: Text::new("Answers are correct").unwrap(),
        metric: Name::new("accuracy").unwrap(),
        comparator: Comparator::AtLeast,
        target: 90.0,
        unit: None,
    };
    tx.add_criterion(&crit, &c, &by).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        open_checks(&store, &p).await.1,
        ["scope_signed_off", "out_of_scope_listed"]
    );
    let out = ScopeItemIn {
        kind: ScopeKind::Out,
        description: Text::new("Voice support").unwrap(),
    };
    let mut tx = store.project(&p).await.unwrap();
    tx.add_scope_item(&ScopeItemId::new(new_id("itm")).unwrap(), &out, &by)
        .await
        .unwrap()
        .unwrap();
    tx.sign_off(&sam, &by).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    assert!(open_checks(&store, &p).await.1.is_empty());
    // A change after the sign-off opens it again until the new version is signed.
    let mut tx = store.project(&p).await.unwrap();
    let inside = ScopeItemIn {
        kind: ScopeKind::In,
        description: Text::new("Tier-1 tickets").unwrap(),
    };
    tx.add_scope_item(&ScopeItemId::new(new_id("itm")).unwrap(), &inside, &by)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(open_checks(&store, &p).await.1, ["scope_signed_off"]);
    let mut tx = store.project(&p).await.unwrap();
    tx.sign_off(&sam, &by).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    assert_eq!(step(Stage::Access, None).await.unwrap(), Stage::Access);

    // Access: met with no requests; open while any is not granted.
    assert!(open_checks(&store, &p).await.1.is_empty());
    let mut tx = store.project(&p).await.unwrap();
    let mut req = AccessRequestIn {
        description: Text::new("Read-only API token").unwrap(),
        system: None,
        owner: None,
        status: AccessStatus::Requested,
    };
    let token = AccessRequestId::new(new_id("acc")).unwrap();
    tx.add_access_request(&token, &req, &by).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    assert_eq!(open_checks(&store, &p).await.1, ["access_granted"]);
    req.status = AccessStatus::Granted;
    let mut tx = store.project(&p).await.unwrap();
    tx.update_access_request(&token, &req, &by).await.unwrap().unwrap();
    req.status = AccessStatus::InProgress;
    tx.add_access_request(&AccessRequestId::new(new_id("acc")).unwrap(), &req, &by)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(open_checks(&store, &p).await.1, ["access_granted"]);
    // Moving on with it open: refused without a reason, kept in the audit log with one.
    assert!(matches!(
        step(Stage::Build, None).await,
        Err(StoreError::ChecklistOpen(open)) if open == [Check::AccessGranted]
    ));
    assert_eq!(open_checks(&store, &p).await.0, Stage::Access);
    assert_eq!(step(Stage::Build, Some(&why)).await.unwrap(), Stage::Build);

    // Build: every criterion measured by an eval suite.
    assert_eq!(open_checks(&store, &p).await.1, ["criteria_have_evals"]);
    let mut tx = store.project(&p).await.unwrap();
    let suite = EvalSuiteRow {
        id: new_id("suite"),
        name: "Accuracy".into(),
        criteria: vec![crit.clone()],
        definition: serde_json::json!({ "graders": [] }),
        created_by: by.user.clone(),
        created_at: time::OffsetDateTime::now_utc(),
        cases: vec![],
    };
    tx.create_eval_suite(&suite, &by).await.unwrap();
    tx.commit().await.unwrap();
    assert!(open_checks(&store, &p).await.1.is_empty());
    assert_eq!(step(Stage::Evaluate, None).await.unwrap(), Stage::Evaluate);

    // Evaluate: the rule behind "ready to deploy".
    assert_eq!(open_checks(&store, &p).await.1, ["criteria_met"]);
    let run = oryxa_fde_core::EvalRunId::new(new_id("evr")).unwrap();
    let mut tx = store.project(&p).await.unwrap();
    assert!(tx.record_criterion_result(&crit, &run, 80.0).await.unwrap());
    tx.commit().await.unwrap();
    assert_eq!(open_checks(&store, &p).await.1, ["criteria_met"]);
    let mut tx = store.project(&p).await.unwrap();
    assert!(tx.record_criterion_result(&crit, &run, 95.0).await.unwrap());
    tx.commit().await.unwrap();
    assert!(open_checks(&store, &p).await.1.is_empty());

    // Moving back needs no reason, even to a stage whose items are open.
    let mut tx = store.project(&p).await.unwrap();
    tx.remove_criterion(&crit, &by).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(step(Stage::Build, None).await.unwrap(), Stage::Build);
    assert_eq!(open_checks(&store, &p).await.1, ["criteria_have_evals"]);
    assert_eq!(step(Stage::Evaluate, Some(&why)).await.unwrap(), Stage::Evaluate);
    assert_eq!(step(Stage::Deploy, Some(&why)).await.unwrap(), Stage::Deploy);
    // Nothing recorded yet can be checked to leave deploy.
    assert_eq!(open_checks(&store, &p).await, (Stage::Deploy, vec![]));

    let none = || (None::<String>, None::<Vec<String>>);
    let kept = |open: &[&str]| {
        (
            Some(why.as_str().to_owned()),
            Some(open.iter().map(|k| k.to_string()).collect::<Vec<_>>()),
        )
    };
    let rows: Vec<_> = stage_audits(&p)
        .await
        .into_iter()
        .map(|(to, r, o)| (to, (r, o)))
        .collect();
    assert_eq!(
        rows,
        [
            ("scope".into(), none()),
            ("access".into(), none()),
            ("build".into(), kept(&["access_granted"])),
            ("evaluate".into(), none()),
            ("build".into(), none()),
            ("evaluate".into(), kept(&["criteria_have_evals"])),
            ("deploy".into(), kept(&["criteria_met"])),
        ]
    );
    // The event stays ids only: no reason and no checks in it.
    let events = payloads(&store, &t, "fde.project.stage-changed.v1").await;
    assert_eq!(events.len(), rows.len());
    assert!(events.iter().all(|e| !e.to_string().contains("Customer confirmed")));
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_stage_checklist_reads_only_its_own_company_and_project() {
    use oryxa_fde_core::Stage;
    let store = store().await;
    let (t, p) = project_world(&store).await;
    let by = actor("alice");
    add_stakeholder(&store, &p.company).await;
    let mut tx = PlanTx::from(store.project(&p).await.unwrap());
    let note = MeetingNoteId::new(new_id("mtg")).unwrap();
    tx.add_meeting_note(&note, &note_in(vec![]), &by)
        .await
        .unwrap()
        .unwrap();
    tx.commit().await.unwrap();
    assert!(open_checks(&store, &p).await.1.is_empty());

    // Another company of the same tenant, and another project of the first company, see none of it.
    let other = scope(&t, &new_id("cmp"));
    create_company(&store, &other).await;
    let theirs = other.project(ProjectId::new(new_id("prj")).unwrap());
    let mut tx = store.project(&theirs).await.unwrap();
    tx.create(&project_in("Other"), &by).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        open_checks(&store, &theirs).await,
        (Stage::Discover, vec!["stakeholders_named", "discovery_notes"])
    );
    let sibling = add_project(&store, &p.company, "Sibling").await;
    assert_eq!(open_checks(&store, &sibling).await.1, ["discovery_notes"]);

    // The project named under the other company is not found, and cannot be moved.
    let mismatched = other.project(p.project.clone());
    let mut tx = store.project(&mismatched).await.unwrap();
    assert!(tx.stage_checklist().await.unwrap().is_none());
    assert!(tx.change_stage(Stage::Scope, None, &by).await.unwrap().is_none());
}
