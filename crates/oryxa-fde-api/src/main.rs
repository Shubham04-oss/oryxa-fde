//! oryxa-fde-api on ECS Fargate: the HTTP API, the outbox relay and the grant reconciler.
//! Configuration comes from the environment; ECS injects the secrets (SpiceDB key, WorkOS key,
//! event signing key) from Secrets Manager. The only third-party host it calls is WorkOS, for the
//! JWKS of `WORKOS_ISSUER`. Uploads go to S3 (`DOCUMENTS_BUCKET`); search queries are embedded on
//! Bedrock (`EMBEDDING_*`).
//!
//! Browser sign-in uses `WEB_ORIGIN` (the web app, which forwards `/auth/*` here) and
//! `SESSION_PASSWORD` (64 hex characters) to seal the session cookie; `SESSION_PASSWORD_PREVIOUS`
//! is also read, for rotating in two deploys (see `session`: the new key goes here first).
//!
//! The database login is the runtime login, which owns nothing; the store refuses any other. On
//! ECS it signs in with RDS IAM tokens (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`; the RDS CA bundle is built in),
//! locally with `DATABASE_URL`. Migrations run before a deploy as a one-off task
//! (`oryxa-fde-ops migrate`) with the migrator's login.

use std::time::Duration;

use oryxa_authn::AccessTokenVerifier;
use oryxa_authz::SpiceDb;
use oryxa_events::{EventBusPublisher, Signer};
use std::sync::Arc;

use oryxa_fde_api::{App, SignIn, WorkOsAuthKit, router, run_reconciler};
use oryxa_fde_context::Context;
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

    let store = Store::from_env().await?;
    let authz = SpiceDb::connect_lazy(
        &env("SPICEDB_ENDPOINT")?,
        &env("SPICEDB_PRESHARED_KEY")?,
        Duration::from_secs(2),
    )?;
    let workos = workos::Client::builder()
        .api_key(env("WORKOS_API_KEY")?)
        .client_id(env("WORKOS_CLIENT_ID")?)
        // A request waiting on a refresh answers 503 within this, not after the SDK's 30 s default.
        .timeout(Duration::from_secs(10))
        .build();
    let issuer = std::env::var("WORKOS_ISSUER").unwrap_or_else(|_| "https://api.workos.com/".into());
    let tokens = AccessTokenVerifier::new(JwksHelper::from_client(&workos), issuer.clone());
    // Agent runs (crates/oryxa-fde-agent): off unless SANDBOX_GATEWAY_URL is set.
    let agent_runs = oryxa_fde_agent::prod::router_from_env(
        store.clone(),
        authz.clone(),
        AccessTokenVerifier::new(JwksHelper::from_client(&workos), issuer),
    )?;
    let mut sign_in = SignIn::new(
        env("WEB_ORIGIN")?,
        env("SESSION_PASSWORD")?,
        Arc::new(WorkOsAuthKit(workos.clone())),
    )?;
    if let Ok(previous) = std::env::var("SESSION_PASSWORD_PREVIOUS") {
        sign_in = sign_in.with_previous_password(previous)?;
    }

    let signer = Signer::from_pkcs8_pem(env("EVENT_SIGNING_KID")?, &env("EVENT_SIGNING_KEY")?)?;
    let publisher = EventBusPublisher::from_env(env("EVENT_BUS_ARN")?).await;
    tokio::spawn(relay::run(store.clone(), signer, publisher));

    let context = Context::from_env().await?;
    let app = App::with_sign_in(store, authz, tokens, context, sign_in);
    tokio::spawn(run_reconciler(app.clone()));

    let addr = std::env::var("LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "listening");
    axum::serve(listener, router(app).merge(agent_runs)).await?;
    Ok(())
}
