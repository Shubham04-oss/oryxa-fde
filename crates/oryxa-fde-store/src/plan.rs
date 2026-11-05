//! Planning records (#20) live at a company or at one project of it: a canvas and its shape links,
//! comment threads and meeting notes. [`PlanTx`] is either scope's transaction, so each record kind
//! has one set of queries; every one filters by tenant, company and project (null at a company).

use oryxa_fde_core::{CompanyScope, ProjectId};
use sqlx::PgConnection;

use crate::{Actor, CompanyTx, ProjectTx, StoreError, audit};

/// A company's transaction or a project's, for its planning records.
pub enum PlanTx {
    Company(CompanyTx),
    Project(ProjectTx),
}

impl From<CompanyTx> for PlanTx {
    fn from(tx: CompanyTx) -> Self {
        PlanTx::Company(tx)
    }
}

impl From<ProjectTx> for PlanTx {
    fn from(tx: ProjectTx) -> Self {
        PlanTx::Project(tx)
    }
}

/// The SQL filter for a place's rows: `$1` tenant, `$2` company, `$3` project or null.
pub(crate) const AT: &str = "tenant_id = $1 and company_id = $2 and project_id is not distinct from $3";

impl PlanTx {
    pub fn company(&self) -> &CompanyScope {
        match self {
            PlanTx::Company(t) => &t.scope,
            PlanTx::Project(t) => &t.scope.company,
        }
    }

    /// The project, for a project's records.
    pub fn project(&self) -> Option<&ProjectId> {
        match self {
            PlanTx::Company(_) => None,
            PlanTx::Project(t) => Some(&t.scope.project),
        }
    }

    pub async fn commit(self) -> Result<(), StoreError> {
        match self {
            PlanTx::Company(t) => t.commit().await,
            PlanTx::Project(t) => t.commit().await,
        }
    }

    pub(crate) fn conn(&mut self) -> &mut PgConnection {
        match self {
            PlanTx::Company(t) => &mut t.tx,
            PlanTx::Project(t) => &mut t.tx,
        }
    }

    /// Tenant, company and project as bind values, owned so they outlive borrows of the
    /// transaction.
    pub(crate) fn keys(&self) -> (String, String, Option<String>) {
        let c = self.company();
        (
            c.tenant.to_string(),
            c.company.to_string(),
            self.project().map(ToString::to_string),
        )
    }

    /// Whether the company, or the project in this company, exists.
    pub(crate) async fn exists(&mut self) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let found: bool = sqlx::query_scalar(
            "select case when $3::text is null
                 then exists (select 1 from companies where tenant_id = $1 and company_id = $2)
                 else exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)
             end",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_one(self.conn())
        .await?;
        Ok(found)
    }

    pub(crate) async fn audit(&mut self, by: &Actor, action: &'static str, target: &str) -> Result<(), StoreError> {
        let s = self.company().clone();
        let p = self.project().cloned();
        audit(self.conn(), &s, p.as_ref(), by, action, Some(target)).await
    }
}
