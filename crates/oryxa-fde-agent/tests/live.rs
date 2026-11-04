//! The production access checks and context source against a real SpiceDB and Postgres, as CI runs them:
//!   docker run --rm -p 50051:50051 authzed/spicedb:v1.56.2 serve-testing
//!   docker run --rm -e POSTGRES_PASSWORD=oryxa -e POSTGRES_DB=oryxa_fde -p 55432:5432 pgvector/pgvector:pg17
//!   DATABASE_URL=postgres://postgres:oryxa@localhost:55432/oryxa_fde SPICEDB_ENDPOINT=http://localhost:50051 \
//!     cargo test -p oryxa-fde-agent -- --ignored
//! Every test uses fresh tenants and its own SpiceDB datastore.

use std::sync::Arc;
use std::time::Duration;

use oryxa_authn::{AccessTokenVerifier, KeySource};
use oryxa_authz::{ObjectRef, Relationship, SpiceDb, SubjectRef, Write};
use oryxa_core::{TenantId, UserId};
use oryxa_fde_agent::access::{Access, AccessError, Caller, Permission, PlatformAccess};
use oryxa_fde_agent::project_context::StoreContext;
use oryxa_fde_agent::{AgentConfig, ContextError, ContextSource};
use oryxa_fde_core::{CompanyId, CompanyScope, CriterionId, DecisionId, ProjectId, ScopeItemId};
use oryxa_fde_store::{Actor, Comparator, CriterionIn, DecisionIn, Name, ScopeItemIn, ScopeKind, Store, Text, new_id};
use oryxa_spicedb_proto::v1::{WriteSchemaRequest, schema_service_client::SchemaServiceClient};
use workos::helpers::JwkSet;

const SCHEMA: &str = include_str!("../../../schema/fde.zed");

struct NoKeys;

impl KeySource for NoKeys {
    async fn keys(&self) -> Result<Arc<JwkSet>, String> {
        Err("no keys in this test".into())
    }
    async fn refresh(&self) -> Result<Arc<JwkSet>, String> {
        Err("no keys in this test".into())
    }
}

async fn spicedb() -> SpiceDb {
    let endpoint = std::env::var("SPICEDB_ENDPOINT").unwrap_or_else(|_| "http://localhost:50051".into());
    // serve-testing gives each preshared key its own empty datastore.
    let key = new_id("agent-test");
    let mut schema = SchemaServiceClient::connect(endpoint.clone()).await.unwrap();
    let mut req = tonic::Request::new(WriteSchemaRequest { schema: SCHEMA.into() });
    req.metadata_mut()
        .insert("authorization", format!("Bearer {key}").parse().unwrap());
    schema.write_schema(req).await.unwrap();
    SpiceDb::connect(&endpoint, &key, Duration::from_secs(2)).await.unwrap()
}

async fn store() -> Store {
    let url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgres://postgres:oryxa@localhost:55432/oryxa_fde".into());
    let store = Store::connect(&url).await.unwrap();
    store.migrate().await.unwrap();
    store
}

fn rel(resource: ObjectRef, relation: &'static str, subject: ObjectRef) -> Write {
    Write::Touch(Relationship {
        resource,
        relation,
        subject: SubjectRef::object(subject),
        caveat: None,
        expires_at: None,
    })
}

#[tokio::test]
#[ignore = "needs SpiceDB"]
async fn access_checks_the_permission_and_that_the_project_is_in_the_company() {
    let authz = spicedb().await;
    let t = TenantId::new(new_id("org")).unwrap();
    let o = |kind, id: &str| ObjectRef::new(&t, kind, id);
    authz
        .write(
            &t,
            &[
                rel(o("fde_project", "prj_1"), "company", o("fde_company", "cmp_1")),
                rel(o("fde_project", "prj_2"), "company", o("fde_company", "cmp_2")),
                rel(o("fde_project", "prj_1"), "assignee", o("user", "usr_dev")),
                rel(o("fde_company", "cmp_1"), "lead", o("user", "usr_lead")),
            ],
            &[],
        )
        .await
        .unwrap();
    let access = PlatformAccess::new(AccessTokenVerifier::new(NoKeys, "https://api.workos.com/"), authz);
    let who = |u: &str| Caller {
        tenant: t.clone(),
        user: UserId::new(u).unwrap(),
    };
    let at =
        |c: &str, p: &str| CompanyScope::new(t.clone(), CompanyId::new(c).unwrap()).project(ProjectId::new(p).unwrap());
    let allowed = async |u: &str, c: &str, p: &str, perm| access.allowed(&who(u), &at(c, p), perm).await.unwrap();

    assert!(allowed("usr_dev", "cmp_1", "prj_1", Permission::Work).await);
    assert!(!allowed("usr_dev", "cmp_1", "prj_1", Permission::Manage).await);
    assert!(allowed("usr_lead", "cmp_1", "prj_1", Permission::Work).await);
    assert!(allowed("usr_lead", "cmp_1", "prj_1", Permission::Manage).await);
    // Not on the project, or the project addressed through another company: refused.
    assert!(!allowed("usr_dev", "cmp_2", "prj_2", Permission::Work).await);
    assert!(!allowed("usr_dev", "cmp_2", "prj_1", Permission::Work).await);
    assert!(!allowed("usr_lead", "cmp_2", "prj_1", Permission::Manage).await);
    // A scope in another tenant is never checked.
    let other = CompanyScope::new(TenantId::new(new_id("org")).unwrap(), CompanyId::new("cmp_1").unwrap())
        .project(ProjectId::new("prj_1").unwrap());
    assert!(!access.allowed(&who("usr_dev"), &other, Permission::Work).await.unwrap());

    assert_eq!(access.caller("not.a.token").await, Err(AccessError::Unauthorized));
}

#[tokio::test]
#[ignore = "needs Postgres"]
async fn the_pack_reads_the_projects_scope_criteria_and_decisions() {
    let store = store().await;
    let tenant = TenantId::new(new_id("org")).unwrap();
    let company = CompanyScope::new(tenant.clone(), CompanyId::new(new_id("cmp")).unwrap());
    let project = company.project(ProjectId::new(new_id("prj")).unwrap());
    let by = Actor {
        user: UserId::new("usr_lead").unwrap(),
        request_id: new_id("req"),
    };
    let mut tx = store.company(&company).await.unwrap();
    tx.create(&Name::new("Sample company").unwrap(), &by).await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = store.project(&project).await.unwrap();
    tx.create(&Name::new("Status page").unwrap(), &by)
        .await
        .unwrap()
        .unwrap();
    let item = ScopeItemIn {
        kind: ScopeKind::In,
        description: Text::new("A status page for the sample API.").unwrap(),
    };
    tx.add_scope_item(&ScopeItemId::new(new_id("si")).unwrap(), &item, &by)
        .await
        .unwrap();
    let criterion = CriterionIn {
        description: Text::new("Reports health quickly.").unwrap(),
        metric: Name::new("p95 latency").unwrap(),
        comparator: Comparator::AtMost,
        target: 60.0,
        unit: Some(Name::new("s").unwrap()),
    };
    let crit = CriterionId::new(new_id("crit")).unwrap();
    tx.add_criterion(&crit, &criterion, &by).await.unwrap();
    let decision = DecisionIn {
        title: Name::new("Stay on Hono").unwrap(),
        rationale: Text::new("No new web framework.").unwrap(),
        decided_by: Name::new("Sample sponsor").unwrap(),
        decided_at: time::OffsetDateTime::now_utc(),
    };
    let dec = DecisionId::new(new_id("dec")).unwrap();
    tx.record_decision(&dec, &decision, &by).await.unwrap();
    tx.commit().await.unwrap();

    let config = AgentConfig {
        model: "anthropic.claude-opus-5-5".into(),
        region: "eu-west-1".into(),
        max_turns: 40,
        approvals: vec![],
    };
    let source = StoreContext::new(store, config.clone(), vec!["TypeScript.".into()]);
    let context = source.project_context(&project).await.unwrap();
    assert_eq!(context.scope_of_work, "- In scope: A status page for the sample API.");
    assert_eq!(context.success_criteria[0].id, crit);
    assert_eq!(
        context.success_criteria[0].text,
        "Reports health quickly. (p95 latency: at most 60 s)"
    );
    assert_eq!(context.decisions[0].id, dec);
    assert_eq!(context.decisions[0].text, "Stay on Hono: No new web framework.");
    assert_eq!(context.conventions, ["TypeScript."]);
    assert_eq!(context.config, config);

    // The same project id through another company, or in another tenant: nothing.
    let elsewhere = CompanyScope::new(tenant, CompanyId::new(new_id("cmp")).unwrap()).project(project.project.clone());
    assert_eq!(source.project_context(&elsewhere).await, Err(ContextError::NotFound));
    let other_tenant = CompanyScope::new(TenantId::new(new_id("org")).unwrap(), project.company.company.clone())
        .project(project.project.clone());
    assert_eq!(source.project_context(&other_tenant).await, Err(ContextError::NotFound));
}
