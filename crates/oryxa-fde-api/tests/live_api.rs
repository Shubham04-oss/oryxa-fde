//! The API against a real SpiceDB and Postgres, including the isolation suite (ADR 0002):
//!   docker run --rm -p 50051:50051 authzed/spicedb:v1.56.2 serve-testing
//!   docker run --rm -e POSTGRES_PASSWORD=oryxa -e POSTGRES_DB=oryxa_fde -p 55432:5432 pgvector/pgvector:pg17
//!   DATABASE_URL=postgres://postgres:oryxa@localhost:55432/oryxa_fde SPICEDB_ENDPOINT=http://localhost:50051 \
//!     cargo test -p oryxa-fde-api -- --ignored
//! Every test uses fresh tenants and its own SpiceDB datastore. The API connects as a fresh runtime
//! login; `DATABASE_URL`'s login is the owner, used only to read the outbox.

mod support;

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use oryxa_authz::SpiceDb;
use oryxa_core::TenantId;
use oryxa_fde_api::{App, SignIn, openapi, reconcile_grants, router};
use oryxa_fde_context::Context;
use oryxa_fde_core::{CompanyId, CompanyScope, DocumentId};
use oryxa_fde_store::{Store, new_id, testing};
use oryxa_spicedb_proto::v1::{WriteSchemaRequest, schema_service_client::SchemaServiceClient};
use serde_json::{Value, json};
use sqlx::Row;
use tower::ServiceExt;

const SCHEMA: &str = include_str!("../../../schema/fde.zed");
/// The web app the API serves cookies for in these tests.
const WEB: &str = "https://fde.test";

struct World {
    router: Router,
    /// The MCP server on the same app.
    mcp: Router,
    app: Arc<App>,
    store: Store,
    authz: SpiceDb,
    /// Files in memory and the fake embedder, shared with ingestion.
    context: Context,
    /// AuthKit for browser sign-in.
    authkit: Arc<support::FakeAuthKit>,
    /// Seals session cookies; random per world.
    password: String,
}

fn sign_in_config(authkit: &Arc<support::FakeAuthKit>, password: &str) -> SignIn {
    SignIn::new(WEB, password, authkit.clone()).unwrap()
}

async fn world() -> World {
    let store = testing::store().await;

    let endpoint = std::env::var("SPICEDB_ENDPOINT").unwrap_or_else(|_| "http://localhost:50051".into());
    // serve-testing gives each preshared key its own empty datastore.
    let key = new_id("fde-test");
    let mut schema = SchemaServiceClient::connect(endpoint.clone()).await.unwrap();
    let mut req = tonic::Request::new(WriteSchemaRequest { schema: SCHEMA.into() });
    req.metadata_mut()
        .insert("authorization", format!("Bearer {key}").parse().unwrap());
    schema.write_schema(req).await.unwrap();
    let authz = SpiceDb::connect(&endpoint, &key, Duration::from_secs(2)).await.unwrap();
    let context = Context::fake();
    let authkit = Arc::new(support::FakeAuthKit::default());
    let password = format!("{}{}", new_id("x").replace("x_", ""), new_id("x").replace("x_", ""));
    let app = App::with_sign_in(
        store.clone(),
        authz.clone(),
        support::verifier(),
        context.clone(),
        sign_in_config(&authkit, &password),
    );

    World {
        router: router(app.clone()),
        mcp: oryxa_fde_mcp::router(app.clone(), Vec::new()),
        app,
        store,
        authz,
        context,
        authkit,
        password,
    }
}

impl World {
    /// Another replica of the API: same database and SpiceDB, its own caches.
    fn replica(&self) -> Router {
        router(App::with_sign_in(
            self.store.clone(),
            self.authz.clone(),
            support::verifier(),
            self.context.clone(),
            sign_in_config(&self.authkit, &self.password),
        ))
    }

    /// A raw request: the status, the response headers and the JSON body.
    async fn send(&self, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Value) {
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let (status, headers) = (resp.status(), resp.headers().clone());
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, headers, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Signs in through `/auth/login` and `/auth/callback` as `user` of `org` (no org when
    /// `None`); returns the response of the callback.
    async fn sign_in_as(
        &self,
        org: Option<&str>,
        user: &str,
        role: &str,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        *self.authkit.who.lock().unwrap() = (org.map(str::to_owned), user.to_owned(), role.to_owned());
        let login = Request::get("/auth/login?return_to=/companies")
            .body(Body::empty())
            .unwrap();
        let (status, headers, _) = self.send(login).await;
        assert_eq!(status, StatusCode::FOUND);
        let location = headers["location"].to_str().unwrap();
        let state = location
            .split("state=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .to_owned();
        let pending = set_cookie(&headers, "__Host-fde_signin").unwrap();
        let callback = Request::get(format!("/auth/callback?code=code-{state}&state={state}"))
            .header("cookie", format!("__Host-fde_signin={pending}"))
            .body(Body::empty())
            .unwrap();
        self.send(callback).await
    }

    /// A signed-in user's session cookie value.
    async fn session(&self, who: &User, org: &str) -> String {
        let (status, headers, body) = self.sign_in_as(Some(org), &who.id, "member").await;
        assert_eq!(status, StatusCode::FOUND, "{body}");
        set_cookie(&headers, "__Host-fde_session").unwrap()
    }

    /// Calls with a session cookie; `same_site` adds what the web app sends on changes.
    async fn with_cookie(
        &self,
        cookie: &str,
        method: &str,
        path: &str,
        body: Option<Value>,
        same_site: bool,
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header("cookie", format!("__Host-fde_session={cookie}"));
        if same_site {
            req = req.header("x-oryxa-request", "1").header("origin", WEB);
        }
        let req = match body {
            Some(b) => req
                .header("content-type", "application/json")
                .body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        self.send(req).await
    }

    /// Calls an MCP tool as `token`: the HTTP status and the JSON-RPC response.
    async fn tool(&self, token: Option<&str>, tool: &str, arguments: Value) -> (StatusCode, Value) {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": tool, "arguments": arguments}});
        let mut req = Request::builder()
            .method("POST")
            .uri(oryxa_fde_mcp::PATH)
            .header("host", "localhost")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        let resp = self
            .mcp
            .clone()
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }

    /// Sends one JSON-RPC request to the MCP server as `token`: the HTTP status and the response.
    async fn mcp_rpc(&self, token: &str, body: &Value) -> (StatusCode, Value) {
        let req = Request::builder()
            .method("POST")
            .uri(oryxa_fde_mcp::PATH)
            .header("host", "localhost")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::from(body.to_string()))
            .unwrap();
        let resp = self.mcp.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Sends `bytes` as the body with `content_type`, not as JSON.
    async fn send_raw(
        &self,
        token: &str,
        method: &str,
        path: &str,
        content_type: &str,
        bytes: &[u8],
    ) -> (StatusCode, Value) {
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", content_type)
            .body(Body::from(bytes.to_vec()))
            .unwrap();
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Uploads a text document as `who` and ingests it; returns its id.
    async fn document(&self, who: &User, org: &str, company: &str, name: &str, text: &str) -> String {
        let path = format!("/v1/companies/{company}/documents?name={name}");
        let (status, body) = self
            .send_raw(&who.token, "POST", &path, "text/plain", text.as_bytes())
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let id = body["id"].as_str().unwrap().to_owned();
        let scope = CompanyScope::new(TenantId::new(org).unwrap(), CompanyId::new(company).unwrap());
        oryxa_fde_context::ingest::ingest(&self.context, &self.store, &scope, &DocumentId::new(&id).unwrap())
            .await
            .unwrap();
        id
    }

    async fn call_on(
        &self,
        router: &Router,
        token: Option<&str>,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
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
        let resp = router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn call(&self, token: Option<&str>, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.call_on(&self.router, token, method, path, body).await
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

    /// Outbox detail types for one tenant, oldest first, read as the owner.
    async fn events(&self, tenant: &str) -> Vec<String> {
        let owner = testing::admin().await;
        sqlx::query("select detail_type from outbox where tenant_id = $1 order by seq")
            .bind(tenant)
            .fetch_all(&owner)
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.get("detail_type"))
            .collect()
    }
}

/// The value a response sets for cookie `name`, if it sets one.
fn set_cookie(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| {
            v.strip_prefix(&format!("{name}="))?
                .split(';')
                .next()
                .map(str::to_owned)
        })
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

/// Every route in the OpenAPI spec as (method, path template). The router is built from the same
/// list (`oryxa_fde_api::routes`), so these are the routes it serves.
fn spec_routes() -> BTreeSet<(String, String)> {
    let spec = serde_json::to_value(openapi()).unwrap();
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
    ("GET", "/v1/me"),
    ("GET", "/v1/today"),
    ("GET", "/auth/login"),
    ("GET", "/auth/callback"),
    ("POST", "/auth/logout"),
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
    ("GET", "/v1/companies/{company}/documents", None),
    ("POST", "/v1/companies/{company}/documents", Some(RAW_UPLOAD)),
    ("GET", "/v1/companies/{company}/documents/{document}", None),
    ("GET", "/v1/companies/{company}/search", None),
    ("GET", "/v1/companies/{company}/projects/{project}/search", None),
    ("GET", "/v1/companies/{company}/projects/{project}/stakeholders", None),
    ("GET", "/v1/companies/{company}/projects/{project}/systems", None),
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
        Some(r#"{"description":"pwned","status":"requested","owner":"{stakeholder}","system":"{system}"}"#),
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
        Some(r#"{"title":"pwned","status":"todo","waiting_on":"{stakeholder}"}"#),
    ),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/tasks/{task}",
        Some(r#"{"title":"pwned","status":"done","waiting_on":"{stakeholder}"}"#),
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

/// Every MCP tool; each takes a company and a project.
const MCP_TOOLS: &[&str] = &["search_context", "get_scope", "list_decisions", "list_tasks"];

/// The body of an upload attack: sent as text/plain, not JSON.
const RAW_UPLOAD: &str = "RAW:pwned";

/// The query string an attack adds to a route that needs one.
fn query_for(method: &str, template: &str) -> &'static str {
    match (method, template.rsplit('/').next()) {
        ("POST", Some("documents")) => "?name=pwned",
        ("GET", Some("search")) => "?q=refunds",
        _ => "",
    }
}

/// Placeholders that name one record; a route or body using one can be aimed at another company's
/// record from the attacker's own project.
const RECORDS: &[&str] = &[
    "{document}",
    "{stakeholder}",
    "{system}",
    "{item}",
    "{criterion}",
    "{access_request}",
    "{task}",
    "{answer}",
];

/// One company in `org`, led by `lead`, with a project, an engineer, a project assignee and one of
/// every lifecycle record, plus a WorkOS admin of `org`. Every record is open to the change an
/// attack would make, so a missing permission check cannot hide behind a refusal from the data:
/// `{stakeholder}` has signed nothing and can be deleted, and the scope's current version is
/// unsigned (a signer signed an earlier one).
struct Tenant {
    org: String,
    lead: User,
    engineer: User,
    assignee: User,
    admin: User,
    company: String,
    project: String,
    /// Placeholder -> id of this company's record.
    records: Vec<(&'static str, String)>,
    /// Each user's session cookie, by user id.
    sessions: Vec<(String, String)>,
}

impl Tenant {
    /// The id of this company's record for `placeholder`.
    fn record(&self, placeholder: &str) -> &str {
        self.records
            .iter()
            .find(|(p, _)| *p == placeholder)
            .map(|(_, id)| id.as_str())
            .unwrap()
    }
}

async fn company(w: &World, org: &str, name: &str) -> Tenant {
    let lead = user(org, &format!("{name}_lead"), "member");
    let engineer = user(org, &format!("{name}_eng"), "member");
    let assignee = user(org, &format!("{name}_asg"), "member");
    let admin = user(org, &format!("{name}_admin"), "admin");
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
    let signer = add(format!("{base}/stakeholders"), json!({"name": "Sam", "title": "CTO"})).await;
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
    add(format!("{pbase}/scope/sign-offs"), json!({"stakeholder": signer})).await;
    // Changed since it was signed, so the current version is open to a sign-off.
    add(
        format!("{pbase}/scope/items"),
        json!({"kind": "in", "description": "Escalations"}),
    )
    .await;
    let stakeholder = add(
        format!("{base}/stakeholders"),
        json!({"name": "Pat", "title": "Head of Support"}),
    )
    .await;
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
    let mut sessions = Vec::new();
    for (who, role) in [
        (&lead, "member"),
        (&engineer, "member"),
        (&assignee, "member"),
        (&admin, "admin"),
    ] {
        let (status, headers, body) = w.sign_in_as(Some(org), &who.id, role).await;
        assert_eq!(status, StatusCode::FOUND, "{body}");
        sessions.push((who.id.clone(), set_cookie(&headers, "__Host-fde_session").unwrap()));
    }
    let document = w
        .document(
            &lead,
            org,
            &company,
            "policy.txt",
            &format!("{name} refunds over 500 need approval from the support lead"),
        )
        .await;
    Tenant {
        org: org.to_owned(),
        lead,
        engineer,
        assignee,
        admin,
        sessions,
        company,
        project,
        records: vec![
            ("{stakeholder}", stakeholder),
            ("{document}", document),
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
        format!("{base}/documents"),
        format!("{base}/search?q=refunds"),
        project.clone(),
        format!("{project}/assignees"),
        format!("{project}/stakeholders"),
        format!("{project}/systems"),
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
    /// The victim's company with the attacker's own project (which the attacker may work on).
    OwnProjectInVictimCompany,
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
            Kind::OwnCompany | Kind::OwnProjectInVictimCompany => template.contains("{project}"),
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

    // Everyone at A attacks B (same tenant) and C (other tenant); everyone at C attacks A. A WorkOS
    // admin manages every company of their own tenant, so they attack the other tenant only.
    let mut attacks = Vec::new();
    for (own, victims) in [(&a, vec![&b, &c]), (&c, vec![&a])] {
        for who in [&own.lead, &own.engineer, &own.assignee, &own.admin] {
            for v in &victims {
                let cross_tenant = v.org != own.org;
                if who.id == own.admin.id && !cross_tenant {
                    continue;
                }
                for (kind, company, project) in [
                    (Kind::Victim, &v.company, &v.project),
                    (Kind::OwnCompany, &own.company, &v.project),
                    (Kind::OwnProjectInVictimCompany, &v.company, &own.project),
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

    // A session cookie is checked exactly as a bearer token is: the attacks aimed at another
    // company are sent with each attacker's cookie too, as the web app sends them.
    let cookie_of = |who: &User| -> String {
        [&a, &b, &c]
            .iter()
            .flat_map(|t| t.sessions.iter())
            .find(|(id, _)| *id == who.id)
            .map(|(_, cookie)| cookie.clone())
            .unwrap()
    };
    let mut leaks = Vec::new();
    let mut tried = BTreeSet::new();
    let mut calls = 0;
    for (method, template, body) in TARGETED {
        for at in attacks.iter().filter(|at| at.applies(template, *body)) {
            let path = at.fill(template) + query_for(method, template);
            let raw = body.and_then(|b| b.strip_prefix("RAW:"));
            let body: Option<Value> = match raw {
                Some(_) => None,
                None => body.map(|b| serde_json::from_str(&at.fill(b)).unwrap()),
            };
            let (status, resp) = match raw {
                Some(raw) => {
                    w.send_raw(&at.who.token, method, &path, "text/plain", raw.as_bytes())
                        .await
                }
                None => w.call(Some(&at.who.token), method, &path, body.clone()).await,
            };
            calls += 1;
            tried.insert((*method, *template));
            if status.is_success() {
                leaks.push(format!(
                    "{} ({:?}) {method} {path} -> {status} {resp}",
                    at.who.id, at.kind
                ));
            }
            // Uploads take a raw body, which the cookie helper does not send.
            if raw.is_none() && matches!(at.kind, Kind::Victim | Kind::OwnProjectInVictimCompany) {
                let (status, _, resp) = w.with_cookie(&cookie_of(at.who), method, &path, body, true).await;
                calls += 1;
                if status.is_success() {
                    leaks.push(format!(
                        "{} ({:?}, cookie) {method} {path} -> {status} {resp}",
                        at.who.id, at.kind
                    ));
                }
            }
        }
    }
    // Every MCP tool, aimed the same ways: the victim's project, the victim's project under the
    // attacker's company, and the attacker's own project under the victim's company.
    let mut tools_tried = BTreeSet::new();
    for tool in MCP_TOOLS {
        for at in attacks.iter().filter(|at| at.kind != Kind::OwnProject) {
            let mut args = json!({"company": at.company, "project": at.project});
            if *tool == "search_context" {
                args["query"] = json!("refunds");
            }
            let (status, resp) = w.tool(Some(&at.who.token), tool, args).await;
            calls += 1;
            tools_tried.insert(*tool);
            if mcp_succeeded(status, &resp) {
                leaks.push(format!(
                    "{} ({:?}) mcp {tool} {}/{} -> {resp}",
                    at.who.id, at.kind, at.company, at.project
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
    assert_eq!(tools_tried.len(), MCP_TOOLS.len(), "every MCP tool was attacked");
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
    // Today and me show only the caller's own projects and organisation.
    for (t, own_tenant_companies) in [(&a, vec![&a.company, &b.company]), (&c, vec![&c.company])] {
        for who in [&t.lead, &t.engineer, &t.assignee, &t.admin] {
            let today = w.ok(who, "GET", "/v1/today", None, StatusCode::OK).await;
            for item in today["items"].as_array().unwrap() {
                let company = item["company"]["id"].as_str().unwrap();
                assert!(
                    own_tenant_companies.iter().any(|c| c.as_str() == company),
                    "{} sees {item}",
                    who.id
                );
                if who.id == t.assignee.id {
                    assert_eq!(
                        item["project"]["id"],
                        t.project.as_str(),
                        "an assignee sees their project only"
                    );
                }
            }
            let me = w.ok(who, "GET", "/v1/me", None, StatusCode::OK).await;
            assert_eq!(me["organisation"]["id"], t.org.as_str());
        }
    }

    // An admin sees every company of their own tenant and none of another's.
    for (admin, own, others) in [
        (&a.admin, vec![&a.company, &b.company], vec![&c.company]),
        (&c.admin, vec![&c.company], vec![&a.company, &b.company]),
    ] {
        let list = w.ok(admin, "GET", "/v1/companies", None, StatusCode::OK).await;
        let seen: BTreeSet<&str> = ids(&list).into_iter().collect();
        assert_eq!(
            seen,
            own.iter().map(|c| c.as_str()).collect(),
            "{} sees {list}",
            admin.id
        );
        assert!(others.iter().all(|o| !seen.contains(o.as_str())));
    }
    let answers = w.ok(&c.lead, "GET", "/v1/security-answers", None, StatusCode::OK).await;
    assert_eq!(ids(&answers), [c.record("{answer}")], "only the tenant's own answers");
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
    for who in [&a.lead, &b.lead, &a.admin] {
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
    let stakeholder = t.record("{stakeholder}").to_owned();

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

    // The company setup signed version 2 and changed the scope after; a further change bumps the
    // version again and a new sign-off covers it.
    let scope = w.ok(eng, "GET", &format!("{p}/scope"), None, StatusCode::OK).await;
    assert_eq!(
        (
            scope["version"].as_u64(),
            scope["sign_off"]["version"].as_u64(),
            scope["signed_off"].as_bool()
        ),
        (Some(3), Some(2), Some(false))
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
        (Some(4), Some(false))
    );
    assert_eq!(scope["items"][2]["kind"], "out");
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
    assert_eq!(signed["version"], 4);
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
            (4, "item_added"),
            (4, "signed_off"),
            (5, "item_removed")
        ]
    );
    // Each change keeps what it set, so a signed version can be read back after later changes.
    let signed = &changes[5]["content"];
    assert_eq!(signed["stakeholder"], stakeholder.as_str());
    let descriptions: Vec<&str> = signed["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["description"].as_str().unwrap())
        .collect();
    assert_eq!(descriptions, ["Tier-1 tickets", "Escalations", "Voice"]);
    assert_eq!(signed["criteria"][0]["metric"], "accuracy");
    assert_eq!(
        changes[6]["content"]["description"], "Voice",
        "a removal keeps what was removed"
    );

    // An assignee reads the company's stakeholders and systems through the project, to sign off
    // and name owners, but not through the company, which they do not work on.
    let listed = w
        .ok(asg, "GET", &format!("{p}/stakeholders"), None, StatusCode::OK)
        .await;
    assert!(ids(&listed).contains(&stakeholder.as_str()));
    let systems = w.ok(asg, "GET", &format!("{p}/systems"), None, StatusCode::OK).await;
    assert_eq!(ids(&systems), [t.record("{system}")]);
    for path in [format!("{base}/stakeholders"), format!("{base}/systems")] {
        assert_eq!(w.status(asg, "GET", &path, None).await, StatusCode::FORBIDDEN, "{path}");
    }
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

    // Access requests start open: one created settled would never report its change.
    let (status, body) = w
        .call(
            Some(&eng.token),
            "POST",
            &format!("{p}/access-requests"),
            Some(json!({"description": "VPN", "status": "granted"})),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("rejected_initial_status"))
    );

    // Access requests: owner at the customer, status changes published, days waiting.
    let access = format!("{p}/access-requests/{}", t.record("{access_request}"));
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
    let task = format!("{p}/tasks/{}", t.record("{task}"));
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
            "fde.document.uploaded.v1",
            "fde.project.stage-changed.v1",
            "fde.project.stage-changed.v1",
            "fde.scope.signed-off.v1",
            "fde.access-request.status-changed.v1",
        ]
    );
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn every_documented_route_is_served() {
    let w = world().await;
    // Without a token every route answers 401 (sign-in and sign-out something else of their own); a
    // route the router lacked would answer 404 or 405.
    for (method, template) in spec_routes() {
        let path = template.replace('{', "x").replace('}', "");
        let (status, _) = w.call(None, &method, &path, Some(json!({}))).await;
        let want = match template.as_str() {
            "/auth/login" => StatusCode::FOUND,
            "/auth/callback" => StatusCode::BAD_REQUEST,
            "/auth/logout" => StatusCode::NO_CONTENT,
            _ => StatusCode::UNAUTHORIZED,
        };
        assert_eq!(status, want, "{method} {template}");
    }
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_grant_left_pending_after_commit_is_written_by_the_reconciler() {
    use oryxa_core::{TenantId, UserId};
    use oryxa_fde_core::{CompanyId, CompanyScope};
    use oryxa_fde_store::{Actor, CompanyIn, Name};

    let w = world().await;
    let org = new_id("org");
    let alice = user(&org, "alice", "member");
    // A company that committed while SpiceDB was down: its row is there, its grants are not.
    let c = CompanyScope::new(TenantId::new(&org).unwrap(), CompanyId::new(new_id("cmp")).unwrap());
    let by = Actor {
        user: UserId::new(&alice.id).unwrap(),
        request_id: new_id("req"),
    };
    let mut tx = w.store.company(&c).await.unwrap();
    let v = CompanyIn {
        name: Name::new("Acme").unwrap(),
        industry: None,
        region: None,
        summary: None,
    };
    tx.create(&v, &by).await.unwrap();
    tx.commit().await.unwrap();
    let path = format!("/v1/companies/{}", c.company);
    assert_eq!(w.status(&alice, "GET", &path, None).await, StatusCode::FORBIDDEN);

    // Pending grants of other tests come first; run until none is left.
    for _ in 0..100 {
        if reconcile_grants(&w.app).await.unwrap() == 0 {
            break;
        }
    }
    w.ok(&alice, "GET", &path, None, StatusCode::OK).await;
    let listed = w.ok(&alice, "GET", "/v1/companies", None, StatusCode::OK).await;
    assert_eq!(ids(&listed), [c.company.as_str()]);
    // Written once: nothing of it is pending any more.
    assert_eq!(reconcile_grants(&w.app).await.unwrap(), 0);
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_demoted_admin_changes_nothing_on_any_replica() {
    let w = world().await;
    let other = w.replica();
    let org = new_id("org");
    let alice = user(&org, "alice", "member");
    let created = w
        .ok(
            &alice,
            "POST",
            "/v1/companies",
            Some(json!({"name": "Acme"})),
            StatusCode::CREATED,
        )
        .await;
    let company = format!("/v1/companies/{}", created["id"].as_str().unwrap());
    let dana = format!("user_dana_{}", new_id("u"));
    let (member, admin) = (
        support::token(Some(&org), &dana, "member"),
        support::token(Some(&org), &dana, "admin"),
    );
    let rename = || Some(json!({"name": "Renamed"}));

    // The other replica mirrors Dana as a member first.
    let (status, _) = w.call_on(&other, Some(&member), "GET", "/v1/companies", None).await;
    assert_eq!(status, StatusCode::OK);
    // Promoted, Dana manages every company of the organisation, here through this replica.
    let (status, _) = w.call(Some(&admin), "PATCH", &company, rename()).await;
    assert_eq!(status, StatusCode::OK);
    // Demoted: the other replica's last mirror says member already, but a change re-mirrors it.
    let (status, _) = w.call_on(&other, Some(&member), "PATCH", &company, rename()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = w.call(Some(&member), "GET", &company, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn browser_sign_in_sets_a_session_that_works_like_a_bearer_token() {
    use std::sync::atomic::Ordering;
    let w = world().await;
    let org = new_id("org");
    let alice = user(&org, "alice", "member");

    // Login sends the browser to AuthKit and keeps the sign-in in a sealed, host-only cookie.
    let (status, headers, _) = w
        .send(
            Request::get("/auth/login?return_to=/companies")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::FOUND);
    assert!(
        headers["location"]
            .to_str()
            .unwrap()
            .starts_with("https://auth.fake/authorize?state=")
    );
    assert!(
        headers["location"]
            .to_str()
            .unwrap()
            .contains("redirect_uri=https://fde.test/auth/callback")
    );
    let cookie = headers["set-cookie"].to_str().unwrap();
    assert!(cookie.starts_with("__Host-fde_signin=") && cookie.contains("Secure; HttpOnly; SameSite=Lax"));

    // The callback sets the session and returns to where sign-in started.
    let (status, headers, _) = w.sign_in_as(Some(&org), &alice.id, "member").await;
    assert_eq!(
        (status, headers["location"].to_str().unwrap()),
        (StatusCode::FOUND, "/companies")
    );
    let session = set_cookie(&headers, "__Host-fde_session").unwrap();
    assert_eq!(
        set_cookie(&headers, "__Host-fde_signin").as_deref(),
        Some(""),
        "the sign-in cookie is cleared"
    );

    // Reads need nothing more; changes need the web app's headers.
    let (status, _, me) = w.with_cookie(&session, "GET", "/v1/me", None, false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        me["user"],
        json!({"id": alice.id, "name": format!("Name of {}", alice.id)})
    );
    assert_eq!(
        (me["organisation"]["id"].as_str(), me["role"].as_str()),
        (Some(org.as_str()), Some("member"))
    );
    let create = || Some(json!({"name": "Acme"}));
    let (status, _, body) = w.with_cookie(&session, "POST", "/v1/companies", create(), false).await;
    assert_eq!((status, body["error"].as_str()), (StatusCode::FORBIDDEN, Some("csrf")));
    for (header, value) in [("x-oryxa-request", "1"), ("origin", WEB)] {
        // One of the two alone is not enough.
        let req = Request::post("/v1/companies")
            .header("cookie", format!("__Host-fde_session={session}"))
            .header(header, value)
            .header("content-type", "application/json")
            .body(Body::from(json!({"name": "Acme"}).to_string()))
            .unwrap();
        assert_eq!(w.send(req).await.0, StatusCode::FORBIDDEN, "{header} alone");
    }
    let req = Request::post("/v1/companies")
        .header("cookie", format!("__Host-fde_session={session}"))
        .header("x-oryxa-request", "1")
        .header("origin", "https://evil.example")
        .header("content-type", "application/json")
        .body(Body::from(json!({"name": "Acme"}).to_string()))
        .unwrap();
    assert_eq!(w.send(req).await.0, StatusCode::FORBIDDEN, "another origin");
    let (status, _, created) = w.with_cookie(&session, "POST", "/v1/companies", create(), true).await;
    assert_eq!(status, StatusCode::CREATED);
    let company = format!("/v1/companies/{}", created["id"].as_str().unwrap());
    // The same permissions as the bearer token: alice leads it, bob cannot see it.
    w.ok(&alice, "GET", &company, None, StatusCode::OK).await;
    let bob = user(&org, "bob", "member");
    let bob_session = w.session(&bob, &org).await;
    assert_eq!(
        w.with_cookie(&bob_session, "GET", &company, None, false).await.0,
        StatusCode::FORBIDDEN
    );
    // A bearer token wins over a cookie, and needs no web headers.
    let req = Request::get(&company)
        .header("authorization", format!("Bearer {}", alice.token))
        .header("cookie", format!("__Host-fde_session={bob_session}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(w.send(req).await.0, StatusCode::OK);

    // An expired access token is refreshed through AuthKit and the cookie reissued.
    let sealed = |access: String, signed_in: u64| {
        let s = json!({
            "purpose": "fde_session", "access_token": access, "refresh_token": format!("refresh|{org}|{}|member", alice.id),
            "user": alice.id, "organisation": org, "signed_in": signed_in,
        });
        workos::helpers::session::seal(&s, &w.password).unwrap()
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let expired = || support::token_for(Some(&org), &alice.id, "member", -3600);
    let stale = sealed(expired(), now - 3600);
    let (status, headers, _) = w.with_cookie(&stale, "GET", &company, None, false).await;
    assert_eq!(status, StatusCode::OK);
    let renewed = set_cookie(&headers, "__Host-fde_session").unwrap();
    assert!(!renewed.is_empty() && renewed != stale);
    assert_eq!(
        w.with_cookie(&renewed, "GET", &company, None, false).await.0,
        StatusCode::OK
    );
    // A refresh AuthKit refuses ends the session.
    w.authkit.refresh_fails.store(true, Ordering::SeqCst);
    let (status, headers, _) = w.with_cookie(&stale, "GET", &company, None, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        set_cookie(&headers, "__Host-fde_session").as_deref(),
        Some(""),
        "and clears the cookie"
    );
    w.authkit.refresh_fails.store(false, Ordering::SeqCst);

    // A tampered cookie, one sealed with another key, or a session past its week: refused.
    let mut tampered = session.clone().into_bytes();
    let i = tampered.len() / 2;
    tampered[i] = if tampered[i] == b'A' { b'B' } else { b'A' };
    let tampered = String::from_utf8(tampered).unwrap();
    let old = sealed(alice.token.clone(), now - 8 * 24 * 3600);
    let foreign = workos::helpers::session::seal(&json!({"purpose": "fde_session"}), &"0".repeat(64)).unwrap();
    // Another user's token inside a session sealed for alice.
    let swapped = sealed(support::token(Some(&org), &bob.id, "member"), now);
    for bad in [tampered, old, foreign, swapped, "garbage".into()] {
        let (status, headers, _) = w.with_cookie(&bad, "GET", "/v1/me", None, false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{bad}");
        assert_eq!(set_cookie(&headers, "__Host-fde_session").as_deref(), Some(""));
    }

    // Logout ends the WorkOS session and clears the cookie; without a session there is nothing to end.
    let (status, headers, _) = w.with_cookie(&session, "POST", "/auth/logout", None, true).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(set_cookie(&headers, "__Host-fde_session").as_deref(), Some(""));
    assert_eq!(
        w.authkit.revoked.lock().unwrap().last().map(String::as_str),
        Some("session_1")
    );
    let (status, _, _) = w.with_cookie(&session, "POST", "/auth/logout", None, false).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "logout is a change: it needs the web headers too"
    );
    // Without a session there is nothing to revoke, and the cookie is cleared all the same.
    let (status, headers, _) = w.send(Request::post("/auth/logout").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(set_cookie(&headers, "__Host-fde_session").as_deref(), Some(""));
}

/// Every `Set-Cookie` of a response, as sent.
fn set_cookies(headers: &axum::http::HeaderMap) -> Vec<String> {
    headers
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn logout_always_clears_the_session_with_one_cookie_and_never_refreshes() {
    use std::sync::atomic::Ordering;
    let w = world().await;
    let org = new_id("org");
    let alice = user(&org, "alice", "member");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // A session whose access token expired an hour ago, sealed with `password`.
    let expired = |password: &str| {
        let s = json!({
            "purpose": "fde_session",
            "access_token": support::token_for(Some(&org), &alice.id, "member", -3600),
            "refresh_token": format!("refresh|{org}|{}|member", alice.id),
            "user": alice.id, "organisation": org, "session_id": "session_1", "signed_in": now - 60,
        });
        workos::helpers::session::seal(&s, password).unwrap()
    };
    let logout = |router: Router, cookie: String| async move {
        let req = Request::post("/auth/logout")
            .header("cookie", format!("__Host-fde_session={cookie}"))
            .header("x-oryxa-request", "1")
            .header("origin", WEB)
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        (resp.status(), set_cookies(resp.headers()))
    };
    let cleared = vec!["__Host-fde_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax".to_owned()];

    // WorkOS down: no refresh is tried, the revoke fails, and the browser is signed out anyway.
    w.authkit.refresh_unavailable.store(true, Ordering::SeqCst);
    w.authkit.revoke_fails.store(true, Ordering::SeqCst);
    let (status, cookies) = logout(w.router.clone(), expired(&w.password)).await;
    assert_eq!((status, &cookies), (StatusCode::NO_CONTENT, &cleared));
    assert_eq!(w.authkit.refreshes.load(Ordering::SeqCst), 0);
    w.authkit.refresh_unavailable.store(false, Ordering::SeqCst);
    w.authkit.revoke_fails.store(false, Ordering::SeqCst);

    // An expired access token, WorkOS up: revoked, cleared, and still no refresh or new cookie.
    let (status, cookies) = logout(w.router.clone(), expired(&w.password)).await;
    assert_eq!((status, &cookies), (StatusCode::NO_CONTENT, &cleared));
    assert_eq!(w.authkit.refreshes.load(Ordering::SeqCst), 0);
    assert_eq!(w.authkit.revoked.lock().unwrap().as_slice(), ["session_1"]);

    // A cookie under the previous key: revoked and cleared, never resealed under the new one.
    let rotating = router(App::with_sign_in(
        w.store.clone(),
        w.authz.clone(),
        support::verifier(),
        w.context.clone(),
        SignIn::new(WEB, "c".repeat(64), w.authkit.clone())
            .unwrap()
            .with_previous_password(w.password.clone())
            .unwrap(),
    ));
    let (status, cookies) = logout(rotating, expired(&w.password)).await;
    assert_eq!((status, &cookies), (StatusCode::NO_CONTENT, &cleared));
    assert_eq!(w.authkit.revoked.lock().unwrap().len(), 2);
    assert_eq!(w.authkit.refreshes.load(Ordering::SeqCst), 0);
}

/// Starts a sign-in: its state and its sign-in cookie.
async fn start_sign_in(w: &World) -> (String, String) {
    let (_, headers, _) = w.send(Request::get("/auth/login").body(Body::empty()).unwrap()).await;
    let location = headers["location"].to_str().unwrap().to_owned();
    let state = location
        .split("state=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_owned();
    (state, set_cookie(&headers, "__Host-fde_signin").unwrap())
}

/// Whether an MCP call returned data: HTTP 200 and a result that is not a tool error.
fn mcp_succeeded(status: StatusCode, resp: &Value) -> bool {
    status == StatusCode::OK && resp["result"]["isError"] == json!(false)
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn sign_in_refuses_bad_return_paths_states_and_codes() {
    let w = world().await;
    let org = new_id("org");
    for bad in [
        "//evil.example",
        "/%09/evil.example",
        "https://evil.example",
        "/\\\\evil",
        "companies",
    ] {
        let path = format!("/auth/login?return_to={bad}");
        let (status, _, body) = w.send(Request::get(&path).body(Body::empty()).unwrap()).await;
        // %09 decodes to a tab, which is refused like the rest.
        assert_eq!(
            (status, body["error"].as_str()),
            (StatusCode::BAD_REQUEST, Some("invalid_return_to")),
            "{bad}"
        );
    }
    // A callback with no sign-in in progress, or another sign-in's state or code.
    let (status, _, body) = w
        .send(
            Request::get("/auth/callback?code=code-x&state=x")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_sign_in"))
    );
    let (state, pending) = start_sign_in(&w).await;
    let (other_state, _) = start_sign_in(&w).await;
    *w.authkit.who.lock().unwrap() = (Some(org.clone()), "user_x".into(), "member".into());
    for (code, st, want) in [
        (format!("code-{state}"), other_state.clone(), "invalid_state"),
        // The code of the other sign-in: its PKCE verifier is not this one's.
        (format!("code-{other_state}"), state.clone(), "unauthorized"),
    ] {
        let req = Request::get(format!("/auth/callback?code={code}&state={st}"))
            .header("cookie", format!("__Host-fde_signin={pending}"))
            .body(Body::empty())
            .unwrap();
        let (status, _, body) = w.send(req).await;
        assert!(status.is_client_error(), "{want}: {status}");
        assert_eq!(body["error"], want);
    }
    // A user who signed in without picking an organisation gets no session.
    let (status, headers, body) = w.sign_in_as(None, "user_y", "member").await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::FORBIDDEN, Some("no_organisation"))
    );
    assert_eq!(set_cookie(&headers, "__Host-fde_session"), None);
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn screens_get_their_fields_and_today_in_one_call() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "acme").await;
    let (lead, asg) = (&t.lead, &t.assignee);
    let base = format!("/v1/companies/{}", t.company);
    let p = format!("{base}/projects/{}", t.project);

    // Company and project fields; PATCH changes what it names, `null` clears.
    let patched = w
        .ok(
            lead,
            "PATCH",
            &base,
            Some(json!({"industry": "Insurance", "region": "UK", "summary": "Claims automation"})),
            StatusCode::OK,
        )
        .await;
    assert_eq!(
        (patched["name"].as_str(), patched["industry"].as_str()),
        (Some("acme"), Some("Insurance"))
    );
    let patched = w
        .ok(lead, "PATCH", &base, Some(json!({"region": null})), StatusCode::OK)
        .await;
    assert_eq!(
        (patched["region"].clone(), patched["industry"].as_str()),
        (Value::Null, Some("Insurance"))
    );
    let (status, _) = w
        .call(Some(&lead.token), "PATCH", &base, Some(json!({"industry": ""})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let project = w
        .ok(
            asg,
            "PATCH",
            &p,
            Some(json!({"summary": "Tier-1 support bot"})),
            StatusCode::OK,
        )
        .await;
    assert_eq!(
        (project["summary"].as_str(), project["name"].as_str()),
        (Some("Tier-1 support bot"), Some("acme"))
    );

    // Stakeholder role and system kind.
    let s = w
        .ok(
            lead,
            "POST",
            &format!("{base}/stakeholders"),
            Some(json!({"name": "Ana", "role": "sponsor"})),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(s["role"], "sponsor");
    let (status, _) = w
        .call(
            Some(&lead.token),
            "POST",
            &format!("{base}/stakeholders"),
            Some(json!({"name": "X", "role": "boss"})),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let sys = w
        .ok(
            lead,
            "POST",
            &format!("{base}/systems"),
            Some(json!({"name": "Guidewire", "kind": "Policy admin"})),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(sys["kind"], "Policy admin");

    // Task due date, assignee and what it waits on.
    let task = w
        .ok(
            asg,
            "POST",
            &format!("{p}/tasks"),
            Some(
                json!({"title": "Claims export", "status": "waiting_on_customer", "due_on": "2026-11-20",
                "assignee": asg.id, "waiting_on": s["id"]}),
            ),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(
        (
            task["due_on"].as_str(),
            task["assignee"].as_str(),
            task["waiting_on"].as_str()
        ),
        (Some("2026-11-20"), Some(asg.id.as_str()), s["id"].as_str())
    );
    assert!(task["waiting_since"].is_string());
    let (status, body) = w
        .call(
            Some(&asg.token),
            "POST",
            &format!("{p}/tasks"),
            Some(json!({"title": "x", "status": "todo", "due_on": "20 Nov"})),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_due_on"))
    );

    // The company list carries the caller's role and the project summaries.
    let list = w.ok(lead, "GET", "/v1/companies", None, StatusCode::OK).await;
    assert_eq!(
        (list[0]["role"].as_str(), list[0]["industry"].as_str()),
        (Some("lead"), Some("Insurance"))
    );
    assert_eq!(
        list[0]["projects"][0],
        json!({"id": t.project, "name": "acme", "stage": "discover"})
    );
    let list = w.ok(&t.engineer, "GET", "/v1/companies", None, StatusCode::OK).await;
    assert_eq!(list[0]["role"], "engineer");
    let list = w.ok(&t.admin, "GET", "/v1/companies", None, StatusCode::OK).await;
    assert_eq!(list[0]["role"], "admin");

    // Today: the open tasks and the unsettled request across the caller's projects, with names.
    let today = w.ok(asg, "GET", "/v1/today", None, StatusCode::OK).await;
    let kinds: Vec<(&str, &str)> = today["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            let title = i["task"]["title"]
                .as_str()
                .or(i["access"]["description"].as_str())
                .unwrap();
            (i["kind"].as_str().unwrap(), title)
        })
        .collect();
    assert_eq!(
        kinds,
        [
            ("task", "Index tickets"),
            ("task", "Claims export"),
            ("access_request", "API token")
        ]
    );
    let item = &today["items"][2];
    assert_eq!(
        (
            item["owner"].as_str(),
            item["company"]["name"].as_str(),
            item["project"]["name"].as_str()
        ),
        (Some("Pat"), Some("acme"), Some("acme"))
    );
    // Someone in the organisation with no projects has nothing today.
    let other = user(&org, "other", "member");
    let today = w.ok(&other, "GET", "/v1/today", None, StatusCode::OK).await;
    assert_eq!(today["items"], json!([]));
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn mcp_tools_read_one_project_for_whoever_works_on_it() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "acme").await;
    let args = json!({"company": t.company, "project": t.project});

    // An assignee, who works on this one project, can use every tool.
    let (status, resp) = w.tool(Some(&t.assignee.token), "get_scope", args.clone()).await;
    assert!(mcp_succeeded(status, &resp), "{resp}");
    let scope = &resp["result"]["structuredContent"]["scope"];
    assert_eq!(
        (scope["version"].as_u64(), scope["items"][0]["description"].as_str()),
        (Some(3), Some("Tier-1 tickets"))
    );
    let (_, resp) = w.tool(Some(&t.assignee.token), "list_decisions", args.clone()).await;
    assert_eq!(
        resp["result"]["structuredContent"]["decisions"][0]["title"],
        "Use Bedrock"
    );
    let (_, resp) = w.tool(Some(&t.assignee.token), "list_tasks", args.clone()).await;
    assert_eq!(
        resp["result"]["structuredContent"]["tasks"][0]["title"],
        "Index tickets"
    );
    assert_eq!(resp["result"]["structuredContent"]["next"], Value::Null);
    // The lists are paged: one more task makes two pages of one, joined by `next`.
    let tasks = format!("/v1/companies/{}/projects/{}/tasks", t.company, t.project);
    let body = Some(json!({"title": "Second task", "status": "todo"}));
    w.ok(&t.lead, "POST", &tasks, body, StatusCode::CREATED).await;
    let mut paged = args.clone();
    paged["limit"] = json!(1);
    let (_, resp) = w.tool(Some(&t.assignee.token), "list_tasks", paged.clone()).await;
    let first = &resp["result"]["structuredContent"];
    assert_eq!(
        (
            first["tasks"][0]["title"].as_str(),
            first["tasks"].as_array().unwrap().len()
        ),
        (Some("Index tickets"), 1)
    );
    paged["after"] = first["next"].clone();
    let (_, resp) = w.tool(Some(&t.assignee.token), "list_tasks", paged.clone()).await;
    let second = &resp["result"]["structuredContent"];
    assert_eq!(second["tasks"][0]["title"], "Second task");
    assert_eq!(second["next"], Value::Null);
    // A cursor that is not one of this project's tasks, or not an id at all, reads nothing.
    for bad in [json!(new_id("tsk")), json!("a|b")] {
        paged["after"] = bad;
        let (status, resp) = w.tool(Some(&t.assignee.token), "list_tasks", paged.clone()).await;
        assert!(!mcp_succeeded(status, &resp), "{resp}");
        assert_eq!(resp["result"]["content"][0]["text"], "invalid_after");
    }
    let mut decisions = args.clone();
    decisions["limit"] = json!(1);
    let (_, resp) = w.tool(Some(&t.assignee.token), "list_decisions", decisions).await;
    assert_eq!(resp["result"]["structuredContent"]["next"], Value::Null);
    // Company documents need work on the company: the engineer searches them, the assignee cannot.
    let mut search = args.clone();
    search["query"] = json!("who approves refunds?");
    let (status, resp) = w.tool(Some(&t.engineer.token), "search_context", search.clone()).await;
    assert!(mcp_succeeded(status, &resp), "{resp}");
    let hits = &resp["result"]["structuredContent"]["results"];
    assert_eq!(hits[0]["document"], t.record("{document}"));
    assert!(hits[0]["text"].as_str().unwrap().contains("refunds over 500"));

    // Only the four read-only tools exist.
    let list = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"});
    let req = Request::builder()
        .method("POST")
        .uri(oryxa_fde_mcp::PATH)
        .header("host", "localhost")
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("authorization", format!("Bearer {}", t.assignee.token))
        .body(Body::from(list.to_string()))
        .unwrap();
    let resp = w.mcp.clone().oneshot(req).await.unwrap();
    let body: Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let names: BTreeSet<&str> = body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        BTreeSet::from(["get_scope", "list_decisions", "list_tasks", "search_context"])
    );

    // No token, a bad one, or bad input: refused, and no data.
    assert_eq!(
        w.tool(None, "get_scope", args.clone()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        w.tool(Some("not.a.jwt"), "get_scope", args.clone()).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, resp) = w
        .tool(
            Some(&t.lead.token),
            "get_scope",
            json!({"company": "a|b", "project": t.project}),
        )
        .await;
    assert!(!mcp_succeeded(status, &resp), "{resp}");
    let mut empty = search.clone();
    empty["query"] = json!("");
    let (status, resp) = w.tool(Some(&t.lead.token), "search_context", empty).await;
    assert!(!mcp_succeeded(status, &resp), "{resp}");
    // Someone else in the organisation who is not on the project.
    let other = user(&org, "other", "member");
    let (status, resp) = w.tool(Some(&other.token), "list_tasks", args).await;
    assert!(!mcp_succeeded(status, &resp));
    assert_eq!(resp["result"]["content"][0]["text"], "forbidden");
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_workos_outage_does_not_sign_anyone_out() {
    use std::sync::atomic::Ordering;
    let w = world().await;
    let org = new_id("org");
    let alice = user(&org, "alice", "member");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let stale = |password: &str| {
        let s = json!({
            "purpose": "fde_session",
            "access_token": support::token_for(Some(&org), &alice.id, "member", -3600),
            "refresh_token": format!("refresh|{org}|{}|member", alice.id),
            "user": alice.id, "organisation": org, "signed_in": now - 60,
        });
        workos::helpers::session::seal(&s, password).unwrap()
    };

    // WorkOS cannot refresh right now: 503, and the cookie stays for the next try.
    w.authkit.refresh_unavailable.store(true, Ordering::SeqCst);
    let cookie = stale(&w.password);
    let (status, headers, body) = w.with_cookie(&cookie, "GET", "/v1/me", None, false).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("unavailable"))
    );
    assert_eq!(set_cookie(&headers, "__Host-fde_session"), None, "the cookie is kept");
    // The session backs off for WorkOS's Retry-After: asked again at once, WorkOS is not called.
    w.authkit.refresh_unavailable.store(false, Ordering::SeqCst);
    let asked = w.authkit.refreshes.load(Ordering::SeqCst);
    let (status, _, _) = w.with_cookie(&cookie, "GET", "/v1/me", None, false).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(w.authkit.refreshes.load(Ordering::SeqCst), asked);
    // Back up, after the wait: the same cookie works and is renewed.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let (status, headers, _) = w.with_cookie(&cookie, "GET", "/v1/me", None, false).await;
    assert_eq!(status, StatusCode::OK);
    assert!(set_cookie(&headers, "__Host-fde_session").is_some_and(|c| !c.is_empty()));
    // WorkOS refuses the refresh token for good: signed out.
    w.authkit.refresh_fails.store(true, Ordering::SeqCst);
    let (status, headers, _) = w.with_cookie(&cookie, "GET", "/v1/me", None, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(set_cookie(&headers, "__Host-fde_session").as_deref(), Some(""));
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_project_assignee_reads_no_company_document_by_any_path() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "acme").await;
    let base = format!("/v1/companies/{}", t.company);
    let paths = [
        format!("{base}/documents"),
        format!("{base}/documents/{}", t.record("{document}")),
        format!("{base}/search?q=refunds"),
        format!("{base}/projects/{}/search?q=refunds", t.project),
    ];
    let mut search = json!({"company": t.company, "project": t.project, "query": "refunds"});
    // The assignee works on the project, but the company's documents are not theirs to read.
    for path in &paths {
        assert_eq!(
            w.status(&t.assignee, "GET", path, None).await,
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    let (status, resp) = w.tool(Some(&t.assignee.token), "search_context", search.clone()).await;
    assert!(!mcp_succeeded(status, &resp), "{resp}");
    assert_eq!(resp["result"]["content"][0]["text"], "forbidden");
    // Everyone who works on the company reads them, on every path.
    for who in [&t.lead, &t.engineer, &t.admin] {
        for path in &paths {
            assert_eq!(
                w.status(who, "GET", path, None).await,
                StatusCode::OK,
                "{} {path}",
                who.id
            );
        }
        let (status, resp) = w.tool(Some(&who.token), "search_context", search.clone()).await;
        assert!(mcp_succeeded(status, &resp), "{resp}");
    }
    // A project of another company under this company is not found, for those who may search.
    search["project"] = json!(new_id("prj"));
    let (status, resp) = w.tool(Some(&t.lead.token), "search_context", search).await;
    assert!(!mcp_succeeded(status, &resp));
    assert_eq!(resp["result"]["content"][0]["text"], "not_found");
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn rotating_the_session_key_keeps_people_signed_in() {
    let w = world().await;
    let org = new_id("org");
    let alice = user(&org, "alice", "member");
    let old_cookie = w.session(&alice, &org).await;

    // The new key seals, the old one is still read: an old cookie works and comes back resealed.
    let new_key = "b".repeat(64);
    let rotating = router(App::with_sign_in(
        w.store.clone(),
        w.authz.clone(),
        support::verifier(),
        w.context.clone(),
        SignIn::new(WEB, new_key.clone(), w.authkit.clone())
            .unwrap()
            .with_previous_password(w.password.clone())
            .unwrap(),
    ));
    let get_me = |cookie: &str| {
        Request::get("/v1/me")
            .header("cookie", format!("__Host-fde_session={cookie}"))
            .body(Body::empty())
            .unwrap()
    };
    let resp = rotating.clone().oneshot(get_me(&old_cookie)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let resealed = set_cookie(resp.headers(), "__Host-fde_session").unwrap();
    assert!(!resealed.is_empty() && resealed != old_cookie);
    // Once the old key is gone, only the resealed cookie works.
    let rotated = router(App::with_sign_in(
        w.store.clone(),
        w.authz.clone(),
        support::verifier(),
        w.context.clone(),
        SignIn::new(WEB, new_key, w.authkit.clone()).unwrap(),
    ));
    assert_eq!(
        rotated.clone().oneshot(get_me(&resealed)).await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(
        rotated.oneshot(get_me(&old_cookie)).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_failed_callback_ends_its_sign_in_and_return_to_is_checked_again() {
    let w = world().await;
    let org = new_id("org");
    *w.authkit.who.lock().unwrap() = (Some(org.clone()), "user_z".into(), "member".into());
    // A sign-in cookie whose return_to is not ours, however it was made, is refused at the callback.
    let (state, _) = start_sign_in(&w).await;
    let forged = json!({
        "purpose": "fde_sign_in", "state": state, "verifier": "v", "return_to": "//evil.example",
        "expires": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() + 600,
    });
    let forged = workos::helpers::session::seal(&forged, &w.password).unwrap();
    let req = Request::get(format!("/auth/callback?code=code-{state}&state={state}"))
        .header("cookie", format!("__Host-fde_signin={forged}"))
        .body(Body::empty())
        .unwrap();
    let (status, headers, body) = w.send(req).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_return_to"))
    );
    assert_eq!(
        set_cookie(&headers, "__Host-fde_signin").as_deref(),
        Some(""),
        "cleared"
    );
    assert_eq!(set_cookie(&headers, "__Host-fde_session"), None);
    // Any failed callback clears its sign-in cookie, a wrong state too.
    let (_, pending) = start_sign_in(&w).await;
    let req = Request::get("/auth/callback?code=code-x&state=wrong")
        .header("cookie", format!("__Host-fde_signin={pending}"))
        .body(Body::empty())
        .unwrap();
    let (status, headers, _) = w.send(req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(set_cookie(&headers, "__Host-fde_signin").as_deref(), Some(""));
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_task_assignee_must_work_on_the_project() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "acme").await;
    let tasks = format!("/v1/companies/{}/projects/{}/tasks", t.company, t.project);
    let task = |assignee: &str| Some(json!({"title": "Export", "status": "todo", "assignee": assignee}));
    // Someone from another tenant, or from this one with no access to the project: refused.
    let stranger = user(&new_id("org"), "stranger", "member");
    let outsider = user(&org, "outsider", "member");
    for who in [&stranger, &outsider] {
        let (status, body) = w.call(Some(&t.lead.token), "POST", &tasks, task(&who.id)).await;
        assert_eq!(
            (status, body["error"].as_str()),
            (StatusCode::BAD_REQUEST, Some("invalid_assignee")),
            "{}",
            who.id
        );
    }
    // The company's engineer and the project's assignee are fine.
    for who in [&t.engineer, &t.assignee] {
        w.ok(&t.lead, "POST", &tasks, task(&who.id), StatusCode::CREATED).await;
    }
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn mcp_calls_are_reads_and_do_not_rewrite_the_role_mirror() {
    let w = world().await;
    let org = new_id("org");
    let alice = user(&org, "alice", "member");
    let created = w
        .ok(
            &alice,
            "POST",
            "/v1/companies",
            Some(json!({"name": "Acme"})),
            StatusCode::CREATED,
        )
        .await;
    let company = format!("/v1/companies/{}", created["id"].as_str().unwrap());
    let dana = user(&org, "dana", "admin");
    let list = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});

    // The first call mirrors Dana's admin role, as any first request does.
    assert_eq!(w.mcp_rpc(&dana.token, &list).await.0, StatusCode::OK);
    // Take the mirror away behind the API's back: only a write to SpiceDB would bring it back.
    let tenant = TenantId::new(&org).unwrap();
    let mirror = oryxa_authz::Relationship {
        resource: oryxa_authz::ObjectRef::new(&tenant, "workspace", "root"),
        relation: "admin",
        subject: oryxa_authz::SubjectRef::object(oryxa_authz::ObjectRef::new(&tenant, "user", &dana.id)),
        caveat: None,
        expires_at: None,
    };
    w.authz
        .write(&tenant, &[oryxa_authz::Write::Delete(mirror)], &[])
        .await
        .unwrap();

    // Every MCP request is a POST, but none of them writes: the mirror stays gone.
    assert_eq!(w.mcp_rpc(&dana.token, &list).await.0, StatusCode::OK);
    assert_eq!(w.status(&dana, "GET", &company, None).await, StatusCode::FORBIDDEN);
    // A real change still re-mirrors the role first.
    let rename = Some(json!({"name": "Renamed"}));
    assert_eq!(w.status(&dana, "PATCH", &company, rename).await, StatusCode::OK);
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn uploads_take_up_to_20_mib_of_a_known_type_and_other_routes_keep_2_mb() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "acme").await;
    let upload = format!("/v1/companies/{}/documents?name=big", t.company);
    let limit = oryxa_fde_context::MAX_DOCUMENT_BYTES;

    let (status, body) = w
        .send_raw(&t.lead.token, "POST", &upload, "text/plain", &vec![b'a'; limit])
        .await;
    assert_eq!(status, StatusCode::CREATED, "exactly 20 MiB: {body}");
    let (status, _) = w
        .send_raw(&t.lead.token, "POST", &upload, "text/plain", &vec![b'a'; limit + 1])
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    for unsupported in ["text/html", "application/zip", "application/octet-stream", ""] {
        let (status, body) = w
            .send_raw(&t.lead.token, "POST", &upload, unsupported, b"<p>hello</p>")
            .await;
        assert_eq!(
            (status, body["error"].as_str()),
            (StatusCode::UNSUPPORTED_MEDIA_TYPE, Some("unsupported_media_type")),
            "{unsupported:?}"
        );
    }
    // Only the upload route takes a large body: a JSON body over axum's 2 MB default is refused.
    let big = json!({"name": "a".repeat(2 * 1024 * 1024)});
    let tasks = format!("/v1/companies/{}/projects/{}/tasks", t.company, t.project);
    for path in ["/v1/companies", tasks.as_str()] {
        assert_eq!(
            w.status(&t.lead, "POST", path, Some(big.clone())).await,
            StatusCode::PAYLOAD_TOO_LARGE,
            "{path}"
        );
    }
    // Refused uploads stored nothing: only the 20 MiB file and the fixture's document are listed.
    let docs = w
        .ok(
            &t.lead,
            "GET",
            &format!("/v1/companies/{}/documents", t.company),
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(docs.as_array().unwrap().len(), 2, "{docs}");
}
