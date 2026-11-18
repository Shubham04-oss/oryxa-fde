//! SpiceDB objects for `schema/fde.zed`, all through `oryxa-authz`, which refuses any object outside
//! the caller's tenant. What is left after #296 is the workspace a token's role is mirrored onto (see
//! `auth`): `workspace:<tenant>|root`, with its admins and members.

use oryxa_authz::{ObjectRef, Relationship, SubjectRef, Write};
use oryxa_core::{TenantId, UserId};

use crate::{ApiError, App};

/// The tenant's one workspace object, as in the platform.
const WORKSPACE: &str = "root";

pub(crate) fn workspace(t: &TenantId) -> ObjectRef {
    ObjectRef::new(t, "workspace", WORKSPACE)
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

impl App {
    /// Writes `writes` in one call; any error is 503, never a partial success reported as done.
    pub(crate) async fn write(&self, tenant: &TenantId, writes: &[Write]) -> Result<(), ApiError> {
        self.authz.write(tenant, writes, &[]).await.map(|_| ()).map_err(|e| {
            tracing::error!(error = %e, "authz write failed");
            ApiError::Unavailable
        })
    }
}
