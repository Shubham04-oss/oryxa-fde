//! GitHub and Slack links (#22). An organisation claims GitHub App installations and its one Slack
//! workspace; a project links repositories of its claims; a company links a Slack channel. A webhook
//! names no tenant, so it is routed through the reconciler's role, which reads only the routing keys
//! ([`Store::github_route`] and friends); every change is then made under the tenant's or project's
//! own scope.

use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId, ProjectScope};
use oryxa_fde_events::{PullRequestMerged, PullRequestOpened};
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::{Date, OffsetDateTime};

use crate::{
    Actor, CompanyTx, OrgTx, ProjectTx, Store, StoreError, UpdateBody, audit, enqueue, id, unique_violation,
    week_bounds,
};

/// A Slack id (team `T…`, channel `C…`): upper-case letters and digits, as Slack issues them.
fn slack_id(raw: &str) -> bool {
    (1..=32).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SlackTeamId(String);

impl SlackTeamId {
    pub fn new(raw: &str) -> Option<Self> {
        slack_id(raw).then(|| Self(raw.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SlackChannelId(String);

impl SlackChannelId {
    pub fn new(raw: &str) -> Option<Self> {
        slack_id(raw).then(|| Self(raw.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A repository's `owner/name` as GitHub gives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryName(String);

impl RepositoryName {
    pub fn new(raw: &str) -> Option<Self> {
        let part = |p: &str| {
            (1..=100).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        };
        let (owner, name) = raw.split_once('/')?;
        (part(owner) && part(name)).then(|| Self(raw.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// GitHub's numeric ids, positive and within Postgres's `bigint`.
fn github_id(n: u64) -> Result<i64, StoreError> {
    i64::try_from(n)
        .ok()
        .filter(|n| *n > 0)
        .ok_or(StoreError::Rejected("github_id"))
}

fn github_u64(n: i64) -> Result<u64, StoreError> {
    u64::try_from(n).map_err(|_| StoreError::Corrupt("github id"))
}

/// What claiming an installation did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claimed {
    /// Now this organisation's.
    Claimed,
    /// It was already this organisation's.
    Already,
    /// Another organisation's: never moved.
    Taken,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubInstallation {
    pub installation: u64,
    pub claimed_by: UserId,
    pub claimed_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubRepository {
    pub installation: u64,
    pub repository: u64,
    pub full_name: RepositoryName,
    pub linked_by: UserId,
    pub linked_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlackInstallation {
    pub team: SlackTeamId,
    /// The Secrets Manager secret that holds the bot token; never the token.
    pub secret_arn: String,
    pub installed_by: UserId,
    pub installed_at: OffsetDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlackChannel {
    pub channel: SlackChannelId,
    /// As Slack had it when linked.
    pub name: String,
    /// The organisation's workspace.
    pub team: SlackTeamId,
    pub linked_by: UserId,
    pub linked_at: OffsetDateTime,
}

/// An approved update to post, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlackPost {
    pub channel: SlackChannelId,
    pub secret_arn: String,
    pub body: UpdateBody,
}

/// Who changes made for a webhook are recorded as.
fn webhook_actor(source: &str, delivery: &str) -> Result<Actor, StoreError> {
    Ok(Actor {
        user: UserId::new(source).map_err(|_| StoreError::Corrupt("webhook actor"))?,
        request_id: delivery.to_owned(),
    })
}

fn user(r: &PgRow, col: &str) -> Result<UserId, StoreError> {
    id("user id", UserId::new, r.try_get(col)?)
}

impl OrgTx {
    /// Records an install state's id as used; `false` if it was used before.
    pub async fn use_install_state(&mut self, state_id: &str) -> Result<bool, StoreError> {
        let ok = state_id.len() == 32
            && state_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !ok {
            return Ok(false);
        }
        let n = sqlx::query("insert into install_states (state_id, tenant_id) values ($1, $2) on conflict do nothing")
            .bind(state_id)
            .bind(self.tenant.as_str())
            .execute(&mut *self.tx)
            .await?
            .rows_affected();
        Ok(n == 1)
    }

    /// Claims an installation the caller proved access to. Another organisation's claim stands.
    pub async fn claim_github_installation(&mut self, installation: u64, by: &Actor) -> Result<Claimed, StoreError> {
        let n = github_id(installation)?;
        let inserted = sqlx::query(
            "insert into github_installations (installation_id, tenant_id, claimed_by) values ($1, $2, $3)
             on conflict (installation_id) do nothing",
        )
        .bind(n)
        .bind(self.tenant.as_str())
        .bind(by.user.as_str())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if inserted == 1 {
            self.audit(by, "github.installation_claimed", &installation.to_string())
                .await?;
            return Ok(Claimed::Claimed);
        }
        // Row-level security shows this organisation's claims only.
        let ours: bool =
            sqlx::query_scalar("select exists (select 1 from github_installations where installation_id = $1)")
                .bind(n)
                .fetch_one(&mut *self.tx)
                .await?;
        Ok(if ours { Claimed::Already } else { Claimed::Taken })
    }

    pub async fn github_installations(&mut self) -> Result<Vec<GitHubInstallation>, StoreError> {
        sqlx::query(
            "select installation_id, claimed_by, claimed_at from github_installations where tenant_id = $1
             order by claimed_at, installation_id",
        )
        .bind(self.tenant.as_str())
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(|r| {
            Ok(GitHubInstallation {
                installation: github_u64(r.try_get("installation_id")?)?,
                claimed_by: user(&r, "claimed_by")?,
                claimed_at: r.try_get("claimed_at")?,
            })
        })
        .collect()
    }

    /// Unclaims an installation, which unlinks its repositories; `false` if it was not claimed here.
    pub async fn unclaim_github_installation(&mut self, installation: u64, by: &Actor) -> Result<bool, StoreError> {
        let n = sqlx::query("delete from github_installations where tenant_id = $1 and installation_id = $2")
            .bind(self.tenant.as_str())
            .bind(github_id(installation)?)
            .execute(&mut *self.tx)
            .await?
            .rows_affected();
        if n == 1 {
            self.audit(by, "github.installation_unclaimed", &installation.to_string())
                .await?;
        }
        Ok(n == 1)
    }

    pub async fn slack_installation(&mut self) -> Result<Option<SlackInstallation>, StoreError> {
        sqlx::query(
            "select team_id, secret_arn, installed_by, installed_at from slack_installations where tenant_id = $1",
        )
        .bind(self.tenant.as_str())
        .fetch_optional(&mut *self.tx)
        .await?
        .map(|r| slack_installation(&r))
        .transpose()
    }

    /// Holds `team`'s claim lock, across tenants, until this transaction ends: two organisations
    /// installing the same workspace at once are told apart before either stores a token.
    pub async fn lock_slack_team(&mut self, team: &SlackTeamId) -> Result<(), StoreError> {
        sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("oryxa-fde|slack-team|{}", team.as_str()))
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }

    /// Records the organisation's Slack workspace; returns the secret it replaces, if another. A
    /// team another organisation has is refused (`slack_team_claimed`).
    pub async fn set_slack_installation(
        &mut self,
        team: &SlackTeamId,
        secret_arn: &str,
        by: &Actor,
    ) -> Result<Option<String>, StoreError> {
        let before = self.slack_installation().await?.map(|s| s.secret_arn);
        sqlx::query(
            "insert into slack_installations (tenant_id, team_id, secret_arn, installed_by) values ($1, $2, $3, $4)
             on conflict (tenant_id) do update set team_id = excluded.team_id, secret_arn = excluded.secret_arn,
                 installed_by = excluded.installed_by, installed_at = now()",
        )
        .bind(self.tenant.as_str())
        .bind(team.as_str())
        .bind(secret_arn)
        .bind(by.user.as_str())
        .execute(&mut *self.tx)
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Rejected("slack_team_claimed")
            } else {
                e.into()
            }
        })?;
        self.audit(by, "slack.installed", team.as_str()).await?;
        Ok(before.filter(|arn| arn != secret_arn))
    }

    /// Forgets the organisation's Slack workspace and its channel links; returns the secret to
    /// delete, if there was one.
    pub async fn remove_slack_installation(&mut self, by: &Actor) -> Result<Option<String>, StoreError> {
        let arn: Option<String> =
            sqlx::query_scalar("delete from slack_installations where tenant_id = $1 returning secret_arn")
                .bind(self.tenant.as_str())
                .fetch_optional(&mut *self.tx)
                .await?;
        if arn.is_some() {
            let tenant = self.tenant.to_string();
            self.audit(by, "slack.uninstalled", &tenant).await?;
        }
        Ok(arn)
    }

    /// For a webhook: forgets the workspace if it is `team`'s; returns the secret to delete.
    pub async fn remove_slack_team(&mut self, team: &SlackTeamId, event: &str) -> Result<Option<String>, StoreError> {
        let by = webhook_actor("slack_webhook", event)?;
        let arn: Option<String> = sqlx::query_scalar(
            "delete from slack_installations where tenant_id = $1 and team_id = $2 returning secret_arn",
        )
        .bind(self.tenant.as_str())
        .bind(team.as_str())
        .fetch_optional(&mut *self.tx)
        .await?;
        if arn.is_some() {
            self.audit(&by, "slack.uninstalled", team.as_str()).await?;
        }
        Ok(arn)
    }
}

fn slack_installation(r: &PgRow) -> Result<SlackInstallation, StoreError> {
    Ok(SlackInstallation {
        team: SlackTeamId::new(r.try_get("team_id")?).ok_or(StoreError::Corrupt("slack team"))?,
        secret_arn: r.try_get("secret_arn")?,
        installed_by: user(r, "installed_by")?,
        installed_at: r.try_get("installed_at")?,
    })
}

fn repository_of(r: PgRow) -> Result<GitHubRepository, StoreError> {
    Ok(GitHubRepository {
        installation: github_u64(r.try_get("installation_id")?)?,
        repository: github_u64(r.try_get("repository_id")?)?,
        full_name: RepositoryName::new(r.try_get("full_name")?).ok_or(StoreError::Corrupt("repository name"))?,
        linked_by: user(&r, "linked_by")?,
        linked_at: r.try_get("linked_at")?,
    })
}

const REPOSITORY: &str = "installation_id, repository_id, full_name, linked_by, linked_at";

impl ProjectTx {
    pub async fn github_repositories(&mut self) -> Result<Vec<GitHubRepository>, StoreError> {
        let (t, c, p) = self.keys();
        sqlx::query(&format!(
            "select {REPOSITORY} from github_repositories where tenant_id = $1 and company_id = $2 and project_id = $3
             order by full_name, repository_id"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .fetch_all(&mut *self.tx)
        .await?
        .into_iter()
        .map(repository_of)
        .collect()
    }

    /// Links a repository of one of the organisation's installations, once checked with GitHub.
    /// `None` if the project is not in this company; `Missing("installation")` if this organisation
    /// has not claimed it; `Conflict` if the repository is linked already, to any project.
    pub async fn link_github_repository(
        &mut self,
        installation: u64,
        repository: u64,
        full_name: &RepositoryName,
        by: &Actor,
    ) -> Result<Option<GitHubRepository>, StoreError> {
        let (t, c, p) = self.keys();
        let (i, r) = (github_id(installation)?, github_id(repository)?);
        let claimed: bool = sqlx::query_scalar(
            "select exists (select 1 from github_installations where tenant_id = $1 and installation_id = $2)",
        )
        .bind(&t)
        .bind(i)
        .fetch_one(&mut *self.tx)
        .await?;
        if !claimed {
            return Err(StoreError::Missing("installation"));
        }
        let row = sqlx::query(&format!(
            "insert into github_repositories (tenant_id, company_id, project_id, installation_id, repository_id,
                 full_name, linked_by)
             select $1, $2, $3, $4, $5, $6, $7
             where exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)
             returning {REPOSITORY}"
        ))
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(i)
        .bind(r)
        .bind(full_name.as_str())
        .bind(by.user.as_str())
        .fetch_optional(&mut *self.tx)
        .await
        .map_err(|e| {
            if unique_violation(&e) {
                StoreError::Conflict
            } else {
                e.into()
            }
        })?;
        let Some(row) = row else { return Ok(None) };
        let s = self.scope.clone();
        audit(
            &mut self.tx,
            &s.company,
            Some(&s.project),
            by,
            "github.repository_linked",
            Some(&repository.to_string()),
        )
        .await?;
        repository_of(row).map(Some)
    }

    /// Unlinks a repository from this project; `false` if it was not linked here.
    pub async fn unlink_github_repository(&mut self, repository: u64, by: &Actor) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let n = sqlx::query(
            "delete from github_repositories
             where tenant_id = $1 and company_id = $2 and project_id = $3 and repository_id = $4",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(github_id(repository)?)
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if n > 0 {
            let s = self.scope.clone();
            audit(
                &mut self.tx,
                &s.company,
                Some(&s.project),
                by,
                "github.repository_unlinked",
                Some(&repository.to_string()),
            )
            .await?;
        }
        Ok(n > 0)
    }

    /// For a webhook confirmed with GitHub: unlinks the repository if it is linked here.
    pub async fn unlink_removed_repository(&mut self, repository: u64, delivery: &str) -> Result<bool, StoreError> {
        let by = webhook_actor("github_webhook", delivery)?;
        self.unlink_github_repository(repository, &by).await
    }

    /// Records a pull request delivery and publishes its event, unless its delivery id or the hash
    /// of its signed body was seen before: `false` for a replay, which changes nothing. Deliveries
    /// older than 7 days are dropped as each new one is recorded.
    pub async fn record_pull_request(
        &mut self,
        delivery: &str,
        body_sha256: &str,
        number: u32,
        merged: bool,
    ) -> Result<bool, StoreError> {
        let (t, c, p) = self.keys();
        let by = webhook_actor("github_webhook", delivery)?;
        let n = sqlx::query(
            "insert into github_deliveries (tenant_id, company_id, project_id, delivery_id, body_sha256)
             select $1, $2, $3, $4, $5
             where exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)
             on conflict do nothing",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(delivery)
        .bind(body_sha256)
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Ok(false);
        }
        sqlx::query(
            "delete from github_deliveries where tenant_id = $1 and company_id = $2
                 and received_at < now() - interval '7 days'",
        )
        .bind(&t)
        .bind(&c)
        .execute(&mut *self.tx)
        .await?;
        let s = self.scope.clone();
        if merged {
            enqueue(&mut self.tx, &s.company, &by, &PullRequestMerged::new(&s, number)).await?;
        } else {
            enqueue(&mut self.tx, &s.company, &by, &PullRequestOpened::new(&s, number)).await?;
        }
        Ok(true)
    }

    /// The approved update of the week starting `monday` and where to post it: the company's
    /// channel in the organisation's Slack workspace. `None` if any is missing.
    pub async fn slack_post(&mut self, monday: Date) -> Result<Option<SlackPost>, StoreError> {
        week_bounds(monday)?;
        let (t, c, p) = self.keys();
        let row = sqlx::query(
            "select u.body, ch.channel_id, i.secret_arn
             from update_drafts u
             join slack_channels ch on ch.tenant_id = u.tenant_id and ch.company_id = u.company_id
             join slack_installations i on i.tenant_id = u.tenant_id
             where u.tenant_id = $1 and u.company_id = $2 and u.project_id = $3 and u.week = $4
                 and u.status = 'approved'",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(monday)
        .fetch_optional(&mut *self.tx)
        .await?;
        let Some(r) = row else { return Ok(None) };
        Ok(Some(SlackPost {
            channel: SlackChannelId::new(r.try_get("channel_id")?).ok_or(StoreError::Corrupt("slack channel"))?,
            secret_arn: r.try_get("secret_arn")?,
            body: UpdateBody::new(r.try_get::<String, _>("body")?).map_err(|_| StoreError::Corrupt("update body"))?,
        }))
    }

    /// Claims the post of the week's update; `false` if it is claimed or posted already.
    pub async fn claim_slack_post(&mut self, monday: Date) -> Result<bool, StoreError> {
        week_bounds(monday)?;
        let (t, c, p) = self.keys();
        let n = sqlx::query(
            "insert into slack_posts (tenant_id, company_id, project_id, week) select $1, $2, $3, $4
             where exists (select 1 from projects where tenant_id = $1 and company_id = $2 and project_id = $3)
             on conflict do nothing",
        )
        .bind(&t)
        .bind(&c)
        .bind(&p)
        .bind(monday)
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        Ok(n == 1)
    }

    /// Marks the claimed post as sent (`true`), or releases the claim so it is tried again.
    pub async fn finish_slack_post(&mut self, monday: Date, posted: bool) -> Result<(), StoreError> {
        let (t, c, p) = self.keys();
        let sql = if posted {
            "update slack_posts set posted_at = now()
             where tenant_id = $1 and company_id = $2 and project_id = $3 and week = $4 and posted_at is null"
        } else {
            "delete from slack_posts
             where tenant_id = $1 and company_id = $2 and project_id = $3 and week = $4 and posted_at is null"
        };
        sqlx::query(sql)
            .bind(&t)
            .bind(&c)
            .bind(&p)
            .bind(monday)
            .execute(&mut *self.tx)
            .await?;
        Ok(())
    }
}

impl CompanyTx {
    pub async fn slack_channel(&mut self) -> Result<Option<SlackChannel>, StoreError> {
        sqlx::query(
            "select c.channel_id, c.channel_name, i.team_id, c.linked_by, c.linked_at
             from slack_channels c join slack_installations i on i.tenant_id = c.tenant_id
             where c.tenant_id = $1 and c.company_id = $2",
        )
        .bind(self.scope.tenant.as_str())
        .bind(self.scope.company.as_str())
        .fetch_optional(&mut *self.tx)
        .await?
        .map(|r| {
            Ok(SlackChannel {
                channel: SlackChannelId::new(r.try_get("channel_id")?).ok_or(StoreError::Corrupt("slack channel"))?,
                name: r.try_get("channel_name")?,
                team: SlackTeamId::new(r.try_get("team_id")?).ok_or(StoreError::Corrupt("slack team"))?,
                linked_by: user(&r, "linked_by")?,
                linked_at: r.try_get("linked_at")?,
            })
        })
        .transpose()
    }

    /// Links the channel approved updates are posted to, replacing any. `None` if the company does
    /// not exist; `Missing("slack")` if the organisation has no Slack workspace.
    pub async fn set_slack_channel(
        &mut self,
        channel: &SlackChannelId,
        name: &str,
        by: &Actor,
    ) -> Result<Option<SlackChannel>, StoreError> {
        if !(1..=80).contains(&name.chars().count()) {
            return Err(StoreError::Missing("channel_name"));
        }
        let s = self.scope.clone();
        let installed: bool =
            sqlx::query_scalar("select exists (select 1 from slack_installations where tenant_id = $1)")
                .bind(s.tenant.as_str())
                .fetch_one(&mut *self.tx)
                .await?;
        if !installed {
            return Err(StoreError::Missing("slack"));
        }
        let n = sqlx::query(
            "insert into slack_channels (tenant_id, company_id, channel_id, channel_name, linked_by)
             select $1, $2, $3, $4, $5 where exists (select 1 from companies where tenant_id = $1 and company_id = $2)
             on conflict (tenant_id, company_id) do update
                 set channel_id = excluded.channel_id, channel_name = excluded.channel_name,
                     linked_by = excluded.linked_by, linked_at = now()",
        )
        .bind(s.tenant.as_str())
        .bind(s.company.as_str())
        .bind(channel.as_str())
        .bind(name)
        .bind(by.user.as_str())
        .execute(&mut *self.tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Ok(None);
        }
        audit(
            &mut self.tx,
            &s,
            None,
            by,
            "slack.channel_linked",
            Some(channel.as_str()),
        )
        .await?;
        self.slack_channel().await
    }

    /// Unlinks the company's channel; `false` if it had none.
    pub async fn unlink_slack_channel(&mut self, by: &Actor) -> Result<bool, StoreError> {
        let s = self.scope.clone();
        let n = sqlx::query("delete from slack_channels where tenant_id = $1 and company_id = $2")
            .bind(s.tenant.as_str())
            .bind(s.company.as_str())
            .execute(&mut *self.tx)
            .await?
            .rows_affected();
        if n == 1 {
            audit(&mut self.tx, &s, None, by, "slack.channel_unlinked", None).await?;
        }
        Ok(n == 1)
    }
}

impl Store {
    /// The project a linked repository's deliveries go to, across tenants.
    pub async fn github_route(&self, installation: u64, repository: u64) -> Result<Option<ProjectScope>, StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("set local role oryxa_fde_grants").execute(&mut *tx).await?;
        let row = sqlx::query(
            "select tenant_id, company_id, project_id from github_repositories
             where installation_id = $1 and repository_id = $2",
        )
        .bind(github_id(installation)?)
        .bind(github_id(repository)?)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        row.map(|r| {
            let tenant = id("tenant id", TenantId::new, r.try_get("tenant_id")?)?;
            let company = id("company id", CompanyId::new, r.try_get("company_id")?)?;
            let project = id("project id", ProjectId::new, r.try_get("project_id")?)?;
            Ok(CompanyScope::new(tenant, company).project(project))
        })
        .transpose()
    }

    /// The organisation that claims an installation, across tenants.
    pub async fn github_installation_tenant(&self, installation: u64) -> Result<Option<TenantId>, StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("set local role oryxa_fde_grants").execute(&mut *tx).await?;
        let tenant: Option<String> =
            sqlx::query_scalar("select tenant_id from github_installations where installation_id = $1")
                .bind(github_id(installation)?)
                .fetch_optional(&mut *tx)
                .await?;
        tx.commit().await?;
        tenant.map(|t| id("tenant id", TenantId::new, t)).transpose()
    }

    /// The organisation whose Slack workspace is `team`, across tenants.
    pub async fn slack_team_tenant(&self, team: &SlackTeamId) -> Result<Option<TenantId>, StoreError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("set local role oryxa_fde_grants").execute(&mut *tx).await?;
        let tenant: Option<String> = sqlx::query_scalar("select tenant_id from slack_installations where team_id = $1")
            .bind(team.as_str())
            .fetch_optional(&mut *tx)
            .await?;
        tx.commit().await?;
        tenant.map(|t| id("tenant id", TenantId::new, t)).transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integration_ids_are_checked_before_they_reach_sql() {
        assert!(SlackTeamId::new("T061EG9R6").is_some() && SlackChannelId::new("C0123ABC").is_some());
        for bad in ["", "t061", "T 1", "T1;--", &"T".repeat(33)] {
            assert!(
                SlackTeamId::new(bad).is_none() && SlackChannelId::new(bad).is_none(),
                "{bad}"
            );
        }
        assert_eq!(
            RepositoryName::new("acme/support-rag.v2").unwrap().as_str(),
            "acme/support-rag.v2"
        );
        for bad in ["acme", "acme/", "/rag", "acme/rag/x", "acme/r ag", "acme/<rag>"] {
            assert!(RepositoryName::new(bad).is_none(), "{bad}");
        }
        assert_eq!(github_id(7).unwrap(), 7);
        assert!(github_id(0).is_err() && github_id(u64::MAX).is_err());
    }
}
