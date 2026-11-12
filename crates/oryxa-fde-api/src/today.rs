//! The caller's Today view: open tasks and unsettled access requests across every project they
//! work on, each with its company and project. The projects come from SpiceDB (`work` on each),
//! so an assignee sees their own projects and nothing else of those companies.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use oryxa_fde_store::{Named, TodayItem};
use serde::Serialize;
use utoipa::ToSchema;

use crate::lifecycle::{AccessRequestOut, TaskOut};
use crate::session::NamedOut;
use crate::{ApiError, App, ErrorBody, Principal};

/// Something that needs the FDE, tagged by `kind`.
#[derive(Debug, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TodayItemOut {
    /// A task that is not done.
    Task {
        task: TaskOut,
        company: NamedOut,
        project: NamedOut,
    },
    /// An access request that is not granted, with the name of the stakeholder who owns it.
    AccessRequest {
        access: AccessRequestOut,
        owner: Option<String>,
        company: NamedOut,
        project: NamedOut,
    },
}

/// A project, with its company.
#[derive(Debug, Serialize, ToSchema)]
pub struct ProjectRefOut {
    pub company: NamedOut,
    pub project: NamedOut,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct TodayOut {
    pub items: Vec<TodayItemOut>,
    /// The caller's projects with no next step: every task is done, or there are none. An engagement
    /// with no next step needs one, or is over (direction section 4).
    // ponytail: always sent, but optional in the spec until the web's fixtures carry it.
    #[schema(required = false)]
    pub projects_without_next_step: Vec<ProjectRefOut>,
}

fn named<T: std::fmt::Display>(n: Named<T>) -> NamedOut {
    NamedOut {
        id: n.id.to_string(),
        name: n.name.as_str().to_owned(),
    }
}

impl TodayItemOut {
    /// The item, or the project it marks as having no next step.
    fn of(i: TodayItem) -> Result<Self, ProjectRefOut> {
        Ok(match i {
            TodayItem::Task { task, company, project } => TodayItemOut::Task {
                task: task.into(),
                company: named(company),
                project: named(project),
            },
            TodayItem::AccessRequest {
                access,
                owner,
                company,
                project,
            } => TodayItemOut::AccessRequest {
                access: access.into(),
                owner: owner.map(|o| o.as_str().to_owned()),
                company: named(company),
                project: named(project),
            },
            TodayItem::NoNextStep { company, project } => {
                return Err(ProjectRefOut {
                    company: named(company),
                    project: named(project),
                });
            }
        })
    }
}

/// What needs the caller across their projects: projects with no next step, open tasks and
/// unsettled access requests.
#[utoipa::path(get, operation_id = "get_today", path = "/v1/today", tag = "projects",
    responses((status = 200, body = TodayOut), (status = 401, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn today(State(app): State<Arc<App>>, who: Principal) -> Result<Json<TodayOut>, ApiError> {
    let projects = app.projects_for(&who).await?;
    let scopes = app.store.project_scopes(&who.tenant, &projects).await?;
    let mut out = TodayOut {
        items: Vec::new(),
        projects_without_next_step: Vec::new(),
    };
    for item in app.store.today(&scopes).await? {
        match TodayItemOut::of(item) {
            Ok(i) => out.items.push(i),
            Err(p) => out.projects_without_next_step.push(p),
        }
    }
    Ok(Json(out))
}
