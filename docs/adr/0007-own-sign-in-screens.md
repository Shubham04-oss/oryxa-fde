# 0007: Our own sign-in screens

Status: accepted, 11 November 2026. Amends how ADR 0002's tenant sign-in is presented; the identity
provider and the token checks do not change.

## Context
Sign-in sent the browser to WorkOS's hosted page and back. The founder wants every screen a person
sees to be ours, and no visible dependency on a third party in the sign-in path. Replacing the
identity provider itself would mean storing passwords, sending verification mail, MFA and enterprise
SSO, and a change to the platform base, whose token checks the whole product rests on.

## Decision
- **Every sign-in screen is ours,** served by `fde-web` on the product's own host: sign in, sign up
  from an invite, email verification, forgotten and reset password, choose an organisation, and the
  "you are not in an organisation yet" outcome. No person is sent to a WorkOS page.
- **WorkOS stays behind the API as the engine.** It stores credentials, verifies email, runs social
  sign-in and, later, a customer's SSO. The API calls its user-management endpoints at
  `api.workos.com`, the only host on its outbound allowlist for sign-in; the browser never does, and
  no WorkOS key or client secret reaches the browser.
- **Methods, in order:** email and password, an emailed one-time code, Google. Google and a
  customer's SSO still leave our host for the provider's own page (that cannot be avoided), never
  for WorkOS's hosted page, and come back to `/auth/callback` with PKCE and state as today. From
  there they take the same pending steps as the other methods, because WorkOS can answer any method
  with "verify your email" or "choose an organisation".
- **WorkOS is set to match,** in every environment. Sign-up is off except with an invitation.
  Adding members by verified email domain and SSO just-in-time membership are off. The invitation
  and password reset links in WorkOS's mail point at our screens. MFA and Radar challenges stay off
  until we have screens for them. Any answer from WorkOS our screens do not handle (MFA, SSO
  required by a domain policy, a Radar challenge) ends the sign-in with a clear outcome and no
  session.
- **Sessions do not change.** A successful sign-in by any method ends in the same sealed
  `__Host-` session cookie holding WorkOS's tokens, verified by `oryxa-authn` with the issuer
  pinned. The session rules, refresh and sign-out stay as they are.
- **The password passes through the API and is never kept.** It is forwarded to WorkOS over TLS and
  is never logged, stored, put in an event or a cookie, or returned. Request bodies of the sign-in
  routes are excluded from any logging, in the API and in the Worker. Logs of these routes carry
  ids, never an email address.
- **The new routes are unauthenticated, so they are guarded:**
  - one answer for "wrong password" and "no such account", and for "code sent" or "reset sent"
    whether or not the address exists, so nobody can list accounts. A limit reached answers the
    same for an unknown address as for a known one;
  - a limit per address and per client on password attempts, code guesses, codes sent and resets,
    and a ceiling across all of them, so a flood cannot use up the WorkOS limits that every
    session's refresh shares. A limit slows guessing for a short window and does not lock the
    account. Counters hold a keyed hash of the lowercased address, never the address. The client is
    the address the Worker forwards from Cloudflare, never one the browser sets, and it goes to
    WorkOS with the user agent on each attempt. A counter that cannot be read or written refuses
    the attempt;
  - the same origin check as every cookie route, on each of these routes whether or not a cookie
    is present, so another site cannot sign a browser in to an account of its choosing;
  - a pending step (verification, organisation choice) travels in a short-lived sealed `__Host-`
    cookie, the way the sign-in cookie carries PKCE today. It names its step, holds WorkOS's
    pending token and the organisations offered, never the password, and is cleared when the step
    ends or fails. The organisation chosen must be one of those offered;
  - a completed sign-in always sets a new session cookie and clears the pending one; nothing the
    browser brought with it becomes the session;
  - an invitation or reset token from a link reaches the API in a request body, is never logged,
    and the page that reads it sends no `Referer`;
  - `return_to` stays a local path.
- **Membership still decides.** A person signs in only as an active member of an organisation with
  role `admin` or `member` (or a customer role, ADR 0005). Signing up without an invite is off, and
  a WorkOS user with no organisation gets the clear outcome, never a session. An invitation is
  accepted only at the address it was sent to: the API reads the address from the invitation, never
  from the request, although WorkOS itself would let another address on the same company domain
  accept it.
- **Leaving WorkOS later stays possible.** The API reaches it through one small trait (today's
  `AuthKit`, widened). Our screens and routes do not carry WorkOS names or shapes, so a different
  engine would replace the trait's implementation and the token verifier, not the screens.

## Consequences
- The API gains sign-in routes and the web gains the screens. `/auth/login` no longer goes to
  WorkOS's hosted page; a redirect remains only for Google and SSO, straight to the provider.
- Brute-force and enumeration defence for these routes is now ours to get right and to test.
- The lead keeps the WorkOS settings above in each environment, and a change to them is reviewed
  like a change to this ADR.
- WorkOS's password policy, verification mail and code expiry still apply; the mail's wording and
  sender are set in WorkOS until we send it ourselves. In staging the mail comes from a WorkOS
  domain and Google shows WorkOS's name; production needs our own Google client and a custom email
  domain before no WorkOS name is visible.
- MFA, passkeys and SSO set-up screens are not built yet.
