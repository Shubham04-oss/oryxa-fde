//! Fakes of GitHub, Slack and Secrets Manager for tests (`testing` feature; never in a release
//! build). Each keeps what it was told and answers from it.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::github_api::{BoxFuture, GitHub, GitHubError};
use crate::secrets::{Secrets, SecretsError};
use crate::slack::{BotToken, Channel, ChannelId, Slack, SlackError, TeamId};

/// GitHub as the tests set it up.
#[derive(Default)]
pub struct FakeGitHub {
    /// The installations each one-time code's user can reach.
    pub codes: Mutex<HashMap<String, Vec<u64>>>,
    /// The repositories in each installation, by `(installation, repository)`.
    pub repositories: Mutex<HashMap<(u64, u64), String>>,
    /// Installations deleted or suspended on GitHub.
    pub gone: Mutex<Vec<u64>>,
    /// How many times an installation's repositories were listed (each one installation token).
    pub listings: Mutex<u32>,
}

impl GitHub for FakeGitHub {
    fn install_url(&self, state: &str) -> String {
        format!("https://github.test/apps/oryxa-fde/installations/new?state={state}")
    }

    fn user_installations<'a>(&'a self, code: &'a str) -> BoxFuture<'a, Result<Vec<u64>, GitHubError>> {
        // A code works once, as GitHub's do.
        let found = self.codes.lock().unwrap_or_else(|e| e.into_inner()).remove(code);
        Box::pin(async move { found.ok_or(GitHubError::Refused) })
    }

    fn installation_repositories<'a>(
        &'a self,
        installation: u64,
    ) -> BoxFuture<'a, Result<HashMap<u64, String>, GitHubError>> {
        *self.listings.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        let found = self
            .repositories
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|((i, _), _)| *i == installation)
            .map(|((_, r), name)| (*r, name.clone()))
            .collect();
        Box::pin(async move { Ok(found) })
    }

    fn installation_active<'a>(&'a self, installation: u64) -> BoxFuture<'a, Result<bool, GitHubError>> {
        let gone = self
            .gone
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&installation);
        Box::pin(async move { Ok(!gone) })
    }
}

/// How the fake Slack answers a post.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PostMode {
    #[default]
    Accept,
    /// Fails in a way that may pass (Slack unreachable, rate limited).
    Unavailable,
    /// Refuses for good (`channel_not_found`).
    Refuse,
}

/// Slack as the tests set it up.
#[derive(Default)]
pub struct FakeSlack {
    /// The team and token each one-time code grants.
    pub codes: Mutex<HashMap<String, (TeamId, BotToken)>>,
    pub channels: Mutex<Vec<Channel>>,
    /// Every post accepted: the token used, the channel and the text as sent.
    pub posts: Mutex<Vec<(String, String, String)>>,
    pub mode: Mutex<PostMode>,
}

impl Slack for FakeSlack {
    fn authorize_url(&self, state: &str) -> String {
        format!("https://slack.test/oauth/v2/authorize?state={state}")
    }

    fn exchange<'a>(&'a self, code: &'a str) -> BoxFuture<'a, Result<(TeamId, BotToken), SlackError>> {
        let found = self.codes.lock().unwrap_or_else(|e| e.into_inner()).remove(code);
        Box::pin(async move { found.ok_or_else(|| SlackError::Refused("invalid_code".into())) })
    }

    fn channels<'a>(&'a self, _token: &'a BotToken) -> BoxFuture<'a, Result<Vec<Channel>, SlackError>> {
        let list = self.channels.lock().unwrap_or_else(|e| e.into_inner()).clone();
        Box::pin(async move { Ok(list) })
    }

    fn post<'a>(
        &'a self,
        token: &'a BotToken,
        channel: &'a ChannelId,
        text: &'a str,
    ) -> BoxFuture<'a, Result<(), SlackError>> {
        let mode = *self.mode.lock().unwrap_or_else(|e| e.into_inner());
        let sent = match mode {
            PostMode::Accept => {
                self.posts.lock().unwrap_or_else(|e| e.into_inner()).push((
                    token.expose().to_owned(),
                    channel.as_str().to_owned(),
                    crate::slack::plain(text),
                ));
                Ok(())
            }
            PostMode::Unavailable => Err(SlackError::Status(503)),
            PostMode::Refuse => Err(SlackError::Refused("channel_not_found".into())),
        };
        Box::pin(async move { sent })
    }
}

/// Secrets Manager in memory, under the ARNs it makes up.
#[derive(Default)]
pub struct FakeSecrets {
    pub secrets: Mutex<HashMap<String, BotToken>>,
    pub deleted: Mutex<Vec<String>>,
}

impl FakeSecrets {
    pub fn arn(tenant: &str) -> String {
        format!("arn:aws:secretsmanager:eu-west-2:000000000000:secret:oryxa-fde/test/slack/{tenant}")
    }
}

impl Secrets for FakeSecrets {
    fn put<'a>(&'a self, tenant: &'a str, token: &'a BotToken) -> BoxFuture<'a, Result<String, SecretsError>> {
        let arn = Self::arn(tenant);
        self.secrets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(arn.clone(), token.clone());
        Box::pin(async move { Ok(arn) })
    }

    fn get<'a>(&'a self, arn: &'a str) -> BoxFuture<'a, Result<BotToken, SecretsError>> {
        let found = self.secrets.lock().unwrap_or_else(|e| e.into_inner()).get(arn).cloned();
        Box::pin(async move { found.ok_or_else(|| SecretsError::Aws("ResourceNotFoundException".into())) })
    }

    fn delete<'a>(&'a self, arn: &'a str) -> BoxFuture<'a, Result<(), SecretsError>> {
        self.secrets.lock().unwrap_or_else(|e| e.into_inner()).remove(arn);
        self.deleted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(arn.to_owned());
        Box::pin(async { Ok(()) })
    }
}
