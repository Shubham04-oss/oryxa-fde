//! The JSON Schema grader's validator: a strict subset of JSON Schema. A schema using a keyword outside the
//! subset is refused when the suite is created, never silently ignored, so a suite cannot pass cases its author
//! meant to fail.
//!
//! Supported: `type` (one or a list), `properties`, `required`, `additionalProperties` (bool or schema), `items`,
//! `enum`, `const`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`,
//! `pattern`, `minItems`, `maxItems`, and the annotations `title`, `description`, `$comment`, `$schema`.

use regex::{Regex, RegexBuilder};
use serde_json::{Map, Value};

const MAX_DEPTH: usize = 32;
const MAX_PATTERN: usize = 512;
const ANNOTATIONS: [&str; 4] = ["title", "description", "$comment", "$schema"];
const TYPES: [&str; 7] = ["object", "array", "string", "number", "integer", "boolean", "null"];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("unsupported or invalid JSON schema at {path}: {problem}")]
pub struct SchemaError {
    pub path: String,
    pub problem: String,
}

fn err(path: &str, problem: impl Into<String>) -> SchemaError {
    SchemaError {
        path: if path.is_empty() { "/".into() } else { path.into() },
        problem: problem.into(),
    }
}

fn pattern(p: &str) -> Option<Regex> {
    (p.len() <= MAX_PATTERN)
        .then(|| RegexBuilder::new(p).size_limit(1 << 20).build().ok())
        .flatten()
}

/// Checks that `schema` only uses the supported subset, well formed.
pub fn check(schema: &Value) -> Result<(), SchemaError> {
    check_at(schema, "", 0)
}

fn check_at(schema: &Value, path: &str, depth: usize) -> Result<(), SchemaError> {
    if depth > MAX_DEPTH {
        return Err(err(path, "nested too deeply"));
    }
    let Value::Object(s) = schema else {
        return Err(err(path, "a schema must be an object"));
    };
    for (key, value) in s {
        let at = format!("{path}/{key}");
        let ok = match key.as_str() {
            k if ANNOTATIONS.contains(&k) => true,
            "type" => match value {
                Value::String(t) => TYPES.contains(&t.as_str()),
                Value::Array(ts) => !ts.is_empty() && ts.iter().all(|t| t.as_str().is_some_and(|t| TYPES.contains(&t))),
                _ => false,
            },
            "properties" => match value {
                Value::Object(props) => {
                    for (name, sub) in props {
                        check_at(sub, &format!("{at}/{name}"), depth + 1)?;
                    }
                    true
                }
                _ => false,
            },
            "required" => value.as_array().is_some_and(|r| r.iter().all(Value::is_string)),
            "additionalProperties" => match value {
                Value::Bool(_) => true,
                sub => {
                    check_at(sub, &at, depth + 1)?;
                    true
                }
            },
            "items" => {
                check_at(value, &at, depth + 1)?;
                true
            }
            "enum" => value.is_array(),
            "const" => true,
            "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum" => value.is_number(),
            "minLength" | "maxLength" | "minItems" | "maxItems" => value.is_u64(),
            "pattern" => value.as_str().and_then(pattern).is_some(),
            _ => return Err(err(&at, "keyword is not supported")),
        };
        if !ok {
            return Err(err(&at, "invalid value"));
        }
    }
    Ok(())
}

/// The first place `value` breaks `schema`, which `check` accepted.
pub fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    validate_at(schema, value, "")
}

fn type_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn has_type(value: &Value, t: &str) -> bool {
    match t {
        "integer" => value.as_f64().is_some_and(|n| n.fract() == 0.0),
        "number" => value.is_number(),
        other => type_of(value) == other,
    }
}

fn validate_at(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    let Value::Object(s) = schema else {
        return Ok(());
    };
    let at = || {
        if path.is_empty() {
            "/".to_owned()
        } else {
            path.to_owned()
        }
    };
    if let Some(t) = s.get("type") {
        let types: Vec<&str> = match t {
            Value::String(one) => vec![one.as_str()],
            Value::Array(many) => many.iter().filter_map(Value::as_str).collect(),
            _ => vec![],
        };
        if !types.iter().any(|t| has_type(value, t)) {
            return Err(format!("{}: expected {}", at(), types.join(" or ")));
        }
    }
    if let Some(Value::Array(options)) = s.get("enum")
        && !options.contains(value)
    {
        return Err(format!("{}: not one of the allowed values", at()));
    }
    if let Some(c) = s.get("const")
        && c != value
    {
        return Err(format!("{}: not the expected constant", at()));
    }
    if let Some(n) = value.as_f64() {
        let bound = |k: &str| s.get(k).and_then(Value::as_f64);
        let broken = bound("minimum").is_some_and(|m| n < m)
            || bound("maximum").is_some_and(|m| n > m)
            || bound("exclusiveMinimum").is_some_and(|m| n <= m)
            || bound("exclusiveMaximum").is_some_and(|m| n >= m);
        if broken {
            return Err(format!("{}: out of range", at()));
        }
    }
    let count = |k: &str| s.get(k).and_then(Value::as_u64);
    if let Value::String(text) = value {
        let chars = text.chars().count() as u64;
        if count("minLength").is_some_and(|m| chars < m) || count("maxLength").is_some_and(|m| chars > m) {
            return Err(format!("{}: length out of range", at()));
        }
        if let Some(p) = s.get("pattern").and_then(Value::as_str)
            && !pattern(p).is_some_and(|re| re.is_match(text))
        {
            return Err(format!("{}: does not match the pattern", at()));
        }
    }
    if let Value::Array(items) = value {
        let n = items.len() as u64;
        if count("minItems").is_some_and(|m| n < m) || count("maxItems").is_some_and(|m| n > m) {
            return Err(format!("{}: item count out of range", at()));
        }
        if let Some(item) = s.get("items") {
            for (i, v) in items.iter().enumerate() {
                validate_at(item, v, &format!("{path}/{i}"))?;
            }
        }
    }
    if let Value::Object(fields) = value {
        object(s, fields, path)?;
    }
    Ok(())
}

fn object(s: &Map<String, Value>, fields: &Map<String, Value>, path: &str) -> Result<(), String> {
    if let Some(Value::Array(required)) = s.get("required") {
        for name in required.iter().filter_map(Value::as_str) {
            if !fields.contains_key(name) {
                return Err(format!("{path}/{name}: required"));
            }
        }
    }
    let props = s.get("properties").and_then(Value::as_object);
    for (name, v) in fields {
        let at = format!("{path}/{name}");
        match props.and_then(|p| p.get(name)) {
            Some(sub) => validate_at(sub, v, &at)?,
            None => match s.get("additionalProperties") {
                Some(Value::Bool(false)) => return Err(format!("{at}: not allowed")),
                Some(sub @ Value::Object(_)) => validate_at(sub, v, &at)?,
                _ => {}
            },
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn answer() -> Value {
        json!({
            "type": "object",
            "required": ["status", "items"],
            "additionalProperties": false,
            "properties": {
                "status": { "enum": ["ok", "degraded"] },
                "latency_ms": { "type": "integer", "minimum": 0, "exclusiveMaximum": 60000 },
                "items": { "type": "array", "minItems": 1, "items": { "type": "string", "pattern": "^svc-", "maxLength": 20 } },
                "note": { "type": ["string", "null"] }
            }
        })
    }

    #[test]
    fn accepts_values_that_match() {
        check(&answer()).unwrap();
        let ok = json!({ "status": "ok", "latency_ms": 120, "items": ["svc-api"], "note": null });
        assert_eq!(validate(&answer(), &ok), Ok(()));
    }

    #[test]
    fn names_the_first_violation() {
        let s = answer();
        for (value, at) in [
            (json!({ "items": ["svc-a"] }), "/status: required"),
            (json!({ "status": "down", "items": ["svc-a"] }), "/status: not one of"),
            (json!({ "status": "ok", "items": [] }), "/items: item count"),
            (json!({ "status": "ok", "items": ["db"] }), "/items/0: does not match"),
            (
                json!({ "status": "ok", "items": ["svc-a"], "latency_ms": 1.5 }),
                "/latency_ms: expected integer",
            ),
            (
                json!({ "status": "ok", "items": ["svc-a"], "latency_ms": 60000 }),
                "/latency_ms: out of range",
            ),
            (
                json!({ "status": "ok", "items": ["svc-a"], "extra": 1 }),
                "/extra: not allowed",
            ),
            (json!(["not", "an", "object"]), "/: expected object"),
        ] {
            let e = validate(&s, &value).unwrap_err();
            assert!(e.starts_with(at), "{e} should start with {at}");
        }
    }

    #[test]
    fn refuses_keywords_it_does_not_enforce() {
        for (schema, at) in [
            (json!({ "oneOf": [{ "type": "string" }] }), "/oneOf"),
            (
                json!({ "properties": { "a": { "$ref": "#/x" } } }),
                "/properties/a/$ref",
            ),
            (json!({ "type": "text" }), "/type"),
            (json!({ "pattern": "(" }), "/pattern"),
            (json!({ "minLength": -1 }), "/minLength"),
            (json!("string"), "/"),
        ] {
            assert_eq!(check(&schema).unwrap_err().path, at, "{schema}");
        }
        let mut deep = json!({});
        for _ in 0..40 {
            deep = json!({ "items": deep });
        }
        assert_eq!(check(&deep).unwrap_err().problem, "nested too deeply");
    }
}
