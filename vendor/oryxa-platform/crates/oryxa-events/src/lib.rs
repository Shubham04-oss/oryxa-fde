//! The central event contract. Payloads and envelope come from `/proto/oryxa/events/v1`;
//! this crate binds each payload to its EventBridge Source/DetailType and publishes.
//! Wire shape: EventBridge Detail = envelope JSON + `data`. Bus: `oryxa-<env>`.

use std::sync::{Arc, Mutex};

use oryxa_core::{AgentKind, Ctx};
use serde::Serialize;

pub mod signing;
pub use signing::{Signer, Verifier, VerifyError};

#[allow(clippy::all)] // generated code
pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/oryxa.events.v1.rs"));
    include!(concat!(env!("OUT_DIR"), "/oryxa.events.v1.serde.rs"));
}

/// EventBridge's per-entry limit; bigger payloads go to S3 and the event carries the key.
pub const MAX_DETAIL_BYTES: usize = 256 * 1024;

/// A payload bound to its place on the bus.
pub trait Event: Serialize {
    const SOURCE: &'static str;
    const DETAIL_TYPE: &'static str;
    /// Entity whose events must stay in order (FIFO group = "<tenant>/<entity>"); `None` = tenant.
    fn entity_key(&self) -> Option<&str> {
        None
    }
}

macro_rules! ordered_by {
    ($($ty:ident => $field:ident;)*) => {
        $(impl v1::$ty {
            fn entity(&self) -> Option<&str> {
                Some(self.$field.as_str()).filter(|s| !s.is_empty())
            }
        })*
    };
}

// Per-user streams stay ordered without serialising a whole tenant behind one user.
ordered_by! {
    UserCreated => user;
    UserEmailChanged => user;
    UserDeactivated => user;
    UserDeleted => user;
    MemberJoined => user;
    MemberRoleChanged => user;
    MemberRemoved => user;
    GroupMembershipChanged => user;
    ChatLinkCreated => user;
    ChatLinkInvalidated => user;
    ConnectionStatusChanged => connection_id;
    SyncFinished => connection_id;
    TaskStatusChanged => task_id;
    UsageRecorded => task_id;
}

/// Types without an `ordered_by!` entry group by tenant only.
trait EntityFallback {
    fn entity(&self) -> Option<&str> {
        None
    }
}
impl<T> EntityFallback for T {}

macro_rules! events {
    ($($ty:ident => $source:literal, $detail:literal;)*) => {
        $(impl Event for v1::$ty {
            const SOURCE: &'static str = $source;
            const DETAIL_TYPE: &'static str = $detail;
            fn entity_key(&self) -> Option<&str> {
                #[allow(unused_imports)]
                use EntityFallback as _;
                self.entity()
            }
        })*
        /// Every (Source, DetailType) this platform emits; consumers derive rule patterns from it.
        pub const CATALOG: &[(&str, &str)] = &[$(($source, $detail)),*];
    };
}

events! {
    UserCreated => "oryxa.identity", "identity.user.created.v1";
    UserEmailChanged => "oryxa.identity", "identity.user.email-changed.v1";
    UserDeactivated => "oryxa.identity", "identity.user.deactivated.v1";
    UserDeleted => "oryxa.identity", "identity.user.deleted.v1";
    MemberJoined => "oryxa.identity", "identity.member.joined.v1";
    MemberRoleChanged => "oryxa.identity", "identity.member.role-changed.v1";
    MemberRemoved => "oryxa.identity", "identity.member.removed.v1";
    GroupMembershipChanged => "oryxa.identity", "identity.group.membership-changed.v1";
    OrganizationDeleted => "oryxa.identity", "identity.organization.deleted.v1";
    ChatLinkCreated => "oryxa.identity", "identity.chat-link.created.v1";
    ChatLinkInvalidated => "oryxa.identity", "identity.chat-link.invalidated.v1";
    ToolAuthorizationDecided => "oryxa.gateway", "gateway.tool-authorization.decided.v1";
    AgentDelegated => "oryxa.gateway", "gateway.agent.delegated.v1";
    ConnectionStatusChanged => "oryxa.connectors", "connectors.connection.status-changed.v1";
    SyncFinished => "oryxa.connectors", "connectors.sync.finished.v1";
    TaskStatusChanged => "oryxa.sessions", "sessions.task.status-changed.v1";
    UsageRecorded => "oryxa.billing", "billing.usage.recorded.v1";
}

/// Envelope for a request-driven event: tenant and actor come from the verified context.
pub fn envelope_for(ctx: &Ctx) -> v1::Envelope {
    let agent_chain = ctx
        .agent_chain
        .iter()
        .map(|a| v1::AgentRef {
            id: a.id.to_string(),
            kind: match a.kind {
                AgentKind::Personal => "personal",
                AgentKind::Workspace => "workspace",
            }
            .into(),
        })
        .collect();
    v1::Envelope {
        tenant: ctx.tenant.to_string(),
        actor: Some(v1::Actor {
            user: ctx.user.to_string(),
            agent_chain,
            system: String::new(),
        }),
        correlation_id: ctx.trace_id.clone(),
        ..new_envelope()
    }
}

/// Envelope with a fresh id and timestamp; callers fill tenant/actor (e.g. system events).
pub fn new_envelope() -> v1::Envelope {
    let now = time::OffsetDateTime::now_utc();
    v1::Envelope {
        event_id: format!("evt_{}", uuid::Uuid::now_v7().simple()),
        version: 1,
        occurred_at: now
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default(),
        ..Default::default()
    }
}

/// A ready-to-send entry; encoding happens before any async hand-off.
#[derive(Debug, Clone, PartialEq)]
pub struct Encoded {
    pub source: String,
    pub detail_type: String,
    /// FIFO ordering group on the bus: "<tenant>" or "<tenant>/<entity>".
    pub group: String,
    pub event_id: String,
    pub detail: String,
}

#[derive(Debug, thiserror::Error)]
pub enum PublishError {
    #[error("encode: {0}")]
    Encode(#[from] serde_json::Error),
    #[error("detail is {0} bytes; over the 256 KiB EventBridge limit, store it in S3")]
    TooLarge(usize),
    #[error("eventbridge: {0}")]
    Bus(String),
    #[error("refusing to publish unsigned event {0}")]
    Unsigned(String),
}

pub fn encode<T: Event>(envelope: &v1::Envelope, data: &T) -> Result<Encoded, PublishError> {
    #[derive(Serialize)]
    struct Wire<'a, T> {
        #[serde(flatten)]
        envelope: &'a v1::Envelope,
        data: &'a T,
    }
    let detail = serde_json::to_string(&Wire { envelope, data })?;
    if detail.len() > MAX_DETAIL_BYTES {
        return Err(PublishError::TooLarge(detail.len()));
    }
    let group = match data.entity_key() {
        Some(entity) => format!("{}/{entity}", envelope.tenant),
        None => envelope.tenant.clone(),
    };
    Ok(Encoded {
        source: T::SOURCE.into(),
        detail_type: T::DETAIL_TYPE.into(),
        group,
        event_id: envelope.event_id.clone(),
        detail,
    })
}

pub trait Publisher: Send + Sync + 'static {
    fn send(&self, entry: Encoded) -> impl Future<Output = Result<(), PublishError>> + Send;
}

/// Publishes to an EventBridge (v2) Custom Event Bus: `EventGroupId` = the entity group, so FIFO
/// subscribers get each group in publish order; `DeduplicationId` = event_id.
pub struct EventBusPublisher {
    client: aws_sdk_eventbridgev2::Client,
    bus_arn: String,
}

impl EventBusPublisher {
    pub fn new(client: aws_sdk_eventbridgev2::Client, bus_arn: impl Into<String>) -> Self {
        Self {
            client,
            bus_arn: bus_arn.into(),
        }
    }

    pub async fn from_env(bus_arn: impl Into<String>) -> Self {
        let config = aws_config::load_from_env().await;
        Self::new(aws_sdk_eventbridgev2::Client::new(&config), bus_arn)
    }
}

impl Publisher for EventBusPublisher {
    async fn send(&self, entry: Encoded) -> Result<(), PublishError> {
        use aws_sdk_eventbridgev2::types::{PutEventsRequestEntry, PutEventsSystemMetadata};
        if !entry.detail.contains("\"sig\":\"ed25519:") {
            return Err(PublishError::Unsigned(entry.event_id));
        }
        let meta = PutEventsSystemMetadata::builder()
            .event_group_id(&entry.group)
            .deduplication_id(&entry.event_id)
            .build();
        let item = PutEventsRequestEntry::builder()
            .source(&entry.source)
            .detail_type(&entry.detail_type)
            .detail(&entry.detail)
            .system_metadata(meta)
            .build()
            .map_err(|e| PublishError::Bus(e.to_string()))?;
        let out = self
            .client
            .put_events()
            .event_bus_arn(&self.bus_arn)
            .entries(item)
            .send()
            .await
            .map_err(|e| PublishError::Bus(aws_sdk_eventbridgev2::error::DisplayErrorContext(&e).to_string()))?;
        if out.failed_entry_count() > 0 {
            let code = out.entries().first().and_then(|e| e.error_code()).unwrap_or("unknown");
            return Err(PublishError::Bus(format!("entry rejected: {code}")));
        }
        Ok(())
    }
}

/// A verified, validated event, ready for a handler.
#[derive(Debug)]
pub struct Verified<T> {
    pub envelope: v1::Envelope,
    pub tenant: oryxa_core::TenantId,
    pub data: T,
}

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("signature: {0}")]
    Signature(#[from] VerifyError),
    #[error("expected {expected}, got {got}")]
    WrongType { expected: &'static str, got: String },
    #[error("invalid envelope: {0}")]
    Envelope(String),
    #[error("invalid payload: {0}")]
    Payload(serde_json::Error),
}

/// The only way consumers should read events: verify the signature, then validate every
/// field they will trust. Payload JSON must match `T` exactly (unknown fields tolerated for
/// forward compatibility, wrong types are not).
pub fn decode<T: Event + serde::de::DeserializeOwned>(
    verifier: &Verifier,
    source: &str,
    detail_type: &str,
    detail: &str,
) -> Result<Verified<T>, DecodeError> {
    if source != T::SOURCE || detail_type != T::DETAIL_TYPE {
        return Err(DecodeError::WrongType {
            expected: T::DETAIL_TYPE,
            got: format!("{source} {detail_type}"),
        });
    }
    let mut detail = verifier.verify(source, detail_type, detail)?;
    let data = detail
        .as_object_mut()
        .and_then(|m| m.remove("data"))
        .ok_or(DecodeError::Envelope("no data".into()))?;
    let envelope: v1::Envelope = serde_json::from_value(detail).map_err(|e| DecodeError::Envelope(e.to_string()))?;
    let tenant = oryxa_core::TenantId::new(&envelope.tenant).map_err(|e| DecodeError::Envelope(e.to_string()))?;
    let id_ok = envelope.event_id.len() <= 64
        && envelope
            .event_id
            .strip_prefix("evt_")
            .is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_alphanumeric()));
    if !id_ok {
        return Err(DecodeError::Envelope("event_id".into()));
    }
    if let Some(actor) = &envelope.actor
        && !actor.user.is_empty()
    {
        oryxa_core::UserId::new(&actor.user).map_err(|e| DecodeError::Envelope(e.to_string()))?;
    }
    let data = serde_json::from_value(data).map_err(DecodeError::Payload)?;
    Ok(Verified { envelope, tenant, data })
}

/// Background sender: callers `try_send` into the channel and never wait on EventBridge.
/// Each entry is retried with backoff; after the last attempt it is logged and dropped.
// ponytail: in-memory queue, lost on crash. Fine for decision/notification events (the
// audit log is the record); state-changing producers must use an outbox instead.
pub fn spawn_publisher<P: Publisher>(publisher: P, capacity: usize) -> tokio::sync::mpsc::Sender<Encoded> {
    spawn_flushable_publisher(publisher, capacity).0
}

/// [`spawn_publisher`] plus a [`Flusher`], for hosts that may freeze between requests (Lambda).
pub fn spawn_flushable_publisher<P: Publisher>(
    publisher: P,
    capacity: usize,
) -> (tokio::sync::mpsc::Sender<Encoded>, Flusher) {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Encoded>(capacity);
    let flushed = Arc::new(tokio::sync::Notify::new());
    let notify = flushed.clone();
    tokio::spawn(async move {
        while let Some(entry) = rx.recv().await {
            if entry.event_id.is_empty() {
                // A flush marker: everything queued before it has been handled.
                notify.notify_waiters();
                continue;
            }
            let mut delay = std::time::Duration::from_millis(100);
            for attempt in 1..=5 {
                match publisher.send(entry.clone()).await {
                    Ok(()) => break,
                    Err(e) if attempt == 5 => {
                        tracing::error!(event_id = %entry.event_id, detail_type = %entry.detail_type, error = %e, "event dropped");
                    }
                    Err(_) => {
                        tokio::time::sleep(delay).await;
                        delay *= 2;
                    }
                }
            }
        }
    });
    let flusher = Flusher {
        tx: tx.clone(),
        flushed,
    };
    (tx, flusher)
}

/// Waits until everything queued so far has been sent (or dropped after its retries).
pub struct Flusher {
    tx: tokio::sync::mpsc::Sender<Encoded>,
    flushed: Arc<tokio::sync::Notify>,
}

impl Flusher {
    /// Queues a marker behind the pending events and waits for the sender to reach it. Callers
    /// bound it with a timeout (the Lambda deadline).
    pub async fn flush(&self) {
        let reached = self.flushed.notified();
        tokio::pin!(reached);
        reached.as_mut().enable();
        let marker = Encoded {
            event_id: String::new(),
            source: String::new(),
            detail_type: String::new(),
            group: String::new(),
            detail: String::new(),
        };
        if self.tx.send(marker).await.is_ok() {
            reached.await;
        }
    }
}

/// In-memory publisher for tests and local runs.
#[derive(Default)]
pub struct MemoryPublisher(pub Mutex<Vec<Encoded>>);

impl MemoryPublisher {
    pub fn sent(&self) -> Vec<Encoded> {
        self.0.lock().expect("lock").clone()
    }
}

impl Publisher for MemoryPublisher {
    async fn send(&self, entry: Encoded) -> Result<(), PublishError> {
        self.0.lock().expect("lock").push(entry);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oryxa_core::{AgentId, AgentRef, TenantId, UserId, VerifiedEmail};
    use serde_json::{Value, json};

    fn ctx() -> Ctx {
        Ctx {
            tenant: TenantId::new("org_1").unwrap(),
            user: UserId::new("user_1").unwrap(),
            email: VerifiedEmail::from_workos_verified("a@acme.com"),
            session_id: "s1".into(),
            agent_chain: vec![AgentRef {
                id: AgentId::new("ws_agent").unwrap(),
                kind: AgentKind::Workspace,
            }],
            trace_id: "req_1".into(),
        }
    }

    /// Slow and shared, so the test can see what was sent and when.
    struct Slow(Arc<MemoryPublisher>);

    impl Publisher for Slow {
        async fn send(&self, entry: Encoded) -> Result<(), PublishError> {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            self.0.send(entry).await
        }
    }

    #[tokio::test]
    async fn flush_returns_once_everything_queued_before_it_is_sent() {
        let sent = Arc::new(MemoryPublisher::default());
        let (tx, flusher) = spawn_flushable_publisher(Slow(sent.clone()), 10);
        for i in 0..3 {
            let mut e = encode(
                &new_envelope(),
                &v1::MemberJoined {
                    user: format!("u{i}"),
                    role: "member".into(),
                },
            )
            .unwrap();
            e.event_id = format!("ev{i}");
            tx.try_send(e).unwrap();
        }
        flusher.flush().await;
        let ids: Vec<_> = sent.sent().into_iter().map(|e| e.event_id).collect();
        assert_eq!(ids, ["ev0", "ev1", "ev2"], "the marker itself is never published");
        flusher.flush().await; // nothing pending: returns at once
    }

    #[test]
    fn wire_shape_has_envelope_tenant_actor_and_data() {
        let data = v1::ToolAuthorizationDecided {
            capability: "jira_create".into(),
            effect: "write".into(),
            allowed: false,
            reason: "not_invoker".into(),
            args_hash: "h".into(),
        };
        let e = encode(&envelope_for(&ctx()), &data).unwrap();
        assert_eq!(
            (e.source.as_str(), e.detail_type.as_str()),
            ("oryxa.gateway", "gateway.tool-authorization.decided.v1")
        );

        let v: Value = serde_json::from_str(&e.detail).unwrap();
        assert!(v["event_id"].as_str().unwrap().starts_with("evt_"));
        assert_eq!(v["version"], 1);
        assert_eq!(v["tenant"], "org_1");
        assert_eq!(v["actor"]["user"], "user_1");
        assert_eq!(
            v["actor"]["agent_chain"][0],
            json!({"id": "ws_agent", "kind": "workspace"})
        );
        assert_eq!(v["correlation_id"], "req_1");
        // Defaults must be present: a deny is `allowed: false`, not a missing field.
        assert_eq!(v["data"]["allowed"], false);
        assert_eq!(v["data"]["capability"], "jira_create");
        // Email never travels on the bus.
        assert!(!e.detail.contains("a@acme.com"));
        time::OffsetDateTime::parse(
            v["occurred_at"].as_str().unwrap(),
            &time::format_description::well_known::Rfc3339,
        )
        .unwrap();
    }

    #[test]
    fn catalog_names_follow_the_convention() {
        let mut seen = std::collections::HashSet::new();
        for (source, detail) in CATALOG {
            let svc = source.strip_prefix("oryxa.").unwrap();
            assert!(detail.starts_with(&format!("{svc}.")), "{detail} not under {svc}");
            let ok = detail
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
            assert!(ok && detail.rsplit('.').next().unwrap().starts_with('v'), "{detail}");
            assert!(seen.insert(*detail), "duplicate {detail}");
        }
    }

    #[test]
    fn oversized_payloads_are_refused() {
        let data = v1::SyncFinished {
            error: "x".repeat(MAX_DETAIL_BYTES),
            ..Default::default()
        };
        assert!(matches!(encode(&new_envelope(), &data), Err(PublishError::TooLarge(_))));
    }
}
