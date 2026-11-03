//! The FDE HTTP API. Every request carries a WorkOS access token (verified with `oryxa-authn`);
//! every handler checks `oryxa-authz` before it touches the store, and writes the SpiceDB
//! relationships its change implies before the store transaction commits.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::routing::get;
use oryxa_authz::SpiceDb;
use oryxa_core::{TenantId, UserId};
use oryxa_fde_store::Store;
use utoipa::OpenApi;
use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};

pub mod auth;
mod authz;
mod companies;
mod error;
mod projects;

pub use auth::{Principal, VerifyToken};
pub use error::{ApiError, ErrorBody};

pub struct App {
    pub store: Store,
    pub authz: SpiceDb,
    tokens: Box<dyn VerifyToken>,
    // ponytail: per-process and unbounded; fine for P0's user counts, move to Postgres if it grows.
    synced: Mutex<HashSet<(TenantId, UserId, bool)>>,
}

impl App {
    pub fn new(store: Store, authz: SpiceDb, tokens: impl VerifyToken) -> Arc<Self> {
        Arc::new(Self {
            store,
            authz,
            tokens: Box::new(tokens),
            synced: Mutex::new(HashSet::new()),
        })
    }
}

pub fn router(app: Arc<App>) -> Router {
    use axum::routing::put;
    Router::new()
        .route("/v1/companies", get(companies::list).post(companies::create))
        .route("/v1/companies/{company}", get(companies::get).patch(companies::rename))
        .route("/v1/companies/{company}/members", get(companies::members))
        .route(
            "/v1/companies/{company}/members/{user}",
            put(companies::set_member).delete(companies::remove_member),
        )
        .route(
            "/v1/companies/{company}/projects",
            get(projects::list).post(projects::create),
        )
        .route(
            "/v1/companies/{company}/projects/{project}",
            get(projects::get).patch(projects::rename),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/assignees",
            get(projects::assignees),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/assignees/{user}",
            put(projects::assign).delete(projects::unassign),
        )
        // Load balancer health check; reads nothing.
        .route("/healthz", get(|| async { "ok" }))
        .with_state(app)
}

#[derive(OpenApi)]
#[openapi(
    info(title = "oryxa-fde-api", version = "0.1.0", description = "The FDE workspace API."),
    paths(
        companies::list,
        companies::create,
        companies::get,
        companies::rename,
        companies::members,
        companies::set_member,
        companies::remove_member,
        projects::list,
        projects::create,
        projects::get,
        projects::rename,
        projects::assignees,
        projects::assign,
        projects::unassign,
    ),
    modifiers(&Bearer),
    security(("bearer" = [])),
    tags(
        (name = "companies", description = "Customer companies and their members"),
        (name = "projects", description = "Projects and their assignees"),
    )
)]
pub struct ApiDoc;

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
    use super::*;

    const SPEC: &str = "openapi.json";

    /// The committed spec must match the code. Regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p oryxa-fde-api openapi`.
    #[test]
    fn openapi_spec_is_committed_and_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SPEC);
        let spec = ApiDoc::openapi().to_pretty_json().unwrap() + "\n";
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
    fn operation_ids_are_unique() {
        let spec = serde_json::to_value(ApiDoc::openapi()).unwrap();
        let mut seen = HashSet::new();
        for item in spec["paths"].as_object().unwrap().values() {
            for op in item.as_object().unwrap().values() {
                let id = op["operationId"].as_str().unwrap();
                assert!(seen.insert(id.to_owned()), "duplicate operationId {id}");
            }
        }
    }
}
