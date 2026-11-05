//! Where a tenant's Slack bot token is kept: AWS Secrets Manager, under
//! `oryxa-fde/<env>/slack/<tenant>`, tagged with the tenant and encrypted with the app's KMS key.
//! Tables hold the secret's ARN only. An error is logged by its code, never its message.

use aws_sdk_secretsmanager::error::ProvideErrorMetadata;
use aws_sdk_secretsmanager::types::Tag;

use crate::github_api::BoxFuture;
use crate::slack::BotToken;

#[derive(Debug, thiserror::Error)]
pub enum SecretsError {
    #[error("Secrets Manager: {0}")]
    Aws(String),
    #[error("not a bot token")]
    NotAToken,
}

fn aws<E: ProvideErrorMetadata>(e: &E) -> SecretsError {
    SecretsError::Aws(e.code().unwrap_or("unavailable").to_owned())
}

/// Keeps one bot token per tenant. A trait so tests use a fake.
pub trait Secrets: Send + Sync + 'static {
    /// Stores the tenant's token, replacing any it had; returns the secret's ARN.
    fn put<'a>(&'a self, tenant: &'a str, token: &'a BotToken) -> BoxFuture<'a, Result<String, SecretsError>>;
    fn get<'a>(&'a self, arn: &'a str) -> BoxFuture<'a, Result<BotToken, SecretsError>>;
    /// Deletes at once, with no recovery window: an uninstalled app's token is dead anyway.
    fn delete<'a>(&'a self, arn: &'a str) -> BoxFuture<'a, Result<(), SecretsError>>;
}

pub struct SecretsManager {
    client: aws_sdk_secretsmanager::Client,
    /// `oryxa-fde/<env>/slack/`
    prefix: String,
    /// `None` for a reader, which cannot store.
    kms_key: Option<String>,
}

fn prefix_ok(prefix: &str) -> bool {
    prefix.ends_with('/')
        && prefix.len() > 1
        && prefix.bytes().all(|b| b.is_ascii_alphanumeric() || b"/_-".contains(&b))
}

impl SecretsManager {
    /// Stores, reads and deletes tokens under `prefix`, encrypted with `kms_key`.
    pub fn new(client: aws_sdk_secretsmanager::Client, prefix: &str, kms_key: &str) -> Option<Self> {
        (prefix_ok(prefix) && !kms_key.is_empty()).then(|| Self {
            client,
            prefix: prefix.to_owned(),
            kms_key: Some(kms_key.to_owned()),
        })
    }

    /// Reads tokens under `prefix` only, as the poster does.
    pub fn reader(client: aws_sdk_secretsmanager::Client, prefix: &str) -> Option<Self> {
        prefix_ok(prefix).then(|| Self {
            client,
            prefix: prefix.to_owned(),
            kms_key: None,
        })
    }

    /// An ARN is read or deleted only if it names a secret under the prefix, so a row changed by
    /// mistake or malice cannot point the service at another secret.
    fn ours(&self, arn: &str) -> Result<(), SecretsError> {
        let ok = arn.starts_with("arn:aws:secretsmanager:") && arn.contains(&format!(":secret:{}", self.prefix));
        if ok {
            Ok(())
        } else {
            Err(SecretsError::Aws("not a token secret".into()))
        }
    }
}

impl Secrets for SecretsManager {
    fn put<'a>(&'a self, tenant: &'a str, token: &'a BotToken) -> BoxFuture<'a, Result<String, SecretsError>> {
        Box::pin(async move {
            let kms_key = self
                .kms_key
                .as_deref()
                .ok_or_else(|| SecretsError::Aws("read only".into()))?;
            let name = format!("{}{tenant}", self.prefix);
            let created = self
                .client
                .create_secret()
                .name(&name)
                .kms_key_id(kms_key)
                .secret_string(token.expose())
                .tags(Tag::builder().key("tenant").value(tenant).build())
                .send()
                .await;
            match created {
                Ok(out) => out.arn.ok_or_else(|| SecretsError::Aws("no arn".into())),
                Err(e) if e.code() == Some("ResourceExistsException") => {
                    let out = self
                        .client
                        .put_secret_value()
                        .secret_id(&name)
                        .secret_string(token.expose())
                        .send()
                        .await
                        .map_err(|e| aws(&e))?;
                    out.arn.ok_or_else(|| SecretsError::Aws("no arn".into()))
                }
                Err(e) => Err(aws(&e)),
            }
        })
    }

    fn get<'a>(&'a self, arn: &'a str) -> BoxFuture<'a, Result<BotToken, SecretsError>> {
        Box::pin(async move {
            self.ours(arn)?;
            let out = self
                .client
                .get_secret_value()
                .secret_id(arn)
                .send()
                .await
                .map_err(|e| aws(&e))?;
            out.secret_string.and_then(BotToken::new).ok_or(SecretsError::NotAToken)
        })
    }

    fn delete<'a>(&'a self, arn: &'a str) -> BoxFuture<'a, Result<(), SecretsError>> {
        Box::pin(async move {
            self.ours(arn)?;
            if self.kms_key.is_none() {
                return Err(SecretsError::Aws("read only".into()));
            }
            match self
                .client
                .delete_secret()
                .secret_id(arn)
                .force_delete_without_recovery(true)
                .send()
                .await
            {
                Ok(_) => Ok(()),
                Err(e) if e.code() == Some("ResourceNotFoundException") => Ok(()),
                Err(e) => Err(aws(&e)),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> aws_sdk_secretsmanager::Client {
        let conf = aws_sdk_secretsmanager::Config::builder()
            .behavior_version(aws_sdk_secretsmanager::config::BehaviorVersion::latest())
            .region(aws_sdk_secretsmanager::config::Region::new("eu-west-2"))
            .build();
        aws_sdk_secretsmanager::Client::from_conf(conf)
    }

    #[test]
    fn only_secrets_under_the_prefix_are_touched() {
        let s = SecretsManager::reader(client(), "oryxa-fde/prod/slack/").unwrap();
        let ours = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:oryxa-fde/prod/slack/org_1-AbCdEf";
        assert!(s.ours(ours).is_ok());
        for other in [
            "arn:aws:secretsmanager:eu-west-2:123456789012:secret:oryxa-fde/prod/db-AbCdEf",
            "arn:aws:secretsmanager:eu-west-2:123456789012:secret:other/oryxa-fde/prod/slack/x",
            "arn:aws:s3:::oryxa-fde/prod/slack/org_1",
            "",
        ] {
            assert!(s.ours(other).is_err(), "{other}");
        }
        for bad in ["oryxa-fde/prod/slack", "", "/", "a b/"] {
            assert!(SecretsManager::reader(client(), bad).is_none(), "{bad}");
        }
        assert!(SecretsManager::new(client(), "oryxa-fde/prod/slack/", "").is_none());
    }
}
