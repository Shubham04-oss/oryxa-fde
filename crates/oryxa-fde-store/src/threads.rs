//! Comment threads on a record or a canvas shape. A thread lives where its subject does: a
//! company's records (stakeholders, systems, documents, the company's meeting notes and canvas)
//! or a project's (its lifecycle records, meeting notes and canvas; the company's stakeholders and
//! systems too). Comments are append-only. A project's thread can be promoted to its decisions
//! log, once.

use oryxa_core::UserId;
use oryxa_fde_core::{
    AccessRequestId, CriterionId, DecisionId, DocumentId, ScopeItemId, StakeholderId, SystemId, TaskId,
};
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::OffsetDateTime;

use crate::ids::{CommentId, MeetingNoteId, ShapeId, ThreadId};
use crate::plan::{AT, PlanTx};
use crate::{Actor, Decision, DecisionIn, Name, ProjectTx, StoreError, Text, id, text, unique_violation};

/// What a thread is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Subject {
    Stakeholder(StakeholderId),
    System(SystemId),
    Document(DocumentId),
    Task(TaskId),
    Decision(DecisionId),
    AccessRequest(AccessRequestId),
    ScopeItem(ScopeItemId),
    Criterion(CriterionId),
    MeetingNote(MeetingNoteId),
    /// A shape on the canvas of the thread's company or project.
    Shape(ShapeId),
}

/// Where a subject's record is, as (table, id column), for the check that it is in the thread's
/// place.
enum Lives {
    /// In the company, whichever the place.
    Company(&'static str, &'static str),
    /// At a company only: project people do not read the company's documents.
    CompanyOnly(&'static str, &'static str),
    /// In the place's project.
    Project(&'static str, &'static str),
    /// At the place itself (a company's own, or the project's).
    Place(&'static str, &'static str),
    /// On the place's canvas, which keeps no record of its shapes.
    Canvas,
}

impl Subject {
    pub fn kind(&self) -> &'static str {
        match self {
            Subject::Stakeholder(_) => "stakeholder",
            Subject::System(_) => "system",
            Subject::Document(_) => "document",
            Subject::Task(_) => "task",
            Subject::Decision(_) => "decision",
            Subject::AccessRequest(_) => "access_request",
            Subject::ScopeItem(_) => "scope_item",
            Subject::Criterion(_) => "criterion",
            Subject::MeetingNote(_) => "meeting_note",
            Subject::Shape(_) => "shape",
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Subject::Stakeholder(i) => i.as_str(),
            Subject::System(i) => i.as_str(),
            Subject::Document(i) => i.as_str(),
            Subject::Task(i) => i.as_str(),
            Subject::Decision(i) => i.as_str(),
            Subject::AccessRequest(i) => i.as_str(),
            Subject::ScopeItem(i) => i.as_str(),
            Subject::Criterion(i) => i.as_str(),
            Subject::MeetingNote(i) => i.as_str(),
            Subject::Shape(i) => i.as_str(),
        }
    }

    /// From a kind and an id; `None` if either is invalid.
    pub fn parse(kind: &str, id: String) -> Option<Self> {
        Some(match kind {
            "stakeholder" => Subject::Stakeholder(StakeholderId::new(id).ok()?),
            "system" => Subject::System(SystemId::new(id).ok()?),
            "document" => Subject::Document(DocumentId::new(id).ok()?),
            "task" => Subject::Task(TaskId::new(id).ok()?),
            "decision" => Subject::Decision(DecisionId::new(id).ok()?),
            "access_request" => Subject::AccessRequest(AccessRequestId::new(id).ok()?),
            "scope_item" => Subject::ScopeItem(ScopeItemId::new(id).ok()?),
            "criterion" => Subject::Criterion(CriterionId::new(id).ok()?),
            "meeting_note" => Subject::MeetingNote(MeetingNoteId::new(id).ok()?),
            "shape" => Subject::Shape(ShapeId::new(id).ok()?),
            _ => return None,
        })
    }

    fn lives(&self) -> Lives {
        match self {
            Subject::Stakeholder(_) => Lives::Company("stakeholders", "stakeholder_id"),
            Subject::System(_) => Lives::Company("systems", "system_id"),
            Subject::Document(_) => Lives::CompanyOnly("documents", "document_id"),
            Subject::Task(_) => Lives::Project("tasks", "task_id"),
            Subject::Decision(_) => Lives::Project("decisions", "decision_id"),
            Subject::AccessRequest(_) => Lives::Project("access_requests", "access_request_id"),
            Subject::ScopeItem(_) => Lives::Project("scope_items", "item_id"),
            Subject::Criterion(_) => Lives::Project("criteria", "criterion_id"),
            Subject::MeetingNote(_) => Lives::Place("meeting_notes", "note_id"),
            Subject::Shape(_) => Lives::Canvas,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thread {
    pub id: ThreadId,
    pub subject: Subject,
    /// The decision it was promoted to.
    pub decision: Option<DecisionId>,
    pub created_by: UserId,
    pub created_at: OffsetDateTime,
    pub comments: u32,
    pub last_comment_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comment {
    pub id: CommentId,
    pub body: Text,
    pub author: UserId,
    pub created_at: OffsetDateTime,
}

/// What promoting a thread records; the rationale defaults to the thread's opening comment.
#[derive(Debug, Clone)]
pub struct PromoteIn {
    pub title: Name,
    pub rationale: Option<Text>,
    pub decided_by: Name,
    pub decided_at: OffsetDateTime,
}

const THREAD: &str = "t.thread_id, t.subject_kind, t.subject_id, t.decision_id, t.created_by, t.created_at,
    (select count(*) from thread_comments m where m.tenant_id = t.tenant_id and m.thread_id = t.thread_id) as comments,
    (select max(m.created_at) from thread_comments m where m.tenant_id = t.tenant_id and m.thread_id = t.thread_id)
        as last_comment_at";
const COMMENT: &str = "comment_id, body, author, created_at";

impl PlanTx {
    /// The place's threads, most recently active first; only those about `subject` if given.
    pub async fn threads(&mut self, subject: Option<&Subject>) -> Result<Vec<Thread>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {THREAD} from threads t
             where t.{AT} and ($4::text is null or (t.subject_kind = $4 and t.subject_id = $5))
             order by last_comment_at desc, t.thread_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(subject.map(Subject::kind))
        .bind(subject.map(Subject::id))
        .fetch_all(self.conn())
        .await?
        .into_iter()
        .map(thread)
        .collect()
    }

    pub async fn thread(&mut self, id: &ThreadId) -> Result<Option<Thread>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {THREAD} from threads t where t.{AT} and t.thread_id = $4"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .fetch_optional(self.conn())
        .await?
        .map(thread)
        .transpose()
    }

    /// The thread's comments, oldest first; `None` if the thread is not at this place.
    pub async fn comments(&mut self, id: &ThreadId) -> Result<Option<Vec<Comment>>, StoreError> {
        if self.thread(id).await?.is_none() {
            return Ok(None);
        }
        let (t, c, _) = self.keys();
        let list = sqlx::query(&format!(
            "select {COMMENT} from thread_comments where tenant_id = $1 and company_id = $2 and thread_id = $3
             order by created_at, comment_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(id.as_str())
        .fetch_all(self.conn())
        .await?
        .into_iter()
        .map(comment)
        .collect::<Result<_, _>>()?;
        Ok(Some(list))
    }

    /// Starts a thread about `subject` with its first comment. `None` if the company or project
    /// does not exist; `Missing("subject")` if the subject is not at this place.
    pub async fn start_thread(
        &mut self,
        id: &ThreadId,
        subject: &Subject,
        first: (&CommentId, &Text),
        by: &Actor,
    ) -> Result<Option<Thread>, StoreError> {
        if !self.exists().await? {
            return Ok(None);
        }
        if !self.subject_here(subject).await? {
            return Err(StoreError::Missing("subject"));
        }
        let (t, c, p) = self.keys();
        sqlx::query(
            "insert into threads (tenant_id, company_id, project_id, thread_id, subject_kind, subject_id, created_by)
             values ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(subject.kind())
        .bind(subject.id())
        .bind(by.user.as_str())
        .execute(self.conn())
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        self.insert_comment(id, first.0, first.1, by).await?;
        self.audit(by, "thread.started", id.as_str()).await?;
        self.thread(id).await
    }

    /// Adds a comment; `None` if the thread is not at this place.
    pub async fn comment(
        &mut self,
        thread: &ThreadId,
        id: &CommentId,
        body: &Text,
        by: &Actor,
    ) -> Result<Option<Comment>, StoreError> {
        if self.thread(thread).await?.is_none() {
            return Ok(None);
        }
        let added = self.insert_comment(thread, id, body, by).await?;
        self.audit(by, "thread.commented", thread.as_str()).await?;
        Ok(Some(added))
    }

    async fn insert_comment(
        &mut self,
        thread: &ThreadId,
        id: &CommentId,
        body: &Text,
        by: &Actor,
    ) -> Result<Comment, StoreError> {
        let (t, c, _) = self.keys();
        let row = sqlx::query(&format!(
            "insert into thread_comments (tenant_id, company_id, thread_id, comment_id, body, author)
             values ($1, $2, $3, $4, $5, $6) returning {COMMENT}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(thread.as_str())
        .bind(id.as_str())
        .bind(body.as_str())
        .bind(by.user.as_str())
        .fetch_one(self.conn())
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        comment(row)
    }

    /// Whether the subject's record is at this place (see [`Subject`]).
    async fn subject_here(&mut self, subject: &Subject) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        // Table and column names come from `lives`, never from input. `$1` tenant, `$2` company,
        // `$3` the subject's id and, where the place matters, `$4` the project or null.
        let (sql, by_place) = match subject.lives() {
            Lives::Canvas => return Ok(true),
            Lives::CompanyOnly(..) if p.is_some() => return Ok(false),
            Lives::Project(..) if p.is_none() => return Ok(false),
            Lives::Company(table, column) | Lives::CompanyOnly(table, column) => (
                format!("select exists (select 1 from {table} where tenant_id = $1 and company_id = $2 and {column} = $3)"),
                false,
            ),
            Lives::Project(table, column) | Lives::Place(table, column) => (
                format!(
                    "select exists (select 1 from {table}
                         where tenant_id = $1 and company_id = $2 and {column} = $3 and project_id is not distinct from $4)"
                ),
                true,
            ),
        };
        let mut q = sqlx::query_scalar(&sql).bind(&t).bind(&c).bind(subject.id());
        if by_place {
            q = q.bind(&p);
        }
        let found: bool = q.fetch_one(self.conn()).await?;
        Ok(found)
    }
}

impl ProjectTx {
    /// Records the thread as a decision and marks it promoted. `None` if the thread is not in this
    /// project; `Rejected("already_promoted")` the second time.
    pub async fn promote_thread(
        &mut self,
        thread: &ThreadId,
        decision: &DecisionId,
        v: &PromoteIn,
        by: &Actor,
    ) -> Result<Option<Decision>, StoreError> {
        let (t, c, p) = self.keys();
        // Locked, so two promotions of one thread cannot both record a decision.
        let row = sqlx::query(
            "select decision_id,
                 (select body from thread_comments m where m.tenant_id = t.tenant_id and m.thread_id = t.thread_id
                  order by created_at, comment_id limit 1) as opening
             from threads t
             where tenant_id = $1 and company_id = $2 and project_id = $3 and thread_id = $4 for update",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(thread.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(row) = row else { return Ok(None) };
        let promoted: Option<String> = row.try_get("decision_id")?;
        if promoted.is_some() {
            return Err(StoreError::Rejected("already_promoted"));
        }
        let rationale = match &v.rationale {
            Some(r) => r.clone(),
            None => text(row.try_get("opening")?, "comment")?,
        };
        let input = DecisionIn {
            title: v.title.clone(),
            rationale,
            decided_by: v.decided_by.clone(),
            decided_at: v.decided_at,
        };
        let Some(recorded) = self.record_decision(decision, &input, by).await? else {
            return Ok(None);
        };
        sqlx::query(
            "update threads set decision_id = $5
             where tenant_id = $1 and company_id = $2 and project_id = $3 and thread_id = $4",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(thread.as_str())
        .bind(decision.as_str())
        .execute(&mut *self.tx)
        .await?;
        let s = self.scope.clone();
        crate::audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "thread.promoted",
            Some(thread.as_str()),
        )
        .await?;
        Ok(Some(recorded))
    }
}

fn thread(r: PgRow) -> Result<Thread, StoreError> {
    let kind: String = r.try_get("subject_kind")?;
    let decision: Option<String> = r.try_get("decision_id")?;
    let created_at: OffsetDateTime = r.try_get("created_at")?;
    let comments: i64 = r.try_get("comments")?;
    let last: Option<OffsetDateTime> = r.try_get("last_comment_at")?;
    Ok(Thread {
        id: id("thread id", ThreadId::new, r.try_get("thread_id")?)?,
        subject: Subject::parse(&kind, r.try_get("subject_id")?).ok_or(StoreError::Corrupt("thread subject"))?,
        decision: decision.map(|d| id("decision id", DecisionId::new, d)).transpose()?,
        created_by: id("created_by", UserId::new, r.try_get("created_by")?)?,
        created_at,
        comments: u32::try_from(comments).map_err(|_| StoreError::Corrupt("comment count"))?,
        last_comment_at: last.unwrap_or(created_at),
    })
}

fn comment(r: PgRow) -> Result<Comment, StoreError> {
    Ok(Comment {
        id: id("comment id", CommentId::new, r.try_get("comment_id")?)?,
        body: text(r.try_get("body")?, "comment")?,
        author: id("author", UserId::new, r.try_get("author")?)?,
        created_at: r.try_get("created_at")?,
    })
}
