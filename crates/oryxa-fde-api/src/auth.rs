//! Who is calling: a WorkOS access token, verified with `oryxa-authn`, becomes a [`Principal`].
//! The token's organisation is the tenant; its role is mirrored onto the tenant's SpiceDB
//! workspace, so `workspace->manage` follows WorkOS.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::FromRequestParts;
use axum::http::Method;
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
        // A change always re-mirrors the role, so a demotion stops every write at once on every
        // replica; reads trust this replica's last mirror for up to ROLE_TTL.
        let writes = !matches!(parts.method, Method::GET | Method::HEAD);
        app.sync_workspace_role(&tenant, &user, admin, writes).await?;
        Ok(Principal {
            tenant,
            user,
            admin,
            request_id: new_id("req"),
        })
    }
}

/// How long a replica trusts its last mirror of a user's workspace role before writing it again.
/// Short against a WorkOS access token's lifetime, which bounds how stale a role can be anyway.
pub(crate) const ROLE_TTL: Duration = Duration::from_secs(30);
/// Past this many entries, expired ones are dropped.
const ROLE_CACHE_PRUNE_AT: usize = 10_000;

/// The roles this replica mirrored to SpiceDB recently, by user.
#[derive(Default)]
pub(crate) struct RoleCache(Mutex<HashMap<(TenantId, UserId), (bool, Instant)>>);

impl RoleCache {
    fn fresh(&self, key: &(TenantId, UserId), admin: bool, now: Instant) -> bool {
        let seen = self.0.lock().unwrap_or_else(|e| e.into_inner());
        matches!(seen.get(key), Some(&(a, at)) if a == admin && now.saturating_duration_since(at) < ROLE_TTL)
    }

    fn record(&self, key: (TenantId, UserId), admin: bool, now: Instant) {
        let mut seen = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if seen.len() >= ROLE_CACHE_PRUNE_AT {
            seen.retain(|_, (_, at)| now.saturating_duration_since(*at) < ROLE_TTL);
        }
        seen.insert(key, (admin, now));
    }
}

impl App {
    /// Mirrors the token's role onto `workspace:<tenant>|root`: admin or member, never both. Skipped
    /// only for a read whose role this replica mirrored less than [`ROLE_TTL`] ago: another replica
    /// may have mirrored a different role since, so no mirror is trusted for long.
    async fn sync_workspace_role(
        &self,
        tenant: &TenantId,
        u: &UserId,
        admin: bool,
        writes: bool,
    ) -> Result<(), ApiError> {
        let key = (tenant.clone(), u.clone());
        if !writes && self.roles.fresh(&key, admin, Instant::now()) {
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
        self.roles.record(key, admin, Instant::now());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mirrored_role_is_trusted_briefly_and_only_for_the_same_role() {
        let cache = RoleCache::default();
        let key = (TenantId::new("org_1").unwrap(), UserId::new("user_1").unwrap());
        let t0 = Instant::now();
        assert!(!cache.fresh(&key, false, t0), "nothing mirrored yet");
        cache.record(key.clone(), true, t0);
        assert!(cache.fresh(&key, true, t0 + Duration::from_secs(1)));
        assert!(
            !cache.fresh(&key, false, t0 + Duration::from_secs(1)),
            "a role change re-mirrors"
        );
        assert!(!cache.fresh(&key, true, t0 + ROLE_TTL), "expired");
        let other = (TenantId::new("org_2").unwrap(), UserId::new("user_1").unwrap());
        assert!(!cache.fresh(&other, true, t0), "per tenant");
    }

    #[test]
    fn the_cache_drops_expired_entries_once_it_is_large() {
        let cache = RoleCache::default();
        let t0 = Instant::now();
        for i in 0..ROLE_CACHE_PRUNE_AT {
            let key = (
                TenantId::new("org_1").unwrap(),
                UserId::new(format!("user_{i}")).unwrap(),
            );
            cache.record(key, false, t0);
        }
        let later = t0 + ROLE_TTL + Duration::from_secs(1);
        cache.record(
            (TenantId::new("org_1").unwrap(), UserId::new("new").unwrap()),
            true,
            later,
        );
        assert_eq!(cache.0.lock().unwrap().len(), 1);
    }
}
