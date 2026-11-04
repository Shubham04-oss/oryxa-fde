//! The API against a real SpiceDB and Postgres, including the isolation suite (ADR 0002):
//!   docker run --rm -p 50051:50051 authzed/spicedb:v1.56.2 serve-testing
//!   docker run --rm -e POSTGRES_PASSWORD=oryxa -e POSTGRES_DB=oryxa_fde -p 55432:5432 pgvector/pgvector:pg17
//!   DATABASE_URL=postgres://postgres:oryxa@localhost:55432/oryxa_fde SPICEDB_ENDPOINT=http://localhost:50051 \
//!     cargo test -p oryxa-fde-api -- --ignored
//! Every test uses fresh tenants and its own SpiceDB datastore.

mod support;

use std::collections::BTreeSet;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use oryxa_authz::SpiceDb;
use oryxa_fde_api::{ApiDoc, App, router};
use oryxa_fde_store::{Store, new_id};
use oryxa_spicedb_proto::v1::{WriteSchemaRequest, schema_service_client::SchemaServiceClient};
use serde_json::{Value, json};
use sqlx::Row;
use tower::ServiceExt;
use utoipa::OpenApi;

const SCHEMA: &str = include_str!("../../../schema/fde.zed");

struct World {
    router: Router,
    store: Store,
}

async fn world() -> World {
    let url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:oryxa@localhost:55432/oryxa_fde".into());
    let store = Store::connect(&url).await.unwrap();
    store.migrate().await.unwrap();

    let endpoint = std::env::var("SPICEDB_ENDPOINT").unwrap_or_else(|_| "http://localhost:50051".into());
    // serve-testing gives each preshared key its own empty datastore.
    let key = new_id("fde-test");
    let mut schema = SchemaServiceClient::connect(endpoint.clone()).await.unwrap();
    let mut req = tonic::Request::new(WriteSchemaRequest { schema: SCHEMA.into() });
    req.metadata_mut()
        .insert("authorization", format!("Bearer {key}").parse().unwrap());
    schema.write_schema(req).await.unwrap();
    let authz = SpiceDb::connect(&endpoint, &key, Duration::from_secs(2)).await.unwrap();

    World {
        router: router(App::new(store.clone(), authz, support::verifier())),
        store,
    }
}

impl World {
    async fn call(&self, token: Option<&str>, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        let req = match body {
            Some(b) => req
                .header("content-type", "application/json")
                .body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Calls as `who` and requires `want`; returns the body.
    async fn ok(&self, who: &User, method: &str, path: &str, body: Option<Value>, want: StatusCode) -> Value {
        let (status, body) = self.call(Some(&who.token), method, path, body).await;
        assert_eq!(status, want, "{} {method} {path}: {body}", who.id);
        body
    }

    async fn status(&self, who: &User, method: &str, path: &str, body: Option<Value>) -> StatusCode {
        self.call(Some(&who.token), method, path, body).await.0
    }

    /// Outbox detail types for one tenant, oldest first.
    async fn events(&self, tenant: &str) -> Vec<String> {
        let mut tx = self.store.pool().begin().await.unwrap();
        sqlx::query("set local role oryxa_fde_relay")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("select detail_type from outbox where tenant_id = $1 order by seq")
            .bind(tenant)
            .fetch_all(&mut *tx)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.get("detail_type"))
            .collect()
    }
}

struct User {
    id: String,
    token: String,
}

fn user(org: &str, name: &str, role: &str) -> User {
    let id = format!("user_{name}_{}", new_id("u"));
    User {
        token: support::token(Some(org), &id, role),
        id,
    }
}

fn ids(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn companies_projects_and_members_end_to_end() {
    let w = world().await;
    let org = new_id("org");
    let (alice, bob, carol, dana) = (
        user(&org, "alice", "member"),
        user(&org, "bob", "member"),
        user(&org, "carol", "member"),
        user(&org, "dana", "admin"),
    );

    // Any member of the organisation may create a company and becomes its lead.
    let created = w
        .ok(
            &alice,
            "POST",
            "/v1/companies",
            Some(json!({"name": " Acme "})),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(created["name"], "Acme");
    let a = created["id"].as_str().unwrap().to_owned();
    let company = format!("/v1/companies/{a}");
    let listed = w.ok(&alice, "GET", "/v1/companies", None, StatusCode::OK).await;
    assert_eq!(ids(&listed), [a.as_str()]);
    let listed = w.ok(&bob, "GET", "/v1/companies", None, StatusCode::OK).await;
    assert!(ids(&listed).is_empty());
    assert_eq!(w.status(&bob, "GET", &company, None).await, StatusCode::FORBIDDEN);

    // The lead invites an engineer, who can then work on the company but not manage it.
    let bob_member = format!("{company}/members/{}", bob.id);
    w.ok(
        &alice,
        "PUT",
        &bob_member,
        Some(json!({"role": "engineer"})),
        StatusCode::NO_CONTENT,
    )
    .await;
    let members = w
        .ok(&bob, "GET", &format!("{company}/members"), None, StatusCode::OK)
        .await;
    let roles: BTreeSet<(String, String)> = members
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["user"].as_str().unwrap().to_owned(),
                m["role"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        roles,
        BTreeSet::from([(alice.id.clone(), "lead".into()), (bob.id.clone(), "engineer".into())])
    );
    let rename = Some(json!({"name": "Acme Corp"}));
    assert_eq!(
        w.status(&bob, "PATCH", &company, rename.clone()).await,
        StatusCode::FORBIDDEN
    );
    let renamed = w.ok(&alice, "PATCH", &company, rename, StatusCode::OK).await;
    assert_eq!(renamed["name"], "Acme Corp");

    // Projects: the lead creates, engineers work on them.
    let new_project = Some(json!({"name": "Support RAG"}));
    let projects = format!("{company}/projects");
    assert_eq!(
        w.status(&bob, "POST", &projects, new_project.clone()).await,
        StatusCode::FORBIDDEN
    );
    let p = w.ok(&alice, "POST", &projects, new_project, StatusCode::CREATED).await;
    assert_eq!(
        (p["stage"].as_str(), p["company"].as_str()),
        (Some("discover"), Some(a.as_str()))
    );
    let project = format!("{projects}/{}", p["id"].as_str().unwrap());
    w.ok(&bob, "GET", &project, None, StatusCode::OK).await;
    let renamed = w
        .ok(&bob, "PATCH", &project, Some(json!({"name": "RAG"})), StatusCode::OK)
        .await;
    assert_eq!(renamed["name"], "RAG");
    assert_eq!(ids(&w.ok(&bob, "GET", &projects, None, StatusCode::OK).await).len(), 1);

    // An assignee works on that one project and nothing else of the company.
    let carol_on_project = format!("{project}/assignees/{}", carol.id);
    assert_eq!(
        w.status(&bob, "PUT", &carol_on_project, None).await,
        StatusCode::FORBIDDEN
    );
    w.ok(&alice, "PUT", &carol_on_project, None, StatusCode::NO_CONTENT)
        .await;
    w.ok(&carol, "GET", &project, None, StatusCode::OK).await;
    let assignees = w
        .ok(&carol, "GET", &format!("{project}/assignees"), None, StatusCode::OK)
        .await;
    assert_eq!(assignees[0]["user"], carol.id.as_str());
    assert_eq!(w.status(&carol, "GET", &company, None).await, StatusCode::FORBIDDEN);
    assert_eq!(w.status(&carol, "GET", &projects, None).await, StatusCode::FORBIDDEN);

    // A WorkOS admin manages every company of the organisation.
    assert_eq!(
        ids(&w.ok(&dana, "GET", "/v1/companies", None, StatusCode::OK).await),
        [a.as_str()]
    );
    w.ok(&dana, "PATCH", &company, Some(json!({"name": "Acme"})), StatusCode::OK)
        .await;

    // Removal takes effect at once, and takes the member's project assignments with it.
    let bob_on_project = format!("{project}/assignees/{}", bob.id);
    w.ok(&alice, "PUT", &bob_on_project, None, StatusCode::NO_CONTENT).await;
    w.ok(&alice, "DELETE", &bob_member, None, StatusCode::NO_CONTENT).await;
    assert_eq!(w.status(&bob, "GET", &company, None).await, StatusCode::FORBIDDEN);
    assert_eq!(w.status(&bob, "GET", &project, None).await, StatusCode::FORBIDDEN);
    assert_eq!(
        w.status(&bob, "PATCH", &project, Some(json!({"name": "Mine now"})))
            .await,
        StatusCode::FORBIDDEN
    );
    let left = w
        .ok(&alice, "GET", &format!("{project}/assignees"), None, StatusCode::OK)
        .await;
    assert!(
        left.as_array().unwrap().iter().all(|a| a["user"] != bob.id.as_str()),
        "a removed member must not stay assigned: {left}"
    );
    w.ok(&alice, "DELETE", &carol_on_project, None, StatusCode::NO_CONTENT)
        .await;
    assert_eq!(w.status(&carol, "GET", &project, None).await, StatusCode::FORBIDDEN);

    // State changes published through the outbox.
    assert_eq!(
        w.events(&org).await,
        ["fde.company.created.v1", "fde.project.created.v1"]
    );
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn bad_tokens_and_bad_input_are_refused() {
    let w = world().await;
    let org = new_id("org");
    let alice = user(&org, "alice", "member");
    assert_eq!(
        w.call(None, "GET", "/v1/companies", None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        w.call(Some("not.a.jwt"), "GET", "/v1/companies", None).await.0,
        StatusCode::UNAUTHORIZED
    );
    // Valid token, but no organisation selected.
    let (status, body) = w
        .call(
            Some(&support::token(None, "user_x", "member")),
            "GET",
            "/v1/companies",
            None,
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::FORBIDDEN, Some("no_organisation"))
    );
    // An organisation id that is not a valid tenant id.
    let bad_org = support::token(Some("org|other"), "user_x", "member");
    assert_eq!(
        w.call(Some(&bad_org), "GET", "/v1/companies", None).await.0,
        StatusCode::UNAUTHORIZED
    );

    let (status, body) = w
        .call(Some(&alice.token), "POST", "/v1/companies", Some(json!({"name": "  "})))
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_name"))
    );
    let extra = Some(json!({"name": "Acme", "owner": "someone"}));
    assert!(w.status(&alice, "POST", "/v1/companies", extra).await.is_client_error());
    assert_eq!(
        w.status(&alice, "GET", "/v1/companies/not%7Cvalid", None).await,
        StatusCode::BAD_REQUEST
    );
}

/// Every route in the OpenAPI spec as (method, path template).
fn spec_routes() -> BTreeSet<(String, String)> {
    let spec = serde_json::to_value(ApiDoc::openapi()).unwrap();
    let mut out = BTreeSet::new();
    for (path, item) in spec["paths"].as_object().unwrap() {
        for method in item.as_object().unwrap().keys() {
            out.insert((method.to_uppercase(), path.clone()));
        }
    }
    out
}

/// Routes that take no company: listing is checked by its contents, creating only ever creates
/// in the caller's own tenant.
const UNTARGETED: &[(&str, &str)] = &[("GET", "/v1/companies"), ("POST", "/v1/companies")];

/// Every route that names a company, with a body that would succeed if it were allowed.
const TARGETED: &[(&str, &str, Option<&str>)] = &[
    ("GET", "/v1/companies/{company}", None),
    ("PATCH", "/v1/companies/{company}", Some(r#"{"name":"pwned"}"#)),
    ("GET", "/v1/companies/{company}/members", None),
    (
        "PUT",
        "/v1/companies/{company}/members/{user}",
        Some(r#"{"role":"lead"}"#),
    ),
    ("DELETE", "/v1/companies/{company}/members/{user}", None),
    ("GET", "/v1/companies/{company}/projects", None),
    ("POST", "/v1/companies/{company}/projects", Some(r#"{"name":"pwned"}"#)),
    ("GET", "/v1/companies/{company}/projects/{project}", None),
    (
        "PATCH",
        "/v1/companies/{company}/projects/{project}",
        Some(r#"{"name":"pwned"}"#),
    ),
    ("GET", "/v1/companies/{company}/projects/{project}/assignees", None),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/assignees/{user}",
        None,
    ),
    (
        "DELETE",
        "/v1/companies/{company}/projects/{project}/assignees/{user}",
        None,
    ),
];

/// One company in `org`, led by `lead`, with a project, an engineer and a project assignee.
struct Tenant {
    org: String,
    lead: User,
    engineer: User,
    assignee: User,
    company: String,
    project: String,
}

async fn company(w: &World, org: &str, name: &str) -> Tenant {
    let lead = user(org, &format!("{name}_lead"), "member");
    let engineer = user(org, &format!("{name}_eng"), "member");
    let assignee = user(org, &format!("{name}_asg"), "member");
    let c = w
        .ok(
            &lead,
            "POST",
            "/v1/companies",
            Some(json!({"name": name})),
            StatusCode::CREATED,
        )
        .await;
    let company = c["id"].as_str().unwrap().to_owned();
    let base = format!("/v1/companies/{company}");
    let p = w
        .ok(
            &lead,
            "POST",
            &format!("{base}/projects"),
            Some(json!({"name": name})),
            StatusCode::CREATED,
        )
        .await;
    let project = p["id"].as_str().unwrap().to_owned();
    let engineer_path = format!("{base}/members/{}", engineer.id);
    w.ok(
        &lead,
        "PUT",
        &engineer_path,
        Some(json!({"role": "engineer"})),
        StatusCode::NO_CONTENT,
    )
    .await;
    let assignee_path = format!("{base}/projects/{project}/assignees/{}", assignee.id);
    w.ok(&lead, "PUT", &assignee_path, None, StatusCode::NO_CONTENT).await;
    Tenant {
        org: org.to_owned(),
        lead,
        engineer,
        assignee,
        company,
        project,
    }
}

/// What a company's lead sees of it; must not change under attack.
async fn snapshot(w: &World, t: &Tenant) -> Value {
    let base = format!("/v1/companies/{}", t.company);
    let project = format!("{base}/projects/{}", t.project);
    let mut out = json!({});
    for (key, path) in [
        ("company", base.clone()),
        ("members", format!("{base}/members")),
        ("projects", format!("{base}/projects")),
        ("project", project.clone()),
        ("assignees", format!("{project}/assignees")),
    ] {
        out[key] = w.ok(&t.lead, "GET", &path, None, StatusCode::OK).await;
    }
    out
}

struct Attack<'a> {
    who: &'a User,
    company: &'a str,
    project: &'a str,
    /// The attacker's own company with someone else's project: only project routes apply, since
    /// acting on your own company is allowed.
    idor: bool,
    label: &'static str,
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn isolation_suite_no_endpoint_reaches_another_company_or_tenant() {
    let w = world().await;

    // The suite covers every route the API documents.
    let covered: BTreeSet<(String, String)> = UNTARGETED
        .iter()
        .map(|(m, p)| (m.to_string(), p.to_string()))
        .chain(TARGETED.iter().map(|(m, p, _)| (m.to_string(), p.to_string())))
        .collect();
    assert_eq!(covered, spec_routes(), "add new routes to the isolation suite");

    // Companies A and B in one tenant, C in another.
    let (org1, org2) = (new_id("org"), new_id("org"));
    let a = company(&w, &org1, "alpha").await;
    let b = company(&w, &org1, "beta").await;
    let c = company(&w, &org2, "gamma").await;
    let before = [snapshot(&w, &a).await, snapshot(&w, &b).await, snapshot(&w, &c).await];
    let events_before = [w.events(&org1).await, w.events(&org2).await];

    // Everyone at A attacks B (same tenant) and C (other tenant); everyone at C attacks A.
    let mut attacks = Vec::new();
    for (own, victims) in [(&a, vec![&b, &c]), (&c, vec![&a])] {
        for who in [&own.lead, &own.engineer, &own.assignee] {
            for v in &victims {
                let label = if v.org == own.org {
                    "same tenant, other company"
                } else {
                    "other tenant"
                };
                attacks.push(Attack {
                    who,
                    company: &v.company,
                    project: &v.project,
                    idor: false,
                    label,
                });
                let label = if v.org == own.org {
                    "own company, same tenant's project"
                } else {
                    "own company, other tenant's project"
                };
                attacks.push(Attack {
                    who,
                    company: &own.company,
                    project: &v.project,
                    idor: true,
                    label,
                });
            }
        }
    }

    let mut leaks = Vec::new();
    let mut tried = 0;
    for (method, template, body) in TARGETED {
        for at in attacks.iter().filter(|at| !at.idor || template.contains("{project}")) {
            // The user in the path is the attacker, trying to add themselves.
            let path = template
                .replace("{company}", at.company)
                .replace("{project}", at.project)
                .replace("{user}", &at.who.id);
            let body = body.map(|b| serde_json::from_str(b).unwrap());
            let (status, resp) = w.call(Some(&at.who.token), method, &path, body).await;
            tried += 1;
            if status.is_success() {
                leaks.push(format!(
                    "{} ({}) {method} {path} -> {status} {resp}",
                    at.who.id, at.label
                ));
            }
        }
    }
    assert!(
        leaks.is_empty(),
        "cross-company access succeeded:\n{}",
        leaks.join("\n")
    );
    assert!(tried > 100, "only {tried} attempts");

    // Listing shows only the caller's own companies; creating stays in the caller's tenant.
    for (t, others) in [(&a, [&b.company, &c.company]), (&c, [&a.company, &b.company])] {
        for who in [&t.lead, &t.engineer, &t.assignee] {
            let list = w.ok(who, "GET", "/v1/companies", None, StatusCode::OK).await;
            assert!(
                others.iter().all(|o| !ids(&list).contains(&o.as_str())),
                "{} sees {list}",
                who.id
            );
        }
    }
    let made = w
        .ok(
            &c.lead,
            "POST",
            "/v1/companies",
            Some(json!({"name": "new"})),
            StatusCode::CREATED,
        )
        .await;
    let made = made["id"].as_str().unwrap();
    for who in [&a.lead, &b.lead] {
        let list = w.ok(who, "GET", "/v1/companies", None, StatusCode::OK).await;
        assert!(!ids(&list).contains(&made));
        let path = format!("/v1/companies/{made}");
        assert_eq!(w.status(who, "GET", &path, None).await, StatusCode::FORBIDDEN);
    }

    // Nothing changed, no event was written, and no attempt left a grant behind.
    let after = [snapshot(&w, &a).await, snapshot(&w, &b).await, snapshot(&w, &c).await];
    assert_eq!(before, after);
    assert_eq!(events_before[0], w.events(&org1).await);
    let mut org2_events = events_before[1].clone();
    org2_events.push("fde.company.created.v1".into());
    assert_eq!(org2_events, w.events(&org2).await);
    for who in [&a.lead, &a.engineer, &a.assignee] {
        for path in [
            format!("/v1/companies/{}", b.company),
            format!("/v1/companies/{}/projects/{}", b.company, b.project),
            format!("/v1/companies/{}/projects/{}", a.company, b.project),
        ] {
            assert_ne!(
                w.status(who, "GET", &path, None).await,
                StatusCode::OK,
                "{} {path}",
                who.id
            );
        }
    }
}
