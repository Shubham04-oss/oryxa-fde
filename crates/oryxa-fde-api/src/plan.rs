//! Where a planning record lives: a company (`work` on the company) or one of its projects (`work`
//! on the project, whose company must be the path's). Canvases, threads and meeting notes take the
//! same routes under both, so each handler pair shares one body through [`Place`].

use oryxa_authz::ObjectRef;
use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId, ProjectScope};
use oryxa_fde_store::PlanTx;

use crate::authz::{company, project};
use crate::{ApiError, App, Principal};

#[derive(Debug, Clone)]
pub(crate) enum Place {
    Company(CompanyScope),
    Project(ProjectScope),
}

impl Place {
    pub(crate) fn company(who: &Principal, c: CompanyId) -> Self {
        Place::Company(who.company(c))
    }

    pub(crate) fn project(who: &Principal, c: CompanyId, p: ProjectId) -> Self {
        Place::Project(who.company(c).project(p))
    }

    pub(crate) fn scope(&self) -> &CompanyScope {
        match self {
            Place::Company(s) => s,
            Place::Project(s) => &s.company,
        }
    }

    pub(crate) fn resource(&self) -> ObjectRef {
        match self {
            Place::Company(s) => company(s),
            Place::Project(s) => project(s),
        }
    }

    /// Checks the caller's `work` on the place, then opens its transaction.
    pub(crate) async fn enter(&self, app: &App, who: &Principal) -> Result<PlanTx, ApiError> {
        self.require(app, who).await?;
        self.open(app).await
    }

    /// Checks the caller's `work` on the place, for a handler with more to check before it opens
    /// the transaction.
    pub(crate) async fn require(&self, app: &App, who: &Principal) -> Result<(), ApiError> {
        app.require(who, self.resource(), "work").await
    }

    /// Opens the place's transaction, for a caller already checked. A project must be in the
    /// path's company, since the permission was on the project.
    pub(crate) async fn open(&self, app: &App) -> Result<PlanTx, ApiError> {
        match self {
            Place::Company(s) => Ok(app.store.company(s).await?.into()),
            Place::Project(s) => {
                let mut tx = app.store.project(s).await?;
                if !tx.exists().await? {
                    return Err(ApiError::NotFound);
                }
                Ok(tx.into())
            }
        }
    }
}
