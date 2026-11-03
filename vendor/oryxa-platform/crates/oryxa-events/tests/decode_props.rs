//! decode is the only way consumers read the bus: garbage and tampered events must be rejected,
//! never panic, and never come back as a valid event.

use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
use oryxa_events::{Encoded, Signer, Verifier, decode, encode, new_envelope, v1};
use proptest::prelude::*;

type Decided = v1::ToolAuthorizationDecided;
const SOURCE: &str = "oryxa.gateway";
const DETAIL_TYPE: &str = "gateway.tool-authorization.decided.v1";

fn keys() -> (Signer, Verifier) {
    let k = SigningKey::generate(&mut rand::rngs::OsRng);
    let signer = Signer::from_pkcs8_pem("gw-1", &k.to_pkcs8_pem(LineEnding::LF).unwrap()).unwrap();
    let public = k.verifying_key().to_public_key_pem(LineEnding::LF).unwrap();
    (signer, Verifier::default().trust("gw-1", SOURCE, &public).unwrap())
}

fn signed(signer: &Signer) -> Encoded {
    let data = Decided {
        capability: "jira_create".into(),
        effect: "write".into(),
        allowed: false,
        reason: "not_invoker".into(),
        args_hash: "h".into(),
    };
    let envelope = v1::Envelope {
        tenant: "org_1".into(),
        ..new_envelope()
    };
    let mut e = encode(&envelope, &data).unwrap();
    signer.sign(&mut e).unwrap();
    e
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn arbitrary_details_never_decode(detail in "\\PC*", bytes in prop::collection::vec(any::<u8>(), 0..512)) {
        let (_, verifier) = keys();
        prop_assert!(decode::<Decided>(&verifier, SOURCE, DETAIL_TYPE, &detail).is_err());
        let lossy = String::from_utf8_lossy(&bytes);
        prop_assert!(decode::<Decided>(&verifier, SOURCE, DETAIL_TYPE, &lossy).is_err());
    }

    #[test]
    fn any_changed_character_is_rejected(pos in any::<prop::sample::Index>(), ch in prop::char::range(' ', '~')) {
        let (signer, verifier) = keys();
        let e = signed(&signer);
        prop_assert!(decode::<Decided>(&verifier, SOURCE, DETAIL_TYPE, &e.detail).is_ok());

        let mut chars: Vec<char> = e.detail.chars().collect();
        let i = pos.index(chars.len());
        prop_assume!(chars[i] != ch);
        chars[i] = ch;
        let tampered: String = chars.into_iter().collect();
        prop_assert!(
            decode::<Decided>(&verifier, SOURCE, DETAIL_TYPE, &tampered).is_err(),
            "accepted after changing byte {i} to {ch:?}: {tampered}"
        );
    }

    #[test]
    fn dropped_or_replaced_fields_are_rejected(field in any::<prop::sample::Index>(), value in "\\PC{0,20}") {
        let (signer, verifier) = keys();
        let e = signed(&signer);
        let obj: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&e.detail).unwrap();
        let key = obj.keys().nth(field.index(obj.len())).unwrap().clone();

        let mut dropped = obj.clone();
        dropped.remove(&key);
        let dropped = serde_json::Value::Object(dropped).to_string();
        prop_assert!(decode::<Decided>(&verifier, SOURCE, DETAIL_TYPE, &dropped).is_err(), "accepted without {key}");

        prop_assume!(obj[&key] != serde_json::Value::String(value.clone()));
        let mut replaced = obj;
        replaced.insert(key.clone(), serde_json::Value::String(value));
        let replaced = serde_json::Value::Object(replaced).to_string();
        prop_assert!(decode::<Decided>(&verifier, SOURCE, DETAIL_TYPE, &replaced).is_err(), "accepted with {key} replaced");
    }

    #[test]
    fn a_valid_event_under_another_name_is_rejected(source in "\\PC{0,30}", detail_type in "\\PC{0,50}") {
        prop_assume!(source != SOURCE || detail_type != DETAIL_TYPE);
        let (signer, verifier) = keys();
        let e = signed(&signer);
        prop_assert!(decode::<Decided>(&verifier, &source, &detail_type, &e.detail).is_err());
    }
}
