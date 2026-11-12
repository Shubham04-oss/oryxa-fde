//! Setting up a company in one call (#225, ADR 0008): the new-company conversation ends in one
//! confirmation, and this makes everything it described in one transaction, or nothing. It grants
//! nothing new: the caller needs what creating a company needs, every part is parsed by the same
//! body type and stored by the same store function as its own route, and each of those queues the
//! same audit rows and events. It invites nobody, changes no role and sets no rule: those are
//! confirmed one at a time through their own routes.
//!
//! A retry is safe: the `Idempotency-Key` header is claimed in the same transaction, so the same key
//! with the same body answers the first setup (200) and makes nothing new, and the same key with
//! another body is refused.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use oryxa_fde_core::{CompanyId, CriterionId, ProjectId, ScopeItemId, StakeholderId, TaskId};
use oryxa_fde_store::{
    CompanyIn, CompanyTx, CriterionIn, CriterionProof, GrantRow, ProjectIn, ProjectTx, ScopeItemIn, SetupClaim,
    StakeholderIn, TaskIn,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use crate::authz::{company, workspace};
use crate::companies::{CompanyBody, CompanyOut};
use crate::lifecycle::{CriterionBody, ScopeItemBody, ScopeOut, TaskBody, TaskOut, TaskState, unversioned};
use crate::projects::{ProjectBody, ProjectOut, ProjectStage};
use crate::records::{StakeholderBody, StakeholderOut, new};
use crate::{ApiError, App, ErrorBody, Principal};

pub const MAX_STAKEHOLDERS: usize = 20;
pub const MAX_SCOPE_ITEMS: usize = 30;
pub const MAX_CRITERIA: usize = 20;
pub const MAX_PLAN: usize = 30;
const IDEMPOTENCY_KEY: &str = "idempotency-key";
const MAX_KEY_CHARS: usize = 128;

/// One step of the plan: a task, `todo`, in the order given.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SetupTaskBody {
    pub title: String,
    /// The stage of the plan it belongs to.
    pub stage: Option<ProjectStage>,
    /// Due date, `YYYY-MM-DD`.
    pub due_on: Option<String>,
    /// The success criterion it works towards, by its place in `criteria` (from 0).
    pub criterion: Option<usize>,
}

/// Everything the new-company conversation confirmed.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SetupBody {
    pub company: CompanyBody,
    /// The company's first project.
    pub project: ProjectBody,
    /// Up to 20 people at the customer, without `version`.
    #[serde(default)]
    pub stakeholders: Vec<StakeholderBody>,
    /// The company's main contact, by place in `stakeholders` (from 0).
    pub main_contact: Option<usize>,
    /// Up to 30 in-scope and out-of-scope items, without `version`.
    #[serde(default)]
    pub scope_items: Vec<ScopeItemBody>,
    /// Up to 20 success criteria, each with its baseline and how it will be proven, without
    /// `version`.
    #[serde(default)]
    pub criteria: Vec<CriterionBody>,
    /// Up to 30 plan steps, as tasks in this order.
    #[serde(default)]
    pub plan: Vec<SetupTaskBody>,
}

/// What the setup made, read back from the store.
#[derive(Debug, Serialize, ToSchema)]
pub struct SetupOut {
    pub company: CompanyOut,
    /// With its `next_step`: the plan's first step.
    pub project: ProjectOut,
    pub stakeholders: Vec<StakeholderOut>,
    pub scope: ScopeOut,
    /// The plan, in order.
    pub plan: Vec<TaskOut>,
}

/// The body, parsed by each part's own rules before anything is written.
struct Parsed {
    company: CompanyIn,
    project: ProjectIn,
    stakeholders: Vec<StakeholderIn>,
    main_contact: Option<usize>,
    scope_items: Vec<ScopeItemIn>,
    criteria: Vec<(CriterionIn, CriterionProof)>,
    /// Each step, and the place of its criterion in `criteria`.
    plan: Vec<(TaskIn, Option<usize>)>,
}

fn at_most<T>(list: &[T], max: usize, what: &'static str) -> Result<(), ApiError> {
    if list.len() > max {
        return Err(ApiError::Invalid(what));
    }
    Ok(())
}

impl SetupBody {
    fn parse(self) -> Result<Parsed, ApiError> {
        at_most(&self.stakeholders, MAX_STAKEHOLDERS, "stakeholders")?;
        at_most(&self.scope_items, MAX_SCOPE_ITEMS, "scope_items")?;
        at_most(&self.criteria, MAX_CRITERIA, "criteria")?;
        at_most(&self.plan, MAX_PLAN, "plan")?;
        if self.main_contact.is_some_and(|i| i >= self.stakeholders.len()) {
            return Err(ApiError::Invalid("main_contact"));
        }
        let criteria_count = self.criteria.len();
        let stakeholders = self
            .stakeholders
            .into_iter()
            .map(|s| unversioned(s.version).and_then(|()| s.parse()))
            .collect::<Result<_, _>>()?;
        let scope_items = self
            .scope_items
            .into_iter()
            .map(|i| unversioned(i.version).and_then(|()| i.parse()))
            .collect::<Result<_, _>>()?;
        let criteria = self
            .criteria
            .into_iter()
            .map(|c| unversioned(c.version).and_then(|()| c.parse()))
            .collect::<Result<_, _>>()?;
        let plan = self
            .plan
            .into_iter()
            .map(|t| {
                if t.criterion.is_some_and(|i| i >= criteria_count) {
                    return Err(ApiError::Invalid("criterion"));
                }
                // The task route's own rules; the criterion is linked once it has an id.
                let task = TaskBody {
                    title: t.title,
                    status: TaskState::Todo,
                    blocker: None,
                    due_on: t.due_on,
                    assignee: None,
                    waiting_on: None,
                    blocked_by: None,
                    version: None,
                    criterion: None,
                    before: None,
                    after: None,
                    stage: t.stage,
                }
                .parse()?;
                Ok((task, t.criterion))
            })
            .collect::<Result<_, ApiError>>()?;
        Ok(Parsed {
            company: self.company.parse()?,
            project: self.project.parse()?,
            stakeholders,
            main_contact: self.main_contact,
            scope_items,
            criteria,
            plan,
        })
    }
}

/// The `Idempotency-Key` header, required: 1 to 128 letters, digits, `-` and `_`. Kept as its hash.
fn idempotency_key(headers: &HeaderMap) -> Result<[u8; 32], ApiError> {
    let key = headers
        .get(IDEMPOTENCY_KEY)
        .and_then(|v| v.to_str().ok())
        .filter(|k| {
            (1..=MAX_KEY_CHARS).contains(&k.len())
                && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .ok_or(ApiError::Invalid("idempotency_key"))?;
    Ok(Sha256::digest(key.as_bytes()).into())
}

/// The company and project as they stand, with what the setup made in them, read in `tx`.
async fn read_back(mut tx: CompanyTx, project: ProjectId) -> Result<(SetupOut, ProjectTx), ApiError> {
    let company = tx.get().await?.ok_or(ApiError::NotFound)?;
    let stakeholders = tx.stakeholders().await?;
    let mut ptx = tx.into_project(project);
    let project = ptx.get().await?.ok_or(ApiError::NotFound)?;
    let scope = ptx.scope_of_work().await?.ok_or(ApiError::NotFound)?;
    let plan = ptx.tasks(None).await?;
    let out = SetupOut {
        company: company.into(),
        project: project.into(),
        stakeholders: stakeholders.into_iter().map(Into::into).collect(),
        scope: scope.into(),
        plan: plan.into_iter().map(Into::into).collect(),
    };
    Ok((out, ptx))
}

/// Set up a company in one call: the company (the caller becomes its lead), its first project,
/// its stakeholders and main contact, the project's scope items and success criteria, and the plan
/// as tasks in order. All of it or none of it. Send an `Idempotency-Key` header: a retry with the
/// same key and body answers the first setup with 200 and makes nothing new.
#[utoipa::path(post, operation_id = "set_up_company", path = "/v1/companies/setup", tag = "companies",
    request_body = SetupBody,
    params(("Idempotency-Key" = String, Header, description = "1 to 128 of `A-Za-z0-9-_`, the same for a retry")),
    responses((status = 201, body = SetupOut, description = "Set up"),
        (status = 200, body = SetupOut, description = "Set up earlier with this key and body: that setup, as it stands"),
        (status = 400, body = ErrorBody, description = "`invalid_*` naming the part, e.g. `invalid_name`, \
            `invalid_plan` (more than 30 steps), `invalid_criterion`, `invalid_idempotency_key`; nothing is made"),
        (status = 403, body = ErrorBody),
        (status = 409, body = ErrorBody, description = "`rejected_idempotency_key_reused`: this key set up \
            something else")))]
pub(crate) async fn setup(State(app): State<Arc<App>>, who: Principal, headers: HeaderMap, raw: Bytes) -> Response {
    run(&app, &who, &headers, &raw)
        .await
        .unwrap_or_else(IntoResponse::into_response)
}

async fn run(app: &App, who: &Principal, headers: &HeaderMap, raw: &[u8]) -> Result<Response, ApiError> {
    app.require(who, workspace(&who.tenant), "access").await?;
    let key = idempotency_key(headers)?;
    let body: SetupBody = serde_json::from_slice(raw).map_err(|_| ApiError::Invalid("body"))?;
    let v = body.parse()?;
    let body_hash: [u8; 32] = Sha256::digest(raw).into();
    let scope = who.company(new("cmp", CompanyId::new)?);
    let project = new("prj", ProjectId::new)?;
    let mut tx = app.store.company(&scope).await?;
    if let SetupClaim::Earlier {
        company: earlier,
        project: earlier_project,
        same_body,
    } = tx.claim_setup(&who.user, &key, &body_hash, &project).await?
    {
        drop(tx);
        if !same_body {
            return Err(ApiError::Rejected("idempotency_key_reused"));
        }
        // What it made is shown only to someone who may still see it.
        let earlier = who.company(earlier);
        app.require(who, company(&earlier), "work").await?;
        let (out, ptx) = read_back(app.store.company(&earlier).await?, earlier_project).await?;
        ptx.commit().await?;
        return Ok((StatusCode::OK, Json(out)).into_response());
    }

    let by = who.actor();
    tx.create(&v.company, &by).await?;
    let mut stakeholders = Vec::with_capacity(v.stakeholders.len());
    for s in &v.stakeholders {
        let id = new("stk", StakeholderId::new)?;
        tx.add_stakeholder(&id, s, &by).await?.ok_or(ApiError::Internal)?;
        stakeholders.push(id);
    }
    if let Some(i) = v.main_contact {
        tx.set_main_contact(stakeholders.get(i), &by).await?;
    }
    let mut ptx = tx.into_project(project.clone());
    ptx.create(&v.project, &by).await?.ok_or(ApiError::Internal)?;
    for item in &v.scope_items {
        ptx.add_scope_item(&new("itm", ScopeItemId::new)?, item, &by)
            .await?
            .ok_or(ApiError::Internal)?;
    }
    let mut criteria = Vec::with_capacity(v.criteria.len());
    for (c, m) in &v.criteria {
        let id = new("crt", CriterionId::new)?;
        ptx.add_criterion_with(&id, c, m, &by)
            .await?
            .ok_or(ApiError::Internal)?;
        criteria.push(id);
    }
    for (task, criterion) in v.plan {
        let task = TaskIn {
            criterion: criterion.and_then(|i| criteria.get(i).cloned()),
            ..task
        };
        ptx.add_task(&new("tsk", TaskId::new)?, &task, &by)
            .await?
            .ok_or(ApiError::Internal)?;
    }
    let (out, ptx) = read_back(ptx.into_company(), project.clone()).await?;
    ptx.commit().await?;
    // As the company and project routes do: the grants follow the commit, and the reconciler
    // retries any left pending.
    app.grant(GrantRow::Company(scope.clone())).await;
    app.grant(GrantRow::Member(scope.clone(), who.user.clone())).await;
    app.grant(GrantRow::Project(scope.project(project))).await;
    Ok((StatusCode::CREATED, Json(out)).into_response())
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;
    use serde_json::{Value, json};

    use super::*;

    fn body(extra: Value) -> SetupBody {
        let mut v = json!({ "company": { "name": "Acme" }, "project": { "name": "Support triage" } });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }

    fn code(r: Result<Parsed, ApiError>) -> String {
        match r {
            Ok(_) => "ok".into(),
            Err(e) => e.code(),
        }
    }

    #[test]
    fn every_part_is_parsed_by_its_own_rules_and_every_list_is_bounded() {
        let full = body(json!({
            "stakeholders": [{ "name": "Sam", "role": "sponsor" }, { "name": "Kim" }],
            "main_contact": 1,
            "scope_items": [{ "kind": "in", "description": "Triage tickets" }],
            "criteria": [{ "description": "Labels are right", "metric": "accuracy", "comparator": "at_least",
                "target": 90.0, "baseline": 60.0, "proof": "Eval suite" }],
            "plan": [{ "title": "Call the sponsor", "stage": "discover" },
                     { "title": "Build the labeller", "stage": "build", "criterion": 0, "due_on": "2026-12-01" }],
        }))
        .parse()
        .unwrap();
        assert_eq!((full.stakeholders.len(), full.main_contact), (2, Some(1)));
        assert_eq!(full.plan[1].1, Some(0));
        assert_eq!(full.plan[0].0.status, oryxa_fde_store::TaskStatus::Todo);

        let many = |n: usize, one: Value| Value::Array(vec![one; n]);
        for (extra, want) in [
            (json!({ "company": { "name": "" } }), "invalid_name"),
            (
                json!({ "stakeholders": many(21, json!({ "name": "x" })) }),
                "invalid_stakeholders",
            ),
            (
                json!({ "scope_items": many(31, json!({ "kind": "in", "description": "x" })) }),
                "invalid_scope_items",
            ),
            (
                json!({ "criteria": many(21, json!({ "description": "d", "metric": "m", "comparator": "at_least", "target": 1.0 })) }),
                "invalid_criteria",
            ),
            (json!({ "plan": many(31, json!({ "title": "x" })) }), "invalid_plan"),
            (json!({ "main_contact": 0 }), "invalid_main_contact"),
            (
                json!({ "plan": [{ "title": "x", "criterion": 0 }] }),
                "invalid_criterion",
            ),
            (json!({ "plan": [{ "title": "" }] }), "invalid_title"),
            (
                json!({ "plan": [{ "title": "x", "due_on": "soon" }] }),
                "invalid_due_on",
            ),
            (
                json!({ "stakeholders": [{ "name": "x", "version": 2 }] }),
                "invalid_version",
            ),
            (
                json!({ "criteria": [{ "description": "d", "metric": "m", "comparator": "at_least", "target": 1.0,
                    "proof": "x".repeat(501) }] }),
                "invalid_proof",
            ),
        ] {
            assert_eq!(code(body(extra.clone()).parse()), want, "{extra}");
        }

        // Unknown fields are refused, at the top and in a part; the plan cannot set who does it.
        for bad in [
            json!({ "company": { "name": "Acme" }, "project": { "name": "P" }, "invite": ["x@example.com"] }),
            json!({ "company": { "name": "Acme" }, "project": { "name": "P" }, "plan": [{ "title": "x", "assignee": "user_1" }] }),
            json!({ "company": { "name": "Acme", "owner": "x" }, "project": { "name": "P" } }),
        ] {
            assert!(serde_json::from_value::<SetupBody>(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_idempotency_key_is_required_and_kept_as_a_hash() {
        let mut h = HeaderMap::new();
        assert_eq!(idempotency_key(&h).unwrap_err().code(), "invalid_idempotency_key");
        for bad in ["", "has space", "a/b", &"k".repeat(129)] {
            h.insert(IDEMPOTENCY_KEY, HeaderValue::from_str(bad).unwrap());
            assert!(idempotency_key(&h).is_err(), "{bad:?}");
        }
        h.insert(IDEMPOTENCY_KEY, HeaderValue::from_static("setup-01J_x"));
        let k = idempotency_key(&h).unwrap();
        assert_eq!(k, <[u8; 32]>::from(Sha256::digest(b"setup-01J_x")));
    }
}
