//! What an agent may see from the knowledge base (#29): one helper every KB read goes through.
//!
//! `visible(item) = agent_view(agent) ∧ view(acting_for) ∧ ∀ reader ∈ audience: view(reader)`
//!
//! - The agent sees only sources it was given (`kb_source#agent_reader`).
//! - It never sees more than the human it acts for. With no human (a scheduled workspace agent)
//!   and no known reader, only items the whole workspace may see.
//! - Every reader of the answer must be able to see the item too: this stops the commonest leak,
//!   an agent quoting a private document into a channel where some members cannot see it.
//!
//! Fail closed: an audience over [`MAX_AUDIENCE`] only gets items shared with the whole workspace;
//! a reader we cannot match to an Oryxa user (a Slack Connect external, a guest) can see nothing,
//! so nothing is shown into that conversation; any check error or outage denies.

use oryxa_core::{AgentId, ConnectionId, KbItemId, TenantId, UserId, WorkspaceId};

use crate::ids::{ObjectRef, SubjectRef};
use crate::spicedb::{AuthzError, CheckItem, Consistency, Decision, SpiceDb};

/// Largest audience checked member by member; larger ones fall back to workspace-wide items.
pub const MAX_AUDIENCE: usize = 500;
/// Largest surviving items × readers checked one by one (one bulk call); above it, workspace-wide.
pub const MAX_READER_CHECKS: usize = 10_000;

/// Who will read the answer.
#[derive(Debug, Clone, Default)]
pub struct Audience {
    /// Readers matched to Oryxa users.
    pub users: Vec<UserId>,
    /// Readers we could not match to an Oryxa user. Any at all hides every item.
    pub unmatched: usize,
}

impl Audience {
    /// Just one person (a DM with the owner, or the requester themself).
    pub fn one(user: &UserId) -> Self {
        Self {
            users: vec![user.clone()],
            unmatched: 0,
        }
    }
}

/// Who is reading: the agent, the human it acts for (if any), and who will see the answer.
#[derive(Debug, Clone)]
pub struct KbReader<'a> {
    pub agent: &'a AgentId,
    pub acting_for: Option<&'a UserId>,
    pub audience: &'a Audience,
}

/// For each of `items` (in order), whether `reader` may show it. `workspace` is the tenant's
/// workspace object.
///
/// Consistency: production callers pass `Consistency::MinimizeLatency`, or
/// `AtLeastAsFresh(token)` right after their own ACL write; `FullyConsistent` is for tests only.
///
/// ponytail: MinimizeLatency can be a few seconds stale (as in the gateway); ACL sync writes
/// removals as deletes immediately, so the window is SpiceDB's cache, not a resync interval.
pub async fn kb_visible(
    spicedb: &SpiceDb,
    tenant: &TenantId,
    workspace: &WorkspaceId,
    reader: &KbReader<'_>,
    items: &[KbItemId],
    consistency: &Consistency,
) -> Result<Vec<bool>, AuthzError> {
    // A reader who can see nothing makes every item unshowable here.
    if items.is_empty() || reader.audience.unmatched > 0 {
        return Ok(vec![false; items.len()]);
    }
    let object = |kind, id: &str| ObjectRef::new(tenant, kind, id);
    let user = |u: &UserId| ("view", SubjectRef::object(object("user", u.as_str())));
    let workspace_members = || {
        (
            "view",
            SubjectRef::set(object("workspace", workspace.as_str()), "member"),
        )
    };

    // Pass 1, items × (agent + human): cheap, and usually drops most items.
    let mut first = vec![("agent_view", SubjectRef::object(object("agent", reader.agent.as_str())))];
    first.extend(reader.acting_for.map(user));
    let mut shown = check_all(spicedb, tenant, items.iter().collect(), &first, consistency).await?;
    let survivors: Vec<&KbItemId> = items.iter().zip(&shown).filter(|(_, s)| **s).map(|(i, _)| i).collect();
    if survivors.is_empty() {
        return Ok(shown);
    }

    // Pass 2, survivors × readers (deduplicated, minus the human already checked).
    let mut readers: Vec<&UserId> = reader
        .audience
        .users
        .iter()
        .filter(|u| reader.acting_for != Some(*u))
        .collect();
    readers.sort_unstable_by(|a, b| a.as_str().cmp(b.as_str()));
    readers.dedup();
    let second = if readers.is_empty() && reader.acting_for.is_none() {
        // No human and no known reader (a scheduled job): at most what the workspace may see.
        vec![workspace_members()]
    } else if readers.len() > MAX_AUDIENCE || survivors.len() * readers.len() > MAX_READER_CHECKS {
        // Too many to check one by one: only what the whole workspace may see.
        vec![workspace_members()]
    } else {
        readers.into_iter().map(user).collect()
    };
    if second.is_empty() {
        return Ok(shown);
    }
    let mut passed = check_all(spicedb, tenant, survivors, &second, consistency)
        .await?
        .into_iter();
    for s in shown.iter_mut().filter(|s| **s) {
        *s = passed.next().unwrap_or(false);
    }
    Ok(shown)
}

/// One bulk check of every item × subject; an item passes only if all its checks allowed.
async fn check_all(
    spicedb: &SpiceDb,
    tenant: &TenantId,
    items: Vec<&KbItemId>,
    subjects: &[(&'static str, SubjectRef)],
    consistency: &Consistency,
) -> Result<Vec<bool>, AuthzError> {
    let checks: Vec<CheckItem> = items
        .iter()
        .flat_map(|item| {
            subjects.iter().map(move |(permission, subject)| CheckItem {
                resource: ObjectRef::new(tenant, "kb_item", item.as_str()),
                permission,
                subject: subject.clone(),
                context: None,
            })
        })
        .collect();
    Ok(all_allowed(
        &spicedb.check_bulk(tenant, &checks, consistency).await?,
        subjects.len(),
    ))
}

/// Groups decisions per item; errors and conditionals deny.
fn all_allowed(decisions: &[Decision], per_item: usize) -> Vec<bool> {
    decisions
        .chunks(per_item)
        .map(|d| d.iter().all(Decision::allowed))
        .collect()
}

/// Whether `agent` (acting for `acting_for`) may act through a connection: `connection#use` for
/// the agent, and for a personal connection, acting for its owner. The broker asks this before it
/// issues an egress handle.
pub async fn may_use_connection(
    spicedb: &SpiceDb,
    tenant: &TenantId,
    connection: &ConnectionId,
    agent: &AgentId,
    acting_for: &UserId,
    personal_owner: Option<&UserId>,
    consistency: &Consistency,
) -> Result<bool, AuthzError> {
    if personal_owner.is_some_and(|o| o != acting_for) {
        return Ok(false);
    }
    let check = CheckItem {
        resource: ObjectRef::new(tenant, "connection", connection.as_str()),
        permission: "use",
        subject: SubjectRef::object(ObjectRef::new(tenant, "agent", agent.as_str())),
        context: None,
    };
    Ok(spicedb.check(tenant, &check, consistency).await?.allowed())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_and_conditionals_deny() {
        let cond = Decision::Conditional {
            missing: vec!["x".into()],
        };
        let err = Decision::Error("boom".into());
        let d = [
            Decision::Allow,
            Decision::Allow,
            Decision::Allow,
            cond,
            err,
            Decision::Allow,
            Decision::Allow,
            Decision::Deny,
        ];
        assert_eq!(all_allowed(&d, 2), [true, false, false, false]);
    }
}
