//! Read-only views of one project for callers other than the HTTP routes, such as the MCP server
//! for coding agents. Each checks `work` on the project before it reads, runs under the project's
//! `ProjectScope`, and returns what the matching route returns.

use oryxa_fde_context::SearchQuery;
use oryxa_fde_core::{CompanyId, ProjectId};

use crate::documents::{SearchHitOut, project_search};
use crate::lifecycle::{DecisionOut, ScopeOut, TaskOut, project_tx};
use crate::{ApiError, App, Principal};

/// The project's scope, success criteria and latest sign-off.
pub async fn scope(app: &App, who: &Principal, c: CompanyId, p: ProjectId) -> Result<ScopeOut, ApiError> {
    let mut tx = project_tx(app, who, c, p).await?;
    let scope = tx.scope_of_work().await?.ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(scope.into())
}

/// The project's decisions log, newest first.
pub async fn decisions(app: &App, who: &Principal, c: CompanyId, p: ProjectId) -> Result<Vec<DecisionOut>, ApiError> {
    let mut tx = project_tx(app, who, c, p).await?;
    let list = tx.decisions().await?;
    tx.commit().await?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// The project's tasks.
pub async fn tasks(app: &App, who: &Principal, c: CompanyId, p: ProjectId) -> Result<Vec<TaskOut>, ApiError> {
    let mut tx = project_tx(app, who, c, p).await?;
    let list = tx.tasks().await?;
    tx.commit().await?;
    Ok(list.into_iter().map(Into::into).collect())
}

/// Passages from the documents of the project's company.
pub async fn search(
    app: &App,
    who: &Principal,
    c: CompanyId,
    p: ProjectId,
    q: &SearchQuery,
    limit: usize,
) -> Result<Vec<SearchHitOut>, ApiError> {
    project_search(app, who, c, p, q, limit).await
}
