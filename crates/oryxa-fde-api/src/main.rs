//! oryxa-fde-api on ECS Fargate: the HTTP API, the outbox relay and the grant reconciler.
//! Configuration comes from the environment; ECS injects the secrets (SpiceDB key, WorkOS key,
//! event signing key) from Secrets Manager. The only third-party host it calls is WorkOS, for the
//! JWKS of `WORKOS_ISSUER`.
//!
//! Browser sign-in uses `WEB_ORIGIN` (the web app, which forwards `/auth/*` here) and
//! `SESSION_PASSWORD` (64 hex characters) to seal the session cookie.
//!
//! `DATABASE_URL` is the runtime login, which owns nothing; the store refuses any other. Migrations
//! run before a deploy as a one-off task (`oryxa-fde-ops migrate`) with the owner's login.

use std::time::Duration;

use oryxa_authn::AccessTokenVerifier;
use oryxa_authz::SpiceDb;
use oryxa_events::{EventBusPublisher, Signer};
use std::sync::Arc;

use oryxa_fde_api::{App, SignIn, WorkOsAuthKit, router, run_reconciler};
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
    let sign_in = SignIn::new(
        env("WEB_ORIGIN")?,
        env("SESSION_PASSWORD")?,
        Arc::new(WorkOsAuthKit(workos.clone())),
    )?;

    let signer = Signer::from_pkcs8_pem(env("EVENT_SIGNING_KID")?, &env("EVENT_SIGNING_KEY")?)?;
    let publisher = EventBusPublisher::from_env(env("EVENT_BUS_ARN")?).await;
    tokio::spawn(relay::run(store.clone(), signer, publisher));

    let app = App::with_sign_in(store, authz, tokens, sign_in);
    tokio::spawn(run_reconciler(app.clone()));

    let addr = std::env::var("LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "listening");
    axum::serve(listener, router(app)).await?;
    Ok(())
}
