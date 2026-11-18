//! FDE storage on Postgres, down to sign-in (#296): the sign-in limits' counters ([`SignInHit`]).
//!
//! The service connects with a runtime login that owns nothing and holds no privilege outside a
//! transaction's role ([`Store::connect`] refuses any other); migrations run separately as the
//! owner ([`migrate`]).

use std::fmt;

use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

pub mod iam;
mod sign_in;
#[cfg(any(test, feature = "testing"))]
pub mod testing;

pub use sign_in::Hit as SignInHit;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("migrate: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("configuration: {0}")]
    Config(String),
    /// The runtime login, or a role it can reach, could act as an owner; migrations need their own
    /// login.
    #[error("refusing a database login that can reach owner powers: {0}")]
    Privileged(String),
    #[error("stored {0} is invalid")]
    Corrupt(&'static str),
    /// The request breaks a rule, e.g. a sign-in limit that is not one.
    #[error("{0}")]
    Rejected(&'static str),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("an email address must be local@domain.tld, at most 254 characters, with no spaces")]
pub struct EmailError;

/// An email address someone signs in with. It goes to WorkOS and nowhere else: never into SpiceDB,
/// events or logs, so `Debug` hides it.
#[derive(Clone, PartialEq, Eq)]
pub struct EmailAddress(String);

impl EmailAddress {
    pub fn new(value: impl AsRef<str>) -> Result<Self, EmailError> {
        let v = value.as_ref().trim();
        let Some((local, domain)) = v.split_once('@') else {
            return Err(EmailError);
        };
        let printable = v
            .chars()
            .all(|c| c.is_ascii_graphic() && !matches!(c, '<' | '>' | ',' | ';' | '"' | '(' | ')' | '\\' | '[' | ']'));
        let ok = v.len() <= 254
            && printable
            && (1..=64).contains(&local.len())
            && !domain.contains('@')
            && domain.contains('.')
            && !domain.starts_with('.')
            && !domain.ends_with('.')
            && !domain.contains("..");
        if ok { Ok(Self(v.to_owned())) } else { Err(EmailError) }
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for EmailAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EmailAddress(<hidden>)")
    }
}

/// A fresh id for a new record, e.g. `req_0192…`. Server-generated, so always in the id charset.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::now_v7().simple())
}

/// Runs the migrations as `url`'s login, which owns the tables: a one-off task with its own
/// login, never the service's.
pub async fn migrate(url: &str) -> Result<(), StoreError> {
    let pool = PgPoolOptions::new().max_connections(1).connect(url).await?;
    let result = migrate_with(&pool).await;
    pool.close().await;
    result
}

/// Runs the migrations as the migrator: with IAM tokens when `DB_HOST` and the rest are set (see
/// [`iam::IamConfig`]), else as `MIGRATION_DATABASE_URL`'s login.
pub async fn migrate_from_env() -> Result<(), StoreError> {
    match iam::IamConfig::from_env()? {
        Some(cfg) => {
            let tokens = iam::RdsIam::from_env(&cfg).await?;
            iam::migrate_iam(&cfg, &tokens).await
        }
        None => {
            let url = std::env::var("MIGRATION_DATABASE_URL")
                .map_err(|_| StoreError::Config("MIGRATION_DATABASE_URL or DB_HOST".into()))?;
            migrate(&url).await
        }
    }
}

pub(crate) async fn migrate_with(pool: &PgPool) -> Result<(), StoreError> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

#[derive(Clone)]
pub struct Store {
    // Private: every query goes through a scoped transaction, which takes a role.
    pool: PgPool,
}

impl Store {
    /// Connects as the runtime login, after checking it cannot act as the owner.
    pub async fn connect(url: &str) -> Result<Self, StoreError> {
        Self::connect_with(url.parse::<PgConnectOptions>()?).await
    }

    /// Connects as the runtime login: with IAM tokens when `DB_HOST` and the rest are set (see
    /// [`iam::IamConfig`]), else as `DATABASE_URL`'s login (local and test runs).
    pub async fn from_env() -> Result<Self, StoreError> {
        match iam::IamConfig::from_env()? {
            Some(cfg) => {
                let tokens = std::sync::Arc::new(iam::RdsIam::from_env(&cfg).await?);
                Self::connect_iam(cfg, tokens, iam::REFRESH_EVERY).await
            }
            None => {
                let url =
                    std::env::var("DATABASE_URL").map_err(|_| StoreError::Config("DATABASE_URL or DB_HOST".into()))?;
                Self::connect(&url).await
            }
        }
    }

    pub async fn connect_with(options: PgConnectOptions) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new().max_connections(10).connect_with(options).await?;
        if let Some(why) = owner_powers(&pool).await? {
            pool.close().await;
            return Err(StoreError::Privileged(why));
        }
        Ok(Self { pool })
    }
}

/// What would let this login act as an owner, if anything, for the login and every role it can
/// reach by SET ROLE or inheritance: superuser, the right to create roles or databases or to bypass
/// row-level security, a predefined role, owning the database, a schema, a relation or a function,
/// creating in a schema, or an admin option. The same rule as the infra bootstrap's own check.
async fn owner_powers(pool: &PgPool) -> Result<Option<String>, StoreError> {
    let found: Option<String> = sqlx::query_scalar(
        "select string_agg(format('%s (%s)', r.rolname, why), ', ' order by r.rolname, why)
         from pg_roles r
         cross join lateral (values
             (r.rolsuper, 'superuser'),
             (r.rolcreaterole, 'createrole'),
             (r.rolcreatedb, 'createdb'),
             (r.rolbypassrls, 'bypassrls'),
             (r.rolname like 'pg\\_%', 'predefined role'),
             (r.oid = (select datdba from pg_database where datname = current_database()), 'owns the database'),
             (exists (select from pg_class c where c.relowner = r.oid), 'owns a relation'),
             -- An owner of a function a row-level policy calls could redefine it and switch the policy off.
             (exists (select from pg_proc p where p.proowner = r.oid), 'owns a function'),
             (exists (select from pg_namespace n where n.nspowner = r.oid), 'owns a schema'),
             (exists (select from pg_namespace n
                      where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
                        and has_schema_privilege(r.oid, n.oid, 'create')), 'create in a schema'),
             (exists (select from pg_auth_members m where m.member = r.oid and m.admin_option), 'admin option')
         ) as v(failed, why)
         where pg_has_role(current_user, r.oid, 'member') and v.failed",
    )
    .fetch_one(pool)
    .await?;
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_addresses_are_plain_and_stay_out_of_debug_output() {
        assert_eq!(
            EmailAddress::new(" sam@acme.example ").unwrap().as_str(),
            "sam@acme.example"
        );
        for bad in [
            "",
            "sam",
            "sam@",
            "@acme.example",
            "sam@acme",
            "sam@@acme.example",
            "sam@acme..example",
            "sam smith@acme.example",
            "Sam <sam@acme.example>",
            "sam@acme.example\r\nBcc: x@evil.example",
            "sam,eve@acme.example",
        ] {
            assert_eq!(EmailAddress::new(bad), Err(EmailError), "{bad:?}");
        }
        assert!(EmailAddress::new(format!("{}@acme.example", "a".repeat(65))).is_err());
        assert_eq!(
            format!("{:?}", EmailAddress::new("sam@acme.example").unwrap()),
            "EmailAddress(<hidden>)"
        );
    }

    #[test]
    fn new_ids_are_valid_ids() {
        let id = new_id("req");
        assert!(id.starts_with("req_"));
        assert!(oryxa_core::UserId::new(id).is_ok());
    }
}
