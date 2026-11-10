//! The health route and the client side of the container health check
//! (`oryxa-fde-ops healthcheck`): one GET to [`HEALTH_PATH`] on the API's own listen address, over
//! loopback only, so the image needs no shell or curl. It reads `LISTEN_ADDR` and nothing else.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

pub const HEALTH_PATH: &str = "/healthz";
/// Where the API listens when `LISTEN_ADDR` is not set.
pub const DEFAULT_LISTEN_ADDR: &str = "0.0.0.0:8080";
/// Well inside the 5 s ECS allows a health check command by default.
pub const TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, thiserror::Error)]
pub enum HealthError {
    #[error("LISTEN_ADDR must be an ip:port, not {0:?}")]
    Address(String),
    #[error("LISTEN_ADDR {0} is not loopback or unspecified; the health check calls loopback only")]
    NotLoopback(SocketAddr),
    #[error("health check request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("health check answered {0}")]
    Status(u16),
}

/// `LISTEN_ADDR`, or [`DEFAULT_LISTEN_ADDR`]: where the API binds, and so where its check calls.
pub fn listen_addr() -> String {
    std::env::var("LISTEN_ADDR").unwrap_or_else(|_| DEFAULT_LISTEN_ADDR.into())
}

/// The loopback address that reaches a server bound to `listen`: itself when it is loopback, the
/// same family's loopback when it binds every address, and an error otherwise.
pub fn loopback(listen: &str) -> Result<SocketAddr, HealthError> {
    let addr: SocketAddr = listen.parse().map_err(|_| HealthError::Address(listen.to_owned()))?;
    let ip = match addr.ip() {
        ip if ip.is_loopback() => ip,
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        _ => return Err(HealthError::NotLoopback(addr)),
    };
    Ok(SocketAddr::new(ip, addr.port()))
}

/// One request to the health route of the server bound to `listen`; `Ok` only on a 200.
pub async fn check(listen: &str, timeout: Duration) -> Result<(), HealthError> {
    let addr = loopback(listen)?;
    // No proxy from the environment, no redirects, no TLS: loopback, one hop, plain HTTP.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()?;
    let status = client.get(format!("http://{addr}{HEALTH_PATH}")).send().await?.status();
    if status == reqwest::StatusCode::OK {
        Ok(())
    } else {
        Err(HealthError::Status(status.as_u16()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_check_calls_loopback_only() {
        let cases = [
            ("0.0.0.0:8080", "127.0.0.1:8080"),
            ("127.0.0.1:9000", "127.0.0.1:9000"),
            ("127.0.0.2:9000", "127.0.0.2:9000"),
            ("[::]:8080", "[::1]:8080"),
            ("[::1]:8080", "[::1]:8080"),
        ];
        for (listen, called) in cases {
            assert_eq!(loopback(listen).unwrap().to_string(), called, "{listen}");
        }
        for remote in ["10.0.1.5:8080", "[fd00::1]:8080", "8.8.8.8:80"] {
            assert!(matches!(loopback(remote), Err(HealthError::NotLoopback(_))), "{remote}");
        }
        for bad in [
            "",
            "localhost:8080",
            "0.0.0.0",
            "api.example:8080",
            "http://127.0.0.1:8080",
        ] {
            assert!(matches!(loopback(bad), Err(HealthError::Address(_))), "{bad}");
        }
    }
}
