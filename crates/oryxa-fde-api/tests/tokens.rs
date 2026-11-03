//! Token verification runs end to end with the workspace's real dependency versions. workos 3.5
//! turns on a second jsonwebtoken crypto backend, and verifying then panics; this test catches a
//! lockfile that resolves to it again (keep workos at 3.4.1, see oryxa-platform#162).

mod support;

use oryxa_fde_api::VerifyToken;

#[tokio::test]
async fn an_authkit_token_verifies_and_a_forged_one_does_not() {
    let v = support::verifier();
    let claims = v
        .claims(&support::token(Some("org_1"), "user_1", "admin"))
        .await
        .unwrap();
    assert_eq!(
        (claims.sub.as_str(), claims.org_id.as_deref(), claims.role.as_deref()),
        ("user_1", Some("org_1"), Some("admin"))
    );

    // Another user's claims under this token's signature.
    let mine = support::token(Some("org_1"), "user_1", "member");
    let theirs = support::token(Some("org_1"), "user_2", "admin");
    let part = |t: &str, i: usize| t.split('.').nth(i).unwrap().to_owned();
    let forged = [part(&mine, 0), part(&theirs, 1), part(&mine, 2)].join(".");
    assert!(v.claims(&forged).await.is_err());
    assert!(v.claims("not.a.jwt").await.is_err());
}
