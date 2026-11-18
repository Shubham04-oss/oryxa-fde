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
    /// The request breaks a rule; the code says which.
    #[error("rejected: {0}")]
    Rejected(&'static str),
    /// The request can't be carried out until something is done elsewhere first; the code says what.
    #[error("needs {0}")]
    NeedsAction(&'static str),
    /// A sign-in refused: wrong password or no such account, which answer alike.
    #[error("sign-in refused")]
    InvalidCredentials,
    /// A sign-in code that is wrong, spent or expired.
    #[error("code refused")]
    InvalidCode,
    /// A sign-in limit is reached; try again after this long. Answers alike for every address.
    #[error("too many attempts")]
    TooManyAttempts(std::time::Duration),
    /// WorkOS wants a step our screens do not handle yet (MFA, SSO, a Radar challenge): the sign-in
    /// ends with no session.
    #[error("sign-in method unsupported")]
    SignInUnsupported,
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
            ApiError::Rejected(_) => (StatusCode::CONFLICT, "rejected"),
            ApiError::NeedsAction(what) => (StatusCode::BAD_REQUEST, *what),
            ApiError::InvalidCredentials => (StatusCode::UNAUTHORIZED, "invalid_credentials"),
            ApiError::InvalidCode => (StatusCode::UNAUTHORIZED, "invalid_code"),
            ApiError::TooManyAttempts(_) => (StatusCode::TOO_MANY_REQUESTS, "too_many_attempts"),
            ApiError::SignInUnsupported => (StatusCode::FORBIDDEN, "sign_in_unsupported"),
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
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, _) = self.status();
        let body = ErrorBody { error: self.code() };
        let mut resp = (status, Json(body)).into_response();
        if let ApiError::TooManyAttempts(wait) = self {
            let secs = wait.as_secs().max(1);
            resp.headers_mut()
                .insert(axum::http::header::RETRY_AFTER, axum::http::HeaderValue::from(secs));
        }
        resp
    }
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        match e {
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
        let r = ApiError::Invalid("email").into_response();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        assert_eq!(ApiError::Invalid("email").code(), "invalid_email");
        assert_eq!(ApiError::Rejected("x").status().0, StatusCode::CONFLICT);
        assert!(matches!(
            ApiError::from(StoreError::Rejected("sign_in_limit")),
            ApiError::Rejected("sign_in_limit")
        ));
        // What to do first is the code itself.
        let needs = ApiError::NeedsAction("verify_email");
        assert_eq!(
            (needs.status().0, needs.code().as_str()),
            (StatusCode::BAD_REQUEST, "verify_email")
        );
        assert!(matches!(
            ApiError::from(StoreError::Corrupt("bucket")),
            ApiError::Internal
        ));
    }

    #[tokio::test]
    async fn a_body_is_a_bare_code_and_a_wait_says_how_long() {
        let r = ApiError::Forbidden.into_response();
        let bytes = http_body_util::BodyExt::collect(r.into_body())
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(bytes.as_ref(), br#"{"error":"forbidden"}"#);
        let r = ApiError::TooManyAttempts(std::time::Duration::from_millis(10)).into_response();
        assert_eq!(r.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(r.headers()[axum::http::header::RETRY_AFTER], "1");
    }
}
