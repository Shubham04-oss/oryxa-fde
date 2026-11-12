//! The organisation's people and their display names, from WorkOS memberships (#142).
//!
//! One WorkOS lookup per organisation lists everyone with an active membership, with their role and
//! name; each replica keeps it for [`PEOPLE_TTL`], so a person added in WorkOS shows within that
//! time. Nothing is stored in Postgres, and names never go into events or logs.
//!
//! Who sees whom: `GET /v1/people` needs `access` to the workspace (the organisation's own admins and
//! members) and lists only them, never a guest or customer person, whose WorkOS role gives them no
//! workspace relation (`auth::WorkspaceRole`). A company's members and a project's assignees carry
//! their names on the routes that already decide who may see them (`work`). No email is returned.
//!
//! Names fail soft: when WorkOS cannot answer, those routes return ids with no names. Only the list
//! itself answers 503, since a partial or empty list would read as complete.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use serde::Serialize;
use tokio::time::Instant;
use utoipa::ToSchema;

use crate::auth::WorkspaceRole;
use crate::authz::workspace;
use crate::session::AuthKit;
use crate::{ApiError, App, ErrorBody, Principal};

/// How long a replica keeps an organisation's people.
const PEOPLE_TTL: Duration = Duration::from_secs(5 * 60);
/// After a failed lookup, names are left out this long, so a WorkOS outage does not slow every request.
const FAILED_TTL: Duration = Duration::from_secs(15);
/// A lookup that takes longer than this has failed.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Someone with an active membership of the organisation, as WorkOS has them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    /// WorkOS user id.
    pub id: String,
    /// First and last name; `None` when WorkOS has neither. Never the email.
    pub name: Option<String>,
    /// The membership's WorkOS role slug.
    pub role: String,
}

impl Person {
    /// One of the organisation's own admins or members, rather than a guest or customer person.
    fn staff(&self) -> bool {
        WorkspaceRole::of(Some(&self.role)) != WorkspaceRole::Outsider
    }
}

/// A display name from WorkOS's first and last name, or `None`: never falls back to the email.
pub fn display_name(first: Option<&str>, last: Option<&str>) -> Option<String> {
    let name = [first, last]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!name.is_empty()).then_some(name)
}

type Directory = Arc<HashMap<String, Person>>;
/// The last lookup (`Err` if it failed) and when it was made.
type Slot = tokio::sync::Mutex<Option<(Result<Directory, ()>, Instant)>>;

/// Each organisation's people, cached per replica.
// ponytail: one slot per organisation this replica has served, never dropped; fine for the number
// of organisations one deployment serves.
#[derive(Default)]
pub(crate) struct People(Mutex<HashMap<String, Arc<Slot>>>);

impl People {
    /// Everyone in `organisation` by user id. Concurrent misses share one lookup.
    pub(crate) async fn of(&self, authkit: &dyn AuthKit, organisation: &str) -> Result<Directory, ApiError> {
        let slot = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(organisation.to_owned())
            .or_default()
            .clone();
        let mut last = slot.lock().await;
        if let Some((found, at)) = last.as_ref() {
            let ttl = if found.is_ok() { PEOPLE_TTL } else { FAILED_TTL };
            if at.elapsed() < ttl {
                return found.clone().map_err(|()| ApiError::Unavailable);
            }
        }
        let found = match tokio::time::timeout(LOOKUP_TIMEOUT, authkit.people(organisation)).await {
            Ok(Ok(list)) => Ok(Arc::new(list.into_iter().map(|p| (p.id.clone(), p)).collect())),
            Ok(Err(e)) => {
                tracing::error!(error = %e, "workos people lookup failed");
                Err(())
            }
            Err(_) => {
                tracing::error!("workos people lookup timed out");
                Err(())
            }
        };
        *last = Some((found.clone(), Instant::now()));
        found.map_err(|()| ApiError::Unavailable)
    }
}

/// Display names by user id, for naming people in an answer.
pub(crate) struct Names(Option<Directory>);

impl Names {
    /// `id`'s display name, if they are in the organisation and WorkOS has one.
    pub(crate) fn of(&self, id: &str) -> Option<String> {
        self.0.as_ref()?.get(id)?.name.clone()
    }
}

impl App {
    /// The caller's organisation's people; 503 if WorkOS cannot say.
    async fn people(&self, who: &Principal) -> Result<Directory, ApiError> {
        let sign_in = self.sign_in.as_ref().ok_or(ApiError::Unavailable)?;
        sign_in.people(who.tenant.as_str()).await
    }

    /// Names for the caller's organisation, or none at all when WorkOS cannot say: a name is never
    /// worth failing the request for.
    pub(crate) async fn names(&self, who: &Principal) -> Names {
        Names(self.people(who).await.ok())
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PersonOut {
    /// WorkOS user id.
    pub id: String,
    /// First and last name, or `null` when WorkOS has neither.
    pub name: Option<String>,
}

/// The organisation's own people (its admins and members in WorkOS), by name: whom a lead can add
/// to a company, and the names behind the user ids in any answer. Needs `access` to the
/// organisation's workspace; guests and customer people are neither listed nor allowed to list.
/// No emails. 503 when WorkOS cannot answer, never a partial list.
#[utoipa::path(get, operation_id = "list_people", path = "/v1/people", tag = "people",
    responses((status = 200, body = [PersonOut]), (status = 401, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn list(State(app): State<Arc<App>>, who: Principal) -> Result<Json<Vec<PersonOut>>, ApiError> {
    app.require(&who, workspace(&who.tenant), "access").await?;
    let people = app.people(&who).await?;
    let mut list: Vec<&Person> = people.values().filter(|p| p.staff()).collect();
    // By name, the unnamed last; ids break ties so the order is stable.
    list.sort_by(|a, b| {
        (a.name.is_none(), a.name.as_deref().map(str::to_lowercase), &a.id).cmp(&(
            b.name.is_none(),
            b.name.as_deref().map(str::to_lowercase),
            &b.id,
        ))
    });
    Ok(Json(
        list.into_iter()
            .map(|p| PersonOut {
                id: p.id.clone(),
                name: p.name.clone(),
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;
    use crate::BoxFuture;
    use crate::session::{Attempt, Client, RefreshError, Tokens};

    /// AuthKit whose only working call is `people`, counting lookups.
    #[derive(Default)]
    struct FakeDirectory {
        lookups: AtomicUsize,
        fail: AtomicBool,
        hang: AtomicBool,
    }

    impl AuthKit for FakeDirectory {
        fn authorization_url(&self, _: &str, _: &str, _: &str) -> Result<String, String> {
            Err("unused".into())
        }
        fn exchange_code<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<Tokens, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn refresh<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<Tokens, RefreshError>> {
            Box::pin(async { Err(RefreshError::Refused("unused".into())) })
        }
        fn revoke<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn user_name<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<String, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn organisation_name<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<String, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn people<'a>(&'a self, organisation: &'a str) -> BoxFuture<'a, Result<Vec<Person>, String>> {
            Box::pin(async move {
                self.lookups.fetch_add(1, Ordering::SeqCst);
                if self.hang.load(Ordering::SeqCst) {
                    std::future::pending::<()>().await;
                }
                if self.fail.load(Ordering::SeqCst) {
                    return Err("workos is down".into());
                }
                Ok(vec![Person {
                    id: format!("user_of_{organisation}"),
                    name: Some("Ada Lovelace".into()),
                    role: "member".into(),
                }])
            })
        }
        fn sign_in_with_password<'a>(&'a self, _: &'a str, _: &'a str, _: &'a Client) -> BoxFuture<'a, Attempt> {
            Box::pin(async { Attempt::Unavailable("unused".into()) })
        }
        fn verify_email<'a>(&'a self, _: &'a str, _: &'a str, _: &'a Client) -> BoxFuture<'a, Attempt> {
            Box::pin(async { Attempt::Unavailable("unused".into()) })
        }
        fn choose_organisation<'a>(&'a self, _: &'a str, _: &'a str, _: &'a Client) -> BoxFuture<'a, Attempt> {
            Box::pin(async { Attempt::Unavailable("unused".into()) })
        }
    }

    #[test]
    fn a_display_name_is_first_and_last_and_never_the_email() {
        assert_eq!(
            display_name(Some("Ada"), Some("Lovelace")).as_deref(),
            Some("Ada Lovelace")
        );
        assert_eq!(display_name(Some(" Ada "), None).as_deref(), Some("Ada"));
        assert_eq!(display_name(None, Some("Lovelace")).as_deref(), Some("Lovelace"));
        assert_eq!(display_name(Some(""), Some("  ")), None);
        assert_eq!(display_name(None, None), None);
    }

    #[test]
    fn only_the_organisations_admins_and_members_are_staff() {
        let as_role = |role: &str| Person {
            id: "user_1".into(),
            name: None,
            role: role.into(),
        };
        assert!(as_role("admin").staff());
        assert!(as_role("member").staff());
        for other in ["guest", "it_admin", "sponsor", "Admin", ""] {
            assert!(!as_role(other).staff(), "{other}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_organisation_is_looked_up_once_per_ttl() {
        let (kit, people) = (FakeDirectory::default(), People::default());
        let first = people.of(&kit, "org_1").await.unwrap();
        assert_eq!(first["user_of_org_1"].name.as_deref(), Some("Ada Lovelace"));
        people.of(&kit, "org_1").await.unwrap();
        assert_eq!(kit.lookups.load(Ordering::SeqCst), 1, "cached");
        let other = people.of(&kit, "org_2").await.unwrap();
        assert!(!other.contains_key("user_of_org_1"), "per organisation");
        assert_eq!(kit.lookups.load(Ordering::SeqCst), 2);
        tokio::time::advance(PEOPLE_TTL).await;
        people.of(&kit, "org_1").await.unwrap();
        assert_eq!(kit.lookups.load(Ordering::SeqCst), 3, "expired");
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_misses_share_one_lookup() {
        let (kit, people) = (FakeDirectory::default(), People::default());
        let (a, b) = tokio::join!(people.of(&kit, "org_1"), people.of(&kit, "org_1"));
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(kit.lookups.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_lookup_is_unavailable_briefly_then_tried_again() {
        let (kit, people) = (FakeDirectory::default(), People::default());
        kit.fail.store(true, Ordering::SeqCst);
        assert!(matches!(people.of(&kit, "org_1").await, Err(ApiError::Unavailable)));
        kit.fail.store(false, Ordering::SeqCst);
        assert!(
            matches!(people.of(&kit, "org_1").await, Err(ApiError::Unavailable)),
            "the failure is remembered, so an outage does not slow every request"
        );
        assert_eq!(kit.lookups.load(Ordering::SeqCst), 1);
        tokio::time::advance(FAILED_TTL).await;
        assert!(people.of(&kit, "org_1").await.is_ok());
        assert_eq!(kit.lookups.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_lookup_times_out() {
        let (kit, people) = (FakeDirectory::default(), People::default());
        kit.hang.store(true, Ordering::SeqCst);
        assert!(matches!(people.of(&kit, "org_1").await, Err(ApiError::Unavailable)));
    }

    #[test]
    fn names_without_a_directory_are_all_unknown() {
        assert_eq!(Names(None).of("user_1"), None);
        let dir = HashMap::from([(
            "user_1".to_owned(),
            Person {
                id: "user_1".into(),
                name: Some("Ada".into()),
                role: "member".into(),
            },
        )]);
        let names = Names(Some(Arc::new(dir)));
        assert_eq!(names.of("user_1").as_deref(), Some("Ada"));
        assert_eq!(names.of("user_2"), None);
    }
}
