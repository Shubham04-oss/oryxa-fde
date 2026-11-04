//! Agent runs end to end through the API, on sample data, with a fake sandbox gateway and a scripted fake harness
//! in place of the Worker and the SDK. Also the isolation of runs and approvals between companies and tenants, and
//! the fail-closed paths.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use oryxa_core::{TenantId, UserId};
use oryxa_fde_agent::access::{Access, AccessError, Caller, Permission};
use oryxa_fde_agent::api;
use oryxa_fde_agent::event::{EVENT_VERSION, Usage};
use oryxa_fde_agent::gateway::{Exec, ExecOutput, HarnessProcess, ProcessEvent, Sandbox, SandboxError};
use oryxa_fde_agent::live::{LiveError, LiveOutput};
use oryxa_fde_agent::service::{Deps, Pricing, Remaining, Runs, RunsConfig};
use oryxa_fde_agent::store::{
    ApprovalRecord, Budget, DecideResult, Decided, InMemoryRuns, RunRecord, RunStore, Spend, StoreError,
};
use oryxa_fde_agent::{
    AgentConfig, ApprovalId, ApprovalRule, EventLine, HarnessEvent, HarnessInput, InMemoryContext, Outcome,
    ProjectContext, ToolCallId, ToolKind, ToolStatus,
};
use oryxa_fde_core::{AgentRunId, CompanyId, CompanyScope, ProjectId, ProjectScope};
use oryxa_fde_events::RunOutcome;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;
use tower::ServiceExt;

// ---- Fakes -------------------------------------------------------------------------------------------------

/// Tokens map to callers; grants say who may do what on which project, and which company each project is in.
#[derive(Default)]
struct FakeAccess {
    tokens: HashMap<&'static str, Caller>,
    projects: HashMap<(TenantId, ProjectId), CompanyId>,
    grants: HashSet<(UserId, ProjectId, &'static str)>,
    down: bool,
}

impl Access for FakeAccess {
    async fn caller(&self, bearer: &str) -> Result<Caller, AccessError> {
        self.tokens.get(bearer).cloned().ok_or(AccessError::Unauthorized)
    }

    async fn allowed(
        &self,
        caller: &Caller,
        scope: &ProjectScope,
        permission: Permission,
    ) -> Result<bool, AccessError> {
        if self.down {
            return Err(AccessError::Unavailable);
        }
        let in_company =
            self.projects.get(&(scope.tenant().clone(), scope.project.clone())) == Some(&scope.company.company);
        let name = match permission {
            Permission::Work => "work",
            Permission::Manage => "manage",
        };
        Ok(caller.tenant == *scope.tenant()
            && in_company
            && self
                .grants
                .contains(&(caller.user.clone(), scope.project.clone(), name)))
    }
}

/// One step of a scripted harness.
#[derive(Clone)]
enum Step {
    Emit(HarnessEvent),
    /// Send a line that is not a harness event.
    Garbage,
    /// Wait for the approval decision: approved continues, rejected ends with a `rejected` result.
    AwaitDecision,
    /// Wait for a cancel, as a harness stuck on a slow model would.
    Hang,
    /// Record whether a deploy request would pass the outbound handler now.
    Probe,
    /// Wait (up to two seconds) for the deploy grant to close, then record whether a deploy would pass.
    ProbeAfterClose,
}

#[derive(Default)]
struct SandboxLog {
    calls: Vec<String>,
    stdin: Vec<String>,
    execs: Vec<Vec<String>>,
}

/// The gateway's open grants, by action, with the approval that opened each.
type Grants = Arc<Mutex<HashMap<String, String>>>;

struct FakeSandbox {
    log: Mutex<SandboxLog>,
    script: Mutex<Vec<Step>>,
    stdin: Mutex<Option<mpsc::UnboundedSender<String>>>,
    harness_out: Mutex<Option<mpsc::Sender<ProcessEvent>>>,
    /// Approval actions the outbound policy holds hosts for.
    held: BTreeSet<String>,
    grants: Grants,
    /// What the harness's probes saw: would a deploy have passed?
    probes: Arc<Mutex<Vec<bool>>>,
    tamper_pack: bool,
    stdin_down: bool,
    grants_down: bool,
    close_down: bool,
}

impl FakeSandbox {
    fn new(script: Vec<Step>) -> Self {
        Self {
            log: Mutex::default(),
            script: Mutex::new(script),
            stdin: Mutex::new(None),
            harness_out: Mutex::new(None),
            held: BTreeSet::from(["deploy".to_owned()]),
            grants: Arc::default(),
            probes: Arc::default(),
            tamper_pack: false,
            stdin_down: false,
            grants_down: false,
            close_down: false,
        }
    }

    fn calls(&self) -> Vec<String> {
        self.log.lock().unwrap().calls.clone()
    }

    fn call(&self, what: String) {
        self.log.lock().unwrap().calls.push(what);
    }
}

fn exec_output(argv: &[String]) -> ExecOutput {
    let ok = |stdout: &str| ExecOutput {
        exit_code: Some(0),
        stdout: stdout.into(),
        stderr: String::new(),
        timed_out: false,
    };
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    match args.as_slice() {
        [.., "diff", "--cached", "--quiet"] => ExecOutput {
            exit_code: Some(1),
            ..ok("")
        },
        [.., "rev-list", "--count", _] => ok("1\n"),
        ["curl", ..] => ok("{\"number\":7,\"html_url\":\"https://elsewhere.example/7\"}\n201\n"),
        _ => ok(""),
    }
}

impl Sandbox for FakeSandbox {
    async fn start(&self, company: &CompanyScope) -> Result<(), SandboxError> {
        self.call(format!("start {}", company.company));
        Ok(())
    }

    async fn stop(&self, company: &CompanyScope) -> Result<(), SandboxError> {
        self.call(format!("stop {}", company.company));
        // The container goes, and the harness with it.
        self.harness_out.lock().unwrap().take();
        self.stdin.lock().unwrap().take();
        Ok(())
    }

    async fn exec(&self, _: &CompanyScope, exec: Exec) -> Result<ExecOutput, SandboxError> {
        let out = exec_output(&exec.argv);
        let mut log = self.log.lock().unwrap();
        log.calls.push(format!("exec {}", exec.argv[0]));
        log.execs.push(exec.argv);
        Ok(out)
    }

    async fn write_pack(&self, _: &CompanyScope, run: &AgentRunId, pack: Vec<u8>) -> Result<String, SandboxError> {
        self.call(format!("pack {run}"));
        let mut on_disk = pack;
        if self.tamper_pack {
            on_disk.extend_from_slice(b" ");
        }
        Ok(hex(&Sha256::digest(&on_disk)))
    }

    async fn start_harness(
        &self,
        _: &CompanyScope,
        run: &AgentRunId,
        sha256: &str,
        _: Duration,
    ) -> Result<HarnessProcess, SandboxError> {
        self.call(format!("harness {run} {}", &sha256[..8]));
        let (out_tx, out_rx) = mpsc::channel(64);
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        *self.stdin.lock().unwrap() = Some(in_tx);
        *self.harness_out.lock().unwrap() = Some(out_tx.clone());
        let script = std::mem::take(&mut *self.script.lock().unwrap());
        // A new harness inherits no grant, as at the gateway.
        self.grants.lock().unwrap().clear();
        tokio::spawn(fake_harness(
            script,
            out_tx,
            in_rx,
            self.grants.clone(),
            self.probes.clone(),
        ));
        Ok(HarnessProcess {
            exec: "0b7a2f62-8f58-4d2e-a2a9-3d1b1f3c9e10".into(),
            output: out_rx,
        })
    }

    async fn write_stdin(&self, _: &CompanyScope, exec: &str, line: String) -> Result<(), SandboxError> {
        assert_eq!(exec, "0b7a2f62-8f58-4d2e-a2a9-3d1b1f3c9e10");
        if self.stdin_down {
            return Err(SandboxError::Unreachable { route: "stdin" });
        }
        self.log.lock().unwrap().stdin.push(line.clone());
        if let Some(tx) = self.stdin.lock().unwrap().as_ref() {
            let _ = tx.send(line);
        }
        Ok(())
    }

    async fn held_actions(&self, _: &CompanyScope) -> Result<BTreeSet<String>, SandboxError> {
        Ok(self.held.clone())
    }

    async fn open_grant(
        &self,
        _: &CompanyScope,
        action: &str,
        approval: &ApprovalId,
        run: &AgentRunId,
        _: Duration,
    ) -> Result<(), SandboxError> {
        if self.grants_down || !self.held.contains(action) {
            return Err(SandboxError::Status {
                status: 409,
                route: "grant",
            });
        }
        self.call(format!("grant {action} {approval} {run}"));
        self.grants.lock().unwrap().insert(action.into(), approval.to_string());
        Ok(())
    }

    async fn close_grant(&self, _: &CompanyScope, action: &str, approval: &ApprovalId) -> Result<(), SandboxError> {
        self.call(format!("close {action} {approval}"));
        if self.close_down {
            return Err(SandboxError::Unreachable { route: "grant" });
        }
        let mut grants = self.grants.lock().unwrap();
        if grants.get(action).is_some_and(|a| a == approval.as_str()) {
            grants.remove(action);
        }
        Ok(())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Plays a script like the real harness: numbered lines on stdout, decisions and cancel on stdin.
async fn fake_harness(
    script: Vec<Step>,
    out: mpsc::Sender<ProcessEvent>,
    mut stdin: mpsc::UnboundedReceiver<String>,
    grants: Grants,
    probes: Arc<Mutex<Vec<bool>>>,
) {
    let deploy_open = || grants.lock().unwrap().contains_key("deploy");
    let mut seq = 0;
    let mut emit = async |event: HarnessEvent| {
        let line = serde_json::to_string(&EventLine {
            v: EVENT_VERSION,
            seq,
            event,
        })
        .unwrap();
        seq += 1;
        let _ = out.send(ProcessEvent::Line(line)).await;
    };
    let end = |outcome| HarnessEvent::Result {
        outcome,
        reason: None,
        text: String::new(),
        turns: 1,
        usage: Usage::default(),
    };
    for step in script {
        match step {
            Step::Emit(event) => emit(event).await,
            Step::Garbage => {
                let _ = out.send(ProcessEvent::Line("{\"not\":\"an event\"}".into())).await;
            }
            Step::Probe => probes.lock().unwrap().push(deploy_open()),
            Step::ProbeAfterClose => {
                for _ in 0..400 {
                    if !deploy_open() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                probes.lock().unwrap().push(deploy_open());
            }
            Step::AwaitDecision | Step::Hang => {
                let Some(line) = stdin.recv().await else { break };
                match serde_json::from_str::<HarnessInput>(line.trim()).unwrap() {
                    HarnessInput::ApprovalDecision { outcome, .. } => {
                        if outcome == oryxa_fde_agent::ApprovalOutcome::Rejected {
                            emit(end(Outcome::Rejected)).await;
                            break;
                        }
                    }
                    HarnessInput::Cancel => {
                        emit(end(Outcome::Cancelled)).await;
                        break;
                    }
                }
            }
        }
    }
    let _ = out
        .send(ProcessEvent::Exited {
            code: Some(0),
            timed_out: false,
        })
        .await;
}

#[derive(Default)]
struct FakeLive {
    lines: Mutex<Vec<String>>,
}

impl LiveOutput for FakeLive {
    async fn publish(&self, _: &ProjectScope, _: &AgentRunId, lines: Vec<String>) -> Result<(), LiveError> {
        self.lines.lock().unwrap().extend(lines);
        Ok(())
    }
}

/// The in-memory store, made to fail one thing.
struct Failing<S>(S, Fail);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fail {
    /// Approval requests cannot be kept.
    Approvals,
    /// The run's hold on the sandbox is refused, as if another run had been given it.
    Renewals,
}

impl<S: RunStore> RunStore for Failing<S> {
    async fn create(&self, run: &RunRecord) -> Result<(), StoreError> {
        self.0.create(run).await
    }
    async fn run(&self, scope: &ProjectScope, id: &AgentRunId) -> Result<Option<RunRecord>, StoreError> {
        self.0.run(scope, id).await
    }
    async fn runs(&self, scope: &ProjectScope) -> Result<Vec<RunRecord>, StoreError> {
        self.0.runs(scope).await
    }
    async fn update(&self, run: &RunRecord) -> Result<(), StoreError> {
        self.0.update(run).await
    }
    async fn append_event(&self, scope: &ProjectScope, run: &AgentRunId, line: &EventLine) -> Result<(), StoreError> {
        self.0.append_event(scope, run, line).await
    }
    async fn events(&self, scope: &ProjectScope, run: &AgentRunId) -> Result<Vec<EventLine>, StoreError> {
        self.0.events(scope, run).await
    }
    async fn add_approval(&self, scope: &ProjectScope, approval: &ApprovalRecord) -> Result<(), StoreError> {
        if self.1 == Fail::Approvals {
            return Err(StoreError::Unavailable);
        }
        self.0.add_approval(scope, approval).await
    }
    async fn approvals(&self, scope: &ProjectScope, run: &AgentRunId) -> Result<Vec<ApprovalRecord>, StoreError> {
        self.0.approvals(scope, run).await
    }
    async fn decide(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        approval: &ApprovalId,
        decided: &Decided,
    ) -> Result<DecideResult, StoreError> {
        self.0.decide(scope, run, approval, decided).await
    }
    async fn request_cancel(&self, scope: &ProjectScope, run: &AgentRunId, by: &UserId) -> Result<bool, StoreError> {
        self.0.request_cancel(scope, run, by).await
    }
    async fn cancel_requested(&self, scope: &ProjectScope, run: &AgentRunId) -> Result<bool, StoreError> {
        self.0.cancel_requested(scope, run).await
    }
    async fn budget(&self, scope: &ProjectScope) -> Result<Option<Budget>, StoreError> {
        self.0.budget(scope).await
    }
    async fn set_budget(&self, scope: &ProjectScope, budget: Budget, by: &UserId) -> Result<(), StoreError> {
        self.0.set_budget(scope, budget, by).await
    }
    async fn spend(&self, scope: &ProjectScope) -> Result<Spend, StoreError> {
        self.0.spend(scope).await
    }
    async fn take_sandbox(&self, scope: &ProjectScope, run: &AgentRunId, lease: Duration) -> Result<bool, StoreError> {
        self.0.take_sandbox(scope, run, lease).await
    }
    async fn renew_sandbox(&self, scope: &ProjectScope, run: &AgentRunId, lease: Duration) -> Result<bool, StoreError> {
        if self.1 == Fail::Renewals {
            return Ok(false);
        }
        self.0.renew_sandbox(scope, run, lease).await
    }
    async fn reserve(
        &self,
        scope: &ProjectScope,
        run: &AgentRunId,
        default: Budget,
        max_run: Duration,
    ) -> Result<Option<Remaining>, StoreError> {
        self.0.reserve(scope, run, default, max_run).await
    }
    async fn finish(&self, run: &RunRecord, used: Spend, outcome: RunOutcome) -> Result<(), StoreError> {
        self.0.finish(run, used, outcome).await
    }
}

struct Test;
impl Deps for Test {
    type Store = InMemoryRuns;
    type Sandbox = FakeSandbox;
    type Live = FakeLive;
    type Context = InMemoryContext;
    type Access = FakeAccess;
}

struct TestFailingStore;
impl Deps for TestFailingStore {
    type Store = Failing<InMemoryRuns>;
    type Sandbox = FakeSandbox;
    type Live = FakeLive;
    type Context = InMemoryContext;
    type Access = FakeAccess;
}

// ---- Sample world --------------------------------------------------------------------------------------------
//
// org_a has cmp_1 (projects prj_1, prj_3) and cmp_2 (prj_2); org_b has its own cmp_1 with prj_1.
// usr_lead works and manages prj_1 and prj_3; usr_other works on prj_2 only; usr_b works on org_b's prj_1.

fn scope(tenant: &str, company: &str, project: &str) -> ProjectScope {
    CompanyScope::new(TenantId::new(tenant).unwrap(), CompanyId::new(company).unwrap())
        .project(ProjectId::new(project).unwrap())
}

fn caller(tenant: &str, user: &str) -> Caller {
    Caller {
        tenant: TenantId::new(tenant).unwrap(),
        user: UserId::new(user).unwrap(),
    }
}

fn access() -> FakeAccess {
    let mut a = FakeAccess::default();
    a.tokens.insert("lead", caller("org_a", "usr_lead"));
    a.tokens.insert("other", caller("org_a", "usr_other"));
    a.tokens.insert("b", caller("org_b", "usr_b"));
    for (t, p, c) in [
        ("org_a", "prj_1", "cmp_1"),
        ("org_a", "prj_3", "cmp_1"),
        ("org_a", "prj_2", "cmp_2"),
        ("org_b", "prj_1", "cmp_1"),
    ] {
        a.projects.insert(
            (TenantId::new(t).unwrap(), ProjectId::new(p).unwrap()),
            CompanyId::new(c).unwrap(),
        );
    }
    for (u, p, perm) in [
        ("usr_lead", "prj_1", "work"),
        ("usr_lead", "prj_1", "manage"),
        ("usr_lead", "prj_3", "work"),
        ("usr_other", "prj_2", "work"),
        ("usr_b", "prj_1", "work"),
    ] {
        a.grants
            .insert((UserId::new(u).unwrap(), ProjectId::new(p).unwrap(), perm));
    }
    a
}

fn context() -> InMemoryContext {
    let mut source = InMemoryContext::default();
    for s in [
        scope("org_a", "cmp_1", "prj_1"),
        scope("org_a", "cmp_1", "prj_3"),
        scope("org_a", "cmp_2", "prj_2"),
        scope("org_b", "cmp_1", "prj_1"),
    ] {
        source.insert(
            s,
            ProjectContext {
                scope_of_work: "Sample scope: a status page for the sample customer.".into(),
                success_criteria: vec![],
                decisions: vec![],
                conventions: vec![],
                config: AgentConfig {
                    model: "anthropic.claude-opus-5-5".into(),
                    region: "eu-west-1".into(),
                    max_turns: 40,
                    approvals: vec![ApprovalRule {
                        action: "deploy".into(),
                        tool: "Bash".into(),
                        pattern: Some("deploy".into()),
                    }],
                },
            },
        );
    }
    source
}

fn config() -> RunsConfig {
    RunsConfig {
        pricing: Pricing {
            input_usd_micros_per_mtok: 15_000_000,
            output_usd_micros_per_mtok: 75_000_000,
        },
        default_budget: Budget {
            minutes: 600,
            spend_usd_micros: 100_000_000,
        },
        max_run: Duration::from_secs(3600),
        grant_ttl: Duration::from_secs(900),
        grace: Duration::from_secs(5),
        poll: Duration::from_millis(20),
        lease: Duration::from_secs(2),
    }
}

fn runs_with(sandbox: FakeSandbox) -> Arc<Runs<Test>> {
    Runs::new(
        InMemoryRuns::default(),
        sandbox,
        FakeLive::default(),
        context(),
        access(),
        config(),
    )
}

fn tool_call(id: &str, title: &str) -> Step {
    Step::Emit(HarnessEvent::ToolCall {
        id: ToolCallId::new(id).unwrap(),
        title: title.into(),
        kind: ToolKind::Execute,
        status: ToolStatus::Completed,
    })
}

fn deploy_request() -> Step {
    Step::Emit(HarnessEvent::ApprovalRequest {
        id: ApprovalId::new("apr_1").unwrap(),
        tool_call_id: ToolCallId::new("toolu_d1").unwrap(),
        action: "deploy".into(),
        title: "Run: npx wrangler deploy".into(),
        tool: "Bash".into(),
        input: json!({ "command": "npx wrangler deploy" }),
    })
}

fn usage(input_tokens: u64, output_tokens: u64) -> Step {
    Step::Emit(HarnessEvent::Usage {
        usage: Usage {
            input_tokens,
            output_tokens,
        },
    })
}

fn result(outcome: Outcome) -> Step {
    Step::Emit(HarnessEvent::Result {
        outcome,
        reason: None,
        text: "Done.".into(),
        turns: 3,
        usage: Usage {
            input_tokens: 2000,
            output_tokens: 300,
        },
    })
}

fn message(text: &str) -> Step {
    Step::Emit(HarnessEvent::Message { text: text.into() })
}

// ---- HTTP helpers --------------------------------------------------------------------------------------------

async fn call(app: &Router, method: &str, path: &str, token: &str, body: Option<Value>) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

const RUNS_1: &str = "/v1/companies/cmp_1/projects/prj_1/agent-runs";

fn new_run() -> Value {
    json!({
        "task": "Add a /healthz endpoint to the API service, with a test.",
        "repository": { "owner": "sample-org", "name": "status-page", "base": "main" }
    })
}

async fn create(app: &Router) -> String {
    let (status, run) = call(app, "POST", RUNS_1, "lead", Some(new_run())).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{run}");
    assert_eq!(run["state"], "queued");
    run["id"].as_str().unwrap().to_owned()
}

/// Polls the run through the API until `done` holds (up to 200 seconds, of virtual time where it is paused).
async fn wait(app: &Router, run: &str, done: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..40_000 {
        let (status, body) = call(app, "GET", &format!("{RUNS_1}/{run}"), "lead", None).await;
        assert_eq!(status, StatusCode::OK);
        if done(&body) {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("run {run} never got there");
}

fn ended(run: &Value) -> bool {
    !run["ended_at"].is_null()
}

// ---- End to end ----------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_run_goes_end_to_end_through_an_approval_to_a_pull_request() {
    let runs = runs_with(FakeSandbox::new(vec![
        message("I'll add the endpoint, then deploy."),
        tool_call("toolu_1", "Run: npm test"),
        usage(1200, 180),
        deploy_request(),
        Step::AwaitDecision,
        // During the approved call, a deploy passes the gateway.
        Step::Probe,
        tool_call("toolu_d1", "Run: npx wrangler deploy"),
        // Once it returned, a second deploy is refused.
        Step::ProbeAfterClose,
        usage(2400, 360),
        result(Outcome::Success),
    ]));
    let app = api::router(runs.clone());
    let run = create(&app).await;

    let waiting = wait(&app, &run, |r| r["state"] == "waiting_for_approval").await;
    assert_eq!(waiting["pending_approval"], "apr_1");
    let (_, approvals) = call(&app, "GET", &format!("{RUNS_1}/{run}/approvals"), "lead", None).await;
    assert_eq!(approvals[0]["action"], "deploy");
    assert_eq!(approvals[0]["input"], json!({ "command": "npx wrangler deploy" }));
    assert!(approvals[0]["decision"].is_null());
    // The harness is held: nothing reached its stdin yet.
    assert!(runs.sandbox.log.lock().unwrap().stdin.is_empty());

    let (status, decided) = call(
        &app,
        "POST",
        &format!("{RUNS_1}/{run}/approvals/apr_1/approve"),
        "lead",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{decided}");
    assert_eq!(decided["decision"]["outcome"], "approved");
    assert_eq!(decided["decision"]["by"], "usr_lead");
    // A second decision is refused: the first stands.
    let (status, _) = call(
        &app,
        "POST",
        &format!("{RUNS_1}/{run}/approvals/apr_1/reject"),
        "lead",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let done = wait(&app, &run, ended).await;
    assert_eq!(done["state"], "finished");
    assert_eq!(done["usage"], json!({ "input_tokens": 2400, "output_tokens": 360 }));
    assert_eq!(
        done["delivery"],
        json!({ "status": "pull_request", "number": 7, "url": "https://github.com/sample-org/status-page/pull/7" })
    );

    // The sandbox saw the run in order: start, checkout, pack, harness, the grant for the approved action, its
    // decision, the grant closed, then the branch and the pull request.
    let calls = runs.sandbox.calls();
    let pos = |prefix: &str| calls.iter().position(|c| c.starts_with(prefix)).unwrap();
    assert!(pos("start cmp_1") < pos("exec rm"));
    assert!(pos("exec git") < pos(&format!("pack {run}")));
    assert!(pos(&format!("pack {run}")) < pos(&format!("harness {run}")));
    assert!(pos(&format!("harness {run}")) < pos(&format!("grant deploy apr_1 {run}")));
    assert!(pos("grant deploy apr_1") < pos("close deploy apr_1"));
    assert!(pos("close deploy apr_1") < pos("exec curl"));
    // The grant held for the approved call only: open during it, closed straight after, never reopened.
    assert_eq!(*runs.sandbox.probes.lock().unwrap(), [true, false]);
    assert_eq!(calls.iter().filter(|c| c.starts_with("grant ")).count(), 1);
    {
        let log = runs.sandbox.log.lock().unwrap();
        assert_eq!(
            log.stdin,
            ["{\"type\":\"approval_decision\",\"id\":\"apr_1\",\"outcome\":\"approved\"}\n"]
        );
        let push = log.execs.iter().find(|a| a.contains(&"push".to_owned())).unwrap();
        assert_eq!(push.last().unwrap(), &format!("HEAD:refs/heads/fde-agent/{run}"));
    }

    // The transcript is stored in full and went out live; the approval keeps its decision.
    let (_, events) = call(&app, "GET", &format!("{RUNS_1}/{run}/events"), "lead", None).await;
    assert_eq!(events["events"].as_array().unwrap().len(), 7);
    assert_eq!(runs.live.lines.lock().unwrap().len(), 7);

    // One bus event, ids and the outcome only.
    let outbox = runs.store.outbox();
    assert_eq!(outbox.len(), 1);
    assert_eq!(
        serde_json::to_value(&outbox[0]).unwrap(),
        json!({ "company": "cmp_1", "project": "prj_1", "agent_run": run, "outcome": "succeeded" })
    );

    // The run's use counts against the project's budget.
    let (_, budget) = call(
        &app,
        "GET",
        "/v1/companies/cmp_1/projects/prj_1/agent-budget",
        "lead",
        None,
    )
    .await;
    let expected = Pricing {
        input_usd_micros_per_mtok: 15_000_000,
        output_usd_micros_per_mtok: 75_000_000,
    }
    .cost(Usage {
        input_tokens: 2400,
        output_tokens: 360,
    });
    assert_eq!(budget["used"]["usd_micros"], expected);
}

#[tokio::test]
async fn a_rejection_ends_the_run_with_no_grant_and_no_branch() {
    let runs = runs_with(FakeSandbox::new(vec![
        deploy_request(),
        Step::AwaitDecision,
        result(Outcome::Success),
    ]));
    let app = api::router(runs.clone());
    let run = create(&app).await;
    wait(&app, &run, |r| r["state"] == "waiting_for_approval").await;
    let (status, _) = call(
        &app,
        "POST",
        &format!("{RUNS_1}/{run}/approvals/apr_1/reject"),
        "lead",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["state"], "failed");
    assert_eq!(done["failure"], "approval_rejected");
    assert_eq!(done["delivery"]["status"], "none");
    let calls = runs.sandbox.calls();
    assert!(
        !calls.iter().any(|c| c.starts_with("grant") || c == "exec curl"),
        "{calls:?}"
    );
    assert_eq!(runs.store.outbox()[0].outcome, RunOutcome::Rejected);
}

#[tokio::test]
async fn cancel_stops_a_run_that_is_stuck() {
    let runs = runs_with(FakeSandbox::new(vec![message("Thinking."), Step::Hang]));
    let app = api::router(runs.clone());
    let run = create(&app).await;
    wait(&app, &run, |r| r["state"] == "running").await;
    let (status, _) = call(&app, "POST", &format!("{RUNS_1}/{run}/cancel"), "lead", None).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["failure"], "cancelled");
    assert_eq!(runs.sandbox.log.lock().unwrap().stdin, ["{\"type\":\"cancel\"}\n"]);
    assert_eq!(runs.store.outbox()[0].outcome, RunOutcome::Cancelled);
    // An ended run cannot be cancelled again.
    let (status, _) = call(&app, "POST", &format!("{RUNS_1}/{run}/cancel"), "lead", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn a_run_stops_when_its_spend_budget_runs_out() {
    let runs = runs_with(FakeSandbox::new(vec![
        usage(1000, 100),
        usage(1_000_000, 100_000),
        Step::Hang,
    ]));
    let app = api::router(runs.clone());
    // 1 dollar: the second report costs 15 + 7.5 dollars.
    let budget = json!({ "minutes": 600, "spend_usd_micros": 1_000_000 });
    let (status, _) = call(
        &app,
        "PUT",
        "/v1/companies/cmp_1/projects/prj_1/agent-budget",
        "lead",
        Some(budget),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let run = create(&app).await;
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["failure"], "over_budget");
    assert_eq!(runs.sandbox.log.lock().unwrap().stdin, ["{\"type\":\"cancel\"}\n"]);
    // The budget is used up, so the next run is refused before it starts.
    let (status, body) = call(&app, "POST", RUNS_1, "lead", Some(new_run())).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"], "rejected_over_budget");
}

#[tokio::test(start_paused = true)]
async fn a_run_stops_when_its_minutes_run_out() {
    let runs = runs_with(FakeSandbox::new(vec![message("Working."), Step::Hang]));
    let app = api::router(runs.clone());
    let budget = json!({ "minutes": 2, "spend_usd_micros": 100_000_000 });
    call(
        &app,
        "PUT",
        "/v1/companies/cmp_1/projects/prj_1/agent-budget",
        "lead",
        Some(budget),
    )
    .await;
    let run = create(&app).await;
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["failure"], "over_budget");
    let (_, budget) = call(
        &app,
        "GET",
        "/v1/companies/cmp_1/projects/prj_1/agent-budget",
        "lead",
        None,
    )
    .await;
    let seconds = budget["used"]["seconds"].as_u64().unwrap();
    assert!((120..=121).contains(&seconds), "{seconds}");
}

#[tokio::test]
async fn only_a_company_manager_sets_a_budget_and_bounds_hold() {
    let app = api::router(runs_with(FakeSandbox::new(vec![])));
    let path = "/v1/companies/cmp_1/projects/prj_3/agent-budget";
    let (status, _) = call(
        &app,
        "PUT",
        path,
        "lead",
        Some(json!({ "minutes": 10, "spend_usd_micros": 1 })),
    )
    .await;
    // usr_lead works on prj_3 but does not manage it.
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, budget) = call(&app, "GET", path, "lead", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        budget["budget"],
        json!({ "minutes": 600, "spend_usd_micros": 100_000_000 })
    );
    let huge = json!({ "minutes": 10, "spend_usd_micros": u64::MAX });
    let (status, _) = call(
        &app,
        "PUT",
        "/v1/companies/cmp_1/projects/prj_1/agent-budget",
        "lead",
        Some(huge),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// ---- Isolation -----------------------------------------------------------------------------------------------

#[tokio::test]
async fn runs_and_approvals_stay_inside_their_company_and_tenant() {
    let runs = runs_with(FakeSandbox::new(vec![deploy_request(), Step::AwaitDecision]));
    let app = api::router(runs.clone());
    let run = create(&app).await;
    wait(&app, &run, |r| r["state"] == "waiting_for_approval").await;

    // Another user of the same tenant, without work on cmp_1/prj_1: refused everywhere on it.
    for (method, path) in [
        ("GET", RUNS_1.to_owned()),
        ("POST", RUNS_1.to_owned()),
        ("GET", format!("{RUNS_1}/{run}")),
        ("GET", format!("{RUNS_1}/{run}/events")),
        ("GET", format!("{RUNS_1}/{run}/approvals")),
        ("POST", format!("{RUNS_1}/{run}/approvals/apr_1/approve")),
        ("POST", format!("{RUNS_1}/{run}/cancel")),
    ] {
        let body = (method == "POST" && path == RUNS_1).then(new_run);
        let (status, _) = call(&app, method, &path, "other", body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }

    // Another tenant with its own cmp_1/prj_1 (same ids): its own empty project, never org_a's.
    let (status, list) = call(&app, "GET", RUNS_1, "b", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list, json!([]));
    for (method, path) in [
        ("GET", format!("{RUNS_1}/{run}")),
        ("GET", format!("{RUNS_1}/{run}/approvals")),
        ("POST", format!("{RUNS_1}/{run}/approvals/apr_1/approve")),
        ("POST", format!("{RUNS_1}/{run}/cancel")),
    ] {
        let (status, _) = call(&app, method, &path, "b", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
    }

    // The same user through another project they work on: the run is not there.
    let other_project = format!("/v1/companies/cmp_1/projects/prj_3/agent-runs/{run}");
    for suffix in ["", "/approvals", "/approvals/apr_1/approve"] {
        let method = if suffix.ends_with("approve") { "POST" } else { "GET" };
        let (status, _) = call(&app, method, &format!("{other_project}{suffix}"), "lead", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{suffix}");
    }

    // A project addressed through a company it is not in is refused, even for someone who works on it.
    let (status, _) = call(
        &app,
        "GET",
        "/v1/companies/cmp_2/projects/prj_1/agent-runs",
        "lead",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // None of that touched the run: it still waits, undecided.
    let (_, approvals) = call(&app, "GET", &format!("{RUNS_1}/{run}/approvals"), "lead", None).await;
    assert!(approvals[0]["decision"].is_null());
    assert!(runs.sandbox.log.lock().unwrap().stdin.is_empty());
}

#[tokio::test]
async fn requests_without_a_valid_token_or_with_authz_down_are_refused() {
    let app = api::router(runs_with(FakeSandbox::new(vec![])));
    let (status, _) = call(&app, "GET", RUNS_1, "nobody", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let mut down = access();
    down.down = true;
    let runs = Runs::<Test>::new(
        InMemoryRuns::default(),
        FakeSandbox::new(vec![]),
        FakeLive::default(),
        context(),
        down,
        config(),
    );
    let (status, body) = call(&api::router(runs), "GET", RUNS_1, "lead", None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "unavailable");
}

#[tokio::test]
async fn bad_input_is_refused_before_a_run_exists() {
    let runs = runs_with(FakeSandbox::new(vec![]));
    let app = api::router(runs.clone());
    for body in [
        json!({ "task": "", "repository": { "owner": "o", "name": "r", "base": "main" } }),
        json!({ "task": "x", "repository": { "owner": "o", "name": "r", "base": "--upload-pack=sh" } }),
        json!({ "task": "x\u{0}y", "repository": { "owner": "o", "name": "r", "base": "main" } }),
    ] {
        let (status, _) = call(&app, "POST", RUNS_1, "lead", Some(body.clone())).await;
        assert!(status.is_client_error(), "{body}");
    }
    let (status, _) = call(
        &app,
        "GET",
        "/v1/companies/cmp_1/projects/prj_1/agent-runs/run%7C1",
        "lead",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(runs.sandbox.calls().is_empty());
}

// ---- Fail closed ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_pack_that_differs_on_disk_never_starts_the_harness() {
    let mut sandbox = FakeSandbox::new(vec![result(Outcome::Success)]);
    sandbox.tamper_pack = true;
    let runs = runs_with(sandbox);
    let app = api::router(runs.clone());
    let run = create(&app).await;
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["failure"], "setup_failed");
    assert!(!runs.sandbox.calls().iter().any(|c| c.starts_with("harness")));
}

#[tokio::test]
async fn a_decision_that_cannot_reach_the_harness_fails_the_run_and_stops_the_sandbox() {
    let mut sandbox = FakeSandbox::new(vec![deploy_request(), Step::AwaitDecision, result(Outcome::Success)]);
    sandbox.stdin_down = true;
    let runs = runs_with(sandbox);
    let app = api::router(runs.clone());
    let run = create(&app).await;
    wait(&app, &run, |r| r["state"] == "waiting_for_approval").await;
    call(
        &app,
        "POST",
        &format!("{RUNS_1}/{run}/approvals/apr_1/approve"),
        "lead",
        None,
    )
    .await;
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["failure"], "decision_undelivered");
    assert!(runs.sandbox.calls().contains(&"stop cmp_1".to_owned()));
}

#[tokio::test]
async fn an_approval_whose_hosts_cannot_open_is_never_delivered() {
    let mut sandbox = FakeSandbox::new(vec![deploy_request(), Step::AwaitDecision, result(Outcome::Success)]);
    sandbox.grants_down = true;
    let runs = runs_with(sandbox);
    let app = api::router(runs.clone());
    let run = create(&app).await;
    wait(&app, &run, |r| r["state"] == "waiting_for_approval").await;
    call(
        &app,
        "POST",
        &format!("{RUNS_1}/{run}/approvals/apr_1/approve"),
        "lead",
        None,
    )
    .await;
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["failure"], "decision_undelivered");
    assert!(runs.sandbox.log.lock().unwrap().stdin.is_empty());
    assert!(runs.sandbox.calls().contains(&"stop cmp_1".to_owned()));
}

#[tokio::test]
async fn a_grant_that_cannot_close_after_its_call_fails_the_run_and_destroys_the_sandbox() {
    let mut sandbox = FakeSandbox::new(vec![
        deploy_request(),
        Step::AwaitDecision,
        tool_call("toolu_d1", "Run: npx wrangler deploy"),
        Step::Hang,
    ]);
    sandbox.close_down = true;
    let runs = runs_with(sandbox);
    let app = api::router(runs.clone());
    let run = create(&app).await;
    wait(&app, &run, |r| r["state"] == "waiting_for_approval").await;
    call(
        &app,
        "POST",
        &format!("{RUNS_1}/{run}/approvals/apr_1/approve"),
        "lead",
        None,
    )
    .await;
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["failure"], "grant_not_closed");
    let calls = runs.sandbox.calls();
    let close = calls.iter().position(|c| c == "close deploy apr_1").unwrap();
    assert_eq!(calls[close + 1], "stop cmp_1", "{calls:?}");
    // Nothing was delivered from a sandbox that may still have had the hosts open.
    assert!(!calls.iter().any(|c| c == "exec curl"), "{calls:?}");
}

#[tokio::test]
async fn a_run_that_loses_the_sandbox_destroys_it_and_ends() {
    let runs = Runs::<TestFailingStore>::new(
        Failing(InMemoryRuns::default(), Fail::Renewals),
        FakeSandbox::new(vec![message("Working."), Step::Hang]),
        FakeLive::default(),
        context(),
        access(),
        RunsConfig {
            lease: Duration::from_millis(200),
            ..config()
        },
    );
    let app = api::router(runs.clone());
    let run = create(&app).await;
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["failure"], "store_unavailable");
    assert!(runs.sandbox.calls().contains(&"stop cmp_1".to_owned()));
}

#[tokio::test]
async fn a_queued_run_can_be_cancelled_and_never_touches_the_sandbox() {
    let runs = runs_with(FakeSandbox::new(vec![message("first"), Step::Hang]));
    let app = api::router(runs.clone());
    let first = create(&app).await;
    wait(&app, &first, |r| r["state"] == "running").await;
    let second = create(&app).await;
    call(&app, "POST", &format!("{RUNS_1}/{second}/cancel"), "lead", None).await;
    let done = wait(&app, &second, ended).await;
    assert_eq!(done["failure"], "cancelled");
    assert!(!runs.sandbox.calls().iter().any(|c| c.contains(&second)));
    let (_, first) = call(&app, "GET", &format!("{RUNS_1}/{first}"), "lead", None).await;
    assert_eq!(first["state"], "running");
}

#[tokio::test]
async fn an_approval_request_the_store_cannot_keep_stops_the_run() {
    let runs = Runs::<TestFailingStore>::new(
        Failing(InMemoryRuns::default(), Fail::Approvals),
        FakeSandbox::new(vec![deploy_request(), Step::AwaitDecision, result(Outcome::Success)]),
        FakeLive::default(),
        context(),
        access(),
        config(),
    );
    let app = api::router(runs.clone());
    let (status, body) = call(&app, "POST", RUNS_1, "lead", Some(new_run())).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let run = body["id"].as_str().unwrap().to_owned();
    let id = AgentRunId::new(run.clone()).unwrap();
    let scope = scope("org_a", "cmp_1", "prj_1");
    for _ in 0..2000 {
        if runs.store.0.run(&scope, &id).await.unwrap().unwrap().ended_at.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let record = runs.store.0.run(&scope, &id).await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(record.run.state()).unwrap(),
        json!({ "state": "failed", "reason": "store_unavailable" })
    );
    // The harness was told to stop; nothing approved anything.
    assert_eq!(runs.sandbox.log.lock().unwrap().stdin, ["{\"type\":\"cancel\"}\n"]);
}

#[tokio::test]
async fn a_run_whose_approval_list_has_an_action_with_no_held_host_never_starts() {
    let mut sandbox = FakeSandbox::new(vec![result(Outcome::Success)]);
    sandbox.held = BTreeSet::new();
    let runs = runs_with(sandbox);
    let app = api::router(runs.clone());
    let run = create(&app).await;
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["failure"], "setup_failed");
    // Refused before the sandbox was even started.
    assert!(runs.sandbox.calls().is_empty(), "{:?}", runs.sandbox.calls());
}

#[tokio::test]
async fn an_approval_request_for_an_action_off_the_list_stops_the_run() {
    let runs = runs_with(FakeSandbox::new(vec![
        Step::Emit(HarnessEvent::ApprovalRequest {
            id: ApprovalId::new("apr_1").unwrap(),
            tool_call_id: ToolCallId::new("toolu_x").unwrap(),
            action: "customer_send".into(),
            title: "Send".into(),
            tool: "Bash".into(),
            input: json!({ "command": "curl https://hooks.example.com" }),
        }),
        Step::Hang,
    ]));
    let app = api::router(runs.clone());
    let run = create(&app).await;
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["failure"], "bad_output");
    let (_, approvals) = call(&app, "GET", &format!("{RUNS_1}/{run}/approvals"), "lead", None).await;
    assert_eq!(approvals, json!([]));
    assert!(!runs.sandbox.calls().iter().any(|c| c.starts_with("grant")));
}

#[tokio::test]
async fn output_that_is_not_a_harness_event_stops_the_run() {
    let runs = runs_with(FakeSandbox::new(vec![message("ok"), Step::Garbage, Step::Hang]));
    let app = api::router(runs.clone());
    let run = create(&app).await;
    let done = wait(&app, &run, ended).await;
    assert_eq!(done["failure"], "bad_output");
}

#[tokio::test]
async fn runs_in_one_company_take_turns_on_its_sandbox() {
    let runs = runs_with(FakeSandbox::new(vec![message("first"), Step::Hang]));
    let app = api::router(runs.clone());
    let first = create(&app).await;
    wait(&app, &first, |r| r["state"] == "running").await;
    let second = create(&app).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (_, waiting) = call(&app, "GET", &format!("{RUNS_1}/{second}"), "lead", None).await;
    assert_eq!(waiting["state"], "queued");
    call(&app, "POST", &format!("{RUNS_1}/{first}/cancel"), "lead", None).await;
    wait(&app, &first, ended).await;
    // The second run gets the sandbox once the first has ended (its script is spent, so it exits at once).
    let done = wait(&app, &second, ended).await;
    assert_eq!(done["failure"], "harness_exited");
    let (_, list) = call(&app, "GET", RUNS_1, "lead", None).await;
    assert_eq!(list[0]["id"], second.as_str());
}

// ---- On Postgres ----------------------------------------------------------------------------------------------

struct OnPostgres;
impl Deps for OnPostgres {
    type Store = oryxa_fde_store::Store;
    type Sandbox = FakeSandbox;
    type Live = FakeLive;
    type Context = InMemoryContext;
    type Access = FakeAccess;
}

/// A fresh tenant with org_a's sample company and project, in Postgres and in the fakes.
async fn postgres_world(store: &oryxa_fde_store::Store) -> (ProjectScope, FakeAccess, InMemoryContext) {
    use oryxa_fde_store::{Actor, CompanyIn, Name, ProjectIn, new_id};
    let tenant = new_id("org");
    let scope = scope(&tenant, "cmp_1", "prj_1");
    let by = Actor {
        user: UserId::new("usr_lead").unwrap(),
        request_id: new_id("req"),
    };
    let mut tx = store.company(&scope.company).await.unwrap();
    let company = CompanyIn {
        name: Name::new("Sample company").unwrap(),
        industry: None,
        region: None,
        summary: None,
    };
    tx.create(&company, &by).await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = store.project(&scope).await.unwrap();
    let project = ProjectIn {
        name: Name::new("Status page").unwrap(),
        summary: None,
    };
    tx.create(&project, &by).await.unwrap().unwrap();
    tx.commit().await.unwrap();

    let mut a = FakeAccess::default();
    a.tokens.insert("lead", caller(&tenant, "usr_lead"));
    a.projects.insert(
        (scope.tenant().clone(), scope.project.clone()),
        scope.company.company.clone(),
    );
    a.grants
        .insert((UserId::new("usr_lead").unwrap(), scope.project.clone(), "work"));
    let mut source = context();
    let sample = source_context();
    source.insert(scope.clone(), sample);
    (scope, a, source)
}

fn source_context() -> ProjectContext {
    ProjectContext {
        scope_of_work: "Sample scope: a status page for the sample customer.".into(),
        success_criteria: vec![],
        decisions: vec![],
        conventions: vec![],
        config: AgentConfig {
            model: "anthropic.claude-opus-5-5".into(),
            region: "eu-west-1".into(),
            max_turns: 40,
            approvals: vec![ApprovalRule {
                action: "deploy".into(),
                tool: "Bash".into(),
                pattern: Some("deploy".into()),
            }],
        },
    }
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_decision_made_on_another_api_task_reaches_the_run() {
    let store = oryxa_fde_store::testing::store().await;
    let (scope, access_a, context_a) = postgres_world(&store).await;
    let (access_b, context_b) = second_task(&scope, &access_a);
    // Two API tasks on one database: the run is driven by A, the FDE's decision lands on B.
    let a = Runs::<OnPostgres>::new(
        store.clone(),
        FakeSandbox::new(vec![
            deploy_request(),
            Step::AwaitDecision,
            tool_call("toolu_d1", "Run: deploy"),
            result(Outcome::Success),
        ]),
        FakeLive::default(),
        context_a,
        access_a,
        config(),
    );
    let b = Runs::<OnPostgres>::new(
        store.clone(),
        FakeSandbox::new(vec![]),
        FakeLive::default(),
        context_b,
        access_b,
        config(),
    );
    let (app_a, app_b) = (api::router(a.clone()), api::router(b));
    let path = format!(
        "/v1/companies/{}/projects/{}/agent-runs",
        scope.company.company, scope.project
    );
    let (status, created) = call(&app_a, "POST", &path, "lead", Some(new_run())).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{created}");
    let run = created["id"].as_str().unwrap().to_owned();

    let state = async |app: &Router| call(app, "GET", &format!("{path}/{run}"), "lead", None).await.1;
    for _ in 0..2000 {
        if state(&app_b).await["state"] == "waiting_for_approval" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let (status, decided) = call(
        &app_b,
        "POST",
        &format!("{path}/{run}/approvals/apr_1/approve"),
        "lead",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{decided}");
    for _ in 0..2000 {
        if !state(&app_b).await["ended_at"].is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let done = state(&app_b).await;
    assert_eq!(done["state"], "finished", "{done}");
    assert_eq!(done["delivery"]["status"], "pull_request");
    // Its use counts against the project's budget, in Postgres.
    let mut tx = store.project(&scope).await.unwrap();
    assert!(tx.agent_budget().await.unwrap().1.usd_micros > 0);
    tx.commit().await.unwrap();
}

/// A second API task's view of a `postgres_world`: the same tokens and grants, the same project context.
fn second_task(scope: &ProjectScope, access: &FakeAccess) -> (FakeAccess, InMemoryContext) {
    let a = FakeAccess {
        tokens: access.tokens.clone(),
        projects: access.projects.clone(),
        grants: access.grants.clone(),
        down: false,
    };
    let mut c = context();
    c.insert(scope.clone(), source_context());
    (a, c)
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn a_companys_sandbox_takes_one_run_at_a_time_across_api_tasks() {
    let store = oryxa_fde_store::testing::store().await;
    let (scope, access_a, context_a) = postgres_world(&store).await;
    let (access_b, context_b) = second_task(&scope, &access_a);
    let a = Runs::<OnPostgres>::new(
        store.clone(),
        FakeSandbox::new(vec![message("first"), Step::Hang]),
        FakeLive::default(),
        context_a,
        access_a,
        config(),
    );
    let b = Runs::<OnPostgres>::new(
        store.clone(),
        FakeSandbox::new(vec![result(Outcome::Success)]),
        FakeLive::default(),
        context_b,
        access_b,
        config(),
    );
    let (app_a, app_b) = (api::router(a.clone()), api::router(b.clone()));
    let path = format!(
        "/v1/companies/{}/projects/{}/agent-runs",
        scope.company.company, scope.project
    );
    let state = async |app: &Router, run: &str| call(app, "GET", &format!("{path}/{run}"), "lead", None).await.1;
    let until = async |app: &Router, run: &str, done: &dyn Fn(&Value) -> bool| {
        for _ in 0..2000 {
            let r = state(app, run).await;
            if done(&r) {
                return r;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("run {run} never got there: {}", state(app, run).await);
    };

    let (_, first) = call(&app_a, "POST", &path, "lead", Some(new_run())).await;
    let first = first["id"].as_str().unwrap().to_owned();
    until(&app_a, &first, &|r| r["state"] == "running").await;
    // B's run waits for the sandbox A's run holds: B's gateway is never called.
    let (_, second) = call(&app_b, "POST", &path, "lead", Some(new_run())).await;
    let second = second["id"].as_str().unwrap().to_owned();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(state(&app_b, &second).await["state"], "queued");
    assert!(b.sandbox.calls().is_empty(), "{:?}", b.sandbox.calls());

    // Once A's run ends, B's takes the sandbox and runs to the end.
    call(&app_b, "POST", &format!("{path}/{first}/cancel"), "lead", None).await;
    until(&app_a, &first, &|r| !r["ended_at"].is_null()).await;
    let done = until(&app_b, &second, &|r| !r["ended_at"].is_null()).await;
    assert_eq!(done["state"], "finished", "{done}");
    assert!(b.sandbox.calls().contains(&"start cmp_1".to_owned()));
}
