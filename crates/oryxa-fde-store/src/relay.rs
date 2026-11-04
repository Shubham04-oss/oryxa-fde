//! Publishes the outbox to the bus through `oryxa_events`. Each row is signed just before sending,
//! keeps its event id (the bus deduplication id) and its scope's event group, and goes out in
//! order within its group: a row that fails holds back the rest of its group until it is sent or
//! goes dead.

use std::collections::HashSet;
use std::time::Duration;

use oryxa_events::{Encoded, Publisher, Signer};
use sqlx::{PgPool, Row};

use crate::StoreError;

/// After this many failed sends a row goes dead (logged, no longer retried, no longer blocking).
pub const MAX_ATTEMPTS: i32 = 20;
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
    pool: &PgPool,
    signer: &Signer,
    publisher: &P,
    batch: i64,
) -> Result<DispatchStats, StoreError> {
    let mut tx = pool.begin().await?;
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
        let sent = match signer.sign(&mut entry) {
            Ok(()) => publisher.send(entry.clone()).await.map_err(|e| e.to_string()),
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
                let dead = attempts >= MAX_ATTEMPTS;
                let backoff = 2_i32.saturating_pow(attempts.min(6) as u32); // 2s .. 64s
                sqlx::query(
                    "update outbox set attempts = $2, last_error = $3,
                         available_at = now() + make_interval(secs => $4),
                         dead_at = case when $5 then now() end
                     where id = $1",
                )
                .bind(&entry.event_id)
                .bind(attempts)
                .bind(&error)
                .bind(f64::from(backoff))
                .bind(dead)
                .execute(&mut *tx)
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
    }
    tx.commit().await?;
    Ok(stats)
}

/// Relay loop: every second, and straight away while there is a backlog. Published rows older
/// than seven days are pruned hourly.
pub async fn run<P: Publisher>(pool: PgPool, signer: Signer, publisher: P) {
    let mut last_prune = tokio::time::Instant::now();
    loop {
        let busy = match dispatch_once(&pool, &signer, &publisher, BATCH).await {
            Ok(s) => s.published + s.failed + s.dead == BATCH as usize,
            Err(e) => {
                tracing::warn!(error = %e, "outbox dispatch failed");
                false
            }
        };
        if last_prune.elapsed() > Duration::from_secs(3600) {
            if let Err(e) = prune(&pool).await {
                tracing::warn!(error = %e, "outbox prune failed");
            }
            last_prune = tokio::time::Instant::now();
        }
        if !busy {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

async fn prune(pool: &PgPool) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    sqlx::query("set local role oryxa_fde_relay").execute(&mut *tx).await?;
    sqlx::query("delete from outbox where published_at < now() - interval '7 days'")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
