//! oryxa-fde-mcp on ECS Fargate, next to the API and with its configuration: `DATABASE_URL` (the
//! runtime login), SpiceDB, WorkOS, `DOCUMENTS_BUCKET` and `EMBEDDING_*`; `MCP_ALLOWED_HOSTS` is a
//! comma-separated list of the hostnames agents reach it at. Third-party host: WorkOS (JWKS).

use std::time::Duration;

use oryxa_authn::AccessTokenVerifier;
use oryxa_authz::SpiceDb;
use oryxa_fde_api::App;
use oryxa_fde_context::Context;
use oryxa_fde_store::Store;
use tracing_subscriber::EnvFilter;
use workos::helpers::JwksHelper;

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
    let authz = SpiceDb::connect_lazy(
        &env("SPICEDB_ENDPOINT")?,
        &env("SPICEDB_PRESHARED_KEY")?,
        Duration::from_secs(2),
    )?;
    let workos = workos::Client::builder()
        .api_key(env("WORKOS_API_KEY")?)
        .client_id(env("WORKOS_CLIENT_ID")?)
        .build();
    let issuer = std::env::var("WORKOS_ISSUER").unwrap_or_else(|_| "https://api.workos.com/".into());
    let tokens = AccessTokenVerifier::new(JwksHelper::from_client(&workos), issuer);
    let app = App::new(store, authz, tokens, Context::from_env().await?);
    let hosts = env("MCP_ALLOWED_HOSTS")?
        .split(',')
        .map(|h| h.trim().to_owned())
        .filter(|h| !h.is_empty())
        .collect();

    let addr = std::env::var("LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:8081".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "mcp listening");
    axum::serve(listener, oryxa_fde_mcp::router(app, hosts)).await?;
    Ok(())
}
