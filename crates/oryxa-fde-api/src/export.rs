//! A company's records as one JSON document, for the customer to keep. Needs `manage` on the
//! company. Read in one read-only transaction of that company's scope, so it is one moment of it
//! and holds nothing of another company. Documents are listed by their metadata; their bytes stay
//! in S3.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use oryxa_fde_core::CompanyId;
use oryxa_fde_store::PlanTx;
use serde::Serialize;
use utoipa::ToSchema;

use crate::authz::company;
use crate::companies::CompanyOut;
use crate::documents::DocumentOut;
use crate::engine::UpdateOut;
use crate::lifecycle::{AccessRequestOut, DecisionOut, ScopeOut, TaskOut};
use crate::meetings::MeetingNoteOut;
use crate::projects::ProjectOut;
use crate::records::{StakeholderOut, SystemOut};
use crate::threads::ThreadWithComments;
use crate::{ApiError, App, ErrorBody, Principal, ts};

#[derive(Debug, Serialize, ToSchema)]
pub struct ExportOut {
    pub exported_at: String,
    pub company: CompanyOut,
    pub stakeholders: Vec<StakeholderOut>,
    pub systems: Vec<SystemOut>,
    /// Metadata only; the files stay where they are.
    pub documents: Vec<DocumentOut>,
    /// The company's own threads, each with its comments, and meeting notes.
    pub threads: Vec<ThreadWithComments>,
    pub meeting_notes: Vec<MeetingNoteOut>,
    pub projects: Vec<ProjectExport>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ProjectExport {
    pub project: ProjectOut,
    pub scope: ScopeOut,
    pub access_requests: Vec<AccessRequestOut>,
    pub tasks: Vec<TaskOut>,
    pub decisions: Vec<DecisionOut>,
    /// The weekly updates, newest first, drafts included.
    pub updates: Vec<UpdateOut>,
    pub threads: Vec<ThreadWithComments>,
    pub meeting_notes: Vec<MeetingNoteOut>,
}

/// A place's threads, each with its comments, and its meeting notes.
async fn planning(tx: &mut PlanTx) -> Result<(Vec<ThreadWithComments>, Vec<MeetingNoteOut>), ApiError> {
    let mut threads = Vec::new();
    // ponytail: one query per thread for its comments; paging threads is a filed follow-up (#75).
    for t in tx.threads(None).await? {
        let comments = tx.comments(&t.id).await?.unwrap_or_default();
        threads.push(ThreadWithComments {
            thread: t.into(),
            comments: comments.into_iter().map(Into::into).collect(),
        });
    }
    let notes = tx.meeting_notes().await?.into_iter().map(Into::into).collect();
    Ok((threads, notes))
}

/// The company's records as one JSON document: the company, its stakeholders, systems and
/// documents (metadata), and each project with its scope, access requests, tasks, decisions and
/// weekly updates; and the threads (with comments) and meeting notes of the company and of each
/// project. What the engine derives from events (activity, suggestions) and the canvases are left
/// out.
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
    let mut place = PlanTx::from(tx);
    let (threads, meeting_notes) = planning(&mut place).await?;
    let mut tx = place.into_company();
    let mut projects = Vec::new();
    for p in tx.projects().await? {
        let mut ptx = tx.into_project(p.id.clone());
        let scope = ptx.scope_of_work().await?.ok_or(ApiError::NotFound)?;
        let access_requests = ptx.access_requests().await?;
        let tasks = ptx.tasks().await?;
        let decisions = ptx.decisions().await?;
        let updates = ptx.update_drafts().await?;
        let mut place = PlanTx::from(ptx);
        let (project_threads, project_notes) = planning(&mut place).await?;
        tx = place.into_company();
        projects.push(ProjectExport {
            project: p.into(),
            scope: scope.into(),
            access_requests: access_requests.into_iter().map(Into::into).collect(),
            tasks: tasks.into_iter().map(Into::into).collect(),
            decisions: decisions.into_iter().map(Into::into).collect(),
            updates: updates.into_iter().map(Into::into).collect(),
            threads: project_threads,
            meeting_notes: project_notes,
        });
    }
    tx.commit().await?;
    Ok(Json(ExportOut {
        exported_at,
        company: found.into(),
        stakeholders: stakeholders.into_iter().map(Into::into).collect(),
        systems: systems.into_iter().map(Into::into).collect(),
        documents: documents.into_iter().map(Into::into).collect(),
        threads,
        meeting_notes,
        projects,
    }))
}
