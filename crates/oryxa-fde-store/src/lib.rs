//! FDE storage on Postgres. Every query runs in a transaction opened for one [`CompanyScope`] or
//! [`ProjectScope`]: the SQL filters by tenant and company, and row-level security (set up per
//! transaction) hides every other row even from a query that forgets to.
//!
//! State changes write an audit row and, where one applies, an outbox event in the same
//! transaction; [`relay`] publishes the outbox.
//!
//! The service connects with a runtime login that owns nothing and holds no privilege outside a
//! transaction's role ([`Store::connect`] refuses any other); migrations run separately as the
//! owner ([`migrate`]).

use std::fmt;

use oryxa_core::{TenantId, UserId};
use oryxa_events::{Event, encode, new_envelope, v1};
use oryxa_fde_core::{Check, CompanyId, CompanyScope, ProjectId, ProjectScope, StageError};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use sqlx::{PgConnection, Postgres, Transaction};

mod access;
mod assistant;
mod canvas;
mod checklist;
mod companies;
mod digest;
mod documents;
mod engine;
mod evals;
mod grants;
pub mod iam;
mod ids;
mod integrations;
mod meetings;
mod org;
mod plan;
mod projects;
mod records;
pub mod relay;
mod runs;
mod scope;
mod setup;
mod share;
mod sign_in;
#[cfg(any(test, feature = "testing"))]
pub mod testing;
mod updates;

mod threads;
mod views;
mod work;

pub use access::{AccessRequest, AccessRequestIn};
pub use assistant::{
    AssistantTx, Conversation, ConversationScope, MAX_BLOCKS, MAX_BLOCKS_BYTES, MAX_PROPOSALS, MAX_PROPOSALS_BYTES,
    MAX_REPLY_CHARS, MAX_SAID_CHARS, MAX_TURNS, Said, Turn, TurnKey, TurnState, reply_fits,
};
pub use canvas::{
    INLINE_SNAPSHOT_BYTES, LinkTarget, MAX_VERSIONS_LISTED, ShapeLink, Snapshot, SnapshotBody, SnapshotIn, SnapshotMeta,
};
pub use checklist::{ChecklistItem, MAX_REASON_CHARS, Reason, ReasonError};
pub use companies::{Company, CompanyIn, CompanyTx, Member, Role};
pub use digest::{DIGEST_ATTEMPTS, DIGEST_WINDOW, DigestClaim, DueDigest, UnsubscribeToken};
pub use documents::{ChunkHit, ChunkIn, ContentType, Document, DocumentIn, DocumentStatus};
pub use engine::{Activity, ActivityIn, CriterionResult, Suggestion, SuggestionKind, engine_actor};
pub use evals::{EvalCaseResultRow, EvalCaseRow, EvalCriterionRow, EvalResults, EvalRunRow, EvalSuiteRow};
pub use grants::{Grant, GrantRow, PendingGrant, PendingGrants};
pub use ids::{CommentId, ConversationId, MeetingNoteId, ShapeId, SnapshotId, ThreadId};
pub use integrations::{
    Claimed, GitHubInstallation, GitHubRepository, RepositoryName, SlackChannel, SlackChannelId, SlackInstallation,
    SlackPost, SlackTeamId,
};
pub use meetings::{MAX_NOTE_CHARS, MeetingNote, MeetingNoteIn, NoteText, NoteTextError};
pub use org::{Dismissal, OrgTx, SecurityAnswer, SecurityAnswerIn, SuggestionKey};
pub use plan::PlanTx;
pub use projects::{Assignee, NextStep, Project, ProjectIn, ProjectTx};
pub use records::{Stakeholder, StakeholderIn, StakeholderRole, System, SystemIn};
pub use runs::{AgentApprovalRow, AgentBudget, AgentDecided, AgentDecision, AgentRunRow, AgentSpend};
pub use scope::{
    Comparator, Criterion, CriterionIn, CriterionProof, MAX_PROOF_CHARS, Proof, ProofError, ScopeChange, ScopeItem,
    ScopeItemIn, ScopeKind, ScopeOfWork, SignOff,
};
pub use updates::{
    DraftingLock, MAX_UPDATE_CHARS, UpdateBody, UpdateDraft, UpdateStatus, WeekFacts, week_bounds, week_of,
};

pub use threads::{Comment, PromoteIn, Subject, Thread};

pub use setup::SetupClaim;
pub use share::{Redeemed, ShareLink};
pub use sign_in::Hit as SignInHit;
pub use views::{CompanySummary, Named, TodayItem};
pub use work::{Decision, DecisionIn, Page, Task, TaskIn, TaskPlace, TaskStatus};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("migrate: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("configuration: {0}")]
    Config(String),
    /// The runtime login, or a role it can reach, could act as an owner; migrations need their own
    /// login.
    #[error("refusing a database login that can reach owner powers: {0}")]
    Privileged(String),
    #[error("encode event: {0}")]
    Event(#[from] oryxa_events::PublishError),
    #[error("stored {0} is invalid")]
    Corrupt(&'static str),
    #[error("scopes must share one tenant")]
    MixedTenants,
    /// A duplicate id, or a delete of a record that others still refer to.
    #[error("conflicts with existing data")]
    Conflict,
    /// A referenced record (e.g. a stakeholder) is not in this company.
    #[error("no such {0} in this company")]
    Missing(&'static str),
    #[error(transparent)]
    Stage(#[from] StageError),
    /// The request breaks a rule of the record, e.g. signing off an empty scope.
    #[error("{0}")]
    Rejected(&'static str),
    /// A forward stage move with these checks open and no reason given.
    #[error("checks open to leave the stage: {0:?}")]
    ChecklistOpen(Vec<Check>),
}

impl StoreError {
    /// Whether the same call would fail the same way again: the data breaks a rule (refused,
    /// corrupt, a constraint or a bad value), as opposed to a database that is unreachable, busy or
    /// misconfigured, where trying later may work.
    pub fn is_permanent(&self) -> bool {
        match self {
            StoreError::Rejected(_)
            | StoreError::ChecklistOpen(_)
            | StoreError::Corrupt(_)
            | StoreError::Missing(_)
            | StoreError::Conflict
            | StoreError::Stage(_)
            | StoreError::MixedTenants
            | StoreError::Event(_) => true,
            // Class 22 is a bad value, class 23 a broken constraint.
            StoreError::Db(sqlx::Error::Database(d)) => {
                d.code().is_some_and(|c| c.starts_with("22") || c.starts_with("23"))
            }
            StoreError::Db(sqlx::Error::ColumnDecode { .. } | sqlx::Error::Decode(_) | sqlx::Error::Encode(_)) => true,
            _ => false,
        }
    }
}

/// Who made a change, for the audit log and the event envelope. `request_id` is generated by the
/// service, never taken from the caller.
#[derive(Debug, Clone)]
pub struct Actor {
    pub user: UserId,
    pub request_id: String,
}

/// What a whole-record save did, checked under the record's row lock against the version the
/// caller read (`None`: no check, the last writer wins).
#[derive(Debug, Clone, PartialEq)]
pub enum Saved<T, S = T> {
    /// Written, or left as it was because it already held these values: the record as it stands.
    Current(T),
    /// The record has moved on from the version the caller read; nothing was written. The
    /// record as it stands.
    Stale(S),
}

impl<T, S> Saved<T, S> {
    /// Converts the record, whichever way the save went, e.g. into an API answer.
    pub fn map<U, V>(self, current: impl FnOnce(T) -> U, stale: impl FnOnce(S) -> V) -> Saved<U, V> {
        match self {
            Saved::Current(t) => Saved::Current(current(t)),
            Saved::Stale(s) => Saved::Stale(stale(s)),
        }
    }
}

impl<T> Saved<T> {
    /// The record as it stands, whether or not this save wrote it.
    pub fn record(self) -> T {
        match self {
            Saved::Current(t) | Saved::Stale(t) => t,
        }
    }
}

/// Whether a save that read `expected` is too late for a record now at `current`.
pub(crate) fn stale(expected: Option<u32>, current: u32) -> bool {
    expected.is_some_and(|e| e != current)
}

/// A version column, which starts at 1 and only grows.
pub(crate) fn row_version(v: i32) -> Result<u32, StoreError> {
    u32::try_from(v).map_err(|_| StoreError::Corrupt("version"))
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("a name must be 1..={MAX_NAME_CHARS} characters with no control characters")]
pub struct NameError;

pub const MAX_NAME_CHARS: usize = 200;

/// A display name (company, project). Customer text: it stays in Postgres and never reaches
/// SpiceDB, events or logs, so `Debug` shows only its length.
#[derive(Clone, PartialEq, Eq)]
pub struct Name(String);

impl Name {
    pub fn new(value: impl AsRef<str>) -> Result<Self, NameError> {
        let v = value.as_ref().trim();
        let chars = v.chars().count();
        if (1..=MAX_NAME_CHARS).contains(&chars) && !v.chars().any(char::is_control) {
            Ok(Self(v.to_owned()))
        } else {
            Err(NameError)
        }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Name {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Name(<{} chars>)", self.0.chars().count())
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("text must be 1..={MAX_TEXT_CHARS} characters with no control characters but newlines and tabs")]
pub struct TextError;

pub const MAX_TEXT_CHARS: usize = 4000;

/// Free text on a record (a description, an answer, a rationale). Customer text, like [`Name`]:
/// never in SpiceDB, events or logs.
#[derive(Clone, PartialEq, Eq)]
pub struct Text(String);

impl Text {
    pub fn new(value: impl AsRef<str>) -> Result<Self, TextError> {
        let v = value.as_ref().trim();
        let chars = v.chars().count();
        let ok = (1..=MAX_TEXT_CHARS).contains(&chars) && !v.chars().any(|c| c.is_control() && c != '\n' && c != '\t');
        if ok { Ok(Self(v.to_owned())) } else { Err(TextError) }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Text {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Text(<{} chars>)", self.0.chars().count())
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("an email address must be local@domain.tld, at most 254 characters, with no spaces")]
pub struct EmailError;

/// An email address of someone at the customer, for the weekly digest. Customer data: it stays in
/// Postgres and the mail sent to it, never in SpiceDB, events or logs, so `Debug` hides it.
#[derive(Clone, PartialEq, Eq)]
pub struct EmailAddress(String);

impl EmailAddress {
    pub fn new(value: impl AsRef<str>) -> Result<Self, EmailError> {
        let v = value.as_ref().trim();
        let Some((local, domain)) = v.split_once('@') else {
            return Err(EmailError);
        };
        let printable = v
            .chars()
            .all(|c| c.is_ascii_graphic() && !matches!(c, '<' | '>' | ',' | ';' | '"' | '(' | ')' | '\\' | '[' | ']'));
        let ok = v.len() <= 254
            && printable
            && (1..=64).contains(&local.len())
            && !domain.contains('@')
            && domain.contains('.')
            && !domain.starts_with('.')
            && !domain.ends_with('.')
            && !domain.contains("..");
        if ok { Ok(Self(v.to_owned())) } else { Err(EmailError) }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for EmailAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EmailAddress(<hidden>)")
    }
}

/// A fresh id for a new record, e.g. `cmp_0192…`. Server-generated, so always in the id charset.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::now_v7().simple())
}

/// Runs the migrations as `url`'s login, which owns the tables: a one-off task with its own
/// login, never the service's.
pub async fn migrate(url: &str) -> Result<(), StoreError> {
    let pool = PgPoolOptions::new().max_connections(1).connect(url).await?;
    let result = migrate_with(&pool).await;
    pool.close().await;
    result
}

/// Runs the migrations as the migrator: with IAM tokens when `DB_HOST` and the rest are set (see
/// [`iam::IamConfig`]), else as `MIGRATION_DATABASE_URL`'s login.
pub async fn migrate_from_env() -> Result<(), StoreError> {
    match iam::IamConfig::from_env()? {
        Some(cfg) => {
            let tokens = iam::RdsIam::from_env(&cfg).await?;
            iam::migrate_iam(&cfg, &tokens).await
        }
        None => {
            let url = std::env::var("MIGRATION_DATABASE_URL")
                .map_err(|_| StoreError::Config("MIGRATION_DATABASE_URL or DB_HOST".into()))?;
            migrate(&url).await
        }
    }
}

pub(crate) async fn migrate_with(pool: &PgPool) -> Result<(), StoreError> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

#[derive(Clone)]
pub struct Store {
    // Private: every query goes through a scoped transaction, which takes a role.
    pool: PgPool,
}

impl Store {
    /// Connects as the runtime login, after checking it cannot act as the owner.
    pub async fn connect(url: &str) -> Result<Self, StoreError> {
        Self::connect_with(url.parse::<PgConnectOptions>()?).await
    }

    /// Connects as the runtime login: with IAM tokens when `DB_HOST` and the rest are set (see
    /// [`iam::IamConfig`]), else as `DATABASE_URL`'s login (local and test runs).
    pub async fn from_env() -> Result<Self, StoreError> {
        match iam::IamConfig::from_env()? {
            Some(cfg) => {
                let tokens = std::sync::Arc::new(iam::RdsIam::from_env(&cfg).await?);
                Self::connect_iam(cfg, tokens, iam::REFRESH_EVERY).await
            }
            None => {
                let url =
                    std::env::var("DATABASE_URL").map_err(|_| StoreError::Config("DATABASE_URL or DB_HOST".into()))?;
                Self::connect(&url).await
            }
        }
    }

    pub async fn connect_with(options: PgConnectOptions) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new().max_connections(10).connect_with(options).await?;
        if let Some(why) = owner_powers(&pool).await? {
            pool.close().await;
            return Err(StoreError::Privileged(why));
        }
        Ok(Self { pool })
    }

    /// Companies for the given scopes (the caller's permitted companies), by name.
    pub async fn companies(&self, scopes: &[CompanyScope]) -> Result<Vec<Company>, StoreError> {
        let Some(first) = scopes.first() else {
            return Ok(Vec::new());
        };
        if scopes.iter().any(|s| s.tenant != first.tenant) {
            return Err(StoreError::MixedTenants);
        }
        let ids: Vec<&CompanyId> = scopes.iter().map(|s| &s.company).collect();
        let mut tx = self.scoped(&first.tenant, &ids).await?;
        let list = companies::list(&mut tx, &first.tenant, &ids).await?;
        tx.commit().await?;
        Ok(list)
    }

    /// A transaction limited to one company.
    pub async fn company(&self, scope: &CompanyScope) -> Result<CompanyTx, StoreError> {
        let tx = self.scoped(&scope.tenant, &[&scope.company]).await?;
        Ok(CompanyTx::new(tx, scope.clone()))
    }

    /// A read-only transaction limited to one company that sees one moment of it throughout, for
    /// an export: its projects are read in the same transaction ([`CompanyTx::into_project`]).
    pub async fn company_snapshot(&self, scope: &CompanyScope) -> Result<CompanyTx, StoreError> {
        let tx = self.open_scoped(&scope.tenant, &[&scope.company], true).await?;
        Ok(CompanyTx::new(tx, scope.clone()))
    }

    /// A transaction limited to one project of one company.
    pub async fn project(&self, scope: &ProjectScope) -> Result<ProjectTx, StoreError> {
        let tx = self.scoped(&scope.company.tenant, &[&scope.company.company]).await?;
        Ok(ProjectTx::new(tx, scope.clone()))
    }

    /// A transaction limited to one organisation's own records (no company's).
    pub async fn organisation(&self, tenant: &TenantId) -> Result<OrgTx, StoreError> {
        let tx = self.scoped(tenant, &[]).await?;
        Ok(OrgTx::new(tx, tenant.clone()))
    }

    /// Opens a transaction that row-level security limits to `tenant` and `companies`.
    async fn scoped(
        &self,
        tenant: &TenantId,
        companies: &[&CompanyId],
    ) -> Result<Transaction<'static, Postgres>, StoreError> {
        self.open_scoped(tenant, companies, false).await
    }

    /// [`Store::scoped`]; a `snapshot` is read-only and sees one moment throughout.
    async fn open_scoped(
        &self,
        tenant: &TenantId,
        companies: &[&CompanyId],
        snapshot: bool,
    ) -> Result<Transaction<'static, Postgres>, StoreError> {
        let mut tx = self.pool.begin().await?;
        if snapshot {
            // Must come before any other statement of the transaction.
            sqlx::query("set transaction isolation level repeatable read, read only")
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("set local role oryxa_fde_app").execute(&mut *tx).await?;
        // Company ids are [a-zA-Z0-9_-], so a comma cannot appear inside one.
        let ids = companies.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(",");
        sqlx::query("select set_config('fde.tenant', $1, true), set_config('fde.companies', $2, true)")
            .bind(tenant.as_str())
            .bind(ids)
            .execute(&mut *tx)
            .await?;
        Ok(tx)
    }
}

/// What would let this login act as an owner, if anything, for the login and every role it can
/// reach by SET ROLE or inheritance: superuser, the right to create roles or databases or to bypass
/// row-level security, a predefined role, owning the database, a schema, a relation or a function,
/// creating in a schema, or an admin option. The same rule as the infra bootstrap's own check.
async fn owner_powers(pool: &PgPool) -> Result<Option<String>, StoreError> {
    let found: Option<String> = sqlx::query_scalar(
        "select string_agg(format('%s (%s)', r.rolname, why), ', ' order by r.rolname, why)
         from pg_roles r
         cross join lateral (values
             (r.rolsuper, 'superuser'),
             (r.rolcreaterole, 'createrole'),
             (r.rolcreatedb, 'createdb'),
             (r.rolbypassrls, 'bypassrls'),
             (r.rolname like 'pg\\_%', 'predefined role'),
             (r.oid = (select datdba from pg_database where datname = current_database()), 'owns the database'),
             (exists (select from pg_class c where c.relowner = r.oid), 'owns a relation'),
             -- An owner of fde_in_scope could redefine it and switch off every row-level policy.
             (exists (select from pg_proc p where p.proowner = r.oid), 'owns a function'),
             (exists (select from pg_namespace n where n.nspowner = r.oid), 'owns a schema'),
             (exists (select from pg_namespace n
                      where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
                        and has_schema_privilege(r.oid, n.oid, 'create')), 'create in a schema'),
             (exists (select from pg_auth_members m where m.member = r.oid and m.admin_option), 'admin option')
         ) as v(failed, why)
         where pg_has_role(current_user, r.oid, 'member') and v.failed",
    )
    .fetch_one(pool)
    .await?;
    Ok(found)
}

/// Appends an audit row: ids only.
async fn audit(
    conn: &mut PgConnection,
    scope: &CompanyScope,
    project: Option<&ProjectId>,
    by: &Actor,
    action: &'static str,
    target: Option<&str>,
) -> Result<(), StoreError> {
    audit_override(conn, scope, project, by, action, target, None).await
}

/// Appends an audit row that may also record why a rule was overridden and what it left open:
/// the one free-text field in the log.
async fn audit_override(
    conn: &mut PgConnection,
    scope: &CompanyScope,
    project: Option<&ProjectId>,
    by: &Actor,
    action: &'static str,
    target: Option<&str>,
    overridden: Option<(&Reason, &[Check])>,
) -> Result<(), StoreError> {
    let (reason, open) = match overridden {
        Some((r, open)) => (Some(r.as_str()), Some(open.iter().map(|c| c.key()).collect::<Vec<_>>())),
        None => (None, None),
    };
    sqlx::query(
        "insert into audit_log (tenant_id, company_id, project_id, actor, action, target, reason, open_items)
         values ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(scope.tenant.as_str())
    .bind(scope.company.as_str())
    .bind(project.map(ProjectId::as_str))
    .bind(by.user.as_str())
    .bind(action)
    .bind(target)
    .bind(reason)
    .bind(open)
    .execute(conn)
    .await?;
    Ok(())
}

/// Writes `data` to the outbox in the caller's transaction, enveloped for `scope`'s tenant.
async fn enqueue<T: Event>(
    conn: &mut PgConnection,
    scope: &CompanyScope,
    by: &Actor,
    data: &T,
) -> Result<String, StoreError> {
    let envelope = v1::Envelope {
        tenant: scope.tenant.to_string(),
        actor: Some(v1::Actor {
            user: by.user.to_string(),
            ..Default::default()
        }),
        correlation_id: by.request_id.clone(),
        ..new_envelope()
    };
    let e = encode(&envelope, data)?;
    sqlx::query(
        "insert into outbox (id, tenant_id, company_id, source, detail_type, group_key, detail)
         values ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&e.event_id)
    .bind(scope.tenant.as_str())
    .bind(scope.company.as_str())
    .bind(&e.source)
    .bind(&e.detail_type)
    .bind(&e.group)
    .bind(&e.detail)
    .execute(conn)
    .await?;
    Ok(e.event_id)
}

fn id<T, E>(kind: &'static str, make: impl FnOnce(String) -> Result<T, E>, raw: String) -> Result<T, StoreError> {
    make(raw).map_err(|_| StoreError::Corrupt(kind))
}

fn unique_violation(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.is_unique_violation())
}

/// Maps a delete refused by a foreign key (the record is still referenced) to `Conflict`.
fn in_use(e: sqlx::Error) -> StoreError {
    match &e {
        sqlx::Error::Database(d) if d.is_foreign_key_violation() => StoreError::Conflict,
        _ => e.into(),
    }
}

fn name(raw: String, what: &'static str) -> Result<Name, StoreError> {
    Name::new(raw).map_err(|_| StoreError::Corrupt(what))
}

fn text(raw: String, what: &'static str) -> Result<Text, StoreError> {
    Text::new(raw).map_err(|_| StoreError::Corrupt(what))
}

/// A row's optional text column, validated like on the way in.
fn opt<T>(
    raw: Option<String>,
    what: &'static str,
    make: fn(String, &'static str) -> Result<T, StoreError>,
) -> Result<Option<T>, StoreError> {
    raw.map(|r| make(r, what)).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_save_is_stale_only_when_it_names_another_version() {
        assert!(!stale(None, 7), "no version: the last writer wins");
        assert!(!stale(Some(7), 7));
        assert!(stale(Some(6), 7));
        assert!(
            stale(Some(8), 7),
            "a version from the future is not the one stored either"
        );
        assert!(row_version(-1).is_err());
    }

    #[test]
    fn names_are_trimmed_bounded_and_printable() {
        assert_eq!(Name::new("  Acme Corp ").unwrap().as_str(), "Acme Corp");
        assert_eq!(
            Name::new("é".repeat(MAX_NAME_CHARS)).unwrap().as_str().chars().count(),
            MAX_NAME_CHARS
        );
        for bad in ["", "   ", "a\nb", "tab\there", "\u{0}"] {
            assert_eq!(Name::new(bad), Err(NameError), "{bad:?}");
        }
        assert!(Name::new("x".repeat(MAX_NAME_CHARS + 1)).is_err());
    }

    #[test]
    fn only_errors_of_the_data_are_permanent() {
        for permanent in [
            StoreError::Rejected("x"),
            StoreError::Corrupt("x"),
            StoreError::Missing("x"),
            StoreError::Conflict,
            StoreError::MixedTenants,
        ] {
            assert!(permanent.is_permanent(), "{permanent:?}");
        }
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset");
        for transient in [
            StoreError::Db(sqlx::Error::Io(io)),
            StoreError::Db(sqlx::Error::PoolTimedOut),
            StoreError::Config("x".into()),
        ] {
            assert!(!transient.is_permanent(), "{transient:?}");
        }
    }

    #[test]
    fn email_addresses_are_plain_and_stay_out_of_debug_output() {
        assert_eq!(
            EmailAddress::new(" sam@acme.example ").unwrap().as_str(),
            "sam@acme.example"
        );
        for bad in [
            "",
            "sam",
            "sam@",
            "@acme.example",
            "sam@acme",
            "sam@@acme.example",
            "sam@acme..example",
            "sam smith@acme.example",
            "Sam <sam@acme.example>",
            "sam@acme.example\r\nBcc: x@evil.example",
            "sam,eve@acme.example",
        ] {
            assert_eq!(EmailAddress::new(bad), Err(EmailError), "{bad:?}");
        }
        assert!(EmailAddress::new(format!("{}@acme.example", "a".repeat(65))).is_err());
        assert_eq!(
            format!("{:?}", EmailAddress::new("sam@acme.example").unwrap()),
            "EmailAddress(<hidden>)"
        );
    }

    #[test]
    fn names_stay_out_of_debug_output() {
        assert_eq!(format!("{:?}", Name::new("Acme Corp").unwrap()), "Name(<9 chars>)");
        assert_eq!(format!("{:?}", Text::new("secret plan").unwrap()), "Text(<11 chars>)");
    }

    #[test]
    fn text_allows_lines_but_no_other_control_characters() {
        assert_eq!(Text::new(" a\n\tb ").unwrap().as_str(), "a\n\tb");
        assert!(Text::new("x".repeat(MAX_TEXT_CHARS)).is_ok());
        for bad in [
            String::new(),
            "\n".into(),
            "a\u{0}b".into(),
            "a\rb".into(),
            "x".repeat(MAX_TEXT_CHARS + 1),
        ] {
            assert_eq!(Text::new(&bad), Err(TextError), "{bad:?}");
        }
    }

    #[test]
    fn new_ids_are_valid_ids() {
        let id = new_id("cmp");
        assert!(id.starts_with("cmp_"));
        assert!(CompanyId::new(id).is_ok());
    }
}

#[cfg(test)]
mod live;
