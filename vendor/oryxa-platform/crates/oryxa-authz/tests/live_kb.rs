//! `kb_visible` and `may_use_connection` against a real SpiceDB with the real schema (#29):
//!   SPICEDB_ENDPOINT=http://localhost:50051 cargo test -p oryxa-authz -- --ignored

use std::time::Duration;

use oryxa_authz::*;
use oryxa_core::{AgentId, ConnectionId, KbItemId, TenantId, UserId, WorkspaceId};
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

/// A tenant with: members bob, carol, dave (alice admin); a Drive source the workspace agent was
/// given and a "hr" source it was not; and items with different grants.
async fn world() -> (SpiceDb, TenantId) {
    let endpoint = std::env::var("SPICEDB_ENDPOINT").unwrap_or_else(|_| "http://localhost:50051".into());
    // serve-testing gives each preshared key its own empty datastore.
    let key = format!("oryxa-kb-{}-{}", std::process::id(), uuid_like());
    let mut schema = SchemaServiceClient::connect(endpoint.clone()).await.unwrap();
    let mut req = tonic::Request::new(WriteSchemaRequest { schema: SCHEMA.into() });
    req.metadata_mut()
        .insert("authorization", format!("Bearer {key}").parse().unwrap());
    schema.write_schema(req).await.unwrap();
    let db = SpiceDb::connect(&endpoint, &key, Duration::from_secs(2)).await.unwrap();

    let t = TenantId::new("org_kb").unwrap();
    let o = |kind, id: &str| ObjectRef::new(&t, kind, id);
    let u = |id: &str| SubjectRef::object(o("user", id));
    let ws_members = || SubjectRef::set(o("workspace", "ws"), "member");
    let mut w = vec![
        rel(o("workspace", "ws"), "admin", u("alice")),
        rel(
            o("knowledge_base", "kb"),
            "workspace",
            SubjectRef::object(o("workspace", "ws")),
        ),
        rel(
            o("agent", "ws_agent"),
            "workspace",
            SubjectRef::object(o("workspace", "ws")),
        ),
        rel(o("agent", "alice_pa"), "owner", u("alice")),
        rel(o("agent", "bob_pa"), "owner", u("bob")),
    ];
    for m in ["bob", "carol", "dave"] {
        w.push(rel(o("workspace", "ws"), "member", u(m)));
    }
    for (source, given) in [("drive", true), ("hr", false)] {
        w.push(rel(
            o("kb_source", source),
            "knowledge_base",
            SubjectRef::object(o("knowledge_base", "kb")),
        ));
        w.push(rel(o("kb_source", source), "viewer", ws_members()));
        if given {
            w.push(rel(
                o("kb_source", source),
                "agent_reader",
                SubjectRef::object(o("agent", "ws_agent")),
            ));
        }
    }
    // Items: who may view each.
    let item = |id: &str, source: &str, viewer: SubjectRef| {
        [
            rel(o("kb_item", id), "source", SubjectRef::object(o("kb_source", source))),
            rel(o("kb_item", id), "viewer", viewer),
        ]
    };
    w.extend(item("shared", "drive", ws_members()));
    w.extend(item("bobs", "drive", u("bob")));
    w.extend(item("carols", "drive", u("carol")));
    w.extend(item("hr_handbook", "hr", ws_members()));
    // A provider group: design = {carol}.
    w.push(rel(o("provider_group", "design"), "member", u("carol")));
    w.extend(item(
        "design_spec",
        "drive",
        SubjectRef::set(o("provider_group", "design"), "member"),
    ));
    // Connections.
    w.push(rel(o("connection", "c_alice"), "owner", u("alice")));
    w.push(rel(
        o("connection", "c_alice"),
        "agent_user",
        SubjectRef::object(o("agent", "alice_pa")),
    ));
    w.push(rel(o("connection", "c_slack"), "owner", u("alice")));
    w.push(rel(
        o("connection", "c_slack"),
        "agent_user",
        SubjectRef::object(o("agent", "ws_agent")),
    ));
    db.write(&t, &w.into_iter().map(Write::Touch).collect::<Vec<_>>(), &[])
        .await
        .unwrap();
    (db, t)
}

fn uuid_like() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

const ITEMS: [&str; 5] = ["shared", "bobs", "carols", "hr_handbook", "design_spec"];

async fn visible(db: &SpiceDb, t: &TenantId, acting_for: Option<&UserId>, audience: &Audience) -> Vec<&'static str> {
    let ws = agent("ws_agent");
    let reader = KbReader {
        agent: &ws,
        acting_for,
        audience,
    };
    let items: Vec<KbItemId> = ITEMS.iter().map(|s| KbItemId::new(*s).unwrap()).collect();
    let ws_id = WorkspaceId::new("ws").unwrap();
    let shown = kb_visible(db, t, &ws_id, &reader, &items, &Consistency::FullyConsistent)
        .await
        .unwrap();
    ITEMS.iter().zip(shown).filter(|(_, s)| *s).map(|(i, _)| *i).collect()
}

#[tokio::test]
#[ignore = "needs a running SpiceDB (SPICEDB_ENDPOINT)"]
async fn the_agent_sees_the_intersection_of_its_sources_its_human_and_its_readers() {
    let (db, t) = world().await;
    let bob = user("bob");
    let carol = user("carol");

    // Bob asks in a DM: what bob can see, from sources the agent was given (not hr).
    assert_eq!(
        visible(&db, &t, Some(&bob), &Audience::one(&bob)).await,
        ["shared", "bobs"]
    );
    // Carol's provider group grants her the design spec.
    assert_eq!(
        visible(&db, &t, Some(&carol), &Audience::one(&carol)).await,
        ["shared", "carols", "design_spec"]
    );
    // Bob asks in a channel with carol: only what both can see. Bob's private doc stays out.
    let channel = Audience {
        users: vec![bob.clone(), carol.clone()],
        unmatched: 0,
    };
    assert_eq!(visible(&db, &t, Some(&bob), &channel).await, ["shared"]);
    // A scheduled workspace agent (no human): the readers alone decide.
    assert_eq!(
        visible(&db, &t, None, &Audience::one(&carol)).await,
        ["shared", "carols", "design_spec"]
    );
    // The same reader twice changes nothing.
    let twice = Audience {
        users: vec![carol.clone(), carol.clone()],
        unmatched: 0,
    };
    assert_eq!(
        visible(&db, &t, None, &twice).await,
        ["shared", "carols", "design_spec"]
    );
}

#[tokio::test]
#[ignore = "needs a running SpiceDB (SPICEDB_ENDPOINT)"]
async fn a_scheduled_agent_with_no_readers_sees_only_workspace_wide_items() {
    let (db, t) = world().await;
    // No human, empty audience: private items in its sources (bobs, carols, design_spec) stay hidden.
    assert_eq!(visible(&db, &t, None, &Audience::default()).await, ["shared"]);
}

#[tokio::test]
#[ignore = "needs a running SpiceDB (SPICEDB_ENDPOINT)"]
async fn unmatched_readers_and_huge_audiences_fail_closed() {
    let (db, t) = world().await;
    let bob = user("bob");
    // One Slack Connect external in the channel: nothing is shown there.
    let with_external = Audience {
        users: vec![bob.clone()],
        unmatched: 1,
    };
    assert!(visible(&db, &t, Some(&bob), &with_external).await.is_empty());
    // Over the cap: only items the whole workspace may see.
    let crowd = Audience {
        users: (0..=MAX_AUDIENCE).map(|n| user(&format!("member_{n}"))).collect(),
        unmatched: 0,
    };
    assert_eq!(visible(&db, &t, Some(&bob), &crowd).await, ["shared"]);
}

#[tokio::test]
#[ignore = "needs a running SpiceDB (SPICEDB_ENDPOINT)"]
async fn a_removed_group_member_loses_access_at_once() {
    let (db, t) = world().await;
    let carol = user("carol");
    let o = |kind, id: &str| ObjectRef::new(&t, kind, id);
    db.write(
        &t,
        &[Write::Delete(rel(
            o("provider_group", "design"),
            "member",
            SubjectRef::object(o("user", "carol")),
        ))],
        &[],
    )
    .await
    .unwrap();
    assert_eq!(
        visible(&db, &t, Some(&carol), &Audience::one(&carol)).await,
        ["shared", "carols"]
    );
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
    let t = TenantId::new("org_kb").unwrap();
    let ws = agent("ws_agent");
    let bob = user("bob");
    let audience = Audience::one(&bob);
    let reader = KbReader {
        agent: &ws,
        acting_for: Some(&bob),
        audience: &audience,
    };
    let r = kb_visible(
        &db,
        &t,
        &WorkspaceId::new("ws").unwrap(),
        &reader,
        &[KbItemId::new("shared").unwrap()],
        &Consistency::MinimizeLatency,
    )
    .await;
    assert!(r.is_err());
}
