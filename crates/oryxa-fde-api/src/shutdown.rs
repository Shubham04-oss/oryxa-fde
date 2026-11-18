//! Graceful shutdown of the API service. On SIGTERM (ECS stopping the task) or SIGINT the listener
//! closes, so new connections are refused; requests in flight and any background loops then get
//! [`grace_from_env`] in all to finish, and the process exits. Whatever is still running at the
//! bound is dropped: an open transaction rolls back.

use std::future::IntoFuture;
use std::io;
use std::time::Duration;

use axum::Router;
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};
use tokio::task::JoinHandle;
use tokio::time::{Instant, timeout_at};
pub use tokio_util::sync::CancellationToken;

/// Installs the SIGTERM and SIGINT handlers now, so a signal that arrives later is never the
/// default (an immediate exit), and returns a token cancelled when the first one arrives. Must be
/// called inside the Tokio runtime.
pub fn on_signal() -> io::Result<CancellationToken> {
    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    let stop = CancellationToken::new();
    let fire = stop.clone();
    tokio::spawn(async move {
        let name = tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
        };
        tracing::info!(signal = name, "shutting down");
        fire.cancel();
    });
    Ok(stop)
}

/// Seconds the API waits, after the signal, for requests and background loops to finish.
pub const GRACE_VAR: &str = "SHUTDOWN_GRACE_SECONDS";
/// Under the 30 s ECS gives a container between SIGTERM and SIGKILL when its task definition sets
/// no `stopTimeout`, with room to log and exit.
pub const DEFAULT_GRACE: Duration = Duration::from_secs(20);
/// Fargate's longest `stopTimeout` is 120 s; a grace that long would always be cut by SIGKILL.
const MAX_GRACE_SECS: u64 = 119;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{GRACE_VAR} must be a whole number of seconds from 1 to {MAX_GRACE_SECS}")]
pub struct BadGrace;

/// The grace from `SHUTDOWN_GRACE_SECONDS`, or [`DEFAULT_GRACE`] when it is not set.
pub fn grace_from_env() -> Result<Duration, BadGrace> {
    parse_grace(std::env::var(GRACE_VAR).ok().as_deref())
}

fn parse_grace(value: Option<&str>) -> Result<Duration, BadGrace> {
    let Some(value) = value else { return Ok(DEFAULT_GRACE) };
    match value.parse::<u64>() {
        Ok(secs @ 1..=MAX_GRACE_SECS) => Ok(Duration::from_secs(secs)),
        _ => Err(BadGrace),
    }
}

/// What finished within the grace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Drained {
    /// Every request in flight at the signal got its response.
    pub requests: bool,
    /// Every background loop returned.
    pub background: bool,
}

/// Serves `router` on `listener` until `stop` is cancelled, then drains for at most `grace`:
/// requests in flight first, then `background`, the loops already told to stop by the same token.
/// A server that ends on its own (an error) also cancels `stop`, so the loops end with it.
pub async fn serve(
    listener: TcpListener,
    router: Router,
    stop: CancellationToken,
    grace: Duration,
    background: Vec<JoinHandle<()>>,
) -> std::io::Result<Drained> {
    let server = axum::serve(listener, router).with_graceful_shutdown(stop.clone().cancelled_owned());
    let mut server = std::pin::pin!(server.into_future());
    let ended = tokio::select! {
        r = &mut server => Some(r),
        () = stop.cancelled() => None,
    };
    stop.cancel();
    let deadline = Instant::now() + grace;
    let served = match ended {
        Some(r) => r.map(|()| true),
        None => timeout_at(deadline, server)
            .await
            .map_or(Ok(false), |r| r.map(|()| true)),
    };
    let mut background_done = true;
    for task in background {
        match timeout_at(deadline, task).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::error!(error = %e, "a background loop panicked"),
            Err(_) => background_done = false,
        }
    }
    let drained = Drained {
        requests: served?,
        background: background_done,
    };
    if drained.requests && drained.background {
        tracing::info!("drained; exiting");
    } else {
        tracing::warn!(
            requests_finished = drained.requests,
            background_finished = drained.background,
            grace_secs = grace.as_secs(),
            "shutdown grace ran out; dropping what is left"
        );
    }
    Ok(drained)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sigterm_cancels_the_token_instead_of_killing_the_process() {
        let stop = on_signal().unwrap();
        assert!(!stop.is_cancelled());
        let pid = std::process::id().to_string();
        let sent = std::process::Command::new("kill")
            .args(["-TERM", &pid])
            .status()
            .unwrap();
        assert!(sent.success());
        tokio::time::timeout(Duration::from_secs(5), stop.cancelled())
            .await
            .expect("SIGTERM reaches the token");
    }

    #[test]
    fn the_grace_defaults_under_the_ecs_stop_timeout_and_refuses_nonsense() {
        assert_eq!(parse_grace(None), Ok(DEFAULT_GRACE));
        assert!(DEFAULT_GRACE < Duration::from_secs(30));
        assert_eq!(parse_grace(Some("1")), Ok(Duration::from_secs(1)));
        assert_eq!(parse_grace(Some("119")), Ok(Duration::from_secs(119)));
        for bad in ["", "0", "120", "-5", "20s", " 20", "1.5", "99999999999999999999999"] {
            assert_eq!(parse_grace(Some(bad)), Err(BadGrace), "{bad:?}");
        }
    }
}
