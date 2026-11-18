//! One-off operations, each run as its own ECS task:
//!   oryxa-fde-ops migrate        migrations, as the migrator
//!   oryxa-fde-ops healthcheck    the API container's health check: exits 0 on a 200 from its health
//!                                route on loopback, 1 otherwise; reads LISTEN_ADDR only
//! On ECS `migrate` signs in with RDS IAM tokens (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`; the RDS CA
//! bundle is built in); locally with `MIGRATION_DATABASE_URL`. The service itself never migrates: its
//! login owns nothing.

use oryxa_fde_api::health;
use oryxa_fde_store::migrate_from_env;
use tracing_subscriber::EnvFilter;

type Error = Box<dyn std::error::Error + Send + Sync>;

const USAGE: &str = "usage: oryxa-fde-ops migrate | healthcheck";

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
        // Run every 30 s for the life of the task, so it logs nothing unless it fails.
        ["healthcheck"] => health::check(&health::listen_addr(), health::TIMEOUT).await?,
        _ => return Err(USAGE.into()),
    }
    Ok(())
}
