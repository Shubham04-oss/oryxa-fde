//! Share links and the customer room. An FDE who works on a project makes a link for it; a customer
//! person signed in to the tenant redeems it and becomes a guest of that project only (SpiceDB's
//! `guest`, written after the row commits). The room shows a guest only room-safe fields, and
//! only while their link is live: an expired or revoked link fails closed whatever SpiceDB holds.
//!
//! A token is `<company>.<project>.<link>.<secret>`: ids are `[A-Za-z0-9_-]`, so the dots split it,
//! and the secret is 32 random bytes in hex, of which only the SHA-256 is stored.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use oryxa_authz::Write;
use oryxa_fde_core::{CompanyId, ProjectId, ShareLinkId, Stage};
use oryxa_fde_store::{CriterionResult, Redeemed, ShareLink, UnsubscribeToken, UpdateStatus, new_id};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use utoipa::ToSchema;

use crate::authz::{project, rel, user};
use crate::lifecycle::{CriterionOut, project_tx};
use crate::projects::ProjectStage;
use crate::records::new;
use crate::{ApiError, App, ErrorBody, Principal, ts};

/// How long a link lives unless asked otherwise, and the longest it may.
const DEFAULT_DAYS: u32 = 14;
const MAX_DAYS: u32 = 90;

#[derive(Debug, Default, Deserialize, ToSchema)]
pub struct ShareLinkBody {
    /// Days until it expires, 1 to 90; 14 if not given.
    pub expires_in_days: Option<u32>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ShareLinkOut {
    pub id: String,
    pub expires_at: String,
    pub revoked_at: Option<String>,
    pub created_by: String,
    pub created_at: String,
    /// How many people redeemed it.
    pub guests: u32,
}

impl From<ShareLink> for ShareLinkOut {
    fn from(l: ShareLink) -> Self {
        Self {
            id: l.id.to_string(),
            expires_at: ts(l.expires_at),
            revoked_at: l.revoked_at.map(ts),
            created_by: l.created_by.to_string(),
            created_at: ts(l.created_at),
            guests: l.guests,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct NewShareLinkOut {
    pub link: ShareLinkOut,
    /// Shown once, never stored: the only way to redeem the link.
    pub token: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RedeemBody {
    pub token: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RedeemedOut {
    pub company: String,
    pub project: String,
}

/// What a guest may see of a project.
#[derive(Debug, Serialize, ToSchema)]
pub struct RoomOut {
    pub project: String,
    pub name: String,
    pub stage: ProjectStage,
    /// Stages reached, from 1 (discover) to `stages` (operate).
    pub progress: u32,
    pub stages: u32,
    /// The success criteria, each with its latest measured result.
    pub criteria: Vec<RoomCriterionOut>,
    /// How many criteria the latest results meet.
    pub criteria_passing: u32,
    /// The scope as it stands is waiting for the customer's sign-off.
    pub scope_awaits_sign_off: bool,
    /// Questions the team put to the customer, oldest first, until answered.
    pub questions: Vec<RoomQuestionOut>,
    /// The newest update an FDE approved; never a draft.
    pub latest_update: Option<RoomUpdateOut>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RoomCriterionOut {
    pub criterion: CriterionOut,
    /// The latest value an eval run measured; null until one has.
    pub latest: Option<f64>,
    /// Whether that value meets the target; null until measured.
    pub passing: Option<bool>,
    pub measured_at: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RoomQuestionOut {
    pub question: String,
    pub asked_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RoomUpdateOut {
    /// The Monday of the week it covers, `YYYY-MM-DD`.
    pub week: String,
    pub body: String,
    pub approved_at: Option<String>,
}

fn sha256(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A token's parts, if it is well formed: no lookup happens for anything else.
fn parse_token(token: &str) -> Option<(CompanyId, ProjectId, ShareLinkId, &str)> {
    let mut parts = token.split('.');
    let (c, p, l, secret) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || secret.len() != 64 || !secret.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some((
        CompanyId::new(c).ok()?,
        ProjectId::new(p).ok()?,
        ShareLinkId::new(l).ok()?,
        secret,
    ))
}

/// Make a link to the project for a customer person. The token is in this response only.
#[utoipa::path(post, operation_id = "create_share_link", path = "/v1/companies/{company}/projects/{project}/share-links",
    tag = "room", request_body = ShareLinkBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 201, body = NewShareLinkOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub(crate) async fn create(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<ShareLinkBody>,
) -> Result<(StatusCode, Json<NewShareLinkOut>), ApiError> {
    let days = body.expires_in_days.unwrap_or(DEFAULT_DAYS);
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(ApiError::Invalid("expires_in_days"));
    }
    let mut tx = project_tx(&app, &who, c.clone(), p.clone()).await?;
    let id = new("shr", ShareLinkId::new)?;
    let mut secret = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut secret);
    let secret: String = secret.iter().map(|b| format!("{b:02x}")).collect();
    let expires_at = OffsetDateTime::now_utc() + Duration::days(i64::from(days));
    let link = tx
        .create_share_link(&id, &sha256(&secret), expires_at, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        Json(NewShareLinkOut {
            link: link.into(),
            token: format!("{c}.{p}.{id}.{secret}"),
        }),
    ))
}

/// The project's share links, newest first; never their tokens.
#[utoipa::path(get, operation_id = "list_share_links", path = "/v1/companies/{company}/projects/{project}/share-links",
    tag = "room",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [ShareLinkOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn list(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<ShareLinkOut>>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let links = tx.share_links().await?;
    tx.commit().await?;
    Ok(Json(links.into_iter().map(Into::into).collect()))
}

/// Revoke a link: its guests lose the project at once, unless another live link keeps one.
#[utoipa::path(delete, operation_id = "revoke_share_link",
    path = "/v1/companies/{company}/projects/{project}/share-links/{link}", tag = "room",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("link" = String, Path, description = "Share link id")),
    responses((status = 204), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn revoke(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, l)): Path<(CompanyId, ProjectId, ShareLinkId)>,
) -> Result<StatusCode, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let gone = tx
        .revoke_share_link(&l, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    // Deleted before the revocation commits: if SpiceDB cannot be reached, nothing changes.
    let s = tx.scope().clone();
    let deletes: Vec<Write> = gone
        .iter()
        .map(|u| Write::Delete(rel(project(&s), "guest", user(&who.tenant, u))))
        .collect();
    if !deletes.is_empty() {
        app.write(&who.tenant, &deletes).await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Redeem a share link: the caller, signed in to the organisation, becomes a guest of its project.
/// A token that is malformed, unknown, expired or revoked is refused alike.
#[utoipa::path(post, operation_id = "redeem_share_link", path = "/v1/share-links/redeem", tag = "room",
    request_body = RedeemBody,
    responses((status = 200, body = RedeemedOut), (status = 404, body = ErrorBody)))]
pub(crate) async fn redeem(
    State(app): State<Arc<App>>,
    who: Principal,
    Json(body): Json<RedeemBody>,
) -> Result<Json<RedeemedOut>, ApiError> {
    let (c, p, l, secret) = parse_token(&body.token).ok_or(ApiError::NotFound)?;
    // The token is the permission: it names its project, in the caller's own tenant.
    let s = who.company(c.clone()).project(p.clone());
    let mut tx = app.store.project(&s).await?;
    let row = match tx
        .redeem_share_link(&l, &sha256(secret), &who.user, &who.actor())
        .await?
    {
        Redeemed::Guest(row) => row,
        Redeemed::Refused => return Err(ApiError::NotFound),
    };
    tx.commit().await?;
    app.grant(row).await;
    Ok(Json(RedeemedOut {
        company: c.to_string(),
        project: p.to_string(),
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UnsubscribeBody {
    /// From the fragment of the link in a weekly digest.
    pub token: String,
}

/// Unsubscribe a sponsor from the weekly digest, from the link in a digest they were sent. No
/// sign-in: the token is the permission, and it does this one thing. A token that is malformed,
/// unknown or not the latest sent for its delivery is refused alike; again is no change.
#[utoipa::path(post, operation_id = "unsubscribe_digest", path = "/v1/digest/unsubscribe", tag = "room",
    request_body = UnsubscribeBody, security(()),
    responses((status = 204, description = "Unsubscribed"), (status = 404, body = ErrorBody)))]
pub(crate) async fn unsubscribe(
    State(app): State<Arc<App>>,
    Json(body): Json<UnsubscribeBody>,
) -> Result<StatusCode, ApiError> {
    let token = UnsubscribeToken::parse(&body.token).ok_or(ApiError::NotFound)?;
    let mut tx = app.store.project(&token.scope).await?;
    if !tx.unsubscribe_digest(&token, &new_id("req")).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The customer room of one project: what its guests may see. Needs `work` on the project, or
/// `view` with a live share link the caller redeemed.
#[utoipa::path(get, operation_id = "get_room", path = "/v1/room/companies/{company}/projects/{project}", tag = "room",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = RoomOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn room(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<RoomOut>, ApiError> {
    let s = who.company(c).project(p);
    let works = app.allowed(&who, project(&s), "work").await?;
    if !works {
        app.require(&who, project(&s), "view").await?;
    }
    let mut tx = app.store.project(&s).await?;
    if !works && !tx.live_guest(&who.user).await? {
        return Err(ApiError::Forbidden);
    }
    let found = tx.get().await?.ok_or(ApiError::NotFound)?;
    let scope = tx.scope_of_work().await?.ok_or(ApiError::NotFound)?;
    let results = tx.latest_criterion_results().await?;
    let questions = tx.customer_questions().await?;
    // Newest week first: the first approved one is the latest.
    let approved = tx
        .update_drafts()
        .await?
        .into_iter()
        .find(|u| u.status == UpdateStatus::Approved);
    tx.commit().await?;
    let progress = Stage::ALL.iter().position(|st| *st == found.stage).unwrap_or(0) as u32 + 1;
    let criteria: Vec<RoomCriterionOut> = scope
        .criteria
        .into_iter()
        .map(|c| {
            let result: Option<&CriterionResult> = results.iter().find(|r| r.criterion == c.id);
            RoomCriterionOut {
                latest: result.map(|r| r.value),
                passing: result.map(|r| r.passing),
                measured_at: result.map(|r| ts(r.measured_at)),
                criterion: c.into(),
            }
        })
        .collect();
    Ok(Json(RoomOut {
        project: found.id.to_string(),
        name: found.name.as_str().to_owned(),
        stage: found.stage.into(),
        progress,
        stages: Stage::ALL.len() as u32,
        scope_awaits_sign_off: !scope.items.is_empty()
            && scope.sign_off.as_ref().map(|so| so.version) != Some(scope.version),
        questions: questions
            .into_iter()
            .map(|(q, at)| RoomQuestionOut {
                question: q.as_str().to_owned(),
                asked_at: ts(at),
            })
            .collect(),
        criteria_passing: criteria.iter().filter(|c| c.passing == Some(true)).count() as u32,
        criteria,
        latest_update: approved.map(|u| RoomUpdateOut {
            week: u.week.to_string(),
            body: u.body.as_str().to_owned(),
            approved_at: u.decided_at.map(ts),
        }),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_well_formed_token_is_looked_up() {
        let secret = "ab".repeat(32);
        let ok = format!("cmp_1.prj_1.shr_1.{secret}");
        let (c, p, l, s) = parse_token(&ok).unwrap();
        assert_eq!(
            (c.as_str(), p.as_str(), l.as_str(), s),
            ("cmp_1", "prj_1", "shr_1", secret.as_str())
        );
        for bad in [
            String::new(),
            format!("cmp_1.prj_1.{secret}"),
            format!("cmp_1.prj_1.shr_1.{secret}.x"),
            format!("cmp_1.prj_1.shr_1.{}", "zz".repeat(32)),
            format!("cmp_1.prj_1.shr_1.{}", "ab".repeat(31)),
            format!("cmp|1.prj_1.shr_1.{secret}"),
        ] {
            assert!(parse_token(&bad).is_none(), "{bad}");
        }
    }
}
