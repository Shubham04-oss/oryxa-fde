//! Who is calling and what they may do, for the run API. Tokens are verified with `oryxa-authn` and every check
//! goes to SpiceDB through `oryxa-authz`, with the same objects as `oryxa-fde-api` (`schema/fde.zed`). Any error
//! denies; nothing falls back to allow.

use std::future::Future;

use oryxa_authn::{AccessTokenVerifier, JwtError, KeySource};
use oryxa_authz::{CheckItem, Consistency, ObjectRef, SpiceDb, SubjectRef};
use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::ProjectScope;

/// The verified caller of one request. Their organisation is the tenant every scope is built from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub tenant: TenantId,
    pub user: UserId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    /// `work` on the project: run the agent there, read its runs, decide its approvals.
    Work,
    /// `manage` on the project's company: set the project's budget.
    Manage,
    /// `view` on the project, which the customer's guests also hold: read its criteria's pass rates.
    View,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AccessError {
    #[error("missing or invalid access token")]
    Unauthorized,
    #[error("no organisation selected")]
    NoOrganisation,
    #[error("permission service unavailable")]
    Unavailable,
}

pub trait Access: Send + Sync + 'static {
    fn caller(&self, bearer: &str) -> impl Future<Output = Result<Caller, AccessError>> + Send;
    /// Whether `caller` holds `permission`, and the project is in the scope's company: a project addressed through
    /// another company is never allowed.
    fn allowed(
        &self,
        caller: &Caller,
        project: &ProjectScope,
        permission: Permission,
    ) -> impl Future<Output = Result<bool, AccessError>> + Send;
}

/// WorkOS access tokens and SpiceDB, as in `oryxa-fde-api`.
// ponytail: unlike the API's principal, this does not mirror the token's workspace role into SpiceDB; an
// organisation admin's `workspace->manage` applies once any API call has synced it.
pub struct PlatformAccess<K> {
    tokens: AccessTokenVerifier<K>,
    authz: SpiceDb,
}

impl<K> PlatformAccess<K> {
    pub fn new(tokens: AccessTokenVerifier<K>, authz: SpiceDb) -> Self {
        Self { tokens, authz }
    }
}

// Fully consistent, like the API's checks: a revoked grant applies at once.
const CONSISTENCY: Consistency = Consistency::FullyConsistent;

impl<K: KeySource + 'static> Access for PlatformAccess<K> {
    async fn caller(&self, bearer: &str) -> Result<Caller, AccessError> {
        let claims = match self.tokens.verify(bearer).await {
            Ok(c) => c,
            Err(JwtError::Keys(e)) => {
                tracing::error!(error = %e, "could not load WorkOS signing keys");
                return Err(AccessError::Unavailable);
            }
            Err(_) => return Err(AccessError::Unauthorized),
        };
        let org = claims.org_id.as_deref().ok_or(AccessError::NoOrganisation)?;
        Ok(Caller {
            tenant: TenantId::new(org).map_err(|_| AccessError::Unauthorized)?,
            user: UserId::new(claims.sub).map_err(|_| AccessError::Unauthorized)?,
        })
    }

    async fn allowed(
        &self,
        caller: &Caller,
        scope: &ProjectScope,
        permission: Permission,
    ) -> Result<bool, AccessError> {
        let t = &caller.tenant;
        if scope.tenant() != t {
            return Ok(false);
        }
        let project = ObjectRef::new(t, "fde_project", scope.project.as_str());
        let company = ObjectRef::new(t, "fde_company", scope.company.company.as_str());
        let user = SubjectRef::object(ObjectRef::new(t, "user", caller.user.as_str()));
        let checks = [
            // The project belongs to the company in the path.
            CheckItem {
                resource: project.clone(),
                permission: "company",
                subject: SubjectRef::object(company.clone()),
                context: None,
            },
            match permission {
                Permission::Work => CheckItem {
                    resource: project,
                    permission: "work",
                    subject: user,
                    context: None,
                },
                Permission::View => CheckItem {
                    resource: project,
                    permission: "view",
                    subject: user,
                    context: None,
                },
                Permission::Manage => CheckItem {
                    resource: company,
                    permission: "manage",
                    subject: user,
                    context: None,
                },
            },
        ];
        for item in &checks {
            match self.authz.check(t, item, &CONSISTENCY).await {
                Ok(d) if d.allowed() => {}
                Ok(_) => return Ok(false),
                Err(e) => {
                    tracing::error!(error = %e, permission = item.permission, "authz check failed");
                    return Err(AccessError::Unavailable);
                }
            }
        }
        Ok(true)
    }
}
