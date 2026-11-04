//! The consumer side of the bus: an EventBridge message as an SQS queue delivers it, and (with
//! the `sqs` feature) the loop that reads one queue. A handler decodes the message with
//! `oryxa_events::decode`, which verifies the signature before anything is trusted.

use serde_json::Value;

/// One event off the bus: what `oryxa_events::decode` takes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub source: String,
    pub detail_type: String,
    /// The detail object as JSON text. EventBridge delivers it as an object, possibly with its
    /// keys reordered; the signature covers its canonical form, so re-serialising is safe.
    pub detail: String,
}

impl Message {
    /// From an SQS message body. `None` if it is not an EventBridge event.
    pub fn parse(body: &str) -> Option<Self> {
        let v: Value = serde_json::from_str(body).ok()?;
        let detail = v.get("detail").filter(|d| d.is_object())?;
        Some(Self {
            source: v.get("source")?.as_str()?.to_owned(),
            detail_type: v.get("detail-type")?.as_str()?.to_owned(),
            detail: detail.to_string(),
        })
    }
}

/// Why `oryxa_events::decode` refused an event, for logs: a code, never the error text, which
/// can quote the payload.
pub fn refusal(e: &oryxa_events::DecodeError) -> &'static str {
    match e {
        oryxa_events::DecodeError::Signature(_) => "signature",
        oryxa_events::DecodeError::WrongType { .. } => "wrong_type",
        oryxa_events::DecodeError::Envelope(_) => "envelope",
        oryxa_events::DecodeError::Payload(_) => "payload",
    }
}

/// What a handler did with a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Handled, or nothing to do (a redelivery, an event this consumer ignores): delete it.
    Done,
    /// A dependency failed; leave it to be redelivered after the visibility timeout.
    Retry,
    /// It cannot be trusted or read (bad signature, wrong payload): never act on it. It stays in
    /// the queue until the redrive policy moves it to the dead-letter queue.
    Quarantine,
}

#[cfg(feature = "sqs")]
pub mod sqs {
    //! Reads one SQS FIFO queue (fed by an EventBridge FIFO subscriber) and hands each message
    //! to a handler. Within a message group SQS releases the next message only once the current
    //! one is deleted, so a message that is retried or quarantined holds its group back: events
    //! of one project are handled in order.

    use std::future::Future;
    use std::time::Duration;

    use aws_sdk_sqs::Client;

    use super::{Message, Outcome};

    const WAIT: i32 = 20;
    const BATCH: i32 = 10;

    /// Runs forever. `handle` must be idempotent: SQS delivers at least once.
    pub async fn run<F, Fut>(client: Client, queue_url: String, handle: F)
    where
        F: Fn(Message) -> Fut,
        Fut: Future<Output = Outcome>,
    {
        loop {
            let received = client
                .receive_message()
                .queue_url(&queue_url)
                .max_number_of_messages(BATCH)
                .wait_time_seconds(WAIT)
                .send()
                .await;
            let messages = match received {
                Ok(r) => r.messages.unwrap_or_default(),
                Err(e) => {
                    tracing::warn!(error = %e, "sqs receive failed");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            for m in messages {
                let Some(receipt) = m.receipt_handle else { continue };
                let outcome = match m.body.as_deref().and_then(Message::parse) {
                    Some(msg) => handle(msg).await,
                    None => Outcome::Quarantine,
                };
                match outcome {
                    Outcome::Done => {
                        if let Err(e) = client
                            .delete_message()
                            .queue_url(&queue_url)
                            .receipt_handle(receipt)
                            .send()
                            .await
                        {
                            // Redelivered later; handlers are idempotent.
                            tracing::warn!(error = %e, "sqs delete failed");
                        }
                    }
                    Outcome::Retry => tracing::warn!(message_id = ?m.message_id, "event left for redelivery"),
                    Outcome::Quarantine => {
                        tracing::error!(message_id = ?m.message_id, "event quarantined")
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_eventbridge_message_as_sqs_delivers_it() {
        let body = r#"{"version":"0","id":"x","detail-type":"fde.document.uploaded.v1","source":"oryxa.fde",
            "detail":{"data":{"company":"cmp_1","document":"doc_1"},"tenant":"org_1"}}"#;
        let m = Message::parse(body).unwrap();
        assert_eq!(
            (m.source.as_str(), m.detail_type.as_str()),
            ("oryxa.fde", "fde.document.uploaded.v1")
        );
        let detail: Value = serde_json::from_str(&m.detail).unwrap();
        assert_eq!(detail["data"]["document"], "doc_1");
    }

    #[test]
    fn anything_else_is_not_a_message() {
        for bad in [
            "",
            "not json",
            "[]",
            r#"{"source":"oryxa.fde","detail-type":"x"}"#,
            r#"{"source":"oryxa.fde","detail-type":"x","detail":"a string"}"#,
            r#"{"source":1,"detail-type":"x","detail":{}}"#,
        ] {
            assert_eq!(Message::parse(bad), None, "{bad:?}");
        }
    }
}
