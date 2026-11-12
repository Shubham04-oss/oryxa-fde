//! Counters for the sign-in limits (ADR 0007): each attempt counts once in every bucket it names,
//! within a fixed window, and is refused while any of them is over its limit. A window that lapses
//! starts again from one, so a limit slows guessing and never locks an account.

use std::time::Duration;

use sqlx::Row;

use crate::{Store, StoreError};

/// The most a bucket counts, so a flood cannot overflow it.
const MAX_HITS: i32 = 1_000_000;
/// Windows lapsed this long are deleted, a few at each hit.
const SWEEP_AFTER_SECS: f64 = 24.0 * 3600.0;
const SWEEP_ROWS: i64 = 20;

/// One counter an attempt counts in: what is limited (e.g. `password_address`) and a keyed hash of
/// whom (none for a ceiling across everyone).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    bucket: String,
    window: Duration,
    limit: u32,
}

impl Hit {
    /// `kind` is `[a-z_]{1,32}`; `key` is a keyed hash made by the caller, never an address.
    pub fn new(kind: &'static str, key: Option<&[u8; 32]>, window: Duration, limit: u32) -> Result<Self, StoreError> {
        let kind_ok = (1..=32).contains(&kind.len()) && kind.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
        if !kind_ok || window.is_zero() || limit == 0 {
            return Err(StoreError::Rejected("sign_in_limit"));
        }
        let hex: String = key
            .map(|k| k.iter().map(|b| format!("{b:02x}")).collect())
            .unwrap_or_default();
        Ok(Self {
            bucket: format!("{kind}:{hex}"),
            window,
            limit,
        })
    }

    pub fn bucket(&self) -> &str {
        &self.bucket
    }
}

impl Store {
    /// Counts one attempt in every bucket of `keyed` (per address, per client) and, only when none of
    /// them is over its limit, in `ceiling`, the bucket shared by everyone: an attempt already refused
    /// for its own address or client never uses up what everyone else needs. Answers how long to wait
    /// when a bucket is over (`None`: go ahead). One transaction; the caller refuses on an error.
    pub async fn sign_in_hits(&self, keyed: &[Hit], ceiling: &Hit) -> Result<Option<Duration>, StoreError> {
        let mut sorted: Vec<&Hit> = keyed.iter().filter(|h| h.bucket != ceiling.bucket).collect();
        // One order for every transaction, so two attempts never wait on each other's rows.
        sorted.sort_by(|a, b| a.bucket.cmp(&b.bucket));
        sorted.dedup_by(|a, b| a.bucket == b.bucket);
        let mut tx = self.pool.begin().await?;
        sqlx::query("set local role oryxa_fde_relay").execute(&mut *tx).await?;
        let mut wait: Option<Duration> = None;
        for hit in sorted {
            if let Some(left) = bump(&mut tx, hit).await? {
                wait = Some(wait.map_or(left, |w| w.max(left)));
            }
        }
        // The shared row is taken last, so it is held only for the end of the transaction.
        if wait.is_none() {
            wait = bump(&mut tx, ceiling).await?;
        }
        sqlx::query(
            "delete from sign_in_limits where bucket in (
                 select bucket from sign_in_limits where window_start < now() - make_interval(secs => $1)
                 limit $2 for update skip locked)",
        )
        .bind(SWEEP_AFTER_SECS)
        .bind(SWEEP_ROWS)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(wait)
    }
}

/// Counts one attempt in `hit`'s bucket; how long until its window ends when it is now over its limit.
async fn bump(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, hit: &Hit) -> Result<Option<Duration>, StoreError> {
    let secs = hit.window.as_secs_f64();
    let row = sqlx::query(
        "insert into sign_in_limits as l (bucket, window_start, hits) values ($1, now(), 1)
         on conflict (bucket) do update set
             window_start = case when l.window_start <= now() - make_interval(secs => $2)
                            then now() else l.window_start end,
             hits = case when l.window_start <= now() - make_interval(secs => $2)
                    then 1 else least(l.hits + 1, $3) end
         returning hits,
             greatest(extract(epoch from (window_start + make_interval(secs => $2) - now())), 0)::float8 as left_secs",
    )
    .bind(&hit.bucket)
    .bind(secs)
    .bind(MAX_HITS)
    .fetch_one(&mut **tx)
    .await?;
    let count: i32 = row.try_get("hits")?;
    let left: f64 = row.try_get("left_secs")?;
    if i64::from(count) <= i64::from(hit.limit) {
        return Ok(None);
    }
    // At least a second, so a client told to wait never retries at once.
    Ok(Some(Duration::from_secs_f64(left.max(1.0).min(secs.max(1.0)))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_hold_a_kind_and_a_hash_only() {
        let key = [0xabu8; 32];
        let hit = Hit::new("password_address", Some(&key), Duration::from_secs(60), 5).unwrap();
        assert_eq!(hit.bucket(), format!("password_address:{}", "ab".repeat(32)));
        assert_eq!(
            Hit::new("all", None, Duration::from_secs(10), 100).unwrap().bucket(),
            "all:"
        );
        for kind in ["", "Password", "a b", "a:b", "x@example.com", &"a".repeat(33)] {
            let kind: &'static str = Box::leak(kind.to_owned().into_boxed_str());
            assert!(Hit::new(kind, None, Duration::from_secs(1), 1).is_err(), "{kind:?}");
        }
        assert!(Hit::new("all", None, Duration::ZERO, 1).is_err());
        assert!(Hit::new("all", None, Duration::from_secs(1), 0).is_err());
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn attempts_over_a_limit_wait_for_the_window_and_buckets_count_apart() {
        let store = crate::testing::store().await;
        let mut key = [0u8; 32];
        key[..8].copy_from_slice(&rand_bytes());
        // Room enough that the ceiling never decides here.
        key[29] ^= 1;
        let ceiling = Hit::new("test_ceiling", Some(&key), Duration::from_secs(60), 1000).unwrap();
        key[29] ^= 1;
        let mine = Hit::new("test_address", Some(&key), Duration::from_secs(60), 2).unwrap();
        key[31] ^= 1;
        let other = Hit::new("test_address", Some(&key), Duration::from_secs(60), 2).unwrap();
        assert_eq!(
            store.sign_in_hits(std::slice::from_ref(&mine), &ceiling).await.unwrap(),
            None
        );
        assert_eq!(
            store.sign_in_hits(std::slice::from_ref(&mine), &ceiling).await.unwrap(),
            None
        );
        let wait = store.sign_in_hits(std::slice::from_ref(&mine), &ceiling).await.unwrap();
        assert!(
            wait.is_some_and(|w| w >= Duration::from_secs(1) && w <= Duration::from_secs(60)),
            "{wait:?}"
        );
        assert_eq!(
            store
                .sign_in_hits(std::slice::from_ref(&other), &ceiling)
                .await
                .unwrap(),
            None,
            "another address is not slowed"
        );
        // An attempt naming both is refused while either is over.
        assert!(
            store
                .sign_in_hits(&[other.clone(), mine.clone()], &ceiling)
                .await
                .unwrap()
                .is_some()
        );

        // A lapsed window starts again from one.
        key[30] ^= 1;
        let short = Hit::new("test_address", Some(&key), Duration::from_millis(1100), 1).unwrap();
        assert_eq!(
            store
                .sign_in_hits(std::slice::from_ref(&short), &ceiling)
                .await
                .unwrap(),
            None
        );
        assert!(
            store
                .sign_in_hits(std::slice::from_ref(&short), &ceiling)
                .await
                .unwrap()
                .is_some()
        );
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert_eq!(
            store
                .sign_in_hits(std::slice::from_ref(&short), &ceiling)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    #[ignore = "needs Postgres (DATABASE_URL)"]
    async fn a_client_over_its_own_limit_does_not_use_up_the_ceiling_for_everyone() {
        let store = crate::testing::store().await;
        let mut key = [0u8; 32];
        key[..8].copy_from_slice(&rand_bytes());
        let flooder = Hit::new("test_client", Some(&key), Duration::from_secs(60), 2).unwrap();
        key[31] ^= 1;
        let someone = Hit::new("test_client", Some(&key), Duration::from_secs(60), 2).unwrap();
        // A ceiling of its own for this test, so other tests' counts do not matter.
        key[30] ^= 1;
        let ceiling = Hit::new("test_ceiling", Some(&key), Duration::from_secs(60), 5).unwrap();
        for _ in 0..20 {
            store
                .sign_in_hits(std::slice::from_ref(&flooder), &ceiling)
                .await
                .unwrap();
        }
        assert_eq!(
            store
                .sign_in_hits(std::slice::from_ref(&someone), &ceiling)
                .await
                .unwrap(),
            None,
            "only the flooder's two allowed attempts count against the ceiling"
        );
        // The ceiling still holds for attempts that pass their own limits.
        for n in 0..3 {
            key[28] = n + 1;
            let fresh = Hit::new("test_client", Some(&key), Duration::from_secs(60), 2).unwrap();
            let wait = store
                .sign_in_hits(std::slice::from_ref(&fresh), &ceiling)
                .await
                .unwrap();
            assert_eq!(wait.is_some(), n == 2, "attempt {n} past the ceiling of 5");
        }
    }

    fn rand_bytes() -> [u8; 8] {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64;
        n.to_be_bytes()
    }
}
