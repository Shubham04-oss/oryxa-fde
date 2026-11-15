//! The caller's home suggestions (#227, ADR 0008): a short ranked list of next steps, built on each
//! read from a small store read of what can make one (`Store::home_facts`: blocked or due tasks,
//! waiting requests, projects with no task left, ids and names only), for the projects the caller
//! `work`s on, and a fixed set of kinds. No model is called and no record's own text is quoted: a
//! suggestion is a kind, counts, the ids and names of its company and project, and the route it opens.
//! A dismissed suggestion stays hidden for that person until its facts (the ids behind it) change, or
//! it goes away: then the dismissal is forgotten, and it shows again if it comes back.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use oryxa_fde_core::{CompanyId, ProjectId};
use oryxa_fde_store::{Dismissal, HomeFact, Named, SuggestionKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
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
    /// Tasks due today or earlier and not done, across every project.
    DueToday,
    /// Access requests of one project still waiting on the customer, the longest wait in `days`.
    AccessWaiting,
    /// Blocked tasks of one project.
    BlockedTasks,
    /// A project with no next step: every task is done, or there are none.
    NoNextStep,
}

impl HomeKind {
    const ALL: [HomeKind; 4] = [
        HomeKind::DueToday,
        HomeKind::AccessWaiting,
        HomeKind::BlockedTasks,
        HomeKind::NoNextStep,
    ];

    fn as_str(self) -> &'static str {
        match self {
            HomeKind::DueToday => "due_today",
            HomeKind::AccessWaiting => "access_waiting",
            HomeKind::BlockedTasks => "blocked_tasks",
            HomeKind::NoNextStep => "no_next_step",
        }
    }

    /// Whether a suggestion of this kind names a project (all but `due_today`, which spans them).
    fn per_project(self) -> bool {
        self != HomeKind::DueToday
    }
}

/// One suggested next step, built from ids and a fixed template.
#[derive(Debug, Serialize, ToSchema)]
pub struct HomeSuggestionOut {
    /// Stable while its kind and project are: `<kind>` or `<kind>.<project id>`. Send it to dismiss.
    pub id: String,
    pub kind: HomeKind,
    /// How many: `due_today`, the tasks due today or earlier; `access_waiting`, the project's waiting
    /// requests; `blocked_tasks`, the project's blocked tasks; `no_next_step`, always 1 (the project).
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

/// A suggestion, with its key and the hash of the ids behind it, for dismissal.
#[derive(Debug)]
struct Suggestion {
    key: SuggestionKey,
    out: HomeSuggestionOut,
    facts: [u8; 32],
    /// Within a kind, the more pressing first.
    weight: (u32, u32),
}

/// The facts of one project.
#[derive(Default)]
struct ProjectFacts {
    names: Option<(Named<CompanyId>, Named<ProjectId>)>,
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
fn facts(kind: HomeKind, mut ids: Vec<String>) -> [u8; 32] {
    ids.sort();
    let mut h = Sha256::new();
    h.update(kind.as_str().as_bytes());
    for id in ids {
        h.update(b"\n");
        h.update(id.as_bytes());
    }
    h.finalize().into()
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Every suggestion the facts call for, ranked: by kind, then the more pressing first, then by
/// company and project name for a stable order.
fn build(items: Vec<HomeFact>) -> Vec<Suggestion> {
    let mut projects: BTreeMap<(String, String), ProjectFacts> = BTreeMap::new();
    let mut due = Vec::new();
    for item in items {
        let (company, project) = match &item {
            HomeFact::DueTask { company, project, .. }
            | HomeFact::BlockedTask { company, project, .. }
            | HomeFact::WaitingAccess { company, project, .. }
            | HomeFact::NoNextStep { company, project } => (company.clone(), project.clone()),
        };
        let f = projects
            .entry((company.id.to_string(), project.id.to_string()))
            .or_default();
        f.names.get_or_insert((company, project));
        match item {
            HomeFact::DueTask { task, .. } => due.push(task.to_string()),
            HomeFact::BlockedTask { task, .. } => f.blocked.push(task.to_string()),
            HomeFact::WaitingAccess { access, days, .. } => {
                f.waiting
                    .push((access.to_string(), u32::try_from(days.max(0)).unwrap_or(u32::MAX)));
            }
            HomeFact::NoNextStep { .. } => f.no_next_step = true,
        }
    }

    let mut all = Vec::new();
    if !due.is_empty()
        && let Some(key) = SuggestionKey::new(HomeKind::DueToday.as_str())
    {
        all.push(Suggestion {
            key,
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
        let mut one = |kind: HomeKind, n: u32, days: Option<u32>, ids: Vec<String>, weight: (u32, u32)| {
            let id = format!("{}.{}", kind.as_str(), project.id);
            // Built from a kind and a validated project id, so always a key.
            let Some(key) = SuggestionKey::new(&id) else { return };
            all.push(Suggestion {
                key,
                out: HomeSuggestionOut {
                    id,
                    kind,
                    count: n,
                    days,
                    company: Some(named(&company)),
                    project: Some(named(&project)),
                    route: format!("/companies/{}/projects/{}", company.id, project.id),
                },
                facts: facts(kind, ids),
                weight,
            });
        };
        if !f.waiting.is_empty() {
            let longest = f.waiting.iter().map(|(_, d)| *d).max().unwrap_or(0);
            let n = count(f.waiting.len());
            let ids = f.waiting.into_iter().map(|(id, _)| id).collect();
            one(HomeKind::AccessWaiting, n, Some(longest), ids, (longest, n));
        }
        if !f.blocked.is_empty() {
            let n = count(f.blocked.len());
            one(HomeKind::BlockedTasks, n, None, f.blocked, (n, 0));
        }
        if f.no_next_step {
            one(HomeKind::NoNextStep, 1, None, vec![project.id.to_string()], (0, 0));
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
    // ponytail: "today" is the server's UTC date; there is no per-person time zone yet.
    let today = time::OffsetDateTime::now_utc().date();
    Ok(build(app.store.home_facts(&scopes, today).await?))
}

/// What needs the caller next, across the projects they work on, as a few suggestions built from
/// fixed templates: no free text from any record.
#[utoipa::path(get, operation_id = "get_home", path = "/v1/home", tag = "projects",
    responses((status = 200, body = HomeOut), (status = 401, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn home(State(app): State<Arc<App>>, who: Principal) -> Result<Json<HomeOut>, ApiError> {
    // Permission before any read: a customer role is refused even with the database down.
    app.require(&who, workspace(&who.tenant), "access").await?;
    // The dismissals first: one made while this read runs is not among them, so it is never forgotten.
    let mut tx = app.store.organisation(&who.tenant).await?;
    let read = tx.home_dismissals(&who.user).await?;
    tx.commit().await?;
    let all = current(&app, &who).await?;
    let forget = gone(&read, &all);
    if !forget.is_empty() {
        let mut tx = app.store.organisation(&who.tenant).await?;
        tx.forget_home_dismissals(&who.user, &forget).await?;
        tx.commit().await?;
    }
    let dismissed: HashMap<SuggestionKey, [u8; 32]> = read
        .into_iter()
        .filter(|d| !forget.contains(d))
        .map(|d| (d.suggestion, d.facts))
        .collect();
    Ok(Json(HomeOut {
        suggestions: visible(all, &dismissed),
    }))
}

/// The dismissals whose suggestion is not in `all` any more: forgotten, so a suggestion that goes
/// away and comes back with the same ids shows again.
fn gone(read: &[Dismissal], all: &[Suggestion]) -> Vec<Dismissal> {
    read.iter()
        .filter(|d| !all.iter().any(|s| s.key == d.suggestion))
        .cloned()
        .collect()
}

/// The suggestions not dismissed with the facts they have now, at most [`MAX_SUGGESTIONS`].
fn visible(all: Vec<Suggestion>, dismissed: &HashMap<SuggestionKey, [u8; 32]>) -> Vec<HomeSuggestionOut> {
    all.into_iter()
        .filter(|s| dismissed.get(&s.key) != Some(&s.facts))
        .take(MAX_SUGGESTIONS)
        .map(|s| s.out)
        .collect()
}

/// Whether `key` is one the server issues: a known kind, with a project for every kind but
/// `due_today`, and none for it.
fn issued(key: &SuggestionKey) -> bool {
    let (kind, project) = match key.as_str().split_once('.') {
        Some((k, p)) => (k, Some(p)),
        None => (key.as_str(), None),
    };
    HomeKind::ALL
        .iter()
        .any(|k| k.as_str() == kind && k.per_project() == project.is_some())
}

/// Hide a suggestion from the caller's home until its facts change (a new blocked task, another
/// access request) or it goes away; if it comes back, it shows again. Only a suggestion the caller
/// has now.
#[utoipa::path(post, operation_id = "dismiss_home_suggestion", path = "/v1/home/suggestions/{suggestion}/dismiss",
    tag = "projects", params(("suggestion" = String, Path, description = "A suggestion's `id`")),
    responses((status = 204, description = "Dismissed"), (status = 401, body = ErrorBody),
        (status = 400, body = ErrorBody, description = "`invalid_suggestion`: not an id the server issues"),
        (status = 403, body = ErrorBody), (status = 404, body = ErrorBody, description = "Not one the caller has now"),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn dismiss(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(suggestion): Path<String>,
) -> Result<StatusCode, ApiError> {
    let key = SuggestionKey::new(&suggestion)
        .filter(issued)
        .ok_or(ApiError::Invalid("suggestion"))?;
    let found = current(&app, &who)
        .await?
        .into_iter()
        .find(|s| s.key == key)
        .ok_or(ApiError::NotFound)?;
    let mut tx = app.store.organisation(&who.tenant).await?;
    tx.dismiss_home(&who.user, &key, &found.facts).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use oryxa_fde_core::{AccessRequestId, TaskId};
    use oryxa_fde_store::Name;

    use super::*;

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

    fn due(c: &str, p: &str, id: &str) -> HomeFact {
        let (company, project) = place(c, p);
        HomeFact::DueTask {
            task: TaskId::new(id).unwrap(),
            company,
            project,
        }
    }

    fn blocked(c: &str, p: &str, id: &str) -> HomeFact {
        let (company, project) = place(c, p);
        HomeFact::BlockedTask {
            task: TaskId::new(id).unwrap(),
            company,
            project,
        }
    }

    fn waiting(c: &str, p: &str, id: &str, days: i64) -> HomeFact {
        let (company, project) = place(c, p);
        HomeFact::WaitingAccess {
            access: AccessRequestId::new(id).unwrap(),
            days,
            company,
            project,
        }
    }

    fn idle(c: &str, p: &str) -> HomeFact {
        let (company, project) = place(c, p);
        HomeFact::NoNextStep { company, project }
    }

    fn ids(list: &[Suggestion]) -> Vec<&str> {
        list.iter().map(|s| s.out.id.as_str()).collect()
    }

    fn world() -> Vec<HomeFact> {
        vec![
            blocked("Acme", "Triage", "tsk_1"),
            due("Acme", "Triage", "tsk_2"),
            due("Acme", "Triage", "tsk_3"),
            blocked("Globex", "Search", "tsk_5"),
            blocked("Globex", "Search", "tsk_6"),
            waiting("Acme", "Triage", "acc_1", 3),
            waiting("Globex", "Search", "acc_2", 9),
            idle("Initech", "Pilot"),
        ]
    }

    fn dismissal(s: &Suggestion) -> Dismissal {
        Dismissal {
            suggestion: s.key.clone(),
            facts: s.facts,
            dismissed_at: time::OffsetDateTime::UNIX_EPOCH,
        }
    }

    #[test]
    fn each_kind_is_built_from_ids_and_counts_and_ranked() {
        let all = build(world());
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
            (2, "/today", true)
        );
        let longest = &all[1].out;
        assert_eq!((longest.count, longest.days), (1, Some(9)));
        assert_eq!(longest.route, "/companies/cmp_Globex/projects/prj_Search");
        assert_eq!(longest.company.as_ref().map(|c| c.name.as_str()), Some("Globex"));
        assert_eq!((all[3].out.count, all[4].out.count), (2, 1));
        assert_eq!(all[5].out.project.as_ref().map(|p| p.name.as_str()), Some("Pilot"));
        assert_eq!(all[5].out.count, 1, "the one project");
        assert!(build(vec![]).is_empty());
    }

    #[test]
    fn a_suggestion_that_goes_away_and_comes_back_with_the_same_ids_shows_again() {
        let all = build(world());
        let read: Vec<Dismissal> = all
            .iter()
            .filter(|s| s.out.id == "no_next_step.prj_Pilot" || s.out.id == "blocked_tasks.prj_Triage")
            .map(dismissal)
            .collect();
        // Pilot gets a next step and Triage's task is unblocked: both suggestions go away.
        let without: Vec<HomeFact> = world()
            .into_iter()
            .filter(|f| !matches!(f, HomeFact::NoNextStep { .. }))
            .filter(|f| !matches!(f, HomeFact::BlockedTask { task, .. } if task.as_str() == "tsk_1"))
            .collect();
        let forget = gone(&read, &build(without));
        let mut names: Vec<&str> = forget.iter().map(|d| d.suggestion.as_str()).collect();
        names.sort();
        assert_eq!(names, ["blocked_tasks.prj_Triage", "no_next_step.prj_Pilot"]);
        // They come back with exactly the same ids: shown again, since their dismissals were forgotten.
        let left: HashMap<SuggestionKey, [u8; 32]> = read
            .into_iter()
            .filter(|d| !forget.contains(d))
            .map(|d| (d.suggestion, d.facts))
            .collect();
        let shown: Vec<String> = visible(build(world()), &left).into_iter().map(|s| s.id).collect();
        assert!(shown.contains(&"blocked_tasks.prj_Triage".to_owned()), "{shown:?}");
        // A suggestion still there keeps its dismissal.
        let kept: Vec<Dismissal> = all.iter().filter(|s| s.out.id == "due_today").map(dismissal).collect();
        assert!(gone(&kept, &all).is_empty());
    }

    #[test]
    fn at_most_five_are_shown_and_a_dismissal_lasts_until_its_facts_change() {
        let all = build(world());
        assert_eq!(visible(build(world()), &HashMap::new()).len(), MAX_SUGGESTIONS);

        // Dismissed with today's facts: hidden, and the next one moves up.
        let dismissed: HashMap<SuggestionKey, [u8; 32]> = all
            .iter()
            .filter(|s| s.out.id == "access_waiting.prj_Search")
            .map(|s| (s.key.clone(), s.facts))
            .collect();
        let shown = visible(build(world()), &dismissed);
        assert!(!shown.iter().any(|s| s.id == "access_waiting.prj_Search"));
        assert_eq!(shown.last().map(|s| s.id.as_str()), Some("no_next_step.prj_Pilot"));

        // A wait growing longer is the same facts: still hidden.
        let mut later = world();
        later[6] = waiting("Globex", "Search", "acc_2", 12);
        assert!(
            !visible(build(later), &dismissed)
                .iter()
                .any(|s| s.id == "access_waiting.prj_Search")
        );

        // Another request on that project changes the facts: it shows again.
        let mut more = world();
        more.push(waiting("Globex", "Search", "acc_4", 0));
        assert!(
            visible(build(more), &dismissed)
                .iter()
                .any(|s| s.id == "access_waiting.prj_Search")
        );
    }

    #[test]
    fn only_an_id_the_server_issues_can_be_dismissed() {
        for ok in [
            "due_today",
            "blocked_tasks.prj_1",
            "access_waiting.prj_1",
            "no_next_step.prj_1",
        ] {
            assert!(issued(&SuggestionKey::new(ok).unwrap()), "{ok}");
        }
        for bad in [
            "overdue",
            "blocked_tasks",
            "due_today.prj_1",
            "no_next_step",
            "made_up.prj_1",
        ] {
            assert!(!issued(&SuggestionKey::new(bad).unwrap()), "{bad}");
        }
    }
}
