//! Live output: each harness line goes to the `realtime/` Worker, whose Durable Object fans it out to the review
//! screen. Best effort: a run never waits on it or fails because of it, since the transcript is stored and can be
//! read back from the API.

use std::future::Future;
use std::time::Duration;

use oryxa_fde_core::{AgentRunId, ProjectScope};

#[derive(Debug, thiserror::Error)]
#[error("live output failed")]
pub struct LiveError;

pub trait LiveOutput: Send + Sync + 'static {
    /// Sends harness lines, in order, as received.
    fn publish(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        lines: Vec<String>,
    ) -> impl Future<Output = Result<(), LiveError>> + Send;
}

/// No realtime Worker configured: output is only stored.
pub struct Offline;

impl LiveOutput for Offline {
    async fn publish(&self, _: &ProjectScope, _: &AgentRunId, _: Vec<String>) -> Result<(), LiveError> {
        Ok(())
    }
}

/// `POST {base}/internal/v1/companies/<company>/projects/<project>/agent-runs/<run>/events`, NDJSON, behind the
/// realtime Worker's service token.
pub struct RealtimeClient {
    base: String,
    token: String,
    http: reqwest::Client,
}

impl RealtimeClient {
    pub fn new(base: &str, token: String) -> Result<Self, LiveError> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| LiveError)?;
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            token,
            http,
        })
    }
}

impl LiveOutput for RealtimeClient {
    async fn publish(&self, scope: &ProjectScope, run: &AgentRunId, lines: Vec<String>) -> Result<(), LiveError> {
        let url = format!(
            "{}/internal/v1/tenants/{}/companies/{}/projects/{}/agent-runs/{run}/events",
            self.base, scope.company.tenant, scope.company.company, scope.project
        );
        let mut body = lines.join("\n");
        body.push('\n');
        let response = self
            .http
            .post(url)
            .bearer_auth(&self.token)
            .header("content-type", "application/x-ndjson")
            .body(body)
            .send()
            .await
            .map_err(|_| LiveError)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(LiveError)
        }
    }
}
