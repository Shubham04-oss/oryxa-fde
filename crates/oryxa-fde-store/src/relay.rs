//! Publishes the outbox to the bus through `oryxa_events`. Each row is signed just before sending,
//! keeps its event id (the bus deduplication id) and its scope's event group, and goes out in
//! order within its group: a row that fails holds back the rest of its group until it is sent or
//! goes dead. A row goes dead only after failing for [`RETRY_FOR`], so a bus outage shorter than
//! that loses nothing; [`replay_dead`] puts dead rows back in line after a longer one.

use std::collections::HashSet;
use std::time::Duration;

use oryxa_core::TenantId;
use oryxa_events::{Encoded, Publisher, Signer};
use sqlx::Row;

use crate::{Store, StoreError};

/// How long a failing row is retried before it goes dead (logged, no longer retried, no longer
/// blocking its group). The signature is made at each send, so a late send still verifies.
pub const RETRY_FOR: Duration = Duration::from_secs(24 * 3600);
/// Longest wait between two tries of one row.
pub const MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);
/// A send that takes longer counts as failed; the relay holds its lock while it waits.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const BATCH: i64 = 50;
// Any constant works; it only has to be the same for every relay replica.
const RELAY_LOCK: i64 = 0x6f72_7978_6164_6501;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DispatchStats {
    pub published: usize,
    pub failed: usize,
    pub dead: usize,
}

/// Sends up to `batch` due rows, oldest first. Returns nothing sent if another replica is
/// relaying: one relay at a time keeps each group in order.
pub async fn dispatch_once<P: Publisher>(
    store: &Store,
    signer: &Signer,
    publisher: &P,
    batch: i64,
) -> Result<DispatchStats, StoreError> {
    dispatch(store, signer, publisher, batch, SEND_TIMEOUT).await
}

pub(crate) async fn dispatch<P: Publisher>(
    store: &Store,
    signer: &Signer,
    publisher: &P,
    batch: i64,
    send_timeout: Duration,
) -> Result<DispatchStats, StoreError> {
    let mut tx = store.pool.begin().await?;
    sqlx::query("set local role oryxa_fde_relay").execute(&mut *tx).await?;
    let locked: bool = sqlx::query_scalar("select pg_try_advisory_xact_lock($1)")
        .bind(RELAY_LOCK)
        .fetch_one(&mut *tx)
        .await?;
    let mut stats = DispatchStats::default();
    if !locked {
        return Ok(stats);
    }
    // A row waiting out a backoff blocks the later rows of its group.
    let rows = sqlx::query(
        "select id, source, detail_type, group_key, detail, attempts from outbox o
         where published_at is null and dead_at is null and available_at <= now()
           and not exists (
               select 1 from outbox e
               where e.group_key = o.group_key and e.seq < o.seq
                 and e.published_at is null and e.dead_at is null and e.available_at > now())
         order by seq limit $1",
    )
    .bind(batch)
    .fetch_all(&mut *tx)
    .await?;

    let mut stalled: HashSet<String> = HashSet::new();
    for row in rows {
        let mut entry = Encoded {
            event_id: row.try_get("id")?,
            source: row.try_get("source")?,
            detail_type: row.try_get("detail_type")?,
            group: row.try_get("group_key")?,
            detail: row.try_get("detail")?,
        };
        if stalled.contains(&entry.group) {
            continue;
        }
        let mut timed_out = false;
        let sent = match signer.sign(&mut entry) {
            Ok(()) => match tokio::time::timeout(send_timeout, publisher.send(entry.clone())).await {
                Ok(r) => r.map_err(|e| e.to_string()),
                Err(_) => {
                    timed_out = true;
                    Err(format!("send timed out after {send_timeout:?}"))
                }
            },
            Err(e) => Err(e.to_string()),
        };
        match sent {
            Ok(()) => {
                sqlx::query("update outbox set published_at = now(), last_error = null where id = $1")
                    .bind(&entry.event_id)
                    .execute(&mut *tx)
                    .await?;
                stats.published += 1;
            }
            Err(error) => {
                let attempts = row.try_get::<i32, _>("attempts")? + 1;
                let dead: bool = sqlx::query_scalar(
                    "update outbox set attempts = $2, last_error = $3,
                         available_at = now() + make_interval(secs => $4),
                         dead_at = case when retry_since < now() - make_interval(secs => $5) then now() end
                     where id = $1 returning dead_at is not null",
                )
                .bind(&entry.event_id)
                .bind(attempts)
                .bind(&error)
                .bind(backoff(attempts).as_secs_f64())
                .bind(RETRY_FOR.as_secs_f64())
                .fetch_one(&mut *tx)
                .await?;
                if dead {
                    tracing::error!(event_id = %entry.event_id, detail_type = %entry.detail_type, %error, "outbox event dead");
                    stats.dead += 1;
                } else {
                    tracing::warn!(event_id = %entry.event_id, detail_type = %entry.detail_type, %error, "outbox send failed");
                    stats.failed += 1;
                    stalled.insert(entry.group);
                }
            }
        }
        // A bus that does not answer will not answer the next row either; try again next round
        // rather than hold the lock for the whole batch.
        if timed_out {
            break;
        }
    }
    tx.commit().await?;
    Ok(stats)
}

/// 2 s after the first failure, doubling up to [`MAX_BACKOFF`].
fn backoff(attempts: i32) -> Duration {
    let secs = 2_u64.saturating_pow(attempts.clamp(1, 20) as u32);
    Duration::from_secs(secs).min(MAX_BACKOFF)
}

/// Puts dead rows (of one tenant, or all) back in line with a fresh [`RETRY_FOR`], for an operator
/// after a bus outage longer than that. A replayed row keeps its event id, but a day-old replay is
/// far outside the bus's FIFO deduplication window, so consumers deduplicate by event id: one
/// that did arrive before arrives again. It also reaches consumers after later events of its group
/// that went out while it was dead, so consumers must not rely on order across a replay.
pub async fn replay_dead(store: &Store, tenant: Option<&TenantId>) -> Result<u64, StoreError> {
    let mut tx = store.pool.begin().await?;
    sqlx::query("set local role oryxa_fde_relay").execute(&mut *tx).await?;
    let n = sqlx::query(
        "update outbox set dead_at = null, attempts = 0, available_at = now(), retry_since = now()
         where dead_at is not null and published_at is null and ($1::text is null or tenant_id = $1)",
    )
    .bind(tenant.map(TenantId::as_str))
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    Ok(n)
}

/// Relay loop: every second, and straight away while there is a backlog. Published rows older
/// than seven days are pruned hourly.
pub async fn run<P: Publisher>(store: Store, signer: Signer, publisher: P) {
    let mut last_prune = tokio::time::Instant::now();
    loop {
        let busy = match dispatch_once(&store, &signer, &publisher, BATCH).await {
            Ok(s) => s.published + s.failed + s.dead == BATCH as usize,
            Err(e) => {
                tracing::warn!(error = %e, "outbox dispatch failed");
                false
            }
        };
        if last_prune.elapsed() > Duration::from_secs(3600) {
            if let Err(e) = prune(&store).await {
                tracing::warn!(error = %e, "outbox prune failed");
            }
            last_prune = tokio::time::Instant::now();
        }
        if !busy {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

async fn prune(store: &Store) -> Result<(), StoreError> {
    let mut tx = store.pool.begin().await?;
    sqlx::query("set local role oryxa_fde_relay").execute(&mut *tx).await?;
    sqlx::query("delete from outbox where published_at < now() - interval '7 days'")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_a_ceiling_well_inside_the_retry_window() {
        assert_eq!(backoff(1), Duration::from_secs(2));
        assert_eq!(backoff(6), Duration::from_secs(64));
        assert_eq!(backoff(10), MAX_BACKOFF);
        assert_eq!(backoff(i32::MAX), MAX_BACKOFF);
        // A day of failures is many tries, not a handful of long waits.
        let tries_in_window = RETRY_FOR.as_secs() / MAX_BACKOFF.as_secs();
        assert!(tries_in_window >= 90, "{tries_in_window}");
    }
}
