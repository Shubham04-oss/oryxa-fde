//! Drafted weekly updates: one per project and ISO week, drafted by the lifecycle engine from the
//! week's facts and kept until an FDE edits it, approves it or discards it. Nothing here sends
//! anything: an approved update is only marked so.

use oryxa_core::UserId;
use oryxa_fde_events::AccessStatus;
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::{Date, Duration, OffsetDateTime, Time, Weekday};

use crate::engine::Activity;
use crate::{Name, ProjectTx, Store, StoreError, TaskStatus, Text, audit, id, name, text};

/// Longest update accepted.
pub const MAX_UPDATE_CHARS: usize = 20_000;

/// The text of an update: 1 to [`MAX_UPDATE_CHARS`] characters, no control characters but
/// newlines and tabs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateBody(String);

impl UpdateBody {
    pub fn new(raw: impl Into<String>) -> Result<Self, StoreError> {
        let v: String = raw.into();
        let chars = v.trim().chars().count();
        let ok =
            (1..=MAX_UPDATE_CHARS).contains(&chars) && !v.chars().any(|c| c.is_control() && c != '\n' && c != '\t');
        if ok {
            Ok(Self(v.trim().to_owned()))
        } else {
            Err(StoreError::Rejected("body"))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateStatus {
    Draft,
    Approved,
    Discarded,
}

impl UpdateStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            UpdateStatus::Draft => "draft",
            UpdateStatus::Approved => "approved",
            UpdateStatus::Discarded => "discarded",
        }
    }

    fn parse(raw: &str) -> Result<Self, StoreError> {
        [UpdateStatus::Draft, UpdateStatus::Approved, UpdateStatus::Discarded]
            .into_iter()
            .find(|s| s.as_str() == raw)
            .ok_or(StoreError::Corrupt("update status"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateDraft {
    /// The Monday of the ISO week it covers.
    pub week: Date,
    pub body: UpdateBody,
    pub status: UpdateStatus,
    /// The model that drafted it.
    pub model: String,
    pub drafted_at: OffsetDateTime,
    pub edited_by: Option<UserId>,
    pub edited_at: Option<OffsetDateTime>,
    /// Who approved or discarded it, and when.
    pub decided_by: Option<UserId>,
    pub decided_at: Option<OffsetDateTime>,
}

/// The Monday of the ISO week `day` is in.
pub fn week_of(day: Date) -> Date {
    day - Duration::days(i64::from(day.weekday().number_days_from_monday()))
}

/// The start and end (exclusive) of the ISO week starting `monday`, in UTC.
pub fn week_bounds(monday: Date) -> Result<(OffsetDateTime, OffsetDateTime), StoreError> {
    if monday.weekday() != Weekday::Monday {
        return Err(StoreError::Rejected("week"));
    }
    let from = monday.with_time(Time::MIDNIGHT).assume_utc();
    Ok((from, from + Duration::weeks(1)))
}

/// What a week's update is drafted from, all of one project, read under its scope.
#[derive(Debug, Clone, PartialEq)]
pub struct WeekFacts {
    pub project: Name,
    pub stage: oryxa_fde_core::Stage,
    pub week: Date,
    pub activity: Vec<Activity>,
    /// Tasks that moved to done this week (and are still done).
    pub done: Vec<Name>,
    /// Tasks still blocked or waiting on the customer, with what blocks them.
    pub stuck: Vec<(Name, TaskStatus, Option<Text>)>,
    /// Decisions made this week.
    pub decisions: Vec<Name>,
    /// Access requests whose status changed this week.
    pub access: Vec<(Text, AccessStatus)>,
}

impl WeekFacts {
    /// Nothing happened: no update is drafted.
    pub fn is_quiet(&self) -> bool {
        self.activity.is_empty() && self.done.is_empty() && self.decisions.is_empty() && self.access.is_empty()
    }
}

const DRAFT: &str = "week, body, status, model, drafted_at, edited_by, edited_at, decided_by, decided_at";

impl ProjectTx {
    /// The facts of the week starting `monday`. `None` if the project is not in this company.
    pub async fn week_facts(&mut self, monday: Date) -> Result<Option<WeekFacts>, StoreError> {
        let Some(project) = self.get().await? else {
            return Ok(None);
        };
        let (from, to) = week_bounds(monday)?;
        let activity = self.activity_between(from, to).await?;
        let (t, c, p) = self.keys();
        let done = sqlx::query_scalar::<_, String>(
            "select title from tasks where tenant_id = $1 and company_id = $2 and project_id = $3
                 and status = 'done' and done_at >= $4 and done_at < $5 order by done_at, task_id",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(from)
        .bind(to)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(|v| name(v, "task title"))
        .collect::<Result<_, _>>()?;
        let stuck = sqlx::query(
            "select title, status, blocker from tasks where tenant_id = $1 and company_id = $2 and project_id = $3
                 and status in ('blocked', 'waiting_on_customer') order by created_at, task_id",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(|r| {
            let status = match r.try_get::<&str, _>("status")? {
                "blocked" => TaskStatus::Blocked,
                _ => TaskStatus::WaitingOnCustomer,
            };
            let blocker: Option<String> = r.try_get("blocker")?;
            Ok((
                name(r.try_get("title")?, "task title")?,
                status,
                blocker.map(|b| text(b, "blocker")).transpose()?,
            ))
        })
        .collect::<Result<_, StoreError>>()?;
        let decisions = sqlx::query_scalar::<_, String>(
            "select title from decisions where tenant_id = $1 and company_id = $2 and project_id = $3
                 and created_at >= $4 and created_at < $5 order by created_at, decision_id",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(from)
        .bind(to)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(|v| name(v, "decision title"))
        .collect::<Result<_, _>>()?;
        let access = sqlx::query(
            "select description, status from access_requests where tenant_id = $1 and company_id = $2
                 and project_id = $3 and status_changed_at >= $4 and status_changed_at < $5
             order by status_changed_at, access_request_id",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(from)
        .bind(to)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(|r| {
            let status = crate::access::parse(r.try_get("status")?)?;
            Ok((text(r.try_get("description")?, "access request")?, status))
        })
        .collect::<Result<_, StoreError>>()?;
        Ok(Some(WeekFacts {
            project: project.name,
            stage: project.stage,
            week: monday,
            activity,
            done,
            stuck,
            decisions,
            access,
        }))
    }

    /// Counts one model call for the update of the week starting `monday`: `false`, and nothing
    /// counted, once `max` calls were made, so a draft the model keeps refusing is not paid for
    /// every hour.
    pub async fn claim_update_attempt(&mut self, monday: Date, max: u32) -> Result<bool, StoreError> {
        week_bounds(monday)?;
        let (t, c, p) = self.keys();
        let claimed: Option<i32> = sqlx::query_scalar(
            "insert into update_draft_attempts (tenant_id, company_id, project_id, week, attempts)
             select $1, $2, $3, $4, 1
             where $5 >= 1
                 and exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)
             on conflict (tenant_id, project_id, week) do update
                 set attempts = update_draft_attempts.attempts + 1, last_attempt_at = now()
                 where update_draft_attempts.attempts < $5
             returning attempts",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(monday)
        .bind(i64::from(max))
        .fetch_optional(&mut *self.tx)
        .await?;
        Ok(claimed.is_some())
    }

    /// Stores the drafted update of the week starting `monday`, unless the week has one already.
    /// `false` if it has, or the project is not in this company.
    pub async fn add_update_draft(&mut self, monday: Date, body: &UpdateBody, model: &str) -> Result<bool, StoreError> {
        week_bounds(monday)?;
        let (t, c, p) = self.keys();
        let n = sqlx::query(
            "insert into update_drafts (tenant_id, company_id, project_id, week, body, model)
             select $1, $2, $3, $4, $5, $6
             where exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)
             on conflict do nothing",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(monday)
        .bind(body.as_str())
        .bind(model)
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        Ok(n == 1)
    }

    /// The project's updates, newest week first.
    pub async fn update_drafts(&mut self) -> Result<Vec<UpdateDraft>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {DRAFT} from update_drafts where tenant_id = $1 and company_id = $2 and project_id = $3
             order by week desc"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(draft)
        .collect()
    }

    pub async fn update_draft(&mut self, monday: Date) -> Result<Option<UpdateDraft>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {DRAFT} from update_drafts where tenant_id = $1 and company_id = $2 and project_id = $3
                 and week = $4"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(monday)
        .fetch_optional(&mut *self.tx)
        .await?
        .map(draft)
        .transpose()
    }

    /// Replaces a draft's text. `None` if there is no update that week; `Rejected("update_decided")`
    /// once it is approved or discarded.
    pub async fn edit_update_draft(
        &mut self,
        monday: Date,
        body: &UpdateBody,
        by: &crate::Actor,
    ) -> Result<Option<UpdateDraft>, StoreError> {
        let set = "body = coalesce($5::text, body), edited_by = $6, edited_at = now()";
        self.change_draft(monday, set, Some(body.as_str()), by, "update.edited")
            .await
    }

    /// Approves (`true`) or discards a draft; either is final. `None` if there is no update that
    /// week; `Rejected("update_decided")` once it is approved or discarded.
    pub async fn decide_update_draft(
        &mut self,
        monday: Date,
        approve: bool,
        by: &crate::Actor,
    ) -> Result<Option<UpdateDraft>, StoreError> {
        let (set, action) = if approve {
            (
                "body = coalesce($5::text, body), status = 'approved', decided_by = $6, decided_at = now()",
                "update.approved",
            )
        } else {
            (
                "body = coalesce($5::text, body), status = 'discarded', decided_by = $6, decided_at = now()",
                "update.discarded",
            )
        };
        self.change_draft(monday, set, None, by, action).await
    }

    async fn change_draft(
        &mut self,
        monday: Date,
        set: &'static str,
        body: Option<&str>,
        by: &crate::Actor,
        action: &'static str,
    ) -> Result<Option<UpdateDraft>, StoreError> {
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "update update_drafts set {set}
             where tenant_id = $1 and company_id = $2 and project_id = $3 and week = $4 and status = 'draft'
             returning {DRAFT}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(monday)
        .bind(body)
        .bind(by.user.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else {
            return match self.update_draft(monday).await? {
                Some(_) => Err(StoreError::Rejected("update_decided")),
                None => Ok(None),
            };
        };
        let s = self.scope.clone();
        let week = monday.to_string();
        audit(&mut self.tx, &s.company, Some(&s.project), by, action, Some(&week)).await?;
        draft(row).map(Some)
    }
}

fn draft(r: PgRow) -> Result<UpdateDraft, StoreError> {
    let user = |col: &str| -> Result<Option<UserId>, StoreError> {
        let v: Option<String> = r.try_get(col)?;
        v.map(|u| id("user id", UserId::new, u)).transpose()
    };
    Ok(UpdateDraft {
        week: r.try_get("week")?,
        body: UpdateBody::new(r.try_get::<String, _>("body")?).map_err(|_| StoreError::Corrupt("update body"))?,
        status: UpdateStatus::parse(r.try_get("status")?)?,
        model: r.try_get("model")?,
        drafted_at: r.try_get("drafted_at")?,
        edited_by: user("edited_by")?,
        edited_at: r.try_get("edited_at")?,
        decided_by: user("decided_by")?,
        decided_at: r.try_get("decided_at")?,
    })
}

/// Held while one copy of the service drafts one project's week; another copy finds it taken and
/// skips that week. A session advisory lock on a connection of its own, never back in the pool:
/// closing the connection releases it, so a drafter that dies never keeps it.
pub struct DraftingLock {
    conn: sqlx::PgConnection,
}

impl DraftingLock {
    pub async fn release(self) -> Result<(), StoreError> {
        use sqlx::Connection;
        self.conn.close().await?;
        Ok(())
    }
}

impl Store {
    /// The drafting lock of one project's week, if no other copy holds it.
    pub async fn lock_drafting(
        &self,
        scope: &oryxa_fde_core::ProjectScope,
        monday: Date,
    ) -> Result<Option<DraftingLock>, StoreError> {
        let mut conn = self.pool.acquire().await?;
        let key = format!(
            "oryxa-fde-lifecycle|draft|{}|{}|{monday}",
            scope.tenant(),
            scope.project
        );
        let locked: bool = sqlx::query_scalar("select pg_try_advisory_lock(hashtextextended($1, 0))")
            .bind(&key)
            .fetch_one(&mut *conn)
            .await?;
        // Unlocked, the connection goes back to the pool holding nothing.
        Ok(locked.then(|| DraftingLock { conn: conn.detach() }))
    }
}

#[cfg(test)]
mod tests {
    use time::macros::date;

    use super::*;

    #[test]
    fn a_week_is_named_by_its_monday() {
        assert_eq!(week_of(date!(2026 - 11 - 04)), date!(2026 - 11 - 02));
        assert_eq!(week_of(date!(2026 - 11 - 02)), date!(2026 - 11 - 02));
        assert_eq!(week_of(date!(2026 - 11 - 08)), date!(2026 - 11 - 02));
        let (from, to) = week_bounds(date!(2026 - 11 - 02)).unwrap();
        assert_eq!((to - from), Duration::weeks(1));
        assert!(week_bounds(date!(2026 - 11 - 03)).is_err(), "not a Monday");
    }

    #[test]
    fn an_update_body_is_bounded_text() {
        assert_eq!(UpdateBody::new("  Done: X  ").unwrap().as_str(), "Done: X");
        assert!(UpdateBody::new("line\n\tindented").is_ok());
        for bad in [
            String::new(),
            "   ".into(),
            "a\u{7}b".into(),
            "a".repeat(MAX_UPDATE_CHARS + 1),
        ] {
            assert!(UpdateBody::new(bad.clone()).is_err(), "{bad:?}");
        }
    }
}
