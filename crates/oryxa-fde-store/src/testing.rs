//! Live-test helpers. `DATABASE_URL` names a login that may create roles (the test container's
//! superuser): it runs the migrations, and each [`store`] connects as a fresh login that holds
//! exactly what the API's runtime login holds, membership of `oryxa_fde_runtime`.

use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};

use crate::{Store, migrate, new_id};

pub const DEFAULT_DATABASE_URL: &str = "postgres://postgres:oryxa@localhost:55432/oryxa_fde";

pub fn database_url() -> String {
    std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.into())
}

/// A pool on `DATABASE_URL` after the migrations ran: the owner, for test setup and checks that
/// no runtime role may make.
pub async fn admin() -> PgPool {
    let url = database_url();
    migrate(&url).await.expect("migrate");
    PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("connect as the owner")
}

/// A store on a new runtime login, made by the owner for this test.
pub async fn store() -> Store {
    let admin = admin().await;
    let login = new_id("fde_rt");
    // Server-made ids are [a-z0-9_], so both are safe to splice into the statements.
    let password = new_id("pw");
    sqlx::query(&format!(
        "create role {login} login password '{password}' nosuperuser nocreaterole nobypassrls"
    ))
    .execute(&admin)
    .await
    .expect("create runtime login");
    sqlx::query(&format!("grant oryxa_fde_runtime to {login}"))
        .execute(&admin)
        .await
        .expect("grant oryxa_fde_runtime");
    admin.close().await;
    let options = database_url()
        .parse::<PgConnectOptions>()
        .expect("DATABASE_URL")
        .username(&login)
        .password(&password);
    Store::connect_with(options)
        .await
        .expect("connect as the runtime login")
}
