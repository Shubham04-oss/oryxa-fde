//! Runs against a real SpiceDB. Start one, then run:
//!   docker run --rm -p 50051:50051 authzed/spicedb:v1.56.2 serve-testing
//!   SPICEDB_ENDPOINT=http://localhost:50051 cargo test -p oryxa-authz -- --ignored

use std::time::Duration;

use oryxa_authz::*;
use oryxa_core::TenantId;
use oryxa_spicedb_proto::v1::{WriteSchemaRequest, schema_service_client::SchemaServiceClient};
use serde_json::json;

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

#[tokio::test]
#[ignore = "needs a running SpiceDB (SPICEDB_ENDPOINT)"]
async fn tool_call_and_kb_checks_against_real_spicedb() {
    let endpoint = std::env::var("SPICEDB_ENDPOINT").unwrap_or_else(|_| "http://localhost:50051".into());
    // serve-testing gives each preshared key its own empty datastore.
    let key = format!("oryxa-test-{}", std::process::id());

    let mut schema = SchemaServiceClient::connect(endpoint.clone()).await.unwrap();
    let mut req = tonic::Request::new(WriteSchemaRequest { schema: SCHEMA.into() });
    req.metadata_mut()
        .insert("authorization", format!("Bearer {key}").parse().unwrap());
    schema.write_schema(req).await.unwrap();

    let db = SpiceDb::connect(&endpoint, &key, Duration::from_secs(2)).await.unwrap();
    let t = TenantId::new("org_1").unwrap();
    let o = |kind, id| ObjectRef::new(&t, kind, id);
    let user = |id| SubjectRef::object(o("user", id));

    let token = db
        .write(
            &t,
            &[
                Write::Touch(rel(o("workspace", "ws"), "member", user("bob"))),
                Write::Touch(rel(
                    o("knowledge_base", "kb"),
                    "workspace",
                    SubjectRef::object(o("workspace", "ws")),
                )),
                Write::Touch(rel(
                    o("kb_source", "jira"),
                    "knowledge_base",
                    SubjectRef::object(o("knowledge_base", "kb")),
                )),
                Write::Touch(rel(o("kb_source", "jira"), "viewer", user("bob"))),
                Write::Touch(rel(
                    o("kb_item", "https://jira/ENG-1"),
                    "source",
                    SubjectRef::object(o("kb_source", "jira")),
                )),
                Write::Touch(rel(o("kb_item", "https://jira/ENG-1"), "viewer", user("bob"))),
                Write::Touch(Relationship {
                    caveat: Some(("args_match", json!({"approved_args_hash": "h1"}))),
                    expires_at: Some(std::time::SystemTime::now() + Duration::from_secs(600)),
                    ..rel(o("capability", "gmail_send"), "approved_invoker", user("alice"))
                }),
            ],
            &[],
        )
        .await
        .unwrap();
    let fresh = Consistency::AtLeastAsFresh(token);

    // KB post-check: one bulk call, results in request order.
    let item = |doc, who| CheckItem {
        resource: o("kb_item", doc),
        permission: "view",
        subject: user(who),
        context: None,
    };
    let decisions = db
        .check_bulk(
            &t,
            &[
                item("https://jira/ENG-1", "bob"),
                item("https://jira/ENG-1", "carol"),
                item("missing", "bob"),
            ],
            &fresh,
        )
        .await
        .unwrap();
    assert_eq!(
        decisions.iter().map(Decision::allowed).collect::<Vec<_>>(),
        [true, false, false]
    );

    // Approval is bound to the exact args hash; missing context is conditional, hence deny.
    let invoke = |ctx| CheckItem {
        resource: o("capability", "gmail_send"),
        permission: "invoke",
        subject: user("alice"),
        context: ctx,
    };
    assert!(
        db.check(&t, &invoke(Some(json!({"args_hash": "h1"}))), &fresh)
            .await
            .unwrap()
            .allowed()
    );
    assert!(
        !db.check(&t, &invoke(Some(json!({"args_hash": "h2"}))), &fresh)
            .await
            .unwrap()
            .allowed()
    );
    assert!(matches!(
        db.check(&t, &invoke(None), &fresh).await.unwrap(),
        Decision::Conditional { .. }
    ));

    // Revoke, then a check at the revoke's token must deny.
    let revoked = db
        .write(
            &t,
            &[Write::Delete(rel(
                o("kb_item", "https://jira/ENG-1"),
                "viewer",
                user("bob"),
            ))],
            &[],
        )
        .await
        .unwrap();
    assert!(
        !db.check(
            &t,
            &item("https://jira/ENG-1", "bob"),
            &Consistency::AtLeastAsFresh(revoked)
        )
        .await
        .unwrap()
        .allowed()
    );

    // Precondition failure rolls back the whole write.
    let failed = db
        .write(
            &t,
            &[Write::Touch(rel(o("kb_item", "x"), "viewer", user("bob")))],
            &[Precondition::MustExist(rel(o("kb_item", "x"), "owner", user("nobody")))],
        )
        .await;
    assert!(failed.is_err());

    // Lookup returns caller ids, tenant prefix stripped.
    let sources = db
        .lookup_resources(&t, "kb_source", "search", &user("bob"), &fresh)
        .await
        .unwrap();
    assert_eq!(sources, ["jira"]);
}
