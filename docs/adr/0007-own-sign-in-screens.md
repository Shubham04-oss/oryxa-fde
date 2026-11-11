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
  sign-in and, later, a customer's SSO. The API calls its user-management endpoints; the browser
  never does, and no WorkOS key or client secret reaches the browser.
- **Methods, in order:** email and password, an emailed one-time code, Google. Google and a
  customer's SSO still leave our host for the provider's own page (that cannot be avoided) and come
  back to `/auth/callback` with PKCE and state as today.
- **Sessions do not change.** A successful sign-in by any method ends in the same sealed
  `__Host-` session cookie holding WorkOS's tokens, verified by `oryxa-authn` with the issuer
  pinned. The session rules, refresh and sign-out stay as they are.
- **The password passes through the API and is never kept.** It is forwarded to WorkOS over TLS and
  is never logged, stored, put in an event or returned. Request bodies of the sign-in routes are
  excluded from any logging.
- **The new routes are unauthenticated, so they are guarded:**
  - one answer for "wrong password" and "no such account", and for "code sent" whether or not the
    address exists, so nobody can list accounts;
  - a limit per address and per client on attempts, codes and resets, failing closed;
  - the same origin check as every cookie route, and a short-lived sealed cookie carrying a pending
    step (verification, organisation choice) the way the sign-in cookie carries PKCE today;
  - `return_to` stays a local path.
- **Membership still decides.** A person signs in only as an active member of an organisation with
  role `admin` or `member` (or a customer role, ADR 0005). Signing up without an invite creates no
  access.
- **Leaving WorkOS later stays possible.** The API reaches it through one small trait (today's
  `AuthKit`, widened). Our screens and routes do not carry WorkOS names or shapes, so a different
  engine would replace the trait's implementation and the token verifier, not the screens.

## Consequences
- The API gains sign-in routes and the web gains the screens; the hosted redirect remains only for
  Google and SSO.
- Brute-force and enumeration defence for these routes is now ours to get right and to test.
- WorkOS's password policy, verification mail and code expiry still apply; the mail's wording and
  sender are set in WorkOS until we send it ourselves.
- MFA, passkeys and SSO set-up screens are not built yet.
