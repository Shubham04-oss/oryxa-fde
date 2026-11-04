//! One-off operations, each run as its own ECS task:
//!   oryxa-fde-ops migrate                          migrations, as the migrator
//!   oryxa-fde-ops replay-dead-events [<tenant>]    puts dead outbox rows back in line, as the runtime login
//! On ECS both sign in with RDS IAM tokens (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
//! `DB_CA_BUNDLE`); locally with `MIGRATION_DATABASE_URL` and `DATABASE_URL`. The service itself
//! never migrates: its login owns nothing.

use oryxa_core::TenantId;
use oryxa_fde_store::{Store, migrate_from_env, relay};
use tracing_subscriber::EnvFilter;

type Error = Box<dyn std::error::Error + Send + Sync>;

const USAGE: &str = "usage: oryxa-fde-ops migrate | replay-dead-events [<tenant>]";

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["migrate"] => {
            migrate_from_env().await?;
            tracing::info!("migrations applied");
        }
        ["replay-dead-events", rest @ ..] if rest.len() <= 1 => {
            let tenant = rest.first().map(|t| TenantId::new(*t)).transpose()?;
            let store = Store::from_env().await?;
            let n = relay::replay_dead(&store, tenant.as_ref()).await?;
            tracing::info!(replayed = n, "dead events back in line");
        }
        _ => return Err(USAGE.into()),
    }
    Ok(())
}
