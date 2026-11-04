//! The harness event format: one JSON object per line on the harness's stdout. The kinds and their vocabulary
//! (tool kinds, statuses, plan entries, permission requests) follow the Agent Client Protocol's session updates,
//! so an ACP agent maps onto it without a new format.
//!
//! Every line comes from a sandbox that runs untrusted code, so it is parsed with size and depth limits.

use oryxa_core::{MAX_JSON_DEPTH, json_depth};
use serde::{Deserialize, Serialize};

use crate::ids::{ApprovalId, ToolCallId};

pub const EVENT_VERSION: u8 = 1;
/// Longest line accepted from the harness.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventLine {
    pub v: u8,
    /// 0, 1, 2, ... per run, so a replayed line is recognised and dropped.
    pub seq: u64,
    #[serde(flatten)]
    pub event: HarnessEvent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HarnessEvent {
    /// The agent's current plan, replacing the previous one (ACP `plan`).
    Plan { entries: Vec<PlanEntry> },
    /// Text the agent wrote for the FDE (ACP `agent_message_chunk`).
    Message { text: String },
    /// A tool call started or changed status; the same id repeats (ACP `tool_call` / `tool_call_update`).
    ToolCall {
        id: ToolCallId,
        title: String,
        kind: ToolKind,
        status: ToolStatus,
    },
    /// A file the agent changed, from a finished edit tool call.
    FileChange {
        tool_call_id: ToolCallId,
        path: String,
        change: FileChange,
    },
    /// A shell command the agent ran, from a finished execute tool call.
    Command {
        tool_call_id: ToolCallId,
        command: String,
        status: ToolStatus,
    },
    /// An action on the company's approval list; the run waits for an FDE (ACP `session/request_permission`).
    ApprovalRequest {
        id: ApprovalId,
        tool_call_id: ToolCallId,
        action: String,
        title: String,
        /// The tool and its full input, exactly as they will run if approved; the title is only a summary.
        tool: String,
        input: serde_json::Value,
    },
    /// The run's last event.
    Result {
        outcome: Outcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        text: String,
        turns: u32,
        usage: Usage,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanEntry {
    pub content: String,
    pub status: PlanStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Pending,
    InProgress,
    Completed,
}

/// ACP's tool kinds, so the review screen can pick an icon without knowing the harness's tool names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileChange {
    Created,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Error,
    /// An FDE rejected an approval and the harness stopped.
    Rejected,
    /// The API cancelled the run (on request or at its time limit) and the harness stopped.
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// What the API writes to the harness's stdin, one JSON object per line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HarnessInput {
    ApprovalDecision {
        id: ApprovalId,
        outcome: ApprovalOutcome,
    },
    /// Stop the run: the harness aborts the agent, rejects any pending approval and ends with a `cancelled` result.
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalOutcome {
    Approved,
    Rejected,
}

impl HarnessInput {
    /// The line to write to the harness's stdin, newline included.
    pub fn to_line(&self) -> String {
        // Serialising these plain enums cannot fail; fall back to an empty object, which the harness ignores.
        let mut line = serde_json::to_string(self).unwrap_or_else(|_| "{}".into());
        line.push('\n');
        line
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EventError {
    #[error("event line is longer than {MAX_LINE_BYTES} bytes")]
    TooLong,
    #[error("event line nests deeper than {MAX_JSON_DEPTH}")]
    TooDeep,
    #[error("unsupported event version {0}")]
    Version(u8),
    #[error("invalid event line: {0}")]
    Invalid(#[from] serde_json::Error),
}

/// Parses one line of harness output.
pub fn parse_line(line: &str) -> Result<EventLine, EventError> {
    if line.len() > MAX_LINE_BYTES {
        return Err(EventError::TooLong);
    }
    let value: serde_json::Value = serde_json::from_str(line)?;
    if json_depth(&value) > MAX_JSON_DEPTH {
        return Err(EventError::TooDeep);
    }
    let parsed: EventLine = serde_json::from_value(value)?;
    if parsed.v != EVENT_VERSION {
        return Err(EventError::Version(parsed.v));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_kind() {
        let lines = [
            r#"{"v":1,"seq":0,"type":"plan","entries":[{"content":"Add a test","status":"in_progress"}]}"#,
            r#"{"v":1,"seq":1,"type":"message","text":"On it."}"#,
            r#"{"v":1,"seq":2,"type":"tool_call","id":"toolu_1","title":"Read a.ts","kind":"read","status":"completed"}"#,
            r#"{"v":1,"seq":3,"type":"file_change","tool_call_id":"toolu_2","path":"a.ts","change":"modified"}"#,
            r#"{"v":1,"seq":4,"type":"command","tool_call_id":"toolu_3","command":"npm test","status":"failed"}"#,
            r#"{"v":1,"seq":5,"type":"approval_request","id":"apr_1","tool_call_id":"toolu_4","action":"deploy","title":"Run: wrangler deploy","tool":"Bash","input":{"command":"wrangler deploy"}}"#,
            r#"{"v":1,"seq":6,"type":"result","outcome":"success","text":"Done.","turns":3,"usage":{"input_tokens":10,"output_tokens":5}}"#,
            r#"{"v":1,"seq":7,"type":"result","outcome":"cancelled","text":"","turns":0,"usage":{"input_tokens":0,"output_tokens":0}}"#,
        ];
        for (seq, line) in lines.iter().enumerate() {
            let parsed = parse_line(line).unwrap();
            assert_eq!(parsed.seq, seq as u64);
            assert_eq!(
                serde_json::to_value(&parsed).unwrap(),
                serde_json::from_str::<serde_json::Value>(line).unwrap()
            );
        }
    }

    #[test]
    fn refuses_untrusted_input_it_cannot_bound() {
        let long = format!(
            r#"{{"v":1,"seq":0,"type":"message","text":"{}"}}"#,
            "x".repeat(MAX_LINE_BYTES)
        );
        assert!(matches!(parse_line(&long), Err(EventError::TooLong)));
        let deep = format!("{}{}", "[".repeat(MAX_JSON_DEPTH + 1), "]".repeat(MAX_JSON_DEPTH + 1));
        assert!(matches!(parse_line(&deep), Err(EventError::TooDeep)));
        assert!(matches!(
            parse_line(r#"{"v":2,"seq":0,"type":"message","text":"x"}"#),
            Err(EventError::Version(2))
        ));
        for bad in [
            r#"{"v":1,"seq":0,"type":"shell","command":"rm -rf /"}"#,
            r#"{"v":1,"seq":-1,"type":"message","text":"x"}"#,
            r#"{"v":1,"seq":0,"type":"tool_call","id":"a|b","title":"x","kind":"read","status":"completed"}"#,
            r#"{"v":1,"seq":0,"type":"tool_call","id":"t","title":"x","kind":"launch","status":"completed"}"#,
            "not json",
        ] {
            assert!(parse_line(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn writes_harness_input_as_lines() {
        let input = HarnessInput::ApprovalDecision {
            id: ApprovalId::new("apr_1").unwrap(),
            outcome: ApprovalOutcome::Rejected,
        };
        assert_eq!(
            input.to_line(),
            "{\"type\":\"approval_decision\",\"id\":\"apr_1\",\"outcome\":\"rejected\"}\n"
        );
        assert_eq!(HarnessInput::Cancel.to_line(), "{\"type\":\"cancel\"}\n");
    }
}
