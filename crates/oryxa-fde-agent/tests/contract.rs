//! The Rust and TypeScript sides of the harness share these fixtures: the harness's own tests replay a recorded
//! session into `session.events.jsonl` and parse `context.json`.

use oryxa_core::TenantId;
use oryxa_fde_agent::{
    AgentConfig, AgentRun, ApprovalRule, ContextPack, Criterion, Decision, HarnessEvent, InMemoryContext, Outcome,
    ProjectContext, RunState, parse_line,
};
use oryxa_fde_core::{AgentRunId, CompanyId, CompanyScope, CriterionId, DecisionId, ProjectId, ProjectScope};

const EVENTS: &str = include_str!("../../../sandbox/harness/test/fixtures/session.events.jsonl");
const PACK: &str = include_str!("../../../sandbox/harness/test/fixtures/context.json");
const PACK_LIMITS: &str = include_str!("../../../sandbox/harness/test/fixtures/pack-limits.json");

fn scope() -> ProjectScope {
    CompanyScope::new(
        TenantId::new("org_sample").unwrap(),
        CompanyId::new("cmp_sample").unwrap(),
    )
    .project(ProjectId::new("prj_sample").unwrap())
}

#[test]
fn recorded_session_replays_into_a_finished_run() {
    let lines: Vec<_> = EVENTS.lines().map(|l| parse_line(l).unwrap()).collect();
    let kinds: Vec<_> = lines
        .iter()
        .map(|l| match &l.event {
            HarnessEvent::Plan { .. } => "plan",
            HarnessEvent::Message { .. } => "message",
            HarnessEvent::ToolCall { .. } => "tool_call",
            HarnessEvent::FileChange { .. } => "file_change",
            HarnessEvent::Command { .. } => "command",
            HarnessEvent::ApprovalRequest { .. } => "approval_request",
            HarnessEvent::Usage { .. } => "usage",
            HarnessEvent::Result { .. } => "result",
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "message",
            "plan",
            "plan",
            "tool_call",
            "plan",
            "tool_call",
            "tool_call",
            "tool_call",
            "file_change",
            "tool_call",
            "plan",
            "plan",
            "tool_call",
            "file_change",
            "tool_call",
            "tool_call",
            "command",
            "tool_call",
            "tool_call",
            "file_change",
            "tool_call",
            "tool_call",
            "command",
            "plan",
            "message",
            "result",
        ]
    );
    assert!(matches!(
        lines.last().map(|l| &l.event),
        Some(HarnessEvent::Result {
            outcome: Outcome::Success,
            turns: 13,
            ..
        })
    ));

    let mut run = AgentRun::new(AgentRunId::new("run_sample_1").unwrap(), scope());
    run.start().unwrap();
    for line in &lines {
        run.apply(line).unwrap();
    }
    assert_eq!(run.state(), &RunState::Finished);
}

#[tokio::test]
async fn the_pack_the_api_builds_is_the_one_the_harness_reads() {
    let mut source = InMemoryContext::default();
    source.insert(
        scope(),
        ProjectContext {
            scope_of_work: "Sample scope: a status page for the sample customer's API service.".into(),
            success_criteria: vec![Criterion {
                id: CriterionId::new("crit_uptime").unwrap(),
                text: "The status page reports the API's health within 60 seconds of a change.".into(),
            }],
            decisions: vec![Decision {
                id: DecisionId::new("dec_hono").unwrap(),
                text: "The service stays on Hono; no new web framework.".into(),
            }],
            conventions: vec![
                "TypeScript, strict mode.".into(),
                "Tests next to the code under test/.".into(),
            ],
            config: AgentConfig {
                model: "anthropic.claude-opus-5-5".into(),
                region: "eu-west-1".into(),
                max_turns: 40,
                approvals: vec![
                    ApprovalRule {
                        action: "deploy".into(),
                        tool: "Bash".into(),
                        pattern: Some(
                            r"\b(wrangler|vercel|flyctl|kubectl|tofu|terraform)\b.*\b(deploy|apply|publish)\b".into(),
                        ),
                    },
                    ApprovalRule {
                        action: "customer_send".into(),
                        tool: "mcp__customer__send_message".into(),
                        pattern: None,
                    },
                ],
            },
        },
    );
    let pack = ContextPack::build(
        &source,
        AgentRunId::new("run_sample_1").unwrap(),
        scope(),
        "Add a /healthz endpoint to the API service, with a test.".into(),
    )
    .await
    .unwrap();
    let expected: serde_json::Value = serde_json::from_str(PACK).unwrap();
    assert_eq!(serde_json::to_value(&pack).unwrap(), expected);
    assert_eq!(serde_json::from_value::<ContextPack>(expected).unwrap(), pack);
}

#[test]
fn the_api_and_the_harness_apply_the_same_pack_limits() {
    use oryxa_fde_agent::context::{
        MAX_APPROVAL_RULES, MAX_ITEMS, MAX_PACK_BYTES, MAX_PATTERN_BYTES, MAX_TEXT_BYTES, MAX_TOKEN_BYTES,
    };
    let limits: serde_json::Value = serde_json::from_str(PACK_LIMITS).unwrap();
    let expected = serde_json::json!({
        "max_pack_bytes": MAX_PACK_BYTES,
        "max_text_bytes": MAX_TEXT_BYTES,
        "max_items": MAX_ITEMS,
        "max_approval_rules": MAX_APPROVAL_RULES,
        "max_pattern_bytes": MAX_PATTERN_BYTES,
        "max_token_bytes": MAX_TOKEN_BYTES,
    });
    assert_eq!(limits, expected);
}
