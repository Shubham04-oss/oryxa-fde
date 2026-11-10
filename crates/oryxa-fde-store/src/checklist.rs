//! The checklist to leave a project's stage, worked out from the project's records each time it
//! is read: nothing about it is stored except the reason given to move on with a check open.

use std::fmt;

use oryxa_fde_core::{Check, Stage};

use crate::{ProjectTx, StoreError};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("a reason must be 1..={MAX_REASON_CHARS} characters with no control characters but newlines and tabs")]
pub struct ReasonError;

pub const MAX_REASON_CHARS: usize = 500;

/// Why an FDE moved a project on with checks open. Free text, like [`crate::Text`]: it goes in the
/// audit log and never in SpiceDB, events or logs.
#[derive(Clone, PartialEq, Eq)]
pub struct Reason(String);

impl Reason {
    pub fn new(value: impl AsRef<str>) -> Result<Self, ReasonError> {
        let v = value.as_ref().trim();
        let chars = v.chars().count();
        let ok =
            (1..=MAX_REASON_CHARS).contains(&chars) && !v.chars().any(|c| c.is_control() && c != '\n' && c != '\t');
        if ok { Ok(Self(v.to_owned())) } else { Err(ReasonError) }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Reason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Reason(<{} chars>)", self.0.chars().count())
    }
}

/// One check of a stage's checklist and whether the project meets it now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChecklistItem {
    pub check: Check,
    pub met: bool,
}

impl ProjectTx {
    /// The project's stage and the checklist to leave it. `None` if the project is not in this
    /// company.
    pub async fn stage_checklist(&mut self) -> Result<Option<(Stage, Vec<ChecklistItem>)>, StoreError> {
        let Some(project) = self.get().await? else {
            return Ok(None);
        };
        let items = self.checklist(project.stage).await?;
        Ok(Some((project.stage, items)))
    }

    pub(crate) async fn checklist(&mut self, stage: Stage) -> Result<Vec<ChecklistItem>, StoreError> {
        let mut items = Vec::new();
        for check in stage.checklist() {
            let met = self.met(check).await?;
            items.push(ChecklistItem { check, met });
        }
        Ok(items)
    }

    async fn met(&mut self, check: Check) -> Result<bool, StoreError> {
        let sql = match check {
            // The same rule that raises the "ready to deploy" suggestion.
            Check::CriteriaMet => return self.criteria_met().await,
            // Stakeholders belong to the company, so $3 only pins the project to it.
            Check::StakeholdersNamed => {
                "select exists (select 1 from stakeholders s where s.tenant_id = $1 and s.company_id = $2)
                    and exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)"
            }
            Check::DiscoveryNotes => {
                "select exists (select 1 from meeting_notes
                    where tenant_id = $1 and company_id = $2 and project_id = $3)"
            }
            // A sign-off covers the scope only while nothing changed after it.
            Check::ScopeSignedOff => {
                "select exists (select 1 from projects p join scope_signoffs o
                    on o.tenant_id = p.tenant_id and o.company_id = p.company_id and o.project_id = p.project_id
                    and o.version = p.scope_version
                    where p.tenant_id = $1 and p.company_id = $2 and p.project_id = $3)"
            }
            Check::OutOfScopeListed => {
                "select exists (select 1 from scope_items
                    where tenant_id = $1 and company_id = $2 and project_id = $3 and kind = 'out')"
            }
            // Every criterion row has a target (the column is required), so this needs one to exist.
            Check::CriteriaHaveTargets => {
                "select exists (select 1 from criteria where tenant_id = $1 and company_id = $2 and project_id = $3)"
            }
            // Vacuously met with no requests: a project may need no access.
            Check::AccessGranted => {
                "select not exists (select 1 from access_requests
                    where tenant_id = $1 and company_id = $2 and project_id = $3 and status <> 'granted')"
            }
            Check::CriteriaHaveEvals => {
                "select exists (select 1 from criteria where tenant_id = $1 and company_id = $2 and project_id = $3)
                    and not exists (select 1 from criteria c
                        where c.tenant_id = $1 and c.company_id = $2 and c.project_id = $3
                        and not exists (select 1 from eval_suite_criteria e
                            where e.tenant_id = c.tenant_id and e.company_id = c.company_id
                            and e.project_id = c.project_id and e.criterion_id = c.criterion_id))"
            }
        };
        let (t, c, p) = self.keys();
        let met: bool = sqlx::query_scalar(sql)
            .bind(&t)
            .bind(&c)
            .bind(&p)
            .fetch_one(&mut *self.tx)
            .await?;
        Ok(met)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reason_is_short_trimmed_text() {
        assert_eq!(Reason::new("  customer away  ").unwrap().as_str(), "customer away");
        assert_eq!(
            Reason::new("line one\nline two\tend").unwrap().as_str(),
            "line one\nline two\tend"
        );
        assert_eq!(
            Reason::new("x".repeat(MAX_REASON_CHARS)).unwrap().as_str().len(),
            MAX_REASON_CHARS
        );
        for bad in ["", "   ", "bell\u{7}"] {
            assert_eq!(Reason::new(bad), Err(ReasonError), "{bad:?}");
        }
        assert_eq!(Reason::new("x".repeat(MAX_REASON_CHARS + 1)), Err(ReasonError));
        assert_eq!(
            format!("{:?}", Reason::new("secret plan").unwrap()),
            "Reason(<11 chars>)"
        );
    }
}
