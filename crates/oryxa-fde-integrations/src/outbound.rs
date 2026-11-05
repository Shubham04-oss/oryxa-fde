//! The one way out to GitHub and Slack: HTTPS to an explicit host allowlist, on the default port,
//! with redirects off (a redirect could leave the list) and a deadline on every call.

use std::time::Duration;

use url::Url;

/// Every host the integrations call. `github.com` is only for the OAuth code exchange.
pub const HOSTS: &[&str] = &["api.github.com", "github.com", "slack.com"];

const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error)]
pub enum OutboundError {
    #[error("not an allowed destination")]
    NotAllowed,
    #[error("request failed: {0}")]
    Http(#[from] reqwest::Error),
}

/// An HTTP client that reaches the [`HOSTS`] only.
#[derive(Debug, Clone)]
pub struct Outbound {
    client: reqwest::Client,
}

impl Outbound {
    pub fn new() -> Result<Self, OutboundError> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .user_agent("oryxa-fde")
            .build()?;
        Ok(Self { client })
    }

    /// A request to `url`, if it is `https` on an allowed host and the default port, with no
    /// credentials in it.
    pub fn request(&self, method: reqwest::Method, url: &str) -> Result<reqwest::RequestBuilder, OutboundError> {
        let u = allowed(url)?;
        Ok(self.client.request(method, u))
    }
}

fn allowed(url: &str) -> Result<Url, OutboundError> {
    let u = Url::parse(url).map_err(|_| OutboundError::NotAllowed)?;
    let ok = u.scheme() == "https"
        && u.port().is_none()
        && u.username().is_empty()
        && u.password().is_none()
        && u.host_str().is_some_and(|h| HOSTS.contains(&h));
    if ok { Ok(u) } else { Err(OutboundError::NotAllowed) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_to_a_listed_host_is_reachable() {
        for ok in [
            "https://api.github.com/app/installations/99/access_tokens",
            "https://github.com/login/oauth/access_token",
            "https://slack.com/api/chat.postMessage",
            "https://API.GITHUB.COM/repos",
        ] {
            assert!(allowed(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://api.github.com/",
            "https://api.github.com:8443/",
            "https://evil.example/",
            "https://api.github.com.evil.example/",
            "https://evil.example/https://api.github.com/",
            "https://user:pw@api.github.com/",
            "https://slack.com@evil.example/",
            "https://hooks.slack.com/services/x",
            "file:///etc/passwd",
            "api.github.com/repos",
            "",
        ] {
            assert!(allowed(bad).is_err(), "{bad}");
        }
        assert!(
            Outbound::new()
                .unwrap()
                .request(reqwest::Method::GET, "https://evil.example/")
                .is_err()
        );
    }
}
