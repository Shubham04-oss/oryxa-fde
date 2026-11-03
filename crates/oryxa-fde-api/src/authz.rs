//! SpiceDB objects for `schema/fde.zed` and the checks every handler runs. All through
//! `oryxa-authz`, which refuses any object outside the caller's tenant.

use oryxa_authz::{CheckItem, Consistency, ObjectRef, Relationship, SubjectRef, Write};
use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{CompanyId, CompanyScope, ProjectScope};

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

    pub(crate) async fn write(&self, tenant: &TenantId, writes: &[Write]) -> Result<(), ApiError> {
        self.authz.write(tenant, writes, &[]).await.map(|_| ()).map_err(|e| {
            tracing::error!(error = %e, "authz write failed");
            ApiError::Unavailable
        })
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
