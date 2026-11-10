//! Stopping on SIGTERM (ECS stopping a task) or SIGINT (Ctrl-C locally), shared by the API and the
//! workers: each loop takes the token's `cancelled_owned()` and stops between units of work, never
//! in the middle of one.

use std::io;

use tokio::signal::unix::{SignalKind, signal};
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

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
}
