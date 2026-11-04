//! Browser sign-in and the session cookie (the platform's web contract). `/auth/login` sends the
//! browser to WorkOS AuthKit with a state and a PKCE challenge, kept in a short-lived sealed
//! cookie; `/auth/callback` checks the state, exchanges the code with the PKCE verifier and sets
//! `__Host-fde_session`, sealed (AES-256-GCM) with the WorkOS access and refresh tokens. No token
//! reaches JavaScript.
//!
//! A request that carries the session cookie and no bearer token is authenticated from it: the
//! access token is verified like a bearer token (refreshed through WorkOS when it has expired),
//! and the request then goes through the same `Principal` and permission checks. A cookie request
//! that changes anything must also prove it comes from the web app (`X-Oryxa-Request: 1` and the
//! app's `Origin`), or it is refused as cross-site.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Query, Request, State};
use axum::http::header::{AUTHORIZATION, COOKIE, LOCATION, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use oryxa_authn::JwtError;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::{ApiError, App, BoxFuture, ErrorBody, Principal};

pub const SESSION_COOKIE: &str = "__Host-fde_session";
const SIGN_IN_COOKIE: &str = "__Host-fde_signin";
/// How long a sign-in may take between `/auth/login` and `/auth/callback`.
const SIGN_IN_TTL: Duration = Duration::from_secs(10 * 60);
/// A session ends this long after sign-in, however often its access token is refreshed.
pub const SESSION_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
const CSRF_HEADER: &str = "x-oryxa-request";
const NAME_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_RETURN_TO: usize = 2048;

/// Tokens from a code exchange or a refresh.
#[derive(Clone)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
}

/// WorkOS as sign-in needs it. A trait so tests run without WorkOS.
pub trait AuthKit: Send + Sync + 'static {
    /// Where to send the browser to sign in.
    fn authorization_url(&self, state: &str, code_challenge: &str, redirect_uri: &str) -> Result<String, String>;
    fn exchange_code<'a>(&'a self, code: &'a str, code_verifier: &'a str) -> BoxFuture<'a, Result<Tokens, String>>;
    fn refresh<'a>(&'a self, refresh_token: &'a str, organisation: &'a str) -> BoxFuture<'a, Result<Tokens, String>>;
    /// Ends the WorkOS session, so its refresh token stops working.
    fn revoke<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Result<(), String>>;
    fn user_name<'a>(&'a self, user: &'a str) -> BoxFuture<'a, Result<String, String>>;
    fn organisation_name<'a>(&'a self, organisation: &'a str) -> BoxFuture<'a, Result<String, String>>;
}

/// AuthKit through the pinned WorkOS SDK.
pub struct WorkOsAuthKit(pub workos::Client);

impl AuthKit for WorkOsAuthKit {
    fn authorization_url(&self, state: &str, code_challenge: &str, redirect_uri: &str) -> Result<String, String> {
        let mut p = workos::user_management::GetAuthorizationUrlParams::new(redirect_uri);
        p.provider = Some(workos::enums::UserManagementAuthenticationProvider::Authkit);
        p.state = Some(state.to_owned());
        p.code_challenge = Some(code_challenge.to_owned());
        p.code_challenge_method = Some("S256".into());
        self.0
            .user_management()
            .get_authorization_url(p)
            .map_err(|e| e.to_string())
    }

    fn exchange_code<'a>(&'a self, code: &'a str, code_verifier: &'a str) -> BoxFuture<'a, Result<Tokens, String>> {
        Box::pin(async move {
            let mut p = workos::user_management::AuthenticateWithCodeParams::new(code);
            p.code_verifier = Some(code_verifier.into());
            let r = self
                .0
                .user_management()
                .authenticate_with_code(p)
                .await
                .map_err(|e| e.to_string())?;
            Ok(Tokens {
                access_token: r.access_token.expose().to_owned(),
                refresh_token: r.refresh_token.expose().to_owned(),
            })
        })
    }

    fn refresh<'a>(&'a self, refresh_token: &'a str, organisation: &'a str) -> BoxFuture<'a, Result<Tokens, String>> {
        Box::pin(async move {
            let mut p = workos::user_management::AuthenticateWithRefreshTokenParams::new(refresh_token);
            p.organization_id = Some(organisation.to_owned());
            let r = self
                .0
                .user_management()
                .authenticate_with_refresh_token(p)
                .await
                .map_err(|e| e.to_string())?;
            Ok(Tokens {
                access_token: r.access_token.expose().to_owned(),
                refresh_token: r.refresh_token.expose().to_owned(),
            })
        })
    }

    fn revoke<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let body = workos::models::RevokeSession {
                session_id: session_id.to_owned(),
            };
            self.0
                .user_management()
                .revoke_session(workos::user_management::RevokeSessionParams::new(body))
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn user_name<'a>(&'a self, user: &'a str) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let u = self
                .0
                .user_management()
                .get_user(user)
                .await
                .map_err(|e| e.to_string())?;
            let name = [u.first_name.as_deref(), u.last_name.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            Ok(if name.trim().is_empty() { u.email } else { name })
        })
    }

    fn organisation_name<'a>(&'a self, organisation: &'a str) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let o = self
                .0
                .organizations()
                .get_organization(organisation)
                .await
                .map_err(|e| e.to_string())?;
            Ok(o.name)
        })
    }
}

/// Sign-in configuration: the web app's origin (`WEB_ORIGIN`), the cookie sealing password
/// (`SESSION_PASSWORD`, 64 hex characters) and AuthKit.
pub struct SignIn {
    web_origin: String,
    password: String,
    authkit: Arc<dyn AuthKit>,
    names: Mutex<HashMap<String, (String, Instant)>>,
}

impl SignIn {
    pub fn new(
        web_origin: impl Into<String>,
        password: impl Into<String>,
        authkit: Arc<dyn AuthKit>,
    ) -> Result<Self, String> {
        let web_origin = web_origin.into().trim_end_matches('/').to_owned();
        let password = password.into();
        let origin = url::Url::parse(&web_origin).map_err(|_| "WEB_ORIGIN is not a URL".to_owned())?;
        if origin.scheme() != "https" && origin.host_str() != Some("localhost") {
            return Err("WEB_ORIGIN must be https".into());
        }
        if origin.origin().ascii_serialization() != web_origin {
            return Err("WEB_ORIGIN must be an origin, with no path".into());
        }
        if password.len() != 64 || !password.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("SESSION_PASSWORD must be 64 hex characters".into());
        }
        Ok(Self {
            web_origin,
            password,
            authkit,
            names: Mutex::new(HashMap::new()),
        })
    }

    fn redirect_uri(&self) -> String {
        format!("{}/auth/callback", self.web_origin)
    }

    /// A cookie request that changes something must come from the web app itself.
    fn same_site(&self, headers: &HeaderMap) -> bool {
        headers.get(CSRF_HEADER).is_some_and(|v| v == "1")
            && headers
                .get(ORIGIN)
                .is_some_and(|v| v.as_bytes() == self.web_origin.as_bytes())
    }

    fn seal<T: Serialize>(&self, data: &T) -> Result<String, ApiError> {
        workos::helpers::session::seal(data, &self.password).map_err(|_| ApiError::Internal)
    }

    fn unseal<T: for<'de> Deserialize<'de>>(&self, sealed: &str) -> Option<T> {
        workos::helpers::session::unseal(sealed, &self.password).ok()
    }

    /// A display name, cached for a few minutes.
    async fn name(&self, key: String, look_up: BoxFuture<'_, Result<String, String>>) -> Result<String, ApiError> {
        if let Some((name, at)) = self.names.lock().unwrap_or_else(|e| e.into_inner()).get(&key)
            && at.elapsed() < NAME_TTL
        {
            return Ok(name.clone());
        }
        let name = look_up.await.map_err(|e| {
            tracing::error!(error = %e, "workos lookup failed");
            ApiError::Unavailable
        })?;
        let mut names = self.names.lock().unwrap_or_else(|e| e.into_inner());
        names.retain(|_, (_, at)| at.elapsed() < NAME_TTL);
        names.insert(key, (name.clone(), Instant::now()));
        Ok(name)
    }
}

/// The sign-in in progress, sealed in its own cookie between login and callback.
#[derive(Serialize, Deserialize)]
struct SignInState {
    purpose: String,
    state: String,
    verifier: String,
    return_to: String,
    expires: u64,
}

/// What the session cookie holds.
#[derive(Serialize, Deserialize)]
pub(crate) struct Session {
    purpose: String,
    access_token: String,
    refresh_token: String,
    /// The user and organisation signed in; a refresh must keep both.
    user: String,
    organisation: String,
    /// When the user signed in, in Unix seconds.
    signed_in: u64,
}

const SIGN_IN_PURPOSE: &str = "fde_sign_in";
const SESSION_PURPOSE: &str = "fde_session";

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn cookie_value<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(name)?.strip_prefix('='))
}

fn set_cookie(name: &str, value: &str, max_age: Duration) -> HeaderValue {
    let v = format!(
        "{name}={value}; Path=/; Max-Age={}; Secure; HttpOnly; SameSite=Lax",
        max_age.as_secs()
    );
    // Sealed values are base64, which is always a valid header value.
    HeaderValue::from_str(&v).unwrap_or_else(|_| HeaderValue::from_static("invalid=; Max-Age=0"))
}

fn clear_cookie(name: &str) -> HeaderValue {
    set_cookie(name, "", Duration::ZERO)
}

/// A same-origin path to return to after sign-in: `/` then anything but a second `/` or `\`, no
/// control characters or whitespace, and nothing that resolves to another origin.
pub(crate) fn safe_return_to(raw: &str) -> Option<String> {
    let ok = raw.starts_with('/')
        && !raw.starts_with("//")
        && raw.len() <= MAX_RETURN_TO
        && !raw.contains('\\')
        && !raw.chars().any(|c| c.is_control() || c.is_whitespace());
    if !ok {
        return None;
    }
    let base = url::Url::parse("https://fde.invalid/").ok()?;
    let resolved = base.join(raw).ok()?;
    (resolved.origin() == base.origin()).then(|| raw.to_owned())
}

/// The session behind a cookie request, as the handlers see it.
#[derive(Clone)]
pub(crate) struct CookieSession {
    /// The WorkOS session id, to revoke on logout.
    session_id: String,
}

/// Authenticates a request from its session cookie when it carries no bearer token. See the
/// module docs; a cookie that cannot be used is cleared.
pub(crate) async fn layer(State(app): State<Arc<App>>, mut req: Request, next: Next) -> Response {
    if req.headers().contains_key(AUTHORIZATION) {
        return next.run(req).await;
    }
    let Some(sealed) = cookie_value(req.headers(), SESSION_COOKIE).map(str::to_owned) else {
        return next.run(req).await;
    };
    let Some(sign_in) = app.sign_in.as_ref() else {
        return ApiError::Unauthorized.into_response();
    };
    // Checked before the token: a cross-site request never reaches a refresh.
    if !matches!(*req.method(), Method::GET | Method::HEAD) && !sign_in.same_site(req.headers()) {
        return ApiError::Csrf.into_response();
    }
    match resume(&app, sign_in, &sealed).await {
        Ok((token, session_id, reissued)) => {
            let Ok(bearer) = HeaderValue::from_str(&format!("Bearer {token}")) else {
                return ApiError::Unauthorized.into_response();
            };
            req.headers_mut().insert(AUTHORIZATION, bearer);
            req.extensions_mut().insert(CookieSession { session_id });
            let mut resp = next.run(req).await;
            if let Some(cookie) = reissued {
                resp.headers_mut().append(SET_COOKIE, cookie);
            }
            resp
        }
        Err(e) => {
            // A dependency outage is not the cookie's fault; anything else makes it useless.
            let clear = !matches!(e, ApiError::Unavailable);
            let mut resp = e.into_response();
            if clear {
                resp.headers_mut().append(SET_COOKIE, clear_cookie(SESSION_COOKIE));
            }
            resp
        }
    }
}

/// The access token of a session, refreshed if it has expired: the token, the WorkOS session id
/// and, after a refresh, the cookie to set.
async fn resume(app: &App, sign_in: &SignIn, sealed: &str) -> Result<(String, String, Option<HeaderValue>), ApiError> {
    let s: Session = sign_in.unseal(sealed).ok_or(ApiError::Unauthorized)?;
    if s.purpose != SESSION_PURPOSE || now().saturating_sub(s.signed_in) >= SESSION_TTL.as_secs() {
        return Err(ApiError::Unauthorized);
    }
    match app.tokens.claims(&s.access_token).await {
        Ok(c) if c.sub == s.user && c.org_id.as_deref() == Some(s.organisation.as_str()) => {
            Ok((s.access_token, c.sid, None))
        }
        Ok(_) => Err(ApiError::Unauthorized),
        Err(JwtError::Rejected(jsonwebtoken_kind)) if is_expiry(&jsonwebtoken_kind) => {
            let t = sign_in
                .authkit
                .refresh(&s.refresh_token, &s.organisation)
                .await
                .map_err(|e| {
                    tracing::info!(error = %e, "session refresh refused");
                    ApiError::Unauthorized
                })?;
            let c = app
                .tokens
                .claims(&t.access_token)
                .await
                .map_err(|_| ApiError::Unauthorized)?;
            if c.sub != s.user || c.org_id.as_deref() != Some(s.organisation.as_str()) {
                return Err(ApiError::Unauthorized);
            }
            let renewed = Session {
                access_token: t.access_token.clone(),
                refresh_token: t.refresh_token,
                ..s
            };
            let left = SESSION_TTL.saturating_sub(Duration::from_secs(now().saturating_sub(renewed.signed_in)));
            let cookie = set_cookie(SESSION_COOKIE, &sign_in.seal(&renewed)?, left);
            Ok((t.access_token, c.sid, Some(cookie)))
        }
        Err(JwtError::Keys(e)) => {
            tracing::error!(error = %e, "could not load WorkOS signing keys");
            Err(ApiError::Unavailable)
        }
        Err(_) => Err(ApiError::Unauthorized),
    }
}

fn is_expiry(kind: &impl std::fmt::Debug) -> bool {
    // jsonwebtoken's ErrorKind is not re-exported by oryxa-authn; its Debug name is stable.
    format!("{kind:?}") == "ExpiredSignature"
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct LoginParams {
    /// Where to go after sign-in: a path on the web app, e.g. `/companies`. Defaults to `/`.
    pub return_to: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct CallbackParams {
    pub code: String,
    pub state: String,
}

/// Start sign-in: redirects to WorkOS AuthKit.
#[utoipa::path(get, operation_id = "sign_in", path = "/auth/login", tag = "auth", params(LoginParams),
    security(()),
    responses((status = 302, description = "To WorkOS AuthKit"), (status = 400, body = ErrorBody),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn login(State(app): State<Arc<App>>, Query(p): Query<LoginParams>) -> Result<Response, ApiError> {
    let sign_in = app.sign_in.as_ref().ok_or(ApiError::Unavailable)?;
    let return_to = safe_return_to(p.return_to.as_deref().unwrap_or("/")).ok_or(ApiError::Invalid("return_to"))?;
    let pkce = workos::helpers::pkce::generate_pkce_pair().map_err(|_| ApiError::Internal)?;
    let state = workos::helpers::pkce::generate_code_verifier(None).map_err(|_| ApiError::Internal)?;
    let url = sign_in
        .authkit
        .authorization_url(&state, &pkce.code_challenge, &sign_in.redirect_uri())
        .map_err(|e| {
            tracing::error!(error = %e, "authorization url");
            ApiError::Unavailable
        })?;
    let pending = SignInState {
        purpose: SIGN_IN_PURPOSE.into(),
        state,
        verifier: pkce.code_verifier,
        return_to,
        expires: now() + SIGN_IN_TTL.as_secs(),
    };
    let cookie = set_cookie(SIGN_IN_COOKIE, &sign_in.seal(&pending)?, SIGN_IN_TTL);
    let location = HeaderValue::from_str(&url).map_err(|_| ApiError::Internal)?;
    Ok((StatusCode::FOUND, [(LOCATION, location), (SET_COOKIE, cookie)]).into_response())
}

/// Finish sign-in: sets the session cookie and redirects to where sign-in started.
#[utoipa::path(get, operation_id = "sign_in_callback", path = "/auth/callback", tag = "auth", params(CallbackParams),
    security(()),
    responses((status = 302, description = "Signed in; to the page sign-in started from"),
        (status = 400, body = ErrorBody), (status = 401, body = ErrorBody), (status = 403, body = ErrorBody)))]
pub(crate) async fn callback(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Query(p): Query<CallbackParams>,
) -> Result<Response, ApiError> {
    let sign_in = app.sign_in.as_ref().ok_or(ApiError::Unavailable)?;
    let pending: SignInState = cookie_value(&headers, SIGN_IN_COOKIE)
        .and_then(|c| sign_in.unseal(c))
        .filter(|s: &SignInState| s.purpose == SIGN_IN_PURPOSE && s.expires > now())
        .ok_or(ApiError::Invalid("sign_in"))?;
    // Constant time: the state is the only thing tying this callback to its login.
    let same = pending.state.len() == p.state.len()
        && pending
            .state
            .bytes()
            .zip(p.state.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0;
    if !same {
        return Err(ApiError::Invalid("state"));
    }
    let tokens = sign_in
        .authkit
        .exchange_code(&p.code, &pending.verifier)
        .await
        .map_err(|e| {
            tracing::info!(error = %e, "code exchange refused");
            ApiError::Unauthorized
        })?;
    let claims = app
        .tokens
        .claims(&tokens.access_token)
        .await
        .map_err(|_| ApiError::Unauthorized)?;
    let organisation = claims.org_id.ok_or(ApiError::NoOrganisation)?;
    let session = Session {
        purpose: SESSION_PURPOSE.into(),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user: claims.sub,
        organisation,
        signed_in: now(),
    };
    let location = HeaderValue::from_str(&pending.return_to).map_err(|_| ApiError::Internal)?;
    let mut resp = (StatusCode::FOUND, [(LOCATION, location)]).into_response();
    let h = resp.headers_mut();
    h.append(
        SET_COOKIE,
        set_cookie(SESSION_COOKIE, &sign_in.seal(&session)?, SESSION_TTL),
    );
    h.append(SET_COOKIE, clear_cookie(SIGN_IN_COOKIE));
    Ok(resp)
}

/// Sign out: ends the WorkOS session and clears the cookie.
#[utoipa::path(post, operation_id = "sign_out", path = "/auth/logout", tag = "auth",
    responses((status = 204, description = "Signed out"), (status = 401, body = ErrorBody),
        (status = 403, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn logout(
    State(app): State<Arc<App>>,
    session: Option<axum::Extension<CookieSession>>,
) -> Result<Response, ApiError> {
    let sign_in = app.sign_in.as_ref().ok_or(ApiError::Unavailable)?;
    let axum::Extension(session) = session.ok_or(ApiError::Unauthorized)?;
    let revoked = sign_in.authkit.revoke(&session.session_id).await;
    // The cookie goes either way; a session WorkOS still holds is reported, not hidden.
    let mut resp = match revoked {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            tracing::error!(error = %e, "workos session revoke failed");
            ApiError::Unavailable.into_response()
        }
    };
    resp.headers_mut().append(SET_COOKIE, clear_cookie(SESSION_COOKIE));
    Ok(resp)
}

#[derive(Debug, Serialize, ToSchema)]
pub struct NamedOut {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OrgRole {
    Admin,
    Member,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MeOut {
    pub user: NamedOut,
    pub organisation: NamedOut,
    /// The caller's WorkOS role in the organisation.
    pub role: OrgRole,
}

/// Who is signed in.
#[utoipa::path(get, operation_id = "get_me", path = "/v1/me", tag = "auth",
    responses((status = 200, body = MeOut), (status = 401, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn me(State(app): State<Arc<App>>, who: Principal) -> Result<Json<MeOut>, ApiError> {
    let sign_in = app.sign_in.as_ref().ok_or(ApiError::Unavailable)?;
    let (u, o) = (who.user.to_string(), who.tenant.to_string());
    let user = sign_in.name(format!("user:{u}"), sign_in.authkit.user_name(&u)).await?;
    let organisation = sign_in
        .name(format!("org:{o}"), sign_in.authkit.organisation_name(&o))
        .await?;
    Ok(Json(MeOut {
        user: NamedOut {
            id: u.clone(),
            name: user,
        },
        organisation: NamedOut {
            id: o.clone(),
            name: organisation,
        },
        role: if who.admin { OrgRole::Admin } else { OrgRole::Member },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn return_to_must_be_a_same_origin_path() {
        for ok in ["/", "/companies", "/companies/cmp_1?tab=scope#top", "/a%20b"] {
            assert_eq!(safe_return_to(ok).as_deref(), Some(ok), "{ok}");
        }
        for bad in [
            "",
            "companies",
            "//evil.example",
            "/\\evil.example",
            "/\t/evil.example",
            "/\n/x",
            "https://evil.example/",
            "/ /x",
            "/\u{7f}",
            &format!("/{}", "a".repeat(MAX_RETURN_TO)),
        ] {
            assert_eq!(safe_return_to(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn cookies_are_found_by_exact_name() {
        let mut h = HeaderMap::new();
        h.append(
            COOKIE,
            HeaderValue::from_static("a=1; __Host-fde_session=abc; x__Host-fde_signin=no"),
        );
        h.append(COOKIE, HeaderValue::from_static("__Host-fde_signin=def"));
        assert_eq!(cookie_value(&h, SESSION_COOKIE), Some("abc"));
        assert_eq!(cookie_value(&h, SIGN_IN_COOKIE), Some("def"));
        assert_eq!(cookie_value(&h, "missing"), None);
    }

    #[test]
    fn session_cookies_are_host_only_secure_and_http_only() {
        let c = set_cookie(SESSION_COOKIE, "v", SESSION_TTL);
        assert_eq!(
            c.to_str().unwrap(),
            "__Host-fde_session=v; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Lax"
        );
        assert!(clear_cookie(SESSION_COOKIE).to_str().unwrap().contains("Max-Age=0"));
    }

    #[test]
    fn sign_in_configuration_is_checked() {
        struct None_;
        impl AuthKit for None_ {
            fn authorization_url(&self, _: &str, _: &str, _: &str) -> Result<String, String> {
                Err("unused".into())
            }
            fn exchange_code<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<Tokens, String>> {
                Box::pin(async { Err("unused".into()) })
            }
            fn refresh<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<Tokens, String>> {
                Box::pin(async { Err("unused".into()) })
            }
            fn revoke<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
                Box::pin(async { Err("unused".into()) })
            }
            fn user_name<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<String, String>> {
                Box::pin(async { Err("unused".into()) })
            }
            fn organisation_name<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<String, String>> {
                Box::pin(async { Err("unused".into()) })
            }
        }
        let k = || -> Arc<dyn AuthKit> { Arc::new(None_) };
        let pw = "a".repeat(64);
        assert!(SignIn::new("https://fde.example", pw.clone(), k()).is_ok());
        assert!(
            SignIn::new("https://fde.example/", pw.clone(), k()).is_ok(),
            "a trailing slash is trimmed"
        );
        for origin in ["http://fde.example", "https://fde.example/app", "not a url"] {
            assert!(SignIn::new(origin, pw.clone(), k()).is_err(), "{origin}");
        }
        for bad in ["short", &"z".repeat(64)] {
            assert!(SignIn::new("https://fde.example", bad, k()).is_err());
        }
    }
}
