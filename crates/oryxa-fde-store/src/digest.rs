//! The weekly digest: a project's newest approved update, emailed once to each of that project's
//! sponsors (stakeholders of its company named for it, [`ProjectTx::add_project_sponsor`]) who has
//! an address and has not unsubscribed. Each mail is claimed here right before it is sent, and the
//! claim checks all of that again; it holds the SHA-256 of the secret in that mail's unsubscribe
//! link.
//!
//! An unsubscribe token is `<tenant>.<company>.<project>.<week>.<stakeholder>.<secret>`: ids are
//! `[A-Za-z0-9_-]` and the week is `YYYY-MM-DD`, so the dots split it, and the secret is 32 random
//! bytes in hex. It names one delivery, whose stored hash it must match.

use std::fmt;

use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId, ProjectScope, StakeholderId};
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::Row;
use time::{Date, Duration, OffsetDateTime};

use crate::share::same;
use crate::{Actor, EmailAddress, Name, ProjectTx, StoreError, UpdateBody, audit, id, name, week_bounds};

/// How long after its approval an update is still sent, so a sponsor added later gets this
/// week's update and not old ones.
pub const DIGEST_WINDOW: Duration = Duration::days(7);

/// How many times one recipient's mail may be tried.
pub const DIGEST_ATTEMPTS: u32 = 3;

/// One project's update to send, and to whom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueDigest {
    pub project: Name,
    /// The Monday of the week it covers.
    pub week: Date,
    pub body: UpdateBody,
    pub recipients: Vec<StakeholderId>,
}

/// A claimed mail: where it goes, and the link that unsubscribes its recipient.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestClaim {
    pub name: Name,
    pub email: EmailAddress,
    pub unsubscribe: UnsubscribeToken,
}

/// Names one delivery, and holds the secret its mail carries.
#[derive(Clone, PartialEq, Eq)]
pub struct UnsubscribeToken {
    pub scope: ProjectScope,
    pub week: Date,
    pub stakeholder: StakeholderId,
    secret: String,
}

impl UnsubscribeToken {
    /// The token's parts, if it is well formed: nothing else is looked up.
    pub fn parse(raw: &str) -> Option<Self> {
        let mut parts = raw.split('.');
        let (t, c, p, w, s, secret) = (
            parts.next()?,
            parts.next()?,
            parts.next()?,
            parts.next()?,
            parts.next()?,
            parts.next()?,
        );
        if parts.next().is_some()
            || secret.len() != 64
            || !secret.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return None;
        }
        let week = Date::parse(w, time::macros::format_description!("[year]-[month]-[day]")).ok()?;
        week_bounds(week).ok()?;
        let scope = CompanyScope::new(TenantId::new(t).ok()?, CompanyId::new(c).ok()?).project(ProjectId::new(p).ok()?);
        Some(Self {
            scope,
            week,
            stakeholder: StakeholderId::new(s).ok()?,
            secret: secret.to_owned(),
        })
    }

    fn fresh(scope: &ProjectScope, week: Date, stakeholder: &StakeholderId) -> Self {
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        Self {
            scope: scope.clone(),
            week,
            stakeholder: stakeholder.clone(),
            secret: bytes.iter().map(|b| format!("{b:02x}")).collect(),
        }
    }

    fn secret_sha256(&self) -> String {
        Sha256::digest(self.secret.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

impl fmt::Display for UnsubscribeToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}.{}.{}.{}.{}.{}",
            self.scope.tenant(),
            self.scope.company.company,
            self.scope.project,
            self.week,
            self.stakeholder,
            self.secret
        )
    }
}

/// The secret is a credential: it stays out of logs.
impl fmt::Debug for UnsubscribeToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UnsubscribeToken")
            .field("scope", &self.scope)
            .field("week", &self.week)
            .field("stakeholder", &self.stakeholder)
            .finish_non_exhaustive()
    }
}

/// Who an unsubscribe is recorded as: the recipient is no user of ours.
fn recipient(request_id: &str) -> Result<Actor, StoreError> {
    Ok(Actor {
        user: UserId::new("digest_recipient").map_err(|_| StoreError::Corrupt("digest actor"))?,
        request_id: request_id.to_owned(),
    })
}

impl ProjectTx {
    /// The newest approved update, if it was approved within [`DIGEST_WINDOW`] of `now`, and the
    /// sponsors still to get it. `None` if there is no such update or no one left to send it to.
    pub async fn due_digest(&mut self, now: OffsetDateTime) -> Result<Option<DueDigest>, StoreError> {
        let (t, c, p) = self.keys();
        let row = sqlx::query(
            "select u.week, u.body, u.decided_at, pr.name from update_drafts u
             join projects pr on pr.tenant_id = u.tenant_id and pr.company_id = u.company_id
                 and pr.project_id = u.project_id
             where u.tenant_id = $1 and u.company_id = $2 and u.project_id = $3 and u.status = 'approved'
             order by u.week desc limit 1",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let week: Date = row.try_get("week")?;
        let decided: Option<OffsetDateTime> = row.try_get("decided_at")?;
        if decided.is_none_or(|at| at + DIGEST_WINDOW < now) {
            return Ok(None);
        }
        let recipients: Vec<String> = sqlx::query_scalar(
            "select s.stakeholder_id from stakeholders s
             join project_sponsors ps on ps.tenant_id = s.tenant_id and ps.company_id = s.company_id
                 and ps.stakeholder_id = s.stakeholder_id and ps.project_id = $3
             where s.tenant_id = $1 and s.company_id = $2 and s.role = 'sponsor' and s.email is not null
                 and s.digest_opt_out_at is null
                 and not exists (
                     select 1 from digest_deliveries d
                     where d.tenant_id = $1 and d.company_id = $2 and d.project_id = $3 and d.week = $4
                         and d.stakeholder_id = s.stakeholder_id and (d.sent_at is not null or d.attempts >= $5))
             order by s.stakeholder_id",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(week)
        .bind(i64::from(DIGEST_ATTEMPTS))
        .fetch_all(&mut *self.tx)
        .await?;
        if recipients.is_empty() {
            return Ok(None);
        }
        Ok(Some(DueDigest {
            project: name(row.try_get("name")?, "project name")?,
            week,
            body: UpdateBody::new(row.try_get::<String, _>("body")?).map_err(|_| StoreError::Corrupt("update body"))?,
            recipients: recipients
                .into_iter()
                .map(|s| id("stakeholder id", StakeholderId::new, s))
                .collect::<Result<_, _>>()?,
        }))
    }

    /// Claims the mail of the week's update to one sponsor, with a fresh unsubscribe secret, and
    /// returns where it goes. `None` if it was sent, its tries are used up, another claim is under
    /// 15 minutes old and may still be sending, or the stakeholder is no longer this project's
    /// sponsor with an address who wants it: checked here, right before the send.
    pub async fn claim_digest(
        &mut self,
        week: Date,
        stakeholder: &StakeholderId,
    ) -> Result<Option<DigestClaim>, StoreError> {
        week_bounds(week)?;
        let (t, c, p) = self.keys();
        let token = UnsubscribeToken::fresh(&self.scope, week, stakeholder);
        let row = sqlx::query(
            "with who as (
                 select name, email from stakeholders
                 where tenant_id = $1 and company_id = $2 and stakeholder_id = $5 and role = 'sponsor'
                     and email is not null and digest_opt_out_at is null
                     and exists (select 1 from project_sponsors where tenant_id = $1 and company_id = $2
                         and project_id = $3 and stakeholder_id = $5)
             ), claimed as (
                 insert into digest_deliveries (tenant_id, company_id, project_id, week, stakeholder_id,
                     unsubscribe_sha256)
                 select $1, $2, $3, $4, $5, $6 from who
                 where exists (select 1 from update_drafts where tenant_id = $1 and company_id = $2
                     and project_id = $3 and week = $4 and status = 'approved')
                 on conflict (tenant_id, project_id, week, stakeholder_id) do update
                     set unsubscribe_sha256 = excluded.unsubscribe_sha256,
                         attempts = digest_deliveries.attempts + 1, claimed_at = now()
                     where digest_deliveries.sent_at is null and digest_deliveries.attempts < $7
                         and digest_deliveries.claimed_at < now() - interval '15 minutes'
                 returning 1
             )
             select who.name, who.email from who, claimed",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(week)
        .bind(stakeholder.as_str())
        .bind(token.secret_sha256())
        .bind(i64::from(DIGEST_ATTEMPTS))
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        Ok(Some(DigestClaim {
            name: name(row.try_get("name")?, "stakeholder name")?,
            email: EmailAddress::new(row.try_get::<String, _>("email")?).map_err(|_| StoreError::Corrupt("email"))?,
            unsubscribe: token,
        }))
    }

    /// Marks a claimed mail as sent, so it is never claimed again.
    pub async fn digest_sent(&mut self, week: Date, stakeholder: &StakeholderId) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(
            "update digest_deliveries set sent_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 and week = $4 and stakeholder_id = $5
                 and sent_at is null",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(week)
        .bind(stakeholder.as_str())
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    /// Unsubscribes the token's recipient from every project's digest, if the token is the one
    /// its delivery's latest claim stored; `false` otherwise. Again is no change, and `true`.
    pub async fn unsubscribe_digest(&mut self, token: &UnsubscribeToken, request_id: &str) -> Result<bool, StoreError> {
        if token.scope != self.scope {
            return Ok(false);
        }
        let (t, c, p) = self.keys();
        let stored: Option<String> = sqlx::query_scalar(
            "select unsubscribe_sha256 from digest_deliveries
             where tenant_id = $1 and company_id = $2 and project_id = $3 and week = $4 and stakeholder_id = $5",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(token.week)
        .bind(token.stakeholder.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        if !stored.is_some_and(|s| same(s.as_bytes(), token.secret_sha256().as_bytes())) {
            return Ok(false);
        }
        let n = sqlx::query(
            "update stakeholders set digest_opt_out_at = now()
             where tenant_id = $1 and company_id = $2 and stakeholder_id = $3 and digest_opt_out_at is null",
        )
        .bind(&t)
        .bind(&c)
        .bind(token.stakeholder.as_str())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if n == 1 {
            let s = self.scope.clone();
            let by = recipient(request_id)?;
            audit(
                &mut self.tx,
                &s.company,
                Some(&s.project),
                &by,
                "stakeholder.digest_unsubscribed",
                Some(token.stakeholder.as_str()),
            )
            .await?;
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use time::macros::date;

    use super::*;

    fn scope() -> ProjectScope {
        CompanyScope::new(TenantId::new("org_1").unwrap(), CompanyId::new("cmp_1").unwrap())
            .project(ProjectId::new("prj_1").unwrap())
    }

    #[test]
    fn a_token_round_trips_and_keeps_its_secret_out_of_debug_output() {
        let s = StakeholderId::new("stk_1").unwrap();
        let token = UnsubscribeToken::fresh(&scope(), date!(2026 - 11 - 02), &s);
        let raw = token.to_string();
        assert!(raw.starts_with("org_1.cmp_1.prj_1.2026-11-02.stk_1."));
        assert_eq!(UnsubscribeToken::parse(&raw), Some(token.clone()));
        assert_eq!(token.secret_sha256().len(), 64);
        assert!(!format!("{token:?}").contains(&token.secret));
        assert_ne!(
            UnsubscribeToken::fresh(&scope(), date!(2026 - 11 - 02), &s).secret,
            token.secret
        );
    }

    #[test]
    fn only_a_well_formed_token_is_looked_up() {
        let secret = "a".repeat(64);
        let ok = format!("org_1.cmp_1.prj_1.2026-11-02.stk_1.{secret}");
        assert!(UnsubscribeToken::parse(&ok).is_some());
        for bad in [
            String::new(),
            format!("cmp_1.prj_1.2026-11-02.stk_1.{secret}"),
            format!("org_1.cmp_1.prj_1.2026-11-02.stk_1.{secret}.x"),
            // Not a Monday, not a date.
            format!("org_1.cmp_1.prj_1.2026-11-03.stk_1.{secret}"),
            format!("org_1.cmp_1.prj_1.2026-13-02.stk_1.{secret}"),
            format!("org_1.cmp_1.prj_1.2026-11-02.stk_1.{}", "a".repeat(63)),
            format!("org_1.cmp_1.prj_1.2026-11-02.stk_1.{}", "A".repeat(64)),
            format!("org_1.cmp_1.prj_1.2026-11-02.stk_1.{}", "g".repeat(64)),
            format!("org 1.cmp_1.prj_1.2026-11-02.stk_1.{secret}"),
            format!("org_1.cmp_1.prj_1.2026-11-02.stk;1.{secret}"),
        ] {
            assert!(UnsubscribeToken::parse(&bad).is_none(), "{bad:?}");
        }
    }
}
