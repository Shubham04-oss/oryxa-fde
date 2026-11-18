//! The FDE HTTP API, down to sign-in (#296): the WorkOS hosted flow and our own sign-in screens'
//! routes, the session cookie, sign-out and `/v1/me`. Every request carries a WorkOS access token
//! (verified with `oryxa-authn`) or the session cookie that holds one; the token's role is mirrored
//! onto the tenant's SpiceDB workspace through `oryxa-authz` (see `auth`).
//!
//! The router and the OpenAPI spec are built from one list of handlers ([`routes`]), so the spec
//! names every route the API serves.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::Router;
use axum::middleware;
use axum::routing::get;
use oryxa_authz::SpiceDb;
use oryxa_fde_store::Store;
use utoipa::OpenApi;
use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
use utoipa_axum::router::OpenApiRouter;
use utoipa_axum::routes;

pub mod auth;
mod authz;
mod error;
pub mod health;
pub mod session;
pub mod shutdown;
mod signin;

pub use auth::{Principal, VerifyToken};
pub use error::{ApiError, ErrorBody};
pub use session::{
    Attempt, AuthKit, Client, Created, Invitation, ProviderId, RefreshError, Reset, Sent, SignIn, Tokens,
    WorkOsAuthKit, workos_issuer,
};

pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub struct App {
    pub store: Store,
    pub authz: SpiceDb,
    tokens: Box<dyn VerifyToken>,
    roles: auth::RoleCache,
    /// Browser sign-in; without it only bearer tokens are accepted.
    sign_in: Option<SignIn>,
}

impl App {
    pub fn new(store: Store, authz: SpiceDb, tokens: impl VerifyToken) -> Arc<Self> {
        Self::make(store, authz, tokens, None)
    }

    /// With browser sign-in and the session cookie.
    pub fn with_sign_in(store: Store, authz: SpiceDb, tokens: impl VerifyToken, sign_in: SignIn) -> Arc<Self> {
        Self::make(store, authz, tokens, Some(sign_in))
    }

    fn make(store: Store, authz: SpiceDb, tokens: impl VerifyToken, sign_in: Option<SignIn>) -> Arc<Self> {
        Arc::new(Self {
            store,
            authz,
            tokens: Box::new(tokens),
            roles: auth::RoleCache::default(),
            sign_in,
        })
    }
}

/// Every documented route, each registered with axum and the spec at once.
fn routes() -> OpenApiRouter<Arc<App>> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(session::me))
        .routes(routes!(session::login))
        .routes(routes!(session::callback))
        .routes(routes!(session::logout))
        .routes(routes!(signin::password))
        .routes(routes!(signin::verify_email))
        .routes(routes!(signin::choose_organisation))
        .routes(routes!(signin::code))
        .routes(routes!(signin::code_verify))
        .routes(routes!(signin::resend))
        .routes(routes!(signin::invitation))
        .routes(routes!(signin::accept))
        .routes(routes!(signin::forgot))
        .routes(routes!(signin::reset))
}

pub fn router(app: Arc<App>) -> Router {
    let (router, _) = routes().split_for_parts();
    // The container health check (`oryxa-fde-ops healthcheck`); reads nothing, so it is not in the spec.
    router
        .route(health::HEALTH_PATH, get(|| async { "ok" }))
        .with_state(app.clone())
        .layer(middleware::from_fn_with_state(app, session::layer))
}

/// The spec of exactly the routes [`router`] serves.
pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut api = routes().split_for_parts().1;
    // OpenAPI 3.1 requires a description on every response; default to the status's reason phrase.
    for item in api.paths.paths.values_mut() {
        let ops = [
            &mut item.get,
            &mut item.put,
            &mut item.post,
            &mut item.delete,
            &mut item.patch,
        ];
        for op in ops.into_iter().flatten() {
            for (code, response) in &mut op.responses.responses {
                if let utoipa::openapi::RefOr::T(r) = response
                    && r.description.is_empty()
                {
                    r.description = code
                        .parse::<u16>()
                        .ok()
                        .and_then(|c| axum::http::StatusCode::from_u16(c).ok())
                        .and_then(|c| c.canonical_reason())
                        .unwrap_or("Response")
                        .to_owned();
                }
            }
        }
    }
    api
}

/// The spec's info, security and tags; [`routes`] adds the paths.
#[derive(OpenApi)]
#[openapi(
    info(title = "oryxa-fde-api", version = "0.1.0", description = "The FDE workspace API."),
    modifiers(&Bearer),
    security(("bearer" = []), ("session" = [])),
    tags(
        (name = "auth", description = "Browser sign-in, the session cookie and who is signed in"),
    )
)]
struct ApiDoc;

struct Bearer;

impl utoipa::Modify for Bearer {
    fn modify(&self, api: &mut utoipa::openapi::OpenApi) {
        let scheme = HttpBuilder::new()
            .scheme(HttpAuthScheme::Bearer)
            .bearer_format("WorkOS access token")
            .build();
        let components = api.components.get_or_insert_with(Default::default);
        components.add_security_scheme("bearer", SecurityScheme::Http(scheme));
        let mut cookie = utoipa::openapi::security::ApiKeyValue::new(session::SESSION_COOKIE);
        cookie.description = Some(
            "The browser session from /auth/callback. A request carrying it, and no bearer token, that is not \
             GET or HEAD must also send `X-Oryxa-Request: 1` and the web app's `Origin`, or it gets \
             403 {\"error\":\"csrf\"}. While WorkOS cannot refresh an expired session, any request may get \
             503 {\"error\":\"unavailable\"}: the cookie is kept, and the same request works once WorkOS answers."
                .into(),
        );
        components.add_security_scheme(
            "session",
            SecurityScheme::ApiKey(utoipa::openapi::security::ApiKey::Cookie(cookie)),
        );
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    const SPEC: &str = "openapi.json";

    /// The committed spec must match the code. Regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p oryxa-fde-api openapi`.
    #[test]
    fn openapi_spec_is_committed_and_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SPEC);
        let spec = openapi().to_pretty_json().unwrap() + "\n";
        if std::env::var_os("UPDATE_OPENAPI").is_some() {
            std::fs::write(&path, &spec).unwrap();
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            committed == spec,
            "{SPEC} is out of date: run `UPDATE_OPENAPI=1 cargo test -p oryxa-fde-api openapi` and commit it"
        );
    }

    #[test]
    fn every_response_has_a_description() {
        let spec = serde_json::to_value(openapi()).unwrap();
        for (path, item) in spec["paths"].as_object().unwrap() {
            for (method, op) in item.as_object().unwrap() {
                for (code, r) in op["responses"].as_object().unwrap() {
                    assert!(r["description"].is_string(), "{method} {path} {code}");
                }
            }
        }
    }

    #[test]
    fn operation_ids_are_unique() {
        let spec = serde_json::to_value(openapi()).unwrap();
        let mut seen = HashSet::new();
        for item in spec["paths"].as_object().unwrap().values() {
            for op in item.as_object().unwrap().values() {
                let id = op["operationId"].as_str().unwrap();
                assert!(seen.insert(id.to_owned()), "duplicate operationId {id}");
            }
        }
    }
}
