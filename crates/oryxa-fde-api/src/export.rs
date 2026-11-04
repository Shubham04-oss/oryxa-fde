//! A company's records as one JSON document, for the customer to keep. Needs `manage` on the
//! company. Read in one read-only transaction of that company's scope, so it is one moment of it
//! and holds nothing of another company. Documents are listed by their metadata; their bytes stay
//! in S3.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use oryxa_fde_core::CompanyId;
use serde::Serialize;
use utoipa::ToSchema;

use crate::authz::company;
use crate::companies::CompanyOut;
use crate::documents::DocumentOut;
use crate::lifecycle::{AccessRequestOut, DecisionOut, ScopeOut, TaskOut};
use crate::projects::ProjectOut;
use crate::records::{StakeholderOut, SystemOut};
use crate::{ApiError, App, ErrorBody, Principal, ts};

#[derive(Debug, Serialize, ToSchema)]
pub struct ExportOut {
    pub exported_at: String,
    pub company: CompanyOut,
    pub stakeholders: Vec<StakeholderOut>,
    pub systems: Vec<SystemOut>,
    /// Metadata only; the files stay where they are.
    pub documents: Vec<DocumentOut>,
    pub projects: Vec<ProjectExport>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ProjectExport {
    pub project: ProjectOut,
    pub scope: ScopeOut,
    pub access_requests: Vec<AccessRequestOut>,
    pub tasks: Vec<TaskOut>,
    pub decisions: Vec<DecisionOut>,
}

/// The company's records as one JSON document: the company, its stakeholders, systems and
/// documents (metadata), and each project with its scope, access requests, tasks and decisions.
#[utoipa::path(get, operation_id = "export_company", path = "/v1/companies/{company}/export", tag = "companies",
    params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = ExportOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn export(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
) -> Result<Json<ExportOut>, ApiError> {
    let s = who.company(c);
    app.require(&who, company(&s), "manage").await?;
    let exported_at = ts(time::OffsetDateTime::now_utc());
    let mut tx = app.store.company_snapshot(&s).await?;
    let found = tx.get().await?.ok_or(ApiError::NotFound)?;
    let stakeholders = tx.stakeholders().await?;
    let systems = tx.systems().await?;
    let documents = tx.documents().await?;
    let mut projects = Vec::new();
    for p in tx.projects().await? {
        let mut ptx = tx.into_project(p.id.clone());
        let scope = ptx.scope_of_work().await?.ok_or(ApiError::NotFound)?;
        let access_requests = ptx.access_requests().await?;
        let tasks = ptx.tasks().await?;
        let decisions = ptx.decisions().await?;
        tx = ptx.into_company();
        projects.push(ProjectExport {
            project: p.into(),
            scope: scope.into(),
            access_requests: access_requests.into_iter().map(Into::into).collect(),
            tasks: tasks.into_iter().map(Into::into).collect(),
            decisions: decisions.into_iter().map(Into::into).collect(),
        });
    }
    tx.commit().await?;
    Ok(Json(ExportOut {
        exported_at,
        company: found.into(),
        stakeholders: stakeholders.into_iter().map(Into::into).collect(),
        systems: systems.into_iter().map(Into::into).collect(),
        documents: documents.into_iter().map(Into::into).collect(),
        projects,
    }))
}
