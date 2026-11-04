//! `may_use_connection` against a real SpiceDB with the real schema:
//!   SPICEDB_ENDPOINT=http://localhost:50051 cargo test -p oryxa-authz -- --ignored

use std::time::Duration;

use oryxa_authz::*;
use oryxa_core::{AgentId, ConnectionId, TenantId, UserId};
use oryxa_spicedb_proto::v1::{WriteSchemaRequest, schema_service_client::SchemaServiceClient};

const SCHEMA: &str = include_str!("../../../schema/oryxa.zed");

fn rel(resource: ObjectRef, relation: &'static str, subject: SubjectRef) -> Relationship {
    Relationship {
        resource,
        relation,
        subject,
        caveat: None,
        expires_at: None,
    }
}

fn user(u: &str) -> UserId {
    UserId::new(u).unwrap()
}

fn agent(a: &str) -> AgentId {
    AgentId::new(a).unwrap()
}

fn uuid_like() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

/// A tenant with: alice (admin) and bob, carol, dave (members); alice's and bob's personal agents and
/// a workspace agent; alice's personal connection and a workspace connection granted to the
/// workspace agent.
async fn world() -> (SpiceDb, TenantId) {
    let endpoint = std::env::var("SPICEDB_ENDPOINT").unwrap_or_else(|_| "http://localhost:50051".into());
    // serve-testing gives each preshared key its own empty datastore.
    let key = format!("oryxa-conn-{}-{}", std::process::id(), uuid_like());
    let mut schema = SchemaServiceClient::connect(endpoint.clone()).await.unwrap();
    let mut req = tonic::Request::new(WriteSchemaRequest { schema: SCHEMA.into() });
    req.metadata_mut()
        .insert("authorization", format!("Bearer {key}").parse().unwrap());
    schema.write_schema(req).await.unwrap();
    let db = SpiceDb::connect(&endpoint, &key, Duration::from_secs(2)).await.unwrap();

    let t = TenantId::new("org_conn").unwrap();
    let o = |kind, id: &str| ObjectRef::new(&t, kind, id);
    let u = |id: &str| SubjectRef::object(o("user", id));
    let ws = || SubjectRef::object(o("workspace", "ws"));
    let mut w = vec![
        rel(o("workspace", "ws"), "admin", u("alice")),
        rel(o("agent", "ws_agent"), "workspace", ws()),
        rel(o("agent", "alice_pa"), "owner", u("alice")),
        rel(o("agent", "bob_pa"), "owner", u("bob")),
    ];
    for m in ["bob", "carol", "dave"] {
        w.push(rel(o("workspace", "ws"), "member", u(m)));
    }
    for (conn, granted) in [("c_alice", "alice_pa"), ("c_slack", "ws_agent")] {
        w.push(rel(o("connection", conn), "workspace", ws()));
        w.push(rel(o("connection", conn), "owner", u("alice")));
        w.push(rel(
            o("connection", conn),
            "agent_user",
            SubjectRef::object(o("agent", granted)),
        ));
    }
    db.write(&t, &w.into_iter().map(Write::Touch).collect::<Vec<_>>(), &[])
        .await
        .unwrap();
    (db, t)
}

#[tokio::test]
#[ignore = "needs a running SpiceDB (SPICEDB_ENDPOINT)"]
async fn connection_use_is_the_owner_s_agent_or_a_granted_one() {
    let (db, t) = world().await;
    let fresh = Consistency::FullyConsistent;
    let use_ = |conn: &'static str, a: &'static str, acting: &'static str, owner: Option<&'static str>| {
        let db = &db;
        let t = t.clone();
        let fresh = fresh.clone();
        async move {
            let owner = owner.map(user);
            let conn = ConnectionId::new(conn).unwrap();
            may_use_connection(db, &t, &conn, &agent(a), &user(acting), owner.as_ref(), &fresh)
                .await
                .unwrap()
        }
    };
    // Personal: alice's own agent, acting for alice.
    assert!(use_("c_alice", "alice_pa", "alice", Some("alice")).await);
    // ...never acting for someone else, and never another user's personal agent.
    assert!(!use_("c_alice", "alice_pa", "bob", Some("alice")).await);
    assert!(!use_("c_alice", "bob_pa", "bob", Some("alice")).await);
    // Workspace: the granted workspace agent, for any member; ungranted agents cannot.
    assert!(use_("c_slack", "ws_agent", "bob", None).await);
    assert!(!use_("c_slack", "alice_pa", "alice", None).await);
}

#[tokio::test]
async fn an_authz_outage_denies() {
    // Nothing listens here: the check fails, and the caller must treat the error as deny.
    let db = SpiceDb::connect_lazy("http://127.0.0.1:1", "key", Duration::from_millis(300)).unwrap();
    let t = TenantId::new("org_conn").unwrap();
    let r = may_use_connection(
        &db,
        &t,
        &ConnectionId::new("c_slack").unwrap(),
        &agent("ws_agent"),
        &user("bob"),
        None,
        &Consistency::MinimizeLatency,
    )
    .await;
    assert!(r.is_err());
}
