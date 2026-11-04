//! oryxa-fde-lifecycle on ECS Fargate: reads FDE events from its SQS FIFO queue and applies the
//! lifecycle rules, and every hour drafts last week's update for any active project without one.
//! It signs in as the runtime login with RDS IAM tokens (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`),
//! or locally with `DATABASE_URL` (the store refuses an owner); `LIFECYCLE_QUEUE_URL` is the
//! queue; `EVENT_SIGNING_KID` and `EVENT_PUBLIC_KEY` the key FDE events are signed with;
//! `UPDATE_MODEL` the Bedrock model that drafts updates (Claude Opus 5.5 by default). It calls AWS
//! only (SQS, Bedrock).

use std::sync::Arc;
use std::time::Duration;

use oryxa_events::Verifier;
use oryxa_fde_events::inbox::sqs;
use oryxa_fde_lifecycle::drafts::{BedrockDrafter, DEFAULT_MODEL, Drafter, draft_due};
use oryxa_fde_lifecycle::rules::handle;
use oryxa_fde_store::Store;
use tracing_subscriber::EnvFilter;

type Error = Box<dyn std::error::Error + Send + Sync>;

/// How often the drafts are checked; each week's is drafted once, the first check after it ends.
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
    let model = std::env::var("UPDATE_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.into());
    let drafter: Arc<dyn Drafter> = Arc::new(BedrockDrafter::new(aws_sdk_bedrockruntime::Client::new(&aws), model));

    let (drafts_store, drafts) = (store.clone(), drafter.clone());
    tokio::spawn(async move {
        loop {
            let today = time::OffsetDateTime::now_utc().date();
            match draft_due(&drafts_store, drafts.as_ref(), today).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(drafted = n, "weekly updates drafted"),
                Err(e) => tracing::warn!(error = %e, "weekly drafts failed"),
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
