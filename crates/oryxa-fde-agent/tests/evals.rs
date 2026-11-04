//! Evals end to end through the API, on sample data: suites linked to the project's criteria, runs in a fake
//! sandbox (the target, a script grader and the judge's model call are all commands there), results per case and
//! pass rates per criterion. Also the isolation of suites and results between companies and tenants.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use oryxa_core::{TenantId, UserId};
use oryxa_fde_agent::access::{Access, AccessError, Caller, Permission};
use oryxa_fde_agent::evals::{self, EvalDeps, Evals, JudgeConfig};
use oryxa_fde_agent::gateway::{Exec, ExecOutput, HarnessProcess, Sandbox, SandboxError};
use oryxa_fde_agent::live::Offline;
use oryxa_fde_agent::service::{Deps, Pricing, Runs, RunsConfig};
use oryxa_fde_agent::store::{Budget, InMemoryRuns};
use oryxa_fde_agent::{AgentConfig, ApprovalId, Criterion, InMemoryContext, ProjectContext};
use oryxa_fde_core::EvalRunId;
use oryxa_fde_core::{AgentRunId, CompanyId, CompanyScope, CriterionId, ProjectId, ProjectScope};
use oryxa_fde_evals::{EvalRun, EvalStore, InMemoryEvals, Report, SuiteId};
use serde_json::{Value, json};
use tower::ServiceExt;

// ---- Fakes -------------------------------------------------------------------------------------------------

#[derive(Default)]
struct FakeAccess {
    tokens: HashMap<&'static str, Caller>,
    projects: HashMap<(TenantId, ProjectId), CompanyId>,
    grants: HashSet<(UserId, ProjectId, &'static str)>,
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
        let in_company =
            self.projects.get(&(scope.tenant().clone(), scope.project.clone())) == Some(&scope.company.company);
        let name = match permission {
            Permission::Work => "work",
            Permission::Manage => "manage",
            Permission::View => "view",
        };
        Ok(caller.tenant == *scope.tenant()
            && in_company
            && self
                .grants
                .contains(&(caller.user.clone(), scope.project.clone(), name)))
    }
}

/// A sandbox whose commands are answered by `answer`; it records each one.
struct FakeSandbox {
    commands: Mutex<Vec<Exec>>,
    /// A harness an earlier agent run left may still run in the container.
    harness: std::sync::atomic::AtomicBool,
}

fn out(code: i32, stdout: &str) -> ExecOutput {
    ExecOutput {
        exit_code: Some(code),
        stdout: stdout.into(),
        stderr: String::new(),
        timed_out: false,
    }
}

/// The sample system under test, a script grader, and Bedrock behind the gateway for the judge.
fn answer(exec: &Exec) -> ExecOutput {
    let env = |k: &str| exec.env.get(k).cloned().unwrap_or_default();
    match exec.argv[0].as_str() {
        // The target: answers by case.
        "node" => match env("EVAL_CASE").as_str() {
            "c_up" => out(0, "yes\n"),
            "c_down" => out(0, "no\n"),
            "c_json" => out(0, "{\"status\": \"ok\"}"),
            _ => out(1, ""),
        },
        // A script grader: passes outputs that say ok.
        "python3" => out(if env("EVAL_OUTPUT").contains("ok") { 0 } else { 1 }, ""),
        "curl" => {
            let url = exec.argv.last().unwrap();
            assert_eq!(
                url,
                "https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-opus-5-5/converse"
            );
            let request: Value = serde_json::from_str(&exec.argv[11]).unwrap();
            let prompt = request["messages"][0]["content"][0]["text"].as_str().unwrap();
            assert!(prompt.contains("<rubric>\nAnswers the question.\n</rubric>"));
            let pass = prompt.contains("<output>\nyes");
            let text = format!("{{\"pass\": {pass}, \"score\": 1, \"reason\": \"Checked.\"}}");
            let body = json!({ "output": { "message": { "role": "assistant", "content": [{ "text": text }] } } });
            out(0, &format!("{body}\n200\n"))
        }
        other => panic!("unexpected command {other}"),
    }
}

impl Sandbox for FakeSandbox {
    async fn start(&self, _: &CompanyScope) -> Result<(), SandboxError> {
        Ok(())
    }
    async fn stop(&self, _: &CompanyScope) -> Result<(), SandboxError> {
        Ok(())
    }
    async fn harness_may_run(&self, _: &CompanyScope) -> Result<bool, SandboxError> {
        Ok(self.harness.load(std::sync::atomic::Ordering::SeqCst))
    }
    async fn exec(&self, _: &CompanyScope, exec: Exec) -> Result<ExecOutput, SandboxError> {
        let output = answer(&exec);
        self.commands.lock().unwrap().push(exec);
        Ok(output)
    }
    async fn write_pack(&self, _: &CompanyScope, _: &AgentRunId, _: Vec<u8>) -> Result<String, SandboxError> {
        unreachable!("evals write no pack")
    }
    async fn start_harness(
        &self,
        _: &CompanyScope,
        _: &AgentRunId,
        _: &str,
        _: Duration,
    ) -> Result<HarnessProcess, SandboxError> {
        unreachable!("evals start no harness")
    }
    async fn write_stdin(&self, _: &CompanyScope, _: &str, _: String) -> Result<(), SandboxError> {
        unreachable!("evals write no stdin")
    }
    async fn held_actions(&self, _: &CompanyScope) -> Result<BTreeSet<String>, SandboxError> {
        unreachable!("evals read no outbound policy")
    }
    async fn open_grant(
        &self,
        _: &CompanyScope,
        _: &str,
        _: &ApprovalId,
        _: &AgentRunId,
        _: Duration,
    ) -> Result<(), SandboxError> {
        unreachable!("evals open no grant")
    }
    async fn close_grant(&self, _: &CompanyScope, _: &str, _: &ApprovalId) -> Result<(), SandboxError> {
        unreachable!("evals close no grant")
    }
}

struct Test;
impl Deps for Test {
    type Store = InMemoryRuns;
    type Sandbox = FakeSandbox;
    type Live = Offline;
    type Context = InMemoryContext;
    type Access = FakeAccess;
}
impl EvalDeps for Test {
    type Evals = InMemoryEvals;
}

// ---- Sample world: as in tests/runs.rs, plus a customer guest who can only view org_a's prj_1 --------------

fn scope(tenant: &str, company: &str, project: &str) -> ProjectScope {
    CompanyScope::new(TenantId::new(tenant).unwrap(), CompanyId::new(company).unwrap())
        .project(ProjectId::new(project).unwrap())
}

fn crit(id: &str) -> CriterionId {
    CriterionId::new(id).unwrap()
}

fn world() -> (Arc<Evals<Test>>, Router) {
    let mut access = FakeAccess::default();
    for (token, tenant, user) in [
        ("lead", "org_a", "usr_lead"),
        ("other", "org_a", "usr_other"),
        ("guest", "org_a", "usr_guest"),
        ("b", "org_b", "usr_b"),
    ] {
        access.tokens.insert(
            token,
            Caller {
                tenant: TenantId::new(tenant).unwrap(),
                user: UserId::new(user).unwrap(),
            },
        );
    }
    let mut context = InMemoryContext::default();
    for (t, c, p) in [
        ("org_a", "cmp_1", "prj_1"),
        ("org_a", "cmp_1", "prj_3"),
        ("org_a", "cmp_2", "prj_2"),
        ("org_b", "cmp_1", "prj_1"),
    ] {
        access.projects.insert(
            (TenantId::new(t).unwrap(), ProjectId::new(p).unwrap()),
            CompanyId::new(c).unwrap(),
        );
        context.insert(
            scope(t, c, p),
            ProjectContext {
                scope_of_work: "Sample scope.".into(),
                success_criteria: ["crit_accuracy", "crit_format"]
                    .map(|id| Criterion {
                        id: crit(id),
                        text: "Sample criterion.".into(),
                    })
                    .into(),
                decisions: vec![],
                conventions: vec![],
                config: AgentConfig {
                    model: "anthropic.claude-opus-5-5".into(),
                    region: "eu-west-1".into(),
                    max_turns: 40,
                    approvals: vec![],
                },
            },
        );
    }
    for (u, p, perm) in [
        ("usr_lead", "prj_1", "work"),
        ("usr_lead", "prj_1", "view"),
        ("usr_lead", "prj_3", "work"),
        ("usr_other", "prj_2", "work"),
        ("usr_guest", "prj_1", "view"),
        ("usr_b", "prj_1", "work"),
        ("usr_b", "prj_1", "view"),
    ] {
        access
            .grants
            .insert((UserId::new(u).unwrap(), ProjectId::new(p).unwrap(), perm));
    }
    let config = RunsConfig {
        pricing: Pricing {
            input_usd_micros_per_mtok: 0,
            output_usd_micros_per_mtok: 0,
        },
        default_budget: Budget {
            minutes: 60,
            spend_usd_micros: 1,
        },
        max_run: Duration::from_secs(60),
        grant_ttl: Duration::from_secs(60),
        grace: Duration::from_secs(5),
        poll: Duration::from_millis(20),
        lease: Duration::from_secs(2),
    };
    let sandbox = FakeSandbox {
        commands: Mutex::new(vec![]),
        harness: std::sync::atomic::AtomicBool::new(false),
    };
    let runs = Runs::<Test>::new(InMemoryRuns::default(), sandbox, Offline, context, access, config);
    let judge = JudgeConfig {
        model: "anthropic.claude-opus-5-5".into(),
        region: "eu-west-1".into(),
    };
    let evals = Evals::new(runs, InMemoryEvals::default(), judge);
    let router = evals::router(evals.clone());
    (evals, router)
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: &str,
    body: Option<(&str, String)>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", format!("Bearer {token}"));
    let body = match body {
        Some((content_type, body)) => {
            request = request.header("content-type", content_type);
            Body::from(body)
        }
        None => Body::empty(),
    };
    let response = app.clone().oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn json_body(value: Value) -> Option<(&'static str, String)> {
    Some(("application/json", value.to_string()))
}

fn csv_body(text: &str) -> Option<(&'static str, String)> {
    Some(("text/csv", text.to_owned()))
}

const P1: &str = "/v1/companies/cmp_1/projects/prj_1";

async fn create_suite(app: &Router, suite: Value) -> String {
    let (status, body) = call(app, "POST", &format!("{P1}/eval-suites"), "lead", json_body(suite)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["id"].as_str().unwrap().to_owned()
}

async fn finished(app: &Router, run: &str) -> Value {
    for _ in 0..2000 {
        let (status, body) = call(app, "GET", &format!("{P1}/eval-runs/{run}"), "lead", None).await;
        assert_eq!(status, StatusCode::OK);
        if body["state"] == "finished" {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("eval run {run} never finished");
}

fn answer_suite() -> Value {
    json!({
        "name": "Answers",
        "criteria": ["crit_accuracy", "crit_format"],
        "target": { "argv": ["node", "eval/answer.mjs"], "timeout_secs": 30 },
        "graders": [
            { "kind": "exact_match", "ignore_case": true },
            { "kind": "judge", "rubric": "Answers the question." }
        ],
        "cases": [
            { "id": "c_up", "input": "Is the API up?", "expected": "YES", "criteria": ["crit_accuracy"] },
            { "id": "c_down", "input": "Is the DB up?", "expected": "yes", "criteria": ["crit_accuracy"] }
        ]
    })
}

// ---- End to end ----------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_suite_runs_in_the_sandbox_and_rolls_up_to_criterion_pass_rates() {
    let (evals, app) = world();
    let suite = create_suite(&app, answer_suite()).await;
    // A case from CSV: no criteria of its own, so it measures both; its target fails.
    let (status, with_csv) = call(
        &app,
        "POST",
        &format!("{P1}/eval-suites/{suite}/cases"),
        "lead",
        csv_body("id,input,expected\nc_broken,\"Is the queue up?\",yes\n"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{with_csv}");
    assert_eq!(with_csv["cases"].as_array().unwrap().len(), 3);

    let (status, run) = call(&app, "POST", &format!("{P1}/eval-suites/{suite}/runs"), "lead", None).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{run}");
    let run = run["id"].as_str().unwrap().to_owned();
    let done = finished(&app, &run).await;
    let report = &done["report"];

    let outcome = |case: &str| {
        report["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["case"] == case)
            .unwrap()
            .clone()
    };
    // c_up: the output matches (ignoring case) and the judge passes it.
    assert_eq!(outcome("c_up")["outcome"], "passed");
    assert_eq!(outcome("c_up")["output"], "yes\n");
    assert_eq!(
        outcome("c_up")["verdicts"][1],
        json!({ "verdict": "passed", "score": 1.0 })
    );
    // c_down: both graders fail it.
    assert_eq!(outcome("c_down")["outcome"], "failed");
    assert_eq!(
        outcome("c_down")["verdicts"][0],
        json!({ "verdict": "failed", "reason": "differs from the expected output" })
    );
    // c_broken: the target failed, so it is errored and never graded.
    assert_eq!(outcome("c_broken")["outcome"], "errored");
    assert_eq!(outcome("c_broken")["verdicts"], json!([]));

    assert_eq!(
        (
            report["passed"].clone(),
            report["failed"].clone(),
            report["errored"].clone()
        ),
        (json!(1), json!(1), json!(1))
    );
    // Accuracy: c_up, c_down and c_broken measure it; one passed. Format: only c_broken, which errored.
    assert_eq!(
        report["criteria"],
        json!([
            { "criterion": "crit_accuracy", "passed": 1, "total": 3, "rate": 1.0 / 3.0 },
            { "criterion": "crit_format", "passed": 0, "total": 1, "rate": 0.0 }
        ])
    );

    // One bus event: ids and counts, an errored case counted as failed.
    assert_eq!(
        serde_json::to_value(&evals.store.outbox()[0]).unwrap(),
        json!({ "company": "cmp_1", "project": "prj_1", "eval_run": run, "passed": 1, "failed": 2 })
    );

    // The customer's guest sees the pass rates, and nothing else.
    let (status, rates) = call(&app, "GET", &format!("{P1}/eval-criteria"), "guest", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rates.as_array().unwrap().len(), 2);
    assert_eq!(rates[0]["suite"], suite.as_str());
    assert_eq!(rates[0]["criterion"], "crit_accuracy");
    for path in [format!("{P1}/eval-suites"), format!("{P1}/eval-runs/{run}")] {
        let (status, _) = call(&app, "GET", &path, "guest", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}");
    }
}

#[tokio::test]
async fn imported_results_are_graded_without_the_target() {
    let (evals, app) = world();
    let suite = create_suite(
        &app,
        json!({
            "name": "Status JSON",
            "criteria": ["crit_format"],
            "graders": [
                { "kind": "regex", "pattern": "^\\{" },
                { "kind": "json_schema", "schema": {
                    "type": "object", "required": ["status"], "properties": { "status": { "enum": ["ok", "degraded"] } }
                } },
                { "kind": "script", "argv": ["python3", "eval/grade.py"], "timeout_secs": 10 }
            ],
            "cases": [
                { "id": "c1", "input": "status" },
                { "id": "c2", "input": "status" },
                { "id": "c3", "input": "status" }
            ]
        }),
    )
    .await;
    // No target: only imported outputs can be graded.
    let (status, _) = call(&app, "POST", &format!("{P1}/eval-suites/{suite}/runs"), "lead", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) = call(
        &app,
        "POST",
        &format!("{P1}/eval-suites/{suite}/results"),
        "lead",
        csv_body("case,output\nnot_a_case,x\n"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let results = "case,output\nc1,\"{\"\"status\"\": \"\"ok\"\"}\"\nc2,\"{\"\"status\"\": \"\"down\"\"}\"\n";
    let (status, run) = call(
        &app,
        "POST",
        &format!("{P1}/eval-suites/{suite}/results"),
        "lead",
        csv_body(results),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{run}");
    assert_eq!(run["imported"], true);
    let done = finished(&app, run["id"].as_str().unwrap()).await;
    let cases = done["report"]["cases"].as_array().unwrap();
    assert_eq!(cases[0]["outcome"], "passed");
    assert_eq!(cases[1]["outcome"], "failed");
    assert_eq!(
        cases[1]["verdicts"][1]["reason"],
        "/status: not one of the allowed values"
    );
    // c3 had no imported output.
    assert_eq!(cases[2]["outcome"], "errored");
    assert_eq!(cases[2]["error"], "no output was imported for this case");
    // The script grader ran in the sandbox with the output it graded; the target never ran.
    let commands = evals.runs.sandbox.commands.lock().unwrap();
    assert!(commands.iter().all(|c| c.argv[0] == "python3"));
    assert_eq!(commands[0].env["EVAL_OUTPUT"], "{\"status\": \"ok\"}");
}

#[tokio::test]
async fn suites_that_could_not_run_as_written_are_refused() {
    let (_, app) = world();
    let mut bad = Vec::new();
    let mut s = answer_suite();
    s["criteria"] = json!(["crit_elsewhere"]);
    bad.push(s);
    let mut s = answer_suite();
    s["graders"] = json!([{ "kind": "regex", "pattern": "(" }]);
    bad.push(s);
    let mut s = answer_suite();
    s["graders"] = json!([{ "kind": "json_schema", "schema": { "oneOf": [] } }]);
    bad.push(s);
    let mut s = answer_suite();
    s["cases"][1]["id"] = json!("c_up");
    bad.push(s);
    for suite in bad {
        let (status, _) = call(
            &app,
            "POST",
            &format!("{P1}/eval-suites"),
            "lead",
            json_body(suite.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{suite}");
    }
    let suite = create_suite(&app, answer_suite()).await;
    // A case id the suite already has, and a malformed CSV.
    for csv in ["id,input\nc_up,again\n", "input,score\nx,1\n"] {
        let (status, _) = call(
            &app,
            "POST",
            &format!("{P1}/eval-suites/{suite}/cases"),
            "lead",
            csv_body(csv),
        )
        .await;
        assert!(status.is_client_error(), "{csv}");
    }
}

#[tokio::test]
async fn an_eval_run_waits_its_turn_on_the_company_sandbox() {
    let (evals, app) = world();
    let suite = create_suite(&app, answer_suite()).await;
    // Another run of the company holds the sandbox.
    let scope = CompanyScope::new(TenantId::new("org_a").unwrap(), CompanyId::new("cmp_1").unwrap())
        .project(ProjectId::new("prj_3").unwrap());
    let holder = EvalRun {
        id: EvalRunId::new("eval_holder").unwrap(),
        scope: scope.clone(),
        suite: SuiteId::new("suite_holder".to_owned()).unwrap(),
        imported: false,
        created_by: UserId::new("usr_lead").unwrap(),
        request_id: "req_1".into(),
        created_at: time::OffsetDateTime::now_utc(),
        ended_at: None,
        report: None,
    };
    evals.store.create_run(&holder).await.unwrap();
    assert!(
        evals
            .store
            .take_sandbox(&scope, &holder.id, Duration::from_secs(60))
            .await
            .unwrap()
    );
    let (_, run) = call(&app, "POST", &format!("{P1}/eval-suites/{suite}/runs"), "lead", None).await;
    let run = run["id"].as_str().unwrap().to_owned();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (_, waiting) = call(&app, "GET", &format!("{P1}/eval-runs/{run}"), "lead", None).await;
    assert_eq!(waiting["state"], "running");
    assert!(evals.runs.sandbox.commands.lock().unwrap().is_empty());
    // Its end lets the sandbox go.
    let report = Report {
        cases: vec![],
        criteria: vec![],
        passed: 0,
        failed: 0,
        errored: 0,
    };
    evals.store.finish(&holder, &report).await.unwrap();
    finished(&app, &run).await;
    assert!(!evals.runs.sandbox.commands.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_eval_never_runs_beside_a_harness_that_may_still_run() {
    let (evals, app) = world();
    let suite = create_suite(&app, answer_suite()).await;
    evals
        .runs
        .sandbox
        .harness
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (_, run) = call(&app, "POST", &format!("{P1}/eval-suites/{suite}/runs"), "lead", None).await;
    let done = finished(&app, run["id"].as_str().unwrap()).await;
    // Every case errors, so no criterion passes, and nothing ran in that container.
    assert_eq!(done["report"]["errored"], 2, "{done}");
    assert_eq!(done["report"]["cases"][0]["error"], "the sandbox could not start");
    assert!(evals.runs.sandbox.commands.lock().unwrap().is_empty());
}

#[tokio::test]
async fn imported_outputs_graded_without_the_sandbox_do_not_wait_for_it() {
    let (evals, app) = world();
    let suite = create_suite(
        &app,
        json!({
            "name": "Exact answers",
            "criteria": ["crit_accuracy"],
            "graders": [{ "kind": "exact_match" }],
            "cases": [{ "id": "c_1", "input": "2+2", "expected": "4" }],
        }),
    )
    .await;
    let scope = CompanyScope::new(TenantId::new("org_a").unwrap(), CompanyId::new("cmp_1").unwrap())
        .project(ProjectId::new("prj_1").unwrap());
    let holder = EvalRun {
        id: EvalRunId::new("eval_holder").unwrap(),
        scope: scope.clone(),
        suite: SuiteId::new(suite.clone()).unwrap(),
        imported: false,
        created_by: UserId::new("usr_lead").unwrap(),
        request_id: "req_1".into(),
        created_at: time::OffsetDateTime::now_utc(),
        ended_at: None,
        report: None,
    };
    evals.store.create_run(&holder).await.unwrap();
    assert!(
        evals
            .store
            .take_sandbox(&scope, &holder.id, Duration::from_secs(60))
            .await
            .unwrap()
    );
    let (status, run) = call(
        &app,
        "POST",
        &format!("{P1}/eval-suites/{suite}/results"),
        "lead",
        csv_body("case,output\nc_1,4\n"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{run}");
    let done = finished(&app, run["id"].as_str().unwrap()).await;
    assert_eq!(done["report"]["passed"], 1);
    assert!(evals.runs.sandbox.commands.lock().unwrap().is_empty());
}

// ---- Isolation -----------------------------------------------------------------------------------------------

#[tokio::test]
async fn suites_and_results_stay_inside_their_company_and_tenant() {
    let (_, app) = world();
    let suite = create_suite(&app, answer_suite()).await;
    let (_, run) = call(&app, "POST", &format!("{P1}/eval-suites/{suite}/runs"), "lead", None).await;
    let run = run["id"].as_str().unwrap().to_owned();
    finished(&app, &run).await;

    let paths = |base: &str| {
        vec![
            ("GET", format!("{base}/eval-suites")),
            ("GET", format!("{base}/eval-suites/{suite}")),
            ("POST", format!("{base}/eval-suites/{suite}/runs")),
            ("GET", format!("{base}/eval-runs")),
            ("GET", format!("{base}/eval-runs/{run}")),
            ("GET", format!("{base}/eval-criteria")),
        ]
    };
    // A user of the same tenant without access to prj_1: refused everywhere on it.
    for (method, path) in paths(P1) {
        let (status, _) = call(&app, method, &path, "other", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }
    // Another tenant with the same company and project ids sees only its own, empty project.
    for (method, path) in paths(P1) {
        let (status, body) = call(&app, method, &path, "b", None).await;
        match (
            method,
            path.ends_with("eval-suites") || path.ends_with("eval-runs") || path.ends_with("eval-criteria"),
        ) {
            ("GET", true) => assert_eq!((status, body), (StatusCode::OK, json!([])), "{path}"),
            _ => assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}"),
        }
    }
    // The same user through another project of the company (where they work but cannot view): not there.
    let expected = [
        (StatusCode::OK, json!([])),
        (StatusCode::NOT_FOUND, json!({ "error": "not_found" })),
        (StatusCode::NOT_FOUND, json!({ "error": "not_found" })),
        (StatusCode::OK, json!([])),
        (StatusCode::NOT_FOUND, json!({ "error": "not_found" })),
        (StatusCode::FORBIDDEN, json!({ "error": "forbidden" })),
    ];
    for ((method, path), want) in paths("/v1/companies/cmp_1/projects/prj_3").into_iter().zip(expected) {
        assert_eq!(call(&app, method, &path, "lead", None).await, want, "{method} {path}");
    }
    // A project through a company it is not in.
    let (status, _) = call(
        &app,
        "GET",
        "/v1/companies/cmp_2/projects/prj_1/eval-suites",
        "lead",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
