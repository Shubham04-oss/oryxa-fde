//! oryxa-fde-api on ECS Fargate: the HTTP API, down to sign-in (#296). Configuration comes from the
//! environment; ECS injects the secrets (SpiceDB key, WorkOS key) from Secrets Manager. It calls
//! WorkOS, for the JWKS of `WORKOS_ISSUER` and the sign-in steps.
//!
//! Browser sign-in uses `WEB_ORIGIN` (the web app, which forwards `/auth/*` here) and
//! `SESSION_PASSWORD` (64 hex characters) to seal the session cookie; `SESSION_PASSWORD_PREVIOUS`
//! is also read, for rotating in two deploys (see `session`: the new key goes here first).
//!
//! The database login is the runtime login, which owns nothing; the store refuses any other. On
//! ECS it signs in with RDS IAM tokens (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`; the RDS CA bundle is built in),
//! locally with `DATABASE_URL`. Migrations run before a deploy as a one-off task
//! (`oryxa-fde-ops migrate`) with the migrator's login.
//!
//! On SIGTERM or SIGINT it stops accepting connections and gives requests in flight
//! `SHUTDOWN_GRACE_SECONDS` (default 20) to finish, then exits 0 (see `shutdown`).

use std::sync::Arc;
use std::time::Duration;

use oryxa_authn::AccessTokenVerifier;
use oryxa_authz::SpiceDb;
use oryxa_fde_api::{App, SignIn, WorkOsAuthKit, health, router, shutdown, workos_issuer};
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

    // First, so a signal during start-up is a clean stop rather than the default kill.
    let stop = shutdown::on_signal()?;
    let grace = shutdown::grace_from_env()?;
    let store = Store::from_env().await?;
    let authz = SpiceDb::connect_lazy(
        &env("SPICEDB_ENDPOINT")?,
        &env("SPICEDB_PRESHARED_KEY")?,
        Duration::from_secs(2),
    )?;
    let client_id = env("WORKOS_CLIENT_ID")?;
    let issuer = workos_issuer(&client_id, std::env::var("WORKOS_ISSUER").ok().as_deref())?;
    let workos = workos::Client::builder()
        .api_key(env("WORKOS_API_KEY")?)
        .client_id(client_id)
        // A request waiting on a refresh answers 503 within this, not after the SDK's 30 s default.
        .timeout(Duration::from_secs(10))
        .build();
    let tokens = AccessTokenVerifier::new(JwksHelper::from_client(&workos), issuer);
    let mut sign_in = SignIn::new(
        env("WEB_ORIGIN")?,
        env("SESSION_PASSWORD")?,
        Arc::new(WorkOsAuthKit(workos.clone())),
    )?;
    if let Ok(previous) = std::env::var("SESSION_PASSWORD_PREVIOUS") {
        sign_in = sign_in.with_previous_password(previous)?;
    }

    let app = App::with_sign_in(store, authz, tokens, sign_in);
    let addr = health::listen_addr();
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "listening");
    shutdown::serve(listener, router(app), stop, grace, Vec::new()).await?;
    Ok(())
}
