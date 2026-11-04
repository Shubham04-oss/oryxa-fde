//! One-off operations, each run as its own ECS task:
//!   oryxa-fde-ops migrate                          migrations, as the owner (`MIGRATION_DATABASE_URL`)
//!   oryxa-fde-ops replay-dead-events [<tenant>]    puts dead outbox rows back in line (`DATABASE_URL`)
//! The service itself never migrates: its login owns nothing.

use oryxa_core::TenantId;
use oryxa_fde_store::{Store, migrate, relay};
use tracing_subscriber::EnvFilter;

type Error = Box<dyn std::error::Error + Send + Sync>;

const USAGE: &str = "usage: oryxa-fde-ops migrate | replay-dead-events [<tenant>]";

fn env(key: &str) -> Result<String, Error> {
    std::env::var(key).map_err(|_| format!("{key} is not set").into())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["migrate"] => {
            migrate(&env("MIGRATION_DATABASE_URL")?).await?;
            tracing::info!("migrations applied");
        }
        ["replay-dead-events", rest @ ..] if rest.len() <= 1 => {
            let tenant = rest.first().map(|t| TenantId::new(*t)).transpose()?;
            let store = Store::connect(&env("DATABASE_URL")?).await?;
            let n = relay::replay_dead(&store, tenant.as_ref()).await?;
            tracing::info!(replayed = n, "dead events back in line");
        }
        _ => return Err(USAGE.into()),
    }
    Ok(())
}
