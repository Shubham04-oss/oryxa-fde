//! Setting up a company in one call: the record that makes a retried setup return the first one
//! rather than make a second company.

use oryxa_core::UserId;
use oryxa_fde_core::{CompanyId, ProjectId};
use sqlx::Row;

use crate::{CompanyTx, StoreError, id};

/// What a setup's key says about this attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupClaim {
    /// The first setup under this key: go on, in this transaction.
    New,
    /// An earlier setup used this key: its company and project, and whether its body was the same.
    Earlier {
        company: CompanyId,
        project: ProjectId,
        same_body: bool,
    },
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl CompanyTx {
    /// Claims `key` for `user`'s setup of this company and `project`, in this transaction: it holds
    /// only if the setup commits. A concurrent setup with the same key waits for this one, then
    /// finds it. `key` and `body` are SHA-256 hashes.
    pub async fn claim_setup(
        &mut self,
        user: &UserId,
        key: &[u8; 32],
        body: &[u8; 32],
        project: &ProjectId,
    ) -> Result<SetupClaim, StoreError> {
        let s = self.scope.clone();
        let (key, body) = (hex(key), hex(body));
        let claimed = sqlx::query(
            "insert into company_setups (tenant_id, user_id, key_sha256, body_sha256, company_id, project_id)
             values ($1, $2, $3, $4, $5, $6) on conflict do nothing returning 1",
        )
        .bind(s.tenant.as_str())
        .bind(user.as_str())
        .bind(&key)
        .bind(&body)
        .bind(s.company.as_str())
        .bind(project.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        if claimed.is_some() {
            return Ok(SetupClaim::New);
        }
        let row = sqlx::query(
            "select company_id, project_id, body_sha256 from company_setups
             where tenant_id = $1 and user_id = $2 and key_sha256 = $3",
        )
        .bind(s.tenant.as_str())
        .bind(user.as_str())
        .bind(&key)
        .fetch_one(&mut *self.tx)
        .await?;
        let earlier_body: String = row.try_get("body_sha256")?;
        Ok(SetupClaim::Earlier {
            company: id("company id", CompanyId::new, row.try_get("company_id")?)?,
            project: id("project id", ProjectId::new, row.try_get("project_id")?)?,
            same_body: earlier_body == body,
        })
    }
}
