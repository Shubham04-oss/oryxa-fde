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

use oryxa_authz::{AuthzError, CheckItem, Consistency, Decision, ObjectRef, Relationship, SubjectRef, Write};
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

/// Tenants per round, and rows of each kind per tenant.
const RECONCILE_BATCH: i64 = 25;
const RECONCILE_EVERY: Duration = Duration::from_secs(5);

/// Writes pending grants and returns how many it wrote. Tenants go in the order of their longest
/// waiting row, never-tried first. Each tenant's rows are locked in a transaction of their own,
/// only for that tenant's write: a slow SpiceDB holds one tenant's rows for one call (its timeout),
/// never the whole round's, and an unreachable SpiceDB ends the round there. The lock is what keeps
/// a grant from landing after a revocation of its row, so the write never happens without it.
pub async fn reconcile_grants(app: &App) -> Result<usize, ApiError> {
    let mut written = 0;
    for tenant in app.store.pending_grant_tenants(RECONCILE_BATCH).await? {
        let mut pending = app.store.pending_grants(&tenant, RECONCILE_BATCH).await?;
        let grants = pending.grants().to_vec();
        let t = &tenant;
        let (done, reachable) = write_tenant(&grants, |writes| async move {
            app.authz.write(t, &writes, &[]).await.map(|_| ())
        })
        .await;
        for (g, ok) in grants.iter().zip(done) {
            if ok {
                pending.mark(g).await?;
                written += 1;
            } else {
                pending.mark_failed(g).await?;
            }
        }
        pending.commit().await?;
        if !reachable {
            break;
        }
    }
    Ok(written)
}

/// Writes one tenant's grants in one call. A batch SpiceDB refuses is written again a row at a
/// time, so one bad row fails alone. Returns which were written, and whether SpiceDB could be
/// reached at all: unreachable, the rest are not tried.
async fn write_tenant<F, Fut>(grants: &[Grant], write: F) -> (Vec<bool>, bool)
where
    F: Fn(Vec<Write>) -> Fut,
    Fut: std::future::Future<Output = Result<(), AuthzError>>,
{
    let touch = |g: &Grant| Write::Touch(relationship(g));
    match write(grants.iter().map(touch).collect()).await {
        Ok(()) => return (vec![true; grants.len()], true),
        Err(e) if unreachable(&e) => {
            tracing::warn!(error = %e, "spicedb unreachable; grants left for the next round");
            return (vec![false; grants.len()], false);
        }
        Err(e) if grants.len() == 1 => {
            tracing::warn!(error = %e, "grant refused");
            return (vec![false], true);
        }
        Err(e) => tracing::warn!(error = %e, "grant batch refused; writing one at a time"),
    }
    let mut done = Vec::with_capacity(grants.len());
    for g in grants {
        match write(vec![touch(g)]).await {
            Ok(()) => done.push(true),
            Err(e) if unreachable(&e) => {
                tracing::warn!(error = %e, "spicedb unreachable; grants left for the next round");
                done.resize(grants.len(), false);
                return (done, false);
            }
            Err(e) => {
                tracing::warn!(error = %e, "grant refused");
                done.push(false);
            }
        }
    }
    (done, true)
}

/// SpiceDB could not answer, as opposed to refusing the write.
fn unreachable(e: &AuthzError) -> bool {
    match e {
        AuthzError::Connect(_) => true,
        AuthzError::Rpc(status) => matches!(
            status.code(),
            tonic::Code::Unavailable | tonic::Code::DeadlineExceeded | tonic::Code::Cancelled | tonic::Code::Unknown
        ),
        _ => false,
    }
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

    /// Whether `other`, a user of the caller's tenant, works on the project. User objects are
    /// per tenant, so a user of another tenant never does.
    pub(crate) async fn works_on(&self, who: &Principal, other: &UserId, s: &ProjectScope) -> Result<bool, ApiError> {
        self.works_at(who, other, project(s)).await
    }

    /// Whether every one of `others`, users of the caller's tenant, has `work` on the company or
    /// project: one bulk check. An item SpiceDB could not answer is unavailable, never an allow.
    pub(crate) async fn all_work_at(
        &self,
        who: &Principal,
        others: &[UserId],
        resource: ObjectRef,
    ) -> Result<bool, ApiError> {
        if others.is_empty() {
            return Ok(true);
        }
        let items: Vec<CheckItem> = others
            .iter()
            .map(|u| CheckItem {
                resource: resource.clone(),
                permission: "work",
                subject: user(&who.tenant, u),
                context: None,
            })
            .collect();
        match self.authz.check_bulk(&who.tenant, &items, &CONSISTENCY).await {
            Ok(decisions) if decisions.iter().any(|d| matches!(d, Decision::Error(_))) => {
                tracing::error!("authz bulk check had an item error");
                Err(ApiError::Unavailable)
            }
            Ok(decisions) => Ok(decisions.iter().all(Decision::allowed)),
            Err(e) => {
                tracing::error!(error = %e, "authz bulk check failed");
                Err(ApiError::Unavailable)
            }
        }
    }

    /// Whether `other`, a user of the caller's tenant, has `work` on the company or project.
    pub(crate) async fn works_at(
        &self,
        who: &Principal,
        other: &UserId,
        resource: ObjectRef,
    ) -> Result<bool, ApiError> {
        let item = CheckItem {
            resource,
            permission: "work",
            subject: user(&who.tenant, other),
            context: None,
        };
        match self.authz.check(&who.tenant, &item, &CONSISTENCY).await {
            Ok(d) => Ok(d.allowed()),
            Err(e) => {
                tracing::error!(error = %e, "authz check failed");
                Err(ApiError::Unavailable)
            }
        }
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    fn grants(ids: &[&str]) -> Vec<Grant> {
        let t = TenantId::new("org_1").unwrap();
        ids.iter()
            .map(|c| Grant::CompanyWorkspace(CompanyScope::new(t.clone(), CompanyId::new(*c).unwrap())))
            .collect()
    }

    /// A SpiceDB that answers each write with `answer(writes)`, recording the size of each call.
    async fn run(ids: &[&str], answer: impl Fn(&str) -> Result<(), AuthzError>) -> ((Vec<bool>, bool), Vec<usize>) {
        let calls = Mutex::new(Vec::new());
        let out = write_tenant(&grants(ids), |writes| {
            calls.lock().unwrap().push(writes.len());
            let result = answer(&format!("{writes:?}"));
            async move { result }
        })
        .await;
        (out, calls.into_inner().unwrap())
    }

    fn refused() -> AuthzError {
        AuthzError::Rpc(tonic::Status::invalid_argument("no such relation"))
    }

    fn down() -> AuthzError {
        AuthzError::Rpc(tonic::Status::unavailable("connection refused"))
    }

    #[tokio::test]
    async fn a_batch_goes_in_one_call() {
        let (out, calls) = run(&["cmp_1", "cmp_2"], |_| Ok(())).await;
        assert_eq!((out, calls), ((vec![true, true], true), vec![2]));
    }

    #[tokio::test]
    async fn a_refused_batch_is_written_a_row_at_a_time_so_one_bad_row_fails_alone() {
        let (out, calls) = run(&["cmp_1", "cmp_bad", "cmp_3"], |w| {
            if w.contains("cmp_bad") { Err(refused()) } else { Ok(()) }
        })
        .await;
        assert_eq!((out, calls), ((vec![true, false, true], true), vec![3, 1, 1, 1]));
    }

    #[tokio::test]
    async fn an_unreachable_spicedb_is_not_asked_again_this_round() {
        let (out, calls) = run(&["cmp_1", "cmp_2"], |_| Err(down())).await;
        assert_eq!((out, calls), ((vec![false, false], false), vec![2]));
        // Gone while writing a row at a time: the rest are left for the next round.
        let (out, calls) = run(&["cmp_1", "cmp_bad", "cmp_3", "cmp_4"], |w| {
            if w.contains("cmp_bad") && !w.contains("cmp_1") {
                Err(down())
            } else if w.contains("cmp_bad") {
                Err(refused())
            } else {
                Ok(())
            }
        })
        .await;
        assert_eq!((out, calls), ((vec![true, false, false, false], false), vec![4, 1, 1]));
    }

    #[test]
    fn only_a_transport_failure_counts_as_unreachable() {
        assert!(unreachable(&down()));
        assert!(unreachable(&AuthzError::Rpc(tonic::Status::deadline_exceeded("slow"))));
        assert!(!unreachable(&refused()));
        assert!(!unreachable(&AuthzError::Rpc(tonic::Status::permission_denied("key"))));
        assert!(!unreachable(&AuthzError::BadKey));
    }
}
