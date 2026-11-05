//! GitHub and Slack (#22).
//!
//! **GitHub.** An organisation admin installs our GitHub App. The install carries a signed,
//! single-use `state`, and the claim is proved through the user's OAuth: the installation must be
//! among those GitHub says the user can reach. A project then links repositories of the
//! organisation's installations, each checked with GitHub first. `POST /webhooks/github` takes
//! GitHub's deliveries (HMAC-signed, recent, never replayed) and turns pull requests opened or
//! merged into FDE events. An installation leaving, or repositories leaving it, unclaims or unlinks
//! once GitHub confirms it.
//!
//! **Slack.** An admin installs our Slack app into the organisation's workspace. The bot token goes
//! to Secrets Manager, and only its ARN is stored. A company links one channel, and the lifecycle
//! engine posts approved updates there. `POST /webhooks/slack` takes Slack's signed events; an
//! uninstall forgets the workspace and deletes the token.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use oryxa_fde_core::{CompanyId, ProjectId};
use oryxa_fde_integrations::github::{self, InstallationChange, PullRequestAction, WebhookSecret};
use oryxa_fde_integrations::github_api::{GitHub, GitHubError};
use oryxa_fde_integrations::secrets::Secrets;
use oryxa_fde_integrations::slack::{self, ChannelId, SigningSecret, Slack, SlackError, SlackEvent};
use oryxa_fde_integrations::state::{self, InstallKind, InstallState, StateKey};
use oryxa_fde_store::{
    Claimed, GitHubInstallation, GitHubRepository, RepositoryName, SlackChannel, SlackChannelId, SlackInstallation,
    SlackTeamId,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use utoipa::ToSchema;

use crate::authz::{company, workspace};
use crate::lifecycle::project_tx;
use crate::{ApiError, App, ErrorBody, Principal, ts};

/// The GitHub App, when configured.
pub struct GitHubIntegration {
    pub api: Arc<dyn GitHub>,
    pub webhook: WebhookSecret,
    pub state: StateKey,
}

/// The Slack app, when configured.
pub struct SlackIntegration {
    pub api: Arc<dyn Slack>,
    pub signing: SigningSecret,
    pub secrets: Arc<dyn Secrets>,
    pub state: StateKey,
}

/// Either may be off; its routes then answer 503.
#[derive(Default)]
pub struct Integrations {
    pub github: Option<GitHubIntegration>,
    pub slack: Option<SlackIntegration>,
}

fn var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn need(key: &str) -> Result<String, String> {
    var(key).ok_or_else(|| format!("{key} is not set"))
}

impl Integrations {
    /// From the environment. GitHub is on when `GITHUB_APP_ID` is set, and needs `GITHUB_APP_SLUG`,
    /// `GITHUB_APP_PRIVATE_KEY` (PEM), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and
    /// `GITHUB_WEBHOOK_SECRET`. Slack is on when `SLACK_CLIENT_ID` is set, and needs
    /// `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `SLACK_SECRET_PREFIX`
    /// (`oryxa-fde/<env>/slack/`) and `SLACK_KMS_KEY_ID`. Either needs `INSTALL_STATE_KEY` (at least
    /// 32 bytes) to sign install states. The secrets come from Secrets Manager through ECS.
    pub async fn from_env(web_origin: &str) -> Result<Self, String> {
        let state = || {
            oryxa_fde_integrations::state::StateKey::new(need("INSTALL_STATE_KEY")?)
                .ok_or_else(|| "INSTALL_STATE_KEY must be at least 32 bytes".to_owned())
        };
        let http = || oryxa_fde_integrations::outbound::Outbound::new().map_err(|e| e.to_string());
        let github = match var("GITHUB_APP_ID") {
            None => None,
            Some(id) => {
                let app = oryxa_fde_integrations::github_api::GitHubApp::new(
                    id.parse().map_err(|_| "GITHUB_APP_ID must be a number".to_owned())?,
                    &need("GITHUB_APP_SLUG")?,
                    &need("GITHUB_APP_PRIVATE_KEY")?,
                    &need("GITHUB_CLIENT_ID")?,
                    &need("GITHUB_CLIENT_SECRET")?,
                    http()?,
                )
                .ok_or("GITHUB_APP_SLUG or GITHUB_APP_PRIVATE_KEY is not usable")?;
                Some(GitHubIntegration {
                    api: Arc::new(app),
                    webhook: WebhookSecret::new(need("GITHUB_WEBHOOK_SECRET")?)
                        .ok_or("GITHUB_WEBHOOK_SECRET must be at least 32 bytes")?,
                    state: state()?,
                })
            }
        };
        let slack = match var("SLACK_CLIENT_ID") {
            None => None,
            Some(client_id) => {
                let redirect = format!("{}/integrations/slack/callback", web_origin.trim_end_matches('/'));
                let app = oryxa_fde_integrations::slack::SlackApp::new(
                    &client_id,
                    &need("SLACK_CLIENT_SECRET")?,
                    &redirect,
                    http()?,
                )
                .ok_or("SLACK_CLIENT_SECRET is not set or WEB_ORIGIN is not https")?;
                let aws = aws_config::load_from_env().await;
                let secrets = oryxa_fde_integrations::secrets::SecretsManager::new(
                    aws_sdk_secretsmanager::Client::new(&aws),
                    &need("SLACK_SECRET_PREFIX")?,
                    &need("SLACK_KMS_KEY_ID")?,
                )
                .ok_or("SLACK_SECRET_PREFIX must look like oryxa-fde/<env>/slack/")?;
                Some(SlackIntegration {
                    api: Arc::new(app),
                    signing: SigningSecret::new(need("SLACK_SIGNING_SECRET")?)
                        .ok_or("SLACK_SIGNING_SECRET must be at least 16 bytes")?,
                    secrets: Arc::new(secrets),
                    state: state()?,
                })
            }
        };
        Ok(Self { github, slack })
    }
}

fn github(app: &App) -> Result<&GitHubIntegration, ApiError> {
    app.integrations.github.as_ref().ok_or(ApiError::Unavailable)
}

fn slack(app: &App) -> Result<&SlackIntegration, ApiError> {
    app.integrations.slack.as_ref().ok_or(ApiError::Unavailable)
}

/// Most repositories one removal delivery unlinks.
const MAX_REMOVED: usize = 100;

#[derive(Debug, Serialize, ToSchema)]
pub struct InstallStartOut {
    /// Where to send the admin: the install page, carrying a state that works once, for 10 minutes.
    pub url: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GitHubClaimBody {
    /// From GitHub's redirect after the install.
    pub code: String,
    pub installation_id: u64,
    pub state: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GitHubInstallationOut {
    pub installation_id: u64,
    pub claimed_by: String,
    pub claimed_at: String,
}

impl From<GitHubInstallation> for GitHubInstallationOut {
    fn from(i: GitHubInstallation) -> Self {
        Self {
            installation_id: i.installation,
            claimed_by: i.claimed_by.to_string(),
            claimed_at: ts(i.claimed_at),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RepositoryLinkBody {
    /// One of the organisation's installations, which the repository is in.
    pub installation_id: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct GitHubRepositoryOut {
    pub installation_id: u64,
    pub repository_id: u64,
    /// `owner/name`, as GitHub had it when linked.
    pub full_name: String,
    pub linked_by: String,
    pub linked_at: String,
}

impl From<GitHubRepository> for GitHubRepositoryOut {
    fn from(r: GitHubRepository) -> Self {
        Self {
            installation_id: r.installation,
            repository_id: r.repository,
            full_name: r.full_name.as_str().to_owned(),
            linked_by: r.linked_by.to_string(),
            linked_at: ts(r.linked_at),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SlackClaimBody {
    /// From Slack's redirect after the install.
    pub code: String,
    pub state: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SlackInstallationOut {
    pub team_id: String,
    pub installed_by: String,
    pub installed_at: String,
}

impl From<SlackInstallation> for SlackInstallationOut {
    fn from(i: SlackInstallation) -> Self {
        Self {
            team_id: i.team.as_str().to_owned(),
            installed_by: i.installed_by.to_string(),
            installed_at: ts(i.installed_at),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SlackChannelOut {
    pub id: String,
    pub name: String,
    /// Whether the bot is in the channel; only such a channel can be linked (`/invite` the bot).
    pub is_member: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SlackChannelBody {
    /// A public channel of the organisation's workspace, from `GET /v1/slack/channels`.
    pub channel_id: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CompanySlackOut {
    /// The organisation's Slack workspace.
    pub team_id: String,
    pub channel_id: String,
    /// The channel's name as Slack had it when linked.
    pub channel_name: String,
    pub linked_by: String,
    pub linked_at: String,
}

impl From<SlackChannel> for CompanySlackOut {
    fn from(c: SlackChannel) -> Self {
        Self {
            team_id: c.team.as_str().to_owned(),
            channel_id: c.channel.as_str().to_owned(),
            channel_name: c.name,
            linked_by: c.linked_by.to_string(),
            linked_at: ts(c.linked_at),
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn header<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

fn github_error(e: GitHubError) -> ApiError {
    match e {
        GitHubError::Refused => ApiError::Invalid("code"),
        e => {
            tracing::warn!(error = %e, "GitHub call failed");
            ApiError::Unavailable
        }
    }
}

fn slack_error(e: SlackError) -> ApiError {
    match e {
        SlackError::Refused(code) if code == "invalid_code" || code == "code_already_used" => ApiError::Invalid("code"),
        e => {
            tracing::warn!(error = %e, "Slack call failed");
            ApiError::Unavailable
        }
    }
}

/// Starting an install is the organisation admins' alone.
async fn require_admin(app: &App, who: &Principal) -> Result<(), ApiError> {
    app.require(who, workspace(&who.tenant), "manage").await
}

/// A state is good only if this service signed it for this kind of install, for the caller in
/// the caller's organisation, it has not expired, and it is used here for the first time.
async fn spend_state(app: &App, who: &Principal, key: &StateKey, kind: InstallKind, raw: &str) -> Result<(), ApiError> {
    let s: InstallState =
        state::verify(key, kind, raw, OffsetDateTime::now_utc()).map_err(|_| ApiError::Invalid("state"))?;
    if s.tenant != who.tenant.as_str() || s.user != who.user.as_str() {
        return Err(ApiError::Invalid("state"));
    }
    let mut tx = app.store.organisation(&who.tenant).await?;
    if !tx.use_install_state(&s.id).await? {
        return Err(ApiError::Invalid("state"));
    }
    tx.commit().await?;
    Ok(())
}

fn issue(key: &StateKey, kind: InstallKind, who: &Principal) -> Result<String, ApiError> {
    state::issue(
        key,
        kind,
        who.tenant.as_str(),
        who.user.as_str(),
        OffsetDateTime::now_utc(),
    )
    .ok_or(ApiError::Internal)
}

/// Start installing the GitHub App for the organisation. Needs `manage` on the workspace.
#[utoipa::path(post, operation_id = "start_github_install", path = "/v1/github/install", tag = "integrations",
    responses((status = 200, body = InstallStartOut), (status = 403, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn start_github_install(
    State(app): State<Arc<App>>,
    who: Principal,
) -> Result<Json<InstallStartOut>, ApiError> {
    let gh = github(&app)?;
    require_admin(&app, &who).await?;
    let state = issue(&gh.state, InstallKind::GitHub, &who)?;
    Ok(Json(InstallStartOut {
        url: gh.api.install_url(&state),
    }))
}

/// Claim the installation GitHub's redirect names, with its one-time code and the install's state.
/// The installation must be one the user can reach on GitHub; another organisation's claim gives
/// 409 and is never moved.
#[utoipa::path(post, operation_id = "claim_github_installation", path = "/v1/github/installations",
    tag = "integrations", request_body = GitHubClaimBody,
    responses((status = 200, body = GitHubInstallationOut), (status = 400, body = ErrorBody),
        (status = 403, body = ErrorBody), (status = 409, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn claim_github_installation(
    State(app): State<Arc<App>>,
    who: Principal,
    Json(body): Json<GitHubClaimBody>,
) -> Result<Json<GitHubInstallationOut>, ApiError> {
    let gh = github(&app)?;
    require_admin(&app, &who).await?;
    spend_state(&app, &who, &gh.state, InstallKind::GitHub, &body.state).await?;
    if body.code.is_empty() || body.code.len() > 256 {
        return Err(ApiError::Invalid("code"));
    }
    let reachable = gh.api.user_installations(&body.code).await.map_err(github_error)?;
    if !reachable.contains(&body.installation_id) {
        return Err(ApiError::Forbidden);
    }
    let mut tx = app.store.organisation(&who.tenant).await?;
    match tx.claim_github_installation(body.installation_id, &who.actor()).await? {
        Claimed::Taken => return Err(ApiError::Rejected("installation_claimed")),
        Claimed::Claimed | Claimed::Already => {}
    }
    let claimed = tx
        .github_installations()
        .await?
        .into_iter()
        .find(|i| i.installation == body.installation_id)
        .ok_or(ApiError::Internal)?;
    tx.commit().await?;
    Ok(Json(claimed.into()))
}

/// The organisation's GitHub App installations.
#[utoipa::path(get, operation_id = "list_github_installations", path = "/v1/github/installations",
    tag = "integrations",
    responses((status = 200, body = [GitHubInstallationOut]), (status = 403, body = ErrorBody)))]
pub(crate) async fn github_installations(
    State(app): State<Arc<App>>,
    who: Principal,
) -> Result<Json<Vec<GitHubInstallationOut>>, ApiError> {
    app.require(&who, workspace(&who.tenant), "access").await?;
    let mut tx = app.store.organisation(&who.tenant).await?;
    let list = tx.github_installations().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// The project's linked repositories.
#[utoipa::path(get, operation_id = "list_github_repositories",
    path = "/v1/companies/{company}/projects/{project}/github/repositories", tag = "integrations",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [GitHubRepositoryOut]), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn github_repositories(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<GitHubRepositoryOut>>, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    let list = tx.github_repositories().await?;
    tx.commit().await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

/// Link a repository to the project: it must be in one of the organisation's installations, as
/// GitHub confirms. A repository links to one project only.
#[utoipa::path(put, operation_id = "link_github_repository",
    path = "/v1/companies/{company}/projects/{project}/github/repositories/{repository}", tag = "integrations",
    request_body = RepositoryLinkBody,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("repository" = u64, Path, description = "GitHub's repository id")),
    responses((status = 200, body = GitHubRepositoryOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn link_github_repository(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, repository)): Path<(CompanyId, ProjectId, u64)>,
    Json(body): Json<RepositoryLinkBody>,
) -> Result<Json<GitHubRepositoryOut>, ApiError> {
    let gh = github(&app)?;
    let tx = project_tx(&app, &who, c.clone(), p.clone()).await?;
    drop(tx);
    // The App asks GitHub only about the organisation's own installations, so it never tells one
    // organisation what is in another's.
    let mut org = app.store.organisation(&who.tenant).await?;
    let ours = org
        .github_installations()
        .await?
        .iter()
        .any(|i| i.installation == body.installation_id);
    org.commit().await?;
    if !ours {
        return Err(ApiError::Invalid("installation"));
    }
    // Membership, as the installation lists it: a public repository outside it is refused.
    let name = gh
        .api
        .installation_repositories(body.installation_id)
        .await
        .map_err(github_error)?
        .remove(&repository)
        .ok_or(ApiError::NotFound)?;
    let name = RepositoryName::new(&name).ok_or(ApiError::Unavailable)?;
    let mut tx = project_tx(&app, &who, c, p).await?;
    let linked = tx
        .link_github_repository(body.installation_id, repository, &name, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(linked.into()))
}

/// Unlink a repository from the project.
#[utoipa::path(delete, operation_id = "unlink_github_repository",
    path = "/v1/companies/{company}/projects/{project}/github/repositories/{repository}", tag = "integrations",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("repository" = u64, Path, description = "GitHub's repository id")),
    responses((status = 204, description = "Unlinked"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn unlink_github_repository(
    State(app): State<Arc<App>>,
    who: Principal,
    Path((c, p, repository)): Path<(CompanyId, ProjectId, u64)>,
) -> Result<StatusCode, ApiError> {
    let mut tx = project_tx(&app, &who, c, p).await?;
    if !tx.unlink_github_repository(repository, &who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// GitHub's webhook deliveries for our App. No sign-in: a delivery is used only if it is signed
/// with the webhook secret. A pull request opened or merged in a linked repository becomes an FDE
/// event, once; one older than an hour, or whose body or delivery id was seen before, is refused or
/// changes nothing. An installation deleted or suspended is unclaimed, and repositories removed
/// from one are unlinked, once GitHub confirms it.
#[utoipa::path(post, operation_id = "github_webhook", path = "/webhooks/github", tag = "integrations",
    security(()), request_body(content = String, description = "GitHub's JSON delivery, signed"),
    responses((status = 202, description = "Accepted (acted on or dropped)"), (status = 400, body = ErrorBody),
        (status = 401, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn github_webhook(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let gh = github(&app)?;
    github::verify(&gh.webhook, &body, header(&headers, "x-hub-signature-256")).map_err(|_| ApiError::Unauthorized)?;
    let event = header(&headers, "x-github-event");
    let delivery = header(&headers, "x-github-delivery");
    match github::pull_request(event, delivery, &body, OffsetDateTime::now_utc()) {
        Ok(Some(pr)) => {
            let Some(scope) = app.store.github_route(pr.installation, pr.repository).await? else {
                return Ok(StatusCode::ACCEPTED);
            };
            let mut tx = app.store.project(&scope).await?;
            let merged = pr.action == PullRequestAction::Merged;
            let recorded = tx
                .record_pull_request(pr.delivery.as_str(), &sha256_hex(&body), pr.number, merged)
                .await?;
            tx.commit().await?;
            if !recorded {
                tracing::info!(delivery = pr.delivery.as_str(), "GitHub delivery seen before; ignored");
            }
            return Ok(StatusCode::ACCEPTED);
        }
        Ok(None) => {}
        Err(github::WebhookError::Stale) => return Err(ApiError::Invalid("stale")),
        Err(_) => return Err(ApiError::Invalid("delivery")),
    }
    let delivery = delivery
        .and_then(github::DeliveryId::new)
        .ok_or(ApiError::Invalid("delivery"))?;
    match github::installation_change(event, &body).map_err(|_| ApiError::Invalid("delivery"))? {
        Some(InstallationChange::Removed { installation }) => {
            // Acted on only if GitHub agrees, so a replayed delivery changes nothing GitHub has not.
            if gh.api.installation_active(installation).await.map_err(github_error)? {
                return Ok(StatusCode::ACCEPTED);
            }
            if let Some(tenant) = app.store.github_installation_tenant(installation).await? {
                let mut tx = app.store.organisation(&tenant).await?;
                let by = oryxa_fde_store::Actor {
                    user: oryxa_core::UserId::new("github_webhook").map_err(|_| ApiError::Internal)?,
                    request_id: delivery.as_str().to_owned(),
                };
                tx.unclaim_github_installation(installation, &by).await?;
                tx.commit().await?;
            }
        }
        Some(InstallationChange::RepositoriesRemoved {
            installation,
            repositories,
        }) => {
            let mut linked = Vec::new();
            for repository in repositories.into_iter().take(MAX_REMOVED) {
                if let Some(scope) = app.store.github_route(installation, repository).await? {
                    linked.push((repository, scope));
                }
            }
            if linked.is_empty() {
                return Ok(StatusCode::ACCEPTED);
            }
            // One listing (one installation token) for the whole delivery; only a repository GitHub
            // no longer lists in the installation is unlinked.
            let still = gh
                .api
                .installation_repositories(installation)
                .await
                .map_err(github_error)?;
            for (repository, scope) in linked {
                if still.contains_key(&repository) {
                    continue;
                }
                let mut tx = app.store.project(&scope).await?;
                tx.unlink_removed_repository(repository, delivery.as_str()).await?;
                tx.commit().await?;
            }
        }
        None => {}
    }
    Ok(StatusCode::ACCEPTED)
}

/// Start installing the Slack app into the organisation's workspace. Needs `manage` on the
/// workspace.
#[utoipa::path(post, operation_id = "start_slack_install", path = "/v1/slack/install", tag = "integrations",
    responses((status = 200, body = InstallStartOut), (status = 403, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn start_slack_install(
    State(app): State<Arc<App>>,
    who: Principal,
) -> Result<Json<InstallStartOut>, ApiError> {
    let sl = slack(&app)?;
    require_admin(&app, &who).await?;
    let state = issue(&sl.state, InstallKind::Slack, &who)?;
    Ok(Json(InstallStartOut {
        url: sl.api.authorize_url(&state),
    }))
}

/// Finish the Slack install with Slack's one-time code and the install's state. The bot token goes
/// to Secrets Manager; a workspace installed before is replaced. A workspace is one organisation's:
/// another's gets 409 `rejected_slack_team_claimed` and nothing is stored.
#[utoipa::path(post, operation_id = "claim_slack_installation", path = "/v1/slack/installation", tag = "integrations",
    request_body = SlackClaimBody,
    responses((status = 200, body = SlackInstallationOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 409, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn claim_slack_installation(
    State(app): State<Arc<App>>,
    who: Principal,
    Json(body): Json<SlackClaimBody>,
) -> Result<Json<SlackInstallationOut>, ApiError> {
    let sl = slack(&app)?;
    require_admin(&app, &who).await?;
    spend_state(&app, &who, &sl.state, InstallKind::Slack, &body.state).await?;
    if body.code.is_empty() || body.code.len() > 256 {
        return Err(ApiError::Invalid("code"));
    }
    let (team, token) = sl.api.exchange(&body.code).await.map_err(slack_error)?;
    let team = SlackTeamId::new(team.as_str()).ok_or(ApiError::Unavailable)?;
    // The team's claim is checked under its lock, held to commit, before any token is stored; a
    // token for another organisation's team is dropped, never revoked (it is theirs too).
    let mut tx = app.store.organisation(&who.tenant).await?;
    tx.lock_slack_team(&team).await?;
    if app
        .store
        .slack_team_tenant(&team)
        .await?
        .is_some_and(|owner| owner != who.tenant)
    {
        return Err(ApiError::Rejected("slack_team_claimed"));
    }
    let arn = sl.secrets.put(who.tenant.as_str(), &token).await.map_err(|e| {
        tracing::warn!(error = %e, "Slack token not stored");
        ApiError::Unavailable
    })?;
    drop(token);
    let replaced = tx.set_slack_installation(&team, &arn, &who.actor()).await?;
    let installed = tx.slack_installation().await?.ok_or(ApiError::Internal)?;
    tx.commit().await?;
    if let Some(old) = replaced
        && let Err(e) = sl.secrets.delete(&old).await
    {
        tracing::warn!(error = %e, "replaced Slack token not deleted");
    }
    Ok(Json(installed.into()))
}

/// The organisation's Slack workspace, if installed.
#[utoipa::path(get, operation_id = "get_slack_installation", path = "/v1/slack/installation", tag = "integrations",
    responses((status = 200, body = Option<SlackInstallationOut>), (status = 403, body = ErrorBody)))]
pub(crate) async fn slack_installation(
    State(app): State<Arc<App>>,
    who: Principal,
) -> Result<Json<Option<SlackInstallationOut>>, ApiError> {
    app.require(&who, workspace(&who.tenant), "access").await?;
    let mut tx = app.store.organisation(&who.tenant).await?;
    let found = tx.slack_installation().await?;
    tx.commit().await?;
    Ok(Json(found.map(Into::into)))
}

/// Forget the organisation's Slack workspace: its channel links go and its token is deleted.
#[utoipa::path(delete, operation_id = "remove_slack_installation", path = "/v1/slack/installation",
    tag = "integrations",
    responses((status = 204, description = "Removed"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn remove_slack_installation(
    State(app): State<Arc<App>>,
    who: Principal,
) -> Result<StatusCode, ApiError> {
    require_admin(&app, &who).await?;
    let mut tx = app.store.organisation(&who.tenant).await?;
    let arn = tx
        .remove_slack_installation(&who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    if let Ok(sl) = slack(&app)
        && let Err(e) = sl.secrets.delete(&arn).await
    {
        tracing::warn!(error = %e, "Slack token not deleted");
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The bot token of the organisation's workspace, for one call.
async fn bot_token(app: &App, sl: &SlackIntegration, who: &Principal) -> Result<slack::BotToken, ApiError> {
    let mut tx = app.store.organisation(&who.tenant).await?;
    let installed = tx.slack_installation().await?.ok_or(ApiError::Invalid("slack"))?;
    tx.commit().await?;
    sl.secrets.get(&installed.secret_arn).await.map_err(|e| {
        tracing::warn!(error = %e, "Slack token not read");
        ApiError::Unavailable
    })
}

/// The public channels of the organisation's workspace, to choose a company's from.
#[utoipa::path(get, operation_id = "list_slack_channels", path = "/v1/slack/channels", tag = "integrations",
    responses((status = 200, body = [SlackChannelOut]), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn slack_channels(
    State(app): State<Arc<App>>,
    who: Principal,
) -> Result<Json<Vec<SlackChannelOut>>, ApiError> {
    let sl = slack(&app)?;
    app.require(&who, workspace(&who.tenant), "access").await?;
    let token = bot_token(&app, sl, &who).await?;
    let channels = sl.api.channels(&token).await.map_err(slack_error)?;
    Ok(Json(
        channels
            .into_iter()
            .map(|c| SlackChannelOut {
                id: c.id.as_str().to_owned(),
                name: c.name,
                is_member: c.is_member,
            })
            .collect(),
    ))
}

/// The company's Slack channel, if linked.
#[utoipa::path(get, operation_id = "get_company_slack", path = "/v1/companies/{company}/slack", tag = "integrations",
    params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = Option<CompanySlackOut>), (status = 403, body = ErrorBody)))]
pub(crate) async fn company_slack(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
) -> Result<Json<Option<CompanySlackOut>>, ApiError> {
    let s = who.company(c);
    app.require(&who, company(&s), "work").await?;
    let mut tx = app.store.company(&s).await?;
    let found = tx.slack_channel().await?;
    tx.commit().await?;
    Ok(Json(found.map(Into::into)))
}

/// Link the channel the company's approved updates are posted to. Needs `manage` on the company;
/// the channel must be a public channel of the organisation's workspace, with the bot in it
/// (otherwise 400 `bot_not_in_channel`: `/invite` the bot first).
#[utoipa::path(put, operation_id = "link_company_slack", path = "/v1/companies/{company}/slack", tag = "integrations",
    request_body = SlackChannelBody, params(("company" = String, Path, description = "Company id")),
    responses((status = 200, body = CompanySlackOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn link_company_slack(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
    Json(body): Json<SlackChannelBody>,
) -> Result<Json<CompanySlackOut>, ApiError> {
    let sl = slack(&app)?;
    let s = who.company(c);
    app.require(&who, company(&s), "manage").await?;
    let wanted = ChannelId::new(&body.channel_id).ok_or(ApiError::Invalid("channel"))?;
    let token = bot_token(&app, sl, &who).await?;
    let channels = sl.api.channels(&token).await.map_err(slack_error)?;
    let found = channels
        .iter()
        .find(|ch| ch.id == wanted)
        .ok_or(ApiError::Invalid("channel"))?;
    // Slack refuses a post where the bot isn't, for good, so every update would go unposted.
    if !found.is_member {
        return Err(ApiError::NeedsAction("bot_not_in_channel"));
    }
    let channel = SlackChannelId::new(wanted.as_str()).ok_or(ApiError::Invalid("channel"))?;
    let mut tx = app.store.company(&s).await?;
    let linked = tx
        .set_slack_channel(&channel, &found.name, &who.actor())
        .await?
        .ok_or(ApiError::NotFound)?;
    tx.commit().await?;
    Ok(Json(linked.into()))
}

/// Unlink the company's channel. Needs `manage` on the company.
#[utoipa::path(delete, operation_id = "unlink_company_slack", path = "/v1/companies/{company}/slack",
    tag = "integrations", params(("company" = String, Path, description = "Company id")),
    responses((status = 204, description = "Unlinked"), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub(crate) async fn unlink_company_slack(
    State(app): State<Arc<App>>,
    who: Principal,
    Path(c): Path<CompanyId>,
) -> Result<StatusCode, ApiError> {
    let s = who.company(c);
    app.require(&who, company(&s), "manage").await?;
    let mut tx = app.store.company(&s).await?;
    if !tx.unlink_slack_channel(&who.actor()).await? {
        return Err(ApiError::NotFound);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SlackChallengeOut {
    pub challenge: String,
}

/// Slack's Events API. No sign-in: a request is used only if it is signed with our signing secret
/// within the last five minutes. The app uninstalled or its tokens revoked forgets the workspace,
/// its channel links and its token; every other event is acknowledged and dropped.
#[utoipa::path(post, operation_id = "slack_webhook", path = "/webhooks/slack", tag = "integrations",
    security(()), request_body(content = String, description = "Slack's JSON event, signed"),
    responses((status = 200, body = Option<SlackChallengeOut>), (status = 400, body = ErrorBody),
        (status = 401, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn slack_webhook(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Option<SlackChallengeOut>>, ApiError> {
    let sl = slack(&app)?;
    slack::verify(
        &sl.signing,
        header(&headers, "x-slack-request-timestamp"),
        header(&headers, "x-slack-signature"),
        &body,
        OffsetDateTime::now_utc(),
    )
    .map_err(|e| match e {
        slack::SlackRequestError::Stale => ApiError::Invalid("stale"),
        _ => ApiError::Unauthorized,
    })?;
    match slack::event(&body).map_err(|_| ApiError::Invalid("event"))? {
        SlackEvent::Challenge(challenge) => Ok(Json(Some(SlackChallengeOut { challenge }))),
        SlackEvent::Uninstalled(team) => {
            let team = SlackTeamId::new(team.as_str()).ok_or(ApiError::Invalid("event"))?;
            let event = sha256_hex(&body);
            if let Some(tenant) = app.store.slack_team_tenant(&team).await? {
                let mut tx = app.store.organisation(&tenant).await?;
                let arn = tx.remove_slack_team(&team, &event[..32]).await?;
                tx.commit().await?;
                if let Some(arn) = arn
                    && let Err(e) = sl.secrets.delete(&arn).await
                {
                    tracing::warn!(error = %e, "uninstalled Slack token not deleted");
                }
            }
            Ok(Json(None))
        }
        SlackEvent::Other => Ok(Json(None)),
    }
}
