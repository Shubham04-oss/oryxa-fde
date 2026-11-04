//! The eval API, mounted with the agent run API: suites per project, runs in the company's sandbox, results per
//! case and pass rates per success criterion. Suites and runs need `work` on the project; the pass rates need
//! `view`, which the customer's guests hold. The suites, graders and runner are in `oryxa-fde-evals`; this module
//! gives them the company's sandbox and the model.
//!
//! An eval run takes its turn on the company's sandbox like an agent run, so it never grades a checkout an agent
//! is still changing.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::routing::{get, post};
use axum::{Json, Router};
use oryxa_fde_core::{CompanyId, CompanyScope, CriterionId, EvalRunId, ProjectId, ProjectScope};
use oryxa_fde_evals::import::{self, MAX_CSV_BYTES};
use oryxa_fde_evals::runner::{self, CriterionRate, Report, Source};
use oryxa_fde_evals::{
    Case, CaseId, Command, CommandOutput, EvalRun, EvalSandbox, EvalStore, EvalStoreError, Grader, Judge, JudgeFailed,
    SandboxFailed, Suite, SuiteId,
};
use oryxa_fde_events::EvalRunFinished;
use oryxa_fde_store::new_id;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use utoipa::{OpenApi, ToSchema};

use crate::access::{Access, Caller, Permission};
use crate::api::{Bearer, ErrorBody, RunsError};
use crate::context::ContextSource;
use crate::gateway::{Exec, Sandbox};
use crate::service::{Deps, Runs};

const BASE: &str = "/v1/companies/{company}/projects/{project}";

/// The run service's parts plus where suites and results live.
pub trait EvalDeps: Deps {
    type Evals: EvalStore;
}

/// The Bedrock model the judge grader uses, reached from the sandbox through the gateway like the agent's.
#[derive(Debug, Clone)]
pub struct JudgeConfig {
    pub model: String,
    pub region: String,
}

pub struct Evals<D: EvalDeps> {
    pub runs: Arc<Runs<D>>,
    pub store: D::Evals,
    pub judge: JudgeConfig,
}

impl<D: EvalDeps> Evals<D> {
    pub fn new(runs: Arc<Runs<D>>, store: D::Evals, judge: JudgeConfig) -> Arc<Self> {
        Arc::new(Self { runs, store, judge })
    }
}

pub fn router<D: EvalDeps>(evals: Arc<Evals<D>>) -> Router {
    Router::new()
        .route(
            &format!("{BASE}/eval-suites"),
            get(list_suites::<D>).post(create_suite::<D>),
        )
        .route(&format!("{BASE}/eval-suites/{{suite}}"), get(get_suite::<D>))
        .route(&format!("{BASE}/eval-suites/{{suite}}/cases"), post(import_cases::<D>))
        .route(&format!("{BASE}/eval-suites/{{suite}}/runs"), post(start_run::<D>))
        .route(
            &format!("{BASE}/eval-suites/{{suite}}/results"),
            post(import_results::<D>),
        )
        .route(&format!("{BASE}/eval-runs"), get(list_runs::<D>))
        .route(&format!("{BASE}/eval-runs/{{run}}"), get(get_run::<D>))
        .route(&format!("{BASE}/eval-criteria"), get(criteria::<D>))
        .layer(DefaultBodyLimit::max(MAX_CSV_BYTES))
        .with_state(evals)
}

impl<D: EvalDeps> FromRequestParts<Arc<Evals<D>>> for Caller {
    type Rejection = RunsError;

    async fn from_request_parts(parts: &mut Parts, evals: &Arc<Evals<D>>) -> Result<Self, RunsError> {
        Caller::from_request_parts(parts, &evals.runs).await
    }
}

impl From<EvalStoreError> for RunsError {
    fn from(e: EvalStoreError) -> Self {
        match e {
            EvalStoreError::NotFound => RunsError::NotFound,
            EvalStoreError::Conflict => RunsError::Rejected("conflict"),
            EvalStoreError::Unavailable => {
                tracing::error!("eval store unavailable");
                RunsError::Unavailable
            }
        }
    }
}

async fn authorize<D: EvalDeps>(
    evals: &Evals<D>,
    caller: &Caller,
    company: CompanyId,
    project: ProjectId,
    permission: Permission,
) -> Result<ProjectScope, RunsError> {
    let scope = CompanyScope::new(caller.tenant.clone(), company).project(project);
    if evals.runs.access.allowed(caller, &scope, permission).await? {
        Ok(scope)
    } else {
        Err(RunsError::Forbidden)
    }
}

fn ts(t: OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// The company's sandbox for one eval run: commands run as `agent` through the gateway.
struct CompanySandbox<'a, D: Deps> {
    runs: &'a Runs<D>,
    company: CompanyScope,
}

impl<D: Deps> EvalSandbox for CompanySandbox<'_, D> {
    async fn start(&self) -> Result<(), SandboxFailed> {
        self.runs.sandbox.start(&self.company).await.map_err(|_| SandboxFailed)
    }

    async fn run(
        &self,
        argv: &[String],
        env: BTreeMap<String, String>,
        timeout: Duration,
    ) -> Result<CommandOutput, SandboxFailed> {
        let exec = Exec {
            argv: argv.to_vec(),
            env,
            timeout,
        };
        let out = self
            .runs
            .sandbox
            .exec(&self.company, exec)
            .await
            .map_err(|_| SandboxFailed)?;
        Ok(CommandOutput {
            exit_code: out.exit_code,
            stdout: out.stdout,
            timed_out: out.timed_out,
        })
    }
}

/// Bedrock's Converse API, called from the company's sandbox so the gateway adds the model credential.
// ponytail: the judge runs where the target and script graders run; grading that must resist the agent's own
// leftovers in the sandbox needs a judge called from the API instead.
struct SandboxJudge<'a, D: Deps> {
    sandbox: &'a CompanySandbox<'a, D>,
    config: &'a JudgeConfig,
}

/// One argument to the gateway; a request larger than this is not sent.
const MAX_JUDGE_REQUEST: usize = 60 * 1024;

fn converse_url(config: &JudgeConfig) -> Option<String> {
    let token = |v: &str, extra: &[u8]| {
        !v.is_empty() && v.len() <= 128 && v.bytes().all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
    };
    if !token(&config.model, b".:_/-") || !token(&config.region, b"-") {
        return None;
    }
    let model = config.model.replace(':', "%3A").replace('/', "%2F");
    Some(format!(
        "https://bedrock-runtime.{}.amazonaws.com/model/{model}/converse",
        config.region
    ))
}

fn converse_text(curl_output: &str) -> Option<String> {
    let (body, status) = curl_output.trim_end().rsplit_once('\n')?;
    if status.trim() != "200" {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let text: String = value["output"]["message"]["content"]
        .as_array()?
        .iter()
        .filter_map(|block| block["text"].as_str())
        .collect();
    (!text.is_empty()).then_some(text)
}

impl<D: Deps> Judge for SandboxJudge<'_, D> {
    async fn complete(&self, system: &str, prompt: &str) -> Result<String, JudgeFailed> {
        let url = converse_url(self.config).ok_or(JudgeFailed)?;
        let request = serde_json::json!({
            "system": [{ "text": system }],
            "messages": [{ "role": "user", "content": [{ "text": prompt }] }],
            "inferenceConfig": { "maxTokens": 400, "temperature": 0 },
        })
        .to_string();
        if request.len() > MAX_JUDGE_REQUEST {
            return Err(JudgeFailed);
        }
        let argv: Vec<String> = [
            "curl",
            "-sS",
            "--max-time",
            "120",
            "-X",
            "POST",
            "-H",
            "content-type: application/json",
            "-H",
            "accept: application/json",
            "--data-binary",
            &request,
            "--write-out",
            "\n%{http_code}",
            &url,
        ]
        .map(String::from)
        .into();
        let out = self
            .sandbox
            .run(&argv, BTreeMap::new(), Duration::from_secs(150))
            .await
            .map_err(|_| JudgeFailed)?;
        if out.exit_code != Some(0) || out.timed_out {
            return Err(JudgeFailed);
        }
        converse_text(&out.stdout).ok_or(JudgeFailed)
    }
}

// ---- Views ---------------------------------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
pub struct SuiteIn {
    pub name: String,
    /// The project's success criteria this suite measures.
    #[schema(value_type = Vec<String>)]
    pub criteria: Vec<CriterionId>,
    /// Produces each case's output in the sandbox from `EVAL_CASE` and `EVAL_INPUT`; its stdout is the output.
    /// Without one, runs grade outputs imported as CSV.
    #[serde(default)]
    pub target: Option<Command>,
    pub graders: Vec<Grader>,
    #[serde(default)]
    pub cases: Vec<Case>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SuiteOut {
    pub id: String,
    pub name: String,
    pub criteria: Vec<String>,
    pub target: Option<Command>,
    pub graders: Vec<Grader>,
    pub cases: Vec<Case>,
}

impl From<Suite> for SuiteOut {
    fn from(s: Suite) -> Self {
        Self {
            id: s.id.to_string(),
            name: s.name,
            criteria: s.criteria.iter().map(ToString::to_string).collect(),
            target: s.target,
            graders: s.graders,
            cases: s.cases,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct EvalRunOut {
    pub id: String,
    pub suite: String,
    /// `running` or `finished`.
    pub state: String,
    pub imported: bool,
    pub created_by: String,
    pub created_at: String,
    pub ended_at: Option<String>,
    pub report: Option<Report>,
}

impl From<EvalRun> for EvalRunOut {
    fn from(r: EvalRun) -> Self {
        Self {
            id: r.id.to_string(),
            suite: r.suite.to_string(),
            state: if r.report.is_some() { "finished" } else { "running" }.into(),
            imported: r.imported,
            created_by: r.created_by.to_string(),
            created_at: ts(r.created_at),
            ended_at: r.ended_at.map(ts),
            report: r.report,
        }
    }
}

/// A criterion's pass rate in the latest finished run of a suite that measures it.
#[derive(Debug, Serialize, ToSchema)]
pub struct CriterionOut {
    pub suite: String,
    pub run: String,
    pub finished_at: Option<String>,
    #[serde(flatten)]
    pub rate: CriterionRate,
}

async fn project_criteria<D: EvalDeps>(evals: &Evals<D>, scope: &ProjectScope) -> Result<Vec<CriterionId>, RunsError> {
    let context = evals.runs.context.project_context(scope).await.map_err(|e| match e {
        crate::context::ContextError::NotFound => RunsError::NotFound,
        _ => RunsError::Unavailable,
    })?;
    Ok(context.success_criteria.into_iter().map(|c| c.id).collect())
}

// ---- Handlers ------------------------------------------------------------------------------------------------

/// Create an eval suite measuring some of the project's success criteria.
#[utoipa::path(post, operation_id = "create_eval_suite", path = "/v1/companies/{company}/projects/{project}/eval-suites",
    tag = "evals", request_body = SuiteIn,
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 201, body = SuiteOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody)))]
pub async fn create_suite<D: EvalDeps>(
    State(evals): State<Arc<Evals<D>>>,
    caller: Caller,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
    Json(body): Json<SuiteIn>,
) -> Result<(StatusCode, Json<SuiteOut>), RunsError> {
    let scope = authorize(&evals, &caller, c, p, Permission::Work).await?;
    let suite = Suite {
        id: SuiteId::new(new_id("suite")).map_err(|_| RunsError::Unavailable)?,
        scope: scope.clone(),
        name: body.name.trim().to_owned(),
        criteria: body.criteria,
        target: body.target,
        graders: body.graders,
        cases: body.cases,
    };
    suite
        .check(&project_criteria(&evals, &scope).await?)
        .map_err(|_| RunsError::Invalid("suite"))?;
    evals.store.create_suite(&suite).await?;
    Ok((StatusCode::CREATED, Json(suite.into())))
}

/// The project's eval suites, newest first.
#[utoipa::path(get, operation_id = "list_eval_suites", path = "/v1/companies/{company}/projects/{project}/eval-suites",
    tag = "evals",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [SuiteOut]), (status = 403, body = ErrorBody)))]
pub async fn list_suites<D: EvalDeps>(
    State(evals): State<Arc<Evals<D>>>,
    caller: Caller,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<SuiteOut>>, RunsError> {
    let scope = authorize(&evals, &caller, c, p, Permission::Work).await?;
    Ok(Json(
        evals.store.suites(&scope).await?.into_iter().map(Into::into).collect(),
    ))
}

/// One eval suite with its cases.
#[utoipa::path(get, operation_id = "get_eval_suite", path = "/v1/companies/{company}/projects/{project}/eval-suites/{suite}",
    tag = "evals",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("suite" = String, Path, description = "Eval suite id")),
    responses((status = 200, body = SuiteOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub async fn get_suite<D: EvalDeps>(
    State(evals): State<Arc<Evals<D>>>,
    caller: Caller,
    Path((c, p, suite)): Path<(CompanyId, ProjectId, SuiteId)>,
) -> Result<Json<SuiteOut>, RunsError> {
    let scope = authorize(&evals, &caller, c, p, Permission::Work).await?;
    let suite = evals.store.suite(&scope, &suite).await?.ok_or(RunsError::NotFound)?;
    Ok(Json(suite.into()))
}

/// Add cases from CSV (columns `input`, and optionally `expected`, `id`, `criteria`).
#[utoipa::path(post, operation_id = "import_eval_cases", path = "/v1/companies/{company}/projects/{project}/eval-suites/{suite}/cases",
    tag = "evals", request_body(content = String, content_type = "text/csv"),
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("suite" = String, Path, description = "Eval suite id")),
    responses((status = 200, body = SuiteOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody), (status = 409, body = ErrorBody, description = "A case id is already in the suite")))]
pub async fn import_cases<D: EvalDeps>(
    State(evals): State<Arc<Evals<D>>>,
    caller: Caller,
    Path((c, p, suite)): Path<(CompanyId, ProjectId, SuiteId)>,
    csv: Bytes,
) -> Result<Json<SuiteOut>, RunsError> {
    let scope = authorize(&evals, &caller, c, p, Permission::Work).await?;
    let existing = evals.store.suite(&scope, &suite).await?.ok_or(RunsError::NotFound)?;
    let cases = import::cases(&csv, || new_id("case")).map_err(|_| RunsError::Invalid("csv"))?;
    let mut all = existing.cases.clone();
    all.extend(cases.iter().cloned());
    existing.check_cases(&all).map_err(|_| RunsError::Invalid("cases"))?;
    Ok(Json(evals.store.add_cases(&scope, &suite, cases).await?.into()))
}

/// Run the suite: its target produces each case's output in the company's sandbox, and every grader grades it.
#[utoipa::path(post, operation_id = "start_eval_run", path = "/v1/companies/{company}/projects/{project}/eval-suites/{suite}/runs",
    tag = "evals",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("suite" = String, Path, description = "Eval suite id")),
    responses((status = 202, body = EvalRunOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody),
        (status = 409, body = ErrorBody, description = "The suite has no target or no cases")))]
pub async fn start_run<D: EvalDeps>(
    State(evals): State<Arc<Evals<D>>>,
    caller: Caller,
    Path((c, p, suite)): Path<(CompanyId, ProjectId, SuiteId)>,
) -> Result<(StatusCode, Json<EvalRunOut>), RunsError> {
    let scope = authorize(&evals, &caller, c, p, Permission::Work).await?;
    let suite = evals.store.suite(&scope, &suite).await?.ok_or(RunsError::NotFound)?;
    if suite.target.is_none() {
        return Err(RunsError::Rejected("no_target"));
    }
    launch(&evals, caller, suite, Source::Target).await
}

/// Grade outputs produced elsewhere: CSV with columns `case` and `output`, for cases of the suite.
#[utoipa::path(post, operation_id = "import_eval_results", path = "/v1/companies/{company}/projects/{project}/eval-suites/{suite}/results",
    tag = "evals", request_body(content = String, content_type = "text/csv"),
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("suite" = String, Path, description = "Eval suite id")),
    responses((status = 202, body = EvalRunOut), (status = 400, body = ErrorBody), (status = 403, body = ErrorBody),
        (status = 404, body = ErrorBody)))]
pub async fn import_results<D: EvalDeps>(
    State(evals): State<Arc<Evals<D>>>,
    caller: Caller,
    Path((c, p, suite)): Path<(CompanyId, ProjectId, SuiteId)>,
    csv: Bytes,
) -> Result<(StatusCode, Json<EvalRunOut>), RunsError> {
    let scope = authorize(&evals, &caller, c, p, Permission::Work).await?;
    let suite = evals.store.suite(&scope, &suite).await?.ok_or(RunsError::NotFound)?;
    let outputs = import::results(&csv).map_err(|_| RunsError::Invalid("csv"))?;
    let known: HashSet<&CaseId> = suite.cases.iter().map(|c| &c.id).collect();
    if outputs.keys().any(|k| !known.contains(k)) {
        return Err(RunsError::Invalid("case"));
    }
    launch(&evals, caller, suite, Source::Imported(outputs)).await
}

async fn launch<D: EvalDeps>(
    evals: &Arc<Evals<D>>,
    caller: Caller,
    suite: Suite,
    source: Source,
) -> Result<(StatusCode, Json<EvalRunOut>), RunsError> {
    if suite.cases.is_empty() {
        return Err(RunsError::Rejected("no_cases"));
    }
    let run = EvalRun {
        id: EvalRunId::new(new_id("eval")).map_err(|_| RunsError::Unavailable)?,
        scope: suite.scope.clone(),
        suite: suite.id.clone(),
        imported: matches!(source, Source::Imported(_)),
        created_by: caller.user,
        request_id: new_id("req"),
        created_at: OffsetDateTime::now_utc(),
        ended_at: None,
        report: None,
    };
    evals.store.create_run(&run).await?;
    tokio::spawn(execute(evals.clone(), suite, source, run.clone()));
    Ok((StatusCode::ACCEPTED, Json(run.into())))
}

/// Runs the suite on its turn on the company's sandbox, then records the report and `eval_run.finished` together.
async fn execute<D: EvalDeps>(evals: Arc<Evals<D>>, suite: Suite, source: Source, mut run: EvalRun) {
    let company = suite.scope.company.clone();
    let slot = evals.runs.company_slot(&company);
    let report = {
        let _turn = slot.lock().await;
        let sandbox = CompanySandbox {
            runs: &evals.runs,
            company,
        };
        let judge = SandboxJudge {
            sandbox: &sandbox,
            config: &evals.judge,
        };
        runner::run(&suite, &source, &sandbox, &judge).await
    };
    // A case that could not be graded did not pass.
    let event = EvalRunFinished::new(
        &suite.scope,
        run.id.clone(),
        report.passed,
        report.failed + report.errored,
    );
    run.ended_at = Some(OffsetDateTime::now_utc());
    run.report = Some(report);
    if let Err(e) = evals.store.finish(&run, &event).await {
        tracing::error!(error = %e, eval_run = %run.id, "could not record the eval run's end");
    }
}

/// The project's eval runs, newest first.
#[utoipa::path(get, operation_id = "list_eval_runs", path = "/v1/companies/{company}/projects/{project}/eval-runs",
    tag = "evals",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [EvalRunOut]), (status = 403, body = ErrorBody)))]
pub async fn list_runs<D: EvalDeps>(
    State(evals): State<Arc<Evals<D>>>,
    caller: Caller,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<EvalRunOut>>, RunsError> {
    let scope = authorize(&evals, &caller, c, p, Permission::Work).await?;
    Ok(Json(
        evals.store.runs(&scope).await?.into_iter().map(Into::into).collect(),
    ))
}

/// One eval run with its results per case and per criterion.
#[utoipa::path(get, operation_id = "get_eval_run", path = "/v1/companies/{company}/projects/{project}/eval-runs/{run}",
    tag = "evals",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id"),
        ("run" = String, Path, description = "Eval run id")),
    responses((status = 200, body = EvalRunOut), (status = 403, body = ErrorBody), (status = 404, body = ErrorBody)))]
pub async fn get_run<D: EvalDeps>(
    State(evals): State<Arc<Evals<D>>>,
    caller: Caller,
    Path((c, p, run)): Path<(CompanyId, ProjectId, EvalRunId)>,
) -> Result<Json<EvalRunOut>, RunsError> {
    let scope = authorize(&evals, &caller, c, p, Permission::Work).await?;
    let run = evals.store.run(&scope, &run).await?.ok_or(RunsError::NotFound)?;
    Ok(Json(run.into()))
}

/// Each success criterion's pass rate, from the latest finished run of every suite that measures it. Readable by
/// the customer's guests on the project.
#[utoipa::path(get, operation_id = "list_eval_criteria", path = "/v1/companies/{company}/projects/{project}/eval-criteria",
    tag = "evals",
    params(("company" = String, Path, description = "Company id"), ("project" = String, Path, description = "Project id")),
    responses((status = 200, body = [CriterionOut]), (status = 403, body = ErrorBody)))]
pub async fn criteria<D: EvalDeps>(
    State(evals): State<Arc<Evals<D>>>,
    caller: Caller,
    Path((c, p)): Path<(CompanyId, ProjectId)>,
) -> Result<Json<Vec<CriterionOut>>, RunsError> {
    let scope = authorize(&evals, &caller, c, p, Permission::View).await?;
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    // Newest first, so the first finished run of each suite is its latest.
    for run in evals.store.runs(&scope).await? {
        let Some(report) = run.report else { continue };
        if !seen.insert(run.suite.clone()) {
            continue;
        }
        out.extend(report.criteria.into_iter().map(|rate| CriterionOut {
            suite: run.suite.to_string(),
            run: run.id.to_string(),
            finished_at: run.ended_at.map(ts),
            rate,
        }));
    }
    Ok(Json(out))
}

#[derive(OpenApi)]
#[openapi(
    info(title = "oryxa-fde-api: evals", version = "0.1.0",
        description = "Eval suites, runs and criterion pass rates. Served by oryxa-fde-api."),
    paths(create_suite, list_suites, get_suite, import_cases, start_run, import_results, list_runs, get_run, criteria),
    modifiers(&Bearer),
    security(("bearer" = [])),
    tags((name = "evals", description = "Eval suites linked to success criteria, run in the company's sandbox"))
)]
pub struct EvalsDoc;

/// The eval API's spec, with default response descriptions as in `api::openapi`.
pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut api = EvalsDoc::openapi();
    crate::api::describe_responses(&mut api);
    api
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: &str = "openapi.evals.json";

    /// The committed spec must match the code. Regenerate with
    /// `UPDATE_OPENAPI=1 cargo test -p oryxa-fde-agent openapi`.
    #[test]
    fn openapi_spec_is_committed_and_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SPEC);
        let spec = openapi().to_pretty_json().unwrap() + "\n";
        if std::env::var_os("UPDATE_OPENAPI").is_some() {
            std::fs::write(&path, &spec).unwrap();
        }
        let committed = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(
            committed == spec,
            "{SPEC} is out of date: run `UPDATE_OPENAPI=1 cargo test -p oryxa-fde-agent openapi` and commit it"
        );
    }

    #[test]
    fn the_judge_calls_converse_on_a_checked_model_and_region() {
        let config = |model: &str, region: &str| JudgeConfig {
            model: model.into(),
            region: region.into(),
        };
        assert_eq!(
            converse_url(&config("eu.anthropic.claude-opus-5-5", "eu-west-1")).unwrap(),
            "https://bedrock-runtime.eu-west-1.amazonaws.com/model/eu.anthropic.claude-opus-5-5/converse"
        );
        assert_eq!(
            converse_url(&config("arn:aws:bedrock:eu-west-1:1:inference-profile/p", "eu-west-1")).unwrap(),
            "https://bedrock-runtime.eu-west-1.amazonaws.com/model/arn%3Aaws%3Abedrock%3Aeu-west-1%3A1%3Ainference-profile%2Fp/converse"
        );
        for (model, region) in [("m", "eu-west-1.evil.example"), ("m?x", "eu-west-1"), ("", "eu-west-1")] {
            assert_eq!(converse_url(&config(model, region)), None, "{model} {region}");
        }
    }

    #[test]
    fn reads_the_text_of_a_converse_answer() {
        let ok = "{\"output\":{\"message\":{\"role\":\"assistant\",\"content\":[{\"text\":\"{\\\"pass\\\": true}\"}]}}}\n200\n";
        assert_eq!(converse_text(ok).as_deref(), Some("{\"pass\": true}"));
        for bad in [
            "{\"message\":\"denied\"}\n403",
            "not json\n200",
            "{\"output\":{}}\n200",
            "200",
        ] {
            assert_eq!(converse_text(bad), None, "{bad}");
        }
    }
}
