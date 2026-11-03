//! Against a real Postgres. Start one, then run:
//!   docker run --rm -e POSTGRES_PASSWORD=oryxa -e POSTGRES_DB=oryxa_fde -p 55432:5432 pgvector/pgvector:pg17
//!   DATABASE_URL=postgres://postgres:oryxa@localhost:55432/oryxa_fde cargo test -p oryxa-fde-store -- --ignored
//! Each test uses fresh tenant ids, so runs never see each other's rows.

use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
use oryxa_events::{Encoded, MemoryPublisher, PublishError, Publisher, Signer, Verifier, decode};
use oryxa_fde_events::{CompanyCreated, ProjectCreated};
use sqlx::Row;

use super::*;
use crate::relay::{MAX_ATTEMPTS, dispatch_once};

async fn store() -> Store {
    let url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:oryxa@localhost:55432/oryxa_fde".into());
    let store = Store::connect(&url).await.unwrap();
    store.migrate().await.unwrap();
    store
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
    tx.create(&Name::new("Acme").unwrap(), &actor("alice")).await.unwrap();
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

/// Outbox rows of one tenant as (id, detail_type, group, published), oldest first. Read as the
/// pool's login role, which owns the tables and is not limited by the app role's policies.
async fn outbox(store: &Store, t: &TenantId) -> Vec<(String, String, String, bool)> {
    let mut tx = store.pool().begin().await.unwrap();
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
    let mut tx = store.pool().begin().await.unwrap();
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
    let t = tenant();
    create_company(&store, &scope(&t, &new_id("cmp"))).await;
    for sql in [
        "update audit_log set action = 'x' where tenant_id = $1",
        "delete from audit_log where tenant_id = $1",
    ] {
        let r = sqlx::query(sql).bind(t.as_str()).execute(store.pool()).await;
        assert!(r.is_err(), "{sql} must fail");
    }
    let rows: i64 = sqlx::query_scalar("select count(*) from audit_log where tenant_id = $1")
        .bind(t.as_str())
        .fetch_one(store.pool())
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
    tx.create(&Name::new("Acme").unwrap(), &actor("alice")).await.unwrap();
    drop(tx);
    assert!(store.company(&c).await.unwrap().get().await.unwrap().is_none());
    assert!(outbox(&store, &t).await.is_empty());

    // Committed: both, with the scope's event group.
    create_company(&store, &c).await;
    let p = c.project(ProjectId::new(new_id("prj")).unwrap());
    let mut tx = store.project(&p).await.unwrap();
    let project = tx
        .create(&Name::new("RAG").unwrap(), &actor("alice"))
        .await
        .unwrap()
        .unwrap();
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
    assert!(
        tx.create(&Name::new("x").unwrap(), &actor("alice"))
            .await
            .unwrap()
            .is_none()
    );
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

/// Runs the relay until none of `t`'s rows can go out now (due and not held back by its group).
async fn drain<P: Publisher>(store: &Store, signer: &Signer, publisher: &P, t: &TenantId) {
    for _ in 0..100 {
        dispatch_once(store.pool(), signer, publisher, 50).await.unwrap();
        let due: i64 = sqlx::query_scalar(
            "select count(*) from outbox o
             where tenant_id = $1 and published_at is null and dead_at is null and available_at <= now()
               and not exists (
                   select 1 from outbox e
                   where e.group_key = o.group_key and e.seq < o.seq
                     and e.published_at is null and e.dead_at is null and e.available_at > now())",
        )
        .bind(t.as_str())
        .fetch_one(store.pool())
        .await
        .unwrap();
        if due == 0 {
            return;
        }
    }
    panic!("relay did not drain");
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn relay_signs_and_publishes_in_order_with_the_row_id_and_scope_group() {
    let _turn = RELAY_TESTS.lock().await;
    let store = store().await;
    let (signer, verifier) = keys();
    let t = tenant();
    let c = scope(&t, &new_id("cmp"));
    create_company(&store, &c).await;
    // Two more events in the company's group, so order within a group is visible.
    let mut tx = store.company(&c).await.unwrap();
    for _ in 0..2 {
        enqueue(
            tx.conn(),
            &c,
            &actor("alice"),
            &CompanyCreated {
                company: c.company.clone(),
            },
        )
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    let p = c.project(ProjectId::new(new_id("prj")).unwrap());
    let mut tx = store.project(&p).await.unwrap();
    tx.create(&Name::new("RAG").unwrap(), &actor("alice")).await.unwrap();
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
    assert_eq!((got.tenant, got.data.project), (t.clone(), p.project.clone()));
    let (attempts, error): (i32, String) = sqlx::query_as("select attempts, last_error from outbox where id = $1")
        .bind(company_rows[0])
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!((attempts, error.as_str()), (1, "eventbridge: down"));

    // Backoff over, bus back: the group goes out in its original order, each with its row id as
    // the event id (the bus deduplication id) and a valid signature.
    sqlx::query("update outbox set available_at = now() where tenant_id = $1")
        .bind(t.as_str())
        .execute(store.pool())
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
        assert_eq!(got.data.company, c.company);
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
async fn a_row_that_keeps_failing_goes_dead_and_unblocks_its_group() {
    let _turn = RELAY_TESTS.lock().await;
    let store = store().await;
    let (signer, _) = keys();
    let t = tenant();
    let c = scope(&t, &new_id("cmp"));
    create_company(&store, &c).await;
    let mut tx = store.company(&c).await.unwrap();
    enqueue(
        tx.conn(),
        &c,
        &actor("alice"),
        &CompanyCreated {
            company: c.company.clone(),
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let rows = outbox(&store, &t).await;
    sqlx::query("update outbox set attempts = $2 where id = $1")
        .bind(&rows[0].0)
        .bind(MAX_ATTEMPTS - 1)
        .execute(store.pool())
        .await
        .unwrap();

    let down = FailGroup {
        group: c.event_group(),
        ok: MemoryPublisher::default(),
    };
    drain(&store, &signer, &down, &t).await;
    let dead: bool = sqlx::query_scalar("select dead_at is not null from outbox where id = $1")
        .bind(&rows[0].0)
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert!(dead);

    // The second row failed once in the same batch; after its backoff, the dead row no longer
    // holds it back.
    let up = MemoryPublisher::default();
    sqlx::query("update outbox set available_at = now() where tenant_id = $1")
        .bind(t.as_str())
        .execute(store.pool())
        .await
        .unwrap();
    drain(&store, &signer, &up, &t).await;
    let published: Vec<bool> = outbox(&store, &t).await.into_iter().map(|r| r.3).collect();
    assert_eq!(published, [false, true]);
}
