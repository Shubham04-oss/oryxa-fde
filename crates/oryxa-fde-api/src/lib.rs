//! The FDE HTTP API. Every request carries a WorkOS access token (verified with `oryxa-authn`);
//! every handler checks `oryxa-authz` before it touches the store. A change that grants access
//! commits first and writes its SpiceDB grant after, under the lock of the row that justifies it;
//! a change that revokes access deletes the relationship before it commits (see `authz`).
//!
//! The router and the OpenAPI spec are built from one list of handlers ([`routes`]), so the spec,
//! and the isolation suite that walks it, name every route the API serves.

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
mod companies;
mod error;
mod lifecycle;
mod projects;
mod records;
pub mod session;
mod today;

pub use auth::{Principal, VerifyToken};
pub use authz::{reconcile_grants, run_reconciler};
pub use error::{ApiError, ErrorBody};
pub use session::{AuthKit, SignIn, Tokens, WorkOsAuthKit};

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
        .routes(routes!(companies::list, companies::create))
        .routes(routes!(companies::get, companies::update))
        .routes(routes!(companies::members))
        .routes(routes!(companies::set_member, companies::remove_member))
        .routes(routes!(projects::list, projects::create))
        .routes(routes!(projects::get, projects::update))
        .routes(routes!(projects::assignees))
        .routes(routes!(projects::assign, projects::unassign))
        .routes(routes!(records::stakeholders, records::add_stakeholder))
        .routes(routes!(records::update_stakeholder, records::remove_stakeholder))
        .routes(routes!(records::systems, records::add_system))
        .routes(routes!(records::update_system, records::remove_system))
        .routes(routes!(records::project_stakeholders))
        .routes(routes!(records::project_systems))
        .routes(routes!(lifecycle::change_stage))
        .routes(routes!(lifecycle::scope))
        .routes(routes!(lifecycle::add_scope_item))
        .routes(routes!(lifecycle::update_scope_item, lifecycle::remove_scope_item))
        .routes(routes!(lifecycle::add_criterion))
        .routes(routes!(lifecycle::update_criterion, lifecycle::remove_criterion))
        .routes(routes!(lifecycle::sign_off))
        .routes(routes!(lifecycle::scope_changes))
        .routes(routes!(lifecycle::access_requests, lifecycle::add_access_request))
        .routes(routes!(lifecycle::update_access_request))
        .routes(routes!(lifecycle::tasks, lifecycle::add_task))
        .routes(routes!(lifecycle::update_task, lifecycle::remove_task))
        .routes(routes!(lifecycle::decisions, lifecycle::record_decision))
        .routes(routes!(records::security_answers, records::add_security_answer))
        .routes(routes!(
            records::update_security_answer,
            records::remove_security_answer
        ))
        .routes(routes!(today::today))
        .routes(routes!(session::me))
        .routes(routes!(session::login))
        .routes(routes!(session::callback))
        .routes(routes!(session::logout))
}

pub fn router(app: Arc<App>) -> Router {
    let (router, _) = routes().split_for_parts();
    // Load balancer health check; reads nothing, so it is not in the spec.
    router
        .route("/healthz", get(|| async { "ok" }))
        .layer(middleware::from_fn_with_state(app.clone(), session::layer))
        .with_state(app)
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
    security(("bearer" = [])),
    tags(
        (name = "companies", description = "Customer companies and their members"),
        (name = "projects", description = "Projects and their assignees"),
        (name = "records", description = "Company stakeholders and systems; the organisation's security answers"),
        (name = "lifecycle", description = "A project's stage, scope, access requests, tasks and decisions"),
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
        api.components
            .get_or_insert_with(Default::default)
            .add_security_scheme("bearer", SecurityScheme::Http(scheme));
    }
}

/// RFC 3339 for API responses.
fn ts(t: time::OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
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
