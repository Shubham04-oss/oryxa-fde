//! Our own sign-in routes (ADR 0007): the web's screens post here and WorkOS stays behind the API.
//! Each route is unauthenticated, so each is guarded the same way:
//!
//! - the web app's origin and `X-Oryxa-Request: 1`, whether or not a cookie is present; a session
//!   cookie the browser brings is never read, refreshed or reused (the session layer skips these
//!   paths), and success always sets a new one;
//! - limits per address, per client and one ceiling across all sign-in calls, counted in Postgres
//!   before WorkOS is asked, so a limit reached answers alike for every address; a counter that
//!   cannot be counted refuses the attempt. The ceiling counts only attempts that passed their own
//!   limits. An address's limit counts every attempt at it, so one client can keep a chosen address
//!   slowed (never locked) for a window;
//! - one answer for a wrong password and an unknown address, every answer padded to
//!   [`ANSWER_FLOOR`] so its timing says no more than its body;
//! - a pending step (verify the email, choose an organisation) travels in the short-lived sealed
//!   [`PENDING_COOKIE`], which names its step and holds WorkOS's pending token, the organisations
//!   offered and the address's keyed hash, never the password or the address.
//!
//! The password goes to WorkOS and nowhere else: it is never logged, stored, put in a cookie or an
//! event, or returned. Bodies are parsed here, never echoed in an error, and logs carry ids only.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::header::{SET_COOKIE, USER_AGENT};
use axum::response::{IntoResponse, Response};
use oryxa_fde_store::{EmailAddress, SignInHit, Store};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use utoipa::ToSchema;

use crate::session::{
    Attempt, Client, Created, ProviderId, Reset, Sent, SignIn, clear_cookie, cookie_value, now, safe_return_to,
    session_cookie, set_cookie,
};
use crate::{ApiError, App, BoxFuture, ErrorBody, VerifyToken};

pub const PASSWORD_PATH: &str = "/auth/sign-in/password";
pub const VERIFY_EMAIL_PATH: &str = "/auth/sign-in/verify-email";
pub const ORGANISATION_PATH: &str = "/auth/sign-in/organisation";
pub const CODE_PATH: &str = "/auth/sign-in/code";
pub const CODE_VERIFY_PATH: &str = "/auth/sign-in/code/verify";
pub const RESEND_PATH: &str = "/auth/sign-in/verify-email/resend";
pub const INVITATION_PATH: &str = "/auth/invitation";
pub const ACCEPT_PATH: &str = "/auth/invitation/accept";
pub const FORGOT_PATH: &str = "/auth/password/forgot";
pub const RESET_PATH: &str = "/auth/password/reset";
const PATHS: [&str; 10] = [
    PASSWORD_PATH,
    VERIFY_EMAIL_PATH,
    ORGANISATION_PATH,
    CODE_PATH,
    CODE_VERIFY_PATH,
    RESEND_PATH,
    INVITATION_PATH,
    ACCEPT_PATH,
    FORGOT_PATH,
    RESET_PATH,
];

/// Whether the session layer leaves `path` to its own checks.
pub(crate) fn is_sign_in_path(path: &str) -> bool {
    PATHS.contains(&path)
}

pub const PENDING_COOKIE: &str = "__Host-fde_pending";
const PENDING_PURPOSE: &str = "fde_pending";
/// How long a pending step may wait; WorkOS's own pending token lasts about as long.
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);

/// No answer to these routes leaves sooner than this after the request arrived, so a refusal takes
/// as long whether or not WorkOS knew the address.
pub const ANSWER_FLOOR: Duration = Duration::from_millis(800);

const MAX_PASSWORD_BYTES: usize = 1024;
const MAX_CODE_CHARS: usize = 16;
const MAX_USER_AGENT_CHARS: usize = 512;

/// One limit: what it counts, over how long, and how many it lets through.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limit {
    pub kind: &'static str,
    pub window: Duration,
    pub limit: u32,
}

const MINUTES_5: Duration = Duration::from_secs(5 * 60);
/// Password attempts for one address; WorkOS's own is 10 a minute per address.
pub(crate) const PASSWORD_ADDRESS: Limit = Limit {
    kind: "password_address",
    window: MINUTES_5,
    limit: 10,
};
pub(crate) const PASSWORD_CLIENT: Limit = Limit {
    kind: "password_client",
    window: MINUTES_5,
    limit: 30,
};
/// Guesses at an emailed code, for one address.
pub(crate) const CODE_ADDRESS: Limit = Limit {
    kind: "code_address",
    window: MINUTES_5,
    limit: 10,
};
pub(crate) const CODE_CLIENT: Limit = Limit {
    kind: "code_client",
    window: MINUTES_5,
    limit: 30,
};
/// Organisation choices from one client.
pub(crate) const STEP_CLIENT: Limit = Limit {
    kind: "step_client",
    window: MINUTES_5,
    limit: 30,
};
const MINUTES_15: Duration = Duration::from_secs(15 * 60);
/// Codes emailed to one address (a sign-in code or a verification code sent again), so nobody can
/// flood an inbox; WorkOS's own is 3 a minute per address.
pub(crate) const SEND_ADDRESS: Limit = Limit {
    kind: "send_address",
    window: MINUTES_15,
    limit: 3,
};
pub(crate) const SEND_CLIENT: Limit = Limit {
    kind: "send_client",
    window: MINUTES_15,
    limit: 10,
};
/// Invitations looked up or accepted from one client.
pub(crate) const INVITE_CLIENT: Limit = Limit {
    kind: "invite_client",
    window: MINUTES_5,
    limit: 30,
};
/// New passwords set with a reset token, from one client.
pub(crate) const RESET_CLIENT: Limit = Limit {
    kind: "reset_client",
    window: MINUTES_15,
    limit: 10,
};
/// Every sign-in call to WorkOS, from everyone, counted once per attempt (an invitation lookup makes
/// up to three WorkOS calls, an accept four and counts twice, a reset with its revocations a few
/// more): a fifth of WorkOS's environment-wide write limit
/// (500 per 10 seconds), so a flood never uses up what session refresh needs.
pub(crate) const CEILING: Limit = Limit {
    kind: "all",
    window: Duration::from_secs(10),
    limit: 100,
};

/// Counts sign-in attempts; Postgres in the service.
pub(crate) trait Limiter: Send + Sync {
    /// Counts one attempt in each of `keyed` and, only if none is over its limit, in `ceiling`; how
    /// long to wait when any is over.
    fn hit<'a>(
        &'a self,
        keyed: &'a [SignInHit],
        ceiling: &'a SignInHit,
    ) -> BoxFuture<'a, Result<Option<Duration>, String>>;
}

impl Limiter for Store {
    fn hit<'a>(
        &'a self,
        keyed: &'a [SignInHit],
        ceiling: &'a SignInHit,
    ) -> BoxFuture<'a, Result<Option<Duration>, String>> {
        Box::pin(async move { self.sign_in_hits(keyed, ceiling).await.map_err(|e| e.to_string()) })
    }
}

/// What a sign-in route needs, apart from the request.
pub(crate) struct Ctx<'a> {
    pub sign_in: &'a SignIn,
    pub tokens: &'a dyn VerifyToken,
    pub limits: &'a dyn Limiter,
}

fn ctx(app: &App) -> Result<Ctx<'_>, ApiError> {
    Ok(Ctx {
        sign_in: app.sign_in.as_ref().ok_or(ApiError::Unavailable)?,
        tokens: app.tokens.as_ref(),
        limits: &app.store,
    })
}

/// A password, which only ever goes on to WorkOS: no `Serialize`, and `Debug` hides it.
#[derive(Deserialize, Clone)]
#[serde(transparent)]
pub struct Password(String);

impl fmt::Debug for Password {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Password(<hidden>)")
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PasswordSignInIn {
    pub email: String,
    #[schema(value_type = String, format = Password)]
    pub password: Password,
    /// Where to go once signed in: a path on the web app. Defaults to `/`.
    pub return_to: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct VerifyEmailIn {
    /// The code we emailed to the address.
    pub code: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChooseOrganisationIn {
    /// One of the organisations the last step offered.
    pub organisation: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CodeRequestIn {
    pub email: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CodeSignInIn {
    pub email: String,
    /// The one-time code we emailed to the address.
    pub code: String,
    /// Where to go once signed in: a path on the web app. Defaults to `/`.
    pub return_to: Option<String>,
}

#[derive(Debug, Serialize, ToSchema, PartialEq, Eq)]
pub struct OrganisationOut {
    pub id: String,
    pub name: String,
}

/// Where a sign-in stands after a step that worked.
#[derive(Debug, Serialize, ToSchema, PartialEq, Eq)]
#[serde(tag = "next", rename_all = "snake_case")]
pub enum SignInStep {
    /// Signed in: the session cookie is set. Go to `return_to`.
    Done { return_to: String },
    /// A code was emailed to the address; post it to `/auth/sign-in/verify-email`.
    VerifyEmail,
    /// Post one of these to `/auth/sign-in/organisation`.
    ChooseOrganisation { organisations: Vec<OrganisationOut> },
}

/// The one answer to asking for a sign-in code: `{"next":"enter_code"}`, whether or not the address
/// has an account. A type of its own, so no other route can claim it.
#[derive(Debug, Serialize, ToSchema, PartialEq, Eq)]
pub struct CodeRequested {
    pub next: CodeRequestedNext,
}

/// If the address has an account, a code is on its way; post it to `/auth/sign-in/code/verify`.
#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodeRequestedNext {
    EnterCode,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct InvitationIn {
    /// The token from the invitation link.
    pub token: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AcceptInvitationIn {
    /// The token from the invitation link.
    pub token: String,
    /// A new password, or the account's own when the address already has one.
    #[schema(value_type = String, format = Password)]
    pub password: Password,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    /// Where to go once signed in: a path on the web app. Defaults to `/`.
    pub return_to: Option<String>,
}

/// An open invitation, for its screen. Only the link's holder learns it.
#[derive(Debug, Serialize, ToSchema, PartialEq, Eq)]
pub struct InvitationOut {
    /// The address it was sent to; the only one that can accept it.
    pub email: String,
    /// The organisation's name, when it could be read.
    pub organisation: Option<String>,
    /// The address has an account already: accepting takes its password, and names are ignored.
    pub has_account: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ForgotPasswordIn {
    pub email: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ResetPasswordIn {
    /// The token from the reset link.
    pub token: String,
    #[schema(value_type = String, format = Password)]
    pub password: Password,
}

/// The one answer to a forgotten password: `{"next":"check_email"}`, whether or not the address
/// has an account.
#[derive(Debug, Serialize, ToSchema, PartialEq, Eq)]
pub struct ResetRequested {
    pub next: ResetRequestedNext,
}

/// If the address has an account, a reset link is on its way.
#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResetRequestedNext {
    CheckEmail,
}

/// The answer to a new password set: `{"next":"sign_in"}`. The account's existing sessions are
/// revoked and end at their next refresh; the person signs in with the new password.
#[derive(Debug, Serialize, ToSchema, PartialEq, Eq)]
pub struct PasswordChanged {
    pub next: PasswordChangedNext,
}

/// Sign in with the new password.
#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PasswordChangedNext {
    SignIn,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Step {
    VerifyEmail,
    ChooseOrganisation,
}

/// A sign-in waiting on its next step, sealed in [`PENDING_COOKIE`].
#[derive(Serialize, Deserialize)]
struct Pending {
    purpose: String,
    step: Step,
    /// WorkOS's pending authentication token.
    token: String,
    /// The organisations offered, by id, when the step is to choose one.
    organisations: Vec<String>,
    /// The address's keyed hash, for its limits; never the address.
    address: [u8; 32],
    return_to: String,
    expires: u64,
    /// WorkOS's id for the code a verification step waits on, for sending it again.
    #[serde(default)]
    verification: Option<String>,
}

/// The client as the Worker forwards it: the first `X-Forwarded-For` entry, which the Worker sets
/// from Cloudflare's view of the peer after dropping the browser's own (`fde-web/src/forward.ts`);
/// anything after it was added by the load balancer. Not an IP address: no client.
pub(crate) fn client_of(headers: &HeaderMap) -> Client {
    let ip = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .and_then(|v| v.trim().parse::<std::net::IpAddr>().ok())
        .map(|ip| ip.to_string());
    let user_agent = headers
        .get(USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.chars()
                .filter(|c| !c.is_control())
                .take(MAX_USER_AGENT_CHARS)
                .collect::<String>()
        })
        .filter(|v| !v.is_empty());
    Client { ip, user_agent }
}

/// A JSON body, refused without saying why: a parse error can quote the value it choked on.
fn body<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(bytes).map_err(|_| ApiError::Invalid("body"))
}

fn hit(limit: Limit, key: Option<[u8; 32]>) -> Result<SignInHit, ApiError> {
    SignInHit::new(limit.kind, key.as_ref(), limit.window, limit.limit).map_err(|_| ApiError::Internal)
}

/// Whom a client's limits count: its IPv4 address, or the /64 of its IPv6 address, which one
/// subscriber usually holds whole, so rotating within it does not get past them.
fn client_bucket(ip: Option<&str>) -> String {
    match ip.and_then(|i| i.parse::<std::net::IpAddr>().ok()) {
        Some(std::net::IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
        Some(ip) => ip.to_string(),
        None => "unknown".into(),
    }
}

/// Counts the attempt, before WorkOS is asked; refuses it over a limit or when it cannot be counted.
async fn count(ctx: &Ctx<'_>, client: &Client, address: Option<[u8; 32]>, limits: &[Limit]) -> Result<(), ApiError> {
    let client_key = ctx.sign_in.limit_hash("client", &client_bucket(client.ip.as_deref()));
    // The ceiling counts only attempts their own limits let through, so one client cannot use it up.
    let ceiling = hit(CEILING, None)?;
    let mut hits = vec![];
    for l in limits {
        let key = if l.kind.ends_with("_address") {
            address
        } else {
            Some(client_key)
        };
        hits.push(hit(*l, key)?);
    }
    match ctx.limits.hit(&hits, &ceiling).await {
        Ok(None) => Ok(()),
        Ok(Some(wait)) => {
            tracing::info!(wait_secs = wait.as_secs(), "sign-in limit reached");
            Err(ApiError::TooManyAttempts(wait))
        }
        Err(e) => {
            // Fail closed: an attempt that cannot be counted is not made.
            tracing::error!(error = %e, "sign-in limits could not be counted");
            Err(ApiError::Unavailable)
        }
    }
}

/// A token from a link (invitation, reset) as a [`ProviderId`]: letters, digits, `-` and `_` only,
/// so `.`, `..`, a slash or an escape never reaches a WorkOS path.
fn token_of(raw: &str) -> Option<ProviderId> {
    ProviderId::new(raw)
}

/// A name as typed: trimmed, at most 100 characters, no control characters; empty is none.
fn name_of(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(v) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if v.chars().count() > 100 || v.chars().any(char::is_control) {
        return Err(ApiError::Invalid("name"));
    }
    Ok(Some(v.to_owned()))
}

fn password_ok(p: &Password) -> bool {
    !p.0.is_empty() && p.0.len() <= MAX_PASSWORD_BYTES
}

/// An emailed code as typed: 1 to 16 ASCII letters or digits, spaces around it aside.
fn code_of(raw: &str) -> Option<&str> {
    let code = raw.trim();
    let ok =
        !code.is_empty() && code.chars().count() <= MAX_CODE_CHARS && code.chars().all(|c| c.is_ascii_alphanumeric());
    ok.then_some(code)
}

/// The answer to a request to email a code or a link: `answer` whether or not anything was sent, unless WorkOS
/// is down. Whether a mail went out says whether the address has an account, so it is only logged.
fn sent_answer<T: Serialize>(sent: Sent, answer: T) -> Response {
    match sent {
        Sent::Sent => tracing::info!("sign-in mail sent"),
        Sent::NotSent(why) => tracing::info!(why = %why, "sign-in mail not sent"),
        Sent::Unavailable(why) => {
            tracing::warn!(error = %why, "workos could not send a sign-in mail");
            return ApiError::Unavailable.into_response();
        }
    }
    Json(answer).into_response()
}

/// The address's keyed hash, from its lowercased form.
fn address_key(sign_in: &SignIn, email: &EmailAddress) -> [u8; 32] {
    sign_in.limit_hash("address", &email.as_str().to_lowercase())
}

/// The answer to an attempt. `refused` is what a refusal says on this route; whether the pending
/// cookie is kept on one is `keep_on_refusal`.
async fn conclude(
    ctx: &Ctx<'_>,
    attempt: Attempt,
    address: [u8; 32],
    return_to: String,
    refused: ApiError,
    keep_on_refusal: bool,
) -> Response {
    let pending = |step, token, organisations, verification| Pending {
        purpose: PENDING_PURPOSE.into(),
        step,
        token,
        organisations,
        address,
        return_to: return_to.clone(),
        expires: now() + PENDING_TTL.as_secs(),
        verification,
    };
    let result = match attempt {
        Attempt::SignedIn(tokens) => match session_cookie(ctx.tokens, ctx.sign_in, tokens).await {
            Ok(session) => {
                let mut resp = Json(SignInStep::Done {
                    return_to: return_to.clone(),
                })
                .into_response();
                let h = resp.headers_mut();
                h.append(SET_COOKIE, session);
                h.append(SET_COOKIE, clear_cookie(PENDING_COOKIE));
                Ok(resp)
            }
            Err(e) => Err((e, false)),
        },
        Attempt::VerifyEmail {
            pending: token,
            verification,
        } => {
            tracing::info!("sign-in waits on email verification");
            let p = pending(Step::VerifyEmail, token, vec![], verification);
            with_pending(ctx, &p, SignInStep::VerifyEmail)
        }
        Attempt::ChooseOrganisation {
            pending: token,
            organisations,
        } => {
            tracing::info!(offered = organisations.len(), "sign-in waits on an organisation choice");
            let ids = organisations.iter().map(|(id, _)| id.clone()).collect();
            let step = SignInStep::ChooseOrganisation {
                organisations: organisations
                    .into_iter()
                    .map(|(id, name)| OrganisationOut { id, name })
                    .collect(),
            };
            with_pending(ctx, &pending(Step::ChooseOrganisation, token, ids, None), step)
        }
        Attempt::Refused => {
            tracing::info!("sign-in refused");
            Err((refused, keep_on_refusal))
        }
        Attempt::Unsupported(code) => {
            tracing::info!(step = %code, "sign-in needs a step the screens do not handle");
            Err((ApiError::SignInUnsupported, false))
        }
        Attempt::Unavailable(why) => {
            tracing::warn!(error = %why, "workos could not answer a sign-in");
            Err((ApiError::Unavailable, true))
        }
    };
    match result {
        Ok(resp) => resp,
        Err((e, keep)) => {
            let mut resp = e.into_response();
            if !keep {
                resp.headers_mut().append(SET_COOKIE, clear_cookie(PENDING_COOKIE));
            }
            resp
        }
    }
}

/// `step`'s answer, with the pending cookie that carries the sign-in to it.
fn with_pending(ctx: &Ctx<'_>, pending: &Pending, step: SignInStep) -> Result<Response, (ApiError, bool)> {
    let sealed = ctx.sign_in.seal(pending).map_err(|e| (e, false))?;
    let mut resp = Json(step).into_response();
    resp.headers_mut()
        .append(SET_COOKIE, set_cookie(PENDING_COOKIE, &sealed, PENDING_TTL));
    Ok(resp)
}

/// `resp` once at least [`ANSWER_FLOOR`] has passed since `start`.
async fn padded(start: Instant, resp: Response) -> Response {
    tokio::time::sleep_until(start + ANSWER_FLOOR).await;
    resp
}

fn refuse(e: ApiError) -> Response {
    e.into_response()
}

/// The pending sign-in the cookie carries, at `step` and not expired.
fn pending_of(ctx: &Ctx<'_>, headers: &HeaderMap, step: Step) -> Option<Pending> {
    let (p, _): (Pending, bool) = ctx.sign_in.unseal(cookie_value(headers, PENDING_COOKIE)?)?;
    (p.purpose == PENDING_PURPOSE && p.step == step && p.expires > now()).then_some(p)
}

/// A refusal of the pending cookie itself, which also clears it.
fn no_pending() -> Response {
    let mut resp = ApiError::Invalid("sign_in").into_response();
    resp.headers_mut().append(SET_COOKIE, clear_cookie(PENDING_COOKIE));
    resp
}

pub(crate) async fn password_sign_in(ctx: &Ctx<'_>, headers: &HeaderMap, raw: &[u8]) -> Response {
    let start = Instant::now();
    if !ctx.sign_in.same_site(headers) {
        return refuse(ApiError::Csrf);
    }
    let input: PasswordSignInIn = match body(raw) {
        Ok(b) => b,
        Err(e) => return refuse(e),
    };
    let Ok(email) = EmailAddress::new(&input.email) else {
        return refuse(ApiError::Invalid("email"));
    };
    if input.password.0.is_empty() || input.password.0.len() > MAX_PASSWORD_BYTES {
        return refuse(ApiError::Invalid("password"));
    }
    let Some(return_to) = safe_return_to(input.return_to.as_deref().unwrap_or("/")) else {
        return refuse(ApiError::Invalid("return_to"));
    };
    let client = client_of(headers);
    let address = address_key(ctx.sign_in, &email);
    if let Err(e) = count(ctx, &client, Some(address), &[PASSWORD_ADDRESS, PASSWORD_CLIENT]).await {
        return padded(start, e.into_response()).await;
    }
    let attempt = ctx
        .sign_in
        .authkit()
        .sign_in_with_password(email.as_str(), &input.password.0, &client)
        .await;
    // The pending cookie of an earlier attempt means nothing now: a refusal clears it.
    let resp = conclude(ctx, attempt, address, return_to, ApiError::InvalidCredentials, false).await;
    padded(start, resp).await
}

pub(crate) async fn verify_email_sign_in(ctx: &Ctx<'_>, headers: &HeaderMap, raw: &[u8]) -> Response {
    let start = Instant::now();
    if !ctx.sign_in.same_site(headers) {
        return refuse(ApiError::Csrf);
    }
    let input: VerifyEmailIn = match body(raw) {
        Ok(b) => b,
        Err(e) => return refuse(e),
    };
    let Some(code) = code_of(&input.code) else {
        return refuse(ApiError::Invalid("code"));
    };
    let Some(pending) = pending_of(ctx, headers, Step::VerifyEmail) else {
        return no_pending();
    };
    let client = client_of(headers);
    if let Err(e) = count(ctx, &client, Some(pending.address), &[CODE_ADDRESS, CODE_CLIENT]).await {
        return padded(start, e.into_response()).await;
    }
    let attempt = ctx.sign_in.authkit().verify_email(&pending.token, code, &client).await;
    // A mistyped code may be tried again on the same step, within the code limits.
    let resp = conclude(
        ctx,
        attempt,
        pending.address,
        pending.return_to,
        ApiError::InvalidCode,
        true,
    )
    .await;
    padded(start, resp).await
}

pub(crate) async fn choose_organisation_sign_in(ctx: &Ctx<'_>, headers: &HeaderMap, raw: &[u8]) -> Response {
    let start = Instant::now();
    if !ctx.sign_in.same_site(headers) {
        return refuse(ApiError::Csrf);
    }
    let input: ChooseOrganisationIn = match body(raw) {
        Ok(b) => b,
        Err(e) => return refuse(e),
    };
    let Some(pending) = pending_of(ctx, headers, Step::ChooseOrganisation) else {
        return no_pending();
    };
    // Only an organisation WorkOS offered this sign-in.
    if !pending.organisations.contains(&input.organisation) {
        return refuse(ApiError::Invalid("organisation"));
    }
    let client = client_of(headers);
    if let Err(e) = count(ctx, &client, None, &[STEP_CLIENT]).await {
        return padded(start, e.into_response()).await;
    }
    let attempt = ctx
        .sign_in
        .authkit()
        .choose_organisation(&pending.token, &input.organisation, &client)
        .await;
    let resp = conclude(
        ctx,
        attempt,
        pending.address,
        pending.return_to,
        ApiError::Invalid("sign_in"),
        false,
    )
    .await;
    padded(start, resp).await
}

pub(crate) async fn request_code(ctx: &Ctx<'_>, headers: &HeaderMap, raw: &[u8]) -> Response {
    let start = Instant::now();
    if !ctx.sign_in.same_site(headers) {
        return refuse(ApiError::Csrf);
    }
    let input: CodeRequestIn = match body(raw) {
        Ok(b) => b,
        Err(e) => return refuse(e),
    };
    let Ok(email) = EmailAddress::new(&input.email) else {
        return refuse(ApiError::Invalid("email"));
    };
    let client = client_of(headers);
    let address = address_key(ctx.sign_in, &email);
    if let Err(e) = count(ctx, &client, Some(address), &[SEND_ADDRESS, SEND_CLIENT]).await {
        return padded(start, e.into_response()).await;
    }
    let sent = ctx.sign_in.authkit().send_code(email.as_str(), &client).await;
    padded(
        start,
        sent_answer(
            sent,
            CodeRequested {
                next: CodeRequestedNext::EnterCode,
            },
        ),
    )
    .await
}

pub(crate) async fn code_sign_in(ctx: &Ctx<'_>, headers: &HeaderMap, raw: &[u8]) -> Response {
    let start = Instant::now();
    if !ctx.sign_in.same_site(headers) {
        return refuse(ApiError::Csrf);
    }
    let input: CodeSignInIn = match body(raw) {
        Ok(b) => b,
        Err(e) => return refuse(e),
    };
    let Ok(email) = EmailAddress::new(&input.email) else {
        return refuse(ApiError::Invalid("email"));
    };
    let Some(code) = code_of(&input.code) else {
        return refuse(ApiError::Invalid("code"));
    };
    let Some(return_to) = safe_return_to(input.return_to.as_deref().unwrap_or("/")) else {
        return refuse(ApiError::Invalid("return_to"));
    };
    let client = client_of(headers);
    let address = address_key(ctx.sign_in, &email);
    if let Err(e) = count(ctx, &client, Some(address), &[CODE_ADDRESS, CODE_CLIENT]).await {
        return padded(start, e.into_response()).await;
    }
    let attempt = ctx
        .sign_in
        .authkit()
        .sign_in_with_code(email.as_str(), code, &client)
        .await;
    // A wrong code and a code for an address with no account answer alike.
    // This route needs no pending cookie, so clearing one on a refusal only drops a stale step.
    let resp = conclude(ctx, attempt, address, return_to, ApiError::InvalidCode, false).await;
    padded(start, resp).await
}

pub(crate) async fn resend_verification(ctx: &Ctx<'_>, headers: &HeaderMap) -> Response {
    let start = Instant::now();
    if !ctx.sign_in.same_site(headers) {
        return refuse(ApiError::Csrf);
    }
    let Some(pending) = pending_of(ctx, headers, Step::VerifyEmail) else {
        return no_pending();
    };
    let client = client_of(headers);
    if let Err(e) = count(ctx, &client, Some(pending.address), &[SEND_ADDRESS, SEND_CLIENT]).await {
        return padded(start, e.into_response()).await;
    }
    let sent = match pending.verification.as_deref().and_then(ProviderId::new) {
        Some(v) => ctx.sign_in.authkit().resend_verification(&v).await,
        None => Sent::NotSent("the step names no usable verification".into()),
    };
    padded(start, sent_answer(sent, SignInStep::VerifyEmail)).await
}

/// The open invitation `token` names, and its address; an unknown, spent or revoked one is refused.
async fn open_invitation(ctx: &Ctx<'_>, token: &ProviderId) -> Result<(EmailAddress, Option<String>), ApiError> {
    match ctx.sign_in.authkit().invitation(token).await {
        Ok(Some(i)) if i.pending => {
            let email = EmailAddress::new(&i.email).map_err(|_| ApiError::Invalid("invitation"))?;
            Ok((email, i.organisation))
        }
        Ok(_) => {
            tracing::info!("invitation refused: none open for that token");
            Err(ApiError::Invalid("invitation"))
        }
        Err(e) => {
            tracing::warn!(error = %e, "workos could not read an invitation");
            Err(ApiError::Unavailable)
        }
    }
}

pub(crate) async fn look_up_invitation(ctx: &Ctx<'_>, headers: &HeaderMap, raw: &[u8]) -> Response {
    let start = Instant::now();
    if !ctx.sign_in.same_site(headers) {
        return refuse(ApiError::Csrf);
    }
    let input: InvitationIn = match body(raw) {
        Ok(b) => b,
        Err(e) => return refuse(e),
    };
    let Some(token) = token_of(&input.token) else {
        return refuse(ApiError::Invalid("invitation"));
    };
    let client = client_of(headers);
    if let Err(e) = count(ctx, &client, None, &[INVITE_CLIENT]).await {
        return padded(start, e.into_response()).await;
    }
    let answer = async {
        let (email, organisation) = open_invitation(ctx, &token).await?;
        let has_account = ctx.sign_in.authkit().has_account(email.as_str()).await.map_err(|e| {
            tracing::warn!(error = %e, "workos could not look up an account");
            ApiError::Unavailable
        })?;
        let organisation = match organisation {
            Some(o) => ctx.sign_in.authkit().organisation_name(&o).await.ok(),
            None => None,
        };
        Ok::<_, ApiError>(InvitationOut {
            email: email.as_str().to_owned(),
            organisation,
            has_account,
        })
    };
    let resp = match answer.await {
        Ok(out) => Json(out).into_response(),
        Err(e) => e.into_response(),
    };
    padded(start, resp).await
}

pub(crate) async fn accept_invitation(ctx: &Ctx<'_>, headers: &HeaderMap, raw: &[u8]) -> Response {
    let start = Instant::now();
    if !ctx.sign_in.same_site(headers) {
        return refuse(ApiError::Csrf);
    }
    let input: AcceptInvitationIn = match body(raw) {
        Ok(b) => b,
        Err(e) => return refuse(e),
    };
    let Some(token) = token_of(&input.token) else {
        return refuse(ApiError::Invalid("invitation"));
    };
    if !password_ok(&input.password) {
        return refuse(ApiError::Invalid("password"));
    }
    let (first, last) = match (
        name_of(input.first_name.as_deref()),
        name_of(input.last_name.as_deref()),
    ) {
        (Ok(f), Ok(l)) => (f, l),
        (Err(e), _) | (_, Err(e)) => return refuse(e),
    };
    let Some(return_to) = safe_return_to(input.return_to.as_deref().unwrap_or("/")) else {
        return refuse(ApiError::Invalid("return_to"));
    };
    let client = client_of(headers);
    if let Err(e) = count(ctx, &client, None, &[INVITE_CLIENT]).await {
        return padded(start, e.into_response()).await;
    }
    // The address is the invitation's own, never one the request names.
    let email = match open_invitation(ctx, &token).await {
        Ok((email, _)) => email,
        Err(e) => return padded(start, e.into_response()).await,
    };
    let address = address_key(ctx.sign_in, &email);
    if let Err(e) = count(ctx, &client, Some(address), &[PASSWORD_ADDRESS]).await {
        return padded(start, e.into_response()).await;
    }
    let kit = ctx.sign_in.authkit();
    let exists = match kit.has_account(email.as_str()).await {
        Ok(exists) => exists,
        Err(e) => {
            tracing::warn!(error = %e, "workos could not look up an account");
            return padded(start, ApiError::Unavailable.into_response()).await;
        }
    };
    if !exists {
        let refused = match kit
            .create_account(
                email.as_str(),
                &input.password.0,
                (first.as_deref(), last.as_deref()),
                &client,
            )
            .await
        {
            Created::Created | Created::Exists => None,
            Created::WeakPassword => Some(ApiError::NeedsAction("weak_password")),
            Created::Refused(why) => {
                tracing::info!(why = %why, "account for an invitation refused");
                Some(ApiError::Invalid("invitation"))
            }
            Created::Unavailable(why) => {
                tracing::warn!(error = %why, "workos could not create an account");
                Some(ApiError::Unavailable)
            }
        };
        if let Some(e) = refused {
            return padded(start, e.into_response()).await;
        }
    }
    let attempt = kit
        .accept_with_password(email.as_str(), &input.password.0, token.as_str(), &client)
        .await;
    let resp = conclude(ctx, attempt, address, return_to, ApiError::InvalidCredentials, false).await;
    padded(start, resp).await
}

pub(crate) async fn forgot_password(ctx: &Ctx<'_>, headers: &HeaderMap, raw: &[u8]) -> Response {
    let start = Instant::now();
    if !ctx.sign_in.same_site(headers) {
        return refuse(ApiError::Csrf);
    }
    let input: ForgotPasswordIn = match body(raw) {
        Ok(b) => b,
        Err(e) => return refuse(e),
    };
    let Ok(email) = EmailAddress::new(&input.email) else {
        return refuse(ApiError::Invalid("email"));
    };
    let client = client_of(headers);
    let address = address_key(ctx.sign_in, &email);
    if let Err(e) = count(ctx, &client, Some(address), &[SEND_ADDRESS, SEND_CLIENT]).await {
        return padded(start, e.into_response()).await;
    }
    let sent = ctx.sign_in.authkit().send_password_reset(email.as_str()).await;
    let answer = ResetRequested {
        next: ResetRequestedNext::CheckEmail,
    };
    padded(start, sent_answer(sent, answer)).await
}

/// Revokes every WorkOS session of `user` after a reset, so a session from before it (a taken-over
/// account's above all) ends at its next refresh. The new password is set either way, so a failure
/// is logged, not answered.
/// ponytail: a revoked session's access token still verifies until it expires (minutes); ending it
/// at once needs the API to check revocation on every request.
async fn end_sessions(kit: &dyn crate::session::AuthKit, user: &str) {
    let Some(user) = ProviderId::new(user) else {
        tracing::error!("password reset: the user id is not one a WorkOS path can take; sessions not revoked");
        return;
    };
    let sessions = match kit.sessions_of(&user).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = %e, "password reset: sessions could not be listed, so none were revoked");
            return;
        }
    };
    let mut failed = 0usize;
    for id in &sessions {
        if let Err(e) = kit.revoke(id).await {
            failed += 1;
            tracing::error!(error = %e, "password reset: a session could not be revoked");
        }
    }
    tracing::info!(sessions = sessions.len(), failed, "password reset; sessions revoked");
}

pub(crate) async fn reset_password(ctx: &Ctx<'_>, headers: &HeaderMap, raw: &[u8]) -> Response {
    let start = Instant::now();
    if !ctx.sign_in.same_site(headers) {
        return refuse(ApiError::Csrf);
    }
    let input: ResetPasswordIn = match body(raw) {
        Ok(b) => b,
        Err(e) => return refuse(e),
    };
    let Some(token) = token_of(&input.token) else {
        return refuse(ApiError::Invalid("reset_token"));
    };
    if !password_ok(&input.password) {
        return refuse(ApiError::Invalid("password"));
    }
    let client = client_of(headers);
    if let Err(e) = count(ctx, &client, None, &[RESET_CLIENT]).await {
        return padded(start, e.into_response()).await;
    }
    let kit = ctx.sign_in.authkit();
    let resp = match kit.reset_password(token.as_str(), &input.password.0).await {
        Reset::Done { user } => {
            end_sessions(kit, &user).await;
            Json(PasswordChanged {
                next: PasswordChangedNext::SignIn,
            })
            .into_response()
        }
        Reset::WeakPassword => ApiError::NeedsAction("weak_password").into_response(),
        Reset::Refused(why) => {
            tracing::info!(why = %why, "password reset refused");
            ApiError::Invalid("reset_token").into_response()
        }
        Reset::Unavailable(why) => {
            tracing::warn!(error = %why, "workos could not reset a password");
            ApiError::Unavailable.into_response()
        }
    };
    padded(start, resp).await
}

/// Sign in with an email address and password. A wrong password and an unknown address get the
/// same 401 `invalid_credentials`; a limit reached gets 429 `too_many_attempts` with `Retry-After`,
/// alike for every address.
#[utoipa::path(post, operation_id = "sign_in_with_password", path = "/auth/sign-in/password", tag = "auth",
    security(()), request_body = PasswordSignInIn,
    responses((status = 200, body = SignInStep, description = "Signed in (`done`, with the session cookie), or the \
        next step, with a short-lived pending cookie"),
        (status = 400, body = ErrorBody), (status = 401, body = ErrorBody, description = "`invalid_credentials`"),
        (status = 403, body = ErrorBody, description = "`csrf`; `no_organisation` (the person is in no \
            organisation: show the page for it, no session is set); `sign_in_unsupported`"),
        (status = 429, body = ErrorBody, description = "`too_many_attempts`; see `Retry-After`"),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn password(State(app): State<Arc<App>>, headers: HeaderMap, raw: Bytes) -> Response {
    match ctx(&app) {
        Ok(ctx) => password_sign_in(&ctx, &headers, &raw).await,
        Err(e) => e.into_response(),
    }
}

/// Continue a sign-in that waits on email verification, with the code we emailed.
#[utoipa::path(post, operation_id = "sign_in_verify_email", path = "/auth/sign-in/verify-email", tag = "auth",
    security(()), request_body = VerifyEmailIn,
    responses((status = 200, body = SignInStep),
        (status = 400, body = ErrorBody, description = "`invalid_sign_in`: no pending verification (start again); \
            `invalid_code`: not a code"),
        (status = 401, body = ErrorBody, description = "`invalid_code`: wrong or expired; the step stays open"),
        (status = 403, body = ErrorBody), (status = 429, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn verify_email(State(app): State<Arc<App>>, headers: HeaderMap, raw: Bytes) -> Response {
    match ctx(&app) {
        Ok(ctx) => verify_email_sign_in(&ctx, &headers, &raw).await,
        Err(e) => e.into_response(),
    }
}

/// Continue a sign-in into one of the organisations the last step offered.
#[utoipa::path(post, operation_id = "sign_in_choose_organisation", path = "/auth/sign-in/organisation", tag = "auth",
    security(()), request_body = ChooseOrganisationIn,
    responses((status = 200, body = SignInStep),
        (status = 400, body = ErrorBody, description = "`invalid_sign_in`: no pending choice (start again); \
            `invalid_organisation`: not one offered"),
        (status = 403, body = ErrorBody), (status = 429, body = ErrorBody), (status = 503, body = ErrorBody)))]
pub(crate) async fn choose_organisation(State(app): State<Arc<App>>, headers: HeaderMap, raw: Bytes) -> Response {
    match ctx(&app) {
        Ok(ctx) => choose_organisation_sign_in(&ctx, &headers, &raw).await,
        Err(e) => e.into_response(),
    }
}

/// Email a one-time sign-in code. The answer is the same whether or not the address has an account;
/// a limit reached is 429 `too_many_attempts`, alike for every address.
#[utoipa::path(post, operation_id = "sign_in_request_code", path = "/auth/sign-in/code", tag = "auth",
    security(()), request_body = CodeRequestIn,
    responses((status = 200, body = CodeRequested, description = "`enter_code`, whether or not a code was sent"),
        (status = 400, body = ErrorBody), (status = 403, body = ErrorBody, description = "`csrf`"),
        (status = 429, body = ErrorBody, description = "`too_many_attempts`; see `Retry-After`"),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn code(State(app): State<Arc<App>>, headers: HeaderMap, raw: Bytes) -> Response {
    match ctx(&app) {
        Ok(ctx) => request_code(&ctx, &headers, &raw).await,
        Err(e) => e.into_response(),
    }
}

/// Sign in with the one-time code we emailed. A wrong code and an address with no account get the
/// same 401 `invalid_code`.
#[utoipa::path(post, operation_id = "sign_in_with_code", path = "/auth/sign-in/code/verify", tag = "auth",
    security(()), request_body = CodeSignInIn,
    responses((status = 200, body = SignInStep, description = "Signed in (`done`, with the session cookie), or the \
        next step, with a short-lived pending cookie"),
        (status = 400, body = ErrorBody), (status = 401, body = ErrorBody, description = "`invalid_code`"),
        (status = 403, body = ErrorBody, description = "`csrf`; `no_organisation`; `sign_in_unsupported`"),
        (status = 429, body = ErrorBody, description = "`too_many_attempts`; see `Retry-After`"),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn code_verify(State(app): State<Arc<App>>, headers: HeaderMap, raw: Bytes) -> Response {
    match ctx(&app) {
        Ok(ctx) => code_sign_in(&ctx, &headers, &raw).await,
        Err(e) => e.into_response(),
    }
}

/// Email the code of a pending email verification again. The step stays as it is.
#[utoipa::path(post, operation_id = "sign_in_resend_verification", path = "/auth/sign-in/verify-email/resend",
    tag = "auth", security(()),
    responses((status = 200, body = SignInStep, description = "`verify_email`"),
        (status = 400, body = ErrorBody, description = "`invalid_sign_in`: no pending verification (start again)"),
        (status = 403, body = ErrorBody, description = "`csrf`"),
        (status = 429, body = ErrorBody, description = "`too_many_attempts`; see `Retry-After`"),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn resend(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    match ctx(&app) {
        Ok(ctx) => resend_verification(&ctx, &headers).await,
        Err(e) => e.into_response(),
    }
}

/// The invitation a link's token names: its address, organisation and whether the address has an
/// account, for the accept screen. A token that names no open invitation is 400 `invalid_invitation`.
#[utoipa::path(post, operation_id = "look_up_invitation", path = "/auth/invitation", tag = "auth",
    security(()), request_body = InvitationIn,
    responses((status = 200, body = InvitationOut),
        (status = 400, body = ErrorBody, description = "`invalid_invitation`: unknown, accepted, expired or revoked"),
        (status = 403, body = ErrorBody, description = "`csrf`"),
        (status = 429, body = ErrorBody, description = "`too_many_attempts`; see `Retry-After`"),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn invitation(State(app): State<Arc<App>>, headers: HeaderMap, raw: Bytes) -> Response {
    match ctx(&app) {
        Ok(ctx) => look_up_invitation(&ctx, &headers, &raw).await,
        Err(e) => e.into_response(),
    }
}

/// Accept an invitation and sign in. The address is the invitation's own: a new account gets this
/// password and name, and an existing one signs in with its own password.
#[utoipa::path(post, operation_id = "accept_invitation", path = "/auth/invitation/accept", tag = "auth",
    security(()), request_body = AcceptInvitationIn,
    responses((status = 200, body = SignInStep, description = "Signed in (`done`, with the session cookie), or the \
        next step, with a short-lived pending cookie"),
        (status = 400, body = ErrorBody, description = "`invalid_invitation`; `weak_password`: the password does \
            not meet the policy; `invalid_password`, `invalid_name`, `invalid_return_to`, `invalid_body`"),
        (status = 401, body = ErrorBody, description = "`invalid_credentials`: the existing account's password is wrong"),
        (status = 403, body = ErrorBody, description = "`csrf`; `no_organisation`; `sign_in_unsupported`"),
        (status = 429, body = ErrorBody, description = "`too_many_attempts`; see `Retry-After`"),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn accept(State(app): State<Arc<App>>, headers: HeaderMap, raw: Bytes) -> Response {
    match ctx(&app) {
        Ok(ctx) => accept_invitation(&ctx, &headers, &raw).await,
        Err(e) => e.into_response(),
    }
}

/// Email a password reset link. The answer is the same whether or not the address has an account.
#[utoipa::path(post, operation_id = "forgot_password", path = "/auth/password/forgot", tag = "auth",
    security(()), request_body = ForgotPasswordIn,
    responses((status = 200, body = ResetRequested, description = "`check_email`, whether or not a link was sent"),
        (status = 400, body = ErrorBody), (status = 403, body = ErrorBody, description = "`csrf`"),
        (status = 429, body = ErrorBody, description = "`too_many_attempts`; see `Retry-After`"),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn forgot(State(app): State<Arc<App>>, headers: HeaderMap, raw: Bytes) -> Response {
    match ctx(&app) {
        Ok(ctx) => forgot_password(&ctx, &headers, &raw).await,
        Err(e) => e.into_response(),
    }
}

/// Set a new password with the token from a reset link. It signs nobody in: the account's existing
/// sessions are revoked and end at their next refresh, and the person signs in with the new password.
#[utoipa::path(post, operation_id = "reset_password", path = "/auth/password/reset", tag = "auth",
    security(()), request_body = ResetPasswordIn,
    responses((status = 200, body = PasswordChanged, description = "`sign_in`"),
        (status = 400, body = ErrorBody, description = "`invalid_reset_token`: wrong, spent or expired; \
            `weak_password`; `invalid_password`"),
        (status = 403, body = ErrorBody, description = "`csrf`"),
        (status = 429, body = ErrorBody, description = "`too_many_attempts`; see `Retry-After`"),
        (status = 503, body = ErrorBody)))]
pub(crate) async fn reset(State(app): State<Arc<App>>, headers: HeaderMap, raw: Bytes) -> Response {
    match ctx(&app) {
        Ok(ctx) => reset_password(&ctx, &headers, &raw).await,
        Err(e) => e.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use axum::http::header::{COOKIE, ORIGIN, RETRY_AFTER};
    use axum::http::{HeaderValue, StatusCode};
    use oryxa_authn::{JwtError, SessionClaims};
    use tracing::instrument::WithSubscriber;

    use super::*;
    use crate::Person;
    use crate::session::{AuthKit, Invitation, RefreshError, SESSION_COOKIE, Tokens, session_of};

    const WEB: &str = "https://fde.test";
    const KNOWN: &str = "Known.Person@Example.com";
    const PASSWORD: &str = "correct horse battery staple";
    /// Invited, with no account yet.
    const INVITED: &str = "new.person@example.com";

    /// Tokens are `tok|user|organisation|session`; an empty organisation is none.
    struct Verifier;
    impl VerifyToken for Verifier {
        fn claims<'a>(
            &'a self,
            token: &'a str,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<SessionClaims, JwtError>> + Send + 'a>> {
            Box::pin(async move {
                let parts: Vec<&str> = token.split('|').collect();
                let ["tok", user, org, sid] = parts[..] else {
                    return Err(JwtError::Malformed);
                };
                Ok(SessionClaims {
                    sub: user.into(),
                    sid: sid.into(),
                    org_id: (!org.is_empty()).then(|| org.to_owned()),
                    role: Some("member".into()),
                    exp: u64::MAX,
                })
            })
        }
    }

    fn signed_in(user: &str, org: &str) -> Attempt {
        Attempt::SignedIn(Tokens {
            access_token: format!("tok|{user}|{org}|session_{user}"),
            refresh_token: format!("refresh-secret-{user}"),
        })
    }

    /// WorkOS without WorkOS: `KNOWN` with `PASSWORD` gets `on_password`; any other pair is refused,
    /// a known address more slowly than an unknown one, as a real lookup might be.
    struct Kit {
        on_password: Mutex<Attempt>,
        on_code: Mutex<Attempt>,
        /// What sending a code to `KNOWN` answers; any other address gets `NotSent`.
        on_send: Mutex<Sent>,
        calls: Mutex<Vec<(String, Client)>>,
        revoked: Mutex<Vec<String>>,
    }

    impl Kit {
        fn new(on_password: Attempt) -> Arc<Self> {
            Arc::new(Self {
                on_password: Mutex::new(on_password),
                on_code: Mutex::new(signed_in("user_1", "org_01A")),
                on_send: Mutex::new(Sent::Sent),
                calls: Mutex::new(vec![]),
                revoked: Mutex::new(vec![]),
            })
        }
        fn calls(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
    }

    impl AuthKit for Kit {
        fn authorization_url(&self, _: &str, _: &str, _: &str) -> Result<String, String> {
            Err("unused".into())
        }
        fn exchange_code<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<Tokens, String>> {
            Box::pin(async { Err("unused".into()) })
        }
        fn refresh<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFuture<'a, Result<Tokens, RefreshError>> {
            Box::pin(async { Err(RefreshError::Refused("unused".into())) })
        }
        fn revoke<'a>(&'a self, session: &'a str) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                self.revoked.lock().unwrap().push(session.to_owned());
                Ok(())
            })
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
        fn sign_in_with_password<'a>(
            &'a self,
            email: &'a str,
            password: &'a str,
            client: &'a Client,
        ) -> BoxFuture<'a, Attempt> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(("password".into(), client.clone()));
                if email == KNOWN && password == PASSWORD {
                    return self.on_password.lock().unwrap().clone();
                }
                let lookup = if email == KNOWN { 300 } else { 5 };
                tokio::time::sleep(Duration::from_millis(lookup)).await;
                Attempt::Refused
            })
        }
        fn verify_email<'a>(&'a self, pending: &'a str, code: &'a str, client: &'a Client) -> BoxFuture<'a, Attempt> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(("verify".into(), client.clone()));
                if pending == "pt_verify" && code == "123456" {
                    self.on_code.lock().unwrap().clone()
                } else {
                    Attempt::Refused
                }
            })
        }
        fn choose_organisation<'a>(
            &'a self,
            pending: &'a str,
            organisation: &'a str,
            client: &'a Client,
        ) -> BoxFuture<'a, Attempt> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(("organisation".into(), client.clone()));
                if pending == "pt_choose" {
                    signed_in("user_1", organisation)
                } else {
                    Attempt::Refused
                }
            })
        }
        fn send_code<'a>(&'a self, email: &'a str, client: &'a Client) -> BoxFuture<'a, Sent> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(("send".into(), client.clone()));
                if email == KNOWN {
                    // Mail for a real account takes longer to send.
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    return self.on_send.lock().unwrap().clone();
                }
                Sent::NotSent("status 404, code user_not_found".into())
            })
        }
        fn sign_in_with_code<'a>(
            &'a self,
            email: &'a str,
            code: &'a str,
            client: &'a Client,
        ) -> BoxFuture<'a, Attempt> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(("code".into(), client.clone()));
                if email == KNOWN && code == "123456" {
                    return self.on_code.lock().unwrap().clone();
                }
                let lookup = if email == KNOWN { 300 } else { 5 };
                tokio::time::sleep(Duration::from_millis(lookup)).await;
                Attempt::Refused
            })
        }
        fn resend_verification<'a>(&'a self, verification: &'a ProviderId) -> BoxFuture<'a, Sent> {
            Box::pin(async move {
                self.calls
                    .lock()
                    .unwrap()
                    .push((format!("resend {}", verification.as_str()), Client::default()));
                Sent::Sent
            })
        }
        fn sessions_of<'a>(&'a self, user: &'a ProviderId) -> BoxFuture<'a, Result<Vec<String>, String>> {
            Box::pin(async move {
                self.calls
                    .lock()
                    .unwrap()
                    .push((format!("sessions {}", user.as_str()), Client::default()));
                Ok(vec![
                    format!("session_a_{}", user.as_str()),
                    format!("session_b_{}", user.as_str()),
                ])
            })
        }
        fn invitation<'a>(&'a self, token: &'a ProviderId) -> BoxFuture<'a, Result<Option<Invitation>, String>> {
            Box::pin(async move {
                let token = token.as_str();
                self.calls
                    .lock()
                    .unwrap()
                    .push((format!("invitation {token}"), Client::default()));
                let open = |email: &str, pending| {
                    Some(Invitation {
                        email: email.into(),
                        organisation: Some("org_01A".into()),
                        pending,
                    })
                };
                Ok(match token {
                    "inv_new" => open(INVITED, true),
                    "inv_known" => open(KNOWN, true),
                    "inv_spent" => open(INVITED, false),
                    "inv_down" => return Err("status 503".into()),
                    _ => None,
                })
            })
        }
        fn has_account<'a>(&'a self, email: &'a str) -> BoxFuture<'a, Result<bool, String>> {
            Box::pin(async move { Ok(email == KNOWN) })
        }
        fn create_account<'a>(
            &'a self,
            email: &'a str,
            password: &'a str,
            name: (Option<&'a str>, Option<&'a str>),
            client: &'a Client,
        ) -> BoxFuture<'a, Created> {
            Box::pin(async move {
                let call = format!("create {email} {:?} {:?}", name.0, name.1);
                self.calls.lock().unwrap().push((call, client.clone()));
                if password == "weak" {
                    Created::WeakPassword
                } else {
                    Created::Created
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
                self.calls
                    .lock()
                    .unwrap()
                    .push((format!("accept {email} {invitation}"), client.clone()));
                match (email, password) {
                    (KNOWN, PASSWORD) => signed_in("user_1", "org_01A"),
                    (INVITED, _) => signed_in("user_new", "org_01A"),
                    _ => Attempt::Refused,
                }
            })
        }
        fn send_password_reset<'a>(&'a self, email: &'a str) -> BoxFuture<'a, Sent> {
            Box::pin(async move {
                self.calls
                    .lock()
                    .unwrap()
                    .push(("reset link".into(), Client::default()));
                if email == KNOWN {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    return self.on_send.lock().unwrap().clone();
                }
                Sent::NotSent("status 404, code user_not_found".into())
            })
        }
        fn reset_password<'a>(&'a self, token: &'a str, password: &'a str) -> BoxFuture<'a, Reset> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(("reset".into(), Client::default()));
                match (token, password) {
                    (_, "weak") => Reset::WeakPassword,
                    ("reset_ok", _) => Reset::Done { user: "user_1".into() },
                    ("reset_down", _) => Reset::Unavailable("status 503".into()),
                    _ => Reset::Refused("status 400, code invalid_token".into()),
                }
            })
        }
    }

    /// Records each attempt's buckets and answers as told.
    struct Limits {
        answer: Mutex<Result<Option<Duration>, String>>,
        seen: Mutex<Vec<Vec<String>>>,
    }

    impl Limits {
        fn new() -> Self {
            Self {
                answer: Mutex::new(Ok(None)),
                seen: Mutex::new(vec![]),
            }
        }
    }

    impl Limiter for Limits {
        fn hit<'a>(
            &'a self,
            keyed: &'a [SignInHit],
            ceiling: &'a SignInHit,
        ) -> BoxFuture<'a, Result<Option<Duration>, String>> {
            Box::pin(async move {
                assert_eq!(ceiling.bucket(), "all:", "the ceiling is passed as the ceiling");
                assert!(keyed.iter().all(|h| h.bucket() != "all:"), "and not as a keyed bucket");
                let mut seen: Vec<String> = keyed.iter().map(|h| h.bucket().to_owned()).collect();
                seen.push(ceiling.bucket().to_owned());
                self.seen.lock().unwrap().push(seen);
                self.answer.lock().unwrap().clone()
            })
        }
    }

    struct World {
        sign_in: SignIn,
        kit: Arc<Kit>,
        limits: Limits,
    }

    impl World {
        fn new(on_password: Attempt) -> Self {
            let kit = Kit::new(on_password);
            Self {
                sign_in: SignIn::new(WEB, "a".repeat(64), kit.clone()).unwrap(),
                kit,
                limits: Limits::new(),
            }
        }
        fn ctx(&self) -> Ctx<'_> {
            Ctx {
                sign_in: &self.sign_in,
                tokens: &Verifier,
                limits: &self.limits,
            }
        }
    }

    /// The web app's own headers, a forwarded client, and `cookies`.
    fn headers(cookies: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(ORIGIN, HeaderValue::from_static(WEB));
        h.insert("x-oryxa-request", HeaderValue::from_static("1"));
        h.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.7, 10.0.0.2"));
        h.insert(USER_AGENT, HeaderValue::from_static("Browser/1.0"));
        if !cookies.is_empty() {
            h.insert(COOKIE, HeaderValue::from_str(&cookies.join("; ")).unwrap());
        }
        h
    }

    fn password_body(email: &str, password: &str) -> Vec<u8> {
        serde_json::json!({ "email": email, "password": password, "return_to": "/companies" })
            .to_string()
            .into_bytes()
    }

    struct Answer {
        status: StatusCode,
        body: String,
        cookies: Vec<String>,
        retry_after: Option<String>,
    }

    impl Answer {
        fn cookie(&self, name: &str) -> Option<&str> {
            self.cookies.iter().find_map(|c| {
                let v = c.strip_prefix(name)?.strip_prefix('=')?;
                Some(v.split(';').next().unwrap_or_default())
            })
        }
        /// Every byte the browser sees, apart from the sealed cookie values.
        fn visible(&self) -> String {
            let cookies: Vec<String> = self
                .cookies
                .iter()
                .map(|c| {
                    c.split_once('=')
                        .map(|(n, rest)| format!("{n}={}", &rest[rest.find(';').unwrap_or(0)..]))
                        .unwrap_or_default()
                })
                .collect();
            format!("{} {} {:?} {:?}", self.status, self.body, cookies, self.retry_after)
        }
    }

    async fn read(resp: Response) -> Answer {
        let status = resp.status();
        let cookies = resp
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().to_owned())
            .collect();
        let retry_after = resp.headers().get(RETRY_AFTER).map(|v| v.to_str().unwrap().to_owned());
        let bytes = http_body_util::BodyExt::collect(resp.into_body())
            .await
            .unwrap()
            .to_bytes();
        Answer {
            status,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
            cookies,
            retry_after,
        }
    }

    fn cleared(a: &Answer, name: &str) -> bool {
        a.cookies
            .iter()
            .any(|c| c.starts_with(&format!("{name}=;")) && c.contains("Max-Age=0"))
    }

    #[tokio::test(start_paused = true)]
    async fn a_password_sign_in_sets_a_fresh_session_whatever_the_browser_brought() {
        let w = World::new(signed_in("user_1", "org_01A"));
        let stale = "__Host-fde_session=stale-or-someone-elses; __Host-fde_pending=old";
        let a = read(password_sign_in(&w.ctx(), &headers(&[stale]), &password_body(KNOWN, PASSWORD)).await).await;
        assert_eq!(a.status, StatusCode::OK, "{}", a.body);
        assert_eq!(a.body, r#"{"next":"done","return_to":"/companies"}"#);
        let session = a.cookie(SESSION_COOKIE).expect("a session cookie");
        assert_eq!(
            session_of(&w.sign_in, session),
            Some(("user_1".into(), "org_01A".into())),
            "the new session is the one WorkOS just signed in"
        );
        assert!(cleared(&a, PENDING_COOKIE));
        let calls = w.kit.calls.lock().unwrap().clone();
        assert_eq!(
            calls,
            [(
                "password".to_owned(),
                Client {
                    ip: Some("203.0.113.7".into()),
                    user_agent: Some("Browser/1.0".into()),
                }
            )],
            "WorkOS is told the forwarded client and its user agent"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_wrong_password_and_an_unknown_address_answer_alike_and_take_as_long() {
        let w = World::new(signed_in("user_1", "org_01A"));
        let mut answers = vec![];
        for (email, password) in [(KNOWN, "wrong password"), ("nobody@example.com", "wrong password")] {
            let start = Instant::now();
            let a = read(password_sign_in(&w.ctx(), &headers(&[]), &password_body(email, password)).await).await;
            answers.push((a.status, a.body.clone(), a.cookies.clone(), start.elapsed()));
        }
        assert_eq!(answers[0].0, StatusCode::UNAUTHORIZED);
        assert_eq!(answers[0].1, r#"{"error":"invalid_credentials"}"#);
        assert_eq!(answers[0], answers[1], "status, body, cookies and time are the same");
        assert_eq!(answers[0].3, ANSWER_FLOOR);
        assert!(
            answers[0].2.iter().all(|c| !c.starts_with(SESSION_COOKIE)),
            "no session"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn limits_count_before_workos_answer_alike_for_any_address_and_fail_closed() {
        let w = World::new(signed_in("user_1", "org_01A"));
        *w.limits.answer.lock().unwrap() = Ok(Some(Duration::from_secs(42)));
        let mut answers = vec![];
        for email in [KNOWN, "nobody@example.com"] {
            let start = Instant::now();
            let a = read(password_sign_in(&w.ctx(), &headers(&[]), &password_body(email, PASSWORD)).await).await;
            assert_eq!(a.status, StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(a.retry_after.as_deref(), Some("42"));
            answers.push((a.body, start.elapsed()));
        }
        assert_eq!(answers[0], answers[1]);
        assert_eq!(answers[0].0, r#"{"error":"too_many_attempts"}"#);
        assert_eq!(w.kit.calls(), 0, "WorkOS is not asked over a limit");

        // Counters that cannot be counted refuse.
        *w.limits.answer.lock().unwrap() = Err("database down".into());
        let a = read(password_sign_in(&w.ctx(), &headers(&[]), &password_body(KNOWN, PASSWORD)).await).await;
        assert_eq!(a.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(w.kit.calls(), 0);

        // Each attempt counts per address (case aside), per client and in the ceiling, by keyed hash.
        let seen = w.limits.seen.lock().unwrap().clone();
        assert!(
            seen.iter().all(|b| b.len() == 3 && b.contains(&"all:".to_owned())),
            "{seen:?}"
        );
        let address = |b: &Vec<String>| b.iter().find(|x| x.starts_with("password_address:")).cloned().unwrap();
        assert_eq!(address(&seen[0]), address(&seen[2]));
        assert_ne!(address(&seen[0]), address(&seen[1]));
        let again = World::new(Attempt::Refused);
        read(password_sign_in(&again.ctx(), &headers(&[]), &password_body(&KNOWN.to_lowercase(), "x")).await).await;
        assert_eq!(
            address(&again.limits.seen.lock().unwrap()[0]),
            address(&seen[0]),
            "lowercased"
        );
        let all = format!("{seen:?}").to_lowercase();
        assert!(!all.contains("example.com") && !all.contains("known") && !all.contains("203.0.113.7"));
        assert!(seen[0].iter().any(|b| b.starts_with("password_client:")));
    }

    #[tokio::test(start_paused = true)]
    async fn every_route_checks_the_origin_first_cookie_or_not() {
        let w = World::new(signed_in("user_1", "org_01A"));
        let mut bad = vec![];
        let mut no_header = headers(&[]);
        no_header.remove("x-oryxa-request");
        bad.push(no_header);
        let mut other = headers(&[]);
        other.insert(ORIGIN, HeaderValue::from_static("https://evil.example"));
        bad.push(other);
        let mut none = headers(&[]);
        none.remove(ORIGIN);
        bad.push(none);
        for h in bad {
            for resp in [
                password_sign_in(&w.ctx(), &h, &password_body(KNOWN, PASSWORD)).await,
                verify_email_sign_in(&w.ctx(), &h, br#"{"code":"123456"}"#).await,
                choose_organisation_sign_in(&w.ctx(), &h, br#"{"organisation":"org_01A"}"#).await,
                request_code(&w.ctx(), &h, br#"{"email":"known@example.com"}"#).await,
                code_sign_in(&w.ctx(), &h, br#"{"email":"known@example.com","code":"123456"}"#).await,
                resend_verification(&w.ctx(), &h).await,
                look_up_invitation(&w.ctx(), &h, br#"{"token":"inv_new"}"#).await,
                accept_invitation(&w.ctx(), &h, br#"{"token":"inv_new","password":"x"}"#).await,
                forgot_password(&w.ctx(), &h, br#"{"email":"known@example.com"}"#).await,
                reset_password(&w.ctx(), &h, br#"{"token":"reset_ok","password":"x"}"#).await,
            ] {
                let a = read(resp).await;
                assert_eq!(
                    (a.status, a.body.as_str()),
                    (StatusCode::FORBIDDEN, r#"{"error":"csrf"}"#)
                );
            }
        }
        assert_eq!(w.kit.calls(), 0);
        assert!(w.limits.seen.lock().unwrap().is_empty());
    }

    fn pending_cookie(a: &Answer) -> String {
        format!(
            "{PENDING_COOKIE}={}",
            a.cookie(PENDING_COOKIE).expect("a pending cookie")
        )
    }

    #[tokio::test(start_paused = true)]
    async fn email_verification_waits_in_a_sealed_cookie_and_a_mistyped_code_may_be_tried_again() {
        let w = World::new(Attempt::VerifyEmail {
            pending: "pt_verify".into(),
            verification: Some("email_verification_1".into()),
        });
        let a = read(password_sign_in(&w.ctx(), &headers(&[]), &password_body(KNOWN, PASSWORD)).await).await;
        assert_eq!(
            (a.status, a.body.as_str()),
            (StatusCode::OK, r#"{"next":"verify_email"}"#)
        );
        let pending = pending_cookie(&a);
        assert!(
            a.cookies.iter().all(|c| !c.starts_with(SESSION_COOKIE)),
            "no session yet"
        );
        let c = a.cookies.iter().find(|c| c.starts_with(PENDING_COOKIE)).unwrap();
        assert!(
            c.contains("Max-Age=600") && c.contains("Secure") && c.contains("HttpOnly"),
            "{c}"
        );
        // What it holds: the step, WorkOS's token and the address's hash, never the password or address.
        let (held, _): (Pending, bool) = w.sign_in.unseal(a.cookie(PENDING_COOKIE).unwrap()).unwrap();
        let held = serde_json::to_string(&held).unwrap();
        assert!(held.contains("pt_verify") && held.contains("verify_email"), "{held}");
        assert!(
            !held.contains(PASSWORD) && !held.to_lowercase().contains("example.com"),
            "{held}"
        );

        // Without its cookie, or with one for another step, there is nothing to continue.
        let a = read(verify_email_sign_in(&w.ctx(), &headers(&[]), br#"{"code":"123456"}"#).await).await;
        assert_eq!(
            (a.status, a.body.as_str()),
            (StatusCode::BAD_REQUEST, r#"{"error":"invalid_sign_in"}"#)
        );
        assert!(cleared(&a, PENDING_COOKIE));
        let a =
            read(choose_organisation_sign_in(&w.ctx(), &headers(&[&pending]), br#"{"organisation":"org_01A"}"#).await)
                .await;
        assert_eq!(a.body, r#"{"error":"invalid_sign_in"}"#);

        // A wrong code keeps the step; it counts as a code guess for that address.
        let a = read(verify_email_sign_in(&w.ctx(), &headers(&[&pending]), br#"{"code":"654321"}"#).await).await;
        assert_eq!(
            (a.status, a.body.as_str()),
            (StatusCode::UNAUTHORIZED, r#"{"error":"invalid_code"}"#)
        );
        assert!(a.cookies.is_empty(), "{:?}", a.cookies);
        let seen = w.limits.seen.lock().unwrap().clone();
        let last = seen.last().unwrap();
        assert!(
            last.iter().any(|b| b.starts_with("code_address:")) && last.iter().any(|b| b.starts_with("code_client:"))
        );
        let first_address = seen[0].iter().find(|b| b.starts_with("password_address:")).unwrap();
        let code_address = last.iter().find(|b| b.starts_with("code_address:")).unwrap();
        assert_eq!(
            first_address.split_once(':').unwrap().1,
            code_address.split_once(':').unwrap().1
        );

        let a = read(verify_email_sign_in(&w.ctx(), &headers(&[&pending]), br#"{"code":"123456"}"#).await).await;
        assert_eq!(a.body, r#"{"next":"done","return_to":"/companies"}"#);
        assert!(a.cookie(SESSION_COOKIE).is_some() && cleared(&a, PENDING_COOKIE));

        for bad in [
            r#"{"code":""}"#,
            r#"{"code":"12 34"}"#,
            r#"{"code":"12345678901234567"}"#,
        ] {
            let a = read(verify_email_sign_in(&w.ctx(), &headers(&[&pending]), bad.as_bytes()).await).await;
            assert_eq!(a.body, r#"{"error":"invalid_code"}"#, "{bad}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn only_an_organisation_offered_can_be_chosen() {
        let w = World::new(Attempt::ChooseOrganisation {
            pending: "pt_choose".into(),
            organisations: vec![("org_01A".into(), "Acme".into()), ("org_01B".into(), "Beta".into())],
        });
        let a = read(password_sign_in(&w.ctx(), &headers(&[]), &password_body(KNOWN, PASSWORD)).await).await;
        assert_eq!(
            a.body,
            r#"{"next":"choose_organisation","organisations":[{"id":"org_01A","name":"Acme"},{"id":"org_01B","name":"Beta"}]}"#
        );
        let pending = pending_cookie(&a);
        let a =
            read(choose_organisation_sign_in(&w.ctx(), &headers(&[&pending]), br#"{"organisation":"org_01C"}"#).await)
                .await;
        assert_eq!(
            (a.status, a.body.as_str()),
            (StatusCode::BAD_REQUEST, r#"{"error":"invalid_organisation"}"#)
        );
        let calls = w.kit.calls();
        let a =
            read(choose_organisation_sign_in(&w.ctx(), &headers(&[&pending]), br#"{"organisation":"org_01B"}"#).await)
                .await;
        assert_eq!(a.body, r#"{"next":"done","return_to":"/companies"}"#);
        assert_eq!(
            session_of(&w.sign_in, a.cookie(SESSION_COOKIE).unwrap()),
            Some(("user_1".into(), "org_01B".into()))
        );
        assert!(cleared(&a, PENDING_COOKIE));
        assert_eq!(w.kit.calls(), calls + 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_pending_step_lapses() {
        let w = World::new(signed_in("user_1", "org_01A"));
        let stale = Pending {
            purpose: PENDING_PURPOSE.into(),
            step: Step::VerifyEmail,
            token: "pt_verify".into(),
            organisations: vec![],
            address: [0; 32],
            return_to: "/".into(),
            expires: now() - 1,
            verification: None,
        };
        let cookie = format!("{PENDING_COOKIE}={}", w.sign_in.seal(&stale).unwrap());
        let a = read(verify_email_sign_in(&w.ctx(), &headers(&[&cookie]), br#"{"code":"123456"}"#).await).await;
        assert_eq!(a.body, r#"{"error":"invalid_sign_in"}"#);
        assert_eq!(w.kit.calls(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn no_organisation_and_steps_we_cannot_show_end_with_no_session() {
        for (attempt, status, body) in [
            (
                signed_in("user_1", ""),
                StatusCode::FORBIDDEN,
                r#"{"error":"no_organisation"}"#,
            ),
            (
                Attempt::Unsupported("mfa_challenge".into()),
                StatusCode::FORBIDDEN,
                r#"{"error":"sign_in_unsupported"}"#,
            ),
            (
                Attempt::Unavailable("status 503".into()),
                StatusCode::SERVICE_UNAVAILABLE,
                r#"{"error":"unavailable"}"#,
            ),
        ] {
            let w = World::new(attempt);
            let a = read(password_sign_in(&w.ctx(), &headers(&[]), &password_body(KNOWN, PASSWORD)).await).await;
            assert_eq!((a.status, a.body.as_str()), (status, body));
            assert!(
                a.cookies.iter().all(|c| !c.starts_with(SESSION_COOKIE)),
                "{:?}",
                a.cookies
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn bad_input_is_refused_without_echoing_it() {
        let w = World::new(signed_in("user_1", "org_01A"));
        for (body, code) in [
            (
                r#"{"email":"known@example.com","password":31415926535}"#.to_owned(),
                "invalid_body",
            ),
            (
                r#"{"email":"known@example.com","password":"x","extra":"31415926535"}"#.to_owned(),
                "invalid_body",
            ),
            (r#"{"email":"31415926535","password":"x"}"#.to_owned(), "invalid_email"),
            (
                r#"{"email":"known@example.com","password":""}"#.to_owned(),
                "invalid_password",
            ),
            (
                format!(r#"{{"email":"known@example.com","password":"{}"}}"#, "p".repeat(1025)),
                "invalid_password",
            ),
            (
                r#"{"email":"known@example.com","password":"x","return_to":"//evil.example"}"#.to_owned(),
                "invalid_return_to",
            ),
            (
                r#"{"email":"known@example.com","password":"x","return_to":"https://evil.example/"}"#.to_owned(),
                "invalid_return_to",
            ),
        ] {
            let a = read(password_sign_in(&w.ctx(), &headers(&[]), body.as_bytes()).await).await;
            assert_eq!(a.status, StatusCode::BAD_REQUEST);
            assert_eq!(a.body, format!(r#"{{"error":"{code}"}}"#), "{body}");
            assert!(!a.body.contains("31415926535"));
        }
        assert_eq!(w.kit.calls(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn the_password_and_address_never_reach_a_log_or_an_answer_and_no_workos_secret_leaves() {
        let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
        let out = buf.clone();
        let sub = tracing::Dispatch::new(
            tracing_subscriber::fmt()
                .with_ansi(false)
                .with_max_level(tracing::Level::TRACE)
                .with_writer(move || Writer(out.clone()))
                .finish(),
        );
        let mut visible = String::new();
        for attempt in [
            signed_in("user_1", "org_01A"),
            signed_in("user_1", ""),
            Attempt::VerifyEmail {
                pending: "pt_verify".into(),
                verification: Some("email_verification_1".into()),
            },
            Attempt::ChooseOrganisation {
                pending: "pt_choose".into(),
                organisations: vec![("org_01A".into(), "Acme".into())],
            },
            Attempt::Unsupported("mfa_challenge".into()),
            Attempt::Unavailable("status 503".into()),
            Attempt::Refused,
        ] {
            let w = World::new(attempt);
            let ctx = w.ctx();
            let flow = async {
                let mut answers = vec![];
                for token in ["inv_new", "inv_known", "inv_spent"] {
                    let body = format!(r#"{{"token":"{token}","password":"{PASSWORD}","first_name":"Ada"}}"#);
                    answers.push(read(accept_invitation(&ctx, &headers(&[]), body.as_bytes()).await).await);
                }
                for token in ["reset_ok", "reset_bad"] {
                    let body = format!(r#"{{"token":"{token}","password":"{PASSWORD}"}}"#);
                    answers.push(read(reset_password(&ctx, &headers(&[]), body.as_bytes()).await).await);
                }
                for email in [KNOWN, "nobody@example.com"] {
                    let body = format!(r#"{{"email":"{email}"}}"#);
                    answers.push(read(forgot_password(&ctx, &headers(&[]), body.as_bytes()).await).await);
                    answers.push(read(request_code(&ctx, &headers(&[]), body.as_bytes()).await).await);
                    let body = format!(r#"{{"email":"{email}","code":"123456"}}"#);
                    answers.push(read(code_sign_in(&ctx, &headers(&[]), body.as_bytes()).await).await);
                }
                for password in [PASSWORD, "wrong password"] {
                    let a = read(password_sign_in(&ctx, &headers(&[]), &password_body(KNOWN, password)).await).await;
                    if let Some(p) = a.cookie(PENDING_COOKIE) {
                        let cookie = format!("{PENDING_COOKIE}={p}");
                        for resp in [
                            verify_email_sign_in(&ctx, &headers(&[&cookie]), br#"{"code":"123456"}"#).await,
                            choose_organisation_sign_in(&ctx, &headers(&[&cookie]), br#"{"organisation":"org_01A"}"#)
                                .await,
                        ] {
                            answers.push(read(resp).await);
                        }
                    }
                    answers.push(a);
                }
                answers
            };
            for a in flow.with_subscriber(sub.clone()).await {
                visible.push_str(&a.visible());
            }
        }
        let log = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        assert!(log.contains("sign-in refused"), "the flows did log: {log}");
        for secret in [
            PASSWORD,
            "wrong password",
            "example.com",
            "refresh-secret",
            "tok|",
            "pt_verify",
            "pt_choose",
            "123456",
            "email_verification_1",
            INVITED,
            "inv_new",
            "inv_known",
            "reset_ok",
            "reset_bad",
        ] {
            assert!(
                !log.to_lowercase().contains(&secret.to_lowercase()),
                "{secret} in the log: {log}"
            );
            assert!(
                !visible.to_lowercase().contains(&secret.to_lowercase()),
                "{secret} in an answer: {visible}"
            );
        }
        assert!(!visible.to_lowercase().contains("workos"), "{visible}");
    }

    #[derive(Clone)]
    struct Writer(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Writer {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn email_body(email: &str) -> Vec<u8> {
        serde_json::json!({ "email": email }).to_string().into_bytes()
    }

    #[tokio::test(start_paused = true)]
    async fn asking_for_a_code_answers_alike_whether_or_not_the_address_has_an_account() {
        let w = World::new(Attempt::Refused);
        let mut answers = vec![];
        for email in [KNOWN, "nobody@example.com"] {
            let start = Instant::now();
            let a = read(request_code(&w.ctx(), &headers(&[]), &email_body(email)).await).await;
            answers.push((a.status, a.body, a.cookies, a.retry_after, start.elapsed()));
        }
        assert_eq!(answers[0].1, r#"{"next":"enter_code"}"#);
        assert_eq!(answers[0], answers[1], "status, body, cookies and time are the same");
        assert_eq!(answers[0].4, ANSWER_FLOOR);
        let calls = w.kit.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0].1.ip.as_deref(),
            Some("203.0.113.7"),
            "WorkOS is told the client"
        );

        // Each request counts as a code sent, per address and per client, then in the ceiling.
        let seen = w.limits.seen.lock().unwrap().clone();
        for b in &seen {
            assert!(b.iter().any(|x| x.starts_with("send_address:")), "{b:?}");
            assert!(b.iter().any(|x| x.starts_with("send_client:")), "{b:?}");
            assert_eq!(b.last().map(String::as_str), Some("all:"));
        }

        // Over a limit, nothing is sent, and the answer is the same for every address.
        *w.limits.answer.lock().unwrap() = Ok(Some(Duration::from_secs(600)));
        for email in [KNOWN, "nobody@example.com"] {
            let a = read(request_code(&w.ctx(), &headers(&[]), &email_body(email)).await).await;
            assert_eq!(
                (a.status, a.body.as_str()),
                (StatusCode::TOO_MANY_REQUESTS, r#"{"error":"too_many_attempts"}"#)
            );
            assert_eq!(a.retry_after.as_deref(), Some("600"));
        }
        assert_eq!(w.kit.calls(), 2, "no mail over a limit");

        // Only WorkOS being down is told apart, and that is not about the address.
        *w.limits.answer.lock().unwrap() = Ok(None);
        *w.kit.on_send.lock().unwrap() = Sent::NotSent("status 429, code rate_limit_exceeded".into());
        let a = read(request_code(&w.ctx(), &headers(&[]), &email_body(KNOWN)).await).await;
        assert_eq!(a.body, r#"{"next":"enter_code"}"#);
        *w.kit.on_send.lock().unwrap() = Sent::Unavailable("status 503".into());
        let a = read(request_code(&w.ctx(), &headers(&[]), &email_body(KNOWN)).await).await;
        assert_eq!(a.status, StatusCode::SERVICE_UNAVAILABLE);
        let a = read(request_code(&w.ctx(), &headers(&[]), br#"{"email":"not an address"}"#).await).await;
        assert_eq!(a.body, r#"{"error":"invalid_email"}"#);
    }

    #[tokio::test(start_paused = true)]
    async fn a_code_signs_in_and_a_wrong_code_or_unknown_address_answer_alike() {
        let w = World::new(Attempt::Refused);
        let body = |email: &str, code: &str| {
            serde_json::json!({ "email": email, "code": code, "return_to": "/companies" })
                .to_string()
                .into_bytes()
        };
        let stale = "__Host-fde_session=stale-or-someone-elses";
        let a = read(code_sign_in(&w.ctx(), &headers(&[stale]), &body(KNOWN, " 123456 ")).await).await;
        assert_eq!(a.body, r#"{"next":"done","return_to":"/companies"}"#);
        assert_eq!(
            session_of(&w.sign_in, a.cookie(SESSION_COOKIE).unwrap()),
            Some(("user_1".into(), "org_01A".into()))
        );

        let mut answers = vec![];
        for (email, code) in [(KNOWN, "654321"), ("nobody@example.com", "123456")] {
            let start = Instant::now();
            let a = read(code_sign_in(&w.ctx(), &headers(&[]), &body(email, code)).await).await;
            answers.push((a.status, a.body, a.cookies, start.elapsed()));
        }
        assert_eq!(answers[0].0, StatusCode::UNAUTHORIZED);
        assert_eq!(answers[0].1, r#"{"error":"invalid_code"}"#);
        assert_eq!(answers[0], answers[1]);
        assert_eq!(answers[0].3, ANSWER_FLOOR);

        // Code guesses count per address and per client.
        let seen = w.limits.seen.lock().unwrap().clone();
        assert!(seen.iter().all(
            |b| b.iter().any(|x| x.starts_with("code_address:")) && b.iter().any(|x| x.starts_with("code_client:"))
        ));

        // The pending steps follow a code sign-in as they follow a password.
        *w.kit.on_code.lock().unwrap() = Attempt::ChooseOrganisation {
            pending: "pt_choose".into(),
            organisations: vec![("org_01B".into(), "Beta".into())],
        };
        let a = read(code_sign_in(&w.ctx(), &headers(&[]), &body(KNOWN, "123456")).await).await;
        assert!(a.body.contains(r#""next":"choose_organisation""#), "{}", a.body);
        let cookie = pending_cookie(&a);
        let a =
            read(choose_organisation_sign_in(&w.ctx(), &headers(&[&cookie]), br#"{"organisation":"org_01B"}"#).await)
                .await;
        assert_eq!(
            session_of(&w.sign_in, a.cookie(SESSION_COOKIE).unwrap()),
            Some(("user_1".into(), "org_01B".into()))
        );

        for bad in [
            r#"{"email":"x@example.com","code":""}"#,
            r#"{"email":"bad","code":"123456"}"#,
        ] {
            let a = read(code_sign_in(&w.ctx(), &headers(&[]), bad.as_bytes()).await).await;
            assert_eq!(a.status, StatusCode::BAD_REQUEST, "{bad}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_verification_code_is_sent_again_for_the_pending_step_only_and_within_the_send_limits() {
        let w = World::new(Attempt::VerifyEmail {
            pending: "pt_verify".into(),
            verification: Some("email_verification_1".into()),
        });
        let a = read(password_sign_in(&w.ctx(), &headers(&[]), &password_body(KNOWN, PASSWORD)).await).await;
        let pending = pending_cookie(&a);

        let a = read(resend_verification(&w.ctx(), &headers(&[&pending])).await).await;
        assert_eq!(
            (a.status, a.body.as_str()),
            (StatusCode::OK, r#"{"next":"verify_email"}"#)
        );
        assert!(a.cookies.is_empty(), "the step stays as it is: {:?}", a.cookies);
        assert!(
            w.kit
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(c, _)| c == "resend email_verification_1")
        );
        // Counted as a code sent to the address the step is for.
        let seen = w.limits.seen.lock().unwrap().clone();
        let hash =
            |b: &Vec<String>, kind: &str| b.iter().find_map(|x| x.strip_prefix(kind).map(str::to_owned)).unwrap();
        assert_eq!(hash(&seen[0], "password_address:"), hash(&seen[1], "send_address:"));

        // Over the send limit nothing is sent.
        *w.limits.answer.lock().unwrap() = Ok(Some(Duration::from_secs(60)));
        let calls = w.kit.calls();
        let a = read(resend_verification(&w.ctx(), &headers(&[&pending])).await).await;
        assert_eq!(a.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(w.kit.calls(), calls);

        // No pending verification: nothing to send again.
        *w.limits.answer.lock().unwrap() = Ok(None);
        let a = read(resend_verification(&w.ctx(), &headers(&[])).await).await;
        assert_eq!(
            (a.status, a.body.as_str()),
            (StatusCode::BAD_REQUEST, r#"{"error":"invalid_sign_in"}"#)
        );

        // A step that names no verification answers the same and sends nothing.
        let w = World::new(Attempt::VerifyEmail {
            pending: "pt_verify".into(),
            verification: None,
        });
        let a = read(password_sign_in(&w.ctx(), &headers(&[]), &password_body(KNOWN, PASSWORD)).await).await;
        let a = read(resend_verification(&w.ctx(), &headers(&[&pending_cookie(&a)])).await).await;
        assert_eq!(a.body, r#"{"next":"verify_email"}"#);
        assert!(!w.kit.calls.lock().unwrap().iter().any(|(c, _)| c.starts_with("resend")));
    }

    fn token_body(token: &str) -> Vec<u8> {
        serde_json::json!({ "token": token }).to_string().into_bytes()
    }

    #[tokio::test(start_paused = true)]
    async fn an_invitation_is_looked_up_by_its_token_and_only_an_open_one_is_shown() {
        let w = World::new(Attempt::Refused);
        let a = read(look_up_invitation(&w.ctx(), &headers(&[]), &token_body("inv_new")).await).await;
        assert_eq!(a.status, StatusCode::OK, "{}", a.body);
        // The fake cannot name organisations, so the name is left out rather than failing.
        assert_eq!(
            a.body,
            r#"{"email":"new.person@example.com","organisation":null,"has_account":false}"#
        );
        assert!(a.cookies.is_empty());
        let a = read(look_up_invitation(&w.ctx(), &headers(&[]), &token_body("inv_known")).await).await;
        assert!(a.body.contains(r#""has_account":true"#), "{}", a.body);

        for token in ["inv_spent", "inv_unknown", "has space", "../x?y", ""] {
            let a = read(look_up_invitation(&w.ctx(), &headers(&[]), &token_body(token)).await).await;
            assert_eq!(
                (a.status, a.body.as_str()),
                (StatusCode::BAD_REQUEST, r#"{"error":"invalid_invitation"}"#),
                "{token:?}"
            );
        }
        let a = read(look_up_invitation(&w.ctx(), &headers(&[]), &token_body("inv_down")).await).await;
        assert_eq!(a.status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            !w.kit
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(c, _)| c.contains("has space") || c.contains("../"))
        );

        let seen = w.limits.seen.lock().unwrap().clone();
        assert!(
            seen.iter().all(|b| b.iter().any(|x| x.starts_with("invite_client:"))),
            "{seen:?}"
        );
        *w.limits.answer.lock().unwrap() = Ok(Some(Duration::from_secs(30)));
        let a = read(look_up_invitation(&w.ctx(), &headers(&[]), &token_body("inv_new")).await).await;
        assert_eq!(a.status, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test(start_paused = true)]
    async fn a_link_token_that_could_change_the_providers_path_never_reaches_it() {
        let w = World::new(Attempt::Refused);
        let long = "a".repeat(257);
        for token in [
            ".",
            "..",
            "%2e%2e",
            "a/b",
            "../invitations",
            "a?b",
            "a#b",
            "a.b",
            "",
            long.as_str(),
        ] {
            let a = read(look_up_invitation(&w.ctx(), &headers(&[]), &token_body(token)).await).await;
            assert_eq!(a.body, r#"{"error":"invalid_invitation"}"#, "lookup {token:?}");
            let body = serde_json::json!({ "token": token, "password": PASSWORD });
            let a = read(accept_invitation(&w.ctx(), &headers(&[]), body.to_string().as_bytes()).await).await;
            assert_eq!(a.body, r#"{"error":"invalid_invitation"}"#, "accept {token:?}");
            let a = read(reset_password(&w.ctx(), &headers(&[]), body.to_string().as_bytes()).await).await;
            assert_eq!(a.body, r#"{"error":"invalid_reset_token"}"#, "reset {token:?}");
        }
        assert_eq!(w.kit.calls(), 0, "the provider was never asked");
        assert!(
            w.limits.seen.lock().unwrap().is_empty(),
            "refused before anything is counted"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_invitation_is_accepted_only_at_its_own_address() {
        let w = World::new(Attempt::Refused);
        let accept = |token: &str, password: &str| {
            serde_json::json!({ "token": token, "password": password, "first_name": " Ada ", "last_name": "Lovelace",
                "return_to": "/companies" })
            .to_string()
            .into_bytes()
        };

        // The body cannot name an address: the invitation's own is used.
        let smuggled = br#"{"token":"inv_new","password":"x","email":"attacker@example.com"}"#;
        let a = read(accept_invitation(&w.ctx(), &headers(&[]), smuggled).await).await;
        assert_eq!(a.body, r#"{"error":"invalid_body"}"#);
        assert_eq!(w.kit.calls(), 0);

        // No account yet: one is made for the invited address, with the name, then it signs in.
        let stale = "__Host-fde_session=stale-or-someone-elses";
        let a = read(accept_invitation(&w.ctx(), &headers(&[stale]), &accept("inv_new", PASSWORD)).await).await;
        assert_eq!(a.body, r#"{"next":"done","return_to":"/companies"}"#);
        assert_eq!(
            session_of(&w.sign_in, a.cookie(SESSION_COOKIE).unwrap()),
            Some(("user_new".into(), "org_01A".into()))
        );
        let calls: Vec<String> = w.kit.calls.lock().unwrap().iter().map(|(c, _)| c.clone()).collect();
        assert_eq!(
            calls,
            [
                "invitation inv_new",
                "create new.person@example.com Some(\"Ada\") Some(\"Lovelace\")",
                "accept new.person@example.com inv_new"
            ]
        );
        // Counted against the invitation's address, the same bucket a password sign-in uses.
        let seen = w.limits.seen.lock().unwrap().clone();
        let invited = address_key(&w.sign_in, &EmailAddress::new(INVITED).unwrap());
        let hex: String = invited.iter().map(|b| format!("{b:02x}")).collect();
        assert!(
            seen.iter().flatten().any(|b| *b == format!("password_address:{hex}")),
            "{seen:?}"
        );

        // An account already: no new one, it signs in with its own password.
        w.kit.calls.lock().unwrap().clear();
        let a = read(accept_invitation(&w.ctx(), &headers(&[]), &accept("inv_known", PASSWORD)).await).await;
        assert_eq!(
            session_of(&w.sign_in, a.cookie(SESSION_COOKIE).unwrap()),
            Some(("user_1".into(), "org_01A".into()))
        );
        assert!(!w.kit.calls.lock().unwrap().iter().any(|(c, _)| c.starts_with("create")));
        let a = read(accept_invitation(&w.ctx(), &headers(&[]), &accept("inv_known", "wrong")).await).await;
        assert_eq!(
            (a.status, a.body.as_str()),
            (StatusCode::UNAUTHORIZED, r#"{"error":"invalid_credentials"}"#)
        );

        // A weak password, a spent or unknown invitation: refused, and nobody signs in.
        w.kit.calls.lock().unwrap().clear();
        for (token, password, body) in [
            ("inv_new", "weak", r#"{"error":"weak_password"}"#),
            ("inv_spent", PASSWORD, r#"{"error":"invalid_invitation"}"#),
            ("inv_unknown", PASSWORD, r#"{"error":"invalid_invitation"}"#),
        ] {
            let a = read(accept_invitation(&w.ctx(), &headers(&[]), &accept(token, password)).await).await;
            assert_eq!((a.status, a.body.as_str()), (StatusCode::BAD_REQUEST, body), "{token}");
            assert!(a.cookies.iter().all(|c| !c.starts_with(SESSION_COOKIE)));
        }
        assert!(!w.kit.calls.lock().unwrap().iter().any(|(c, _)| c.starts_with("accept")));

        let long = "n".repeat(101);
        for bad in [
            serde_json::json!({ "token": "inv_new", "password": "" }),
            serde_json::json!({ "token": "inv_new", "password": "x", "first_name": long }),
            serde_json::json!({ "token": "inv_new", "password": "x", "last_name": "a\u{7}b" }),
            serde_json::json!({ "token": "inv_new", "password": "x", "return_to": "//evil.example" }),
        ] {
            let a = read(accept_invitation(&w.ctx(), &headers(&[]), bad.to_string().as_bytes()).await).await;
            assert_eq!(a.status, StatusCode::BAD_REQUEST, "{bad}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_forgotten_password_answers_alike_whether_or_not_the_address_has_an_account() {
        let w = World::new(Attempt::Refused);
        let mut answers = vec![];
        for email in [KNOWN, "nobody@example.com"] {
            let start = Instant::now();
            let a = read(forgot_password(&w.ctx(), &headers(&[]), &email_body(email)).await).await;
            answers.push((a.status, a.body, a.cookies, start.elapsed()));
        }
        assert_eq!(answers[0].1, r#"{"next":"check_email"}"#);
        assert_eq!(answers[0], answers[1]);
        assert_eq!(answers[0].3, ANSWER_FLOOR);
        let seen = w.limits.seen.lock().unwrap().clone();
        assert!(seen.iter().all(
            |b| b.iter().any(|x| x.starts_with("send_address:")) && b.iter().any(|x| x.starts_with("send_client:"))
        ));

        *w.limits.answer.lock().unwrap() = Ok(Some(Duration::from_secs(900)));
        let calls = w.kit.calls();
        for email in [KNOWN, "nobody@example.com"] {
            let a = read(forgot_password(&w.ctx(), &headers(&[]), &email_body(email)).await).await;
            assert_eq!(a.status, StatusCode::TOO_MANY_REQUESTS);
        }
        assert_eq!(w.kit.calls(), calls, "no mail over a limit");
        *w.limits.answer.lock().unwrap() = Ok(None);
        *w.kit.on_send.lock().unwrap() = Sent::Unavailable("status 503".into());
        let a = read(forgot_password(&w.ctx(), &headers(&[]), &email_body(KNOWN)).await).await;
        assert_eq!(a.status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test(start_paused = true)]
    async fn a_reset_sets_the_new_password_and_signs_nobody_in() {
        let w = World::new(Attempt::Refused);
        let body = |token: &str, password: &str| {
            serde_json::json!({ "token": token, "password": password })
                .to_string()
                .into_bytes()
        };
        let a = read(reset_password(&w.ctx(), &headers(&[]), &body("reset_ok", PASSWORD)).await).await;
        assert_eq!((a.status, a.body.as_str()), (StatusCode::OK, r#"{"next":"sign_in"}"#));
        assert!(a.cookies.is_empty(), "no session: {:?}", a.cookies);
        // Every session of the person the reset named is revoked.
        let calls: Vec<String> = w.kit.calls.lock().unwrap().iter().map(|(c, _)| c.clone()).collect();
        assert!(calls.contains(&"sessions user_1".to_owned()), "{calls:?}");
        assert_eq!(*w.kit.revoked.lock().unwrap(), ["session_a_user_1", "session_b_user_1"]);
        for (token, password, status, answer) in [
            (
                "reset_ok",
                "weak",
                StatusCode::BAD_REQUEST,
                r#"{"error":"weak_password"}"#,
            ),
            (
                "reset_spent",
                PASSWORD,
                StatusCode::BAD_REQUEST,
                r#"{"error":"invalid_reset_token"}"#,
            ),
            (
                "not a token",
                PASSWORD,
                StatusCode::BAD_REQUEST,
                r#"{"error":"invalid_reset_token"}"#,
            ),
            (
                "reset_ok",
                "",
                StatusCode::BAD_REQUEST,
                r#"{"error":"invalid_password"}"#,
            ),
            (
                "reset_down",
                PASSWORD,
                StatusCode::SERVICE_UNAVAILABLE,
                r#"{"error":"unavailable"}"#,
            ),
        ] {
            let a = read(reset_password(&w.ctx(), &headers(&[]), &body(token, password)).await).await;
            assert_eq!((a.status, a.body.as_str()), (status, answer), "{token} {password}");
        }
        let seen = w.limits.seen.lock().unwrap().clone();
        assert!(
            seen.iter().all(|b| b.iter().any(|x| x.starts_with("reset_client:"))),
            "{seen:?}"
        );
    }

    #[test]
    fn ipv6_clients_are_limited_by_their_64() {
        assert_eq!(client_bucket(Some("2001:db8:1:2:aaaa::1")), "2001:db8:1:2::/64");
        assert_eq!(
            client_bucket(Some("2001:db8:1:2:ffff:1:2:3")),
            client_bucket(Some("2001:db8:1:2::9"))
        );
        assert_ne!(
            client_bucket(Some("2001:db8:1:2::1")),
            client_bucket(Some("2001:db8:1:3::1"))
        );
        assert_eq!(client_bucket(Some("203.0.113.7")), "203.0.113.7");
        assert_eq!(
            client_bucket(Some("::ffff:203.0.113.7")),
            "203.0.113.7",
            "a mapped IPv4 is that IPv4"
        );
        assert_eq!(client_bucket(None), "unknown");
        assert_eq!(client_bucket(Some("not an ip")), "unknown");
    }

    #[test]
    fn the_client_is_the_first_forwarded_address_and_a_tidy_user_agent() {
        let mut h = HeaderMap::new();
        assert_eq!(client_of(&h), Client::default());
        h.insert("x-forwarded-for", HeaderValue::from_static(" 2001:db8::1 , 10.0.0.2"));
        h.insert(
            USER_AGENT,
            HeaderValue::from_str(&format!("A\tB{}", "x".repeat(600))).unwrap(),
        );
        let c = client_of(&h);
        assert_eq!(c.ip.as_deref(), Some("2001:db8::1"));
        let ua = c.user_agent.unwrap();
        assert!(
            ua.starts_with("AB") && ua.chars().count() == MAX_USER_AGENT_CHARS,
            "{ua}"
        );
        for bad in ["not-an-ip", "", "203.0.113.7:443", "unknown, 203.0.113.7"] {
            h.insert("x-forwarded-for", HeaderValue::from_str(bad).unwrap());
            assert_eq!(client_of(&h).ip, None, "{bad}");
        }
    }

    #[test]
    fn sign_in_routes_are_left_to_their_own_checks() {
        for p in PATHS {
            assert!(is_sign_in_path(p));
        }
        for p in [
            "/auth/login",
            "/auth/callback",
            "/auth/logout",
            "/v1/me",
            "/auth/sign-in/password/x",
        ] {
            assert!(!is_sign_in_path(p), "{p}");
        }
    }
}
