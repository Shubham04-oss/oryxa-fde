//! The sandbox gateway (`sandbox/gateway`), as runs use it: start a company's sandbox, run commands as `agent`,
//! write a run's context pack, start the harness and talk to it, and open approved hosts. `GatewayClient` calls the
//! Worker's internal API; tests stand in a fake.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::time::Duration;

use oryxa_fde_core::{AgentRunId, CompanyScope};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::event::MAX_LINE_BYTES;
use crate::ids::ApprovalId;

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("sandbox gateway answered {status} to {route}")]
    Status { status: u16, route: &'static str },
    #[error("sandbox gateway unreachable on {route}")]
    Unreachable { route: &'static str },
    #[error("sandbox gateway sent an invalid response to {route}")]
    Invalid { route: &'static str },
}

/// A command to run in the sandbox as `agent`, in `/workspace`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exec {
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub timeout: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

impl ExecOutput {
    pub fn ok(&self) -> bool {
        self.exit_code == Some(0) && !self.timed_out
    }
}

/// What a running harness sends: its stdout, one complete line at a time, then how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessEvent {
    Line(String),
    /// Output that cannot be a harness line: longer than one may be, or not UTF-8.
    Invalid,
    Exited {
        code: Option<i32>,
        timed_out: bool,
    },
}

/// A harness started through the gateway. `exec` addresses its stdin; the channel closing without `Exited` means
/// the stream was lost.
pub struct HarnessProcess {
    pub exec: String,
    pub output: mpsc::Receiver<ProcessEvent>,
}

/// The generation of the company's sandbox lease a run holds. Every call that changes the sandbox carries it, and the
/// gateway refuses one lower than the highest it has seen: a run whose lease has passed on cannot touch the sandbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LeaseToken(pub u64);

pub trait Sandbox: Send + Sync + 'static {
    fn start(&self, company: &CompanyScope, lease: LeaseToken)
    -> impl Future<Output = Result<(), SandboxError>> + Send;
    /// Destroys the container: the hard stop for a harness that does not stop when told to.
    fn stop(&self, company: &CompanyScope, lease: LeaseToken) -> impl Future<Output = Result<(), SandboxError>> + Send;
    /// Whether a harness started in the sandbox may still run: its exit has not been seen, and the sandbox has not
    /// stopped since.
    fn harness_may_run(&self, company: &CompanyScope) -> impl Future<Output = Result<bool, SandboxError>> + Send;
    fn exec(
        &self,
        company: &CompanyScope,
        exec: Exec,
        lease: LeaseToken,
    ) -> impl Future<Output = Result<ExecOutput, SandboxError>> + Send;
    /// Writes a run's pack where only root can read it, and returns the SHA-256 of what is on disk.
    fn write_pack(
        &self,
        company: &CompanyScope,
        run: &AgentRunId,
        pack: Vec<u8>,
        lease: LeaseToken,
    ) -> impl Future<Output = Result<String, SandboxError>> + Send;
    fn start_harness(
        &self,
        company: &CompanyScope,
        run: &AgentRunId,
        sha256: &str,
        timeout: Duration,
        lease: LeaseToken,
    ) -> impl Future<Output = Result<HarnessProcess, SandboxError>> + Send;
    fn write_stdin(
        &self,
        company: &CompanyScope,
        exec: &str,
        line: String,
        lease: LeaseToken,
    ) -> impl Future<Output = Result<(), SandboxError>> + Send;
    /// The approval actions the company's outbound policy holds hosts for.
    fn held_actions(
        &self,
        company: &CompanyScope,
    ) -> impl Future<Output = Result<BTreeSet<String>, SandboxError>> + Send;
    /// Opens the hosts the company's outbound policy holds for `action`, while `run` makes the call an FDE approved
    /// (`approval`).
    fn open_grant(
        &self,
        company: &CompanyScope,
        action: &str,
        approval: &ApprovalId,
        run: &AgentRunId,
        ttl: Duration,
        lease: LeaseToken,
    ) -> impl Future<Output = Result<(), SandboxError>> + Send;
    /// Closes `action`'s hosts if `approval` opened them.
    fn close_grant(
        &self,
        company: &CompanyScope,
        action: &str,
        approval: &ApprovalId,
    ) -> impl Future<Output = Result<(), SandboxError>> + Send;
}

/// An approval action as it may appear in a gateway path: the approval list's own rule (`[A-Za-z0-9_-]`, at most
/// 128). The harness reports it, so it is checked again here rather than trusted.
pub fn action_segment(action: &str) -> Result<&str, SandboxError> {
    let ok = !action.is_empty()
        && action.len() <= 128
        && action
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(action)
    } else {
        Err(SandboxError::Invalid { route: "grant" })
    }
}

/// Splits a byte stream into lines, refusing one longer than `max` before it is all in memory.
#[derive(Debug)]
pub(crate) struct Lines {
    buf: Vec<u8>,
    max: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Line {
    Text(String),
    Invalid,
}

impl Lines {
    pub(crate) fn new(max: usize) -> Self {
        Self { buf: Vec::new(), max }
    }

    /// The complete lines in `chunk` and what came before it. After an `Invalid`, nothing more is read.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<Line> {
        let mut lines = Vec::new();
        for part in chunk.split_inclusive(|b| *b == b'\n') {
            self.buf.extend_from_slice(part);
            if self.buf.last() == Some(&b'\n') {
                self.buf.pop();
                let line = std::mem::take(&mut self.buf);
                match String::from_utf8(line) {
                    Ok(text) if text.len() <= self.max => lines.push(Line::Text(text)),
                    _ => return push_invalid(lines),
                }
            } else if self.buf.len() > self.max {
                return push_invalid(lines);
            }
        }
        lines
    }
}

fn push_invalid(mut lines: Vec<Line>) -> Vec<Line> {
    lines.push(Line::Invalid);
    lines
}

/// The gateway's streamed exec, one JSON object per line (`sandbox/gateway/src/exec.ts`).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StreamLine {
    Started {
        exec: String,
    },
    Stdout {
        data: String,
    },
    Stderr {
        #[allow(dead_code)]
        data: String,
    },
    Exit {
        code: Option<i32>,
        #[serde(rename = "timedOut")]
        timed_out: bool,
    },
}

/// The gateway's internal API, behind its service token.
pub struct GatewayClient {
    base: String,
    token: String,
    http: reqwest::Client,
}

impl GatewayClient {
    /// `base` is the Worker's internal URL; `token` its `SERVICE_TOKEN`, from Secrets Manager through the task's env.
    pub fn new(base: &str, token: String) -> Result<Self, SandboxError> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| SandboxError::Unreachable { route: "client" })?;
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            token,
            http,
        })
    }

    // Ids are [A-Za-z0-9_-], so they need no escaping in a path.
    /// A call that changes the sandbox, fenced by the caller's lease.
    fn held(&self, request: reqwest::RequestBuilder, lease: LeaseToken) -> reqwest::RequestBuilder {
        request.header("x-oryxa-lease", lease.0)
    }

    fn url(&self, company: &CompanyScope, route: &str) -> String {
        format!(
            "{}/v1/sandboxes/{}/{}/{route}",
            self.base, company.tenant, company.company
        )
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
        route: &'static str,
    ) -> Result<reqwest::Response, SandboxError> {
        // Errors name the route only: a URL holds ids, a body can hold customer content.
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| SandboxError::Unreachable { route })?;
        if !response.status().is_success() {
            return Err(SandboxError::Status {
                status: response.status().as_u16(),
                route,
            });
        }
        Ok(response)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecBody<'a> {
    argv: &'a [String],
    env: &'a BTreeMap<String, String>,
    timeout_ms: u128,
}

#[derive(Deserialize)]
struct Digest {
    sha256: String,
}

#[derive(Deserialize)]
struct Status {
    harness: bool,
}

#[derive(Deserialize)]
struct Policy {
    hosts: Vec<PolicyHost>,
}

#[derive(Deserialize)]
struct PolicyHost {
    #[serde(default)]
    approval: Option<String>,
}

impl Sandbox for GatewayClient {
    async fn start(&self, company: &CompanyScope, lease: LeaseToken) -> Result<(), SandboxError> {
        let request = self.held(self.http.post(self.url(company, "start")), lease);
        self.send(request, "start").await?;
        Ok(())
    }

    async fn stop(&self, company: &CompanyScope, lease: LeaseToken) -> Result<(), SandboxError> {
        let request = self.held(self.http.post(self.url(company, "stop")), lease);
        self.send(request, "stop").await?;
        Ok(())
    }

    async fn harness_may_run(&self, company: &CompanyScope) -> Result<bool, SandboxError> {
        let response = self.send(self.http.get(self.url(company, "")), "status").await?;
        let status: Status = response
            .json()
            .await
            .map_err(|_| SandboxError::Invalid { route: "status" })?;
        Ok(status.harness)
    }

    async fn exec(&self, company: &CompanyScope, exec: Exec, lease: LeaseToken) -> Result<ExecOutput, SandboxError> {
        let body = ExecBody {
            argv: &exec.argv,
            env: &exec.env,
            timeout_ms: exec.timeout.as_millis(),
        };
        let request = self
            .held(self.http.post(self.url(company, "exec")), lease)
            .json(&body)
            .timeout(exec.timeout + Duration::from_secs(30));
        let response = self.send(request, "exec").await?;
        response
            .json()
            .await
            .map_err(|_| SandboxError::Invalid { route: "exec" })
    }

    async fn write_pack(
        &self,
        company: &CompanyScope,
        run: &AgentRunId,
        pack: Vec<u8>,
        lease: LeaseToken,
    ) -> Result<String, SandboxError> {
        let request = self
            .held(self.http.put(self.url(company, &format!("runs/{run}/context"))), lease)
            .body(pack)
            .timeout(Duration::from_secs(60));
        let response = self.send(request, "context").await?;
        let digest: Digest = response
            .json()
            .await
            .map_err(|_| SandboxError::Invalid { route: "context" })?;
        Ok(digest.sha256)
    }

    async fn start_harness(
        &self,
        company: &CompanyScope,
        run: &AgentRunId,
        sha256: &str,
        timeout: Duration,
        lease: LeaseToken,
    ) -> Result<HarnessProcess, SandboxError> {
        let request = self
            .held(self.http.post(self.url(company, &format!("runs/{run}/harness"))), lease)
            .json(&serde_json::json!({ "sha256": sha256, "timeoutMs": timeout.as_millis() as u64 }));
        let mut response = self.send(request, "harness").await?;
        // A gateway line carries a stdout chunk, JSON-escaped; allow for the escaping.
        let mut gateway = Lines::new(8 * MAX_LINE_BYTES);
        let mut pending = Vec::new();
        let exec = loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|_| SandboxError::Unreachable { route: "harness" })?
                .ok_or(SandboxError::Invalid { route: "harness" })?;
            pending.extend(gateway.push(&chunk));
            if let Some(first) = pending.first() {
                match first {
                    Line::Text(text) => match serde_json::from_str(text) {
                        Ok(StreamLine::Started { exec }) => break exec,
                        _ => return Err(SandboxError::Invalid { route: "harness" }),
                    },
                    Line::Invalid => return Err(SandboxError::Invalid { route: "harness" }),
                }
            }
        };
        let (tx, rx) = mpsc::channel(256);
        tokio::spawn(forward(response, gateway, pending.split_off(1), tx));
        Ok(HarnessProcess { exec, output: rx })
    }

    async fn write_stdin(
        &self,
        company: &CompanyScope,
        exec: &str,
        line: String,
        lease: LeaseToken,
    ) -> Result<(), SandboxError> {
        let request = self
            .held(self.http.post(self.url(company, &format!("exec/{exec}/stdin"))), lease)
            .body(line)
            .timeout(Duration::from_secs(30));
        self.send(request, "stdin").await?;
        Ok(())
    }

    async fn held_actions(&self, company: &CompanyScope) -> Result<BTreeSet<String>, SandboxError> {
        let response = self
            .send(self.http.get(self.url(company, "outbound-policy")), "outbound-policy")
            .await?;
        let policy: Policy = response.json().await.map_err(|_| SandboxError::Invalid {
            route: "outbound-policy",
        })?;
        Ok(policy.hosts.into_iter().filter_map(|h| h.approval).collect())
    }

    async fn open_grant(
        &self,
        company: &CompanyScope,
        action: &str,
        approval: &ApprovalId,
        run: &AgentRunId,
        ttl: Duration,
        lease: LeaseToken,
    ) -> Result<(), SandboxError> {
        let route = format!("grants/{}", action_segment(action)?);
        let body = serde_json::json!({ "approval": approval, "run": run, "ttlMs": ttl.as_millis() as u64 });
        let request = self.held(self.http.put(self.url(company, &route)), lease).json(&body);
        self.send(request, "grant").await?;
        Ok(())
    }

    async fn close_grant(
        &self,
        company: &CompanyScope,
        action: &str,
        approval: &ApprovalId,
    ) -> Result<(), SandboxError> {
        // Approval ids are [A-Za-z0-9_-], so the query needs no escaping either.
        let route = format!("grants/{}?approval={approval}", action_segment(action)?);
        self.send(self.http.delete(self.url(company, &route)), "grant").await?;
        Ok(())
    }
}

/// Reads the rest of the gateway's stream and hands the harness's stdout on, line by line.
async fn forward(
    mut response: reqwest::Response,
    mut gateway: Lines,
    mut pending: Vec<Line>,
    tx: mpsc::Sender<ProcessEvent>,
) {
    let mut harness = Lines::new(MAX_LINE_BYTES);
    loop {
        for line in pending.drain(..) {
            let events = match line {
                Line::Invalid => vec![ProcessEvent::Invalid],
                Line::Text(text) => match serde_json::from_str::<StreamLine>(&text) {
                    Ok(StreamLine::Stdout { data }) => harness
                        .push(data.as_bytes())
                        .into_iter()
                        .map(|l| match l {
                            Line::Text(t) => ProcessEvent::Line(t),
                            Line::Invalid => ProcessEvent::Invalid,
                        })
                        .collect(),
                    // Diagnostics only; never read.
                    Ok(StreamLine::Stderr { .. }) | Ok(StreamLine::Started { .. }) => vec![],
                    Ok(StreamLine::Exit { code, timed_out }) => vec![ProcessEvent::Exited { code, timed_out }],
                    Err(_) => vec![ProcessEvent::Invalid],
                },
            };
            for event in events {
                let last = !matches!(event, ProcessEvent::Line(_));
                if tx.send(event).await.is_err() || last {
                    return;
                }
            }
        }
        match response.chunk().await {
            Ok(Some(chunk)) => pending = gateway.push(&chunk),
            // The stream ended or broke without an exit line: dropping `tx` tells the run it was lost.
            _ => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lines_across_chunks_and_refuses_overlong_or_binary_ones() {
        let mut lines = Lines::new(8);
        assert_eq!(lines.push(b"ab"), vec![]);
        assert_eq!(
            lines.push(b"c\nde\nf"),
            vec![Line::Text("abc".into()), Line::Text("de".into())]
        );
        assert_eq!(lines.push(b"\n"), vec![Line::Text("f".into())]);
        // Refused as soon as it passes the limit, before the newline arrives.
        assert_eq!(lines.push(b"123456789"), vec![Line::Invalid]);
        let mut binary = Lines::new(8);
        assert_eq!(binary.push(b"\xff\xfe\n"), vec![Line::Invalid]);
    }

    #[test]
    fn an_action_reaches_a_path_only_as_the_approval_list_writes_one() {
        assert_eq!(action_segment("customer_send").unwrap(), "customer_send");
        for bad in [
            "",
            "de/ploy",
            "../stop",
            "deploy?approval=x",
            "de ploy",
            "dé",
            &"a".repeat(129),
        ] {
            assert!(action_segment(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn reads_the_gateway_stream_format() {
        let lines = [
            r#"{"type":"started","exec":"0b7a2f62-8f58-4d2e-a2a9-3d1b1f3c9e10"}"#,
            r#"{"type":"stdout","data":"{\"v\":1}\n"}"#,
            r#"{"type":"stderr","data":"warning"}"#,
            r#"{"type":"exit","code":0,"timedOut":false}"#,
        ];
        let parsed: Vec<StreamLine> = lines.iter().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert!(matches!(parsed[0], StreamLine::Started { .. }));
        assert!(matches!(&parsed[1], StreamLine::Stdout { data } if data == "{\"v\":1}\n"));
        assert!(matches!(
            parsed[3],
            StreamLine::Exit {
                code: Some(0),
                timed_out: false
            }
        ));
    }
}
