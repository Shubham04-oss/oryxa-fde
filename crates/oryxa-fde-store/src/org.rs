//! Records that belong to the organisation rather than a company: the reusable library of answers
//! to customers' security questionnaires.

use oryxa_core::TenantId;
use oryxa_fde_core::SecurityAnswerId;
use sqlx::postgres::PgRow;
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;

use crate::{Actor, StoreError, Text, id, text, unique_violation};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecurityAnswer {
    pub id: SecurityAnswerId,
    pub question: Text,
    pub answer: Text,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct SecurityAnswerIn {
    pub question: Text,
    pub answer: Text,
}

/// A transaction limited to one organisation's own records; no company's rows are visible.
pub struct OrgTx {
    pub(crate) tx: Transaction<'static, Postgres>,
    pub(crate) tenant: TenantId,
}

const COLUMNS: &str = "answer_id, question, answer, updated_at";

impl OrgTx {
    pub(crate) fn new(tx: Transaction<'static, Postgres>, tenant: TenantId) -> Self {
        Self { tx, tenant }
    }

    pub async fn commit(self) -> Result<(), StoreError> {
        self.tx.commit().await.map_err(Into::into)
    }

    pub async fn security_answers(&mut self) -> Result<Vec<SecurityAnswer>, StoreError> {
        sqlx::query(&format!(
            "select {COLUMNS} from security_answers where tenant_id = $1 order by created_at, answer_id"
        ))
        .bind(self.tenant.as_str())
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(answer)
        .collect()
    }

    pub async fn add_security_answer(
        &mut self,
        id: &SecurityAnswerId,
        v: &SecurityAnswerIn,
        by: &Actor,
    ) -> Result<SecurityAnswer, StoreError> {
        let row = sqlx::query(&format!(
            "insert into security_answers (tenant_id, answer_id, question, answer, created_by)
             values ($1, $2, $3, $4, $5) returning {COLUMNS}"
        ))
        .bind(self.tenant.as_str())
        .bind(id.as_str())
        .bind(v.question.as_str())
        .bind(v.answer.as_str())
        .bind(by.user.as_str())
        .fetch_one(&mut *self.tx)
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        self.audit(by, "security_answer.added", id.as_str()).await?;
        answer(row)
    }

    pub async fn update_security_answer(
        &mut self,
        id: &SecurityAnswerId,
        v: &SecurityAnswerIn,
        by: &Actor,
    ) -> Result<Option<SecurityAnswer>, StoreError> {
        let row = sqlx::query(&format!(
            "update security_answers set question = $3, answer = $4, updated_at = now()
             where tenant_id = $1 and answer_id = $2 returning {COLUMNS}"
        ))
        .bind(self.tenant.as_str())
        .bind(id.as_str())
        .bind(v.question.as_str())
        .bind(v.answer.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        self.audit(by, "security_answer.updated", id.as_str()).await?;
        answer(row).map(Some)
    }

    pub async fn remove_security_answer(&mut self, id: &SecurityAnswerId, by: &Actor) -> Result<bool, StoreError> {
        let n = sqlx::query("delete from security_answers where tenant_id = $1 and answer_id = $2")
            .bind(self.tenant.as_str())
            .bind(id.as_str())
            .execute(&mut *self.tx)
            .await?
            .rows_affected();
        if n == 0 {
            return Ok(false);
        }
        self.audit(by, "security_answer.removed", id.as_str()).await?;
        Ok(true)
    }

    /// Organisation-level audit rows have no company.
    pub(crate) async fn audit(&mut self, by: &Actor, action: &'static str, target: &str) -> Result<(), StoreError> {
        sqlx::query("insert into audit_log (tenant_id, actor, action, target) values ($1, $2, $3, $4)")
            .bind(self.tenant.as_str())
            .bind(by.user.as_str())
            .bind(action)
            .bind(target)
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }
}

fn answer(r: PgRow) -> Result<SecurityAnswer, StoreError> {
    Ok(SecurityAnswer {
        id: id("security answer id", SecurityAnswerId::new, r.try_get("answer_id")?)?,
        question: text(r.try_get("question")?, "question")?,
        answer: text(r.try_get("answer")?, "answer")?,
        updated_at: r.try_get("updated_at")?,
    })
}
