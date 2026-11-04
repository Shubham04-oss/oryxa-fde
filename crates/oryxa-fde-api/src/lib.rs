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
mod lifecycle;
mod projects;
mod records;

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
    use axum::routing::{post, put};
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
        .route(
            "/v1/companies/{company}/stakeholders",
            get(records::stakeholders).post(records::add_stakeholder),
        )
        .route(
            "/v1/companies/{company}/stakeholders/{stakeholder}",
            put(records::update_stakeholder).delete(records::remove_stakeholder),
        )
        .route(
            "/v1/companies/{company}/systems",
            get(records::systems).post(records::add_system),
        )
        .route(
            "/v1/companies/{company}/systems/{system}",
            put(records::update_system).delete(records::remove_system),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/stage",
            put(lifecycle::change_stage),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/scope",
            get(lifecycle::scope),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/scope/items",
            post(lifecycle::add_scope_item),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/scope/items/{item}",
            put(lifecycle::update_scope_item).delete(lifecycle::remove_scope_item),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/scope/criteria",
            post(lifecycle::add_criterion),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/scope/criteria/{criterion}",
            put(lifecycle::update_criterion).delete(lifecycle::remove_criterion),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/scope/sign-offs",
            post(lifecycle::sign_off),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/scope/changes",
            get(lifecycle::scope_changes),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/access-requests",
            get(lifecycle::access_requests).post(lifecycle::add_access_request),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/access-requests/{access_request}",
            put(lifecycle::update_access_request),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/tasks",
            get(lifecycle::tasks).post(lifecycle::add_task),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/tasks/{task}",
            put(lifecycle::update_task).delete(lifecycle::remove_task),
        )
        .route(
            "/v1/companies/{company}/projects/{project}/decisions",
            get(lifecycle::decisions).post(lifecycle::record_decision),
        )
        .route(
            "/v1/security-answers",
            get(records::security_answers).post(records::add_security_answer),
        )
        .route(
            "/v1/security-answers/{answer}",
            put(records::update_security_answer).delete(records::remove_security_answer),
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
        records::stakeholders,
        records::add_stakeholder,
        records::update_stakeholder,
        records::remove_stakeholder,
        records::systems,
        records::add_system,
        records::update_system,
        records::remove_system,
        records::security_answers,
        records::add_security_answer,
        records::update_security_answer,
        records::remove_security_answer,
        lifecycle::change_stage,
        lifecycle::scope,
        lifecycle::add_scope_item,
        lifecycle::update_scope_item,
        lifecycle::remove_scope_item,
        lifecycle::add_criterion,
        lifecycle::update_criterion,
        lifecycle::remove_criterion,
        lifecycle::sign_off,
        lifecycle::scope_changes,
        lifecycle::access_requests,
        lifecycle::add_access_request,
        lifecycle::update_access_request,
        lifecycle::tasks,
        lifecycle::add_task,
        lifecycle::update_task,
        lifecycle::remove_task,
        lifecycle::decisions,
        lifecycle::record_decision,
    ),
    modifiers(&Bearer),
    security(("bearer" = [])),
    tags(
        (name = "companies", description = "Customer companies and their members"),
        (name = "projects", description = "Projects and their assignees"),
        (name = "records", description = "Company stakeholders and systems; the organisation's security answers"),
        (name = "lifecycle", description = "A project's stage, scope, access requests, tasks and decisions"),
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
