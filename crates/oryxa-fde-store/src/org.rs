//! Records that belong to the organisation rather than a company: the reusable library of answers
//! to customers' security questionnaires.

use oryxa_core::{TenantId, UserId};
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

/// A home suggestion's id: `<kind>` or `<kind>.<project id>`, a kind being `[a-z_]{1,32}` and a
/// project id `[A-Za-z0-9_-]{1,128}`, the same rule the table checks.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SuggestionKey(String);

impl SuggestionKey {
    pub fn new(v: &str) -> Option<Self> {
        let (kind, project) = match v.split_once('.') {
            Some((k, p)) => (k, Some(p)),
            None => (v, None),
        };
        let kind_ok = (1..=32).contains(&kind.len()) && kind.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
        let project_ok = project.is_none_or(|p| {
            (1..=128).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        });
        (kind_ok && project_ok).then(|| Self(v.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A home suggestion a person dismissed: its id and the SHA-256 of its facts then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dismissal {
    pub suggestion: SuggestionKey,
    pub facts: [u8; 32],
}

fn to_hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(v: &str) -> Option<[u8; 32]> {
    if v.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(v.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}

impl OrgTx {
    /// The home suggestions `user` dismissed in this organisation.
    pub async fn home_dismissals(&mut self, user: &UserId) -> Result<Vec<Dismissal>, StoreError> {
        let rows = sqlx::query(
            "select suggestion_id, facts_sha256 from home_dismissals where tenant_id = $1 and user_id = $2",
        )
        .bind(self.tenant.as_str())
        .bind(user.as_str())
        .fetch_all(&mut *self.tx)
        .await?;
        rows.into_iter()
            .map(|r| {
                let suggestion: String = r.try_get("suggestion_id")?;
                let facts: String = r.try_get("facts_sha256")?;
                Ok(Dismissal {
                    suggestion: SuggestionKey::new(&suggestion).ok_or(StoreError::Corrupt("suggestion id"))?,
                    facts: from_hex(&facts).ok_or(StoreError::Corrupt("facts"))?,
                })
            })
            .collect()
    }

    /// Records that `user` dismissed `suggestion` while its facts hashed to `facts`; a later
    /// dismissal of the same suggestion replaces it.
    pub async fn dismiss_home(
        &mut self,
        user: &UserId,
        suggestion: &SuggestionKey,
        facts: &[u8; 32],
    ) -> Result<(), StoreError> {
        sqlx::query(
            "insert into home_dismissals (tenant_id, user_id, suggestion_id, facts_sha256) values ($1, $2, $3, $4)
             on conflict (tenant_id, user_id, suggestion_id)
             do update set facts_sha256 = excluded.facts_sha256, dismissed_at = now()",
        )
        .bind(self.tenant.as_str())
        .bind(user.as_str())
        .bind(suggestion.as_str())
        .bind(to_hex(facts))
        .execute(&mut *self.tx)
        .await?;
        Ok(())
    }

    /// Forgets `user`'s dismissals of `suggestions`, so each shows again if it comes back.
    pub async fn forget_home_dismissals(
        &mut self,
        user: &UserId,
        suggestions: &[SuggestionKey],
    ) -> Result<(), StoreError> {
        if suggestions.is_empty() {
            return Ok(());
        }
        let ids: Vec<&str> = suggestions.iter().map(SuggestionKey::as_str).collect();
        sqlx::query("delete from home_dismissals where tenant_id = $1 and user_id = $2 and suggestion_id = any($3)")
            .bind(self.tenant.as_str())
            .bind(user.as_str())
            .bind(&ids)
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod home_tests {
    use super::*;

    #[test]
    fn a_suggestion_key_is_a_kind_and_maybe_a_project_id() {
        for ok in [
            "due_today",
            "blocked_tasks.prj_01A-x",
            &format!("a.{}", "p".repeat(128)),
        ] {
            assert_eq!(
                SuggestionKey::new(ok).map(|k| k.as_str().to_owned()).as_deref(),
                Some(ok),
                "{ok}"
            );
        }
        for bad in [
            "",
            ".",
            "Due_today",
            "due-today",
            "kind.",
            ".prj_1",
            "kind.prj.1",
            "kind.prj/1",
            "kind.prj 1",
            &"k".repeat(33),
            &format!("a.{}", "p".repeat(129)),
        ] {
            assert!(SuggestionKey::new(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn facts_go_to_hex_and_back() {
        let facts = [0xabu8; 32];
        assert_eq!(from_hex(&to_hex(&facts)), Some(facts));
        assert_eq!(from_hex("ab"), None);
        assert_eq!(from_hex(&"zz".repeat(32)), None);
    }
}
