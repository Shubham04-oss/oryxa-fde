//! oryxa-fde-api on ECS Fargate: the HTTP API plus the outbox relay. Configuration comes from the
//! environment; ECS injects the secrets (SpiceDB key, WorkOS key, event signing key) from Secrets
//! Manager. The only third-party host it calls is WorkOS, for the JWKS of `WORKOS_ISSUER`.

use std::time::Duration;

use oryxa_authn::AccessTokenVerifier;
use oryxa_authz::SpiceDb;
use oryxa_events::{EventBusPublisher, Signer};
use oryxa_fde_api::{App, router};
use oryxa_fde_store::{Store, relay};
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
    store.migrate().await?;
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

    let signer = Signer::from_pkcs8_pem(env("EVENT_SIGNING_KID")?, &env("EVENT_SIGNING_KEY")?)?;
    let publisher = EventBusPublisher::from_env(env("EVENT_BUS_ARN")?).await;
    tokio::spawn(relay::run(store.pool().clone(), signer, publisher));

    let addr = std::env::var("LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "listening");
    axum::serve(listener, router(App::new(store, authz, tokens))).await?;
    Ok(())
}
