//! One error type for every handler. Bodies carry a short code only; causes go to the log.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use oryxa_fde_store::{Saved, StoreError};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("missing or invalid access token")]
    Unauthorized,
    /// The token is valid but names no organisation; FDE data always belongs to one.
    #[error("no organisation selected")]
    NoOrganisation,
    #[error("forbidden")]
    Forbidden,
    /// A cookie request that changes something without proving it comes from the web app.
    #[error("cross-site request refused")]
    Csrf,
    #[error("not found")]
    NotFound,
    #[error("invalid {0}")]
    Invalid(&'static str),
    /// An upload of a kind the context layer cannot read.
    #[error("unsupported media type")]
    UnsupportedType,
    #[error("already exists")]
    Conflict,
    /// The change breaks a rule of the record, e.g. a stage skipped or an empty scope signed off.
    #[error("rejected: {0}")]
    Rejected(&'static str),
    /// The request can't be carried out until something is done elsewhere first; the code says
    /// what, e.g. `bot_not_in_channel` (invite the Slack bot).
    #[error("needs {0}")]
    NeedsAction(&'static str),
    /// The company has no usable KMS key of its own, so its files can be neither stored nor read
    /// (ADR 0003). Nothing was stored; a retry fails the same way until the key is provisioned.
    #[error("company key missing")]
    CompanyKeyMissing,
    /// A dependency (SpiceDB, WorkOS keys) failed; the request is denied, never allowed.
    #[error("unavailable")]
    Unavailable,
    #[error("internal error")]
    Internal,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorBody {
    /// A short machine-readable code, e.g. `forbidden`.
    pub error: String,
    /// What a person can do about it, for the few codes that need one (`company_key_missing`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// A whole-record save refused because the record has moved on from the `version` it was based
/// on; nothing was changed. Read `current`, apply the change to it and save with its `version`.
#[derive(Debug, Serialize, ToSchema)]
pub struct StaleBody<T> {
    /// `stale_version`.
    pub error: String,
    /// The record as it stands.
    pub current: T,
}

/// A 409 from a save that also enforces rules of the record: `stale_version` with the record as
/// it stands, or a refusal with a code only, e.g. `rejected_blocker_required`.
#[derive(Debug, Serialize, ToSchema)]
#[serde(untagged)]
pub enum SaveConflict<T> {
    Stale(StaleBody<T>),
    Refused(ErrorBody),
}

/// The answer to a save the store checked against the version its caller read: `ok` with the
/// record as the save left it, or 409 `stale_version` with the record as it stands.
pub(crate) fn saved<O: Serialize, C: Serialize>(ok: StatusCode, s: Saved<O, C>) -> Response {
    match s {
        Saved::Current(record) => (ok, Json(record)).into_response(),
        Saved::Stale(current) => {
            let body = StaleBody {
                error: STALE.to_owned(),
                current,
            };
            (StatusCode::CONFLICT, Json(body)).into_response()
        }
    }
}

const STALE: &str = "stale_version";

impl ApiError {
    fn status(&self) -> (StatusCode, &'static str) {
        match self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            ApiError::NoOrganisation => (StatusCode::FORBIDDEN, "no_organisation"),
            ApiError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            ApiError::Csrf => (StatusCode::FORBIDDEN, "csrf"),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            ApiError::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid"),
            ApiError::UnsupportedType => (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type"),
            ApiError::Conflict => (StatusCode::CONFLICT, "conflict"),
            ApiError::Rejected(_) => (StatusCode::CONFLICT, "rejected"),
            ApiError::CompanyKeyMissing => (StatusCode::CONFLICT, "company_key_missing"),
            ApiError::NeedsAction(what) => (StatusCode::BAD_REQUEST, *what),
            ApiError::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            ApiError::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl ApiError {
    /// The short code a response body carries, e.g. `forbidden` or `invalid_name`.
    pub fn code(&self) -> String {
        let (_, code) = self.status();
        match self {
            ApiError::Invalid(what) | ApiError::Rejected(what) => format!("{code}_{what}"),
            _ => code.to_owned(),
        }
    }

    /// The sentence a person reads, for the codes that carry one.
    pub fn message(&self) -> Option<&'static str> {
        match self {
            ApiError::CompanyKeyMissing => Some(
                "This company has no encryption key of its own yet, or its key is disabled, so its files cannot be \
                 stored or read. Nothing was saved. Ask your Oryxa administrator to provision the company's key, \
                 then try again.",
            ),
            _ => None,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, _) = self.status();
        let body = ErrorBody {
            error: self.code(),
            message: self.message().map(str::to_owned),
        };
        (status, Json(body)).into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Conflict => ApiError::Conflict,
            // A referenced record (stakeholder, system) that is not in this company.
            StoreError::Missing(what) => ApiError::Invalid(what),
            StoreError::Stage(_) => ApiError::Rejected("stage_transition"),
            StoreError::Rejected(why) => ApiError::Rejected(why),
            // Handlers that can hit this answer with the open items; this is the bare fallback.
            StoreError::ChecklistOpen(_) => ApiError::Rejected("checklist_open"),
            e => {
                tracing::error!(error = %e, "store");
                ApiError::Internal
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_map_to_status_and_a_bare_code() {
        assert_eq!(ApiError::NoOrganisation.status().0, StatusCode::FORBIDDEN);
        assert_eq!(ApiError::Unavailable.status().0, StatusCode::SERVICE_UNAVAILABLE);
        let r = ApiError::Invalid("name").into_response();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        assert!(matches!(ApiError::from(StoreError::Conflict), ApiError::Conflict));
        assert!(matches!(
            ApiError::from(StoreError::Missing("owner")),
            ApiError::Invalid("owner")
        ));
        let skip = oryxa_fde_core::StageError::Same(oryxa_fde_core::Stage::Build);
        assert!(matches!(
            ApiError::from(StoreError::Stage(skip)),
            ApiError::Rejected("stage_transition")
        ));
        assert_eq!(ApiError::Rejected("empty_scope").status().0, StatusCode::CONFLICT);
        let open = StoreError::ChecklistOpen(vec![oryxa_fde_core::Check::DiscoveryNotes]);
        assert_eq!(ApiError::from(open).code(), "rejected_checklist_open");
        // What to do first is the code itself.
        let needs = ApiError::NeedsAction("bot_not_in_channel");
        assert_eq!(
            (needs.status().0, needs.code().as_str()),
            (StatusCode::BAD_REQUEST, "bot_not_in_channel")
        );
        assert!(matches!(
            ApiError::from(StoreError::Corrupt("name")),
            ApiError::Internal
        ));
    }

    #[tokio::test]
    async fn a_missing_company_key_is_a_409_with_a_code_and_a_sentence() {
        let missing = ApiError::CompanyKeyMissing;
        assert_eq!(
            (missing.status().0, missing.code().as_str()),
            (StatusCode::CONFLICT, "company_key_missing")
        );
        let r = missing.into_response();
        assert_eq!(r.status(), StatusCode::CONFLICT);
        let bytes = http_body_util::BodyExt::collect(r.into_body())
            .await
            .unwrap()
            .to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "company_key_missing");
        assert!(
            body["message"]
                .as_str()
                .unwrap()
                .contains("provision the company's key")
        );
        // Other errors stay a bare code.
        let r = ApiError::Forbidden.into_response();
        let bytes = http_body_util::BodyExt::collect(r.into_body())
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(bytes.as_ref(), br#"{"error":"forbidden"}"#);
    }
}
