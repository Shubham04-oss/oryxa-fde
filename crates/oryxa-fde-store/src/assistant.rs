//! Assistant conversations (#237, ADR 0008 and 0009): the record behind the Durable Object's working
//! copy. A conversation belongs to one person and one scope, fixed when it is made: one company (and
//! maybe one project in it) or that person's home. Its turns are read and written only in a
//! transaction limited to that scope, and only for the person who holds it. Their content stays in
//! Postgres: it never reaches a log, an event or SpiceDB, and `Debug` shows none of it.

use std::fmt;

use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId, ProjectScope};
use serde_json::Value;
use sqlx::postgres::PgRow;
use sqlx::{Postgres, Row, Transaction};
use time::OffsetDateTime;

use crate::{Actor, ConversationId, Store, StoreError, audit, id};

/// The most turns one conversation holds (the Worker's `MAX_TURNS`).
pub const MAX_TURNS: u32 = 50;
/// The longest message a person may send (`MAX_SAID`).
pub const MAX_SAID_CHARS: usize = 2000;
/// The most text one reply holds (`MAX_REPLY`), in UTF-16 code units as the web's `z.string().max`
/// counts it.
pub const MAX_REPLY_CHARS: usize = 8000;
/// The most blocks, and proposals, one turn holds (`MAX_BLOCKS`, `MAX_PROPOSALS`); the table checks
/// them too.
pub const MAX_BLOCKS: usize = 6;
pub const MAX_PROPOSALS: usize = 3;
/// The most bytes a turn's blocks may take as JSON text, as the table checks: room for the wire's
/// widest (six brief blocks of eight 4000-character values in 4-byte characters) with escapes.
pub const MAX_BLOCKS_BYTES: usize = 1_048_576;
/// The most bytes a turn's proposals may take as JSON text; three small actions need far less.
pub const MAX_PROPOSALS_BYTES: usize = 65_536;

/// Where a conversation is bound, for good.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversationScope {
    /// The person's home: list-level facts only (ADR 0008).
    Home(TenantId),
    Company(CompanyScope),
    Project(ProjectScope),
}

impl ConversationScope {
    pub fn tenant(&self) -> &TenantId {
        match self {
            ConversationScope::Home(t) => t,
            ConversationScope::Company(c) => &c.tenant,
            ConversationScope::Project(p) => &p.company.tenant,
        }
    }

    pub fn company(&self) -> Option<&CompanyScope> {
        match self {
            ConversationScope::Home(_) => None,
            ConversationScope::Company(c) => Some(c),
            ConversationScope::Project(p) => Some(&p.company),
        }
    }

    pub fn project(&self) -> Option<&ProjectId> {
        match self {
            ConversationScope::Project(p) => Some(&p.project),
            _ => None,
        }
    }
}

/// A conversation, without its turns' content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: ConversationId,
    pub user: UserId,
    pub scope: ConversationScope,
    pub created_at: OffsetDateTime,
    pub last_active_at: OffsetDateTime,
}

/// A turn's id as the Worker names it: `t_` and 1 to 64 of `[A-Za-z0-9_-]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnKey(String);

impl TurnKey {
    pub fn new(v: &str) -> Option<Self> {
        let rest = v.strip_prefix("t_")?;
        let ok = (1..=64).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        ok.then(|| Self(v.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What a person said in a turn, by the wire's `text(MAX_SAID)` rule: trimmed as JavaScript trims,
/// 1 to [`MAX_SAID_CHARS`] code points, and no control characters but tab, newline and carriage
/// return. Customer text, so `Debug` shows its length only.
#[derive(Clone, PartialEq, Eq)]
pub struct Said(String);

impl Said {
    pub fn new(v: &str) -> Option<Self> {
        let v = js_trim(v);
        let ok = (1..=MAX_SAID_CHARS).contains(&v.chars().count()) && plain(v);
        ok.then(|| Self(v.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Said {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Said({} chars)", self.0.chars().count())
    }
}

/// The wire's plain-text rule: none of U+0000 to U+0008, U+000B, U+000C, U+000E to U+001F or
/// U+007F (so tab, newline and carriage return pass, as do the C1 controls JavaScript's regex leaves).
pub(crate) fn plain(v: &str) -> bool {
    !v.chars()
        .any(|c| matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}'))
}

/// `String.prototype.trim`: Unicode white space and U+FEFF off both ends.
fn js_trim(v: &str) -> &str {
    // U+0085 is white space to Rust but not to JavaScript, whose trim keeps it.
    v.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// Whether a reply fits the wire: plain text of at most [`MAX_REPLY_CHARS`] UTF-16 code units, the
/// unit the web's view counts, so a stored reply never makes the web drop the conversation.
pub fn reply_fits(v: &str) -> bool {
    v.encode_utf16().count() <= MAX_REPLY_CHARS && plain(v)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnState {
    Done,
    Failed,
}

impl TurnState {
    fn parse(v: &str) -> Result<Self, StoreError> {
        match v {
            "done" => Ok(TurnState::Done),
            "failed" => Ok(TurnState::Failed),
            _ => Err(StoreError::Corrupt("turn state")),
        }
    }
}

/// A stored turn.
#[derive(Clone, PartialEq)]
pub struct Turn {
    pub n: u32,
    pub id: TurnKey,
    pub said: Said,
    pub reply: String,
    pub blocks: Value,
    pub proposals: Value,
    pub notice: Option<String>,
    pub state: TurnState,
    pub created_at: OffsetDateTime,
}

impl fmt::Debug for Turn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Turn(n={}, id={})", self.n, self.id.as_str())
    }
}

const CONVERSATION: &str = "conversation_id, user_id, company_id, project_id, created_at, last_active_at";
const TURN: &str = "n, turn_id, said, reply, blocks, proposals, notice, state, created_at";

fn conversation(tenant: &TenantId, r: PgRow) -> Result<Conversation, StoreError> {
    let company: Option<String> = r.try_get("company_id")?;
    let project: Option<String> = r.try_get("project_id")?;
    let scope = match (company, project) {
        (None, None) => ConversationScope::Home(tenant.clone()),
        (Some(c), None) => {
            ConversationScope::Company(CompanyScope::new(tenant.clone(), id("company id", CompanyId::new, c)?))
        }
        (Some(c), Some(p)) => ConversationScope::Project(
            CompanyScope::new(tenant.clone(), id("company id", CompanyId::new, c)?).project(id(
                "project id",
                ProjectId::new,
                p,
            )?),
        ),
        (None, Some(_)) => return Err(StoreError::Corrupt("conversation scope")),
    };
    Ok(Conversation {
        id: id("conversation id", ConversationId::new, r.try_get("conversation_id")?)?,
        user: id("user id", UserId::new, r.try_get("user_id")?)?,
        scope,
        created_at: r.try_get("created_at")?,
        last_active_at: r.try_get("last_active_at")?,
    })
}

fn turn(r: PgRow) -> Result<Turn, StoreError> {
    let n: i32 = r.try_get("n")?;
    let id_raw: String = r.try_get("turn_id")?;
    let said: String = r.try_get("said")?;
    Ok(Turn {
        n: u32::try_from(n).map_err(|_| StoreError::Corrupt("turn"))?,
        id: TurnKey::new(&id_raw).ok_or(StoreError::Corrupt("turn id"))?,
        said: Said::new(&said).ok_or(StoreError::Corrupt("said"))?,
        reply: r.try_get("reply")?,
        blocks: r.try_get("blocks")?,
        proposals: r.try_get("proposals")?,
        notice: r.try_get("notice")?,
        state: TurnState::parse(&r.try_get::<String, _>("state")?)?,
        created_at: r.try_get("created_at")?,
    })
}

/// A transaction for one conversation scope: row-level security limits it to that company (or to the
/// tenant's home rows), and every query filters by tenant, company and the person. Turns have no person
/// column, so whatever writes one must first lock its conversation by its holder (`find(.., true)`).
pub struct AssistantTx {
    tx: Transaction<'static, Postgres>,
    scope: ConversationScope,
}

impl Store {
    /// The scope `user`'s conversation `id` is bound to, read from its content-free record; `None`
    /// when there is no such conversation or it is someone else's.
    pub async fn conversation_scope(
        &self,
        tenant: &TenantId,
        user: &UserId,
        id: &ConversationId,
    ) -> Result<Option<ConversationScope>, StoreError> {
        let mut tx = self.scoped(tenant, &[]).await?;
        let row = sqlx::query(&format!(
            "select {CONVERSATION} from assistant_conversations
             where tenant_id = $1 and conversation_id = $2 and user_id = $3"
        ))
        .bind(tenant.as_str())
        .bind(id.as_str())
        .bind(user.as_str())
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        row.map(|r| conversation(tenant, r).map(|c| c.scope)).transpose()
    }

    /// `user`'s conversations, most recently active first: their home ones and those of `companies`
    /// (the companies they may still work on), at most `limit`.
    pub async fn conversations(
        &self,
        tenant: &TenantId,
        user: &UserId,
        companies: &[CompanyScope],
        limit: u32,
    ) -> Result<Vec<Conversation>, StoreError> {
        if companies.iter().any(|c| &c.tenant != tenant) {
            return Err(StoreError::MixedTenants);
        }
        let ids: Vec<&CompanyId> = companies.iter().map(|c| &c.company).collect();
        let raw: Vec<&str> = ids.iter().map(|c| c.as_str()).collect();
        let mut tx = self.scoped(tenant, &ids).await?;
        let rows = sqlx::query(&format!(
            "select {CONVERSATION} from assistant_conversations
             where tenant_id = $1 and user_id = $2 and (company_id is null or company_id = any($3))
             order by last_active_at desc, conversation_id limit $4"
        ))
        .bind(tenant.as_str())
        .bind(user.as_str())
        .bind(&raw)
        .bind(i64::from(limit))
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        rows.into_iter().map(|r| conversation(tenant, r)).collect()
    }

    /// A transaction for conversations bound to `scope`.
    pub async fn assistant(&self, scope: &ConversationScope) -> Result<AssistantTx, StoreError> {
        let tx = match scope.company() {
            Some(c) => self.scoped(&c.tenant, &[&c.company]).await?,
            None => self.scoped(scope.tenant(), &[]).await?,
        };
        Ok(AssistantTx {
            tx,
            scope: scope.clone(),
        })
    }
}

impl AssistantTx {
    pub async fn commit(self) -> Result<(), StoreError> {
        self.tx.commit().await.map_err(Into::into)
    }

    /// Tenant, company and project, owned so a query can borrow the transaction mutably.
    fn keys(&self) -> (String, Option<String>, Option<String>) {
        (
            self.scope.tenant().as_str().to_owned(),
            self.scope.company().map(|c| c.company.as_str().to_owned()),
            self.scope.project().map(|p| p.as_str().to_owned()),
        )
    }

    /// Makes conversation `id` for `user` in this scope. A project named by the scope must be one of
    /// its company's, or `StoreError::Missing("project")`; a company must exist, or `Missing("company")`.
    pub async fn create(&mut self, id: &ConversationId, user: &UserId) -> Result<Conversation, StoreError> {
        let (t, c, p) = self.keys();
        if let Some(c) = &c {
            let found: bool =
                sqlx::query_scalar("select exists (select 1 from companies where tenant_id = $1 and company_id = $2)")
                    .bind(&t)
                    .bind(c)
                    .fetch_one(&mut *self.tx)
                    .await?;
            if !found {
                return Err(StoreError::Missing("company"));
            }
        }
        if let (Some(c), Some(p)) = (&c, &p) {
            let found: bool = sqlx::query_scalar(
                "select exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)",
            )
            .bind(&t)
            .bind(c)
            .bind(p)
            .fetch_one(&mut *self.tx)
            .await?;
            if !found {
                return Err(StoreError::Missing("project"));
            }
        }
        let row = sqlx::query(&format!(
            "insert into assistant_conversations (tenant_id, conversation_id, user_id, company_id, project_id)
             values ($1, $2, $3, $4, $5) returning {CONVERSATION}"
        ))
        .bind(&t)
        .bind(id.as_str())
        .bind(user.as_str())
        .bind(&c)
        .bind(&p)
        .fetch_one(&mut *self.tx)
        .await?;
        conversation(self.scope.tenant(), row)
    }

    /// `user`'s conversation `id` in this scope, locked for this transaction when `lock`.
    async fn find(
        &mut self,
        id: &ConversationId,
        user: &UserId,
        lock: bool,
    ) -> Result<Option<Conversation>, StoreError> {
        let (t, c, p) = self.keys();
        let row = sqlx::query(&format!(
            "select {CONVERSATION} from assistant_conversations
             where tenant_id = $1 and conversation_id = $2 and user_id = $3
               and company_id is not distinct from $4 and project_id is not distinct from $5 {}",
            if lock { "for update" } else { "" }
        ))
        .bind(&t)
        .bind(id.as_str())
        .bind(user.as_str())
        .bind(&c)
        .bind(&p)
        .fetch_optional(&mut *self.tx)
        .await?;
        row.map(|r| conversation(self.scope.tenant(), r)).transpose()
    }

    /// The conversation and its turns in order; `None` unless `user` holds it in this scope.
    pub async fn get(
        &mut self,
        id: &ConversationId,
        user: &UserId,
    ) -> Result<Option<(Conversation, Vec<Turn>)>, StoreError> {
        let Some(found) = self.find(id, user, false).await? else {
            return Ok(None);
        };
        let turns = self.turns(id).await?;
        Ok(Some((found, turns)))
    }

    async fn turns(&mut self, id: &ConversationId) -> Result<Vec<Turn>, StoreError> {
        let (t, c, _) = self.keys();
        let rows = sqlx::query(&format!(
            "select {TURN} from assistant_turns
             where tenant_id = $1 and conversation_id = $2 and company_id is not distinct from $3 order by n"
        ))
        .bind(&t)
        .bind(id.as_str())
        .bind(&c)
        .fetch_all(&mut *self.tx)
        .await?;
        rows.into_iter().map(turn).collect()
    }

    // The append of a finished turn (#237's second part) goes here. It must: lock the conversation by its
    // holder first (`find(.., true)`); check `Said` and `reply_fits`, which the table does not; and count
    // the parts' bytes as the table does (`octet_length` of jsonb's text form, which writes ", " and ": "
    // with spaces), or keep a margin under the caps, so a part near them is refused cleanly, never a 500.

    /// Deletes `by`'s conversation `id` in this scope and its turns, and leaves an audit row naming it
    /// (no content); `false` if there is none.
    pub async fn delete(&mut self, id: &ConversationId, by: &Actor) -> Result<bool, StoreError> {
        let user = &by.user;
        let (t, c, p) = self.keys();
        let n = sqlx::query(
            "delete from assistant_conversations
             where tenant_id = $1 and conversation_id = $2 and user_id = $3
               and company_id is not distinct from $4 and project_id is not distinct from $5",
        )
        .bind(&t)
        .bind(id.as_str())
        .bind(user.as_str())
        .bind(&c)
        .bind(&p)
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if n != 1 {
            return Ok(false);
        }
        match self.scope.clone() {
            ConversationScope::Home(tenant) => {
                sqlx::query("insert into audit_log (tenant_id, actor, action, target) values ($1, $2, $3, $4)")
                    .bind(tenant.as_str())
                    .bind(by.user.as_str())
                    .bind("assistant_conversation.deleted")
                    .bind(id.as_str())
                    .execute(&mut *self.tx)
                    .await?;
            }
            ConversationScope::Company(c) => {
                audit(
                    &mut self.tx,
                    &c,
                    None,
                    by,
                    "assistant_conversation.deleted",
                    Some(id.as_str()),
                )
                .await?;
            }
            ConversationScope::Project(p) => {
                audit(
                    &mut self.tx,
                    &p.company,
                    Some(&p.project),
                    by,
                    "assistant_conversation.deleted",
                    Some(id.as_str()),
                )
                .await?;
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_rules_are_the_wires() {
        // Pasted text keeps its carriage returns; JavaScript's trim takes U+FEFF too.
        assert_eq!(
            Said::new("\u{feff} line one\r\nline two \n").unwrap().as_str(),
            "line one\r\nline two"
        );
        assert!(
            Said::new("a\u{85}b").is_some(),
            "a C1 control passes, as the wire's regex lets it"
        );
        assert_eq!(
            Said::new("\u{85}").map(|s| s.as_str().to_owned()),
            Some("\u{85}".into()),
            "NEL is not trimmed"
        );
        assert_eq!(
            Said::new("ok\u{85}").map(|s| s.as_str().to_owned()),
            Some("ok\u{85}".into())
        );
        for bad in ["a\u{0}b", "a\u{b}b", "a\u{1b}b", "a\u{7f}b"] {
            assert!(Said::new(bad).is_none(), "{bad:?}");
        }
        assert_eq!(
            Said::new(&"é".repeat(MAX_SAID_CHARS)).map(|s| s.as_str().chars().count()),
            Some(MAX_SAID_CHARS)
        );
        // A reply counts UTF-16 units: an emoji is two.
        assert!(reply_fits(&"x".repeat(MAX_REPLY_CHARS)));
        assert!(reply_fits(&"😀".repeat(MAX_REPLY_CHARS / 2)));
        assert!(!reply_fits(&"😀".repeat(MAX_REPLY_CHARS / 2 + 1)));
        assert!(reply_fits("line\r\nline\ttab") && !reply_fits("a\u{1b}b"));
    }

    #[test]
    fn turn_keys_and_said_follow_the_workers_rules() {
        assert!(TurnKey::new("t_01J-x_y").is_some());
        for bad in ["", "t_", "x_1", "t_a/b", "t_a b", &format!("t_{}", "a".repeat(65))] {
            assert!(TurnKey::new(bad).is_none(), "{bad:?}");
        }
        assert_eq!(
            Said::new("  plan the pilot\nplease ").unwrap().as_str(),
            "plan the pilot\nplease"
        );
        assert!(Said::new(&"x".repeat(MAX_SAID_CHARS)).is_some());
        for bad in ["", "   ", "a\u{7}b"] {
            assert!(Said::new(bad).is_none(), "{bad:?}");
        }
        assert!(Said::new(&"x".repeat(MAX_SAID_CHARS + 1)).is_none());
        assert_eq!(format!("{:?}", Said::new("secret plan").unwrap()), "Said(11 chars)");
    }
}
