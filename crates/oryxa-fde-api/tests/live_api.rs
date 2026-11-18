//! The API against a real SpiceDB and Postgres:
//!   docker run --rm -p 50051:50051 authzed/spicedb:v1.56.2 serve-testing
//!   docker run --rm -e POSTGRES_PASSWORD=oryxa -e POSTGRES_DB=oryxa_fde -p 55432:5432 pgvector/pgvector:pg17
//!   DATABASE_URL=postgres://postgres:oryxa@localhost:55432/oryxa_fde SPICEDB_ENDPOINT=http://localhost:50051 \
//!     cargo test -p oryxa-fde-api -- --ignored
//! Every test uses fresh tenants and its own SpiceDB datastore. The API connects as a fresh runtime
//! login; `DATABASE_URL`'s login is the owner, used only to read the sign-in limits.

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
use oryxa_fde_api::{App, SignIn, openapi, router};
use oryxa_fde_store::{Store, new_id, testing};
use oryxa_spicedb_proto::v1::{WriteSchemaRequest, schema_service_client::SchemaServiceClient};
use serde_json::{Value, json};
use tower::ServiceExt;

const SCHEMA: &str = include_str!("../../../schema/fde.zed");

const WEB: &str = "https://fde.test";

struct World {
    router: Router,
    store: Store,
    authz: SpiceDb,
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
    let authkit = Arc::new(support::FakeAuthKit::default());
    let password = format!("{}{}", new_id("x").replace("x_", ""), new_id("x").replace("x_", ""));
    let app = App::with_sign_in(
        store.clone(),
        authz.clone(),
        support::verifier(),
        sign_in_config(&authkit, &password),
    );
    World {
        router: router(app),
        store,
        authz,
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
    // A change sent with the cookie needs the web app's headers, both of them, from its origin.
    // Logout is the one such route left (#296); a refusal leaves the session as it was.
    let (status, _, body) = w.with_cookie(&session, "POST", "/auth/logout", None, false).await;
    assert_eq!((status, body["error"].as_str()), (StatusCode::FORBIDDEN, Some("csrf")));
    for (header, value) in [("x-oryxa-request", "1"), ("origin", WEB)] {
        // One of the two alone is not enough.
        let req = Request::post("/auth/logout")
            .header("cookie", format!("__Host-fde_session={session}"))
            .header(header, value)
            .body(Body::empty())
            .unwrap();
        assert_eq!(w.send(req).await.0, StatusCode::FORBIDDEN, "{header} alone");
    }
    let req = Request::post("/auth/logout")
        .header("cookie", format!("__Host-fde_session={session}"))
        .header("x-oryxa-request", "1")
        .header("origin", "https://evil.example")
        .body(Body::empty())
        .unwrap();
    assert_eq!(w.send(req).await.0, StatusCode::FORBIDDEN, "another origin");
    assert!(w.authkit.revoked.lock().unwrap().is_empty(), "nothing was signed out");
    // Each session is its own person; a bearer token wins over a cookie, and needs no web headers.
    let bob = user(&org, "bob", "member");
    let bob_session = w.session(&bob, &org).await;
    let (_, _, me) = w.with_cookie(&bob_session, "GET", "/v1/me", None, false).await;
    assert_eq!(me["user"]["id"], json!(bob.id));
    let req = Request::get("/v1/me")
        .header("authorization", format!("Bearer {}", alice.token))
        .header("cookie", format!("__Host-fde_session={bob_session}"))
        .body(Body::empty())
        .unwrap();
    let (status, _, me) = w.send(req).await;
    assert_eq!((status, me["user"]["id"].clone()), (StatusCode::OK, json!(alice.id)));

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
    let (status, headers, _) = w.with_cookie(&stale, "GET", "/v1/me", None, false).await;
    assert_eq!(status, StatusCode::OK);
    let renewed = set_cookie(&headers, "__Host-fde_session").unwrap();
    assert!(!renewed.is_empty() && renewed != stale);
    assert_eq!(
        w.with_cookie(&renewed, "GET", "/v1/me", None, false).await.0,
        StatusCode::OK
    );
    // A refresh AuthKit refuses ends the session.
    w.authkit.refresh_fails.store(true, Ordering::SeqCst);
    let (status, headers, _) = w.with_cookie(&stale, "GET", "/v1/me", None, false).await;
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

/// A password sign-in from the web app, as `client` (the address the Worker forwards).
fn password_sign_in(email: &str, password: &str, client: &str, cookie: Option<&str>) -> Request<Body> {
    let mut req = Request::post("/auth/sign-in/password")
        .header("origin", WEB)
        .header("x-oryxa-request", "1")
        .header("content-type", "application/json")
        .header("x-forwarded-for", format!("{client}, 10.0.0.2"))
        .header("user-agent", "Browser/1.0");
    if let Some(cookie) = cookie {
        req = req.header("cookie", cookie);
    }
    req.body(Body::from(
        json!({ "email": email, "password": password, "return_to": "/companies" }).to_string(),
    ))
    .unwrap()
}

/// A client address no earlier run has used.
fn fresh_client() -> String {
    let n: u64 = rand::random();
    format!("2001:db8::{:x}:{:x}", n >> 48, n & 0xffff)
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn a_password_sign_in_works_past_a_stale_session_and_is_limited_in_postgres() {
    let w = world().await;
    let org = new_id("org");
    let alice = user(&org, "alice", "member");
    *w.authkit.who.lock().unwrap() = (Some(org.clone()), alice.id.clone(), "member".into());
    let email = format!("{}@example.com", new_id("someone"));
    let client = fresh_client();

    // A cookie the session layer cannot use would answer 401 on any other POST; not here.
    let stale = "__Host-fde_session=not-a-session-any-more";
    let (status, headers, body) = w
        .send(password_sign_in(&email, "right password", &client, Some(stale)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "next": "done", "return_to": "/companies" }));
    let session = set_cookie(&headers, "__Host-fde_session").unwrap();
    assert_ne!(session, "not-a-session-any-more");
    let (status, _, me) = w.with_cookie(&session, "GET", "/v1/me", None, false).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["user"]["id"], alice.id.as_str());
    let seen = w.authkit.clients.lock().unwrap().clone();
    assert_eq!(seen.last().unwrap().ip.as_deref(), Some(client.as_str()));

    // Not from the web app: refused before anything else, with or without a cookie.
    let mut cross = password_sign_in(&email, "right password", &client, None);
    cross.headers_mut().remove("origin");
    assert_eq!(w.send(cross).await.0, StatusCode::FORBIDDEN);

    // Wrong passwords for one address: refused alike, then slowed for a window.
    for _ in 0..9 {
        let (status, _, body) = w.send(password_sign_in(&email, "wrong", &client, None)).await;
        assert_eq!(
            (status, body),
            (StatusCode::UNAUTHORIZED, json!({ "error": "invalid_credentials" }))
        );
    }
    let tries = w.authkit.clients.lock().unwrap().len();
    let (status, headers, body) = w.send(password_sign_in(&email, "right password", &client, None)).await;
    assert_eq!(
        (status, body),
        (StatusCode::TOO_MANY_REQUESTS, json!({ "error": "too_many_attempts" }))
    );
    let wait: u64 = headers["retry-after"].to_str().unwrap().parse().unwrap();
    assert!((1..=300).contains(&wait), "{wait}");
    assert_eq!(w.authkit.clients.lock().unwrap().len(), tries, "WorkOS was not asked");

    // Another address is not slowed by it.
    let other = format!("{}@example.com", new_id("other"));
    let (status, _, _) = w
        .send(password_sign_in(&other, "right password", &fresh_client(), None))
        .await;
    assert_eq!(status, StatusCode::OK);

    // What the counters hold: a kind and a keyed hash, never the address or the client.
    let admin = testing::admin().await;
    let rows: Vec<String> = sqlx::query_scalar("select bucket from sign_in_limits")
        .fetch_all(&admin)
        .await
        .unwrap();
    assert!(!rows.is_empty());
    for b in &rows {
        assert!(!b.contains('@') && !b.contains(&email) && !b.contains(&client), "{b}");
    }
}

/// A sign-in POST from the web app to `path`, as `client`.
fn sign_in_post(path: &str, body: Value, client: &str, cookie: Option<&str>) -> Request<Body> {
    let mut req = Request::post(path)
        .header("origin", WEB)
        .header("x-oryxa-request", "1")
        .header("content-type", "application/json")
        .header("x-forwarded-for", client)
        .header("user-agent", "Browser/1.0");
    if let Some(cookie) = cookie {
        req = req.header("cookie", cookie);
    }
    req.body(Body::from(body.to_string())).unwrap()
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn an_emailed_code_signs_in_and_asking_for_codes_is_limited_per_address() {
    let w = world().await;
    let org = new_id("org");
    let alice = user(&org, "alice", "member");
    *w.authkit.who.lock().unwrap() = (Some(org.clone()), alice.id.clone(), "member".into());
    let email = format!("{}@example.com", new_id("someone"));
    let client = fresh_client();

    // Three codes an address per window; the fourth is refused and sends nothing.
    for _ in 0..3 {
        let (status, _, body) = w
            .send(sign_in_post(
                "/auth/sign-in/code",
                json!({ "email": email }),
                &client,
                None,
            ))
            .await;
        assert_eq!((status, body), (StatusCode::OK, json!({ "next": "enter_code" })));
    }
    let sent = w.authkit.clients.lock().unwrap().len();
    let (status, headers, body) = w
        .send(sign_in_post(
            "/auth/sign-in/code",
            json!({ "email": email }),
            &fresh_client(),
            None,
        ))
        .await;
    assert_eq!(
        (status, body),
        (StatusCode::TOO_MANY_REQUESTS, json!({ "error": "too_many_attempts" }))
    );
    assert!(headers.contains_key("retry-after"));
    assert_eq!(w.authkit.clients.lock().unwrap().len(), sent, "nothing more was sent");

    // The code signs in, whatever stale cookie the browser still has.
    let stale = "__Host-fde_session=not-a-session-any-more";
    let verify = |code: &str| {
        sign_in_post(
            "/auth/sign-in/code/verify",
            json!({ "email": email, "code": code, "return_to": "/companies" }),
            &client,
            Some(stale),
        )
    };
    let (status, _, body) = w.send(verify("999999")).await;
    assert_eq!(
        (status, body),
        (StatusCode::UNAUTHORIZED, json!({ "error": "invalid_code" }))
    );
    let (status, headers, body) = w.send(verify("000000")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "next": "done", "return_to": "/companies" }));
    let session = set_cookie(&headers, "__Host-fde_session").unwrap();
    let (status, _, me) = w.with_cookie(&session, "GET", "/v1/me", None, false).await;
    assert_eq!((status, me["user"]["id"].clone()), (StatusCode::OK, json!(alice.id)));

    // Resending a verification code needs a pending verification.
    let (status, _, body) = w
        .send(sign_in_post(
            "/auth/sign-in/verify-email/resend",
            json!({}),
            &client,
            None,
        ))
        .await;
    assert_eq!(
        (status, body),
        (StatusCode::BAD_REQUEST, json!({ "error": "invalid_sign_in" }))
    );
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn an_invitation_is_accepted_at_its_own_address_and_a_reset_signs_nobody_in() {
    let w = world().await;
    let org = new_id("org");
    let invited = user(&org, "invited", "member");
    *w.authkit.who.lock().unwrap() = (Some(org.clone()), invited.id.clone(), "member".into());
    let client = fresh_client();

    let (status, _, body) = w
        .send(sign_in_post(
            "/auth/invitation",
            json!({ "token": "invite-ok" }),
            &client,
            None,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["email"], "invited@example.com");
    let (status, _, body) = w
        .send(sign_in_post(
            "/auth/invitation",
            json!({ "token": "invite-gone" }),
            &client,
            None,
        ))
        .await;
    assert_eq!(
        (status, body),
        (StatusCode::BAD_REQUEST, json!({ "error": "invalid_invitation" }))
    );

    // The body cannot name another address; the account is made for the invitation's own.
    let smuggled = json!({ "token": "invite-ok", "password": "a long new password", "email": "x@example.com" });
    let (status, _, _) = w
        .send(sign_in_post("/auth/invitation/accept", smuggled, &client, None))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let accept = json!({ "token": "invite-ok", "password": "a long new password", "first_name": "Ada",
        "return_to": "/companies" });
    let stale = "__Host-fde_session=not-a-session-any-more";
    let (status, headers, body) = w
        .send(sign_in_post("/auth/invitation/accept", accept, &client, Some(stale)))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({ "next": "done", "return_to": "/companies" }));
    assert_eq!(*w.authkit.created.lock().unwrap(), ["invited@example.com"]);
    let session = set_cookie(&headers, "__Host-fde_session").unwrap();
    let (status, _, me) = w.with_cookie(&session, "GET", "/v1/me", None, false).await;
    assert_eq!((status, me["user"]["id"].clone()), (StatusCode::OK, json!(invited.id)));

    // A forgotten password answers the same for any address; a reset sets no session.
    for email in ["invited@example.com", &format!("{}@example.com", new_id("nobody"))] {
        let (status, _, body) = w
            .send(sign_in_post(
                "/auth/password/forgot",
                json!({ "email": email }),
                &client,
                None,
            ))
            .await;
        assert_eq!((status, body), (StatusCode::OK, json!({ "next": "check_email" })));
    }
    // A session from before the reset, whose access token has expired: it refreshes, so it works.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let before = workos::helpers::session::seal(
        &json!({
            "purpose": "fde_session",
            "access_token": support::token_for(Some(&org), &invited.id, "member", -60),
            "refresh_token": format!("refresh|{org}|{}|member", invited.id),
            "user": invited.id, "organisation": org, "signed_in": now - 120,
        }),
        &w.password,
    )
    .unwrap();
    assert_eq!(
        w.with_cookie(&before, "GET", "/v1/me", None, false).await.0,
        StatusCode::OK
    );

    let reset = |token: &str| json!({ "token": token, "password": "another long password" });
    let (status, headers, body) = w
        .send(sign_in_post("/auth/password/reset", reset("reset-ok"), &client, None))
        .await;
    assert_eq!((status, body), (StatusCode::OK, json!({ "next": "sign_in" })));
    assert!(set_cookie(&headers, "__Host-fde_session").is_none());
    // The reset revoked the person's sessions: the one from before it no longer works.
    assert!(
        w.authkit
            .revoked
            .lock()
            .unwrap()
            .contains(&format!("session_of_{}", invited.id))
    );
    assert_eq!(
        w.with_cookie(&before, "GET", "/v1/me", None, false).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, _, body) = w
        .send(sign_in_post(
            "/auth/password/reset",
            reset("reset-spent"),
            &client,
            None,
        ))
        .await;
    assert_eq!(
        (status, body),
        (StatusCode::BAD_REQUEST, json!({ "error": "invalid_reset_token" }))
    );
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

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn sign_in_refuses_bad_return_paths_states_and_codes() {
    let w = world().await;
    let org = new_id("org");
    // A redirect route: a return_to that is not one of our paths sends the person home instead.
    *w.authkit.who.lock().unwrap() = (Some(org.clone()), "user_r".into(), "member".into());
    // Each value is percent-encoded into the query, so the type sees it as written here.
    let encoded = |v: &str| -> String {
        v.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
                b => format!("%{b:02X}"),
            })
            .collect()
    };
    for bad in [
        "//evil.example",
        "/\t/evil.example",
        "/%09/evil.example",
        "https://evil.example",
        "/\\evil",
        "/%5C%5Cevil",
        "companies",
        "/.//evil.example",
        "/%2e//evil.example",
        "/%2F/evil.example",
        "/%2Fevil.example/../../x",
        "/%252F/evil.example",
        "/\u{FF0F}evil.example",
    ] {
        let (status, headers, _) = w
            .send(
                Request::get(format!("/auth/login?return_to={}", encoded(bad)))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(status, StatusCode::FOUND, "{bad}");
        let location = headers["location"].to_str().unwrap();
        let state = location.split("state=").nth(1).unwrap().split('&').next().unwrap();
        let pending = set_cookie(&headers, "__Host-fde_signin").unwrap();
        let req = Request::get(format!("/auth/callback?code=code-{state}&state={state}"))
            .header("cookie", format!("__Host-fde_signin={pending}"))
            .body(Body::empty())
            .unwrap();
        let (status, headers, _) = w.send(req).await;
        let to = headers.get("location").and_then(|l| l.to_str().ok());
        assert_eq!((status, to), (StatusCode::FOUND, Some("/")), "{bad}");
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
    // A user in no organisation gets no session, and goes to the page that tells them so.
    let (status, headers, _) = w.sign_in_as(None, "user_y", "member").await;
    assert_eq!(
        (status, headers.get("location").and_then(|l| l.to_str().ok())),
        (StatusCode::FOUND, Some("/sign-in?error=no_organisation"))
    );
    assert_eq!(set_cookie(&headers, "__Host-fde_session"), None);
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
    // A sign-in cookie whose return_to is not ours, however it was made, sends the person home.
    let (state, pending) = start_sign_in(&w).await;
    let mut forged: Value = workos::helpers::session::unseal(&pending, &w.password).unwrap();
    forged["return_to"] = json!("/.//evil.example");
    let forged = workos::helpers::session::seal(&forged, &w.password).unwrap();
    let req = Request::get(format!("/auth/callback?code=code-{state}&state={state}"))
        .header("cookie", format!("__Host-fde_signin={forged}"))
        .body(Body::empty())
        .unwrap();
    let (status, headers, _) = w.send(req).await;
    assert_eq!(
        (status, headers.get("location").and_then(|l| l.to_str().ok())),
        (StatusCode::FOUND, Some("/"))
    );
    assert_eq!(
        set_cookie(&headers, "__Host-fde_signin").as_deref(),
        Some(""),
        "cleared"
    );
    // Its sealing was valid, so the person is signed in, only somewhere else than it named.
    assert!(
        set_cookie(&headers, "__Host-fde_session").is_some_and(|c| !c.is_empty()),
        "session set"
    );
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
            // Not from the web app's origin: refused before anything else.
            "/auth/sign-in/password"
            | "/auth/sign-in/verify-email"
            | "/auth/sign-in/organisation"
            | "/auth/sign-in/code"
            | "/auth/sign-in/code/verify"
            | "/auth/sign-in/verify-email/resend"
            | "/auth/invitation"
            | "/auth/invitation/accept"
            | "/auth/password/forgot"
            | "/auth/password/reset" => StatusCode::FORBIDDEN,
            _ => StatusCode::UNAUTHORIZED,
        };
        assert_eq!(status, want, "{method} {template}");
    }
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn bad_tokens_are_refused() {
    let w = world().await;
    let org = new_id("org");
    let alice = user(&org, "alice", "member");
    assert_eq!(w.call(None, "GET", "/v1/me", None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        w.call(Some("not.a.jwt"), "GET", "/v1/me", None).await.0,
        StatusCode::UNAUTHORIZED
    );
    // Valid token, but no organisation selected.
    let (status, body) = w
        .call(Some(&support::token(None, "user_x", "member")), "GET", "/v1/me", None)
        .await;
    assert_eq!(
        (status, body["error"].as_str()),
        (StatusCode::FORBIDDEN, Some("no_organisation"))
    );
    // An organisation id that is not a valid tenant id.
    let bad_org = support::token(Some("org|other"), "user_x", "member");
    assert_eq!(
        w.call(Some(&bad_org), "GET", "/v1/me", None).await.0,
        StatusCode::UNAUTHORIZED
    );
    // An expired token.
    let expired = support::token_for(Some(&org), &alice.id, "member", -3600);
    assert_eq!(
        w.call(Some(&expired), "GET", "/v1/me", None).await.0,
        StatusCode::UNAUTHORIZED
    );
    // And a good one.
    let me = w.ok(&alice, "GET", "/v1/me", None, StatusCode::OK).await;
    assert_eq!(
        (me["user"]["id"].as_str(), me["organisation"]["id"].as_str()),
        (Some(alice.id.as_str()), Some(org.as_str()))
    );
}

/// Whether `user` of `org` has `permission` on the tenant's workspace, as SpiceDB answers now.
async fn on_workspace(w: &World, org: &str, user: &str, permission: &'static str) -> bool {
    let tenant = TenantId::new(org).unwrap();
    let item = oryxa_authz::CheckItem {
        resource: oryxa_authz::ObjectRef::new(&tenant, "workspace", "root"),
        permission,
        subject: oryxa_authz::SubjectRef::object(oryxa_authz::ObjectRef::new(&tenant, "user", user)),
        context: None,
    };
    w.authz
        .check(&tenant, &item, &oryxa_authz::Consistency::FullyConsistent)
        .await
        .unwrap()
        .allowed()
}

#[tokio::test]
#[ignore = "needs SpiceDB and Postgres (SPICEDB_ENDPOINT, DATABASE_URL)"]
async fn the_tokens_role_is_mirrored_onto_the_workspace_on_any_replica() {
    let w = world().await;
    let other = w.replica();
    let org = new_id("org");
    let dana = format!("user_dana_{}", new_id("u"));
    let token = |role: &str| support::token(Some(&org), &dana, role);

    // A member reaches the workspace but does not manage it.
    let (status, me) = w.call_on(&other, Some(&token("member")), "GET", "/v1/me", None).await;
    assert_eq!((status, me["role"].as_str()), (StatusCode::OK, Some("member")));
    assert!(on_workspace(&w, &org, &dana, "access").await);
    assert!(!on_workspace(&w, &org, &dana, "manage").await);
    // Promoted, here through this replica: an admin, and no longer a member.
    let (status, me) = w.call(Some(&token("admin")), "GET", "/v1/me", None).await;
    assert_eq!((status, me["role"].as_str()), (StatusCode::OK, Some("admin")));
    assert!(on_workspace(&w, &org, &dana, "manage").await);
    // Demoted, on the replica that saw the promotion: a role it did not mirror last is mirrored at once.
    // (A read on the other one trusts its own last mirror, member, for up to ROLE_TTL.)
    w.call(Some(&token("member")), "GET", "/v1/me", None).await;
    assert!(!on_workspace(&w, &org, &dana, "manage").await);
    assert!(on_workspace(&w, &org, &dana, "access").await);
    // Any other role (a customer's guest) holds nothing on the workspace.
    w.call(Some(&token("guest")), "GET", "/v1/me", None).await;
    assert!(!on_workspace(&w, &org, &dana, "access").await);
}
