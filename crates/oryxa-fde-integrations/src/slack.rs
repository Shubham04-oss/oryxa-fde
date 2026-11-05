//! Slack: the Events API (signed requests; only the uninstall events are used) and the Web API calls
//! the service makes with a tenant's bot token: the OAuth v2 code exchange, the channel list, and
//! posting an approved update. The bot token is a credential: `Debug` hides it, and it is passed
//! here from Secrets Manager and dropped after the call.

use std::fmt;

use hmac::{Hmac, Mac};
use reqwest::Method;
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;
use time::{Duration, OffsetDateTime};

use crate::github_api::BoxFuture;
use crate::outbound::{Outbound, OutboundError};

/// How far a request's signed timestamp may be from our clock, as Slack recommends.
pub const WINDOW: Duration = Duration::minutes(5);

/// The bot's only scopes: post, and list channels to choose one.
pub const SCOPES: &str = "chat:write,channels:read";

/// Most pages of channels read (200 each).
const MAX_PAGES: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SlackRequestError {
    #[error("signature missing or wrong")]
    BadSignature,
    #[error("outside the replay window")]
    Stale,
    #[error("not a readable request")]
    Malformed,
}

#[derive(Debug, thiserror::Error)]
pub enum SlackError {
    #[error("Slack refused: {0}")]
    Refused(String),
    #[error("Slack answered {0}")]
    Status(u16),
    #[error("unreadable answer from Slack")]
    Unreadable,
    #[error("{0}")]
    Outbound(#[from] OutboundError),
}

impl From<reqwest::Error> for SlackError {
    fn from(e: reqwest::Error) -> Self {
        SlackError::Outbound(OutboundError::Http(e))
    }
}

/// A Slack id (team `T…`, channel `C…`): upper-case letters and digits.
fn slack_id(raw: &str) -> bool {
    (1..=32).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TeamId(String);

impl TeamId {
    pub fn new(raw: &str) -> Option<Self> {
        slack_id(raw).then(|| Self(raw.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ChannelId(String);

impl ChannelId {
    pub fn new(raw: &str) -> Option<Self> {
        slack_id(raw).then(|| Self(raw.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A tenant's bot token, read from Secrets Manager for one call.
#[derive(Clone, PartialEq, Eq)]
pub struct BotToken(String);

impl BotToken {
    pub fn new(raw: impl Into<String>) -> Option<Self> {
        let t = raw.into();
        (t.starts_with("xoxb-") && t.len() <= 512 && t.bytes().all(|b| b.is_ascii_graphic())).then_some(Self(t))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for BotToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BotToken(<hidden>)")
    }
}

/// The signing secret of our Slack app, from config.
#[derive(Clone)]
pub struct SigningSecret(Vec<u8>);

impl SigningSecret {
    pub fn new(secret: impl Into<Vec<u8>>) -> Option<Self> {
        let s = secret.into();
        (s.len() >= 16).then_some(Self(s))
    }
}

impl fmt::Debug for SigningSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SigningSecret(<hidden>)")
    }
}

/// Checks `X-Slack-Signature` (`v0=<hex>` of `v0:<timestamp>:<body>`) in constant time, and that
/// `X-Slack-Request-Timestamp` is within [`WINDOW`] of `now`.
pub fn verify(
    secret: &SigningSecret,
    timestamp: Option<&str>,
    signature: Option<&str>,
    body: &[u8],
    now: OffsetDateTime,
) -> Result<(), SlackRequestError> {
    let ts = timestamp.ok_or(SlackRequestError::BadSignature)?;
    let at: i64 = ts.parse().map_err(|_| SlackRequestError::BadSignature)?;
    let hex = signature
        .and_then(|s| s.strip_prefix("v0="))
        .filter(|h| h.len() == 64)
        .ok_or(SlackRequestError::BadSignature)?;
    let mut sig = [0u8; 32];
    for (i, byte) in sig.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(2 * i..2 * i + 2).ok_or(SlackRequestError::BadSignature)?, 16)
            .map_err(|_| SlackRequestError::BadSignature)?;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(&secret.0).map_err(|_| SlackRequestError::BadSignature)?;
    mac.update(format!("v0:{ts}:").as_bytes());
    mac.update(body);
    mac.verify_slice(&sig).map_err(|_| SlackRequestError::BadSignature)?;
    if (now.unix_timestamp() - at).abs() > WINDOW.whole_seconds() {
        return Err(SlackRequestError::Stale);
    }
    Ok(())
}

/// What a verified Events API request asks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlackEvent {
    /// Slack checking the endpoint: answer with the challenge.
    Challenge(String),
    /// The app was uninstalled from the team or its tokens revoked: forget the team.
    Uninstalled(TeamId),
    /// Anything else: acknowledged and dropped.
    Other,
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(rename = "type")]
    kind: String,
    challenge: Option<String>,
    team_id: Option<String>,
    event: Option<Inner>,
}

#[derive(Deserialize)]
struct Inner {
    #[serde(rename = "type")]
    kind: String,
}

/// The event in a verified request. Call only after [`verify`].
pub fn event(body: &[u8]) -> Result<SlackEvent, SlackRequestError> {
    let e: Envelope = serde_json::from_slice(body).map_err(|_| SlackRequestError::Malformed)?;
    match e.kind.as_str() {
        "url_verification" => {
            let c = e
                .challenge
                .filter(|c| (1..=200).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_alphanumeric()));
            c.map(SlackEvent::Challenge).ok_or(SlackRequestError::Malformed)
        }
        "event_callback" => match e.event.map(|i| i.kind).as_deref() {
            Some("app_uninstalled" | "tokens_revoked") => e
                .team_id
                .as_deref()
                .and_then(TeamId::new)
                .map(SlackEvent::Uninstalled)
                .ok_or(SlackRequestError::Malformed),
            _ => Ok(SlackEvent::Other),
        },
        _ => Ok(SlackEvent::Other),
    }
}

/// Text as Slack shows it, never as markup: `&`, `<` and `>` are Slack's control characters, so
/// escaped an update cannot mention `@channel`, a user or a link of its own.
pub fn plain(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Channel {
    pub id: ChannelId,
    pub name: String,
    /// Whether the bot is in the channel. `chat:write` posts only where it is, so a channel it is
    /// not in cannot be linked.
    pub is_member: bool,
}

/// What the service asks Slack. A trait so tests use a fake.
pub trait Slack: Send + Sync + 'static {
    /// Where an admin installs the app into their workspace, carrying the signed install state.
    fn authorize_url(&self, state: &str) -> String;
    /// The team and bot token a one-time OAuth `code` grants.
    fn exchange<'a>(&'a self, code: &'a str) -> BoxFuture<'a, Result<(TeamId, BotToken), SlackError>>;
    /// The workspace's public channels.
    fn channels<'a>(&'a self, token: &'a BotToken) -> BoxFuture<'a, Result<Vec<Channel>, SlackError>>;
    /// Posts `text` to the channel as plain text.
    fn post<'a>(
        &'a self,
        token: &'a BotToken,
        channel: &'a ChannelId,
        text: &'a str,
    ) -> BoxFuture<'a, Result<(), SlackError>>;
}

/// Our Slack app, from config.
pub struct SlackApp {
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    http: Outbound,
}

impl fmt::Debug for SlackApp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SlackApp")
            .field("client_id", &self.client_id)
            .finish_non_exhaustive()
    }
}

impl SlackApp {
    /// `redirect_uri` is the web app's page that hands the code and state to the API.
    pub fn new(client_id: &str, client_secret: &str, redirect_uri: &str, http: Outbound) -> Option<Self> {
        if client_id.is_empty() || client_secret.is_empty() || !redirect_uri.starts_with("https://") {
            return None;
        }
        Some(Self {
            client_id: client_id.to_owned(),
            client_secret: client_secret.to_owned(),
            redirect_uri: redirect_uri.to_owned(),
            http,
        })
    }

    /// For posting with a tenant's bot token only, as the poster does: it holds no OAuth
    /// credentials, so its code exchange is always refused.
    pub fn for_posting(http: Outbound) -> Self {
        Self {
            client_id: String::new(),
            client_secret: String::new(),
            redirect_uri: String::new(),
            http,
        }
    }

    fn api(&self, method: Method, name: &str) -> Result<reqwest::RequestBuilder, SlackError> {
        Ok(self.http.request(method, &format!("https://slack.com/api/{name}"))?)
    }
}

/// Slack's Web API answers 200 with `ok: false` and an error code when it refuses.
async fn ok_json<T: serde::de::DeserializeOwned>(resp: reqwest::Response) -> Result<T, SlackError> {
    if !resp.status().is_success() {
        return Err(SlackError::Status(resp.status().as_u16()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|_| SlackError::Unreadable)?;
    if v["ok"] != json!(true) {
        let code = v["error"].as_str().unwrap_or("unknown");
        // Slack's error codes are short snake_case words; anything else is not logged.
        let code = if code.len() <= 64 && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            code
        } else {
            "unknown"
        };
        return Err(SlackError::Refused(code.to_owned()));
    }
    serde_json::from_value(v).map_err(|_| SlackError::Unreadable)
}

impl Slack for SlackApp {
    fn authorize_url(&self, state: &str) -> String {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", &self.client_id)
            .append_pair("scope", SCOPES)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("state", state)
            .finish();
        format!("https://slack.com/oauth/v2/authorize?{query}")
    }

    fn exchange<'a>(&'a self, code: &'a str) -> BoxFuture<'a, Result<(TeamId, BotToken), SlackError>> {
        Box::pin(async move {
            if self.client_id.is_empty() {
                return Err(SlackError::Refused("no_oauth_credentials".into()));
            }
            #[derive(Deserialize)]
            struct Access {
                access_token: String,
                token_type: String,
                team: Team,
            }
            #[derive(Deserialize)]
            struct Team {
                id: String,
            }
            let resp = self
                .api(Method::POST, "oauth.v2.access")?
                .basic_auth(&self.client_id, Some(&self.client_secret))
                .form(&[("code", code), ("redirect_uri", self.redirect_uri.as_str())])
                .send()
                .await?;
            let a: Access = ok_json(resp).await?;
            let team = TeamId::new(&a.team.id).ok_or(SlackError::Unreadable)?;
            let token = (a.token_type == "bot")
                .then(|| BotToken::new(a.access_token))
                .flatten()
                .ok_or(SlackError::Unreadable)?;
            Ok((team, token))
        })
    }

    fn channels<'a>(&'a self, token: &'a BotToken) -> BoxFuture<'a, Result<Vec<Channel>, SlackError>> {
        Box::pin(async move {
            #[derive(Deserialize)]
            struct Page {
                channels: Vec<Raw>,
                response_metadata: Option<Meta>,
            }
            #[derive(Deserialize)]
            struct Raw {
                id: String,
                name: String,
                // Absent reads as not a member, so such a channel is never linked.
                #[serde(default)]
                is_member: bool,
            }
            #[derive(Deserialize)]
            struct Meta {
                next_cursor: Option<String>,
            }
            let mut out = Vec::new();
            let mut cursor = String::new();
            for _ in 0..MAX_PAGES {
                let resp = self
                    .api(Method::GET, "conversations.list")?
                    .bearer_auth(token.expose())
                    .query(&[
                        ("types", "public_channel"),
                        ("exclude_archived", "true"),
                        ("limit", "200"),
                        ("cursor", cursor.as_str()),
                    ])
                    .send()
                    .await?;
                let p: Page = ok_json(resp).await?;
                out.extend(p.channels.into_iter().filter_map(|c| {
                    Some(Channel {
                        id: ChannelId::new(&c.id)?,
                        name: c.name.chars().take(80).collect(),
                        is_member: c.is_member,
                    })
                }));
                cursor = p.response_metadata.and_then(|m| m.next_cursor).unwrap_or_default();
                if cursor.is_empty() {
                    break;
                }
            }
            Ok(out)
        })
    }

    fn post<'a>(
        &'a self,
        token: &'a BotToken,
        channel: &'a ChannelId,
        text: &'a str,
    ) -> BoxFuture<'a, Result<(), SlackError>> {
        Box::pin(async move {
            let resp = self
                .api(Method::POST, "chat.postMessage")?
                .bearer_auth(token.expose())
                .json(&json!({
                    "channel": channel.as_str(),
                    "text": plain(text),
                    "unfurl_links": false,
                    "unfurl_media": false,
                }))
                .send()
                .await?;
            ok_json::<serde_json::Value>(resp).await.map(|_| ())
        })
    }
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    const NOW: OffsetDateTime = datetime!(2026-11-05 18:00 UTC);

    fn secret() -> SigningSecret {
        SigningSecret::new("8f742231b10e8888abcd99yyyzzz85a5").unwrap()
    }

    fn sign(ts: &str, body: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&secret().0).unwrap();
        mac.update(format!("v0:{ts}:").as_bytes());
        mac.update(body);
        let hex: String = mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect();
        format!("v0={hex}")
    }

    #[test]
    fn a_request_is_slacks_only_if_signed_and_recent() {
        let body = br#"{"type":"event_callback","team_id":"T061EG9R6","event":{"type":"app_uninstalled"}}"#;
        let ts = NOW.unix_timestamp().to_string();
        let sig = sign(&ts, body);
        assert_eq!(verify(&secret(), Some(&ts), Some(&sig), body, NOW), Ok(()));
        let other = SigningSecret::new("x".repeat(32)).unwrap();
        assert_eq!(
            verify(&other, Some(&ts), Some(&sig), body, NOW),
            Err(SlackRequestError::BadSignature)
        );
        // The timestamp is signed: changing it breaks the signature, keeping it ages the request.
        let later = (NOW.unix_timestamp() + 1).to_string();
        assert_eq!(
            verify(&secret(), Some(&later), Some(&sig), body, NOW),
            Err(SlackRequestError::BadSignature)
        );
        assert_eq!(
            verify(&secret(), Some(&ts), Some(&sig), body, NOW + Duration::minutes(6)),
            Err(SlackRequestError::Stale)
        );
        for (t, s) in [
            (None, Some(sig.as_str())),
            (Some(ts.as_str()), None),
            (Some("soon"), Some(sig.as_str())),
        ] {
            assert_eq!(verify(&secret(), t, s, body, NOW), Err(SlackRequestError::BadSignature));
        }
        assert_eq!(format!("{:?}", secret()), "SigningSecret(<hidden>)");
    }

    #[test]
    fn only_a_challenge_or_an_uninstall_is_acted_on() {
        assert_eq!(
            event(br#"{"type":"url_verification","challenge":"3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P"}"#),
            Ok(SlackEvent::Challenge(
                "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P".into()
            ))
        );
        for kind in ["app_uninstalled", "tokens_revoked"] {
            let b = format!(r#"{{"type":"event_callback","team_id":"T061EG9R6","event":{{"type":"{kind}"}}}}"#);
            assert_eq!(
                event(b.as_bytes()),
                Ok(SlackEvent::Uninstalled(TeamId::new("T061EG9R6").unwrap()))
            );
        }
        assert_eq!(
            event(br#"{"type":"event_callback","team_id":"T1","event":{"type":"message"}}"#),
            Ok(SlackEvent::Other)
        );
        for bad in [
            &br#"{"type":"url_verification","challenge":"<script>"}"#[..],
            br#"{"type":"event_callback","team_id":"t lower","event":{"type":"app_uninstalled"}}"#,
            br#"{"type":"event_callback","event":{"type":"tokens_revoked"}}"#,
            b"nope",
        ] {
            assert_eq!(event(bad), Err(SlackRequestError::Malformed));
        }
    }

    #[test]
    fn posted_text_is_shown_as_written_and_ids_and_tokens_are_checked() {
        assert_eq!(
            plain("Done <!channel> & <@U123|bob> <https://evil.example|here>"),
            "Done &lt;!channel&gt; &amp; &lt;@U123|bob&gt; &lt;https://evil.example|here&gt;"
        );
        assert!(TeamId::new("T061EG9R6").is_some() && ChannelId::new("C0123ABC").is_some());
        for bad in ["", "c0123", "C01 23", "C01;23", &"C".repeat(33)] {
            assert!(ChannelId::new(bad).is_none(), "{bad}");
        }
        assert!(BotToken::new("xoxb-123-abc").is_some());
        for bad in ["xoxp-123", "xoxb-1 2", ""] {
            assert!(BotToken::new(bad).is_none(), "{bad}");
        }
        assert_eq!(format!("{:?}", BotToken::new("xoxb-1").unwrap()), "BotToken(<hidden>)");
        let app = SlackApp::new(
            "123.456",
            "s3cret",
            "https://app.oryxa.example/integrations/slack",
            Outbound::new().unwrap(),
        )
        .unwrap();
        let url = app.authorize_url("st.1");
        assert_eq!(
            url,
            "https://slack.com/oauth/v2/authorize?client_id=123.456&scope=chat%3Awrite%2Cchannels%3Aread\
             &redirect_uri=https%3A%2F%2Fapp.oryxa.example%2Fintegrations%2Fslack&state=st.1"
        );
        assert!(!format!("{app:?}").contains("s3cret"));
        assert!(SlackApp::new("1", "s", "http://insecure.example", Outbound::new().unwrap()).is_none());
    }
}
