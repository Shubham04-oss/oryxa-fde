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
    /// It cannot be trusted, read or applied (bad signature, wrong payload, data a rule refuses):
    /// never act on it. It is logged with its ids and deleted, so it does not hold its FIFO group
    /// back; the bus archive keeps the event.
    Quarantine,
}

#[cfg(feature = "sqs")]
pub mod sqs {
    //! Reads one SQS FIFO queue (fed by an EventBridge FIFO subscriber) and hands each message
    //! to a handler. Within a message group SQS releases the next message only once the current
    //! one is deleted, so a message that is retried holds its group back: events of one project
    //! are handled in order. A quarantined one is deleted, as a handled one is.

    use std::future::Future;
    use std::time::Duration;

    use aws_sdk_sqs::Client;

    use super::{Message, Outcome};

    const WAIT: i32 = 20;
    /// One message at a time: a worker that dies on one (a crafted file exhausting its memory)
    /// costs only that message's delivery, never other tenants' messages received with it.
    const BATCH: i32 = 1;
    /// Seconds each heartbeat keeps the message hidden from other consumers.
    const VISIBILITY: i32 = 120;
    /// How often a message being handled is kept hidden, starting at once: a long handler (a large
    /// document, thousands of Bedrock calls) is never redelivered while it runs, and a worker that
    /// dies lets its message go within [`VISIBILITY`] seconds.
    const HEARTBEAT: Duration = Duration::from_secs(40);
    /// The longest one message is handled: past it the handler is dropped and the message is no
    /// longer kept hidden, so a hung handler cannot hold its message, and its FIFO group, for ever.
    /// Far above a real document (2M characters is under 2,000 chunks to embed).
    const MAX_HANDLING: Duration = Duration::from_secs(15 * 60);

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
                let parsed = m.body.as_deref().and_then(Message::parse);
                let detail_type = parsed.as_ref().map(|p| p.detail_type.clone());
                let work = async {
                    match parsed {
                        Some(msg) => handle(msg).await,
                        None => Outcome::Quarantine,
                    }
                };
                let outcome = with_heartbeat(work, HEARTBEAT, MAX_HANDLING, || hide(&client, &queue_url, &receipt))
                    .await
                    .unwrap_or_else(|| {
                        // Redelivered once its visibility lapses; handlers resume where they stopped.
                        tracing::error!(message_id = ?m.message_id, "handler gave up after the ceiling");
                        Outcome::Retry
                    });
                let ids = (m.message_id.as_deref(), detail_type.as_deref());
                finish(&client, &queue_url, &receipt, ids, outcome).await;
            }
        }
    }

    /// Settles a handled message: deleted when done or quarantined, left for redelivery when
    /// retried. A failed delete is only logged: the message comes back and is handled, or
    /// quarantined, again, which handlers allow.
    pub(crate) async fn finish(
        client: &Client,
        queue_url: &str,
        receipt: &str,
        (message_id, detail_type): (Option<&str>, Option<&str>),
        outcome: Outcome,
    ) {
        match outcome {
            Outcome::Retry => {
                tracing::warn!(message_id, detail_type, "event left for redelivery");
                return;
            }
            Outcome::Quarantine => tracing::error!(message_id, detail_type, "event quarantined and deleted"),
            Outcome::Done => {}
        }
        if let Err(e) = client
            .delete_message()
            .queue_url(queue_url)
            .receipt_handle(receipt)
            .send()
            .await
        {
            tracing::warn!(message_id, error = %e, "sqs delete failed");
        }
    }

    /// Keeps the message hidden for another [`VISIBILITY`] seconds. A failure is only logged: at
    /// worst the message is delivered again, which handlers allow.
    async fn hide(client: &Client, queue_url: &str, receipt: &str) {
        if let Err(e) = client
            .change_message_visibility()
            .queue_url(queue_url)
            .receipt_handle(receipt)
            .visibility_timeout(VISIBILITY)
            .send()
            .await
        {
            tracing::warn!(error = %e, "sqs visibility extension failed");
        }
    }

    /// Runs `work`, calling `beat` at once and then every `every` until `work` finishes, or until
    /// `ceiling` has passed: then `work` is dropped and the answer is `None`.
    pub(crate) async fn with_heartbeat<T, B, BF>(
        work: impl Future<Output = T>,
        every: Duration,
        ceiling: Duration,
        mut beat: B,
    ) -> Option<T>
    where
        B: FnMut() -> BF,
        BF: Future<Output = ()>,
    {
        let mut work = std::pin::pin!(work);
        let mut tick = tokio::time::interval(every);
        let deadline = tokio::time::sleep(ceiling);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                biased;
                out = &mut work => return Some(out),
                _ = &mut deadline => return None,
                _ = tick.tick() => beat().await,
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use std::cell::Cell;

        use super::*;

        fn capturing() -> (Client, aws_smithy_http_client::test_util::CaptureRequestReceiver) {
            use aws_sdk_sqs::config::{BehaviorVersion, Credentials, Region};
            let (http, requests) = aws_smithy_http_client::test_util::capture_request(None);
            let conf = aws_sdk_sqs::Config::builder()
                .behavior_version(BehaviorVersion::latest())
                .region(Region::new("eu-west-2"))
                .credentials_provider(Credentials::new("AKIDTEST", "secret", None, None, "test"))
                .http_client(http)
                .build();
            (Client::from_conf(conf), requests)
        }

        #[tokio::test]
        async fn a_quarantined_message_is_deleted_and_a_retried_one_is_not() {
            let queue = "https://sqs.eu-west-2.amazonaws.com/123456789012/lifecycle.fifo";
            for outcome in [Outcome::Quarantine, Outcome::Done] {
                let (client, requests) = capturing();
                finish(&client, queue, "receipt-1", (Some("m-1"), Some("fde.x.v1")), outcome).await;
                let sent = requests.expect_request();
                let action = sent.headers().get("x-amz-target").unwrap_or_default().to_owned();
                let body = std::str::from_utf8(sent.body().bytes().unwrap_or_default())
                    .unwrap_or_default()
                    .to_owned();
                assert!(
                    action.ends_with("DeleteMessage") && body.contains("receipt-1"),
                    "{outcome:?}: {action} {body}"
                );
            }
            let (client, requests) = capturing();
            finish(&client, queue, "receipt-1", (Some("m-1"), None), Outcome::Retry).await;
            requests.expect_no_request();
        }

        #[tokio::test(start_paused = true)]
        async fn a_message_is_kept_hidden_from_the_start_until_its_handler_ends() {
            let beats = Cell::new(0);
            let started = tokio::time::Instant::now();
            let work = async {
                tokio::time::sleep(Duration::from_secs(130)).await;
                "done"
            };
            let out = with_heartbeat(work, HEARTBEAT, MAX_HANDLING, || {
                beats.set(beats.get() + 1);
                async {}
            })
            .await;
            assert_eq!(out, Some("done"));
            assert_eq!(started.elapsed(), Duration::from_secs(130));
            // At 0, 40, 80 and 120 seconds: never more than HEARTBEAT apart, and none after the end.
            assert_eq!(beats.get(), 4);
            const { assert!(HEARTBEAT.as_secs() * 2 < VISIBILITY as u64) };
        }

        #[tokio::test(start_paused = true)]
        async fn a_handler_that_ends_at_once_needs_no_heartbeat() {
            let beats = Cell::new(0);
            let out = with_heartbeat(async { 7 }, HEARTBEAT, MAX_HANDLING, || {
                beats.set(beats.get() + 1);
                async {}
            })
            .await;
            assert_eq!((out, beats.get()), (Some(7), 0));
        }

        #[tokio::test(start_paused = true)]
        async fn a_hung_handler_is_dropped_at_the_ceiling_and_no_longer_hidden() {
            let beats = Cell::new(0);
            let started = tokio::time::Instant::now();
            let out = with_heartbeat(std::future::pending::<()>(), HEARTBEAT, MAX_HANDLING, || {
                beats.set(beats.get() + 1);
                async {}
            })
            .await;
            assert_eq!(out, None);
            assert_eq!(started.elapsed(), MAX_HANDLING);
            // Hidden from 0 s every 40 s while it ran, and never after: the message comes back.
            assert_eq!(beats.get(), (MAX_HANDLING.as_secs() / HEARTBEAT.as_secs()) as usize + 1);
            let at_end = beats.get();
            tokio::time::sleep(HEARTBEAT * 3).await;
            assert_eq!(beats.get(), at_end);
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
