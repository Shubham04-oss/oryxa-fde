//! oryxa-fde-ingest on ECS Fargate: reads `document.uploaded` from its SQS FIFO queue and ingests
//! each document. `DATABASE_URL` is the runtime login (the store refuses an owner);
//! `INGEST_QUEUE_URL` the queue; `EVENT_SIGNING_KID` and `EVENT_PUBLIC_KEY` the key FDE events are
//! signed with; `DOCUMENTS_BUCKET` and `EMBEDDING_*` as `Context::from_env` reads them. It calls
//! AWS only (S3, SQS, Bedrock).

use oryxa_events::Verifier;
use oryxa_fde_context::{Context, ingest};
use oryxa_fde_events::inbox::sqs;
use oryxa_fde_store::Store;
use tracing_subscriber::EnvFilter;

type Error = Box<dyn std::error::Error + Send + Sync>;

fn env(key: &str) -> Result<String, Error> {
    std::env::var(key).map_err(|_| format!("{key} is not set").into())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let store = Store::connect(&env("DATABASE_URL")?).await?;
    let ctx = Context::from_env().await?;
    let verifier = Verifier::default().trust(
        env("EVENT_SIGNING_KID")?,
        oryxa_fde_events::SOURCE,
        &env("EVENT_PUBLIC_KEY")?,
    )?;
    let queue = env("INGEST_QUEUE_URL")?;
    let client = aws_sdk_sqs::Client::new(&aws_config::load_from_env().await);
    tracing::info!("ingesting");
    sqs::run(client, queue, |msg| {
        let (ctx, store, verifier) = (&ctx, &store, &verifier);
        async move { ingest::handle(ctx, store, verifier, &msg).await }
    })
    .await;
    Ok(())
}
