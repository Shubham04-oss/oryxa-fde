//! canonical_json is what event signatures and approval hashes are computed over, so any
//! reordering of keys (EventBridge may do this in transit) must give byte-identical output.

use oryxa_core::canonical_json;
use proptest::prelude::*;
use serde_json::{Map, Value};

fn json() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i64>().prop_map(Value::from),
        any::<u64>().prop_map(Value::from),
        any::<String>().prop_map(Value::String),
    ];
    leaf.prop_recursive(4, 64, 8, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
            prop::collection::vec((any::<String>(), inner), 0..6)
                .prop_map(|kv| Value::Object(kv.into_iter().collect::<Map<_, _>>())),
        ]
    })
}

/// Same value with every object's keys in a different insertion order (arrays keep order).
fn reshuffle(v: &Value, seed: &mut u64) -> Value {
    match v {
        Value::Object(m) => {
            let mut entries: Vec<_> = m.iter().map(|(k, v)| (k.clone(), reshuffle(v, seed))).collect();
            for i in (1..entries.len()).rev() {
                *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                entries.swap(i, (*seed >> 33) as usize % (i + 1));
            }
            Value::Object(entries.into_iter().collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| reshuffle(x, seed)).collect()),
        other => other.clone(),
    }
}

proptest! {
    #[test]
    fn key_order_never_changes_the_output(v in json(), mut seed in any::<u64>()) {
        prop_assert_eq!(canonical_json(&v), canonical_json(&reshuffle(&v, &mut seed)));
    }

    #[test]
    fn output_is_valid_json_of_the_same_value_and_a_fixed_point(v in json()) {
        let out = canonical_json(&v);
        let back: Value = serde_json::from_str(&out).unwrap();
        prop_assert_eq!(&back, &v);
        prop_assert_eq!(canonical_json(&back), out);
    }
}
