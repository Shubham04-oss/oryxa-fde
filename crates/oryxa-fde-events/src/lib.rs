//! FDE event payloads on the platform's bus contract (`oryxa_events`). Every type binds to source
//! `oryxa.fde` and a detail type `fde.<entity>.<verb>.v1`. Payloads hold validated ids, enums and
//! counts only, so no name, email or customer text can reach the bus through them.
//!
//! Project events stay in order per project and company events per company: `entity_key` returns
//! the project or company id, which makes the bus group match `ProjectScope::event_group` and
//! `CompanyScope::event_group`.

use oryxa_events::Event;
use oryxa_fde_core::{AccessRequestId, AgentRunId, CompanyId, DocumentId, EvalRunId, ProjectId, Stage};
use serde::{Deserialize, Serialize};

pub const SOURCE: &str = "oryxa.fde";

/// Where an access request stands with the customer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessStatus {
    Requested,
    InProgress,
    Granted,
    Denied,
    Revoked,
}

/// How an agent run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompanyCreated {
    pub company: CompanyId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectCreated {
    pub company: CompanyId,
    pub project: ProjectId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectStageChanged {
    pub company: CompanyId,
    pub project: ProjectId,
    pub from: Stage,
    pub to: Stage,
}

/// The customer signed off a version of the project's scope and success criteria.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeSignedOff {
    pub company: CompanyId,
    pub project: ProjectId,
    pub version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessRequestStatusChanged {
    pub company: CompanyId,
    pub project: ProjectId,
    pub access_request: AccessRequestId,
    pub from: AccessStatus,
    pub to: AccessStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentUploaded {
    pub company: CompanyId,
    pub document: DocumentId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRunFinished {
    pub company: CompanyId,
    pub project: ProjectId,
    pub agent_run: AgentRunId,
    pub outcome: RunOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvalRunFinished {
    pub company: CompanyId,
    pub project: ProjectId,
    pub eval_run: EvalRunId,
    pub passed: u32,
    pub failed: u32,
}

macro_rules! events {
    ($($ty:ident => $detail:literal, ordered by $entity:ident;)*) => {
        $(impl Event for $ty {
            const SOURCE: &'static str = SOURCE;
            const DETAIL_TYPE: &'static str = $detail;
            fn entity_key(&self) -> Option<&str> {
                Some(self.$entity.as_str())
            }
        })*
        /// Every detail type FDE emits under [`SOURCE`]; consumers derive rule patterns from it.
        pub const CATALOG: &[&str] = &[$($detail),*];
    };
}

events! {
    CompanyCreated => "fde.company.created.v1", ordered by company;
    ProjectCreated => "fde.project.created.v1", ordered by project;
    ProjectStageChanged => "fde.project.stage-changed.v1", ordered by project;
    ScopeSignedOff => "fde.scope.signed-off.v1", ordered by project;
    AccessRequestStatusChanged => "fde.access-request.status-changed.v1", ordered by project;
    DocumentUploaded => "fde.document.uploaded.v1", ordered by company;
    AgentRunFinished => "fde.agent-run.finished.v1", ordered by project;
    EvalRunFinished => "fde.eval-run.finished.v1", ordered by project;
}

#[cfg(test)]
mod tests {
    use std::fmt::Debug;

    use ed25519_dalek::SigningKey;
    use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
    use ed25519_dalek::pkcs8::{EncodePrivateKey, EncodePublicKey};
    use oryxa_core::TenantId;
    use oryxa_events::{DecodeError, Encoded, Signer, Verifier, decode, encode, new_envelope, v1};
    use oryxa_fde_core::{CompanyScope, ProjectScope};
    use serde::de::DeserializeOwned;
    use serde_json::Value;

    use super::*;

    fn keys() -> (Signer, Verifier) {
        let k = SigningKey::generate(&mut rand::rngs::OsRng);
        let signer = Signer::from_pkcs8_pem("fde-1", &k.to_pkcs8_pem(LineEnding::LF).unwrap()).unwrap();
        let public = k.verifying_key().to_public_key_pem(LineEnding::LF).unwrap();
        (signer, Verifier::default().trust("fde-1", SOURCE, &public).unwrap())
    }

    fn company() -> CompanyScope {
        CompanyScope::new(TenantId::new("org_1").unwrap(), CompanyId::new("cmp_1").unwrap())
    }

    fn project() -> ProjectScope {
        company().project(ProjectId::new("prj_1").unwrap())
    }

    fn signed<T: Event>(signer: &Signer, data: &T) -> Encoded {
        let envelope = v1::Envelope {
            tenant: "org_1".into(),
            ..new_envelope()
        };
        let mut e = encode(&envelope, data).unwrap();
        signer.sign(&mut e).unwrap();
        e
    }

    /// Encodes, signs and decodes `data`; checks the payload survives and the bus group is `group`.
    fn round_trip<T: Event + DeserializeOwned + PartialEq + Debug>(data: T, group: String) {
        let (signer, verifier) = keys();
        let e = signed(&signer, &data);
        assert_eq!((e.source.as_str(), e.detail_type.as_str()), (SOURCE, T::DETAIL_TYPE));
        assert_eq!(e.group, group, "{}", T::DETAIL_TYPE);
        let got = decode::<T>(&verifier, &e.source, &e.detail_type, &e.detail).unwrap();
        assert_eq!(got.tenant.as_str(), "org_1");
        assert_eq!(got.data, data);
    }

    fn samples() -> Vec<(&'static str, Value)> {
        fn sample<T: Event>(data: T) -> (&'static str, Value) {
            (T::DETAIL_TYPE, serde_json::to_value(&data).unwrap())
        }
        let p = project();
        vec![
            sample(CompanyCreated {
                company: p.company.company.clone(),
            }),
            sample(ProjectCreated {
                company: p.company.company.clone(),
                project: p.project.clone(),
            }),
            sample(ProjectStageChanged {
                company: p.company.company.clone(),
                project: p.project.clone(),
                from: Stage::Discover,
                to: Stage::Scope,
            }),
            sample(ScopeSignedOff {
                company: p.company.company.clone(),
                project: p.project.clone(),
                version: 3,
            }),
            sample(AccessRequestStatusChanged {
                company: p.company.company.clone(),
                project: p.project.clone(),
                access_request: AccessRequestId::new("acc_1").unwrap(),
                from: AccessStatus::Requested,
                to: AccessStatus::InProgress,
            }),
            sample(DocumentUploaded {
                company: p.company.company.clone(),
                document: DocumentId::new("doc_1").unwrap(),
            }),
            sample(AgentRunFinished {
                company: p.company.company.clone(),
                project: p.project.clone(),
                agent_run: AgentRunId::new("run_1").unwrap(),
                outcome: RunOutcome::Succeeded,
            }),
            sample(EvalRunFinished {
                company: p.company.company.clone(),
                project: p.project.clone(),
                eval_run: EvalRunId::new("evr_1").unwrap(),
                passed: 41,
                failed: 2,
            }),
        ]
    }
    #[test]
    fn every_event_round_trips_and_groups_by_its_entity() {
        let p = project();
        let (c, prj) = (p.company.company.clone(), p.project.clone());
        let by_company = p.company.event_group();
        let by_project = p.event_group();
        round_trip(CompanyCreated { company: c.clone() }, by_company.clone());
        round_trip(
            ProjectCreated {
                company: c.clone(),
                project: prj.clone(),
            },
            by_project.clone(),
        );
        round_trip(
            ProjectStageChanged {
                company: c.clone(),
                project: prj.clone(),
                from: Stage::Build,
                to: Stage::Evaluate,
            },
            by_project.clone(),
        );
        round_trip(
            ScopeSignedOff {
                company: c.clone(),
                project: prj.clone(),
                version: 2,
            },
            by_project.clone(),
        );
        round_trip(
            AccessRequestStatusChanged {
                company: c.clone(),
                project: prj.clone(),
                access_request: AccessRequestId::new("acc_1").unwrap(),
                from: AccessStatus::InProgress,
                to: AccessStatus::Granted,
            },
            by_project.clone(),
        );
        round_trip(
            DocumentUploaded {
                company: c.clone(),
                document: DocumentId::new("doc_1").unwrap(),
            },
            by_company,
        );
        round_trip(
            AgentRunFinished {
                company: c.clone(),
                project: prj.clone(),
                agent_run: AgentRunId::new("run_1").unwrap(),
                outcome: RunOutcome::Failed,
            },
            by_project.clone(),
        );
        round_trip(
            EvalRunFinished {
                company: c,
                project: prj,
                eval_run: EvalRunId::new("evr_1").unwrap(),
                passed: 9,
                failed: 1,
            },
            by_project,
        );
    }

    #[test]
    fn catalog_names_follow_the_convention() {
        let mut seen = std::collections::HashSet::new();
        assert_eq!(CATALOG.len(), samples().len(), "every event has a sample");
        for detail in CATALOG {
            let parts: Vec<_> = detail.split('.').collect();
            assert_eq!(parts.len(), 4, "{detail} is not fde.<entity>.<verb>.v1");
            assert_eq!((parts[0], parts[3]), ("fde", "v1"), "{detail}");
            let ok = detail
                .bytes()
                // Kebab-case, the platform's own catalog rule (`vendor/oryxa-platform/crates/oryxa-events`).
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
            assert!(ok, "{detail}");
            assert!(seen.insert(*detail), "duplicate {detail}");
        }
    }

    /// Every leaf of every payload is a number or an id-charset string: no spaces, no `@`, no text.
    #[test]
    fn payloads_hold_only_ids_enums_and_counts() {
        fn check(detail: &str, path: &str, v: &Value) {
            match v {
                Value::Object(m) => m.iter().for_each(|(k, v)| check(detail, &format!("{path}.{k}"), v)),
                Value::Number(_) => {}
                Value::String(s) => assert!(
                    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
                    "{detail}{path} = {s:?} is not an id or enum"
                ),
                other => panic!("{detail}{path} = {other} is not an id, enum or count"),
            }
        }
        for (detail, data) in samples() {
            check(detail, "", &data);
        }
    }

    /// The same source and detail type as [`CompanyCreated`] with a free-form company field, as a
    /// buggy or hostile producer would send it.
    #[derive(Serialize)]
    struct Loose {
        company: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    }

    impl Event for Loose {
        const SOURCE: &'static str = SOURCE;
        const DETAIL_TYPE: &'static str = CompanyCreated::DETAIL_TYPE;
    }

    #[test]
    fn an_email_or_free_text_never_comes_back_as_a_payload() {
        let (signer, verifier) = keys();
        let decode_company = |e: &Encoded| decode::<CompanyCreated>(&verifier, &e.source, &e.detail_type, &e.detail);

        // Signed and well formed, but the id is an email or a sentence: refused.
        for bad in ["bob@acme.com", "Acme Corp renewal at risk"] {
            let e = signed(
                &signer,
                &Loose {
                    company: bad.into(),
                    note: None,
                },
            );
            assert!(
                matches!(decode_company(&e), Err(DecodeError::Payload(_))),
                "{bad:?} must not decode"
            );
        }

        // Extra fields are tolerated for forward compatibility, but the typed payload has nowhere
        // to keep them, so they never reach a handler or a re-published event.
        let e = signed(
            &signer,
            &Loose {
                company: "cmp_1".into(),
                note: Some("call bob@acme.com about the outage".into()),
            },
        );
        let got = decode_company(&e).unwrap();
        let out = serde_json::to_string(&got.data).unwrap();
        assert_eq!(out, r#"{"company":"cmp_1"}"#);
    }

    #[test]
    fn statuses_serialise_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&AccessStatus::InProgress).unwrap(),
            r#""in_progress""#
        );
        assert_eq!(serde_json::to_string(&RunOutcome::Cancelled).unwrap(), r#""cancelled""#);
        assert!(serde_json::from_str::<AccessStatus>(r#""approved""#).is_err());
    }
}
