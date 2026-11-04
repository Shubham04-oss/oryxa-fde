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

#[derive(Debug, Serialize, ToSchema)]
pub struct TodayOut {
    pub items: Vec<TodayItemOut>,
}

fn named<T: std::fmt::Display>(n: Named<T>) -> NamedOut {
    NamedOut {
        id: n.id.to_string(),
        name: n.name.as_str().to_owned(),
    }
}

impl From<TodayItem> for TodayItemOut {
    fn from(i: TodayItem) -> Self {
        match i {
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
        }
    }
}

/// What needs the caller across their projects: open tasks and unsettled access requests.
#[utoipa::path(get, operation_id = "get_today", path = "/v1/today", tag = "projects",
    responses((status = 200, body = TodayOut), (status = 401, body = ErrorBody)))]
pub(crate) async fn today(State(app): State<Arc<App>>, who: Principal) -> Result<Json<TodayOut>, ApiError> {
    let projects = app.projects_for(&who).await?;
    let scopes = app.store.project_scopes(&who.tenant, &projects).await?;
    let items = app.store.today(&scopes).await?;
    Ok(Json(TodayOut {
        items: items.into_iter().map(Into::into).collect(),
    }))
}
