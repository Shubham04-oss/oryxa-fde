//! oryxa-fde-lifecycle on ECS Fargate: reads FDE events from its SQS FIFO queue and applies the
//! lifecycle rules, and every hour drafts last week's update for any active project without one
//! and mails each newly approved update to the customer's sponsors (the weekly digest).
//! It signs in as the runtime login with RDS IAM tokens (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`),
//! or locally with `DATABASE_URL` (the store refuses an owner); `LIFECYCLE_QUEUE_URL` is the
//! queue; `EVENT_SIGNING_KID` and `EVENT_PUBLIC_KEY` the key FDE events are signed with;
//! `UPDATE_MODEL` the Bedrock inference profile that drafts updates: Claude Opus 5.5 is reached
//! only through one (e.g. `<geo>.anthropic.claude-opus-5-5`; a `global.` profile leaves the
//! region), so there is no default. `DIGEST_FROM` is the SES identity the digest is sent from and
//! `WEB_ORIGIN` the web app its unsubscribe page is on; without `DIGEST_FROM` no digest is sent.
//! It calls AWS only (SQS, Bedrock, SES).

use std::sync::Arc;
use std::time::Duration;

use oryxa_events::Verifier;
use oryxa_fde_events::inbox::sqs;
use oryxa_fde_lifecycle::digest::{DigestConfig, Mailer, SesMailer, send_due};
use oryxa_fde_lifecycle::drafts::{BedrockDrafter, DraftLimits, Drafter, draft_due};
use oryxa_fde_lifecycle::rules::handle;
use oryxa_fde_store::Store;
use tracing_subscriber::EnvFilter;

type Error = Box<dyn std::error::Error + Send + Sync>;

/// How often the drafts and the digest are checked; each week's update is drafted once, the first
/// check after the week ends, and mailed the first check after an FDE approves it.
const DRAFT_EVERY: Duration = Duration::from_secs(60 * 60);

fn env(key: &str) -> Result<String, Error> {
    std::env::var(key).map_err(|_| format!("{key} is not set").into())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let store = Store::from_env().await?;
    let verifier = Verifier::default().trust(
        env("EVENT_SIGNING_KID")?,
        oryxa_fde_events::SOURCE,
        &env("EVENT_PUBLIC_KEY")?,
    )?;
    let aws = aws_config::load_from_env().await;
    let model = env("UPDATE_MODEL")?;
    let drafter: Arc<dyn Drafter> = Arc::new(BedrockDrafter::new(aws_sdk_bedrockruntime::Client::new(&aws), model));
    let digest: Option<(Arc<dyn Mailer>, DigestConfig)> = match std::env::var("DIGEST_FROM") {
        Ok(from) => Some((
            Arc::new(SesMailer::new(aws_sdk_sesv2::Client::new(&aws), from)),
            DigestConfig::new(&env("WEB_ORIGIN")?)?,
        )),
        Err(_) => {
            tracing::info!("DIGEST_FROM is not set: no weekly digest is sent");
            None
        }
    };

    let (drafts_store, drafts) = (store.clone(), drafter.clone());
    tokio::spawn(async move {
        loop {
            let now = time::OffsetDateTime::now_utc();
            match draft_due(&drafts_store, drafts.as_ref(), now.date(), &DraftLimits::default()).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(drafted = n, "weekly updates drafted"),
                Err(e) => tracing::warn!(error = %e, "weekly drafts failed"),
            }
            if let Some((mailer, cfg)) = &digest {
                match send_due(&drafts_store, mailer.as_ref(), cfg, now).await {
                    Ok(0) => {}
                    Ok(n) => tracing::info!(sent = n, "weekly digest sent"),
                    Err(e) => tracing::warn!(error = %e, "weekly digest failed"),
                }
            }
            tokio::time::sleep(DRAFT_EVERY).await;
        }
    });

    let queue = env("LIFECYCLE_QUEUE_URL")?;
    let client = aws_sdk_sqs::Client::new(&aws);
    tracing::info!("lifecycle engine running");
    sqs::run(client, queue, |msg| {
        let (store, verifier) = (&store, &verifier);
        async move { handle(store, verifier, &msg).await }
    })
    .await;
    Ok(())
}
