//! Graceful shutdown (`oryxa_fde_api::shutdown`) and the container health check
//! (`oryxa-fde-ops healthcheck`), against servers on loopback. No database or SpiceDB.

use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::http::StatusCode;
use axum::response::Redirect;
use axum::routing::get;
use oryxa_fde_api::shutdown::{self, Drained};
use oryxa_fde_events::shutdown::CancellationToken;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, oneshot};

async fn listener() -> (TcpListener, String) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap().to_string();
    (l, addr)
}

/// A route that tells the test it started, then answers only once `release` is notified.
fn slow(started: oneshot::Sender<()>, release: Arc<Notify>) -> Router {
    let started = Arc::new(Mutex::new(Some(started)));
    Router::new().route(
        "/slow",
        get(move || {
            let (started, release) = (started.clone(), release.clone());
            async move {
                if let Some(tx) = started.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                release.notified().await;
                "done"
            }
        }),
    )
}

/// A GET that ignores any proxy in the environment: these servers are on loopback.
async fn get_slow(addr: &str) -> reqwest::Result<reqwest::Response> {
    let client = reqwest::Client::builder().no_proxy().build()?;
    client.get(format!("http://{addr}/slow")).send().await
}

async fn refused(addr: &str) -> bool {
    for _ in 0..100 {
        if TcpStream::connect(addr).await.is_err() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

#[tokio::test]
async fn a_request_in_flight_finishes_while_new_connections_are_refused() {
    let (l, addr) = listener().await;
    let (started_tx, started) = oneshot::channel();
    let release = Arc::new(Notify::new());
    let stop = CancellationToken::new();
    let looping = stop.clone();
    let background = tokio::spawn(async move { looping.cancelled().await });
    let server = tokio::spawn(shutdown::serve(
        l,
        slow(started_tx, release.clone()),
        stop.clone(),
        Duration::from_secs(10),
        vec![background],
    ));

    let in_flight = tokio::spawn({
        let addr = addr.clone();
        async move { get_slow(&addr).await }
    });
    started.await.unwrap();
    stop.cancel();
    assert!(
        refused(&addr).await,
        "a new connection is refused once the signal arrives"
    );
    assert!(!server.is_finished(), "the server waits for the request in flight");

    release.notify_one();
    let response = in_flight.await.unwrap().unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.text().await.unwrap(), "done");
    let drained = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        drained,
        Drained {
            requests: true,
            background: true
        }
    );
}

#[tokio::test]
async fn the_grace_bounds_a_request_and_a_loop_that_hang() {
    let (l, addr) = listener().await;
    let (started_tx, started) = oneshot::channel();
    // Never released.
    let release = Arc::new(Notify::new());
    let stop = CancellationToken::new();
    let stuck = tokio::spawn(std::future::pending::<()>());
    let grace = Duration::from_millis(300);
    let server = tokio::spawn(shutdown::serve(
        l,
        slow(started_tx, release),
        stop.clone(),
        grace,
        vec![stuck],
    ));
    let _in_flight = tokio::spawn(async move { get_slow(&addr).await });
    started.await.unwrap();

    let asked = Instant::now();
    stop.cancel();
    let drained = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("serve returns at the bound")
        .unwrap()
        .unwrap();
    let took = asked.elapsed();
    assert!(took >= grace && took < grace + Duration::from_secs(2), "{took:?}");
    assert_eq!(
        drained,
        Drained {
            requests: false,
            background: false
        }
    );
}

#[tokio::test]
async fn a_server_with_nothing_in_flight_stops_at_once() {
    let (l, _) = listener().await;
    let stop = CancellationToken::new();
    stop.cancel();
    let drained = tokio::time::timeout(
        Duration::from_secs(2),
        shutdown::serve(l, Router::new(), stop, Duration::from_secs(60), vec![]),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(drained.requests && drained.background);
}

/// Runs `oryxa-fde-ops healthcheck` with `LISTEN_ADDR` as its whole environment.
async fn healthcheck(listen_addr: &str) -> (Option<i32>, Duration) {
    let listen_addr = listen_addr.to_owned();
    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let status = Command::new(env!("CARGO_BIN_EXE_oryxa-fde-ops"))
            .arg("healthcheck")
            .env_clear()
            .env("LISTEN_ADDR", listen_addr)
            .status()
            .unwrap();
        (status.code(), started.elapsed())
    })
    .await
    .unwrap()
}

async fn serving(router: Router) -> String {
    let (l, addr) = listener().await;
    tokio::spawn(async move { axum::serve(l, router).await });
    addr
}

#[tokio::test]
async fn the_healthcheck_exits_0_on_a_200_and_1_on_anything_else() {
    let healthy = serving(Router::new().route("/healthz", get(|| async { "ok" }))).await;
    assert_eq!(healthcheck(&healthy).await.0, Some(0));
    // Bound to every address, the check still calls loopback.
    let port = healthy.rsplit(':').next().unwrap();
    assert_eq!(healthcheck(&format!("0.0.0.0:{port}")).await.0, Some(0));

    let failing =
        serving(Router::new().route("/healthz", get(|| async { (StatusCode::SERVICE_UNAVAILABLE, "down") }))).await;
    assert_eq!(healthcheck(&failing).await.0, Some(1));
    // A redirect is not followed: the check never leaves the API's own address.
    let moved = serving(Router::new().route(
        "/healthz",
        get(|| async { Redirect::temporary("http://198.51.100.1/healthz") }),
    ))
    .await;
    assert_eq!(healthcheck(&moved).await.0, Some(1));
    let missing = serving(Router::new()).await;
    assert_eq!(healthcheck(&missing).await.0, Some(1));

    // Nothing listening.
    let (l, closed) = listener().await;
    drop(l);
    assert_eq!(healthcheck(&closed).await.0, Some(1));
    // Not loopback, or not an address: refused before any request.
    assert_eq!(healthcheck("10.0.0.1:8080").await.0, Some(1));
    assert_eq!(healthcheck("localhost:8080").await.0, Some(1));
}

#[tokio::test]
async fn the_healthcheck_gives_up_on_a_server_that_never_answers() {
    let (l, addr) = listener().await;
    // Accepts and holds every connection without a word.
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((s, _)) = l.accept().await {
            held.push(s);
        }
    });
    let (code, took) = healthcheck(&addr).await;
    assert_eq!(code, Some(1));
    assert!(took < Duration::from_secs(4), "{took:?}");
}
