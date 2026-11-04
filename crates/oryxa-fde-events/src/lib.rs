//! FDE event payloads on the platform's bus contract (`oryxa_events`). Every type binds to source
//! `oryxa.fde` and a detail type `fde.<entity>.<verb>.v1`. Payloads hold validated ids, enums and
//! counts only, so no name, email or customer text can reach the bus through them.
//!
//! Project events stay in order per project and company events per company: `entity_key` returns
//! the project or company id, which makes the bus group match `ProjectScope::event_group` and
//! `CompanyScope::event_group`.

pub mod inbox;

use oryxa_core::TenantId;
use oryxa_events::Event;
use oryxa_fde_core::{
    AccessRequestId, AgentRunId, CompanyId, CompanyScope, DocumentId, EvalRunId, ProjectId, ProjectScope, Stage,
};
use serde::{Deserialize, Serialize};

pub const SOURCE: &str = "oryxa.fde";

// AccessStatus and RunOutcome live here, not in core: they are part of the bus contract, and every
// producer and consumer of these events already depends on this crate.

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

/// How an agent run ended. From the agent's run states (`oryxa-fde-agent`): `finished` is
/// `Succeeded`, `failed` for a rejected approval is `Rejected`, any other `failed` is `Failed`, and a
/// run an FDE or a budget stops is `Cancelled`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Succeeded,
    Failed,
    Rejected,
    Cancelled,
}

// Payloads are built from a scope, never from loose ids, so the company and project in an event
// always belong together; their scope fields are private and read back through `scope`.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompanyCreated {
    company: CompanyId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectCreated {
    company: CompanyId,
    project: ProjectId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectStageChanged {
    company: CompanyId,
    project: ProjectId,
    pub from: Stage,
    pub to: Stage,
}

/// The customer signed off a version of the project's scope and success criteria.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeSignedOff {
    company: CompanyId,
    project: ProjectId,
    pub version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessRequestStatusChanged {
    company: CompanyId,
    project: ProjectId,
    pub access_request: AccessRequestId,
    pub from: AccessStatus,
    pub to: AccessStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentUploaded {
    company: CompanyId,
    pub document: DocumentId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRunFinished {
    company: CompanyId,
    project: ProjectId,
    pub agent_run: AgentRunId,
    pub outcome: RunOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvalRunFinished {
    company: CompanyId,
    project: ProjectId,
    pub eval_run: EvalRunId,
    pub passed: u32,
    pub failed: u32,
}

/// `company()` and `scope(tenant)` for a payload about one company.
macro_rules! company_scoped {
    ($($ty:ident),*) => {$(
        impl $ty {
            pub fn company(&self) -> &CompanyId {
                &self.company
            }
            /// The payload's company in `tenant`, the tenant its envelope was verified for.
            pub fn scope(&self, tenant: &TenantId) -> CompanyScope {
                CompanyScope::new(tenant.clone(), self.company.clone())
            }
        }
    )*};
}

/// `company()`, `project()` and `scope(tenant)` for a payload about one project.
macro_rules! project_scoped {
    ($($ty:ident),*) => {$(
        impl $ty {
            pub fn company(&self) -> &CompanyId {
                &self.company
            }
            pub fn project(&self) -> &ProjectId {
                &self.project
            }
            /// The payload's project in `tenant`, the tenant its envelope was verified for.
            pub fn scope(&self, tenant: &TenantId) -> ProjectScope {
                CompanyScope::new(tenant.clone(), self.company.clone()).project(self.project.clone())
            }
        }
    )*};
}

company_scoped!(CompanyCreated, DocumentUploaded);
project_scoped!(
    ProjectCreated,
    ProjectStageChanged,
    ScopeSignedOff,
    AccessRequestStatusChanged,
    AgentRunFinished,
    EvalRunFinished
);

impl CompanyCreated {
    pub fn new(s: &CompanyScope) -> Self {
        Self {
            company: s.company.clone(),
        }
    }
}

impl DocumentUploaded {
    pub fn new(s: &CompanyScope, document: DocumentId) -> Self {
        Self {
            company: s.company.clone(),
            document,
        }
    }
}

impl ProjectCreated {
    pub fn new(s: &ProjectScope) -> Self {
        Self {
            company: s.company.company.clone(),
            project: s.project.clone(),
        }
    }
}

impl ProjectStageChanged {
    pub fn new(s: &ProjectScope, from: Stage, to: Stage) -> Self {
        Self {
            company: s.company.company.clone(),
            project: s.project.clone(),
            from,
            to,
        }
    }
}

impl ScopeSignedOff {
    pub fn new(s: &ProjectScope, version: u32) -> Self {
        Self {
            company: s.company.company.clone(),
            project: s.project.clone(),
            version,
        }
    }
}

impl AccessRequestStatusChanged {
    pub fn new(s: &ProjectScope, access_request: AccessRequestId, from: AccessStatus, to: AccessStatus) -> Self {
        Self {
            company: s.company.company.clone(),
            project: s.project.clone(),
            access_request,
            from,
            to,
        }
    }
}

impl AgentRunFinished {
    pub fn new(s: &ProjectScope, agent_run: AgentRunId, outcome: RunOutcome) -> Self {
        Self {
            company: s.company.company.clone(),
            project: s.project.clone(),
            agent_run,
            outcome,
        }
    }
}

impl EvalRunFinished {
    pub fn new(s: &ProjectScope, eval_run: EvalRunId, passed: u32, failed: u32) -> Self {
        Self {
            company: s.company.company.clone(),
            project: s.project.clone(),
            eval_run,
            passed,
            failed,
        }
    }
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
            sample(CompanyCreated::new(&p.company)),
            sample(ProjectCreated::new(&p)),
            sample(ProjectStageChanged::new(&p, Stage::Discover, Stage::Scope)),
            sample(ScopeSignedOff::new(&p, 3)),
            sample(AccessRequestStatusChanged::new(
                &p,
                AccessRequestId::new("acc_1").unwrap(),
                AccessStatus::Requested,
                AccessStatus::InProgress,
            )),
            sample(DocumentUploaded::new(&p.company, DocumentId::new("doc_1").unwrap())),
            sample(AgentRunFinished::new(
                &p,
                AgentRunId::new("run_1").unwrap(),
                RunOutcome::Succeeded,
            )),
            sample(EvalRunFinished::new(&p, EvalRunId::new("evr_1").unwrap(), 41, 2)),
        ]
    }

    #[test]
    fn every_event_round_trips_and_groups_by_its_entity() {
        let p = project();
        let by_company = p.company.event_group();
        let by_project = p.event_group();
        round_trip(CompanyCreated::new(&p.company), by_company.clone());
        round_trip(ProjectCreated::new(&p), by_project.clone());
        round_trip(
            ProjectStageChanged::new(&p, Stage::Build, Stage::Evaluate),
            by_project.clone(),
        );
        round_trip(ScopeSignedOff::new(&p, 2), by_project.clone());
        round_trip(
            AccessRequestStatusChanged::new(
                &p,
                AccessRequestId::new("acc_1").unwrap(),
                AccessStatus::InProgress,
                AccessStatus::Granted,
            ),
            by_project.clone(),
        );
        round_trip(
            DocumentUploaded::new(&p.company, DocumentId::new("doc_1").unwrap()),
            by_company,
        );
        round_trip(
            AgentRunFinished::new(&p, AgentRunId::new("run_1").unwrap(), RunOutcome::Failed),
            by_project.clone(),
        );
        round_trip(
            EvalRunFinished::new(&p, EvalRunId::new("evr_1").unwrap(), 9, 1),
            by_project,
        );
    }

    #[test]
    fn a_payload_rebuilds_the_scope_it_was_built_from() {
        let p = project();
        let tenant = p.tenant().clone();
        assert_eq!(ProjectCreated::new(&p).scope(&tenant), p);
        assert_eq!(ScopeSignedOff::new(&p, 1).scope(&tenant), p);
        assert_eq!(CompanyCreated::new(&p.company).scope(&tenant), p.company);
        let e = EvalRunFinished::new(&p, EvalRunId::new("evr_1").unwrap(), 1, 0);
        assert_eq!((e.company(), e.project()), (&p.company.company, &p.project));
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
        assert_eq!(serde_json::to_string(&RunOutcome::Rejected).unwrap(), r#""rejected""#);
        assert!(serde_json::from_str::<AccessStatus>(r#""approved""#).is_err());
    }
}
