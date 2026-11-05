//! The weekly digest. Once an FDE approves a project's update, it is emailed to the company's
//! sponsors through SES. The mail is plain text from a fixed template, so it has no images and no
//! tracking pixels. It carries an unsubscribe link, in the body and in `List-Unsubscribe`.
//!
//! Each mail is claimed in the store before it is sent. A sponsor gets each update once, from
//! whichever copy of the service claims it. A send that fails is tried again after the claim's hold,
//! up to [`DIGEST_ATTEMPTS`](oryxa_fde_store::DIGEST_ATTEMPTS) times.
//!
//! The address is customer data: it goes to SES and nowhere else. Logs name the stakeholder by id,
//! and an SES error is logged by its code only, since its message can quote the address.

use std::time::Duration as StdDuration;

use aws_sdk_sesv2::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_sesv2::types::{Body, Content, Destination, EmailContent, Message, MessageHeader};
use oryxa_fde_core::ProjectScope;
use oryxa_fde_store::{DigestClaim, DueDigest, EmailAddress, Store};
use time::OffsetDateTime;
use url::Url;

use crate::{BoxFuture, LifecycleError};

/// How long one send may take before it counts as failed.
const SEND_TIMEOUT: StdDuration = StdDuration::from_secs(30);

/// One mail, ready to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mail {
    pub to: EmailAddress,
    pub subject: String,
    pub text: String,
    /// The page that unsubscribes the recipient, for `List-Unsubscribe`.
    pub unsubscribe: String,
}

/// Sends a mail. A trait so tests use a fake.
pub trait Mailer: Send + Sync + 'static {
    fn send<'a>(&'a self, mail: &'a Mail) -> BoxFuture<'a, Result<(), LifecycleError>>;
}

/// Amazon SES v2, from a verified identity.
pub struct SesMailer {
    client: aws_sdk_sesv2::Client,
    from: String,
}

impl SesMailer {
    pub fn new(client: aws_sdk_sesv2::Client, from: impl Into<String>) -> Self {
        Self {
            client,
            from: from.into(),
        }
    }
}

fn content(data: &str) -> Result<Content, LifecycleError> {
    Content::builder()
        .data(data)
        .charset("UTF-8")
        .build()
        .map_err(|_| LifecycleError::Mail("content".into()))
}

/// What a failed send is logged as: its kind or SES's error code, never its message.
fn send_error<E: ProvideErrorMetadata, R>(e: &SdkError<E, R>) -> LifecycleError {
    let what = match e {
        SdkError::ServiceError(_) => e.code().unwrap_or("service error"),
        SdkError::TimeoutError(_) => "timed out",
        SdkError::DispatchFailure(_) => "not delivered to SES",
        SdkError::ResponseError(_) => "unreadable response",
        _ => "not built",
    };
    LifecycleError::Mail(what.to_owned())
}

impl Mailer for SesMailer {
    fn send<'a>(&'a self, mail: &'a Mail) -> BoxFuture<'a, Result<(), LifecycleError>> {
        Box::pin(async move {
            let header = MessageHeader::builder()
                .name("List-Unsubscribe")
                .value(format!("<{}>", mail.unsubscribe))
                .build()
                .map_err(|_| LifecycleError::Mail("header".into()))?;
            let message = Message::builder()
                .subject(content(&mail.subject)?)
                .body(Body::builder().text(content(&mail.text)?).build())
                .headers(header)
                .build();
            self.client
                .send_email()
                .from_email_address(&self.from)
                .destination(Destination::builder().to_addresses(mail.to.as_str()).build())
                .content(EmailContent::builder().simple(message).build())
                .send()
                .await
                .map_err(|e| send_error(&e))?;
            Ok(())
        })
    }
}

/// Where the unsubscribe page is: the web app's origin, `https` or a local `http` one.
#[derive(Debug, Clone)]
pub struct DigestConfig {
    web_origin: String,
}

impl DigestConfig {
    pub fn new(web_origin: &str) -> Result<Self, LifecycleError> {
        let bad = || LifecycleError::Config("WEB_ORIGIN must be an origin, e.g. https://app.example.com");
        let url = Url::parse(web_origin).map_err(|_| bad())?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
        let ok = (url.scheme() == "https" || (url.scheme() == "http" && local))
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none();
        if !ok {
            return Err(bad());
        }
        Ok(Self {
            web_origin: url.origin().ascii_serialization(),
        })
    }

    /// The token goes in the fragment, which browsers never send to a server or in a referrer:
    /// the page posts it to the API.
    fn unsubscribe_url(&self, claim: &DigestClaim) -> String {
        format!("{}/unsubscribe#{}", self.web_origin, claim.unsubscribe)
    }
}

/// The mail of one update to one sponsor.
pub fn compose(due: &DueDigest, claim: &DigestClaim, cfg: &DigestConfig) -> Mail {
    let week = format!("{} {} {}", due.week.day(), due.week.month(), due.week.year());
    let project = due.project.as_str();
    let unsubscribe = cfg.unsubscribe_url(claim);
    let text = format!(
        "Hi {name},\n\n\
         Here is the update on {project} for the week of {week}.\n\n\
         {body}\n\n\
         --\n\
         You get this because you sponsor {project}. To stop these emails, open {unsubscribe}\n",
        name = claim.name.as_str(),
        body = due.body.as_str(),
    );
    Mail {
        to: claim.email.clone(),
        subject: format!("{project}: update for the week of {week}"),
        text,
        unsubscribe,
    }
}

/// Sends one project's newest approved update to each sponsor still to get it; returns how many
/// mails went.
pub async fn send_project(
    store: &Store,
    mailer: &dyn Mailer,
    cfg: &DigestConfig,
    scope: &ProjectScope,
    now: OffsetDateTime,
) -> Result<usize, LifecycleError> {
    let mut tx = store.project(scope).await?;
    let due = tx.due_digest(now).await?;
    tx.commit().await?;
    let Some(due) = due else { return Ok(0) };
    let mut sent = 0;
    for stakeholder in &due.recipients {
        let mut tx = store.project(scope).await?;
        let claim = tx.claim_digest(due.week, stakeholder).await?;
        tx.commit().await?;
        let Some(claim) = claim else { continue };
        let mail = compose(&due, &claim, cfg);
        let result = tokio::time::timeout(SEND_TIMEOUT, mailer.send(&mail))
            .await
            .unwrap_or_else(|_| Err(LifecycleError::Mail("timed out".into())));
        match result {
            Ok(()) => {
                // ponytail: a mail SES accepted whose mark is then lost (or that timed out here
                // after SES took it) is sent again once the claim's hold ends, up to the tries.
                let mut tx = store.project(scope).await?;
                tx.digest_sent(due.week, stakeholder).await?;
                tx.commit().await?;
                sent += 1;
            }
            Err(e) => {
                tracing::warn!(project = %scope.project, stakeholder = %stakeholder, error = %e, "digest mail not sent")
            }
        }
    }
    Ok(sent)
}

/// Sends every project's due digest; returns how many mails went. One project's failure is
/// logged and the rest still go.
pub async fn send_due(
    store: &Store,
    mailer: &dyn Mailer,
    cfg: &DigestConfig,
    now: OffsetDateTime,
) -> Result<usize, LifecycleError> {
    let mut sent = 0;
    for scope in store.projects_for_weekly_updates().await? {
        match send_project(store, mailer, cfg, &scope, now).await {
            Ok(n) => sent += n,
            Err(e) => tracing::warn!(project = %scope.project, error = %e, "digest not sent"),
        }
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use oryxa_core::TenantId;
    use oryxa_fde_core::{CompanyId, CompanyScope, ProjectId, StakeholderId};
    use oryxa_fde_store::{Name, UnsubscribeToken, UpdateBody};
    use time::macros::date;

    use super::*;

    fn claim() -> DigestClaim {
        let token = format!("org_1.cmp_1.prj_1.2026-11-02.stk_1.{}", "ab".repeat(32));
        DigestClaim {
            name: Name::new("Sam Sponsor").unwrap(),
            email: EmailAddress::new("sam@acme.example").unwrap(),
            unsubscribe: UnsubscribeToken::parse(&token).unwrap(),
        }
    }

    fn due(body: &str) -> DueDigest {
        DueDigest {
            project: Name::new("Support RAG").unwrap(),
            week: date!(2026 - 11 - 02),
            body: UpdateBody::new(body).unwrap(),
            recipients: vec![StakeholderId::new("stk_1").unwrap()],
        }
    }

    #[test]
    fn a_digest_is_plain_text_with_its_unsubscribe_link() {
        let cfg = DigestConfig::new("https://app.oryxa.example").unwrap();
        let body = "Done this week:\n- Indexed tickets <img src=\"https://evil.example/p.gif\">";
        let mail = compose(&due(body), &claim(), &cfg);
        assert_eq!(mail.to.as_str(), "sam@acme.example");
        assert_eq!(mail.subject, "Support RAG: update for the week of 2 November 2026");
        let link = format!(
            "https://app.oryxa.example/unsubscribe#org_1.cmp_1.prj_1.2026-11-02.stk_1.{}",
            "ab".repeat(32)
        );
        assert_eq!(mail.unsubscribe, link);
        assert!(mail.text.starts_with("Hi Sam Sponsor,\n"));
        // The update is quoted as text: sent as text/plain, markup in it is never rendered.
        assert!(mail.text.contains(body));
        assert!(mail.text.ends_with(&format!("open {link}\n")));
    }

    #[test]
    fn the_unsubscribe_page_is_on_an_https_origin() {
        let scope = CompanyScope::new(TenantId::new("org_1").unwrap(), CompanyId::new("cmp_1").unwrap())
            .project(ProjectId::new("prj_1").unwrap());
        assert_eq!(claim().unsubscribe.scope, scope);
        for ok in [
            "https://app.oryxa.example",
            "https://app.oryxa.example/",
            "http://localhost:5173",
        ] {
            assert!(DigestConfig::new(ok).is_ok(), "{ok}");
        }
        assert_eq!(
            DigestConfig::new("https://app.oryxa.example/").unwrap().web_origin,
            "https://app.oryxa.example"
        );
        for bad in [
            "",
            "app.oryxa.example",
            "http://app.oryxa.example",
            "https://app.oryxa.example/path",
            "https://app.oryxa.example/?x=1",
            "https://app.oryxa.example/#x",
            "https://user:pw@app.oryxa.example",
            "javascript:alert(1)",
        ] {
            assert!(DigestConfig::new(bad).is_err(), "{bad}");
        }
    }
}
