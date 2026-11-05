//! `EvalStore` on Postgres: what evals store comes back the same, and only in its own project.

use oryxa_core::{TenantId, UserId};
use oryxa_fde_core::{CompanyId, CompanyScope, CriterionId, EvalRunId, ProjectId, ProjectScope};
use oryxa_fde_evals::{
    Case, CaseId, CaseOutcome, CaseResult, Command, CriterionRate, EvalRun, EvalStore, EvalStoreError, Grader, Report,
    Suite, SuiteId, Verdict,
};
use oryxa_fde_store::{Actor, CompanyIn, Comparator, CriterionIn, Name, ProjectIn, Store, Text, new_id};
use serde_json::json;
use time::OffsetDateTime;

fn lead() -> UserId {
    UserId::new("usr_lead").unwrap()
}

/// A project with two success criteria: accuracy and format.
async fn project(store: &Store, tenant: &TenantId) -> (ProjectScope, [CriterionId; 2]) {
    let by = Actor {
        user: lead(),
        request_id: new_id("req"),
    };
    let company = CompanyScope::new(tenant.clone(), CompanyId::new(new_id("cmp")).unwrap());
    let mut tx = store.company(&company).await.unwrap();
    let input = CompanyIn {
        name: Name::new("Sample company").unwrap(),
        industry: None,
        region: None,
        summary: None,
    };
    tx.create(&input, &by).await.unwrap();
    tx.commit().await.unwrap();
    let scope = company.project(ProjectId::new(new_id("prj")).unwrap());
    let mut tx = store.project(&scope).await.unwrap();
    let input = ProjectIn {
        name: Name::new("Support triage").unwrap(),
        summary: None,
    };
    tx.create(&input, &by).await.unwrap().unwrap();
    let criteria = ["label accuracy", "label format"].map(|metric| {
        let id = CriterionId::new(new_id("crt")).unwrap();
        let input = CriterionIn {
            description: Text::new("Labels tickets well").unwrap(),
            metric: Name::new(metric).unwrap(),
            comparator: Comparator::AtLeast,
            target: 0.9,
            unit: None,
        };
        (id, input)
    });
    for (id, input) in &criteria {
        tx.add_criterion(id, input, &by).await.unwrap().unwrap();
    }
    tx.commit().await.unwrap();
    (scope, criteria.map(|(id, _)| id))
}

fn case(id: &str, criteria: Vec<CriterionId>) -> Case {
    Case {
        id: CaseId::new(id.to_owned()).unwrap(),
        input: format!("Sample ticket {id}"),
        expected: Some("bug".into()),
        criteria,
    }
}

fn suite(scope: &ProjectScope, [accuracy, format]: &[CriterionId; 2]) -> Suite {
    Suite {
        id: SuiteId::new(new_id("suite")).unwrap(),
        scope: scope.clone(),
        name: "Triage labels".into(),
        criteria: vec![accuracy.clone(), format.clone()],
        target: Some(Command {
            argv: vec!["node".into(), "triage.mjs".into()],
            timeout_secs: 30,
        }),
        graders: vec![
            Grader::ExactMatch { ignore_case: true },
            Grader::Regex {
                pattern: "^(bug|question)$".into(),
            },
            Grader::JsonSchema {
                schema: json!({ "type": "string" }),
            },
            Grader::Judge {
                rubric: "Is the label right?".into(),
            },
        ],
        cases: vec![case("case_b", vec![accuracy.clone()]), case("case_a", vec![])],
    }
}

fn report([accuracy, format]: &[CriterionId; 2]) -> Report {
    Report {
        cases: vec![
            CaseResult {
                case: CaseId::new("case_b".to_owned()).unwrap(),
                output: Some("bug".into()),
                outcome: CaseOutcome::Passed,
                verdicts: vec![Verdict::Passed { score: Some(0.75) }],
                error: None,
            },
            CaseResult {
                case: CaseId::new("case_a".to_owned()).unwrap(),
                output: Some("idea".into()),
                outcome: CaseOutcome::Failed,
                verdicts: vec![Verdict::Failed {
                    reason: "Quoted \u{0} output".into(),
                }],
                error: None,
            },
        ],
        criteria: vec![
            CriterionRate {
                criterion: accuracy.clone(),
                passed: 1,
                total: 2,
                rate: 0.5,
            },
            CriterionRate {
                criterion: format.clone(),
                passed: 0,
                total: 0,
                rate: 0.0,
            },
        ],
        passed: 1,
        failed: 1,
        errored: 0,
    }
}

#[tokio::test]
#[ignore = "needs Postgres (DATABASE_URL)"]
async fn suites_runs_and_reports_round_trip_in_their_project_only() {
    let store = oryxa_fde_store::testing::store().await;
    let tenant = TenantId::new(new_id("org")).unwrap();
    let (scope, criteria) = project(&store, &tenant).await;
    let (other, _) = project(&store, &tenant).await;
    let s = suite(&scope, &criteria);
    // Another project's criteria are refused in the database too.
    let theirs = Suite {
        scope: other.clone(),
        ..suite(&scope, &criteria)
    };
    assert!(matches!(
        store.create_suite(&theirs, &lead()).await,
        Err(EvalStoreError::NotFound)
    ));

    store.create_suite(&s, &lead()).await.unwrap();
    assert!(matches!(
        store.create_suite(&s, &lead()).await,
        Err(EvalStoreError::Conflict)
    ));
    assert_eq!(store.suite(&scope, &s.id).await.unwrap(), Some(s.clone()));
    let added = store
        .add_cases(&scope, &s.id, vec![case("case_c", vec![])], &lead())
        .await
        .unwrap();
    assert_eq!(added.cases.len(), 3);
    assert_eq!(store.suites(&scope).await.unwrap(), vec![added]);

    let run = EvalRun {
        id: EvalRunId::new(new_id("eval")).unwrap(),
        scope: scope.clone(),
        suite: s.id.clone(),
        imported: false,
        created_by: lead(),
        request_id: new_id("req"),
        created_at: OffsetDateTime::now_utc().replace_nanosecond(0).unwrap(),
        ended_at: None,
        report: None,
    };
    store.create_run(&run).await.unwrap();
    assert_eq!(store.run(&scope, &run.id).await.unwrap(), Some(run.clone()));
    store.finish(&run, &report(&criteria)).await.unwrap();
    assert!(matches!(
        store.finish(&run, &report(&criteria)).await,
        Err(EvalStoreError::Conflict)
    ));
    let ended = store.run(&scope, &run.id).await.unwrap().unwrap();
    assert!(ended.ended_at.is_some());
    assert_eq!(ended.report, Some(report(&criteria)));
    assert_eq!(store.runs(&scope).await.unwrap(), vec![ended]);

    // Another project of the tenant sees, adds and finishes nothing.
    assert_eq!(store.suite(&other, &s.id).await.unwrap(), None);
    assert!(store.suites(&other).await.unwrap().is_empty());
    assert_eq!(store.run(&other, &run.id).await.unwrap(), None);
    assert!(store.runs(&other).await.unwrap().is_empty());
    assert!(matches!(
        store
            .add_cases(&other, &s.id, vec![case("case_d", vec![])], &lead())
            .await,
        Err(EvalStoreError::NotFound)
    ));
    let elsewhere = EvalRun {
        scope: other.clone(),
        ..run.clone()
    };
    assert!(store.finish(&elsewhere, &report(&criteria)).await.is_err());
    assert!(store.create_run(&elsewhere).await.is_err());
}
