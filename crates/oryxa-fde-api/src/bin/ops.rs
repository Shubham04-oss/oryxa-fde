//! One-off operations, each run as its own ECS task:
//!   oryxa-fde-ops migrate                          migrations, as the migrator
//!   oryxa-fde-ops replay-dead-events [<tenant>]    puts dead outbox rows back in line, as the runtime login
//!   oryxa-fde-ops healthcheck                      the API container's health check: exits 0 on a 200 from
//!                                                  its health route on loopback, 1 otherwise; reads LISTEN_ADDR only
//! On ECS the first two sign in with RDS IAM tokens (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`; the RDS CA
//! bundle is built in); locally with `MIGRATION_DATABASE_URL` and `DATABASE_URL`. The service itself
//! never migrates: its login owns nothing.

use oryxa_core::TenantId;
use oryxa_fde_api::health;
use oryxa_fde_store::{Store, migrate_from_env, relay};
use tracing_subscriber::EnvFilter;

type Error = Box<dyn std::error::Error + Send + Sync>;

const USAGE: &str = "usage: oryxa-fde-ops migrate | replay-dead-events [<tenant>] | healthcheck";

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
        // Run every 30 s for the life of the task, so it logs nothing unless it fails.
        ["healthcheck"] => health::check(&health::listen_addr(), health::TIMEOUT).await?,
        _ => return Err(USAGE.into()),
    }
    Ok(())
}
