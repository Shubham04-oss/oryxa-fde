//! One error type for every handler. Bodies carry a short code only; causes go to the log.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use oryxa_fde_store::StoreError;
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
    #[error("already exists")]
    Conflict,
    /// The change breaks a rule of the record, e.g. a stage skipped or an empty scope signed off.
    #[error("rejected: {0}")]
    Rejected(&'static str),
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
}

impl ApiError {
    fn status(&self) -> (StatusCode, &'static str) {
        match self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            ApiError::NoOrganisation => (StatusCode::FORBIDDEN, "no_organisation"),
            ApiError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            ApiError::Csrf => (StatusCode::FORBIDDEN, "csrf"),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            ApiError::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid"),
            ApiError::Conflict => (StatusCode::CONFLICT, "conflict"),
            ApiError::Rejected(_) => (StatusCode::CONFLICT, "rejected"),
            ApiError::Unavailable => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            ApiError::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.status();
        let error = match self {
            ApiError::Invalid(what) | ApiError::Rejected(what) => format!("{code}_{what}"),
            _ => code.to_owned(),
        };
        (status, Json(ErrorBody { error })).into_response()
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
        assert!(matches!(
            ApiError::from(StoreError::Corrupt("name")),
            ApiError::Internal
        ));
    }
}
