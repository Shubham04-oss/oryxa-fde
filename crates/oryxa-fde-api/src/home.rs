//! The caller's home suggestions (#227, ADR 0008): a short ranked list of next steps, built on each
//! read from the facts Today already reads (the same SpiceDB `work` lookup, the same store query)
//! and a fixed set of kinds. No model is called and no record's own text is quoted: a suggestion is
//! a kind, counts, the ids and names of its company and project, and the route it opens. A dismissed
//! suggestion stays hidden for that person until its facts (the ids behind it) change.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use oryxa_fde_events::AccessStatus;
use oryxa_fde_store::{Named, TaskStatus, TodayItem};
use serde::Serialize;
use sha2::{Digest, Sha256};
use time::Date;
use utoipa::ToSchema;

use crate::authz::workspace;
use crate::session::NamedOut;
use crate::{ApiError, App, ErrorBody, Principal};

/// The most suggestions a home shows.
pub const MAX_SUGGESTIONS: usize = 5;

/// What a suggestion is about, in rank order: the first kinds come first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum HomeKind {
    /// Tasks due today or earlier and not done, across every project: `count`.
    DueToday,
    /// Access requests of one project still waiting on the customer: `count`, the longest wait in
    /// `days`.
    AccessWaiting,
    /// Blocked tasks of one project: `count`.
    BlockedTasks,
    /// A project with no next step: every task is done, or there are none.
    NoNextStep,
}

impl HomeKind {
    fn as_str(self) -> &'static str {
        match self {
            HomeKind::DueToday => "due_today",
            HomeKind::AccessWaiting => "access_waiting",
            HomeKind::BlockedTasks => "blocked_tasks",
            HomeKind::NoNextStep => "no_next_step",
        }
    }
}

/// One suggested next step, built from ids and a fixed template.
#[derive(Debug, Serialize, ToSchema)]
pub struct HomeSuggestionOut {
    /// Stable while its kind and project are: `<kind>` or `<kind>.<project id>`. Send it to dismiss.
    pub id: String,
    pub kind: HomeKind,
    pub count: u32,
    /// The longest wait in whole days, for `access_waiting`.
    pub days: Option<u32>,
    /// The company and project it is about; none for `due_today`, which spans them.
    pub company: Option<NamedOut>,
    pub project: Option<NamedOut>,
    /// The web app's path it opens, e.g. `/companies/{company}/projects/{project}` or `/today`.
    pub route: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct HomeOut {
    /// At most five, most pressing first.
    pub suggestions: Vec<HomeSuggestionOut>,
}

/// A suggestion, with the hash of the ids behind it, for dismissal.
#[derive(Debug)]
struct Suggestion {
    out: HomeSuggestionOut,
    facts: String,
    /// Within a kind, the more pressing first.
    weight: (u32, u32),
}

/// The facts of one project, as Today reads them.
#[derive(Default)]
struct ProjectFacts {
    names: Option<(Named<oryxa_fde_core::CompanyId>, Named<oryxa_fde_core::ProjectId>)>,
    blocked: Vec<String>,
    waiting: Vec<(String, u32)>,
    no_next_step: bool,
}

fn named<T: std::fmt::Display>(n: &Named<T>) -> NamedOut {
    NamedOut {
        id: n.id.to_string(),
        name: n.name.as_str().to_owned(),
    }
}

/// The hash of a suggestion's facts: its kind and the sorted ids behind it.
fn facts(kind: HomeKind, mut ids: Vec<String>) -> String {
    ids.sort();
    let mut h = Sha256::new();
    h.update(kind.as_str().as_bytes());
    for id in ids {
        h.update(b"\n");
        h.update(id.as_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Every suggestion the facts call for, ranked: by kind, then the more pressing first, then by
/// company and project name for a stable order. `today` is the caller's day (UTC).
fn build(items: Vec<TodayItem>, today: Date) -> Vec<Suggestion> {
    let mut projects: BTreeMap<(String, String), ProjectFacts> = BTreeMap::new();
    let mut due = Vec::new();
    for item in items {
        match item {
            TodayItem::Task { task, company, project } => {
                if task.due_on.is_some_and(|d| d <= today) {
                    due.push(task.id.to_string());
                }
                let f = projects
                    .entry((company.id.to_string(), project.id.to_string()))
                    .or_default();
                if task.status == TaskStatus::Blocked {
                    f.blocked.push(task.id.to_string());
                }
                f.names.get_or_insert((company, project));
            }
            TodayItem::AccessRequest {
                access,
                company,
                project,
                ..
            } => {
                let f = projects
                    .entry((company.id.to_string(), project.id.to_string()))
                    .or_default();
                // Granted is not in Today; denied and revoked wait on nobody.
                if matches!(access.status, AccessStatus::Requested | AccessStatus::InProgress) {
                    let days = u32::try_from(access.days_waiting.max(0)).unwrap_or(u32::MAX);
                    f.waiting.push((access.id.to_string(), days));
                }
                f.names.get_or_insert((company, project));
            }
            TodayItem::NoNextStep { company, project } => {
                let f = projects
                    .entry((company.id.to_string(), project.id.to_string()))
                    .or_default();
                f.no_next_step = true;
                f.names.get_or_insert((company, project));
            }
        }
    }

    let mut all = Vec::new();
    if !due.is_empty() {
        all.push(Suggestion {
            out: HomeSuggestionOut {
                id: HomeKind::DueToday.as_str().to_owned(),
                kind: HomeKind::DueToday,
                count: count(due.len()),
                days: None,
                company: None,
                project: None,
                route: "/today".into(),
            },
            weight: (count(due.len()), 0),
            facts: facts(HomeKind::DueToday, due),
        });
    }
    for f in projects.into_values() {
        let Some((company, project)) = f.names else { continue };
        let one = |kind: HomeKind, n: u32, days: Option<u32>, ids: Vec<String>, weight: (u32, u32)| Suggestion {
            out: HomeSuggestionOut {
                id: format!("{}.{}", kind.as_str(), project.id),
                kind,
                count: n,
                days,
                company: Some(named(&company)),
                project: Some(named(&project)),
                route: format!("/companies/{}/projects/{}", company.id, project.id),
            },
            facts: facts(kind, ids),
            weight,
        };
        if !f.waiting.is_empty() {
            let longest = f.waiting.iter().map(|(_, d)| *d).max().unwrap_or(0);
            let n = count(f.waiting.len());
            let ids = f.waiting.into_iter().map(|(id, _)| id).collect();
            all.push(one(HomeKind::AccessWaiting, n, Some(longest), ids, (longest, n)));
        }
        if !f.blocked.is_empty() {
            let n = count(f.blocked.len());
            all.push(one(HomeKind::BlockedTasks, n, None, f.blocked, (n, 0)));
        }
        if f.no_next_step {
            all.push(one(HomeKind::NoNextStep, 0, None, vec![project.id.to_string()], (0, 0)));
        }
    }
    all.sort_by(|a, b| {
        let name = |s: &Suggestion| {
            (
                s.out.company.as_ref().map(|c| c.name.clone()),
                s.out.project.as_ref().map(|p| (p.name.clone(), p.id.clone())),
            )
        };
        a.out
            .kind
            .cmp(&b.out.kind)
            .then(b.weight.cmp(&a.weight))
            .then_with(|| name(a).cmp(&name(b)))
    });
    all
}

/// The caller's suggestions now, every one, before dismissals: the projects they `work` on only.
async fn current(app: &App, who: &Principal) -> Result<Vec<Suggestion>, ApiError> {
    // Never to a customer role (ADR 0005, 0008): they have no `access` to the workspace.
    app.require(who, workspace(&who.tenant), "access").await?;
    let projects = app.projects_for(who).await?;
    let scopes = app.store.project_scopes(&who.tenant, &projects).await?;
    let items = app.store.today(&scopes).await?;
    Ok(build(items, time::OffsetDateTime::now_utc().date()))
}

/// What needs the caller next, across the projects they work on, as a few suggestions built from
/// fixed templates: no free text from any record.
#[utoipa::path(get, operation_id = "get_home", path = "/v1/home", tag = "projects",
    responses((status = 200, body = HomeOut), (status = 401, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn home(State(app): State<Arc<App>>, who: Principal) -> Result<Json<HomeOut>, ApiError> {
    let all = current(&app, &who).await?;
    let mut tx = app.store.organisation(&who.tenant).await?;
    let dismissed: HashMap<String, String> = tx
        .home_dismissals(&who.user)
        .await?
        .into_iter()
        .map(|d| (d.suggestion, d.facts))
        .collect();
    tx.commit().await?;
    Ok(Json(HomeOut {
        suggestions: visible(all, &dismissed),
    }))
}

/// The suggestions not dismissed with the facts they have now, at most [`MAX_SUGGESTIONS`].
fn visible(all: Vec<Suggestion>, dismissed: &HashMap<String, String>) -> Vec<HomeSuggestionOut> {
    all.into_iter()
        .filter(|s| dismissed.get(&s.out.id) != Some(&s.facts))
        .take(MAX_SUGGESTIONS)
        .map(|s| s.out)
        .collect()
}

/// Hide a suggestion from the caller's home until its facts change: a new blocked task, another
/// access request, a project gaining or losing its next step. Only a suggestion the caller has now.
#[utoipa::path(post, operation_id = "dismiss_home_suggestion", path = "/v1/home/suggestions/{suggestion}/dismiss",
    tag = "projects", params(("suggestion" = String, Path, description = "A suggestion's `id`")),
    responses((status = 204, description = "Dismissed"), (status = 401, body = ErrorBody),
        (status = 403, body = ErrorBody), (status = 404, body = ErrorBody, description = "Not one the caller has now")))]
pub(crate) async fn dismiss(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(suggestion): Path<String>,
) -> Result<StatusCode, ApiError> {
    let found = current(&app, &who)
        .await?
        .into_iter()
        .find(|s| s.out.id == suggestion)
        .ok_or(ApiError::NotFound)?;
    let mut tx = app.store.organisation(&who.tenant).await?;
    tx.dismiss_home(&who.user, &found.out.id, &found.facts).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use oryxa_fde_core::{AccessRequestId, CompanyId, ProjectId, TaskId};
    use oryxa_fde_store::{AccessRequest, Name, Task, Text};
    use time::{Month, OffsetDateTime};

    use super::*;

    const AT: OffsetDateTime = OffsetDateTime::UNIX_EPOCH;

    fn day(d: u8) -> Date {
        Date::from_calendar_date(2026, Month::November, d).unwrap()
    }

    fn place(c: &str, p: &str) -> (Named<CompanyId>, Named<ProjectId>) {
        (
            Named {
                id: CompanyId::new(format!("cmp_{c}")).unwrap(),
                name: Name::new(c).unwrap(),
            },
            Named {
                id: ProjectId::new(format!("prj_{p}")).unwrap(),
                name: Name::new(p).unwrap(),
            },
        )
    }

    fn task(c: &str, p: &str, id: &str, status: TaskStatus, due: Option<Date>) -> TodayItem {
        let (company, project) = place(c, p);
        TodayItem::Task {
            task: Task {
                id: TaskId::new(id).unwrap(),
                title: Name::new("Secret customer plan").unwrap(),
                status,
                blocker: (status == TaskStatus::Blocked).then(|| Text::new("their IT").unwrap()),
                due_on: due,
                assignee: None,
                waiting_on: None,
                waiting_since: None,
                blocked_by: None,
                criterion: None,
                stage: None,
                position: 0,
                created_at: AT,
                updated_at: AT,
                version: 1,
            },
            company,
            project,
        }
    }

    fn access(c: &str, p: &str, id: &str, status: AccessStatus, days: i64) -> TodayItem {
        let (company, project) = place(c, p);
        TodayItem::AccessRequest {
            access: AccessRequest {
                id: AccessRequestId::new(id).unwrap(),
                description: Text::new("Prod database password").unwrap(),
                system: None,
                owner: None,
                status,
                requested_at: AT,
                status_changed_at: AT,
                granted_at: None,
                days_waiting: days,
                version: 1,
            },
            owner: Some(Name::new("Sam Sponsor").unwrap()),
            company,
            project,
        }
    }

    fn idle(c: &str, p: &str) -> TodayItem {
        let (company, project) = place(c, p);
        TodayItem::NoNextStep { company, project }
    }

    fn ids(list: &[Suggestion]) -> Vec<&str> {
        list.iter().map(|s| s.out.id.as_str()).collect()
    }

    fn world() -> Vec<TodayItem> {
        vec![
            task("Acme", "Triage", "tsk_1", TaskStatus::Blocked, None),
            task("Acme", "Triage", "tsk_2", TaskStatus::Todo, Some(day(13))),
            task("Acme", "Triage", "tsk_3", TaskStatus::Todo, Some(day(10))),
            task("Acme", "Triage", "tsk_4", TaskStatus::Todo, Some(day(20))),
            task("Globex", "Search", "tsk_5", TaskStatus::Blocked, None),
            task("Globex", "Search", "tsk_6", TaskStatus::Blocked, None),
            access("Acme", "Triage", "acc_1", AccessStatus::Requested, 3),
            access("Globex", "Search", "acc_2", AccessStatus::InProgress, 9),
            access("Globex", "Search", "acc_3", AccessStatus::Denied, 30),
            idle("Initech", "Pilot"),
        ]
    }

    #[test]
    fn each_kind_is_built_from_ids_and_counts_and_ranked() {
        let all = build(world(), day(13));
        assert_eq!(
            ids(&all),
            [
                "due_today",
                "access_waiting.prj_Search",
                "access_waiting.prj_Triage",
                "blocked_tasks.prj_Search",
                "blocked_tasks.prj_Triage",
                "no_next_step.prj_Pilot",
            ],
            "by kind, then the longest wait and the most blocked first"
        );
        let due = &all[0].out;
        assert_eq!(
            (due.count, due.route.as_str(), due.company.is_none()),
            (2, "/today", true),
            "today and overdue"
        );
        let longest = &all[1].out;
        assert_eq!(
            (longest.count, longest.days),
            (1, Some(9)),
            "a denied request waits on nobody"
        );
        assert_eq!(longest.route, "/companies/cmp_Globex/projects/prj_Search");
        assert_eq!(longest.company.as_ref().map(|c| c.name.as_str()), Some("Globex"));
        assert_eq!((all[3].out.count, all[4].out.count), (2, 1));
        assert_eq!(all[5].out.project.as_ref().map(|p| p.name.as_str()), Some("Pilot"));

        // No record's own text reaches a suggestion: only kinds, counts, ids and names.
        let text = format!("{:?}", all.iter().map(|s| &s.out).collect::<Vec<_>>());
        for secret in [
            "Secret customer plan",
            "their IT",
            "Prod database password",
            "Sam Sponsor",
        ] {
            assert!(!text.contains(secret), "{secret}: {text}");
        }
        assert!(build(vec![], day(13)).is_empty());
    }

    #[test]
    fn at_most_five_are_shown_and_a_dismissal_lasts_until_its_facts_change() {
        let all = build(world(), day(13));
        assert_eq!(visible(build(world(), day(13)), &HashMap::new()).len(), MAX_SUGGESTIONS);

        // Dismissed with today's facts: hidden, and the next one moves up.
        let dismissed: HashMap<String, String> = all
            .iter()
            .filter(|s| s.out.id == "access_waiting.prj_Search")
            .map(|s| (s.out.id.clone(), s.facts.clone()))
            .collect();
        let shown = visible(build(world(), day(13)), &dismissed);
        assert!(!shown.iter().any(|s| s.id == "access_waiting.prj_Search"));
        assert_eq!(shown.last().map(|s| s.id.as_str()), Some("no_next_step.prj_Pilot"));

        // A wait growing longer is the same facts: still hidden.
        let mut later = world();
        later[7] = access("Globex", "Search", "acc_2", AccessStatus::InProgress, 12);
        assert!(
            !visible(build(later, day(14)), &dismissed)
                .iter()
                .any(|s| s.id == "access_waiting.prj_Search")
        );

        // Another request on that project changes the facts: it shows again.
        let mut more = world();
        more.push(access("Globex", "Search", "acc_4", AccessStatus::Requested, 0));
        assert!(
            visible(build(more, day(13)), &dismissed)
                .iter()
                .any(|s| s.id == "access_waiting.prj_Search")
        );
    }
}
