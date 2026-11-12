//! Browser sign-in and the session cookie (the platform's web contract). `/auth/login` sends the
//! browser to WorkOS AuthKit with a state and a PKCE challenge, kept in a short-lived sealed
//! cookie; `/auth/callback` checks the state, exchanges the code with the PKCE verifier and sets
//! `__Host-fde_session`, sealed (AES-256-GCM) with the WorkOS access and refresh tokens. No token
//! reaches JavaScript.
//!
//! A request that carries the session cookie and no bearer token is authenticated from it: the
//! access token is verified like a bearer token (refreshed through WorkOS when it has expired),
//! and the request then goes through the same `Principal` and permission checks. Only WorkOS
//! refusing the session for good (the refresh token is spent, or the user must sign in again
//! another way) ends it; WorkOS being slow, rate limiting or failing answers 503 and keeps the
//! cookie, and that session's refresh is not tried again for a few seconds (or `Retry-After`).
//!
//! Idle sessions: the API relies on AuthKit's session inactivity timeout (WorkOS dashboard,
//! Authentication, Sessions), which revokes a refresh token not used for that long, so the next
//! refresh of an idle session gets `invalid_grant`. Every session also ends [`SESSION_TTL`] after
//! sign-in whatever its activity.
//!
//! Key rotation: cookies are sealed with `SESSION_PASSWORD`; a cookie sealed with
//! `SESSION_PASSWORD_PREVIOUS` is still read, and reissued under the current key. Rotate in two
//! deploys, so no replica ever meets a cookie it cannot read: first set the new key as
//! `SESSION_PASSWORD_PREVIOUS`, then swap the two; drop the old key after [`SESSION_TTL`]. When
//! rotating out a leaked key, do not keep it as the previous key: everyone signs in again.
//!
//! A cookie request that changes anything must also prove it comes from the web app
//! (`X-Oryxa-Request: 1` and the app's `Origin`), or it is refused as cross-site. `/auth/logout`
//! never refreshes or reseals: it revokes the WorkOS session if it can, and always clears the
//! cookie.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Query, Request, State};
use axum::http::header::{AUTHORIZATION, COOKIE, LOCATION, ORIGIN, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use oryxa_authn::JwtError;
use oryxa_core::UserId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::{IntoParams, ToSchema};

use crate::people::{People, Person, display_name};
use crate::{ApiError, App, BoxFuture, ErrorBody, Principal};

pub const SESSION_COOKIE: &str = "__Host-fde_session";
const SIGN_IN_COOKIE: &str = "__Host-fde_signin";
/// How long a sign-in may take between `/auth/login` and `/auth/callback`.
const SIGN_IN_TTL: Duration = Duration::from_secs(10 * 60);
/// A session ends this long after sign-in, however often its access token is refreshed.
pub const SESSION_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
const CSRF_HEADER: &str = "x-oryxa-request";
const NAME_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_RETURN_TO: usize = 2048;

/// Tokens from a code exchange or a refresh.
#[derive(Clone)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
}

/// Why a refresh did not give new tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefreshError {
    /// WorkOS refused this session for good (the refresh token is revoked, expired or idle too
    /// long, or the user must sign in another way): the session is over.
    Refused(String),
    /// WorkOS could not answer now (timeout, 5xx, rate limited after retries): try again later,
    /// after `retry_after` if WorkOS said.
    Unavailable { why: String, retry_after: Option<Duration> },
}

/// How many times a rate-limited refresh is tried, and the wait before the second try (doubling,
/// jittered).
const REFRESH_TRIES: u32 = 3;
const REFRESH_BACKOFF: Duration = Duration::from_millis(250);
/// The longest `Retry-After` a request waits out itself; a longer one ends it with a 503.
const MAX_WAIT_IN_REQUEST: Duration = Duration::from_secs(2);
/// After WorkOS could not refresh a session, it is not asked again for this long (jittered), or
/// for its `Retry-After` up to [`MAX_SESSION_BACKOFF`].
const SESSION_BACKOFF: Duration = Duration::from_secs(5);
const MAX_SESSION_BACKOFF: Duration = Duration::from_secs(60);
const LOGOUT_PATH: &str = "/auth/logout";

/// `base` scaled by a random factor in [0.5, 1.5), so sessions that failed together retry apart.
fn jittered(base: Duration) -> Duration {
    base.mul_f64(rand::Rng::gen_range(&mut rand::thread_rng(), 0.5..1.5))
}

/// Who is attempting a sign-in, as WorkOS is told on each attempt: the address the Worker forwards
/// from Cloudflare and the browser's user agent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Client {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

/// What one sign-in attempt came to, in our terms rather than WorkOS's.
#[derive(Clone)]
pub enum Attempt {
    SignedIn(Tokens),
    /// The address must be verified first: WorkOS has emailed a code, and `pending` continues.
    /// `verification` names that code, for sending it again.
    VerifyEmail {
        pending: String,
        verification: Option<String>,
    },
    /// The person belongs to several organisations: they choose one, and `pending` continues.
    ChooseOrganisation {
        pending: String,
        organisations: Vec<(String, String)>,
    },
    /// Wrong or unknown credentials, a wrong or spent code, or a pending step WorkOS no longer has.
    Refused,
    /// A step our screens do not handle yet (MFA, SSO required, a Radar challenge): the code, for the log.
    Unsupported(String),
    /// WorkOS could not answer (timeout, 5xx, rate limited, our own credentials refused): why, for the log.
    Unavailable(String),
}

/// What asking for a code to be emailed came to. Only an outage is told apart: whether a mail went
/// out says whether the address has an account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sent {
    Sent,
    /// WorkOS sent nothing (no such account, its own per-address limit): why, for the log.
    NotSent(String),
    /// WorkOS could not answer: why, for the log.
    Unavailable(String),
}

/// An invitation, as its token names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invitation {
    /// The address it was sent to: the only address that may accept it.
    pub email: String,
    pub organisation: Option<String>,
    /// Still open: not accepted, expired or revoked.
    pub pending: bool,
}

/// What creating an account for an invited address came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Created {
    Created,
    /// The address already has an account.
    Exists,
    /// The password does not meet WorkOS's policy.
    WeakPassword,
    /// Refused for another reason: why, for the log.
    Refused(String),
    Unavailable(String),
}

/// What setting a new password with a reset token came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reset {
    Done,
    WeakPassword,
    /// The token is wrong, spent or expired: why, for the log.
    Refused(String),
    Unavailable(String),
}

/// WorkOS as sign-in needs it. A trait so tests run without WorkOS.
pub trait AuthKit: Send + Sync + 'static {
    /// Where to send the browser to sign in.
    fn authorization_url(&self, state: &str, code_challenge: &str, redirect_uri: &str) -> Result<String, String>;
    fn exchange_code<'a>(&'a self, code: &'a str, code_verifier: &'a str) -> BoxFuture<'a, Result<Tokens, String>>;
    fn refresh<'a>(
        &'a self,
        refresh_token: &'a str,
        organisation: &'a str,
    ) -> BoxFuture<'a, Result<Tokens, RefreshError>>;
    /// Ends the WorkOS session, so its refresh token stops working.
    fn revoke<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Result<(), String>>;
    fn user_name<'a>(&'a self, user: &'a str) -> BoxFuture<'a, Result<String, String>>;
    fn organisation_name<'a>(&'a self, organisation: &'a str) -> BoxFuture<'a, Result<String, String>>;
    /// Everyone with an active membership of the organisation, whatever their role.
    fn people<'a>(&'a self, organisation: &'a str) -> BoxFuture<'a, Result<Vec<Person>, String>>;
    /// Signs in with an address and password, which go to WorkOS and nowhere else.
    fn sign_in_with_password<'a>(
        &'a self,
        email: &'a str,
        password: &'a str,
        client: &'a Client,
    ) -> BoxFuture<'a, Attempt>;
    /// Continues a pending sign-in with the code WorkOS emailed to verify the address.
    fn verify_email<'a>(&'a self, pending: &'a str, code: &'a str, client: &'a Client) -> BoxFuture<'a, Attempt>;
    /// Continues a pending sign-in into the organisation the person chose.
    fn choose_organisation<'a>(
        &'a self,
        pending: &'a str,
        organisation: &'a str,
        client: &'a Client,
    ) -> BoxFuture<'a, Attempt>;
    /// Emails a one-time sign-in code to the address. The code itself never comes back here.
    fn send_code<'a>(&'a self, email: &'a str, client: &'a Client) -> BoxFuture<'a, Sent>;
    /// Signs in with an address and the one-time code emailed to it.
    fn sign_in_with_code<'a>(&'a self, email: &'a str, code: &'a str, client: &'a Client) -> BoxFuture<'a, Attempt>;
    /// Emails the code of a pending email verification again.
    fn resend_verification<'a>(&'a self, verification: &'a str) -> BoxFuture<'a, Sent>;
    /// The invitation a token names; `None` when there is no such invitation.
    fn invitation<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<Option<Invitation>, String>>;
    /// Whether the address has an account.
    fn has_account<'a>(&'a self, email: &'a str) -> BoxFuture<'a, Result<bool, String>>;
    /// Creates an account for an invited address with this password and name.
    fn create_account<'a>(
        &'a self,
        email: &'a str,
        password: &'a str,
        name: (Option<&'a str>, Option<&'a str>),
        client: &'a Client,
    ) -> BoxFuture<'a, Created>;
    /// Signs in with an address and password, accepting the invitation the token names.
    fn accept_with_password<'a>(
        &'a self,
        email: &'a str,
        password: &'a str,
        invitation: &'a str,
        client: &'a Client,
    ) -> BoxFuture<'a, Attempt>;
    /// Emails a password reset link to the address. The link's token never comes back here.
    fn send_password_reset<'a>(&'a self, email: &'a str) -> BoxFuture<'a, Sent>;
    /// Sets a new password with the token from a reset link.
    fn reset_password<'a>(&'a self, token: &'a str, password: &'a str) -> BoxFuture<'a, Reset>;
}

/// A WorkOS error's status and its code, cut to a code's own charset, for the log.
fn status_and_code(e: &workos::Error) -> (u16, String) {
    let Some(a) = e.api() else {
        return (0, "network".into());
    };
    let code = a
        .code
        .as_deref()
        .unwrap_or("none")
        .chars()
        .filter(|c| c.is_ascii_lowercase() || *c == '_')
        .take(64)
        .collect();
    (a.status, code)
}

/// Whether a refusal is about the password's strength.
fn weak_password(status: u16, code: &str) -> bool {
    matches!(status, 400 | 422) && code.contains("password")
}

fn outage(status: u16, code: &str) -> bool {
    status == 0
        || status >= 500
        || status == 429
        || (status == 401 && matches!(code, "invalid_client" | "unauthorized_client"))
}

/// The invitation and reset methods of an [`AuthKit`] fake that never reaches them.
#[cfg(test)]
macro_rules! unused_invitation_and_reset {
    () => {
        fn invitation<'a>(
            &'a self,
            _: &'a str,
        ) -> $crate::BoxFuture<'a, Result<Option<$crate::session::Invitation>, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn has_account<'a>(&'a self, _: &'a str) -> $crate::BoxFuture<'a, Result<bool, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn create_account<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: (Option<&'a str>, Option<&'a str>),
            _: &'a $crate::session::Client,
        ) -> $crate::BoxFuture<'a, $crate::session::Created> {
            Box::pin(async { $crate::session::Created::Unavailable("unused".into()) })
        }
        fn accept_with_password<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: &'a str,
            _: &'a $crate::session::Client,
        ) -> $crate::BoxFuture<'a, $crate::session::Attempt> {
            Box::pin(async { $crate::session::Attempt::Unavailable("unused".into()) })
        }
        fn send_password_reset<'a>(&'a self, _: &'a str) -> $crate::BoxFuture<'a, $crate::session::Sent> {
            Box::pin(async { $crate::session::Sent::Unavailable("unused".into()) })
        }
        fn reset_password<'a>(&'a self, _: &'a str, _: &'a str) -> $crate::BoxFuture<'a, $crate::session::Reset> {
            Box::pin(async { $crate::session::Reset::Unavailable("unused".into()) })
        }
    };
}
#[cfg(test)]
pub(crate) use unused_invitation_and_reset;

/// An id WorkOS gave us, checked before it goes back into a WorkOS path.
fn workos_id(v: &str) -> Option<String> {
    let ok = (1..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    ok.then(|| v.to_owned())
}

/// A failed send as [`Sent`]: an outage, or nothing sent for a reason the person must not learn.
fn sent_from(e: &workos::Error) -> Sent {
    let Some(a) = e.api() else {
        return Sent::Unavailable("network or decode".into());
    };
    let code: String = a
        .code
        .as_deref()
        .unwrap_or("none")
        .chars()
        .filter(|c| c.is_ascii_lowercase() || *c == '_')
        .take(64)
        .collect();
    match (a.status, code.as_str()) {
        (401, "invalid_client" | "unauthorized_client") | (500.., _) => {
            Sent::Unavailable(format!("status {}, code {code}", a.status))
        }
        (status, _) => Sent::NotSent(format!("status {status}, code {code}")),
    }
}

/// WorkOS answers that need a screen we do not have yet; each ends the sign-in with no session.
const UNSUPPORTED_STEPS: [&str; 6] = [
    "mfa_enrollment",
    "mfa_challenge",
    "sso_required",
    "organization_authentication_methods_required",
    "radar_email_challenge",
    "radar_sms_challenge",
];

/// Longest organisation name passed on to the screen.
const MAX_ORGANISATION_NAME: usize = 200;

/// What a refused WorkOS authenticate call means for the sign-in, from its status and body. Every
/// refusal that is not a known step is one `Refused`, so a wrong password and an unknown address
/// look the same whatever WorkOS calls them. Nothing of the body but the step's own fields is kept.
fn attempt_of(status: u16, body: &[u8]) -> Attempt {
    let v: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
    let code = v.get("code").or_else(|| v.get("error")).and_then(|c| c.as_str());
    let pending = v
        .get("pending_authentication_token")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty() && t.len() <= 4096)
        .map(str::to_owned);
    match (code, pending) {
        (Some("email_verification_required"), Some(pending)) => {
            let verification = v
                .get("email_verification_id")
                .and_then(|i| i.as_str())
                .and_then(workos_id);
            return Attempt::VerifyEmail { pending, verification };
        }
        (Some("organization_selection_required"), Some(pending)) => {
            let organisations: Vec<(String, String)> = v
                .get("organizations")
                .and_then(|o| o.as_array())
                .into_iter()
                .flatten()
                .filter_map(|o| {
                    let id = oryxa_core::TenantId::new(o.get("id")?.as_str()?).ok()?;
                    let name: String = o.get("name")?.as_str()?.chars().take(MAX_ORGANISATION_NAME).collect();
                    Some((id.to_string(), name))
                })
                .collect();
            if organisations.is_empty() {
                return Attempt::Unsupported("organization_selection_required without organisations".into());
            }
            return Attempt::ChooseOrganisation { pending, organisations };
        }
        (Some(c), _) if UNSUPPORTED_STEPS.contains(&c) => return Attempt::Unsupported(c.to_owned()),
        _ => {}
    }
    match (status, code) {
        // Our own credentials or a fault of ours: not the person's doing, and never a session.
        (401, Some("invalid_client" | "unauthorized_client")) | (429, _) | (500.., _) | (0, _) => {
            // WorkOS's code is logged, so only a code's own charset of it.
            let code: String = code
                .unwrap_or("none")
                .chars()
                .filter(|c| c.is_ascii_lowercase() || *c == '_')
                .take(64)
                .collect();
            Attempt::Unavailable(format!("status {status}, code {code}"))
        }
        _ => Attempt::Refused,
    }
}

/// An authenticate call's answer as an [`Attempt`]. Its error text is never kept: WorkOS's
/// message can carry the address.
fn attempt_from(r: Result<workos::models::AuthenticateResponse, workos::Error>) -> Attempt {
    match r {
        Ok(r) => Attempt::SignedIn(Tokens {
            access_token: r.access_token.expose().to_owned(),
            refresh_token: r.refresh_token.expose().to_owned(),
        }),
        Err(e) => match e.api() {
            Some(a) => attempt_of(a.status, &a.raw_body),
            None => Attempt::Unavailable(
                match e {
                    workos::Error::Network(_) => "network",
                    workos::Error::Decode(_) => "decode",
                    _ => "sdk",
                }
                .into(),
            ),
        },
    }
}

/// WorkOS's largest page of memberships.
const PEOPLE_PAGE: i64 = 100;
/// ponytail: an organisation of more than 10,000 people fails the lookup (no names, a 503 for the list)
/// rather than paging on; raise it, or search WorkOS by name, if one ever gets that big.
const MAX_PEOPLE_PAGES: usize = 100;

/// AuthKit through the pinned WorkOS SDK.
pub struct WorkOsAuthKit(pub workos::Client);

impl AuthKit for WorkOsAuthKit {
    fn authorization_url(&self, state: &str, code_challenge: &str, redirect_uri: &str) -> Result<String, String> {
        let mut p = workos::user_management::GetAuthorizationUrlParams::new(redirect_uri);
        p.provider = Some(workos::enums::UserManagementAuthenticationProvider::Authkit);
        p.state = Some(state.to_owned());
        p.code_challenge = Some(code_challenge.to_owned());
        p.code_challenge_method = Some("S256".into());
        self.0
            .user_management()
            .get_authorization_url(p)
            .map_err(|e| e.to_string())
    }

    fn exchange_code<'a>(&'a self, code: &'a str, code_verifier: &'a str) -> BoxFuture<'a, Result<Tokens, String>> {
        Box::pin(async move {
            let mut p = workos::user_management::AuthenticateWithCodeParams::new(code);
            p.code_verifier = Some(code_verifier.into());
            let r = self
                .0
                .user_management()
                .authenticate_with_code(p)
                .await
                .map_err(|e| e.to_string())?;
            Ok(Tokens {
                access_token: r.access_token.expose().to_owned(),
                refresh_token: r.refresh_token.expose().to_owned(),
            })
        })
    }

    fn refresh<'a>(
        &'a self,
        refresh_token: &'a str,
        organisation: &'a str,
    ) -> BoxFuture<'a, Result<Tokens, RefreshError>> {
        Box::pin(async move {
            let mut backoff = REFRESH_BACKOFF;
            for attempt in 1..=REFRESH_TRIES {
                let mut p = workos::user_management::AuthenticateWithRefreshTokenParams::new(refresh_token);
                p.organization_id = Some(organisation.to_owned());
                let e = match self.0.user_management().authenticate_with_refresh_token(p).await {
                    Ok(r) => {
                        return Ok(Tokens {
                            access_token: r.access_token.expose().to_owned(),
                            refresh_token: r.refresh_token.expose().to_owned(),
                        });
                    }
                    Err(e) => e,
                };
                let (status, code) = e.api().map(|a| (a.status, a.code.as_deref())).unwrap_or((0, None));
                let unavailable = || RefreshError::Unavailable {
                    why: e.to_string(),
                    retry_after: e.retry_after(),
                };
                match refresh_failure(status, code) {
                    Failure::Final => return Err(RefreshError::Refused(e.to_string())),
                    Failure::RateLimited if attempt < REFRESH_TRIES => {
                        let wait = match e.retry_after() {
                            Some(after) if after > MAX_WAIT_IN_REQUEST => return Err(unavailable()),
                            Some(after) => after,
                            None => jittered(backoff),
                        };
                        tokio::time::sleep(wait).await;
                        backoff *= 2;
                    }
                    _ => return Err(unavailable()),
                }
            }
            Err(RefreshError::Unavailable {
                why: "rate limited".into(),
                retry_after: None,
            })
        })
    }

    fn revoke<'a>(&'a self, session_id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let body = workos::models::RevokeSession {
                session_id: session_id.to_owned(),
            };
            self.0
                .user_management()
                .revoke_session(workos::user_management::RevokeSessionParams::new(body))
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn user_name<'a>(&'a self, user: &'a str) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let u = self
                .0
                .user_management()
                .get_user(user)
                .await
                .map_err(|e| e.to_string())?;
            let name = [u.first_name.as_deref(), u.last_name.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            Ok(if name.trim().is_empty() { u.email } else { name })
        })
    }

    fn organisation_name<'a>(&'a self, organisation: &'a str) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let o = self
                .0
                .organizations()
                .get_organization(organisation)
                .await
                .map_err(|e| e.to_string())?;
            Ok(o.name)
        })
    }

    fn people<'a>(&'a self, organisation: &'a str) -> BoxFuture<'a, Result<Vec<Person>, String>> {
        Box::pin(async move {
            let mut people = Vec::new();
            let mut after = None;
            for _ in 0..MAX_PEOPLE_PAGES {
                let p = workos::organization_membership::ListOrganizationMembershipsParams {
                    organization_id: Some(organisation.to_owned()),
                    statuses: Some(vec![workos::UserManagementOrganizationMembershipStatuses::Active]),
                    limit: Some(PEOPLE_PAGE),
                    after,
                    ..Default::default()
                };
                let page = self
                    .0
                    .organization_membership()
                    .list_organization_memberships(p)
                    .await
                    .map_err(|e| e.to_string())?;
                people.extend(page.data.into_iter().map(|m| Person {
                    name: display_name(m.user.first_name.as_deref(), m.user.last_name.as_deref()),
                    id: m.user_id,
                    role: m.role.slug,
                }));
                match page.list_metadata.after {
                    Some(next) => after = Some(next),
                    None => return Ok(people),
                }
            }
            Err("the organisation has too many people to list".into())
        })
    }

    fn sign_in_with_password<'a>(
        &'a self,
        email: &'a str,
        password: &'a str,
        client: &'a Client,
    ) -> BoxFuture<'a, Attempt> {
        Box::pin(async move {
            let mut p = workos::user_management::AuthenticateWithPasswordParams::new(email, password);
            p.ip_address = client.ip.clone();
            p.user_agent = client.user_agent.clone();
            attempt_from(self.0.user_management().authenticate_with_password(p).await)
        })
    }

    fn verify_email<'a>(&'a self, pending: &'a str, code: &'a str, client: &'a Client) -> BoxFuture<'a, Attempt> {
        Box::pin(async move {
            let mut p = workos::user_management::AuthenticateWithEmailVerificationParams::new(code, pending);
            p.ip_address = client.ip.clone();
            p.user_agent = client.user_agent.clone();
            attempt_from(self.0.user_management().authenticate_with_email_verification(p).await)
        })
    }

    fn choose_organisation<'a>(
        &'a self,
        pending: &'a str,
        organisation: &'a str,
        client: &'a Client,
    ) -> BoxFuture<'a, Attempt> {
        Box::pin(async move {
            let mut p =
                workos::user_management::AuthenticateWithOrganizationSelectionParams::new(pending, organisation);
            p.ip_address = client.ip.clone();
            p.user_agent = client.user_agent.clone();
            attempt_from(
                self.0
                    .user_management()
                    .authenticate_with_organization_selection(p)
                    .await,
            )
        })
    }

    fn send_code<'a>(&'a self, email: &'a str, client: &'a Client) -> BoxFuture<'a, Sent> {
        Box::pin(async move {
            let body = workos::models::CreateMagicCodeAndReturn {
                email: email.to_owned(),
                invitation_token: None,
                ip_address: client.ip.clone(),
                user_agent: client.user_agent.clone(),
                radar_auth_attempt_id: None,
                signals_id: None,
            };
            // The answer holds the code itself: dropped unread.
            match self
                .0
                .user_management()
                .create_magic_auth(workos::user_management::CreateMagicAuthParams::new(body))
                .await
            {
                Ok(_) => Sent::Sent,
                Err(e) => sent_from(&e),
            }
        })
    }

    fn sign_in_with_code<'a>(&'a self, email: &'a str, code: &'a str, client: &'a Client) -> BoxFuture<'a, Attempt> {
        Box::pin(async move {
            let mut p = workos::user_management::AuthenticateWithMagicAuthParams::new(code, email);
            p.ip_address = client.ip.clone();
            p.user_agent = client.user_agent.clone();
            attempt_from(self.0.user_management().authenticate_with_magic_auth(p).await)
        })
    }

    fn resend_verification<'a>(&'a self, verification: &'a str) -> BoxFuture<'a, Sent> {
        Box::pin(async move {
            // The verification names its user; its code is dropped unread.
            let user = match self.0.user_management().get_email_verification(verification).await {
                Ok(v) => v.user_id,
                Err(e) => return sent_from(&e),
            };
            let Some(user) = workos_id(&user) else {
                return Sent::NotSent("user id not valid".into());
            };
            match self.0.user_management().send_verification_email(&user).await {
                Ok(_) => Sent::Sent,
                Err(e) => sent_from(&e),
            }
        })
    }

    fn invitation<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<Option<Invitation>, String>> {
        Box::pin(async move {
            match self.0.user_management().find_invitation_by_token(token).await {
                // The answer also holds the token and its link: only these fields are kept.
                Ok(i) => Ok(Some(Invitation {
                    email: i.email,
                    organisation: i.organization_id,
                    pending: matches!(i.state, workos::enums::UserInviteState::Pending),
                })),
                Err(e) => {
                    let (status, code) = status_and_code(&e);
                    if outage(status, &code) {
                        Err(format!("status {status}, code {code}"))
                    } else {
                        Ok(None)
                    }
                }
            }
        })
    }

    fn has_account<'a>(&'a self, email: &'a str) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            let p = workos::user_management::ListUsersParams {
                email: Some(email.to_owned()),
                limit: Some(1),
                ..Default::default()
            };
            match self.0.user_management().list_users(p).await {
                Ok(list) => Ok(!list.data.is_empty()),
                Err(e) => {
                    let (status, code) = status_and_code(&e);
                    Err(format!("status {status}, code {code}"))
                }
            }
        })
    }

    fn create_account<'a>(
        &'a self,
        email: &'a str,
        password: &'a str,
        name: (Option<&'a str>, Option<&'a str>),
        client: &'a Client,
    ) -> BoxFuture<'a, Created> {
        Box::pin(async move {
            let mut body = workos::user_management::CreateUserParamsBody::new(email);
            body.first_name = name.0.map(str::to_owned);
            body.last_name = name.1.map(str::to_owned);
            body.ip_address = client.ip.clone();
            body.user_agent = client.user_agent.clone();
            body.password = Some(workos::user_management::Password::Plaintext {
                password: password.to_owned(),
            });
            match self
                .0
                .user_management()
                .create_user(workos::user_management::CreateUserParams::new(body))
                .await
            {
                Ok(_) => Created::Created,
                Err(e) => {
                    let (status, code) = status_and_code(&e);
                    if outage(status, &code) {
                        Created::Unavailable(format!("status {status}, code {code}"))
                    } else if weak_password(status, &code) {
                        Created::WeakPassword
                    } else if status == 409 || code.contains("already") || code.contains("not_available") {
                        Created::Exists
                    } else {
                        Created::Refused(format!("status {status}, code {code}"))
                    }
                }
            }
        })
    }

    fn accept_with_password<'a>(
        &'a self,
        email: &'a str,
        password: &'a str,
        invitation: &'a str,
        client: &'a Client,
    ) -> BoxFuture<'a, Attempt> {
        Box::pin(async move {
            let mut p = workos::user_management::AuthenticateWithPasswordParams::new(email, password);
            p.invitation_token = Some(invitation.into());
            p.ip_address = client.ip.clone();
            p.user_agent = client.user_agent.clone();
            attempt_from(self.0.user_management().authenticate_with_password(p).await)
        })
    }

    fn send_password_reset<'a>(&'a self, email: &'a str) -> BoxFuture<'a, Sent> {
        Box::pin(async move {
            let body = workos::models::CreatePasswordResetToken {
                email: email.to_owned(),
            };
            // The answer holds the reset token and its link: dropped unread.
            match self
                .0
                .user_management()
                .reset_password(workos::user_management::ResetPasswordParams::new(body))
                .await
            {
                Ok(_) => Sent::Sent,
                Err(e) => sent_from(&e),
            }
        })
    }

    fn reset_password<'a>(&'a self, token: &'a str, password: &'a str) -> BoxFuture<'a, Reset> {
        Box::pin(async move {
            let body = workos::models::CreatePasswordReset {
                token: token.into(),
                new_password: password.into(),
            };
            match self
                .0
                .user_management()
                .confirm_password_reset(workos::user_management::ConfirmPasswordResetParams::new(body))
                .await
            {
                Ok(_) => Reset::Done,
                Err(e) => {
                    let (status, code) = status_and_code(&e);
                    if outage(status, &code) {
                        Reset::Unavailable(format!("status {status}, code {code}"))
                    } else if weak_password(status, &code) {
                        Reset::WeakPassword
                    } else {
                        Reset::Refused(format!("status {status}, code {code}"))
                    }
                }
            }
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    Final,
    RateLimited,
    Transient,
}

/// WorkOS error codes that end a session: its refresh token is spent, its user or organisation is
/// gone, or the user must sign in again another way (SSO, MFA, a verified email).
const SESSION_ENDED: [&str; 9] = [
    "invalid_grant",
    "sso_required",
    "organization_authentication_methods_required",
    "mfa_enrollment",
    "mfa_challenge",
    "email_verification_required",
    "organization_selection_required",
    "user_not_found",
    "organization_not_found",
];

/// Whether a failed refresh ends the session. WorkOS refuses a user it will not sign in to the
/// organisation (such as one no longer a member) with a 403, and our own bad credentials with a
/// 401, which, like a 5xx or a timeout, is not the session's fault. A 429 is worth retrying.
fn refresh_failure(status: u16, code: Option<&str>) -> Failure {
    match (status, code) {
        (_, Some(c)) if SESSION_ENDED.contains(&c) => Failure::Final,
        (403, _) => Failure::Final,
        (429, _) => Failure::RateLimited,
        _ => Failure::Transient,
    }
}

/// Sign-in configuration: the web app's origin (`WEB_ORIGIN`), the cookie sealing password
/// (`SESSION_PASSWORD`, 64 hex characters; `SESSION_PASSWORD_PREVIOUS` while rotating) and
/// AuthKit.
pub struct SignIn {
    web_origin: String,
    password: String,
    previous: Option<String>,
    authkit: Arc<dyn AuthKit>,
    names: Mutex<HashMap<String, (String, Instant)>>,
    /// The organisations' people, cached.
    people: People,
    /// Sessions whose refresh WorkOS could not answer, by hash of refresh token: not asked again
    /// before then.
    waits: Mutex<HashMap<String, Instant>>,
    /// Keys the sign-in limits' hashes of addresses and clients, derived from `SESSION_PASSWORD`.
    limit_key: [u8; 32],
}

/// The issuer AuthKit access tokens carry, which the verifier pins exactly: `configured`
/// (`WORKOS_ISSUER`, for a custom auth domain) when set, else WorkOS's own issuer for this client.
pub fn workos_issuer(client_id: &str, configured: Option<&str>) -> Result<String, String> {
    // The client id goes into the issuer URL, so it keeps to an id's safe charset.
    let valid = !client_id.is_empty()
        && client_id.len() <= 64
        && client_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !valid {
        return Err("WORKOS_CLIENT_ID must be 1..=64 characters of [A-Za-z0-9_-]".into());
    }
    match configured.map(str::trim).filter(|i| !i.is_empty()) {
        Some(issuer) => Ok(issuer.to_owned()),
        None => Ok(format!("https://api.workos.com/user_management/{client_id}")),
    }
}

/// HMAC-SHA256 of `message` under `key`.
fn keyed(key: &[u8], message: &[u8]) -> [u8; 32] {
    use hmac::Mac;
    // HMAC takes a key of any length, so this never fails; if it did, every value would share one
    // bucket, which limits more, never less.
    let Ok(mut mac) = hmac::Hmac::<Sha256>::new_from_slice(key) else {
        return [0; 32];
    };
    mac.update(message);
    mac.finalize().into_bytes().into()
}

fn check_password(password: &str) -> Result<(), String> {
    if password.len() != 64 || !password.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("SESSION_PASSWORD must be 64 hex characters".into());
    }
    Ok(())
}

impl SignIn {
    pub fn new(
        web_origin: impl Into<String>,
        password: impl Into<String>,
        authkit: Arc<dyn AuthKit>,
    ) -> Result<Self, String> {
        let web_origin = web_origin.into().trim_end_matches('/').to_owned();
        let password = password.into();
        let origin = url::Url::parse(&web_origin).map_err(|_| "WEB_ORIGIN is not a URL".to_owned())?;
        if origin.scheme() != "https" && origin.host_str() != Some("localhost") {
            return Err("WEB_ORIGIN must be https".into());
        }
        if origin.origin().ascii_serialization() != web_origin {
            return Err("WEB_ORIGIN must be an origin, with no path".into());
        }
        check_password(&password)?;
        let limit_key = keyed(password.as_bytes(), b"oryxa-fde sign-in limits v1");
        Ok(Self {
            web_origin,
            password,
            previous: None,
            authkit,
            names: Mutex::new(HashMap::new()),
            people: People::default(),
            waits: Mutex::new(HashMap::new()),
            limit_key,
        })
    }

    /// Also reads cookies sealed with `previous`, the key being rotated out.
    pub fn with_previous_password(mut self, previous: impl Into<String>) -> Result<Self, String> {
        let previous = previous.into();
        check_password(&previous)?;
        self.previous = Some(previous);
        Ok(self)
    }

    /// A keyed hash for a sign-in limit's bucket: `what` names the kind of value, so an address and
    /// a client never share one.
    pub(crate) fn limit_hash(&self, what: &str, value: &str) -> [u8; 32] {
        keyed(&self.limit_key, format!("{what}\0{value}").as_bytes())
    }

    pub(crate) fn authkit(&self) -> &dyn AuthKit {
        self.authkit.as_ref()
    }

    fn redirect_uri(&self) -> String {
        format!("{}/auth/callback", self.web_origin)
    }

    /// A cookie request that changes something must come from the web app itself.
    pub(crate) fn same_site(&self, headers: &HeaderMap) -> bool {
        headers.get(CSRF_HEADER).is_some_and(|v| v == "1")
            && headers
                .get(ORIGIN)
                .is_some_and(|v| v.as_bytes() == self.web_origin.as_bytes())
    }

    pub(crate) fn seal<T: Serialize>(&self, data: &T) -> Result<String, ApiError> {
        workos::helpers::session::seal(data, &self.password).map_err(|_| ApiError::Internal)
    }

    /// The sealed value, and whether it was sealed with the previous key.
    pub(crate) fn unseal<T: for<'de> Deserialize<'de>>(&self, sealed: &str) -> Option<(T, bool)> {
        if let Ok(v) = workos::helpers::session::unseal(sealed, &self.password) {
            return Some((v, false));
        }
        let previous = self.previous.as_deref()?;
        workos::helpers::session::unseal(sealed, previous)
            .ok()
            .map(|v| (v, true))
    }

    /// Whether the session behind `key` is backing off from a failed refresh.
    fn backing_off(&self, key: &str) -> bool {
        let waits = self.waits.lock().unwrap_or_else(|e| e.into_inner());
        waits.get(key).is_some_and(|until| Instant::now() < *until)
    }

    /// Backs the session behind `key` off for `retry_after` (bounded), or a jittered few seconds.
    fn back_off(&self, key: String, retry_after: Option<Duration>) {
        let wait = retry_after
            .unwrap_or_else(|| jittered(SESSION_BACKOFF))
            .min(MAX_SESSION_BACKOFF);
        let now = Instant::now();
        let mut waits = self.waits.lock().unwrap_or_else(|e| e.into_inner());
        waits.retain(|_, until| *until > now);
        waits.insert(key, now + wait);
    }

    fn refreshed(&self, key: &str) {
        self.waits.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    }

    /// Everyone in `organisation`, by user id, cached for a few minutes.
    pub(crate) async fn people(&self, organisation: &str) -> Result<Arc<HashMap<String, Person>>, ApiError> {
        self.people.of(self.authkit.as_ref(), organisation).await
    }

    /// A display name, cached for a few minutes.
    async fn name(&self, key: String, look_up: BoxFuture<'_, Result<String, String>>) -> Result<String, ApiError> {
        if let Some((name, at)) = self.names.lock().unwrap_or_else(|e| e.into_inner()).get(&key)
            && at.elapsed() < NAME_TTL
        {
            return Ok(name.clone());
        }
        let name = look_up.await.map_err(|e| {
            tracing::error!(error = %e, "workos lookup failed");
            ApiError::Unavailable
        })?;
        let mut names = self.names.lock().unwrap_or_else(|e| e.into_inner());
        names.retain(|_, (_, at)| at.elapsed() < NAME_TTL);
        names.insert(key, (name.clone(), Instant::now()));
        Ok(name)
    }
}

/// The sign-in in progress, sealed in its own cookie between login and callback.
#[derive(Serialize, Deserialize)]
struct SignInState {
    purpose: String,
    state: String,
    verifier: String,
    return_to: String,
    expires: u64,
}

/// What the session cookie holds.
#[derive(Serialize, Deserialize)]
pub(crate) struct Session {
    purpose: String,
    access_token: String,
    refresh_token: String,
    /// The user and organisation signed in; a refresh must keep both.
    user: String,
    organisation: String,
    /// The WorkOS session, for logout to revoke without reading the tokens. Cookies sealed before
    /// it was kept have none, and logout only clears them.
    #[serde(default)]
    session_id: String,
    /// When the user signed in, in Unix seconds.
    signed_in: u64,
}

const SIGN_IN_PURPOSE: &str = "fde_sign_in";
const SESSION_PURPOSE: &str = "fde_session";

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn cookie_value<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(name)?.strip_prefix('='))
}

pub(crate) fn set_cookie(name: &str, value: &str, max_age: Duration) -> HeaderValue {
    let v = format!(
        "{name}={value}; Path=/; Max-Age={}; Secure; HttpOnly; SameSite=Lax",
        max_age.as_secs()
    );
    // Sealed values are base64, which is always a valid header value.
    HeaderValue::from_str(&v).unwrap_or_else(|_| HeaderValue::from_static("invalid=; Max-Age=0"))
}

pub(crate) fn clear_cookie(name: &str) -> HeaderValue {
    set_cookie(name, "", Duration::ZERO)
}

/// A same-origin path to return to after sign-in: `/` then anything but a second `/` or `\`, no
/// control characters or whitespace, and nothing that resolves to another origin.
pub(crate) fn safe_return_to(raw: &str) -> Option<String> {
    let ok = raw.starts_with('/')
        && !raw.starts_with("//")
        && raw.len() <= MAX_RETURN_TO
        && !raw.contains('\\')
        && !raw.chars().any(|c| c.is_control() || c.is_whitespace());
    if !ok {
        return None;
    }
    let base = url::Url::parse("https://fde.invalid/").ok()?;
    let resolved = base.join(raw).ok()?;
    (resolved.origin() == base.origin()).then(|| raw.to_owned())
}

/// Authenticates a request from its session cookie when it carries no bearer token. See the
/// module docs; a cookie that cannot be used is cleared.
pub(crate) async fn layer(State(app): State<Arc<App>>, mut req: Request, next: Next) -> Response {
    // Sign-in routes check the origin themselves and never use the session they replace, so a
    // stale cookie cannot refuse a sign-in.
    if crate::signin::is_sign_in_path(req.uri().path()) {
        return next.run(req).await;
    }
    if req.headers().contains_key(AUTHORIZATION) {
        return next.run(req).await;
    }
    let Some(sealed) = cookie_value(req.headers(), SESSION_COOKIE).map(str::to_owned) else {
        return next.run(req).await;
    };
    let Some(sign_in) = app.sign_in.as_ref() else {
        return ApiError::Unauthorized.into_response();
    };
    // Checked before the token: a cross-site request never reaches a refresh.
    if !matches!(*req.method(), Method::GET | Method::HEAD) && !sign_in.same_site(req.headers()) {
        return ApiError::Csrf.into_response();
    }
    // Logout reads the cookie itself: it must never refresh, reseal or keep the session.
    if req.uri().path() == LOGOUT_PATH {
        return next.run(req).await;
    }
    match resume(&app, sign_in, &sealed).await {
        Ok((token, reissued)) => {
            let Ok(bearer) = HeaderValue::from_str(&format!("Bearer {token}")) else {
                return ApiError::Unauthorized.into_response();
            };
            req.headers_mut().insert(AUTHORIZATION, bearer);
            let mut resp = next.run(req).await;
            if let Some(cookie) = reissued {
                resp.headers_mut().append(SET_COOKIE, cookie);
            }
            resp
        }
        Err(e) => {
            // A dependency outage is not the cookie's fault; anything else makes it useless.
            let clear = !matches!(e, ApiError::Unavailable);
            let mut resp = e.into_response();
            if clear {
                resp.headers_mut().append(SET_COOKIE, clear_cookie(SESSION_COOKIE));
            }
            resp
        }
    }
}

/// The access token of a session, refreshed if it has expired, and the cookie to set if it changed.
async fn resume(app: &App, sign_in: &SignIn, sealed: &str) -> Result<(String, Option<HeaderValue>), ApiError> {
    let (s, old_key): (Session, bool) = sign_in.unseal(sealed).ok_or(ApiError::Unauthorized)?;
    if s.purpose != SESSION_PURPOSE || now().saturating_sub(s.signed_in) >= SESSION_TTL.as_secs() {
        return Err(ApiError::Unauthorized);
    }
    let left = |s: &Session| SESSION_TTL.saturating_sub(Duration::from_secs(now().saturating_sub(s.signed_in)));
    match app.tokens.claims(&s.access_token).await {
        Ok(c) if c.sub == s.user && c.org_id.as_deref() == Some(s.organisation.as_str()) => {
            // Sealed with the key being rotated out: reissue under the new one.
            let reissued = if old_key {
                Some(set_cookie(SESSION_COOKIE, &sign_in.seal(&s)?, left(&s)))
            } else {
                None
            };
            Ok((s.access_token, reissued))
        }
        Ok(_) => Err(ApiError::Unauthorized),
        Err(JwtError::Rejected(jsonwebtoken_kind)) if is_expiry(&jsonwebtoken_kind) => {
            // Keyed by a hash: refresh tokens are kept out of anything long-lived.
            let key: String = Sha256::digest(s.refresh_token.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            if sign_in.backing_off(&key) {
                return Err(ApiError::Unavailable);
            }
            let t = match sign_in.authkit.refresh(&s.refresh_token, &s.organisation).await {
                Ok(t) => t,
                Err(RefreshError::Refused(why)) => {
                    tracing::info!(error = %why, "session refresh refused");
                    return Err(ApiError::Unauthorized);
                }
                Err(RefreshError::Unavailable { why, retry_after }) => {
                    tracing::warn!(error = %why, "session refresh failed for now");
                    sign_in.back_off(key, retry_after);
                    return Err(ApiError::Unavailable);
                }
            };
            sign_in.refreshed(&key);
            let c = app.tokens.claims(&t.access_token).await.map_err(refused_token)?;
            if c.sub != s.user || c.org_id.as_deref() != Some(s.organisation.as_str()) {
                return Err(ApiError::Unauthorized);
            }
            let renewed = Session {
                access_token: t.access_token.clone(),
                refresh_token: t.refresh_token,
                ..s
            };
            let cookie = set_cookie(SESSION_COOKIE, &sign_in.seal(&renewed)?, left(&renewed));
            Ok((t.access_token, Some(cookie)))
        }
        Err(e) => Err(refused_token(e)),
    }
}

/// Maps a token the verifier refused to the answer, and logs why: the error kind, never the token.
pub(crate) fn refused_token(e: JwtError) -> ApiError {
    if let JwtError::Keys(e) = e {
        tracing::error!(error = %e, "could not load WorkOS signing keys");
        return ApiError::Unavailable;
    }
    tracing::warn!(kind = token_error_kind(&e), "access token refused");
    ApiError::Unauthorized
}

/// The kind of a refusal, without the data some kinds carry (claim values, key material).
fn token_error_kind(e: &JwtError) -> String {
    match e {
        JwtError::Malformed => "malformed".into(),
        JwtError::WrongAlgorithm => "wrong_algorithm".into(),
        JwtError::UnknownKey => "unknown_key".into(),
        // jsonwebtoken's ErrorKind is not re-exported by oryxa-authn; its Debug name is stable.
        JwtError::Rejected(kind) => format!("{kind:?}").split('(').next().unwrap_or_default().to_owned(),
        JwtError::Keys(_) => "keys".into(),
    }
}

/// The organisation a sign-in is for; a person in none is refused, and logged by user id only.
pub(crate) fn organisation_of(user: &str, org_id: Option<String>) -> Result<String, ApiError> {
    org_id.ok_or_else(|| {
        match UserId::new(user) {
            Ok(user) => tracing::info!(%user, "sign-in refused: the user is in no organisation"),
            Err(_) => tracing::info!("sign-in refused: the user is in no organisation (user id not valid)"),
        }
        ApiError::NoOrganisation
    })
}

/// Where the web app tells a person refused for having no organisation what to do next.
pub const NO_ORGANISATION_PAGE: &str = "/sign-in?error=no_organisation";

/// The browser's answer to a failed callback, which also ends that sign-in: the browser starts
/// again from /auth/login. A person in no organisation reached it by navigating, so they go to a
/// page that explains it rather than a bare error.
fn refused_sign_in(e: ApiError) -> Response {
    let mut resp = match e {
        ApiError::NoOrganisation => (
            StatusCode::FOUND,
            [(LOCATION, HeaderValue::from_static(NO_ORGANISATION_PAGE))],
        )
            .into_response(),
        e => e.into_response(),
    };
    resp.headers_mut().append(SET_COOKIE, clear_cookie(SIGN_IN_COOKIE));
    resp
}

fn is_expiry(kind: &impl std::fmt::Debug) -> bool {
    // jsonwebtoken's ErrorKind is not re-exported by oryxa-authn; its Debug name is stable.
    format!("{kind:?}") == "ExpiredSignature"
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct LoginParams {
    /// Where to go after sign-in: a path on the web app, e.g. `/companies`. Defaults to `/`.
    pub return_to: Option<String>,
}

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct CallbackParams {
    pub code: String,
    pub state: String,
}

/// Start sign-in: redirects to WorkOS AuthKit.
#[utoipa::path(get, operation_id = "sign_in", path = "/auth/login", tag = "auth", params(LoginParams),
    security(()),
    responses((status = 302, description = "To WorkOS AuthKit"), (status = 400, body = ErrorBody),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn login(State(app): State<Arc<App>>, Query(p): Query<LoginParams>) -> Result<Response, ApiError> {
    let sign_in = app.sign_in.as_ref().ok_or(ApiError::Unavailable)?;
    let return_to = safe_return_to(p.return_to.as_deref().unwrap_or("/")).ok_or(ApiError::Invalid("return_to"))?;
    let pkce = workos::helpers::pkce::generate_pkce_pair().map_err(|_| ApiError::Internal)?;
    let state = workos::helpers::pkce::generate_code_verifier(None).map_err(|_| ApiError::Internal)?;
    let url = sign_in
        .authkit
        .authorization_url(&state, &pkce.code_challenge, &sign_in.redirect_uri())
        .map_err(|e| {
            tracing::error!(error = %e, "authorization url");
            ApiError::Unavailable
        })?;
    let pending = SignInState {
        purpose: SIGN_IN_PURPOSE.into(),
        state,
        verifier: pkce.code_verifier,
        return_to,
        expires: now() + SIGN_IN_TTL.as_secs(),
    };
    let cookie = set_cookie(SIGN_IN_COOKIE, &sign_in.seal(&pending)?, SIGN_IN_TTL);
    let location = HeaderValue::from_str(&url).map_err(|_| ApiError::Internal)?;
    Ok((StatusCode::FOUND, [(LOCATION, location), (SET_COOKIE, cookie)]).into_response())
}

/// Finish sign-in: sets the session cookie and redirects to where sign-in started.
#[utoipa::path(get, operation_id = "sign_in_callback", path = "/auth/callback", tag = "auth", params(CallbackParams),
    security(()),
    responses((status = 302, description = "Signed in, to the page sign-in started from; or refused because the \
        person is in no WorkOS organisation, to `/sign-in?error=no_organisation` with no session"),
        (status = 400, body = ErrorBody), (status = 401, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn callback(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Query(p): Query<CallbackParams>,
) -> Response {
    finish_sign_in(&app, &headers, &p).await.unwrap_or_else(refused_sign_in)
}

async fn finish_sign_in(app: &App, headers: &HeaderMap, p: &CallbackParams) -> Result<Response, ApiError> {
    let sign_in = app.sign_in.as_ref().ok_or(ApiError::Unavailable)?;
    let pending: SignInState = cookie_value(headers, SIGN_IN_COOKIE)
        .and_then(|c| sign_in.unseal(c))
        .map(|(s, _)| s)
        .filter(|s: &SignInState| s.purpose == SIGN_IN_PURPOSE && s.expires > now())
        .ok_or(ApiError::Invalid("sign_in"))?;
    // Checked again: whatever made the cookie, the redirect only ever goes to our own pages.
    let return_to = safe_return_to(&pending.return_to).ok_or(ApiError::Invalid("return_to"))?;
    // Constant time: the state is the only thing tying this callback to its login.
    let same = pending.state.len() == p.state.len()
        && pending
            .state
            .bytes()
            .zip(p.state.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0;
    if !same {
        return Err(ApiError::Invalid("state"));
    }
    let tokens = sign_in
        .authkit
        .exchange_code(&p.code, &pending.verifier)
        .await
        .map_err(|e| {
            tracing::info!(error = %e, "code exchange refused");
            ApiError::Unauthorized
        })?;
    let cookie = session_cookie(app.tokens.as_ref(), sign_in, tokens).await?;
    let location = HeaderValue::from_str(&return_to).map_err(|_| ApiError::Internal)?;
    let mut resp = (StatusCode::FOUND, [(LOCATION, location)]).into_response();
    let h = resp.headers_mut();
    h.append(SET_COOKIE, cookie);
    h.append(SET_COOKIE, clear_cookie(SIGN_IN_COOKIE));
    Ok(resp)
}

/// A new session cookie for the tokens a sign-in just got, whatever method it used: the tokens are
/// verified, and a person in no organisation is refused. Nothing the browser brought becomes part
/// of it.
pub(crate) async fn session_cookie(
    verifier: &dyn crate::VerifyToken,
    sign_in: &SignIn,
    tokens: Tokens,
) -> Result<HeaderValue, ApiError> {
    let claims = verifier.claims(&tokens.access_token).await.map_err(refused_token)?;
    let organisation = organisation_of(&claims.sub, claims.org_id)?;
    let session = Session {
        purpose: SESSION_PURPOSE.into(),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user: claims.sub,
        organisation,
        session_id: claims.sid,
        signed_in: now(),
    };
    Ok(set_cookie(SESSION_COOKIE, &sign_in.seal(&session)?, SESSION_TTL))
}

/// Sign out: clears the session cookie, always, and ends the WorkOS session if WorkOS answers.
/// It never refreshes or reissues the cookie, whatever state the session is in.
#[utoipa::path(post, operation_id = "sign_out", path = "/auth/logout", tag = "auth",
    security(("session" = [])),
    responses((status = 204, description = "Signed out; the cookie is cleared"), (status = 403, body = ErrorBody)))]
pub(crate) async fn logout(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    let session = app.sign_in.as_ref().and_then(|sign_in| {
        let (s, _): (Session, bool) = sign_in.unseal(cookie_value(&headers, SESSION_COOKIE)?)?;
        (s.purpose == SESSION_PURPOSE && !s.session_id.is_empty()).then_some((sign_in, s.session_id))
    });
    if let Some((sign_in, id)) = session
        && let Err(e) = sign_in.authkit.revoke(&id).await
    {
        // Best effort: the browser is signed out either way, and the session lapses at WorkOS.
        tracing::error!(error = %e, "workos session revoke failed");
    }
    (StatusCode::NO_CONTENT, [(SET_COOKIE, clear_cookie(SESSION_COOKIE))]).into_response()
}

#[derive(Debug, Serialize, ToSchema)]
pub struct NamedOut {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OrgRole {
    Admin,
    Member,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct MeOut {
    pub user: NamedOut,
    pub organisation: NamedOut,
    /// The caller's WorkOS role in the organisation.
    pub role: OrgRole,
}

/// Who is signed in.
#[utoipa::path(get, operation_id = "get_me", path = "/v1/me", tag = "auth",
    responses((status = 200, body = MeOut), (status = 401, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn me(State(app): State<Arc<App>>, who: Principal) -> Result<Json<MeOut>, ApiError> {
    let sign_in = app.sign_in.as_ref().ok_or(ApiError::Unavailable)?;
    let (u, o) = (who.user.to_string(), who.tenant.to_string());
    let user = sign_in.name(format!("user:{u}"), sign_in.authkit.user_name(&u)).await?;
    let organisation = sign_in
        .name(format!("org:{o}"), sign_in.authkit.organisation_name(&o))
        .await?;
    Ok(Json(MeOut {
        user: NamedOut {
            id: u.clone(),
            name: user,
        },
        organisation: NamedOut {
            id: o.clone(),
            name: organisation,
        },
        role: if who.admin { OrgRole::Admin } else { OrgRole::Member },
    }))
}

/// The user and organisation a sealed session cookie holds, for tests elsewhere in the crate.
#[cfg(test)]
pub(crate) fn session_of(sign_in: &SignIn, sealed: &str) -> Option<(String, String)> {
    let (s, _): (Session, bool) = sign_in.unseal(sealed)?;
    (s.purpose == SESSION_PURPOSE).then_some((s.user, s.organisation))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AuthKit for tests that never reach WorkOS.
    struct NoAuthKit;
    impl AuthKit for NoAuthKit {
        fn authorization_url(&self, _: &str, _: &str, _: &str) -> Result<String, String> {
            Err("unused".into())
        }
        fn exchange_code<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<Tokens, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn refresh<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<Tokens, RefreshError>> {
            Box::pin(async { Err(RefreshError::Refused("unused".into())) })
        }
        fn revoke<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn user_name<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<String, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn organisation_name<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<String, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn people<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Result<Vec<Person>, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn sign_in_with_password<'a>(&'a self, _: &'a str, _: &'a str, _: &'a Client) -> BoxFuture<'a, Attempt> {
            Box::pin(async { Attempt::Unavailable("unused".into()) })
        }
        fn verify_email<'a>(&'a self, _: &'a str, _: &'a str, _: &'a Client) -> BoxFuture<'a, Attempt> {
            Box::pin(async { Attempt::Unavailable("unused".into()) })
        }
        fn choose_organisation<'a>(&'a self, _: &'a str, _: &'a str, _: &'a Client) -> BoxFuture<'a, Attempt> {
            Box::pin(async { Attempt::Unavailable("unused".into()) })
        }
        fn send_code<'a>(&'a self, _: &'a str, _: &'a Client) -> BoxFuture<'a, Sent> {
            Box::pin(async { Sent::Unavailable("unused".into()) })
        }
        fn sign_in_with_code<'a>(&'a self, _: &'a str, _: &'a str, _: &'a Client) -> BoxFuture<'a, Attempt> {
            Box::pin(async { Attempt::Unavailable("unused".into()) })
        }
        fn resend_verification<'a>(&'a self, _: &'a str) -> BoxFuture<'a, Sent> {
            Box::pin(async { Sent::Unavailable("unused".into()) })
        }
        crate::session::unused_invitation_and_reset!();
    }

    fn kind(a: &Attempt) -> &'static str {
        match a {
            Attempt::SignedIn(_) => "signed_in",
            Attempt::VerifyEmail { .. } => "verify_email",
            Attempt::ChooseOrganisation { .. } => "choose_organisation",
            Attempt::Refused => "refused",
            Attempt::Unsupported(_) => "unsupported",
            Attempt::Unavailable(_) => "unavailable",
        }
    }

    #[test]
    fn every_refusal_that_is_not_a_step_is_one_answer() {
        // Whatever WorkOS calls a wrong password or an unknown address, it is the same `Refused`.
        for (status, body) in [
            (
                401,
                r#"{"code":"invalid_credentials","message":"Invalid credentials for someone@example.com"}"#,
            ),
            (400, r#"{"code":"user_not_found","message":"no such user"}"#),
            (404, r#"{"error":"user_not_found"}"#),
            (400, r#"{"code":"invalid_one_time_code"}"#),
            (400, "not json"),
            (422, r#"{"code":"email_verification_required"}"#), // no pending token: not a step
            (403, ""),
        ] {
            assert_eq!(kind(&attempt_of(status, body.as_bytes())), "refused", "{status} {body}");
        }
        for (status, body) in [
            (429, r#"{"code":"rate_limit_exceeded"}"#),
            (500, ""),
            (503, r#"{"message":"down"}"#),
            (401, r#"{"error":"invalid_client"}"#),
        ] {
            assert_eq!(
                kind(&attempt_of(status, body.as_bytes())),
                "unavailable",
                "{status} {body}"
            );
        }
    }

    #[test]
    fn pending_steps_keep_only_their_token_and_the_organisations_offered() {
        let body = r#"{"code":"email_verification_required","message":"verify","pending_authentication_token":"pt_1",
            "email":"someone@example.com","email_verification_id":"email_verification_1"}"#;
        let Attempt::VerifyEmail { pending, verification } = attempt_of(403, body.as_bytes()) else {
            panic!("a verification step")
        };
        assert_eq!(pending, "pt_1");
        assert_eq!(verification.as_deref(), Some("email_verification_1"));
        let odd = r#"{"code":"email_verification_required","pending_authentication_token":"pt","email_verification_id":"../users/x"}"#;
        let Attempt::VerifyEmail { verification, .. } = attempt_of(403, odd.as_bytes()) else {
            panic!("a verification step")
        };
        assert_eq!(verification, None, "an id that could leave its WorkOS path is dropped");

        let body = r#"{"code":"organization_selection_required","pending_authentication_token":"pt_2",
            "organizations":[{"id":"org_01A","name":"Acme"},{"id":"bad id; drop","name":"x"},{"id":"org_01B","name":"Beta"}],
            "user":{"id":"user_1","email":"someone@example.com"}}"#;
        let Attempt::ChooseOrganisation { pending, organisations } = attempt_of(403, body.as_bytes()) else {
            panic!("an organisation step")
        };
        assert_eq!(pending, "pt_2");
        assert_eq!(
            organisations,
            [
                ("org_01A".to_owned(), "Acme".to_owned()),
                ("org_01B".to_owned(), "Beta".to_owned())
            ],
            "only valid ids are offered"
        );
        let none =
            r#"{"code":"organization_selection_required","pending_authentication_token":"pt","organizations":[]}"#;
        assert_eq!(kind(&attempt_of(403, none.as_bytes())), "unsupported");

        for code in UNSUPPORTED_STEPS {
            let body = format!(r#"{{"code":"{code}","pending_authentication_token":"pt"}}"#);
            assert_eq!(kind(&attempt_of(403, body.as_bytes())), "unsupported", "{code}");
            let body = format!(r#"{{"error":"{code}","error_description":"x"}}"#);
            assert_eq!(kind(&attempt_of(403, body.as_bytes())), "unsupported", "{code}");
        }
    }

    #[test]
    fn return_to_must_be_a_same_origin_path() {
        for ok in ["/", "/companies", "/companies/cmp_1?tab=scope#top", "/a%20b"] {
            assert_eq!(safe_return_to(ok).as_deref(), Some(ok), "{ok}");
        }
        for bad in [
            "",
            "companies",
            "//evil.example",
            "/\\evil.example",
            "/\t/evil.example",
            "/\n/x",
            "https://evil.example/",
            "/ /x",
            "/\u{7f}",
            &format!("/{}", "a".repeat(MAX_RETURN_TO)),
        ] {
            assert_eq!(safe_return_to(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn only_what_this_session_cannot_fix_ends_it() {
        for (status, code) in [
            (400, Some("invalid_grant")),
            (401, Some("invalid_grant")),
            (403, Some("sso_required")),
            (403, Some("mfa_enrollment")),
            (403, Some("organization_authentication_methods_required")),
            (404, Some("user_not_found")),
            (404, Some("organization_not_found")),
            // A user WorkOS will not sign in to the organisation, whatever the code.
            (403, None),
            (403, Some("some_new_refusal")),
        ] {
            assert_eq!(refresh_failure(status, code), Failure::Final, "{status} {code:?}");
        }
        assert_eq!(refresh_failure(429, None), Failure::RateLimited);
        // Outages, and faults of our own such as bad credentials, never sign anyone out.
        for (status, code) in [
            (500, None),
            (502, None),
            (503, None),
            (0, None),
            (401, Some("invalid_client")),
            (400, Some("invalid_request")),
            (404, None),
        ] {
            assert_eq!(refresh_failure(status, code), Failure::Transient, "{status} {code:?}");
        }
    }

    #[test]
    fn retries_are_jittered_around_their_base() {
        let base = Duration::from_millis(1000);
        let waits: Vec<Duration> = (0..200).map(|_| jittered(base)).collect();
        assert!(waits.iter().all(|w| *w >= base / 2 && *w < base * 3 / 2));
        assert!(waits.iter().any(|w| *w != waits[0]), "not all the same");
    }

    #[test]
    fn a_session_that_could_not_refresh_waits_before_asking_again() {
        let sign_in = SignIn::new("https://fde.test", "a".repeat(64), Arc::new(NoAuthKit)).unwrap();
        assert!(!sign_in.backing_off("s1"));
        sign_in.back_off("s1".into(), None);
        assert!(sign_in.backing_off("s1"));
        assert!(!sign_in.backing_off("s2"), "only that session");
        // Retry-After is honoured, but never for more than the cap.
        sign_in.back_off("s2".into(), Some(Duration::from_secs(3600)));
        let until = sign_in.waits.lock().unwrap()["s2"];
        assert!(until <= Instant::now() + MAX_SESSION_BACKOFF);
        sign_in.back_off("s3".into(), Some(Duration::ZERO));
        assert!(!sign_in.backing_off("s3"));
        sign_in.refreshed("s1");
        assert!(!sign_in.backing_off("s1"));
    }

    #[test]
    fn cookies_are_found_by_exact_name() {
        let mut h = HeaderMap::new();
        h.append(
            COOKIE,
            HeaderValue::from_static("a=1; __Host-fde_session=abc; x__Host-fde_signin=no"),
        );
        h.append(COOKIE, HeaderValue::from_static("__Host-fde_signin=def"));
        assert_eq!(cookie_value(&h, SESSION_COOKIE), Some("abc"));
        assert_eq!(cookie_value(&h, SIGN_IN_COOKIE), Some("def"));
        assert_eq!(cookie_value(&h, "missing"), None);
    }

    #[test]
    fn session_cookies_are_host_only_secure_and_http_only() {
        let c = set_cookie(SESSION_COOKIE, "v", SESSION_TTL);
        assert_eq!(
            c.to_str().unwrap(),
            "__Host-fde_session=v; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Lax"
        );
        assert!(clear_cookie(SESSION_COOKIE).to_str().unwrap().contains("Max-Age=0"));
    }

    /// What `f` logs, as plain text.
    fn logged(f: impl FnOnce()) -> String {
        #[derive(Clone, Default)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf::default();
        let out = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .with_writer(move || out.clone())
            .finish();
        tracing::subscriber::with_default(sub, f);
        String::from_utf8(buf.0.lock().unwrap().clone()).unwrap()
    }

    #[test]
    fn the_issuer_defaults_to_the_clients_workos_issuer() {
        assert_eq!(
            workos_issuer("client_01ABC", None).unwrap(),
            "https://api.workos.com/user_management/client_01ABC"
        );
        // Unset in all but name: Terraform may pass an empty variable.
        assert_eq!(
            workos_issuer("client_01ABC", Some(" ")).unwrap(),
            "https://api.workos.com/user_management/client_01ABC"
        );
        assert_eq!(
            workos_issuer("client_01ABC", Some("https://auth.example.com")).unwrap(),
            "https://auth.example.com",
            "WORKOS_ISSUER overrides it, for a custom auth domain"
        );
        for bad in ["", "client/../x", "client 1", "client_1?x=y", &"c".repeat(65)] {
            assert!(workos_issuer(bad, None).is_err(), "{bad:?}");
            assert!(workos_issuer(bad, Some("https://auth.example.com")).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_refused_token_is_logged_by_kind_never_by_content() {
        use jsonwebtoken::errors::ErrorKind;
        let mut answer = None;
        let log = logged(|| answer = Some(refused_token(JwtError::Rejected(ErrorKind::InvalidIssuer))));
        assert!(matches!(answer, Some(ApiError::Unauthorized)));
        assert!(
            log.contains("access token refused") && log.contains("kind=\"InvalidIssuer\""),
            "{log}"
        );

        // A kind that carries data logs its name only.
        let log = logged(|| {
            refused_token(JwtError::Rejected(ErrorKind::MissingRequiredClaim(
                "secret-claim".into(),
            )));
        });
        assert!(
            log.contains("MissingRequiredClaim") && !log.contains("secret-claim"),
            "{log}"
        );
        for (e, kind) in [
            (JwtError::Malformed, "malformed"),
            (JwtError::WrongAlgorithm, "wrong_algorithm"),
            (JwtError::UnknownKey, "unknown_key"),
        ] {
            assert_eq!(token_error_kind(&e), kind);
        }

        // Keys WorkOS could not serve: a dependency failure, still refused.
        assert!(matches!(
            refused_token(JwtError::Keys("down".into())),
            ApiError::Unavailable
        ));
    }

    #[test]
    fn a_sign_in_with_no_organisation_is_refused_and_logged_by_user_id() {
        let mut answer = None;
        let log = logged(|| answer = Some(organisation_of("user_01ABC", None)));
        assert!(matches!(answer, Some(Err(ApiError::NoOrganisation))));
        assert!(log.contains("no organisation") && log.contains("user_01ABC"), "{log}");

        // A user id that is not a valid id stays out of the log.
        let log = logged(|| {
            let _ = organisation_of("someone@example.com", None);
        });
        assert!(log.contains("no organisation") && !log.contains("example.com"), "{log}");

        let log = logged(|| assert_eq!(organisation_of("user_01ABC", Some("org_1".into())).unwrap(), "org_1"));
        assert!(log.is_empty(), "{log}");
    }

    #[test]
    fn a_callback_refused_for_no_organisation_goes_to_a_page_that_says_so() {
        let resp = refused_sign_in(ApiError::NoOrganisation);
        assert_eq!(resp.status(), StatusCode::FOUND);
        assert_eq!(resp.headers()[LOCATION], NO_ORGANISATION_PAGE);
        let cookies: Vec<_> = resp.headers().get_all(SET_COOKIE).iter().collect();
        assert_eq!(
            cookies,
            [clear_cookie(SIGN_IN_COOKIE)],
            "the sign-in ends and no session is set"
        );

        // Other refusals keep their status and code.
        let resp = refused_sign_in(ApiError::Unauthorized);
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(resp.headers().get(LOCATION).is_none());
        assert_eq!(resp.headers()[SET_COOKIE], clear_cookie(SIGN_IN_COOKIE));
    }

    #[test]
    fn sign_in_configuration_is_checked() {
        let k = || -> Arc<dyn AuthKit> { Arc::new(NoAuthKit) };
        let pw = "a".repeat(64);
        assert!(SignIn::new("https://fde.example", pw.clone(), k()).is_ok());
        assert!(
            SignIn::new("https://fde.example/", pw.clone(), k()).is_ok(),
            "a trailing slash is trimmed"
        );
        for origin in ["http://fde.example", "https://fde.example/app", "not a url"] {
            assert!(SignIn::new(origin, pw.clone(), k()).is_err(), "{origin}");
        }
        for bad in ["short", &"z".repeat(64)] {
            assert!(SignIn::new("https://fde.example", bad, k()).is_err());
            let ok = SignIn::new("https://fde.example", pw.clone(), k()).unwrap();
            assert!(
                ok.with_previous_password(bad).is_err(),
                "the previous key is checked too"
            );
        }
    }
}
