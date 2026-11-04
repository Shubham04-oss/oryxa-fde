//! Consumer-side check: reads EventBridge messages (one JSON per line, as SQS delivers them)
//! and runs each through `oryxa_events::decode`, exactly as a real consumer would.
//!   cargo run -p oryxa-events --example verify_dump -- <kid> <source> <public.pem> <messages.jsonl>
use oryxa_events::{DecodeError, Verifier, decode, v1};
use serde_json::Value;

fn check(verifier: &Verifier, source: &str, detail_type: &str, detail: &str) -> Result<String, DecodeError> {
    macro_rules! dispatch {
        ($($ty:ident),*) => {
            match detail_type {
                $(t if t == <v1::$ty as oryxa_events::Event>::DETAIL_TYPE => {
                    let v = decode::<v1::$ty>(verifier, source, detail_type, detail)?;
                    Ok(format!("tenant={} actor={:?} data={:?}", v.tenant, v.envelope.actor.map(|a| a.system), v.data))
                })*
                other => Ok(format!("(no decoder for {other})")),
            }
        };
    }
    dispatch!(
        UserCreated,
        UserEmailChanged,
        UserDeactivated,
        UserDeleted,
        MemberJoined,
        MemberRoleChanged,
        MemberRemoved,
        GroupMembershipChanged,
        OrganizationDeleted,
        ToolAuthorizationDecided,
        AgentDelegated,
        ConnectionStatusChanged,
        SyncFinished,
        TaskStatusChanged,
        UsageRecorded
    )
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, kid, source, pem, file] = &args[..] else {
        eprintln!("usage: verify_dump <kid> <source> <public.pem> <messages.jsonl>");
        std::process::exit(2);
    };
    let verifier = Verifier::default()
        .trust(kid, source, &std::fs::read_to_string(pem).expect("public key"))
        .expect("key");
    let mut failures = 0;
    for line in std::fs::read_to_string(file)
        .expect("messages")
        .lines()
        .filter(|l| !l.trim().is_empty())
    {
        let msg: Value = serde_json::from_str(line).expect("eventbridge message");
        let (src, dt) = (
            msg["source"].as_str().unwrap_or(""),
            msg["detail-type"].as_str().unwrap_or(""),
        );
        // EventBridge delivers `detail` as an object (keys possibly reordered); re-serialize it.
        let detail = msg["detail"].to_string();
        match check(&verifier, src, dt, &detail) {
            Ok(summary) => println!("OK   {dt}  {summary}"),
            Err(e) => {
                failures += 1;
                println!("FAIL {dt}  {e}");
            }
        }
    }
    std::process::exit(if failures == 0 { 0 } else { 1 });
}
