//! Read-only views of one project for callers other than the HTTP routes, such as the MCP server
//! for coding agents. Each checks `oryxa-authz` before it reads (`work` on the project; for the
//! company's documents, `work` on the company), runs under the project's `ProjectScope`, and
//! returns what the matching route returns.

use oryxa_fde_context::SearchQuery;
use oryxa_fde_core::{CompanyId, DecisionId, ProjectId, TaskId};

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

/// Most items one page of a list holds.
pub const MAX_PAGE: u32 = 100;

/// One page of a list, and the cursor for the next page if there is one.
pub struct Paged<T> {
    pub items: Vec<T>,
    /// The id to pass as `after` for the next page.
    pub next: Option<String>,
}

/// One page of the project's decisions log, newest first, after decision `after`.
pub async fn decisions(
    app: &App,
    who: &Principal,
    c: CompanyId,
    p: ProjectId,
    after: Option<DecisionId>,
    limit: u32,
) -> Result<Paged<DecisionOut>, ApiError> {
    let mut tx = project_tx(app, who, c, p).await?;
    let page = tx.decisions_page(after.as_ref(), limit.clamp(1, MAX_PAGE)).await?;
    tx.commit().await?;
    let next = page.more.then(|| page.items.last().map(|d| d.id.to_string())).flatten();
    Ok(Paged {
        items: page.items.into_iter().map(Into::into).collect(),
        next,
    })
}

/// One page of the project's tasks, oldest first, after task `after`.
pub async fn tasks(
    app: &App,
    who: &Principal,
    c: CompanyId,
    p: ProjectId,
    after: Option<TaskId>,
    limit: u32,
) -> Result<Paged<TaskOut>, ApiError> {
    let mut tx = project_tx(app, who, c, p).await?;
    let page = tx.tasks_page(after.as_ref(), limit.clamp(1, MAX_PAGE)).await?;
    tx.commit().await?;
    let next = page.more.then(|| page.items.last().map(|t| t.id.to_string())).flatten();
    Ok(Paged {
        items: page.items.into_iter().map(Into::into).collect(),
        next,
    })
}

/// Passages from the documents of the project's company; needs `work` on the company.
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
