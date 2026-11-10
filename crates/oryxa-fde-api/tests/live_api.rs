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
use oryxa_fde_api::integrations::{GitHubIntegration, Integrations, SlackIntegration};
use oryxa_fde_api::{App, SignIn, openapi, reconcile_grants, router, router_with};
use oryxa_fde_context::Context;
use oryxa_fde_core::{CompanyId, CompanyScope, DocumentId};
use oryxa_fde_integrations::github::WebhookSecret;
use oryxa_fde_integrations::slack::{BotToken, Channel, ChannelId, SigningSecret, TeamId};
use oryxa_fde_integrations::state::StateKey;
use oryxa_fde_integrations::testing::{FakeGitHub, FakeSecrets, FakeSlack};
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
    /// GitHub, Slack and Secrets Manager, faked.
    github: Arc<FakeGitHub>,
    slack: Arc<FakeSlack>,
    secrets: Arc<FakeSecrets>,
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

const WEBHOOK_SECRET: &str = "github-webhook-secret-for-the-tests";
const SIGNING_SECRET: &str = "slack-signing-secret-for-the-tests";

fn integrations(github: &Arc<FakeGitHub>, slack: &Arc<FakeSlack>, secrets: &Arc<FakeSecrets>) -> Integrations {
    let state = || StateKey::new("install-state-key-for-the-tests-0123456789").unwrap();
    Integrations {
        github: Some(GitHubIntegration {
            api: github.clone(),
            webhook: WebhookSecret::new(WEBHOOK_SECRET).unwrap(),
            state: state(),
        }),
        slack: Some(SlackIntegration {
            api: slack.clone(),
            signing: SigningSecret::new(SIGNING_SECRET).unwrap(),
            secrets: secrets.clone(),
            state: state(),
        }),
    }
}

/// The `state` in an install URL.
fn state_of(url: &str) -> String {
    url.split("state=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_owned()
}

/// A fresh GitHub id, unique in this run of the tests.
fn github_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let base = 1_000_000 + u64::from(rand::random::<u32>());
    base * 1000 + NEXT.fetch_add(1, Ordering::SeqCst)
}

fn hmac_hex(secret: &str, parts: &[&[u8]]) -> String {
    use hmac::Mac;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    for p in parts {
        mac.update(p);
    }
    mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
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
    let (github, slack, secrets) = (
        Arc::new(FakeGitHub::default()),
        Arc::new(FakeSlack::default()),
        Arc::new(FakeSecrets::default()),
    );
    let app = App::with_integrations(
        store.clone(),
        authz.clone(),
        support::verifier(),
        context.clone(),
        Some(sign_in_config(&authkit, &password)),
        integrations(&github, &slack, &secrets),
    );

    World {
        router: router(app.clone()),
        github,
        slack,
        secrets,
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
        router(App::with_integrations(
            self.store.clone(),
            self.authz.clone(),
            support::verifier(),
            self.context.clone(),
            Some(sign_in_config(&self.authkit, &self.password)),
            integrations(&self.github, &self.slack, &self.secrets),
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
        let body = body.map(|b| ("application/json", b.to_string().into_bytes()));
        self.with_cookie_body(cookie, method, path, body, same_site).await
    }

    /// [`World::with_cookie`] with any body: its content type and bytes.
    async fn with_cookie_body(
        &self,
        cookie: &str,
        method: &str,
        path: &str,
        body: Option<(&str, Vec<u8>)>,
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
            Some((content_type, bytes)) => req.header("content-type", content_type).body(Body::from(bytes)),
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

/// WorkOS's membership of `id` in an organisation, as the fake lists it.
fn person(id: &str, name: Option<&str>, role: &str) -> oryxa_fde_api::Person {
    oryxa_fde_api::Person {
        id: id.to_owned(),
        name: name.map(str::to_owned),
        role: role.to_owned(),
    }
}

/// `(user, name)` for each row of a member or assignee list.
fn named(list: &Value) -> BTreeSet<(String, Option<String>)> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["user"].as_str().unwrap().to_owned(),
                m["name"].as_str().map(str::to_owned),
            )
        })
        .collect()
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn people_are_named_only_to_those_who_may_see_them() {
    let w = world().await;
    let (org, other_org, down_org) = (new_id("org"), new_id("org"), new_id("org"));
    let (alice, bob, carol, dana, gina) = (
        user(&org, "alice", "member"),
        user(&org, "bob", "member"),
        user(&org, "carol", "member"),
        user(&org, "dana", "admin"),
        user(&org, "gina", "guest"),
    );
    let eve = user(&other_org, "eve", "member");
    w.authkit.people.lock().unwrap().extend([
        (
            org.clone(),
            vec![
                person(&alice.id, Some("alice Archer"), "member"),
                person(&bob.id, None, "member"),
                person(&carol.id, Some("Carol Chen"), "member"),
                person(&dana.id, Some("Dana Doe"), "admin"),
                person(&gina.id, Some("Gina Guest"), "guest"),
            ],
        ),
        (other_org.clone(), vec![person(&eve.id, Some("Eve Other"), "member")]),
    ]);

    // The organisation's own admins and members, by name with the unnamed last; never a guest, never
    // another organisation's people, and no email.
    let people = w.ok(&alice, "GET", "/v1/people", None, StatusCode::OK).await;
    assert_eq!(
        people,
        json!([
            {"id": alice.id, "name": "alice Archer"},
            {"id": carol.id, "name": "Carol Chen"},
            {"id": dana.id, "name": "Dana Doe"},
            {"id": bob.id, "name": null},
        ])
    );
    assert_eq!(w.ok(&dana, "GET", "/v1/people", None, StatusCode::OK).await, people);
    // A guest (and so, later, any customer role) has no `access` to the workspace.
    assert_eq!(w.status(&gina, "GET", "/v1/people", None).await, StatusCode::FORBIDDEN);
    assert_eq!(
        w.ok(&eve, "GET", "/v1/people", None, StatusCode::OK).await,
        json!([{"id": eve.id, "name": "Eve Other"}])
    );

    // A company's members and a project's assignees carry their names to those who work on them.
    let c = w
        .ok(
            &alice,
            "POST",
            "/v1/companies",
            Some(json!({"name": "Acme"})),
            StatusCode::CREATED,
        )
        .await;
    let company = format!("/v1/companies/{}", c["id"].as_str().unwrap());
    for member in [&bob.id, &eve.id] {
        w.ok(
            &alice,
            "PUT",
            &format!("{company}/members/{member}"),
            Some(json!({"role": "engineer"})),
            StatusCode::NO_CONTENT,
        )
        .await;
    }
    let members = w
        .ok(&bob, "GET", &format!("{company}/members"), None, StatusCode::OK)
        .await;
    assert_eq!(
        named(&members),
        BTreeSet::from([
            (alice.id.clone(), Some("alice Archer".into())),
            (bob.id.clone(), None),
            // Another organisation's user is never named here.
            (eve.id.clone(), None),
        ])
    );
    let p = w
        .ok(
            &alice,
            "POST",
            &format!("{company}/projects"),
            Some(json!({"name": "RAG"})),
            StatusCode::CREATED,
        )
        .await;
    let project = format!("{company}/projects/{}", p["id"].as_str().unwrap());
    w.ok(
        &alice,
        "PUT",
        &format!("{project}/assignees/{}", carol.id),
        None,
        StatusCode::NO_CONTENT,
    )
    .await;
    let assignees = w
        .ok(&carol, "GET", &format!("{project}/assignees"), None, StatusCode::OK)
        .await;
    assert_eq!(
        named(&assignees),
        BTreeSet::from([(carol.id.clone(), Some("Carol Chen".into()))])
    );
    assert_eq!(
        w.status(&gina, "GET", &format!("{company}/members"), None).await,
        StatusCode::FORBIDDEN
    );
    let everything = format!("{people}{members}{assignees}");
    assert!(!everything.contains('@'), "no email in any answer: {everything}");
    assert!(!everything.contains("Gina"), "no guest named: {everything}");
    // One WorkOS lookup per organisation, shared by every route.
    assert_eq!(w.authkit.people_lookups.load(std::sync::atomic::Ordering::SeqCst), 2);

    // WorkOS down: the list is unavailable rather than partial, and names drop out of the rest.
    let (lead, member) = (user(&down_org, "lead", "member"), user(&down_org, "member", "member"));
    w.authkit.people_fail.store(true, std::sync::atomic::Ordering::SeqCst);
    let (status, body) = w.call(Some(&lead.token), "GET", "/v1/people", None).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("unavailable"))
    );
    let c = w
        .ok(
            &lead,
            "POST",
            "/v1/companies",
            Some(json!({"name": "Down"})),
            StatusCode::CREATED,
        )
        .await;
    let company = format!("/v1/companies/{}", c["id"].as_str().unwrap());
    w.ok(
        &lead,
        "PUT",
        &format!("{company}/members/{}", member.id),
        Some(json!({"role": "engineer"})),
        StatusCode::NO_CONTENT,
    )
    .await;
    let members = w
        .ok(&lead, "GET", &format!("{company}/members"), None, StatusCode::OK)
        .await;
    assert_eq!(
        named(&members),
        BTreeSet::from([(lead.id.clone(), None), (member.id.clone(), None)])
    );
    w.authkit.people_fail.store(false, std::sync::atomic::Ordering::SeqCst);

    // Names never reach the events.
    let owner = testing::admin().await;
    let payloads: Vec<String> = sqlx::query_scalar("select detail from outbox where tenant_id = $1")
        .bind(&org)
        .fetch_all(&owner)
        .await
        .unwrap();
    assert!(!payloads.is_empty());
    for p in payloads {
        assert!(!p.contains("Archer") && !p.contains("Carol Chen"), "{p}");
    }
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
    // The caller's own organisation's people, under `access` to its workspace.
    ("GET", "/v1/people"),
    // Names nothing: the token is the permission, and only in the caller's own tenant.
    ("POST", "/v1/share-links/redeem"),
    // No sign-in: the token in a digest's link names its one delivery, in its own tenant.
    ("POST", "/v1/digest/unsubscribe"),
    ("GET", "/v1/today"),
    ("GET", "/auth/login"),
    ("GET", "/auth/callback"),
    ("POST", "/auth/logout"),
    // The organisation's own: installs and workspace, under its admins or members.
    ("POST", "/v1/github/install"),
    ("GET", "/v1/github/installations"),
    ("POST", "/v1/github/installations"),
    ("POST", "/v1/slack/install"),
    ("GET", "/v1/slack/installation"),
    ("POST", "/v1/slack/installation"),
    ("DELETE", "/v1/slack/installation"),
    ("GET", "/v1/slack/channels"),
    // No sign-in: signed by GitHub or Slack, routed by what they name.
    ("POST", "/webhooks/github"),
    ("POST", "/webhooks/slack"),
];

/// The targeted saves that check the `version` their caller read: the whole-record `PUT`s and the
/// scope sign-off.
const VERSIONED: &[(&str, &str)] = &[
    ("PUT", "/v1/companies/{company}/stakeholders/{stakeholder}"),
    ("PUT", "/v1/companies/{company}/systems/{system}"),
    ("PUT", "/v1/companies/{company}/projects/{project}/scope/items/{item}"),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/scope/criteria/{criterion}",
    ),
    ("POST", "/v1/companies/{company}/projects/{project}/scope/sign-offs"),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/access-requests/{access_request}",
    ),
    ("PUT", "/v1/companies/{company}/projects/{project}/tasks/{task}"),
];

/// Every route that names a company, project, record or answer, with a body that would succeed if
/// the call were allowed. Placeholders in braces are filled per attack, in the path and the body.
const TARGETED: &[(&str, &str, Option<&str>)] = &[
    ("GET", "/v1/companies/{company}", None),
    ("PATCH", "/v1/companies/{company}", Some(r#"{"name":"pwned"}"#)),
    ("GET", "/v1/companies/{company}/members", None),
    ("GET", "/v1/companies/{company}/export", None),
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
    ("GET", "/v1/companies/{company}/projects/{project}/sponsors", None),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/sponsors/{stakeholder}",
        None,
    ),
    (
        "DELETE",
        "/v1/companies/{company}/projects/{project}/sponsors/{stakeholder}",
        None,
    ),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/stage",
        Some(r#"{"stage":"scope","reason":"pwned"}"#),
    ),
    (
        "GET",
        "/v1/companies/{company}/projects/{project}/stage-checklist",
        None,
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
    ("GET", "/v1/companies/{company}/projects/{project}/activity", None),
    ("GET", "/v1/companies/{company}/projects/{project}/suggestions", None),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/suggestions/{kind}/dismiss",
        None,
    ),
    ("GET", "/v1/companies/{company}/projects/{project}/updates", None),
    ("GET", "/v1/companies/{company}/projects/{project}/updates/{week}", None),
    (
        "PATCH",
        "/v1/companies/{company}/projects/{project}/updates/{week}",
        Some(r#"{"body":"pwned"}"#),
    ),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/updates/{week}/approve",
        None,
    ),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/updates/{week}/discard",
        None,
    ),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/decisions",
        Some(r#"{"title":"pwned","rationale":"x","decided_by":"x"}"#),
    ),
    ("GET", "/v1/companies/{company}/canvas", None),
    (
        "PUT",
        "/v1/companies/{company}/canvas",
        Some(r#"{"base_version":1,"content":{"elements":[]}}"#),
    ),
    ("GET", "/v1/companies/{company}/canvas/versions", None),
    ("GET", "/v1/companies/{company}/canvas/versions/{version}", None),
    ("GET", "/v1/companies/{company}/canvas/links", None),
    (
        "PUT",
        "/v1/companies/{company}/canvas/shapes/{shape}/link",
        Some(r#"{"kind":"stakeholder","id":"{stakeholder}"}"#),
    ),
    ("DELETE", "/v1/companies/{company}/canvas/shapes/{shape}/link", None),
    ("GET", "/v1/companies/{company}/threads", None),
    (
        "POST",
        "/v1/companies/{company}/threads",
        Some(r#"{"subject":{"kind":"stakeholder","id":"{stakeholder}"},"body":"pwned"}"#),
    ),
    ("GET", "/v1/companies/{company}/threads/{thread}", None),
    (
        "POST",
        "/v1/companies/{company}/threads/{thread}/comments",
        Some(r#"{"body":"pwned"}"#),
    ),
    ("GET", "/v1/companies/{company}/meeting-notes", None),
    (
        "POST",
        "/v1/companies/{company}/meeting-notes",
        Some(r#"{"title":"pwned","held_on":"2026-11-02","body":"pwned","stakeholders":["{stakeholder}"]}"#),
    ),
    ("GET", "/v1/companies/{company}/meeting-notes/{note}", None),
    (
        "PUT",
        "/v1/companies/{company}/meeting-notes/{note}",
        Some(r#"{"title":"pwned","held_on":"2026-11-02","body":"pwned","stakeholders":["{stakeholder}"]}"#),
    ),
    ("DELETE", "/v1/companies/{company}/meeting-notes/{note}", None),
    ("GET", "/v1/companies/{company}/projects/{project}/canvas", None),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/canvas",
        Some(r#"{"base_version":1,"content":{"elements":[]}}"#),
    ),
    (
        "GET",
        "/v1/companies/{company}/projects/{project}/canvas/versions",
        None,
    ),
    (
        "GET",
        "/v1/companies/{company}/projects/{project}/canvas/versions/{version}",
        None,
    ),
    ("GET", "/v1/companies/{company}/projects/{project}/canvas/links", None),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/canvas/shapes/{shape}/link",
        Some(r#"{"kind":"access_request","id":"{access_request}"}"#),
    ),
    (
        "DELETE",
        "/v1/companies/{company}/projects/{project}/canvas/shapes/{shape}/link",
        None,
    ),
    ("GET", "/v1/companies/{company}/projects/{project}/threads", None),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/threads",
        Some(r#"{"subject":{"kind":"task","id":"{task}"},"body":"pwned"}"#),
    ),
    (
        "GET",
        "/v1/companies/{company}/projects/{project}/threads/{thread}",
        None,
    ),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/threads/{thread}/comments",
        Some(r#"{"body":"pwned"}"#),
    ),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/threads/{thread}/promote",
        Some(r#"{"title":"pwned","decided_by":"pwned"}"#),
    ),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/threads/{thread}/customer-question",
        Some(r#"{"question":"pwned?"}"#),
    ),
    ("GET", "/v1/companies/{company}/projects/{project}/meeting-notes", None),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/meeting-notes",
        Some(r#"{"title":"pwned","held_on":"2026-11-02","body":"pwned","stakeholders":["{stakeholder}"]}"#),
    ),
    (
        "GET",
        "/v1/companies/{company}/projects/{project}/meeting-notes/{note}",
        None,
    ),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/meeting-notes/{note}",
        Some(r#"{"title":"pwned","held_on":"2026-11-02","body":"pwned","stakeholders":["{stakeholder}"]}"#),
    ),
    (
        "DELETE",
        "/v1/companies/{company}/projects/{project}/meeting-notes/{note}",
        None,
    ),
    (
        "POST",
        "/v1/companies/{company}/projects/{project}/share-links",
        Some("{}"),
    ),
    ("GET", "/v1/companies/{company}/projects/{project}/share-links", None),
    (
        "DELETE",
        "/v1/companies/{company}/projects/{project}/share-links/{link}",
        None,
    ),
    ("GET", "/v1/room/companies/{company}/projects/{project}", None),
    (
        "GET",
        "/v1/companies/{company}/projects/{project}/github/repositories",
        None,
    ),
    (
        "PUT",
        "/v1/companies/{company}/projects/{project}/github/repositories/{repository}",
        Some(r#"{"installation_id":{installation}}"#),
    ),
    (
        "DELETE",
        "/v1/companies/{company}/projects/{project}/github/repositories/{repository}",
        None,
    ),
    ("GET", "/v1/companies/{company}/slack", None),
    (
        "PUT",
        "/v1/companies/{company}/slack",
        Some(r#"{"channel_id":"{channel}"}"#),
    ),
    ("DELETE", "/v1/companies/{company}/slack", None),
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
    "{thread}",
    "{note}",
    "{link}",
    "{repository}",
    "{installation}",
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
    /// A customer person who redeemed `{link}`: a guest of `project`.
    guest: User,
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
    // A customer person: WorkOS role `guest`, no member of the organisation's workspace.
    let guest = user(org, &format!("{name}_guest"), "guest");
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
        json!({"name": "Pat", "title": "Head of Support", "role": "sponsor"}),
    )
    .await;
    // Pat sponsors the project, so its weekly digest goes to them.
    let sponsor = format!("{pbase}/sponsors/{stakeholder}");
    w.ok(&lead, "PUT", &sponsor, None, StatusCode::OK).await;
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
    let made = w
        .ok(
            &lead,
            "POST",
            &format!("{pbase}/share-links"),
            Some(json!({})),
            StatusCode::CREATED,
        )
        .await;
    let link = made["link"]["id"].as_str().unwrap().to_owned();
    let token = made["token"].clone();
    w.ok(
        &guest,
        "POST",
        "/v1/share-links/redeem",
        Some(json!({"token": token})),
        StatusCode::OK,
    )
    .await;
    let mut sessions = Vec::new();
    for (who, role) in [
        (&lead, "member"),
        (&engineer, "member"),
        (&assignee, "member"),
        (&admin, "admin"),
        (&guest, "member"),
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
    // What the lifecycle engine leaves on a project: an activity entry, an open suggestion and a
    // drafted update, written as the engine writes them.
    let scope = CompanyScope::new(TenantId::new(org).unwrap(), CompanyId::new(&company).unwrap())
        .project(oryxa_fde_core::ProjectId::new(&project).unwrap());
    let mut tx = w.store.project(&scope).await.unwrap();
    let run = oryxa_fde_core::EvalRunId::new(new_id("evr")).unwrap();
    tx.record_activity(
        &new_id("evt"),
        &oryxa_fde_store::ActivityIn::EvalRun {
            run: run.clone(),
            passed: 9,
            failed: 1,
        },
        time::OffsetDateTime::now_utc(),
    )
    .await
    .unwrap();
    assert!(
        tx.raise_suggestion(oryxa_fde_store::SuggestionKind::ReadyToDeploy, &run)
            .await
            .unwrap()
    );
    let body = oryxa_fde_store::UpdateBody::new(format!("{name}: done this week")).unwrap();
    assert!(tx.add_update_draft(fixture_week(), &body, "echo").await.unwrap());
    tx.commit().await.unwrap();
    // At the company and at the project: a saved canvas with a linked shape, a thread and a note.
    let mut planning = Vec::new();
    for (at, link, subject) in [
        (
            base.clone(),
            json!({"kind": "stakeholder", "id": stakeholder}),
            json!({"kind": "stakeholder", "id": stakeholder}),
        ),
        (
            pbase.clone(),
            json!({"kind": "access_request", "id": access_request}),
            json!({"kind": "task", "id": task}),
        ),
    ] {
        let canvas = json!({"base_version": 0, "content": {"elements": [{"id": "shape-1"}]}});
        w.ok(&lead, "PUT", &format!("{at}/canvas"), Some(canvas), StatusCode::OK)
            .await;
        let link_path = format!("{at}/canvas/shapes/shape-1/link");
        w.ok(&lead, "PUT", &link_path, Some(link), StatusCode::OK).await;
        let thread = add(
            format!("{at}/threads"),
            json!({"subject": subject, "body": "Who owns this?"}),
        )
        .await;
        let note = json!({"title": "Workshop", "held_on": "2026-11-02", "body": "Refund rules",
            "stakeholders": [stakeholder]});
        let note = add(format!("{at}/meeting-notes"), note).await;
        planning.push((thread, note));
    }
    let [(thread, note), (project_thread, project_note)] = <[_; 2]>::try_from(planning).unwrap();

    // GitHub: the organisation's admin installs the App and claims it; the lead links a repository.
    let (installation, repository) = (github_id(), github_id());
    let started = w.ok(&admin, "POST", "/v1/github/install", None, StatusCode::OK).await;
    let code = new_id("ghc");
    w.github.codes.lock().unwrap().insert(code.clone(), vec![installation]);
    w.github
        .repositories
        .lock()
        .unwrap()
        .insert((installation, repository), format!("{name}/support-rag"));
    let claim =
        json!({"code": code, "installation_id": installation, "state": state_of(started["url"].as_str().unwrap())});
    w.ok(&admin, "POST", "/v1/github/installations", Some(claim), StatusCode::OK)
        .await;
    let repository_link = json!({"installation_id": installation});
    w.ok(
        &lead,
        "PUT",
        &format!("{pbase}/github/repositories/{repository}"),
        Some(repository_link),
        StatusCode::OK,
    )
    .await;
    // Slack: the admin installs the organisation's workspace; the lead links a channel.
    let started = w.ok(&admin, "POST", "/v1/slack/install", None, StatusCode::OK).await;
    let code = new_id("slc");
    let team = TeamId::new(&slack_team(org)).unwrap();
    let token = BotToken::new(format!("xoxb-{org}")).unwrap();
    w.slack.codes.lock().unwrap().insert(code.clone(), (team, token));
    let channel = format!("C{}", github_id());
    w.slack.channels.lock().unwrap().push(Channel {
        id: ChannelId::new(&channel).unwrap(),
        name: name.to_owned(),
        is_member: true,
    });
    let claim = json!({"code": code, "state": state_of(started["url"].as_str().unwrap())});
    w.ok(&admin, "POST", "/v1/slack/installation", Some(claim), StatusCode::OK)
        .await;
    w.ok(
        &lead,
        "PUT",
        &format!("{base}/slack"),
        Some(json!({"channel_id": channel})),
        StatusCode::OK,
    )
    .await;

    Tenant {
        org: org.to_owned(),
        lead,
        engineer,
        assignee,
        admin,
        guest,
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
            ("{week}", fixture_week().to_string()),
            ("{kind}", "ready_to_deploy".into()),
            ("{thread}", thread),
            ("{project_thread}", project_thread),
            ("{note}", note),
            ("{project_note}", project_note),
            // Not records: the same in every company, so they name the victim's only with its path.
            ("{shape}", "shape-1".into()),
            ("{version}", "1".into()),
            ("{link}", link),
            ("{repository}", repository.to_string()),
            ("{installation}", installation.to_string()),
            ("{channel}", channel),
        ],
    }
}

/// The fixture organisation's Slack team.
fn slack_team(org: &str) -> String {
    let digest = <sha2::Sha256 as sha2::Digest>::digest(org.as_bytes());
    format!(
        "T{}",
        digest.iter().take(5).map(|b| format!("{b:02X}")).collect::<String>()
    )
}

/// The week each fixture's drafted update covers.
fn fixture_week() -> time::Date {
    time::macros::date!(2026 - 11 - 02)
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
        format!("{project}/sponsors"),
        format!("{project}/systems"),
        format!("{project}/scope"),
        format!("{project}/scope/changes"),
        format!("{project}/access-requests"),
        format!("{project}/tasks"),
        format!("{project}/decisions"),
        format!("{project}/activity"),
        format!("{project}/suggestions"),
        format!("{project}/updates"),
        format!("{project}/share-links"),
        format!("/v1/room/companies/{}/projects/{}", t.company, t.project),
        "/v1/security-answers".into(),
        format!("{base}/canvas"),
        format!("{base}/canvas/versions"),
        format!("{base}/canvas/links"),
        format!("{base}/threads"),
        format!("{base}/threads/{}", t.record("{thread}")),
        format!("{base}/meeting-notes"),
        format!("{project}/canvas"),
        format!("{project}/canvas/versions"),
        format!("{project}/canvas/links"),
        format!("{project}/threads"),
        format!("{project}/threads/{}", t.record("{project_thread}")),
        format!("{project}/meeting-notes"),
        format!("{project}/github/repositories"),
        format!("{base}/slack"),
        "/v1/github/installations".into(),
        "/v1/slack/installation".into(),
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
        // A project's threads and notes are other records than its company's, under the same names.
        let s = if s.contains("{project}/") {
            s.replace("{thread}", "{project_thread}")
                .replace("{note}", "{project_note}")
        } else {
            s.to_owned()
        };
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
    assert!(
        VERSIONED
            .iter()
            .all(|v| TARGETED.iter().any(|(m, p, b)| (*m, *p) == *v && b.is_some())),
        "every versioned save is a targeted route with a body"
    );

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
        for who in [&own.lead, &own.engineer, &own.assignee, &own.admin, &own.guest] {
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
            // Versions start at 1, so 0 is always stale: a version check run before the tenant and
            // company filter would answer 409 with the victim's record as `current`.
            if let Some(mut stale) = body.clone().filter(|_| VERSIONED.contains(&(*method, *template))) {
                stale["version"] = json!(0);
                // The task save refuses the victim's stakeholder as `waiting_on` (400) before it looks
                // the task up, so without it the call reaches the lookup and the version check.
                if let Some(fields) = stale.as_object_mut() {
                    fields.remove("waiting_on");
                }
                let (status, resp) = w.call(Some(&at.who.token), method, &path, Some(stale)).await;
                calls += 1;
                let refused =
                    matches!(status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND) && resp.get("current").is_none();
                // A sign-off in the attacker's own project rightly answers stale, with that project's own scope.
                let own_scope = at.kind == Kind::OwnProject
                    && template.ends_with("/sign-offs")
                    && status == StatusCode::CONFLICT
                    && resp["current"]
                        == w.call(
                            Some(&at.who.token),
                            "GET",
                            &at.fill("/v1/companies/{company}/projects/{project}/scope"),
                            None,
                        )
                        .await
                        .1;
                if !refused && !own_scope {
                    leaks.push(format!(
                        "{} ({:?}, version 0) {method} {path} -> {status} {resp}",
                        at.who.id, at.kind
                    ));
                }
            }
            if matches!(at.kind, Kind::Victim | Kind::OwnProjectInVictimCompany) {
                let body = match raw {
                    Some(raw) => Some(("text/plain", raw.as_bytes().to_vec())),
                    None => body.map(|b| ("application/json", b.to_string().into_bytes())),
                };
                let (status, _, resp) = w.with_cookie_body(&cookie_of(at.who), method, &path, body, true).await;
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
    // The same cookie upload works where it is allowed, so the refusals above are the API's.
    let own = format!("/v1/companies/{}/documents?name=ours", a.company);
    let upload = Some(("text/plain", b"our runbook".to_vec()));
    let (status, _, body) = w
        .with_cookie_body(&cookie_of(&a.lead), "POST", &own, upload, true)
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
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
    // The setup named stakeholders and wrote a project note, so discover has nothing open and the
    // move behaves as it always did.
    let checklist = w
        .ok(eng, "GET", &format!("{p}/stage-checklist"), None, StatusCode::OK)
        .await;
    assert_eq!(
        checklist,
        json!({"stage": "discover", "items": [
            {"key": "stakeholders_named", "label": "Stakeholders named", "met": true},
            {"key": "discovery_notes", "label": "A meeting note on the project", "met": true},
        ]})
    );
    let moved = w
        .ok(asg, "PUT", &stage, Some(json!({"stage": "scope"})), StatusCode::OK)
        .await;
    assert_eq!(moved["stage"], "scope");
    // The scope changed after its sign-off and lists nothing out of scope: moving on needs a
    // reason, which the audit log keeps with the open items.
    let signed_open =
        json!({"key": "scope_signed_off", "label": "Scope signed off, and unchanged since", "met": false});
    let out_open = json!({"key": "out_of_scope_listed", "label": "What is out of scope is listed", "met": false});
    let checklist = w
        .ok(eng, "GET", &format!("{p}/stage-checklist"), None, StatusCode::OK)
        .await;
    assert_eq!(
        checklist,
        json!({"stage": "scope", "items": [
            signed_open,
            out_open,
            {"key": "criteria_have_targets", "label": "Success criteria set, each with a target", "met": true},
        ]})
    );
    let (status, body) = w
        .call(Some(&asg.token), "PUT", &stage, Some(json!({"stage": "access"})))
        .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::CONFLICT,
            json!({"error": "rejected_checklist_open", "open": [signed_open, out_open]})
        )
    );
    for bad in [String::new(), "  ".into(), "x".repeat(501), "bell\u{7}".into()] {
        let (status, body) = w
            .call(
                Some(&asg.token),
                "PUT",
                &stage,
                Some(json!({"stage": "access", "reason": bad})),
            )
            .await;
        assert_eq!(
            (status, body["error"].as_str()),
            (StatusCode::BAD_REQUEST, Some("invalid_reason")),
            "{bad:?}"
        );
    }
    let why = "Sponsor approved the change by email; out of scope agreed on the call";
    let moved = w
        .ok(
            asg,
            "PUT",
            &stage,
            Some(json!({"stage": "access", "reason": why})),
            StatusCode::OK,
        )
        .await;
    assert_eq!(moved["stage"], "access");
    // Moving back needs no reason, even to a stage with items open.
    w.ok(eng, "PUT", &stage, Some(json!({"stage": "discover"})), StatusCode::OK)
        .await;
    type Audited = (String, String, Option<String>, Option<Vec<String>>);
    let audited: Vec<Audited> = sqlx::query_as(
        "select actor, target, reason, open_items from audit_log
         where tenant_id = $1 and project_id = $2 and action = 'project.stage_changed' order by id",
    )
    .bind(&org)
    .bind(&t.project)
    .fetch_all(&testing::admin().await)
    .await
    .unwrap();
    assert_eq!(
        audited,
        [
            (asg.id.clone(), "scope".into(), None, None),
            (
                asg.id.clone(),
                "access".into(),
                Some(why.into()),
                Some(vec!["scope_signed_off".into(), "out_of_scope_listed".into()])
            ),
            (eng.id.clone(), "discover".into(), None, None),
        ]
    );

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
            // Needs no sign-in, only a token, which `{}` lacks.
            "/v1/digest/unsubscribe" => StatusCode::UNPROCESSABLE_ENTITY,
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

/// The agent run and eval routes as `oryxa_fde_agent::prod` builds them, on this world's store and SpiceDB. The
/// sandbox gateway is never reached: these tests only read runs and suites and set budgets.
fn agent_routes(w: &World) -> Router {
    use oryxa_fde_agent::access::PlatformAccess;
    use oryxa_fde_agent::evals::{self, Evals, JudgeConfig};
    use oryxa_fde_agent::gateway::GatewayClient;
    use oryxa_fde_agent::live::Offline;
    use oryxa_fde_agent::prod::{Live, Production};
    use oryxa_fde_agent::project_context::StoreContext;
    use oryxa_fde_agent::service::{Pricing, Runs, RunsConfig};
    use oryxa_fde_agent::store::Budget;

    let agent = oryxa_fde_agent::AgentConfig {
        model: "model".into(),
        region: "region".into(),
        max_turns: 1,
        approvals: Vec::new(),
    };
    let config = RunsConfig {
        pricing: Pricing {
            input_usd_micros_per_mtok: 1,
            output_usd_micros_per_mtok: 1,
        },
        default_budget: Budget {
            minutes: 60,
            spend_usd_micros: 1_000_000,
        },
        max_run: Duration::from_secs(60),
        grant_ttl: Duration::from_secs(60),
        grace: Duration::from_secs(1),
        poll: Duration::from_secs(1),
        lease: Duration::from_secs(60),
    };
    let runs = Runs::<Production<support::TestKeys>>::new(
        w.store.clone(),
        GatewayClient::new("http://127.0.0.1:9", "unused".into()).unwrap(),
        Live::Offline(Offline),
        StoreContext::new(w.store.clone(), agent, Vec::new()),
        PlatformAccess::new(support::verifier(), w.authz.clone()),
        config,
    );
    let judge = JudgeConfig {
        model: "model".into(),
        region: "region".into(),
        max_calls: 1,
    };
    let evals = Evals::new(runs.clone(), w.store.clone(), judge);
    oryxa_fde_agent::api::router(runs).merge(evals::router(evals))
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn the_session_cookie_reaches_agent_and_eval_routes() {
    let mut w = world().await;
    w.router = router_with(w.app.clone(), agent_routes(&w));
    let org = new_id("org");
    let alice = user(&org, "alice", "member");
    let c = w
        .ok(
            &alice,
            "POST",
            "/v1/companies",
            Some(json!({"name": "Acme"})),
            StatusCode::CREATED,
        )
        .await;
    let company = c["id"].as_str().unwrap();
    let p = w
        .ok(
            &alice,
            "POST",
            &format!("/v1/companies/{company}/projects"),
            Some(json!({"name": "Support"})),
            StatusCode::CREATED,
        )
        .await;
    let base = format!("/v1/companies/{company}/projects/{}", p["id"].as_str().unwrap());
    let session = w.session(&alice, &org).await;
    let budget = || Some(json!({"minutes": 30, "spend_usd_micros": 5_000_000}));

    // Reads with the cookie alone, as the web app sends them: agent runs, the budget, eval suites and criteria.
    for path in [
        "agent-runs",
        "agent-budget",
        "eval-suites",
        "eval-runs",
        "eval-criteria",
    ] {
        let (status, _, body) = w
            .with_cookie(&session, "GET", &format!("{base}/{path}"), None, false)
            .await;
        assert_eq!(status, StatusCode::OK, "GET {path}: {body}");
    }
    // A change with the web app's headers works; without them, or from another origin, it is refused.
    let path = format!("{base}/agent-budget");
    let (status, _, body) = w.with_cookie(&session, "PUT", &path, budget(), true).await;
    assert_eq!(
        (status, body["budget"]["minutes"].as_u64()),
        (StatusCode::OK, Some(30)),
        "{body}"
    );
    let (status, _, body) = w.with_cookie(&session, "PUT", &path, budget(), false).await;
    assert_eq!((status, body["error"].as_str()), (StatusCode::FORBIDDEN, Some("csrf")));
    let req = Request::post(format!("{base}/eval-suites"))
        .header("cookie", format!("__Host-fde_session={session}"))
        .header("x-oryxa-request", "1")
        .header("origin", "https://evil.example")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"name": "pwned", "criteria": [], "graders": []}).to_string(),
        ))
        .unwrap();
    let (status, _, body) = w.send(req).await;
    assert_eq!((status, body["error"].as_str()), (StatusCode::FORBIDDEN, Some("csrf")));

    // A bad or expired session, or none, is refused and a useless cookie cleared.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let old = json!({
        "purpose": "fde_session", "access_token": alice.token, "refresh_token": format!("refresh|{org}|{}|member", alice.id),
        "user": alice.id, "organisation": org, "signed_in": now - 8 * 24 * 3600,
    });
    let old = workos::helpers::session::seal(&old, &w.password).unwrap();
    for bad in [old, "garbage".to_owned()] {
        for path in ["agent-runs", "eval-suites"] {
            let (status, headers, _) = w.with_cookie(&bad, "GET", &format!("{base}/{path}"), None, false).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{path} with {bad}");
            assert_eq!(set_cookie(&headers, "__Host-fde_session").as_deref(), Some(""));
        }
    }
    let (status, _) = w.call(None, "GET", &format!("{base}/agent-runs"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Bearer tokens still work, with no web headers, for callers that are not a browser.
    w.ok(&alice, "GET", &format!("{base}/agent-runs"), None, StatusCode::OK)
        .await;
    w.ok(&alice, "PUT", &path, budget(), StatusCode::OK).await;
    w.ok(&alice, "GET", &format!("{base}/eval-runs"), None, StatusCode::OK)
        .await;
    // Another member of the organisation, signed in, is still refused the project.
    let bob = user(&org, "bob", "member");
    let bob_session = w.session(&bob, &org).await;
    let (status, _, _) = w
        .with_cookie(&bob_session, "GET", &format!("{base}/agent-runs"), None, false)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
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

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn the_engines_activity_suggestions_and_drafts_for_whoever_works_on_the_project() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "acme").await;
    let project = format!("/v1/companies/{}/projects/{}", t.company, t.project);
    let week = format!("{project}/updates/{}", t.record("{week}"));

    // The assignee, who works on the project, reads what the engine left.
    let activity = w
        .ok(&t.assignee, "GET", &format!("{project}/activity"), None, StatusCode::OK)
        .await;
    assert_eq!(
        (activity[0]["kind"].as_str(), activity[0]["passed"].as_u64()),
        (Some("eval_run_finished"), Some(9))
    );
    let suggestions = w
        .ok(
            &t.assignee,
            "GET",
            &format!("{project}/suggestions"),
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(suggestions[0]["kind"], "ready_to_deploy");
    let updates = w
        .ok(&t.assignee, "GET", &format!("{project}/updates"), None, StatusCode::OK)
        .await;
    assert_eq!(
        (updates[0]["status"].as_str(), updates[0]["week"].as_str()),
        (Some("draft"), Some("2026-11-02"))
    );
    for bad in [
        "{project}/activity?limit=0",
        "{project}/activity?limit=201",
        "{project}/updates/2026-11-03",
    ] {
        let path = bad.replace("{project}", &project);
        assert_eq!(
            w.status(&t.lead, "GET", &path, None).await,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }

    // Edited, then approved: final, and nothing is sent.
    let edited = w
        .ok(
            &t.lead,
            "PATCH",
            &week,
            Some(json!({"body": "Done: indexing."})),
            StatusCode::OK,
        )
        .await;
    assert_eq!(
        (edited["body"].as_str(), edited["edited_by"].as_str()),
        (Some("Done: indexing."), Some(t.lead.id.as_str()))
    );
    let unknown = Some(json!({"body": "x", "status": "approved"}));
    assert_eq!(
        w.status(&t.lead, "PATCH", &week, unknown).await,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let approved = w
        .ok(&t.engineer, "POST", &format!("{week}/approve"), None, StatusCode::OK)
        .await;
    assert_eq!(approved["status"], "approved");
    assert_eq!(
        w.status(&t.lead, "PATCH", &week, Some(json!({"body": "late"}))).await,
        StatusCode::CONFLICT
    );
    assert_eq!(
        w.status(&t.lead, "POST", &format!("{week}/discard"), None).await,
        StatusCode::CONFLICT
    );
    let next = format!("{project}/updates/2026-11-09");
    assert_eq!(
        w.status(&t.lead, "POST", &format!("{next}/approve"), None).await,
        StatusCode::NOT_FOUND
    );

    // Dismissed once; a suggestion that is not open, or not a kind, is refused.
    let dismiss = format!("{project}/suggestions/ready_to_deploy/dismiss");
    assert_eq!(w.status(&t.lead, "POST", &dismiss, None).await, StatusCode::NO_CONTENT);
    assert_eq!(w.status(&t.lead, "POST", &dismiss, None).await, StatusCode::NOT_FOUND);
    let bad = format!("{project}/suggestions/deploy_now/dismiss");
    assert_eq!(w.status(&t.lead, "POST", &bad, None).await, StatusCode::BAD_REQUEST);

    // Someone in the organisation who is not on the project reads none of it.
    let other = user(&org, "other", "member");
    for path in [
        format!("{project}/activity"),
        format!("{project}/suggestions"),
        week.clone(),
    ] {
        assert_eq!(
            w.status(&other, "GET", &path, None).await,
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }

    // A task blocked on one of the project's access requests says so; any other is refused.
    let tasks = format!("{project}/tasks");
    let access = t.record("{access_request}");
    let blocked = w
        .ok(
            &t.lead,
            "POST",
            &tasks,
            Some(json!({"title": "Index", "status": "blocked", "blocker": "API token", "blocked_by": access})),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(blocked["blocked_by"], access);
    let open = Some(json!({"title": "Index", "status": "todo", "blocked_by": access}));
    assert_eq!(w.status(&t.lead, "POST", &tasks, open).await, StatusCode::CONFLICT);
    let elsewhere = company(&w, &org, "beta").await;
    let theirs = Some(json!({"title": "Index", "status": "blocked", "blocker": "x",
        "blocked_by": elsewhere.record("{access_request}")}));
    assert_eq!(w.status(&t.lead, "POST", &tasks, theirs).await, StatusCode::BAD_REQUEST);
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_canvas_saves_on_its_latest_version_and_a_large_one_is_checked_when_read_back() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "acme").await;
    let base = format!("/v1/companies/{}", t.company);
    let project = format!("{base}/projects/{}", t.project);
    let canvas = format!("{base}/canvas");

    // The fixture saved version 1; a save on version 0 lost to it.
    let stale = json!({"base_version": 0, "content": {"elements": []}});
    let (status, body) = w.call(Some(&t.engineer.token), "PUT", &canvas, Some(stale)).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("conflict"))
    );
    let not_a_scene = json!({"base_version": 1, "content": [1, 2]});
    let (status, body) = w.call(Some(&t.engineer.token), "PUT", &canvas, Some(not_a_scene)).await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_content"))
    );

    // Past the inline size the scene goes to S3 under the company's prefix, and reads back whole.
    let scene = json!({"elements": [{"id": "shape-1"}], "files": {"f1": {"dataURL": "x".repeat(300 * 1024)}}});
    let save = json!({"base_version": 1, "content": scene});
    let saved = w.ok(&t.engineer, "PUT", &canvas, Some(save), StatusCode::OK).await;
    assert_eq!(saved["version"], 2);
    let latest = w.ok(&t.lead, "GET", &canvas, None, StatusCode::OK).await;
    assert_eq!((&latest["version"], &latest["content"]), (&json!(2), &scene));
    let owner = testing::admin().await;
    let key: String = sqlx::query_scalar(
        "select blob_key from canvas_versions where tenant_id = $1 and company_id = $2 and project_id is null
         and version = 2",
    )
    .bind(&org)
    .bind(&t.company)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert!(key.starts_with(&format!("{org}/{}/canvas/cnv_", t.company)), "{key}");
    let first = w
        .ok(&t.lead, "GET", &format!("{canvas}/versions/1"), None, StatusCode::OK)
        .await;
    assert_eq!(first["content"], json!({"elements": [{"id": "shape-1"}]}));
    let versions = w
        .ok(&t.lead, "GET", &format!("{canvas}/versions"), None, StatusCode::OK)
        .await;
    let numbers: Vec<u64> = versions
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["version"].as_u64().unwrap())
        .collect();
    assert_eq!(numbers, [2, 1]);
    assert_eq!(
        w.status(&t.lead, "GET", &format!("{canvas}/versions/3"), None).await,
        StatusCode::NOT_FOUND
    );

    // An object changed in S3 is refused, never served.
    w.context
        .blobs
        .put(&key, br#"{"elements":["planted"]}"#.to_vec(), "application/json")
        .await
        .unwrap();
    assert_eq!(
        w.status(&t.lead, "GET", &canvas, None).await,
        StatusCode::INTERNAL_SERVER_ERROR
    );

    // Too large: past 8 MiB stored is refused by the API, past the body limit by the router.
    let huge = |n: usize| json!({"base_version": 2, "content": {"blob": "x".repeat(n)}});
    let (status, body) = w
        .call(Some(&t.lead.token), "PUT", &canvas, Some(huge(8 * 1024 * 1024 + 10)))
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_content_too_large"))
    );
    let (status, _) = w
        .call(Some(&t.lead.token), "PUT", &canvas, Some(huge(10 * 1024 * 1024)))
        .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

    // A project's assignee works on the project's canvas, not the company's.
    assert_eq!(w.status(&t.assignee, "GET", &canvas, None).await, StatusCode::FORBIDDEN);
    let own = format!("{project}/canvas");
    let loaded = w.ok(&t.assignee, "GET", &own, None, StatusCode::OK).await;
    assert_eq!(loaded["version"], 1);
    let save = json!({"base_version": 1, "content": {"elements": []}});
    let saved = w.ok(&t.assignee, "PUT", &own, Some(save), StatusCode::OK).await;
    assert_eq!(saved["version"], 2);

    // A shape links to a record of its place only.
    let other = w
        .ok(
            &t.lead,
            "POST",
            &format!("{base}/projects"),
            Some(json!({"name": "Other"})),
            StatusCode::CREATED,
        )
        .await;
    let other_item = w
        .ok(
            &t.lead,
            "POST",
            &format!("{base}/projects/{}/scope/items", other["id"].as_str().unwrap()),
            Some(json!({"kind": "in", "description": "Voice"})),
            StatusCode::CREATED,
        )
        .await;
    let link = json!({"kind": "scope_item", "id": other_item["id"]});
    let (status, body) = w
        .call(
            Some(&t.assignee.token),
            "PUT",
            &format!("{own}/shapes/s2/link"),
            Some(link.clone()),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_target"))
    );
    let linked = w
        .ok(
            &t.lead,
            "PUT",
            &format!("{canvas}/shapes/s2/link"),
            Some(link),
            StatusCode::OK,
        )
        .await;
    assert_eq!(
        (&linked["shape"], &linked["kind"]),
        (&json!("s2"), &json!("scope_item"))
    );
    let (status, _) = w
        .call(Some(&t.lead.token), "PUT", &format!("{canvas}/shapes/a:b/link"), None)
        .await;
    assert!(status.is_client_error());
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_thread_promotes_into_the_decisions_log_and_a_note_names_only_people_of_its_place() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "acme").await;
    let base = format!("/v1/companies/{}", t.company);
    let project = format!("{base}/projects/{}", t.project);
    let thread = format!("{project}/threads/{}", t.record("{project_thread}"));

    // The fixture's project thread is about its task; the assignee comments and promotes it.
    w.ok(
        &t.assignee,
        "POST",
        &format!("{thread}/comments"),
        Some(json!({"body": "Tier-1 only, agreed with Sam"})),
        StatusCode::CREATED,
    )
    .await;
    let detail = w.ok(&t.assignee, "GET", &thread, None, StatusCode::OK).await;
    let bodies: Vec<&str> = detail["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["body"].as_str().unwrap())
        .collect();
    assert_eq!(bodies, ["Who owns this?", "Tier-1 only, agreed with Sam"]);
    let promote = json!({"title": "Tier-1 only", "decided_by": "Sam"});
    let decision = w
        .ok(
            &t.assignee,
            "POST",
            &format!("{thread}/promote"),
            Some(promote.clone()),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(decision["rationale"], "Who owns this?");
    let log = w
        .ok(
            &t.assignee,
            "GET",
            &format!("{project}/decisions"),
            None,
            StatusCode::OK,
        )
        .await;
    assert!(ids(&log).contains(&decision["id"].as_str().unwrap()));
    let (status, body) = w
        .call(
            Some(&t.assignee.token),
            "POST",
            &format!("{thread}/promote"),
            Some(promote),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("rejected_already_promoted"))
    );
    let detail = w.ok(&t.assignee, "GET", &thread, None, StatusCode::OK).await;
    assert_eq!(detail["thread"]["decision"], decision["id"]);

    // Threads are about records of their place: no project thread on the company's documents.
    let on_document = json!({"subject": {"kind": "document", "id": t.record("{document}")}, "body": "?"});
    let (status, body) = w
        .call(
            Some(&t.lead.token),
            "POST",
            &format!("{project}/threads"),
            Some(on_document.clone()),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_subject"))
    );
    w.ok(
        &t.lead,
        "POST",
        &format!("{base}/threads"),
        Some(on_document),
        StatusCode::CREATED,
    )
    .await;
    let shape = json!({"subject": {"kind": "shape", "id": "shape-1"}, "body": "Is this the CRM?"});
    w.ok(
        &t.lead,
        "POST",
        &format!("{project}/threads"),
        Some(shape),
        StatusCode::CREATED,
    )
    .await;
    let on_shape = w
        .ok(
            &t.lead,
            "GET",
            &format!("{project}/threads?subject_kind=shape&subject_id=shape-1"),
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(on_shape.as_array().unwrap().len(), 1);

    // Attendees must work on the place: the assignee works on the project, not on the company.
    let note = |attendee: &str| {
        json!({"title": "Weekly", "held_on": "2026-11-03", "body": "Status", "attendees": [attendee],
            "stakeholders": [t.record("{stakeholder}")]})
    };
    let added = w
        .ok(
            &t.lead,
            "POST",
            &format!("{project}/meeting-notes"),
            Some(note(&t.assignee.id)),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(added["attendees"], json!([t.assignee.id]));
    for (path, attendee) in [
        (format!("{base}/meeting-notes"), &t.assignee.id),
        (
            format!("{project}/meeting-notes"),
            &format!("user_nobody_{}", new_id("u")),
        ),
    ] {
        let (status, body) = w.call(Some(&t.lead.token), "POST", &path, Some(note(attendee))).await;
        assert_eq!(
            (status, body["error"].as_str()),
            (StatusCode::BAD_REQUEST, Some("invalid_attendees")),
            "{path}"
        );
    }
    let mut foreign = note(&t.lead.id);
    foreign["stakeholders"] = json!(["stk_of_someone_else"]);
    let (status, body) = w
        .call(
            Some(&t.lead.token),
            "POST",
            &format!("{base}/meeting-notes"),
            Some(foreign),
        )
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("invalid_stakeholders"))
    );
    // Removing the stakeholder takes them off the notes.
    let stakeholder = format!("{base}/stakeholders/{}", t.record("{stakeholder}"));
    w.ok(&t.lead, "DELETE", &stakeholder, None, StatusCode::NO_CONTENT)
        .await;
    let read = format!("{project}/meeting-notes/{}", added["id"].as_str().unwrap());
    let after = w.ok(&t.lead, "GET", &read, None, StatusCode::OK).await;
    assert_eq!(after["stakeholders"], json!([]));
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn an_export_holds_its_own_companys_records_only_and_needs_manage() {
    let w = world().await;
    let org = new_id("org");
    let a = company(&w, &org, "alpha").await;
    let b = company(&w, &org, "beta").await;
    let path = format!("/v1/companies/{}/export", a.company);

    let export = w.ok(&a.lead, "GET", &path, None, StatusCode::OK).await;
    let text = export.to_string();
    // Every export is audited: who, for which company; a refused one is not.
    let exported = async || -> Vec<String> {
        sqlx::query_scalar(
            "select actor from audit_log where tenant_id = $1 and company_id = $2 and action = 'company.exported'
             order by at",
        )
        .bind(&org)
        .bind(&a.company)
        .fetch_all(&testing::admin().await)
        .await
        .unwrap()
    };
    assert_eq!(exported().await, std::slice::from_ref(&a.lead.id));
    // Every record of A is in it, under its project; nothing of B's is.
    assert_eq!(export["company"]["id"], json!(a.company));
    let projects = export["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0]["project"]["id"], json!(a.project));
    // Every record but the organisation's security answers, the share links, which grant access
    // rather than record the work, the suggestions the engine derives from events, and the canvas.
    // The GitHub and Slack links describe the work, so they are in: each project's repositories
    // (with their installation) and the company's channel.
    let left_out = ["{answer}", "{link}", "{kind}", "{shape}", "{version}"];
    for (placeholder, id) in &a.records {
        if !left_out.contains(placeholder) {
            assert!(text.contains(id.as_str()), "{placeholder} {id} missing");
        }
    }
    assert!(!text.contains(a.record("{link}")));
    assert_eq!(projects[0]["github_repositories"][0]["full_name"], "alpha/support-rag");
    let channel = &export["slack_channel"];
    assert_eq!(
        (&channel["channel_id"], &channel["channel_name"], &channel["team_id"]),
        (&json!(a.record("{channel}")), &json!("alpha"), &json!(slack_team(&org)))
    );
    // What grants access is not: the Slack token, nor where it is kept.
    assert!(!text.contains(&FakeSecrets::arn(&org)) && !text.contains("xoxb-"));
    assert!(!text.contains(&b.company) && !text.contains(&b.project));
    // Every company's fixture shares its week, suggestion kind, shape and canvas version: those
    // name no record of B's.
    let shared = ["{week}", "{kind}", "{shape}", "{version}"];
    for (placeholder, id) in b.records.iter().filter(|(p, _)| !shared.contains(p)) {
        assert!(!text.contains(id.as_str()), "B's {placeholder} {id} is in A's export");
    }
    // The organisation's security answers are not the company's records.
    assert!(!text.contains(a.record("{answer}")));
    // Only those who manage the company export it: its lead and the organisation's admins.
    w.ok(&a.admin, "GET", &path, None, StatusCode::OK).await;
    for who in [&a.engineer, &a.assignee, &b.lead] {
        assert_eq!(
            w.status(who, "GET", &path, None).await,
            StatusCode::FORBIDDEN,
            "{}",
            who.id
        );
    }
    assert_eq!(
        exported().await,
        [a.lead.id.clone(), a.admin.id.clone()],
        "a refused export is not"
    );
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_guest_sees_one_projects_room_and_nothing_else_and_a_dead_link_fails_closed() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "alpha").await;
    let room = format!("/v1/room/companies/{}/projects/{}", t.company, t.project);

    // The fixture's guest redeemed a link: the room shows room-safe fields only.
    let seen = w.ok(&t.guest, "GET", &room, None, StatusCode::OK).await;
    assert_eq!(
        (&seen["project"], &seen["stage"]),
        (&json!(t.project), &json!("discover"))
    );
    assert_eq!((&seen["progress"], &seen["stages"]), (&json!(1), &json!(8)));
    assert_eq!(seen["criteria"].as_array().unwrap().len(), 1);
    assert_eq!(seen["scope_awaits_sign_off"], json!(true));
    // The fixture's update is a draft: the room shows none until an FDE approves it.
    assert_eq!(seen["latest_update"], Value::Null);
    assert_eq!(
        (&seen["criteria"][0]["passing"], &seen["criteria_passing"]),
        (&Value::Null, &json!(0))
    );
    let project_path = format!("/v1/companies/{}/projects/{}", t.company, t.project);
    let approve = format!("{project_path}/updates/{}/approve", t.record("{week}"));
    w.ok(&t.lead, "POST", &approve, None, StatusCode::OK).await;
    // An eval run measured 95 against "at least 90": the criterion passes.
    let scope = CompanyScope::new(TenantId::new(&org).unwrap(), CompanyId::new(&t.company).unwrap())
        .project(oryxa_fde_core::ProjectId::new(&t.project).unwrap());
    let mut tx = w.store.project(&scope).await.unwrap();
    let criterion = oryxa_fde_core::CriterionId::new(t.record("{criterion}")).unwrap();
    let run = oryxa_fde_core::EvalRunId::new(new_id("evr")).unwrap();
    assert!(tx.record_criterion_result(&criterion, &run, 95.0).await.unwrap());
    tx.commit().await.unwrap();
    let seen = w.ok(&t.guest, "GET", &room, None, StatusCode::OK).await;
    assert_eq!(seen["latest_update"]["week"], json!(t.record("{week}")));
    assert!(
        seen["latest_update"]["body"]
            .as_str()
            .unwrap()
            .contains("done this week")
    );
    assert_eq!(
        (
            &seen["criteria"][0]["latest"],
            &seen["criteria"][0]["passing"],
            &seen["criteria_passing"]
        ),
        (&json!(95.0), &json!(true), &json!(1))
    );
    // A project thread puts a question to the customer: the room shows its text and date only,
    // never the thread's comments, until it is cleared or the thread becomes a decision.
    assert_eq!(seen["questions"], json!([]));
    let thread = format!("{project_path}/threads/{}", t.record("{project_thread}"));
    let ask = format!("{thread}/customer-question");
    let asked = w
        .ok(
            &t.lead,
            "PUT",
            &ask,
            Some(json!({"question": "Who approves refunds over 500?"})),
            StatusCode::OK,
        )
        .await;
    assert_eq!(asked["customer_question"], json!("Who approves refunds over 500?"));
    let seen = w.ok(&t.guest, "GET", &room, None, StatusCode::OK).await;
    assert_eq!(
        seen["questions"][0]["question"],
        json!("Who approves refunds over 500?")
    );
    assert_eq!(seen["questions"][0]["asked_at"], asked["asked_at"]);
    let text = seen.to_string();
    for internal in [
        "Index tickets",
        "API token",
        "Tier-1 tickets",
        "Use Bedrock",
        "Zendesk",
        "Who owns this?",
        "Refund rules",
    ] {
        assert!(!text.contains(internal), "the room shows {internal}");
    }
    for bad in [json!({"question": ""}), json!({"question": "x".repeat(201)})] {
        assert_eq!(
            w.status(&t.lead, "PUT", &ask, Some(bad.clone())).await,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
    // A company thread has no room, so no question, under any project's path.
    let company_thread = format!("{project_path}/threads/{}/customer-question", t.record("{thread}"));
    assert_eq!(
        w.status(&t.lead, "PUT", &company_thread, Some(json!({"question": "Q?"})))
            .await,
        StatusCode::NOT_FOUND
    );
    w.ok(&t.lead, "PUT", &ask, Some(json!({"question": null})), StatusCode::OK)
        .await;
    let seen = w.ok(&t.guest, "GET", &room, None, StatusCode::OK).await;
    assert_eq!(seen["questions"], json!([]));
    w.ok(
        &t.lead,
        "PUT",
        &ask,
        Some(json!({"question": "Who signs?"})),
        StatusCode::OK,
    )
    .await;
    let promote = json!({"title": "Sam signs", "decided_by": "Sam"});
    w.ok(
        &t.lead,
        "POST",
        &format!("{thread}/promote"),
        Some(promote),
        StatusCode::CREATED,
    )
    .await;
    let seen = w.ok(&t.guest, "GET", &room, None, StatusCode::OK).await;
    assert_eq!(seen["questions"], json!([]), "a decided thread waits on no one");
    let (status, body) = w
        .call(Some(&t.lead.token), "PUT", &ask, Some(json!({"question": "Again?"})))
        .await;
    assert_eq!(
        (status, &body["error"]),
        (StatusCode::CONFLICT, &json!("rejected_already_promoted"))
    );
    // Every other route of its own company and project is refused to the guest, and so is everything
    // the organisation's own people may do: a guest is no member of its workspace.
    let records = &t.records;
    let fill = |s: &str| {
        let mut out = s
            .replace("{company}", &t.company)
            .replace("{project}", &t.project)
            .replace("{user}", &t.guest.id);
        for (placeholder, id) in records {
            out = out.replace(placeholder, id);
        }
        out
    };
    for (method, template, body) in TARGETED {
        if template.starts_with("/v1/room/") {
            continue;
        }
        let body = body
            .filter(|b| !b.starts_with("RAW:"))
            .map(|b| serde_json::from_str::<Value>(&fill(b)).unwrap());
        let path = fill(template) + query_for(method, template);
        let (status, resp) = w.call(Some(&t.guest.token), method, &path, body).await;
        assert!(
            !status.is_success(),
            "the guest reached {method} {path}: {status} {resp}"
        );
    }
    for (method, path, body) in [
        ("GET", "/v1/security-answers", None),
        (
            "POST",
            "/v1/security-answers",
            Some(json!({"question": "Do you encrypt at rest?", "answer": "pwned"})),
        ),
        ("POST", "/v1/companies", Some(json!({"name": "Guest Corp"}))),
        ("GET", "/v1/companies", None),
    ] {
        let (status, resp) = w.call(Some(&t.guest.token), method, path, body).await;
        assert!(
            status == StatusCode::FORBIDDEN || (method == "GET" && path == "/v1/companies" && resp == json!([])),
            "the guest reached {method} {path}: {status} {resp}"
        );
    }
    // Another project of the same company is not theirs.
    let other = w
        .ok(
            &t.lead,
            "POST",
            &format!("/v1/companies/{}/projects", t.company),
            Some(json!({"name": "Other"})),
            StatusCode::CREATED,
        )
        .await;
    let other_room = format!(
        "/v1/room/companies/{}/projects/{}",
        t.company,
        other["id"].as_str().unwrap()
    );
    assert_eq!(
        w.status(&t.guest, "GET", &other_room, None).await,
        StatusCode::FORBIDDEN
    );

    // Expired: refused at once, though SpiceDB still holds the guest relation.
    let owner = testing::admin().await;
    sqlx::query(
        "update share_links set created_at = now() - interval '1 day', expires_at = now() - interval '1 second' where tenant_id = $1 and link_id = $2",
    )
    .bind(&org)
    .bind(t.record("{link}"))
    .execute(&owner)
    .await
    .unwrap();
    assert_eq!(w.status(&t.guest, "GET", &room, None).await, StatusCode::FORBIDDEN);

    // A new link: redeemed, then revoked; the revoked token is refused afterwards.
    let links = format!("/v1/companies/{}/projects/{}/share-links", t.company, t.project);
    let made = w
        .ok(
            &t.lead,
            "POST",
            &links,
            Some(json!({"expires_in_days": 1})),
            StatusCode::CREATED,
        )
        .await;
    let token = made["token"].clone();
    let redeem = Some(json!({"token": token}));
    w.ok(
        &t.guest,
        "POST",
        "/v1/share-links/redeem",
        redeem.clone(),
        StatusCode::OK,
    )
    .await;
    w.ok(&t.guest, "GET", &room, None, StatusCode::OK).await;
    let listed = w.ok(&t.lead, "GET", &links, None, StatusCode::OK).await;
    assert!(
        listed.to_string().find(token.as_str().unwrap()).is_none(),
        "tokens are never listed"
    );
    let revoke = format!("{links}/{}", made["link"]["id"].as_str().unwrap());
    w.ok(&t.lead, "DELETE", &revoke, None, StatusCode::NO_CONTENT).await;
    assert_eq!(w.status(&t.guest, "GET", &room, None).await, StatusCode::FORBIDDEN);
    assert_eq!(
        w.status(&t.guest, "POST", "/v1/share-links/redeem", redeem.clone())
            .await,
        StatusCode::NOT_FOUND
    );
    // Revoked, the guest relation itself is gone from SpiceDB: the earlier link has expired, so
    // no live link keeps it.
    let tenant = TenantId::new(&org).unwrap();
    let item = oryxa_authz::CheckItem {
        resource: oryxa_authz::ObjectRef::new(&tenant, "fde_project", &t.project),
        permission: "view",
        subject: oryxa_authz::SubjectRef::object(oryxa_authz::ObjectRef::new(&tenant, "user", &t.guest.id)),
        context: None,
    };
    let decision = w
        .authz
        .check(&tenant, &item, &oryxa_authz::Consistency::FullyConsistent)
        .await
        .unwrap();
    assert!(!decision.allowed(), "{decision:?}");

    // A live token in another tenant's hands, and malformed ones, are refused alike.
    let made = w
        .ok(&t.lead, "POST", &links, Some(json!({})), StatusCode::CREATED)
        .await;
    let stranger = user(&new_id("org"), "stranger", "member");
    let foreign = Some(json!({"token": made["token"]}));
    assert_eq!(
        w.status(&stranger, "POST", "/v1/share-links/redeem", foreign).await,
        StatusCode::NOT_FOUND
    );
    let secret = made["token"].as_str().unwrap().rsplit('.').next().unwrap().to_owned();
    for bad in [
        String::from("nonsense"),
        format!("{}.{}.shr_none.{secret}", t.company, t.project),
        format!(
            "{}.{}.{}.{}",
            t.company,
            t.project,
            made["link"]["id"].as_str().unwrap(),
            "0".repeat(64)
        ),
    ] {
        let body = Some(json!({"token": bad}));
        assert_eq!(
            w.status(&t.guest, "POST", "/v1/share-links/redeem", body).await,
            StatusCode::NOT_FOUND,
            "{bad}"
        );
    }
    for (days, ok) in [(0, false), (91, false), (90, true)] {
        let status = w
            .status(&t.lead, "POST", &links, Some(json!({"expires_in_days": days})))
            .await;
        assert_eq!(status.is_success(), ok, "{days} days");
    }
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_sponsor_unsubscribes_from_the_digest_with_the_link_alone() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "alpha").await;
    let stakeholders = format!("/v1/companies/{}/stakeholders", t.company);

    // An address is checked, then kept and shown to whoever works on the company.
    for bad in [
        "Sam <sam@acme.example>",
        "sam@acme",
        "sam@acme.example\r\nBcc: eve@evil.example",
    ] {
        let body = json!({"name": "Sam", "role": "sponsor", "email": bad});
        assert_eq!(
            w.status(&t.lead, "POST", &stakeholders, Some(body)).await,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
    let body = json!({"name": "Sam", "role": "sponsor", "email": "sam@acme.example"});
    let sam = w
        .ok(&t.lead, "POST", &stakeholders, Some(body), StatusCode::CREATED)
        .await;
    assert_eq!(
        (&sam["email"], &sam["digest_unsubscribed_at"]),
        (&json!("sam@acme.example"), &Value::Null)
    );

    // The fixture's update, approved, and Sam's mail of it claimed as the digest claims it: only
    // once Sam sponsors this project, not merely the company.
    let project_path = format!("/v1/companies/{}/projects/{}", t.company, t.project);
    let approve = format!("{project_path}/updates/{}/approve", t.record("{week}"));
    w.ok(&t.lead, "POST", &approve, None, StatusCode::OK).await;
    let scope = CompanyScope::new(TenantId::new(&org).unwrap(), CompanyId::new(&t.company).unwrap())
        .project(oryxa_fde_core::ProjectId::new(&t.project).unwrap());
    let sam_id = oryxa_fde_core::StakeholderId::new(sam["id"].as_str().unwrap()).unwrap();
    let mut tx = w.store.project(&scope).await.unwrap();
    assert!(tx.claim_digest(fixture_week(), &sam_id).await.unwrap().is_none());
    drop(tx);
    let sponsors = format!("{project_path}/sponsors");
    w.ok(
        &t.lead,
        "PUT",
        &format!("{sponsors}/{}", sam["id"].as_str().unwrap()),
        None,
        StatusCode::OK,
    )
    .await;
    let listed = w.ok(&t.assignee, "GET", &sponsors, None, StatusCode::OK).await;
    assert!(listed.as_array().unwrap().iter().any(|s| s["id"] == sam["id"]));
    // Only a stakeholder whose part is sponsor sponsors a project.
    let other = w
        .ok(
            &t.lead,
            "POST",
            &stakeholders,
            Some(json!({"name": "Eng", "role": "it"})),
            StatusCode::CREATED,
        )
        .await;
    let (status, body) = w
        .call(
            Some(&t.lead.token),
            "PUT",
            &format!("{sponsors}/{}", other["id"].as_str().unwrap()),
            None,
        )
        .await;
    assert_eq!(
        (status, &body["error"]),
        (StatusCode::CONFLICT, &json!("rejected_not_a_sponsor"))
    );
    let mut tx = w.store.project(&scope).await.unwrap();
    let claim = tx.claim_digest(fixture_week(), &sam_id).await.unwrap().unwrap();
    tx.commit().await.unwrap();
    let token = claim.unsubscribe.to_string();

    // A wrong secret, a malformed token, or the same token naming another tenant: refused alike.
    let last = if token.ends_with('0') { "1" } else { "0" };
    let forged = format!("{}{last}", &token[..token.len() - 1]);
    let elsewhere = token.replacen(&org, &new_id("org"), 1);
    let unsubscribe = |token: &str| w.call(None, "POST", "/v1/digest/unsubscribe", Some(json!({"token": token})));
    for bad in [forged.as_str(), "", "not.a.token", elsewhere.as_str()] {
        assert_eq!(unsubscribe(bad).await.0, StatusCode::NOT_FOUND, "{bad}");
    }
    let listed = w.ok(&t.lead, "GET", &stakeholders, None, StatusCode::OK).await;
    let row = |listed: &Value| {
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == sam["id"])
            .unwrap()
            .clone()
    };
    assert_eq!(row(&listed)["digest_unsubscribed_at"], Value::Null);

    // The link alone unsubscribes Sam; again is no change.
    assert_eq!(unsubscribe(&token).await.0, StatusCode::NO_CONTENT);
    assert_eq!(unsubscribe(&token).await.0, StatusCode::NO_CONTENT);
    let listed = w.ok(&t.lead, "GET", &stakeholders, None, StatusCode::OK).await;
    assert!(row(&listed)["digest_unsubscribed_at"].is_string());
}

/// A GitHub delivery to the webhook, signed with the webhook secret unless `signature` is given.
async fn github_delivery(w: &World, event: &str, delivery: &str, body: &str, signature: Option<&str>) -> StatusCode {
    let sig = signature
        .map(str::to_owned)
        .unwrap_or_else(|| format!("sha256={}", hmac_hex(WEBHOOK_SECRET, &[body.as_bytes()])));
    let req = Request::post("/webhooks/github")
        .header("content-type", "application/json")
        .header("x-github-event", event)
        .header("x-github-delivery", delivery)
        .header("x-hub-signature-256", sig)
        .body(Body::from(body.to_owned()))
        .unwrap();
    w.send(req).await.0
}

fn pull_request(
    action: &str,
    merged: bool,
    installation: u64,
    repository: u64,
    number: u32,
    at: time::OffsetDateTime,
) -> String {
    let at = at.format(&time::format_description::well_known::Rfc3339).unwrap();
    json!({"action": action, "number": number,
        "pull_request": {"merged": merged, "updated_at": at, "title": "Refund flow"},
        "repository": {"id": repository}, "installation": {"id": installation}})
    .to_string()
}

fn delivery() -> String {
    format!("{:032x}", rand::random::<u128>())
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_github_installation_is_claimed_once_and_only_by_whoever_proves_it() {
    let w = world().await;
    let org = new_id("org");
    let admin = user(&org, "gh_admin", "admin");
    let other_admin = user(&org, "gh_admin2", "admin");
    let member = user(&org, "gh_member", "member");
    let installation = github_id();
    let start = async |who: &User| {
        let started = w.ok(who, "POST", "/v1/github/install", None, StatusCode::OK).await;
        state_of(started["url"].as_str().unwrap())
    };
    let code = |reachable: Vec<u64>| {
        let c = new_id("ghc");
        w.github.codes.lock().unwrap().insert(c.clone(), reachable);
        c
    };
    let claim = async |who: &User, code: String, state: &str| {
        let body = json!({"code": code, "installation_id": installation, "state": state});
        w.call(Some(&who.token), "POST", "/v1/github/installations", Some(body))
            .await
    };

    // Only an admin of the organisation starts an install.
    assert_eq!(
        w.status(&member, "POST", "/v1/github/install", None).await,
        StatusCode::FORBIDDEN
    );

    // A state that is forged, someone else's or used before is refused; so is an installation the
    // user cannot reach on GitHub.
    let state = start(&admin).await;
    let forged = state.replacen(&org, &new_id("org"), 1);
    assert_eq!(
        claim(&admin, code(vec![installation]), &forged).await.1["error"],
        "invalid_state"
    );
    assert_eq!(
        claim(&other_admin, code(vec![installation]), &state).await.1["error"],
        "invalid_state"
    );
    let unreachable = start(&admin).await;
    assert_eq!(
        claim(&admin, code(vec![installation + 1]), &unreachable).await.0,
        StatusCode::FORBIDDEN
    );
    let bad_code = start(&admin).await;
    assert_eq!(
        claim(&admin, "spent".into(), &bad_code).await.1["error"],
        "invalid_code"
    );

    let (status, claimed) = claim(&admin, code(vec![installation]), &state).await;
    assert_eq!(
        (status, &claimed["installation_id"]),
        (StatusCode::OK, &json!(installation))
    );
    assert_eq!(
        claim(&admin, code(vec![installation]), &state).await.1["error"],
        "invalid_state",
        "used once"
    );
    let listed = w
        .ok(&member, "GET", "/v1/github/installations", None, StatusCode::OK)
        .await;
    assert_eq!(listed.as_array().unwrap().len(), 1);

    // Another organisation proving the same installation gets 409; the claim never moves.
    let org2 = new_id("org");
    let thief = user(&org2, "gh_thief", "admin");
    let state = start(&thief).await;
    let (status, body) = claim(&thief, code(vec![installation]), &state).await;
    assert_eq!(
        (status, &body["error"]),
        (StatusCode::CONFLICT, &json!("rejected_installation_claimed"))
    );
    let theirs = w
        .ok(&thief, "GET", "/v1/github/installations", None, StatusCode::OK)
        .await;
    assert_eq!(theirs, json!([]));
    // Claiming again from the owner changes nothing.
    let state = start(&other_admin).await;
    assert_eq!(
        claim(&other_admin, code(vec![installation]), &state).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_linked_repositorys_pull_requests_become_events_once_and_removals_unlink() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "alpha").await;
    let other = company(&w, &new_id("org"), "gamma").await;
    let installation: u64 = t.record("{installation}").parse().unwrap();
    let repository: u64 = t.record("{repository}").parse().unwrap();
    let project = format!("/v1/companies/{}/projects/{}", t.company, t.project);
    let repos = format!("{project}/github/repositories");

    // Linking: only a repository GitHub puts in one of the organisation's own installations, and
    // only to one project.
    let listed = w.ok(&t.lead, "GET", &repos, None, StatusCode::OK).await;
    assert_eq!(listed[0]["full_name"], "alpha/support-rag");
    let link = async |path: &str, installation: &str| {
        let body: Value = serde_json::from_str(&format!(r#"{{"installation_id":{installation}}}"#)).unwrap();
        w.call(Some(&t.lead.token), "PUT", path, Some(body)).await
    };
    let unknown = github_id();
    let (status, body) = link(&format!("{repos}/{unknown}"), &installation.to_string()).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    // A repository that exists on GitHub but is not in the installation (here another
    // organisation's, as a public one would be) is refused: membership is what GitHub lists.
    let theirs_repo = other.record("{repository}");
    let (status, body) = link(&format!("{repos}/{theirs_repo}"), &installation.to_string()).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (_, body) = link(&format!("{repos}/{unknown}"), &github_id().to_string()).await;
    assert_eq!(body["error"], "invalid_installation", "an installation no one claimed");
    let (_, body) = link(&format!("{repos}/{unknown}"), other.record("{installation}")).await;
    assert_eq!(
        body["error"], "invalid_installation",
        "another organisation's installation"
    );
    let second = w
        .ok(
            &t.lead,
            "POST",
            &format!("/v1/companies/{}/projects", t.company),
            Some(json!({"name": "Second"})),
            StatusCode::CREATED,
        )
        .await;
    let second_repos = format!(
        "/v1/companies/{}/projects/{}/github/repositories",
        t.company,
        second["id"].as_str().unwrap()
    );
    let (status, _) = link(&format!("{second_repos}/{repository}"), &installation.to_string()).await;
    assert_eq!(status, StatusCode::CONFLICT, "a repository links to one project");

    // A signed, recent pull request opened becomes an event, once.
    let now = time::OffsetDateTime::now_utc();
    let count = |list: &[String], detail: &str| list.iter().filter(|d| d.as_str() == detail).count();
    let before = w.events(&org).await;
    let opened = pull_request("opened", false, installation, repository, 42, now);
    assert_eq!(
        github_delivery(&w, "pull_request", &delivery(), &opened, None).await,
        StatusCode::ACCEPTED
    );
    let after = w.events(&org).await;
    assert_eq!(
        count(&after, "fde.pull-request.opened.v1"),
        count(&before, "fde.pull-request.opened.v1") + 1
    );
    // Replayed: the same body under a new delivery id, or the same delivery id: nothing more.
    assert_eq!(
        github_delivery(&w, "pull_request", &delivery(), &opened, None).await,
        StatusCode::ACCEPTED
    );
    let again = w.events(&org).await;
    assert_eq!(again.len(), after.len(), "a replayed body is no new event");
    // Unsigned, wrongly signed, stale or for an unlinked repository: refused or dropped.
    let wrong = format!(
        "sha256={}",
        hmac_hex("another-secret-of-thirty-two-bytes!", &[opened.as_bytes()])
    );
    assert_eq!(
        github_delivery(&w, "pull_request", &delivery(), &opened, Some(&wrong)).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        github_delivery(&w, "pull_request", &delivery(), &opened, Some("")).await,
        StatusCode::UNAUTHORIZED
    );
    let stale = pull_request(
        "opened",
        false,
        installation,
        repository,
        43,
        now - time::Duration::hours(2),
    );
    assert_eq!(
        github_delivery(&w, "pull_request", &delivery(), &stale, None).await,
        StatusCode::BAD_REQUEST
    );
    let unlinked = pull_request("opened", false, installation, github_id(), 44, now);
    assert_eq!(
        github_delivery(&w, "pull_request", &delivery(), &unlinked, None).await,
        StatusCode::ACCEPTED
    );
    let closed = pull_request("closed", false, installation, repository, 45, now);
    assert_eq!(
        github_delivery(&w, "pull_request", &delivery(), &closed, None).await,
        StatusCode::ACCEPTED
    );
    assert_eq!(
        w.events(&org).await.len(),
        after.len(),
        "stale, unlinked or unmerged: no event"
    );
    let merged = pull_request("closed", true, installation, repository, 42, now);
    assert_eq!(
        github_delivery(&w, "pull_request", &delivery(), &merged, None).await,
        StatusCode::ACCEPTED
    );
    let merged_events = w.events(&org).await;
    assert_eq!(
        count(&merged_events, "fde.pull-request.merged.v1"),
        count(&after, "fde.pull-request.merged.v1") + 1
    );
    assert!(
        w.events(&other.org)
            .await
            .iter()
            .all(|d| !d.starts_with("fde.pull-request"))
    );

    // Repositories removed from the installation are unlinked once GitHub no longer lists them in
    // it, with one listing (one installation token) per delivery, however many it names.
    let extra = github_id();
    w.github
        .repositories
        .lock()
        .unwrap()
        .insert((installation, extra), "alpha/web".into());
    let (status, _) = link(&format!("{repos}/{extra}"), &installation.to_string()).await;
    assert_eq!(status, StatusCode::OK);
    let removed = json!({"action": "removed", "installation": {"id": installation},
        "repositories_removed": [{"id": repository}, {"id": extra}, {"id": theirs_repo.parse::<u64>().unwrap()}]})
    .to_string();
    let listings = || *w.github.listings.lock().unwrap();
    let before = listings();
    assert_eq!(
        github_delivery(&w, "installation_repositories", &delivery(), &removed, None).await,
        StatusCode::ACCEPTED
    );
    assert_eq!(listings(), before + 1, "one listing for the delivery");
    assert_eq!(
        w.ok(&t.lead, "GET", &repos, None, StatusCode::OK)
            .await
            .as_array()
            .unwrap()
            .len(),
        2,
        "GitHub still has them"
    );
    for r in [repository, extra] {
        w.github.repositories.lock().unwrap().remove(&(installation, r));
    }
    assert_eq!(
        github_delivery(&w, "installation_repositories", &delivery(), &removed, None).await,
        StatusCode::ACCEPTED
    );
    assert_eq!(listings(), before + 2);
    assert_eq!(w.ok(&t.lead, "GET", &repos, None, StatusCode::OK).await, json!([]));
    // Nothing of ours is linked any more: a delivery naming them asks GitHub nothing.
    assert_eq!(
        github_delivery(&w, "installation_repositories", &delivery(), &removed, None).await,
        StatusCode::ACCEPTED
    );
    assert_eq!(listings(), before + 2);

    // An installation deleted is unclaimed once GitHub confirms it, with every repository of it.
    let again_repo = github_id();
    w.github
        .repositories
        .lock()
        .unwrap()
        .insert((installation, again_repo), "alpha/api".into());
    let (status, _) = link(&format!("{repos}/{again_repo}"), &installation.to_string()).await;
    assert_eq!(status, StatusCode::OK);
    let deleted = json!({"action": "deleted", "installation": {"id": installation}}).to_string();
    assert_eq!(
        github_delivery(&w, "installation", &delivery(), &deleted, None).await,
        StatusCode::ACCEPTED
    );
    let listed = w
        .ok(&t.admin, "GET", "/v1/github/installations", None, StatusCode::OK)
        .await;
    assert_eq!(listed.as_array().unwrap().len(), 1, "GitHub says it is still installed");
    w.github.gone.lock().unwrap().push(installation);
    assert_eq!(
        github_delivery(&w, "installation", &delivery(), &deleted, None).await,
        StatusCode::ACCEPTED
    );
    assert_eq!(
        w.ok(&t.admin, "GET", "/v1/github/installations", None, StatusCode::OK)
            .await,
        json!([])
    );
    assert_eq!(w.ok(&t.lead, "GET", &repos, None, StatusCode::OK).await, json!([]));
    // The other organisation's installation and links are untouched.
    let theirs = format!(
        "/v1/companies/{}/projects/{}/github/repositories",
        other.company, other.project
    );
    assert_eq!(
        w.ok(&other.lead, "GET", &theirs, None, StatusCode::OK)
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

/// A Slack event to the webhook, signed with the signing secret at `ts` unless `signature` is given.
async fn slack_event(w: &World, body: &str, ts: i64, signature: Option<&str>) -> (StatusCode, Value) {
    let ts = ts.to_string();
    let sig = signature.map(str::to_owned).unwrap_or_else(|| {
        format!(
            "v0={}",
            hmac_hex(SIGNING_SECRET, &[format!("v0:{ts}:").as_bytes(), body.as_bytes()])
        )
    });
    let req = Request::post("/webhooks/slack")
        .header("content-type", "application/json")
        .header("x-slack-request-timestamp", ts)
        .header("x-slack-signature", sig)
        .body(Body::from(body.to_owned()))
        .unwrap();
    let (status, _, body) = w.send(req).await;
    (status, body)
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_slack_workspace_links_a_channel_and_an_uninstall_forgets_it() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "alpha").await;
    let other = company(&w, &new_id("org"), "gamma").await;
    let slack = format!("/v1/companies/{}/slack", t.company);
    let installed = w
        .ok(&t.lead, "GET", "/v1/slack/installation", None, StatusCode::OK)
        .await;
    assert_eq!(installed["team_id"], json!(slack_team(&org)));
    assert!(installed.get("secret_arn").is_none(), "the secret's ARN stays inside");
    let arn = FakeSecrets::arn(&org);
    assert!(
        w.secrets.secrets.lock().unwrap().contains_key(&arn),
        "the token is in Secrets Manager"
    );
    let linked = w.ok(&t.engineer, "GET", &slack, None, StatusCode::OK).await;
    assert_eq!(
        (&linked["channel_id"], &linked["channel_name"], &linked["team_id"]),
        (&json!(t.record("{channel}")), &json!("alpha"), &json!(slack_team(&org)))
    );
    let channels = w.ok(&t.lead, "GET", "/v1/slack/channels", None, StatusCode::OK).await;
    assert!(
        channels
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == json!(t.record("{channel}")))
    );

    // A channel must be one of the workspace's, and only who manages the company links it.
    let (_, body) = w
        .call(
            Some(&t.lead.token),
            "PUT",
            &slack,
            Some(json!({"channel_id": "C0NOTOURS"})),
        )
        .await;
    assert_eq!(body["error"], "invalid_channel");
    let (_, body) = w
        .call(
            Some(&t.lead.token),
            "PUT",
            &slack,
            Some(json!({"channel_id": "c lower"})),
        )
        .await;
    assert_eq!(body["error"], "invalid_channel");
    // A channel the bot isn't in is listed as such and can't be linked, since Slack would refuse
    // every post there; once the bot is invited, it links.
    let outside = format!("C{}", github_id());
    w.slack.channels.lock().unwrap().push(Channel {
        id: ChannelId::new(&outside).unwrap(),
        name: "outside".into(),
        is_member: false,
    });
    let channels = w.ok(&t.lead, "GET", "/v1/slack/channels", None, StatusCode::OK).await;
    let listed = channels
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == json!(outside))
        .cloned();
    assert_eq!(listed.map(|c| c["is_member"].clone()), Some(json!(false)));
    let (status, body) = w
        .call(Some(&t.lead.token), "PUT", &slack, Some(json!({"channel_id": outside})))
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::BAD_REQUEST, Some("bot_not_in_channel"))
    );
    assert_eq!(
        w.ok(&t.engineer, "GET", &slack, None, StatusCode::OK).await["channel_id"],
        json!(t.record("{channel}")),
        "the link is unchanged"
    );
    for c in w.slack.channels.lock().unwrap().iter_mut() {
        c.is_member |= c.id.as_str() == outside;
    }
    w.ok(
        &t.lead,
        "PUT",
        &slack,
        Some(json!({"channel_id": outside})),
        StatusCode::OK,
    )
    .await;
    let back = json!({"channel_id": t.record("{channel}")});
    w.ok(&t.lead, "PUT", &slack, Some(back), StatusCode::OK).await;
    let again = json!({"channel_id": t.record("{channel}")});
    assert_eq!(
        w.status(&t.engineer, "PUT", &slack, Some(again)).await,
        StatusCode::FORBIDDEN
    );
    // A Slack install's state is spent too.
    let started = w.ok(&t.admin, "POST", "/v1/slack/install", None, StatusCode::OK).await;
    let state = state_of(started["url"].as_str().unwrap());
    let code = new_id("slc");
    w.slack.codes.lock().unwrap().insert(
        code.clone(),
        (
            TeamId::new(&slack_team(&org)).unwrap(),
            BotToken::new("xoxb-again").unwrap(),
        ),
    );
    let claim = json!({"code": code, "state": state});
    w.ok(
        &t.admin,
        "POST",
        "/v1/slack/installation",
        Some(claim.clone()),
        StatusCode::OK,
    )
    .await;
    let (_, body) = w
        .call(Some(&t.admin.token), "POST", "/v1/slack/installation", Some(claim))
        .await;
    assert_eq!(body["error"], "invalid_state");
    // A workspace is one organisation's: another's install of it gets 409 and stores no token.
    let theirs_arn = FakeSecrets::arn(&other.org);
    let token_of = |arn: &str| {
        w.secrets
            .secrets
            .lock()
            .unwrap()
            .get(arn)
            .map(|t| t.expose().to_owned())
    };
    let before = token_of(&theirs_arn);
    let started = w
        .ok(&other.admin, "POST", "/v1/slack/install", None, StatusCode::OK)
        .await;
    let code = new_id("slc");
    w.slack.codes.lock().unwrap().insert(
        code.clone(),
        (
            TeamId::new(&slack_team(&org)).unwrap(),
            BotToken::new("xoxb-taken").unwrap(),
        ),
    );
    let claim = json!({"code": code, "state": state_of(started["url"].as_str().unwrap())});
    let (status, body) = w
        .call(Some(&other.admin.token), "POST", "/v1/slack/installation", Some(claim))
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::CONFLICT, Some("rejected_slack_team_claimed"))
    );
    assert_eq!(token_of(&theirs_arn), before, "their own token is untouched");
    assert!(
        w.secrets
            .secrets
            .lock()
            .unwrap()
            .values()
            .all(|t| t.expose() != "xoxb-taken"),
        "the claimed team's token is stored nowhere"
    );
    assert_eq!(
        w.ok(&other.lead, "GET", "/v1/slack/installation", None, StatusCode::OK)
            .await["team_id"],
        json!(slack_team(&other.org))
    );
    assert_eq!(
        w.ok(&t.lead, "GET", "/v1/slack/installation", None, StatusCode::OK)
            .await["team_id"],
        json!(slack_team(&org)),
        "the claim stays put"
    );

    // Slack's events: signed and recent only.
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let challenge = r#"{"type":"url_verification","challenge":"abc123"}"#;
    assert_eq!(
        slack_event(&w, challenge, now, None).await,
        (StatusCode::OK, json!({"challenge": "abc123"}))
    );
    assert_eq!(
        slack_event(&w, challenge, now, Some("v0=00")).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        slack_event(&w, challenge, now - 600, None).await.0,
        StatusCode::BAD_REQUEST
    );

    // Uninstalled: the workspace, its channel links and its token are gone; nobody else's are.
    let uninstalled = format!(
        r#"{{"type":"event_callback","team_id":"{}","event":{{"type":"app_uninstalled"}}}}"#,
        slack_team(&org)
    );
    assert_eq!(slack_event(&w, &uninstalled, now, None).await.0, StatusCode::OK);
    assert_eq!(
        w.ok(&t.lead, "GET", "/v1/slack/installation", None, StatusCode::OK)
            .await,
        Value::Null
    );
    assert_eq!(w.ok(&t.lead, "GET", &slack, None, StatusCode::OK).await, Value::Null);
    assert!(w.secrets.deleted.lock().unwrap().contains(&arn));
    assert!(!w.secrets.secrets.lock().unwrap().contains_key(&arn));
    let theirs = format!("/v1/companies/{}/slack", other.company);
    assert!(
        w.ok(&other.lead, "GET", &theirs, None, StatusCode::OK)
            .await
            .is_object()
    );
    // With no workspace, a channel cannot be linked.
    let (_, body) = w
        .call(
            Some(&t.lead.token),
            "PUT",
            &slack,
            Some(json!({"channel_id": t.record("{channel}")})),
        )
        .await;
    assert_eq!(body["error"], "invalid_slack");
}

/// `body` with `version` set to `v`.
fn versioned(body: &Value, v: &Value) -> Value {
    let mut b = body.clone();
    b["version"] = v.clone();
    b
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_save_based_on_an_old_version_is_refused_with_the_record_as_it_stands() {
    let w = world().await;
    let org = new_id("org");
    let t = company(&w, &org, "acme").await;
    let eng = &t.engineer;
    let base = format!("/v1/companies/{}", t.company);
    let p = format!("{base}/projects/{}", t.project);
    // Each whole-record PUT, with a create path and two different bodies it accepts.
    let kinds = [
        (
            format!("{p}/tasks"),
            t.record("{task}"),
            json!({"title": "Index tickets", "status": "todo"}),
            json!({"title": "Index all tickets", "status": "in_progress"}),
        ),
        (
            format!("{p}/access-requests"),
            t.record("{access_request}"),
            json!({"description": "VPN", "status": "requested"}),
            json!({"description": "VPN for two", "status": "in_progress"}),
        ),
        (
            format!("{base}/stakeholders"),
            t.record("{stakeholder}"),
            json!({"name": "Sam Lee"}),
            json!({"name": "Sam Leigh", "role": "sponsor"}),
        ),
        (
            format!("{base}/systems"),
            t.record("{system}"),
            json!({"name": "Zendesk"}),
            json!({"name": "Zendesk", "kind": "Ticketing"}),
        ),
        (
            format!("{p}/scope/items"),
            t.record("{item}"),
            json!({"kind": "in", "description": "Tier-1 tickets"}),
            json!({"kind": "in", "description": "Tier-1 and tier-2 tickets"}),
        ),
        (
            format!("{p}/scope/criteria"),
            t.record("{criterion}"),
            json!({"description": "Correct", "metric": "accuracy", "comparator": "at_least", "target": 90}),
            json!({"description": "Correct", "metric": "accuracy", "comparator": "at_least", "target": 95}),
        ),
    ];
    for (list, id, first, second) in &kinds {
        let path = format!("{list}/{id}");
        // No version: written as before, and the answer carries the version to send next.
        let saved = w.ok(eng, "PUT", &path, Some(first.clone()), StatusCode::OK).await;
        let v = saved["version"].as_u64().unwrap_or_else(|| panic!("{path}: {saved}"));
        // The same values with that version: nothing changes, not even the version.
        let same = w
            .ok(eng, "PUT", &path, Some(versioned(first, &json!(v))), StatusCode::OK)
            .await;
        assert_eq!(same, saved, "{path}");
        let moved = w
            .ok(eng, "PUT", &path, Some(versioned(second, &json!(v))), StatusCode::OK)
            .await;
        assert_eq!(moved["version"], v + 1, "{path}");
        // A save from before that change is refused with the record as it stands.
        let (status, body) = w
            .call(Some(&eng.token), "PUT", &path, Some(versioned(first, &json!(v))))
            .await;
        assert_eq!(
            (status, body),
            (
                StatusCode::CONFLICT,
                json!({"error": "stale_version", "current": moved})
            ),
            "{path}"
        );
        // A create has no version to name.
        let (status, body) = w
            .call(Some(&eng.token), "POST", list, Some(versioned(first, &json!(1))))
            .await;
        assert_eq!(
            (status, body["error"].as_str()),
            (StatusCode::BAD_REQUEST, Some("invalid_version")),
            "{list}"
        );
    }
    let tasks = w.ok(eng, "GET", &format!("{p}/tasks"), None, StatusCode::OK).await;
    let task = tasks.as_array().unwrap().iter().find(|x| x["id"] == t.record("{task}"));
    assert_eq!(
        task.unwrap()["title"],
        "Index all tickets",
        "the refused save changed nothing"
    );

    // A sign-off names the scope version the customer read.
    let scope = w.ok(eng, "GET", &format!("{p}/scope"), None, StatusCode::OK).await;
    let version = scope["version"].as_u64().unwrap();
    let sign = format!("{p}/scope/sign-offs");
    let stakeholder = t.record("{stakeholder}");
    let (status, body) = w
        .call(
            Some(&eng.token),
            "POST",
            &sign,
            Some(json!({"stakeholder": stakeholder, "version": version - 1})),
        )
        .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::CONFLICT,
            json!({"error": "stale_version", "current": scope})
        )
    );
    let signed = w
        .ok(
            eng,
            "POST",
            &sign,
            Some(json!({"stakeholder": stakeholder, "version": version})),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(signed["version"], version);
    // Saving an item as it is does not move the scope on, so the sign-off still covers it.
    let item = &scope["items"].as_array().unwrap()[0];
    let same = json!({"kind": item["kind"], "description": item["description"], "version": item["version"]});
    let path = format!("{p}/scope/items/{}", item["id"].as_str().unwrap());
    w.ok(eng, "PUT", &path, Some(same), StatusCode::OK).await;
    let scope = w.ok(eng, "GET", &format!("{p}/scope"), None, StatusCode::OK).await;
    assert_eq!(
        (scope["version"].as_u64(), scope["signed_off"].as_bool()),
        (Some(version), Some(true))
    );
}
