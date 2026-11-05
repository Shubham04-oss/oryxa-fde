//! Share links for one project: how a customer person becomes its guest. A link stores the
//! SHA-256 of its secret and an expiry; a live link (not expired, not revoked) redeemed by a user
//! of the tenant records them as its guest, and the API then writes SpiceDB's `guest` on the
//! project ([`GrantRow::Guest`]). A guest's access also needs a live link here at every request,
//! so an expired link fails closed whatever SpiceDB still holds.

use oryxa_core::UserId;
use oryxa_fde_core::ShareLinkId;
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::OffsetDateTime;

use crate::{Actor, GrantRow, ProjectTx, StoreError, audit, id, unique_violation};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareLink {
    pub id: ShareLinkId,
    pub expires_at: OffsetDateTime,
    pub revoked_at: Option<OffsetDateTime>,
    pub created_by: UserId,
    pub created_at: OffsetDateTime,
    /// How many people redeemed it.
    pub guests: u32,
}

/// What redeeming a link did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Redeemed {
    /// The caller is now a guest of the project; the row whose grant the API writes next.
    Guest(GrantRow),
    /// No live link with that secret in this project: unknown, wrong secret, expired or revoked.
    Refused,
}

const LINK: &str = "l.link_id, l.expires_at, l.revoked_at, l.created_by, l.created_at,
    (select count(*) from share_link_guests g where g.tenant_id = l.tenant_id and g.link_id = l.link_id) as guests";

/// Equal without an early exit, so the time taken says nothing about how much of it matched.
pub(crate) fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl ProjectTx {
    /// A new link that expires `days` (1 to 90) from now, by the database's clock, which the table's
    /// check also uses. `None` if the project is not in this company.
    pub async fn create_share_link(
        &mut self,
        id: &ShareLinkId,
        secret_sha256: &str,
        days: u32,
        by: &Actor,
    ) -> Result<Option<ShareLink>, StoreError> {
        if !(1..=90).contains(&days) {
            return Err(StoreError::Rejected("expires_in_days"));
        }
        let (t, c, p) = self.keys();
        let inserted = sqlx::query(
            "insert into share_links (tenant_id, company_id, project_id, link_id, secret_sha256, expires_at,
                 created_by)
             select $1, $2, $3, $4, $5, now() + make_interval(days => $6), $7
             where exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(secret_sha256)
        .bind(i32::try_from(days).map_err(|_| StoreError::Rejected("expires_in_days"))?)
        .bind(by.user.as_str())
        .execute(&mut *self.tx)
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?
        .rows_affected();
        if inserted == 0 {
            return Ok(None);
        }
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "share_link.created",
            Some(id.as_str()),
        )
        .await?;
        self.share_link(id).await
    }

    /// The project's links, newest first; never their secrets.
    pub async fn share_links(&mut self) -> Result<Vec<ShareLink>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {LINK} from share_links l where l.tenant_id = $1 and l.company_id = $2 and l.project_id = $3
             order by l.created_at desc, l.link_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(link)
        .collect()
    }

    pub async fn share_link(&mut self, id: &ShareLinkId) -> Result<Option<ShareLink>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {LINK} from share_links l
             where l.tenant_id = $1 and l.company_id = $2 and l.project_id = $3 and l.link_id = $4"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?
        .map(link)
        .transpose()
    }

    /// Records `user` as a guest through the link, if it is live and `secret_sha256` is its
    /// secret's. The link is locked against a revocation until commit.
    pub async fn redeem_share_link(
        &mut self,
        id: &ShareLinkId,
        secret_sha256: &str,
        user: &UserId,
        by: &Actor,
    ) -> Result<Redeemed, StoreError> {
        let (t, c, p) = self.keys();
        let stored: Option<String> = sqlx::query_scalar(
            "select secret_sha256 from share_links
             where tenant_id = $1 and company_id = $2 and project_id = $3 and link_id = $4
                 and revoked_at is null and expires_at > now()
             for share",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(stored) = stored else {
            return Ok(Redeemed::Refused);
        };
        if !same(stored.as_bytes(), secret_sha256.as_bytes()) {
            return Ok(Redeemed::Refused);
        }
        sqlx::query(
            "insert into share_link_guests (tenant_id, company_id, project_id, link_id, user_id)
             values ($1, $2, $3, $4, $5) on conflict do nothing",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(user.as_str())
        .execute(&mut *self.tx)
        .await?;
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "share_link.redeemed",
            Some(id.as_str()),
        )
        .await?;
        Ok(Redeemed::Guest(GrantRow::Guest(
            self.scope.clone(),
            user.clone(),
            id.clone(),
        )))
    }

    /// Revokes the link and removes its guests. Returns the users who are no longer guests of the
    /// project through any live link, whose `guest` relationship the caller deletes before it
    /// commits; `None` if there is no such link.
    pub async fn revoke_share_link(&mut self, id: &ShareLinkId, by: &Actor) -> Result<Option<Vec<UserId>>, StoreError> {
        let (t, c, p) = self.keys();
        let n = sqlx::query(
            "update share_links set revoked_at = coalesce(revoked_at, now())
             where tenant_id = $1 and company_id = $2 and project_id = $3 and link_id = $4",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Ok(None);
        }
        let removed: Vec<String> = sqlx::query_scalar(
            "delete from share_link_guests
             where tenant_id = $1 and company_id = $2 and project_id = $3 and link_id = $4
             returning user_id",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .fetch_all(&mut *self.tx)
        .await?;
        let mut gone = Vec::new();
        for raw in removed {
            let user = id_user(raw)?;
            if !self.live_guest(&user).await? {
                gone.push(user);
            }
        }
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "share_link.revoked",
            Some(id.as_str()),
        )
        .await?;
        Ok(Some(gone))
    }

    /// Whether `user` is a guest of the project through a link that is still live.
    pub async fn live_guest(&mut self, user: &UserId) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let live: bool = sqlx::query_scalar(
            "select exists (select 1 from share_link_guests g join share_links l
                 on l.tenant_id = g.tenant_id and l.link_id = g.link_id
             where g.tenant_id = $1 and g.company_id = $2 and g.project_id = $3 and g.user_id = $4
                 and l.revoked_at is null and l.expires_at > now())",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(user.as_str())
        .fetch_one(&mut *self.tx)
        .await?;
        Ok(live)
    }
}

fn id_user(raw: String) -> Result<UserId, StoreError> {
    id("user id", UserId::new, raw)
}

fn link(r: PgRow) -> Result<ShareLink, StoreError> {
    let guests: i64 = r.try_get("guests")?;
    Ok(ShareLink {
        id: id("share link id", ShareLinkId::new, r.try_get("link_id")?)?,
        expires_at: r.try_get("expires_at")?,
        revoked_at: r.try_get("revoked_at")?,
        created_by: id_user(r.try_get("created_by")?)?,
        created_at: r.try_get("created_at")?,
        guests: u32::try_from(guests).map_err(|_| StoreError::Corrupt("guest count"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_compare_whole() {
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd") && !same(b"abc", b"ab") && !same(b"", b"a"));
    }
}
