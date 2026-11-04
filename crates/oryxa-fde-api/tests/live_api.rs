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

/// Routes that name nothing: listing is checked by its contents, creating only ever creates in the
/// caller's own tenant (and, for the security answer library, is open to the whole tenant).
const UNTARGETED: &[(&str, &str)] = &[
    ("GET", "/v1/companies"),
    ("POST", "/v1/companies"),
    ("GET", "/v1/security-answers"),
    ("POST", "/v1/security-answers"),
];

/// Every route that names a company, project, record or answer, with a body that would succeed if
/// the call were allowed. Placeholders in braces are filled per attack, in the path and the body.
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
    ("GET", "/v1/companies/{company}/stakeholders", None),
    (
        "POST",
        "/v1/companies/{company}/stakeholders",
        Some(r#"{"name":"pwned"}"#),
    ),
    (
        "PUT",
        "/v1/companies/{company}/stakeholders/{stakeholder}",
        Some(r#"{"name":"pwned"}"#),
    ),
    ("DELETE", "/v1/companies/{company}/stakeholders/{stakeholder}", None),
    ("GET", "/v1/companies/{company}/systems", None),
    ("POST", "/v1/companies/{company}/systems", Some(r#"{"name":"pwned"}"#)),
    (
        "PUT",
        "/v1/companies/{company}/systems/{system}",
        Some(r#"{"name":"pwned"}"#),
    ),
    ("DELETE", "/v1/companies/{company}/systems/{system}", None),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/stage",
        Some(r#"{"stage":"scope"}"#),
    ),
    ("GET", "/v1/companies/{company}/projects/{project}/scope", None),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/scope/items",
        Some(r#"{"kind":"in","description":"pwned"}"#),
    ),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/scope/items/{item}",
        Some(r#"{"kind":"out","description":"pwned"}"#),
    ),
    (
        "DELETE",
        "/v1/companies/{company}/projects/{project}/scope/items/{item}",
        None,
    ),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/scope/criteria",
        Some(r#"{"description":"pwned","metric":"m","comparator":"at_least","target":1}"#),
    ),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/scope/criteria/{criterion}",
        Some(r#"{"description":"pwned","metric":"m","comparator":"at_most","target":0}"#),
    ),
    (
        "DELETE",
        "/v1/companies/{company}/projects/{project}/scope/criteria/{criterion}",
        None,
    ),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/scope/sign-offs",
        Some(r#"{"stakeholder":"{stakeholder}"}"#),
    ),
    ("GET", "/v1/companies/{company}/projects/{project}/scope/changes", None),
    (
        "GET",
        "/v1/companies/{company}/projects/{project}/access-requests",
        None,
    ),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/access-requests",
        Some(r#"{"description":"pwned","status":"granted","owner":"{stakeholder}","system":"{system}"}"#),
    ),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/access-requests/{access_request}",
        Some(r#"{"description":"pwned","status":"granted"}"#),
    ),
    ("GET", "/v1/companies/{company}/projects/{project}/tasks", None),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/tasks",
        Some(r#"{"title":"pwned","status":"todo"}"#),
    ),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/tasks/{task}",
        Some(r#"{"title":"pwned","status":"done"}"#),
    ),
    (
        "DELETE",
        "/v1/companies/{company}/projects/{project}/tasks/{task}",
        None,
    ),
    ("GET", "/v1/companies/{company}/projects/{project}/decisions", None),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/decisions",
        Some(r#"{"title":"pwned","rationale":"x","decided_by":"x"}"#),
    ),
    (
        "PUT",
        "/v1/security-answers/{answer}",
        Some(r#"{"question":"pwned","answer":"pwned"}"#),
    ),
    ("DELETE", "/v1/security-answers/{answer}", None),
];

/// Placeholders that name one record; a route or body using one can be aimed at another company's
/// record from the attacker's own project.
const RECORDS: &[&str] = &[
    "{stakeholder}",
    "{system}",
    "{item}",
    "{criterion}",
    "{access_request}",
    "{task}",
    "{answer}",
];

/// One company in `org`, led by `lead`, with a project, an engineer, a project assignee and one of
/// every lifecycle record.
struct Tenant {
    org: String,
    lead: User,
    engineer: User,
    assignee: User,
    company: String,
    project: String,
    /// Placeholder -> id of this company's record.
    records: Vec<(&'static str, String)>,
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
    let pbase = format!("{base}/projects/{project}");
    let engineer_path = format!("{base}/members/{}", engineer.id);
    w.ok(
        &lead,
        "PUT",
        &engineer_path,
        Some(json!({"role": "engineer"})),
        StatusCode::NO_CONTENT,
    )
    .await;
    let assignee_path = format!("{pbase}/assignees/{}", assignee.id);
    w.ok(&lead, "PUT", &assignee_path, None, StatusCode::NO_CONTENT).await;

    let add = async |path: String, body: Value| -> String {
        let made = w.ok(&lead, "POST", &path, Some(body), StatusCode::CREATED).await;
        made["id"].as_str().map(str::to_owned).unwrap_or_default()
    };
    let stakeholder = add(format!("{base}/stakeholders"), json!({"name": "Sam", "title": "CTO"})).await;
    let system = add(format!("{base}/systems"), json!({"name": "Zendesk"})).await;
    let item = add(
        format!("{pbase}/scope/items"),
        json!({"kind": "in", "description": "Tier-1 tickets"}),
    )
    .await;
    let criterion = add(
        format!("{pbase}/scope/criteria"),
        json!({"description": "Correct", "metric": "accuracy", "comparator": "at_least", "target": 90, "unit": "%"}),
    )
    .await;
    add(format!("{pbase}/scope/sign-offs"), json!({"stakeholder": stakeholder})).await;
    let access_request = add(
        format!("{pbase}/access-requests"),
        json!({"description": "API token", "status": "requested", "owner": stakeholder, "system": system}),
    )
    .await;
    let task = add(
        format!("{pbase}/tasks"),
        json!({"title": "Index tickets", "status": "todo"}),
    )
    .await;
    add(
        format!("{pbase}/decisions"),
        json!({"title": "Use Bedrock", "rationale": "Data stays in AWS", "decided_by": "Sam"}),
    )
    .await;
    let answer = add(
        "/v1/security-answers".into(),
        json!({"question": format!("{name}: encrypted at rest?"), "answer": "Yes"}),
    )
    .await;
    Tenant {
        org: org.to_owned(),
        lead,
        engineer,
        assignee,
        company,
        project,
        records: vec![
            ("{stakeholder}", stakeholder),
            ("{system}", system),
            ("{item}", item),
            ("{criterion}", criterion),
            ("{access_request}", access_request),
            ("{task}", task),
            ("{answer}", answer),
        ],
    }
}

/// What a company's lead sees of it; must not change under attack.
async fn snapshot(w: &World, t: &Tenant) -> Value {
    let base = format!("/v1/companies/{}", t.company);
    let project = format!("{base}/projects/{}", t.project);
    let mut out = json!({});
    for path in [
        base.clone(),
        format!("{base}/members"),
        format!("{base}/projects"),
        format!("{base}/stakeholders"),
        format!("{base}/systems"),
        project.clone(),
        format!("{project}/assignees"),
        format!("{project}/scope"),
        format!("{project}/scope/changes"),
        format!("{project}/access-requests"),
        format!("{project}/tasks"),
        format!("{project}/decisions"),
        "/v1/security-answers".into(),
    ] {
        let mut got = w.ok(&t.lead, "GET", &path, None, StatusCode::OK).await;
        // Time spent waiting moves on its own; nothing else may.
        if let Some(list) = got.as_array_mut() {
            list.iter_mut().for_each(|r| {
                r.as_object_mut().map(|o| o.remove("days_waiting"));
            });
        }
        out[path] = got;
    }
    out
}

struct Attack<'a> {
    who: &'a User,
    company: &'a str,
    project: &'a str,
    records: &'a [(&'static str, String)],
    /// The victim is in another tenant (the security answer library is shared within one).
    cross_tenant: bool,
    kind: Kind,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    /// The victim's company, project and records.
    Victim,
    /// The attacker's own company with the victim's project.
    OwnCompany,
    /// The attacker's own company and project with the victim's records.
    OwnProject,
}

impl Attack<'_> {
    /// Whether this attack applies to the route: acting on your own company or project is allowed,
    /// so those attacks only go where another company's id appears.
    fn applies(&self, template: &str, body: Option<&str>) -> bool {
        let names_record = RECORDS
            .iter()
            .any(|r| template.contains(r) || body.is_some_and(|b| b.contains(r)));
        if !template.contains("{company}") && !self.cross_tenant {
            return false;
        }
        match self.kind {
            Kind::Victim => true,
            Kind::OwnCompany => template.contains("{project}"),
            Kind::OwnProject => names_record,
        }
    }

    fn fill(&self, s: &str) -> String {
        let mut out = s
            .replace("{company}", self.company)
            .replace("{project}", self.project)
            .replace("{user}", &self.who.id);
        for (placeholder, id) in self.records {
            out = out.replace(placeholder, id);
        }
        out
    }
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
                let cross_tenant = v.org != own.org;
                for (kind, company, project) in [
                    (Kind::Victim, &v.company, &v.project),
                    (Kind::OwnCompany, &own.company, &v.project),
                    (Kind::OwnProject, &own.company, &own.project),
                ] {
                    attacks.push(Attack {
                        who,
                        company,
                        project,
                        records: &v.records,
                        cross_tenant,
                        kind,
                    });
                }
            }
        }
    }

    let mut leaks = Vec::new();
    let mut tried = BTreeSet::new();
    let mut calls = 0;
    for (method, template, body) in TARGETED {
        for at in attacks.iter().filter(|at| at.applies(template, *body)) {
            let path = at.fill(template);
            let body = body.map(|b| serde_json::from_str(&at.fill(b)).unwrap());
            let (status, resp) = w.call(Some(&at.who.token), method, &path, body).await;
            calls += 1;
            tried.insert((*method, *template));
            if status.is_success() {
                leaks.push(format!(
                    "{} ({:?}) {method} {path} -> {status} {resp}",
                    at.who.id, at.kind
                ));
            }
        }
    }
    assert!(
        leaks.is_empty(),
        "cross-company access succeeded:\n{}",
        leaks.join("\n")
    );
    assert_eq!(tried.len(), TARGETED.len(), "every targeted route was attacked");
    assert!(calls > 500, "only {calls} attempts");

    // Listing shows only the caller's own companies and tenant; creating stays in the caller's tenant.
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
    let answers = w.ok(&c.lead, "GET", "/v1/security-answers", None, StatusCode::OK).await;
    assert_eq!(
        ids(&answers),
        [c.records[6].1.as_str()],
        "only the tenant's own answers"
    );
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

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn lifecycle_records_end_to_end() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "acme").await;
    let (lead, eng, asg) = (&t.lead, &t.engineer, &t.assignee);
    let base = format!("/v1/companies/{}", t.company);
    let p = format!("{base}/projects/{}", t.project);
    let stakeholder = t.records[0].1.clone();

    // Stages move one forward or back, never skip, and an assignee may move them.
    let stage = format!("{p}/stage");
    let (status, body) = w
        .call(Some(&eng.token), "PUT", &stage, Some(json!({"stage": "build"})))
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("rejected_stage_transition"))
    );
    let moved = w
        .ok(asg, "PUT", &stage, Some(json!({"stage": "scope"})), StatusCode::OK)
        .await;
    assert_eq!(moved["stage"], "scope");
    w.ok(eng, "PUT", &stage, Some(json!({"stage": "discover"})), StatusCode::OK)
        .await;

    // The scope was signed off at version 2 by the company setup; a change makes it stale and a
    // new sign-off covers the new version.
    let scope = w.ok(eng, "GET", &format!("{p}/scope"), None, StatusCode::OK).await;
    assert_eq!(
        (scope["version"].as_u64(), scope["signed_off"].as_bool()),
        (Some(2), Some(true))
    );
    let item = w
        .ok(
            eng,
            "POST",
            &format!("{p}/scope/items"),
            Some(json!({"kind": "out", "description": "Voice"})),
            StatusCode::CREATED,
        )
        .await;
    let scope = w.ok(eng, "GET", &format!("{p}/scope"), None, StatusCode::OK).await;
    assert_eq!(
        (scope["version"].as_u64(), scope["signed_off"].as_bool()),
        (Some(3), Some(false))
    );
    assert_eq!(scope["items"][1]["kind"], "out");
    let sign = format!("{p}/scope/sign-offs");
    let signed = w
        .ok(
            eng,
            "POST",
            &sign,
            Some(json!({"stakeholder": stakeholder})),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(signed["version"], 3);
    let (status, _) = w
        .call(
            Some(&eng.token),
            "POST",
            &sign,
            Some(json!({"stakeholder": stakeholder})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "a version is signed once");
    let (status, body) = w
        .call(
            Some(&eng.token),
            "POST",
            &sign,
            Some(json!({"stakeholder": "stk_nobody"})),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_stakeholder"))
    );
    let item_path = format!("{p}/scope/items/{}", item["id"].as_str().unwrap());
    w.ok(eng, "DELETE", &item_path, None, StatusCode::NO_CONTENT).await;
    let changes = w
        .ok(eng, "GET", &format!("{p}/scope/changes"), None, StatusCode::OK)
        .await;
    let actions: Vec<(u64, &str)> = changes
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["version"].as_u64().unwrap(), c["action"].as_str().unwrap()))
        .collect();
    assert_eq!(
        actions,
        [
            (1, "item_added"),
            (2, "criterion_added"),
            (2, "signed_off"),
            (3, "item_added"),
            (3, "signed_off"),
            (4, "item_removed")
        ]
    );
    // A stakeholder who signed cannot be deleted.
    let (status, _) = w
        .call(
            Some(&lead.token),
            "DELETE",
            &format!("{base}/stakeholders/{stakeholder}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Access requests: owner at the customer, status changes published, days waiting.
    let access = format!("{p}/access-requests/{}", t.records[4].1);
    let granted = w
        .ok(
            eng,
            "PUT",
            &access,
            Some(json!({"description": "API token", "status": "granted", "owner": stakeholder})),
            StatusCode::OK,
        )
        .await;
    assert_eq!(
        (granted["status"].as_str(), granted["days_waiting"].as_i64()),
        (Some("granted"), Some(0))
    );
    assert!(granted["granted_at"].is_string());

    // Tasks: blocked needs a blocker; waiting on the customer is its own state.
    let task = format!("{p}/tasks/{}", t.records[5].1);
    let (status, body) = w
        .call(
            Some(&eng.token),
            "PUT",
            &task,
            Some(json!({"title": "Index tickets", "status": "blocked"})),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("rejected_blocker_required"))
    );
    let waiting = w
        .ok(
            eng,
            "PUT",
            &task,
            Some(json!({"title": "Index tickets", "status": "waiting_on_customer"})),
            StatusCode::OK,
        )
        .await;
    assert_eq!(waiting["status"], "waiting_on_customer");

    // Decisions keep who, when and why.
    let d = w
        .ok(
            eng,
            "POST",
            &format!("{p}/decisions"),
            Some(json!({"title": "Ship to staging", "rationale": "Evals pass", "decided_by": "Sam", "decided_at": "2026-11-01T10:00:00Z"})),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(
        (d["decided_by"].as_str(), d["decided_at"].as_str()),
        (Some("Sam"), Some("2026-11-01T10:00:00Z"))
    );
    assert_eq!(d["recorded_by"], eng.id.as_str());
    let (status, _) = w
        .call(
            Some(&eng.token),
            "POST",
            &format!("{p}/decisions"),
            Some(json!({"title": "x", "rationale": "x", "decided_by": "x", "decided_at": "yesterday"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The security answer library is shared across the organisation.
    let other = user(&org, "other", "member");
    let answers = w.ok(&other, "GET", "/v1/security-answers", None, StatusCode::OK).await;
    assert_eq!(answers.as_array().unwrap().len(), 1);

    // Every state change with an event wrote it through the outbox.
    assert_eq!(
        w.events(&org).await,
        [
            "fde.company.created.v1",
            "fde.project.created.v1",
            "fde.scope.signed-off.v1",
            "fde.project.stage-changed.v1",
            "fde.project.stage-changed.v1",
            "fde.scope.signed-off.v1",
            "fde.access-request.status-changed.v1",
        ]
    );
}
