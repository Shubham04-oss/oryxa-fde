//! Meeting notes, at a company or one of its projects, with the people involved: the customer's
//! stakeholders (records of this company) and the workspace's users (the API checks that each
//! works on the place).

use std::fmt;

use oryxa_core::UserId;
use oryxa_fde_core::StakeholderId;
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::{Date, OffsetDateTime};

use crate::ids::MeetingNoteId;
use crate::plan::{AT, PlanTx};
use crate::{Actor, Name, StoreError, id, name, unique_violation};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("notes must be 1..={MAX_NOTE_CHARS} characters with no control characters but newlines and tabs")]
pub struct NoteTextError;

pub const MAX_NOTE_CHARS: usize = 20_000;

/// The notes themselves: longer than [`crate::Text`]. Customer text, so `Debug` shows only its
/// length.
#[derive(Clone, PartialEq, Eq)]
pub struct NoteText(String);

impl NoteText {
    pub fn new(value: impl AsRef<str>) -> Result<Self, NoteTextError> {
        let v = value.as_ref().trim();
        let chars = v.chars().count();
        let ok = (1..=MAX_NOTE_CHARS).contains(&chars) && !v.chars().any(|c| c.is_control() && c != '\n' && c != '\t');
        if ok { Ok(Self(v.to_owned())) } else { Err(NoteTextError) }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for NoteText {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "NoteText(<{} chars>)", self.0.chars().count())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeetingNote {
    pub id: MeetingNoteId,
    pub title: Name,
    pub held_on: Date,
    pub body: NoteText,
    pub stakeholders: Vec<StakeholderId>,
    pub attendees: Vec<UserId>,
    pub created_by: UserId,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone)]
pub struct MeetingNoteIn {
    pub title: Name,
    pub held_on: Date,
    pub body: NoteText,
    pub stakeholders: Vec<StakeholderId>,
    pub attendees: Vec<UserId>,
}

const NOTE: &str = "n.note_id, n.title, n.held_on, n.body, n.attendees, n.created_by, n.created_at, n.updated_at,
    array(select s.stakeholder_id from meeting_note_stakeholders s
          where s.tenant_id = n.tenant_id and s.note_id = n.note_id order by s.stakeholder_id) as stakeholders";

impl PlanTx {
    /// The place's notes, latest meeting first.
    pub async fn meeting_notes(&mut self) -> Result<Vec<MeetingNote>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {NOTE} from meeting_notes n where n.{AT} order by n.held_on desc, n.created_at desc, n.note_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(self.conn())
        .await?
        .into_iter()
        .map(note)
        .collect()
    }

    pub async fn meeting_note(&mut self, id: &MeetingNoteId) -> Result<Option<MeetingNote>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {NOTE} from meeting_notes n where n.{AT} and n.note_id = $4"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .fetch_optional(self.conn())
        .await?
        .map(note)
        .transpose()
    }

    /// `None` if the company or project does not exist; `Missing("stakeholders")` if one is not
    /// in this company.
    pub async fn add_meeting_note(
        &mut self,
        id: &MeetingNoteId,
        v: &MeetingNoteIn,
        by: &Actor,
    ) -> Result<Option<MeetingNote>, StoreError> {
        if !self.exists().await? {
            return Ok(None);
        }
        let (t, c, p) = self.keys();
        sqlx::query(
            "insert into meeting_notes (tenant_id, company_id, project_id, note_id, title, held_on, body, attendees,
                 created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(v.title.as_str())
        .bind(v.held_on)
        .bind(v.body.as_str())
        .bind(users(&v.attendees))
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
        self.set_note_stakeholders(id, &v.stakeholders).await?;
        self.audit(by, "meeting_note.added", id.as_str()).await?;
        self.meeting_note(id).await
    }

    /// Replaces the note's fields and people; `None` if it is not at this place.
    pub async fn update_meeting_note(
        &mut self,
        id: &MeetingNoteId,
        v: &MeetingNoteIn,
        by: &Actor,
    ) -> Result<Option<MeetingNote>, StoreError> {
        let (t, c, p) = self.keys();
        let n = sqlx::query(&format!(
            "update meeting_notes set title = $5, held_on = $6, body = $7, attendees = $8, updated_at = now()
             where {AT} and note_id = $4"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(id.as_str())
        .bind(v.title.as_str())
        .bind(v.held_on)
        .bind(v.body.as_str())
        .bind(users(&v.attendees))
        .execute(self.conn())
        .await?
        .rows_affected();
        if n == 0 {
            return Ok(None);
        }
        self.set_note_stakeholders(id, &v.stakeholders).await?;
        self.audit(by, "meeting_note.updated", id.as_str()).await?;
        self.meeting_note(id).await
    }

    pub async fn remove_meeting_note(&mut self, id: &MeetingNoteId, by: &Actor) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        // Its stakeholder rows go with it (on delete cascade).
        let n = sqlx::query(&format!("delete from meeting_notes where {AT} and note_id = $4"))
            .bind(&t)
            .bind(&c)
            .bind(&p)
            .bind(id.as_str())
            .execute(self.conn())
            .await?
            .rows_affected();
        if n == 0 {
            return Ok(false);
        }
        self.audit(by, "meeting_note.removed", id.as_str()).await?;
        Ok(true)
    }

    /// Replaces the note's stakeholders; each must be in this company.
    async fn set_note_stakeholders(&mut self, id: &MeetingNoteId, people: &[StakeholderId]) -> Result<(), StoreError> {
        let (t, c, _) = self.keys();
        let mut wanted: Vec<&str> = people.iter().map(StakeholderId::as_str).collect();
        wanted.sort_unstable();
        wanted.dedup();
        sqlx::query("delete from meeting_note_stakeholders where tenant_id = $1 and company_id = $2 and note_id = $3")
            .bind(&t)
            .bind(&c)
            .bind(id.as_str())
            .execute(self.conn())
            .await?;
        let added = sqlx::query(
            "insert into meeting_note_stakeholders (tenant_id, company_id, note_id, stakeholder_id)
             select $1, $2, $3, s.stakeholder_id from stakeholders s
             where s.tenant_id = $1 and s.company_id = $2 and s.stakeholder_id = any($4)",
        )
        .bind(&t)
        .bind(&c)
        .bind(id.as_str())
        .bind(&wanted)
        .execute(self.conn())
        .await?
        .rows_affected();
        if added as usize == wanted.len() {
            Ok(())
        } else {
            Err(StoreError::Missing("stakeholders"))
        }
    }
}

/// Distinct user ids, sorted, as stored.
fn users(list: &[UserId]) -> Vec<&str> {
    let mut out: Vec<&str> = list.iter().map(UserId::as_str).collect();
    out.sort_unstable();
    out.dedup();
    out
}

fn note(r: PgRow) -> Result<MeetingNote, StoreError> {
    let stakeholders: Vec<String> = r.try_get("stakeholders")?;
    let attendees: Vec<String> = r.try_get("attendees")?;
    Ok(MeetingNote {
        id: id("meeting note id", MeetingNoteId::new, r.try_get("note_id")?)?,
        title: name(r.try_get("title")?, "title")?,
        held_on: r.try_get("held_on")?,
        body: NoteText::new(r.try_get::<String, _>("body")?).map_err(|_| StoreError::Corrupt("notes"))?,
        stakeholders: stakeholders
            .into_iter()
            .map(|s| id("stakeholder id", StakeholderId::new, s))
            .collect::<Result<_, _>>()?,
        attendees: attendees
            .into_iter()
            .map(|u| id("attendee", UserId::new, u))
            .collect::<Result<_, _>>()?,
        created_by: id("created_by", UserId::new, r.try_get("created_by")?)?,
        created_at: r.try_get("created_at")?,
        updated_at: r.try_get("updated_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_allow_long_text_with_lines_and_stay_out_of_debug() {
        let long = "word ".repeat(3000);
        assert!(NoteText::new(&long).is_ok());
        assert_eq!(NoteText::new(" a\n\tb ").unwrap().as_str(), "a\n\tb");
        for bad in ["", "  ", "bell\u{7}"] {
            assert_eq!(NoteText::new(bad), Err(NoteTextError), "{bad:?}");
        }
        assert!(NoteText::new("x".repeat(MAX_NOTE_CHARS + 1)).is_err());
        assert_eq!(format!("{:?}", NoteText::new("secret").unwrap()), "NoteText(<6 chars>)");
    }

    #[test]
    fn attendees_are_stored_once_each_in_order() {
        let list = ["u_b", "u_a", "u_b"].map(|u| UserId::new(u).unwrap());
        assert_eq!(users(&list), ["u_a", "u_b"]);
    }
}
