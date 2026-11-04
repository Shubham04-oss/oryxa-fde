//! SpiceDB objects for `schema/fde.zed` and the checks every handler runs. All through
//! `oryxa-authz`, which refuses any object outside the caller's tenant.
//!
//! Grants follow their rows: a handler commits the row, then [`App::grant`] writes the
//! relationship while holding the row's lock (`Store::lock_grant`). Revocations delete the
//! relationship inside the transaction that deletes or changes the row, before it commits. So a
//! failed or cancelled commit never leaves a grant behind, and a grant and a revocation of the same
//! row cannot cross. A grant whose write fails stays pending and [`reconcile_grants`] retries it.

use std::sync::Arc;
use std::time::Duration;

use oryxa_authz::{CheckItem, Consistency, ObjectRef, Relationship, SubjectRef, Write};
use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId, ProjectScope};
use oryxa_fde_store::{Grant, GrantRow};

use crate::{ApiError, App, Principal};

/// The tenant's one workspace object, as in the platform.
const WORKSPACE: &str = "root";

pub(crate) fn workspace(t: &TenantId) -> ObjectRef {
    ObjectRef::new(t, "workspace", WORKSPACE)
}

pub(crate) fn company(s: &CompanyScope) -> ObjectRef {
    ObjectRef::new(&s.tenant, "fde_company", s.company.as_str())
}

pub(crate) fn project(s: &ProjectScope) -> ObjectRef {
    ObjectRef::new(&s.company.tenant, "fde_project", s.project.as_str())
}

pub(crate) fn user(t: &TenantId, u: &UserId) -> SubjectRef {
    SubjectRef::object(ObjectRef::new(t, "user", u.as_str()))
}

pub(crate) fn rel(resource: ObjectRef, relation: &'static str, subject: SubjectRef) -> Relationship {
    Relationship {
        resource,
        relation,
        subject,
        caveat: None,
        expires_at: None,
    }
}

/// The relationship a store row justifies.
pub(crate) fn relationship(g: &Grant) -> Relationship {
    match g {
        Grant::CompanyWorkspace(c) => rel(company(c), "workspace", SubjectRef::object(workspace(&c.tenant))),
        Grant::Member(c, u, role) => rel(company(c), role.as_str(), user(&c.tenant, u)),
        Grant::ProjectCompany(p) => rel(project(p), "company", SubjectRef::object(company(&p.company))),
        Grant::Assignee(p, u) => rel(project(p), "assignee", user(p.tenant(), u)),
    }
}

const RECONCILE_BATCH: i64 = 100;
const RECONCILE_EVERY: Duration = Duration::from_secs(5);

/// Writes every pending grant once (oldest first, up to a batch of each kind) and returns how
/// many it wrote. One that fails again stays pending for the next round.
pub async fn reconcile_grants(app: &App) -> Result<usize, ApiError> {
    let mut pending = app.store.pending_grants(RECONCILE_BATCH).await?;
    let grants = pending.grants().to_vec();
    let mut written = 0;
    for g in &grants {
        if app.write(g.tenant(), &[Write::Touch(relationship(g))]).await.is_ok() {
            pending.mark(g).await?;
            written += 1;
        }
    }
    pending.commit().await?;
    Ok(written)
}

/// The reconciler loop, next to the relay in the API service.
pub async fn run_reconciler(app: Arc<App>) {
    loop {
        match reconcile_grants(&app).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(written = n, "reconciled pending grants"),
            Err(e) => tracing::warn!(error = %e, "grant reconciliation failed"),
        }
        tokio::time::sleep(RECONCILE_EVERY).await;
    }
}

// ponytail: every check is fully consistent, so revocations and fresh grants apply at once on every
// replica. Switch to stored ZedTokens (AtLeastAsFresh) if check latency starts to matter.
const CONSISTENCY: Consistency = Consistency::FullyConsistent;

impl App {
    /// Allows only a clean "has permission"; a deny is 403 and any error is 503, never an allow.
    pub(crate) async fn require(
        &self,
        who: &Principal,
        resource: ObjectRef,
        permission: &'static str,
    ) -> Result<(), ApiError> {
        let item = CheckItem {
            resource,
            permission,
            subject: user(&who.tenant, &who.user),
            context: None,
        };
        match self.authz.check(&who.tenant, &item, &CONSISTENCY).await {
            Ok(d) if d.allowed() => Ok(()),
            Ok(_) => Err(ApiError::Forbidden),
            Err(e) => {
                tracing::error!(error = %e, permission, "authz check failed");
                Err(ApiError::Unavailable)
            }
        }
    }

    /// Writes the grant `row` justifies, after the row has committed and while its lock is held.
    /// The change itself has already succeeded, so a failed write is left to the reconciler.
    pub(crate) async fn grant(&self, row: GrantRow) {
        if let Err(e) = self.try_grant(&row).await {
            tracing::warn!(error = %e, "grant left pending for the reconciler");
        }
    }

    async fn try_grant(&self, row: &GrantRow) -> Result<(), ApiError> {
        let Some(pending) = self.store.lock_grant(row).await? else {
            return Ok(());
        };
        let g = pending.grant();
        self.write(g.tenant(), &[Write::Touch(relationship(g))]).await?;
        pending.done().await?;
        Ok(())
    }

    pub(crate) async fn write(&self, tenant: &TenantId, writes: &[Write]) -> Result<(), ApiError> {
        self.authz.write(tenant, writes, &[]).await.map(|_| ()).map_err(|e| {
            tracing::error!(error = %e, "authz write failed");
            ApiError::Unavailable
        })
    }

    /// The projects the caller can work on, from SpiceDB: through a company or as an assignee.
    pub(crate) async fn projects_for(&self, who: &Principal) -> Result<Vec<ProjectId>, ApiError> {
        let ids = self
            .authz
            .lookup_resources(
                &who.tenant,
                "fde_project",
                "work",
                &user(&who.tenant, &who.user),
                &CONSISTENCY,
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "authz lookup failed");
                ApiError::Unavailable
            })?;
        Ok(ids.into_iter().filter_map(|id| ProjectId::new(id).ok()).collect())
    }

    /// The companies the caller can work on, from SpiceDB.
    pub(crate) async fn companies_for(&self, who: &Principal) -> Result<Vec<CompanyScope>, ApiError> {
        let ids = self
            .authz
            .lookup_resources(
                &who.tenant,
                "fde_company",
                "work",
                &user(&who.tenant, &who.user),
                &CONSISTENCY,
            )
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "authz lookup failed");
                ApiError::Unavailable
            })?;
        Ok(ids
            .into_iter()
            .filter_map(|id| CompanyId::new(id).ok())
            .map(|c| who.company(c))
            .collect())
    }
}
