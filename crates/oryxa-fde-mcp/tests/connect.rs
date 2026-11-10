//! How `oryxa-fde-mcp` reaches the database: IAM tokens when the `DB_*` variables are set (ECS),
//! else `DATABASE_URL` (local runs); a missing or half-set configuration stops startup, and so does
//! a token it cannot get. Each test runs the binary with nothing but the variables it names.

use std::process::{Command, Output};

const PASSWORD: &str = "pw-never-logged";

fn run(vars: &[(&str, &str)]) -> Output {
    let out = Command::new(env!("CARGO_BIN_EXE_oryxa-fde-mcp"))
        .env_clear()
        // No AWS credentials from this machine: no profile files and no instance metadata.
        .env("HOME", "/nonexistent")
        .env("AWS_CONFIG_FILE", "/nonexistent/config")
        .env("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent/credentials")
        .env("AWS_EC2_METADATA_DISABLED", "true")
        .envs(vars.iter().copied())
        .output()
        .expect("run oryxa-fde-mcp");
    assert!(!out.status.success(), "it must not start");
    out
}

fn stderr(out: &Output) -> String {
    let s = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(!s.contains(PASSWORD), "no secret in the output: {s}");
    s
}

const IAM: [(&str, &str); 5] = [
    ("DB_HOST", "fde.cluster-x.eu-west-2.rds.amazonaws.com"),
    ("DB_PORT", "5432"),
    ("DB_NAME", "oryxa_fde"),
    ("DB_USER", "oryxa_fde_api"),
    ("AWS_REGION", "eu-west-2"),
];

#[test]
fn without_a_database_it_names_both_ways_to_reach_one() {
    let err = stderr(&run(&[]));
    assert!(err.contains("DATABASE_URL or DB_HOST"), "{err}");
}

#[test]
fn half_an_iam_configuration_stops_startup() {
    let err = stderr(&run(&[("DB_HOST", IAM[0].1)]));
    assert!(
        err.contains("set all of DB_HOST, DB_PORT, DB_NAME, DB_USER or none"),
        "{err}"
    );
}

#[test]
fn the_db_variables_win_and_no_token_means_no_start() {
    let url = format!("postgres://oryxa_fde_api:{PASSWORD}@localhost:1/oryxa_fde");
    let mut vars = IAM.to_vec();
    vars.push(("DATABASE_URL", &url));
    let err = stderr(&run(&vars));
    assert!(err.contains("AWS credentials"), "{err}");
}

#[test]
fn without_the_db_variables_it_uses_database_url() {
    // `.invalid` never resolves, so the connection fails at once instead of retrying.
    let url = format!("postgres://oryxa_fde_api:{PASSWORD}@db.invalid:5432/oryxa_fde");
    let err = stderr(&run(&[("DATABASE_URL", &url)]));
    assert!(err.contains("Db("), "{err}");
}
