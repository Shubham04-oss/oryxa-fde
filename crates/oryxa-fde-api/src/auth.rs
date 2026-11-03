//! Who is calling: a WorkOS access token, verified with `oryxa-authn`, becomes a [`Principal`].
//! The token's organisation is the tenant; its role is mirrored onto the tenant's SpiceDB
//! workspace, so `workspace->manage` follows WorkOS.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use oryxa_authn::{AccessTokenVerifier, JwtError, KeySource, SessionClaims};
use oryxa_authz::Write;
use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{CompanyId, CompanyScope};
use oryxa_fde_store::{Actor, new_id};

use crate::authz::{rel, user, workspace};
use crate::{ApiError, App};

/// Verifies an access token. Object-safe so the app can hold any key source.
pub trait VerifyToken: Send + Sync + 'static {
    fn claims<'a>(
        &'a self,
        token: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<SessionClaims, JwtError>> + Send + 'a>>;
}

impl<K: KeySource + 'static> VerifyToken for AccessTokenVerifier<K> {
    fn claims<'a>(
        &'a self,
        token: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<SessionClaims, JwtError>> + Send + 'a>> {
        Box::pin(self.verify(token))
    }
}

/// The verified caller of one request.
#[derive(Debug, Clone)]
pub struct Principal {
    pub tenant: TenantId,
    pub user: UserId,
    pub admin: bool,
    /// Generated per request; the correlation id on events this request causes.
    pub request_id: String,
}

impl Principal {
    pub fn company(&self, company: CompanyId) -> CompanyScope {
        CompanyScope::new(self.tenant.clone(), company)
    }

    pub fn actor(&self) -> Actor {
        Actor {
            user: self.user.clone(),
            request_id: self.request_id.clone(),
        }
    }
}

impl FromRequestParts<Arc<App>> for Principal {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, app: &Arc<App>) -> Result<Self, ApiError> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(ApiError::Unauthorized)?;
        let claims = match app.tokens.claims(token).await {
            Ok(c) => c,
            Err(JwtError::Keys(e)) => {
                tracing::error!(error = %e, "could not load WorkOS signing keys");
                return Err(ApiError::Unavailable);
            }
            Err(_) => return Err(ApiError::Unauthorized),
        };
        let org = claims.org_id.as_deref().ok_or(ApiError::NoOrganisation)?;
        let tenant = TenantId::new(org).map_err(|_| ApiError::Unauthorized)?;
        let user = UserId::new(claims.sub).map_err(|_| ApiError::Unauthorized)?;
        let admin = claims.role.as_deref() == Some("admin");
        app.sync_workspace_role(&tenant, &user, admin).await?;
        Ok(Principal {
            tenant,
            user,
            admin,
            request_id: new_id("req"),
        })
    }
}

impl App {
    /// Mirrors the token's role onto `workspace:<tenant>|root`: admin or member, never both.
    /// Written once per process per (user, role), so a role change takes effect on the next token.
    async fn sync_workspace_role(&self, tenant: &TenantId, u: &UserId, admin: bool) -> Result<(), ApiError> {
        let key = (tenant.clone(), u.clone(), admin);
        if self.synced.lock().unwrap_or_else(|e| e.into_inner()).contains(&key) {
            return Ok(());
        }
        let (grant, revoke) = if admin {
            ("admin", "member")
        } else {
            ("member", "admin")
        };
        self.write(
            tenant,
            &[
                Write::Touch(rel(workspace(tenant), grant, user(tenant, u))),
                Write::Delete(rel(workspace(tenant), revoke, user(tenant, u))),
            ],
        )
        .await?;
        let mut synced = self.synced.lock().unwrap_or_else(|e| e.into_inner());
        synced.remove(&(tenant.clone(), u.clone(), !admin));
        synced.insert(key);
        Ok(())
    }
}
