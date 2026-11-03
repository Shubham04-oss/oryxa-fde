//! Publishes one real event to a bus: `EVENT_BUS_ARN=<arn> cargo run -p oryxa-events --example publish_smoke`
use oryxa_events::{EventBusPublisher, Publisher, Signer, encode, new_envelope, v1};

#[tokio::main]
async fn main() {
    let bus = std::env::var("EVENT_BUS_ARN").expect("EVENT_BUS_ARN");
    let envelope = v1::Envelope {
        tenant: "org_smoke".into(),
        ..new_envelope()
    };
    let data = v1::ToolAuthorizationDecided {
        capability: "smoke_test".into(),
        effect: "read".into(),
        allowed: false,
        reason: "smoke".into(),
        args_hash: String::new(),
    };
    let mut entry = encode(&envelope, &data).expect("encode");
    // Throwaway key: the bus refuses unsigned events.
    use ed25519_dalek::pkcs8::{EncodePrivateKey, spki::der::pem::LineEnding};
    let key = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
    let pem = key.to_pkcs8_pem(LineEnding::LF).expect("pem");
    Signer::from_pkcs8_pem("smoke", &pem)
        .expect("signer")
        .sign(&mut entry)
        .expect("sign");
    println!("sending {} ({})", entry.event_id, entry.detail_type);
    EventBusPublisher::from_env(bus)
        .await
        .send(entry)
        .await
        .expect("publish");
    println!("accepted by EventBridge");
}
