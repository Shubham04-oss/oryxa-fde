//! The project's repository in the sandbox: a fresh checkout before a run, and at its end a branch with the
//! agent's work and a draft pull request. Both run inside the sandbox as `agent`, so the gateway's outbound handler
//! adds the GitHub token for `github.com` and `api.github.com` by reference: neither the API nor the sandbox holds it.

use std::collections::BTreeMap;
use std::time::Duration;

use oryxa_fde_core::AgentRunId;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::gateway::{Exec, ExecOutput};

/// Where the run's checkout lives; the agent works in `/workspace`.
pub const REPO_DIR: &str = "/workspace/repo";
const GIT_TIMEOUT: Duration = Duration::from_secs(300);
const TITLE_CHARS: usize = 72;

/// A GitHub repository and the branch a run starts from. Every part reaches a command line, so each is checked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(try_from = "RepositoryIn")]
pub struct Repository {
    pub owner: String,
    pub name: String,
    pub base: String,
}

#[derive(Deserialize)]
struct RepositoryIn {
    owner: String,
    name: String,
    base: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("invalid repository {0}")]
pub struct RepositoryError(pub &'static str);

impl TryFrom<RepositoryIn> for Repository {
    type Error = RepositoryError;
    fn try_from(r: RepositoryIn) -> Result<Self, RepositoryError> {
        Repository::new(r.owner, r.name, r.base)
    }
}

impl Repository {
    pub fn new(owner: String, name: String, base: String) -> Result<Self, RepositoryError> {
        let owner_ok = (1..=39).contains(&owner.len())
            && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !owner.starts_with('-')
            && !owner.ends_with('-');
        if !owner_ok {
            return Err(RepositoryError("owner"));
        }
        let name_ok = (1..=100).contains(&name.len())
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
            && !name.starts_with(['-', '.']);
        if !name_ok {
            return Err(RepositoryError("name"));
        }
        if !branch_ok(&base) {
            return Err(RepositoryError("base"));
        }
        Ok(Self { owner, name, base })
    }

    fn clone_url(&self) -> String {
        format!("https://github.com/{}/{}.git", self.owner, self.name)
    }
}

/// A branch name git accepts that cannot be read as an option or a path outside `refs/heads`.
fn branch_ok(branch: &str) -> bool {
    (1..=200).contains(&branch.len())
        && branch
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
        && !branch.starts_with(['-', '/', '.'])
        && !branch.ends_with(['/', '.'])
        && !branch.ends_with(".lock")
        && !branch.contains("..")
        && !branch.contains("//")
        && !branch.contains("/.")
}

/// The pull request a run opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PullRequest {
    pub number: u64,
    pub url: String,
}

/// What became of a finished run's work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Delivery {
    /// The run ended before there was anything to deliver.
    None,
    /// The agent changed nothing.
    NoChanges,
    PullRequest(PullRequest),
    /// The branch or the pull request could not be made.
    Failed,
}

/// The branch a run's work goes to.
pub fn branch(run: &AgentRunId) -> String {
    format!("fde-agent/{run}")
}

fn exec(argv: Vec<String>) -> Exec {
    Exec {
        argv,
        env: BTreeMap::new(),
        timeout: GIT_TIMEOUT,
    }
}

// Hooks and fsmonitor in the checkout are the agent's to write; our own git commands never run them.
fn git(args: &[&str]) -> Exec {
    let mut argv: Vec<String> = [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        REPO_DIR,
    ]
    .map(String::from)
    .into();
    argv.extend(args.iter().map(|a| (*a).to_owned()));
    exec(argv)
}

/// A fresh checkout of the base branch, so no run sees another's leftovers.
pub fn prepare(repo: &Repository) -> Vec<Exec> {
    vec![
        exec(["rm", "-rf", "--", REPO_DIR].map(String::from).into()),
        exec(
            [
                "git",
                "clone",
                "--quiet",
                "--depth",
                "50",
                "--branch",
                &repo.base,
                "--",
                &repo.clone_url(),
                REPO_DIR,
            ]
            .map(String::from)
            .into(),
        ),
    ]
}

/// The steps that put a finished run's work on its branch, in order. `commit` runs only when `has_staged`
/// reports changes, and `push` only when `ahead` counts commits.
pub struct Deliver {
    pub checkout: Exec,
    pub stage: Exec,
    /// Exit code 1 when there are staged changes, 0 when there are none.
    pub has_staged: Exec,
    pub commit: Exec,
    /// Prints how many commits the branch is ahead of the base.
    pub ahead: Exec,
    pub push: Exec,
    pub pull_request: Exec,
}

pub fn deliver(repo: &Repository, run: &AgentRunId, task: &str) -> Deliver {
    let branch = branch(run);
    let title = title(task);
    let body = format!("Opened by the FDE workspace's coding agent for run `{run}`.\n\nTask:\n\n{task}");
    let request = serde_json::json!({
        "title": title,
        "head": branch,
        "base": repo.base,
        "body": body,
        "draft": true,
    });
    let url = format!("https://api.github.com/repos/{}/{}/pulls", repo.owner, repo.name);
    Deliver {
        checkout: git(&["checkout", "-q", "-B", &branch]),
        stage: git(&["add", "-A"]),
        has_staged: git(&["diff", "--cached", "--quiet"]),
        commit: git(&[
            "-c",
            "user.name=FDE workspace agent",
            "-c",
            "user.email=agent@fde-workspace.invalid",
            "commit",
            "-q",
            "-m",
            &title,
            "-m",
            &format!("Run {run}"),
        ]),
        ahead: git(&["rev-list", "--count", &format!("origin/{}..HEAD", repo.base)]),
        push: git(&["push", "-q", "origin", &format!("HEAD:refs/heads/{branch}")]),
        pull_request: exec(
            [
                "curl",
                "-sS",
                "--max-time",
                "60",
                "-X",
                "POST",
                "-H",
                "accept: application/vnd.github+json",
                "-H",
                "content-type: application/json",
                "--data-binary",
                &request.to_string(),
                "--write-out",
                "\n%{http_code}",
                &url,
            ]
            .map(String::from)
            .into(),
        ),
    }
}

fn title(task: &str) -> String {
    let line = task
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("Agent run");
    if line.chars().count() <= TITLE_CHARS {
        line.to_owned()
    } else {
        let cut: String = line.chars().take(TITLE_CHARS - 1).collect();
        format!("{cut}…")
    }
}

/// How many commits `ahead` printed; anything else is unreadable output.
pub fn commits_ahead(out: &ExecOutput) -> Option<u64> {
    out.ok().then(|| out.stdout.trim().parse().ok()).flatten()
}

#[derive(Deserialize)]
struct Created {
    number: u64,
}

/// The pull request GitHub created, from curl's output (the body, then the status code on its own line). The
/// output passed through the sandbox, so only the number is taken from it and the URL is built here.
pub fn created_pull_request(repo: &Repository, out: &ExecOutput) -> Option<PullRequest> {
    if !out.ok() {
        return None;
    }
    let (body, status) = out.stdout.trim_end().rsplit_once('\n')?;
    if status.trim() != "201" {
        return None;
    }
    let created: Created = serde_json::from_str(body).ok()?;
    Some(PullRequest {
        number: created.number,
        url: format!(
            "https://github.com/{}/{}/pull/{}",
            repo.owner, repo.name, created.number
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> Repository {
        Repository::new("sample-org".into(), "status-page".into(), "main".into()).unwrap()
    }

    fn out(code: i32, stdout: &str) -> ExecOutput {
        ExecOutput {
            exit_code: Some(code),
            stdout: stdout.into(),
            stderr: String::new(),
            timed_out: false,
        }
    }

    #[test]
    fn repositories_that_could_become_options_or_paths_are_refused() {
        let new = |o: &str, n: &str, b: &str| Repository::new(o.into(), n.into(), b.into());
        assert!(new("sample-org", "status.page_2", "release/2026-11").is_ok());
        for (o, n, b, part) in [
            ("-o", "r", "main", "owner"),
            ("a b", "r", "main", "owner"),
            ("o", "../r", "main", "name"),
            ("o", "-r", "main", "name"),
            ("o", ".git", "main", "name"),
            ("o", "r", "--upload-pack=x", "base"),
            ("o", "r", "a..b", "base"),
            ("o", "r", "/etc", "base"),
            ("o", "r", "a//b", "base"),
            ("o", "r", "a/.hidden", "base"),
            ("o", "r", "x.lock", "base"),
            ("o", "r", "a b", "base"),
            ("o", "r", "", "base"),
        ] {
            assert_eq!(new(o, n, b), Err(RepositoryError(part)), "{o} {n} {b}");
        }
        let json = r#"{"owner":"o","name":"r","base":"-x"}"#;
        assert!(serde_json::from_str::<Repository>(json).is_err());
    }

    #[test]
    fn checks_out_a_fresh_copy_of_the_base() {
        let steps = prepare(&repo());
        assert_eq!(steps[0].argv, ["rm", "-rf", "--", REPO_DIR]);
        assert_eq!(
            steps[1].argv,
            [
                "git",
                "clone",
                "--quiet",
                "--depth",
                "50",
                "--branch",
                "main",
                "--",
                "https://github.com/sample-org/status-page.git",
                REPO_DIR
            ]
        );
    }

    #[test]
    fn delivers_to_the_run_branch_without_running_repository_hooks() {
        let run = AgentRunId::new("run_1").unwrap();
        let d = deliver(&repo(), &run, "Add a /healthz endpoint\n\nwith a test");
        for step in [&d.checkout, &d.stage, &d.has_staged, &d.commit, &d.ahead, &d.push] {
            assert_eq!(
                step.argv[..7],
                [
                    "git",
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "core.fsmonitor=false",
                    "-C",
                    REPO_DIR
                ]
            );
        }
        assert_eq!(d.push.argv.last().unwrap(), "HEAD:refs/heads/fde-agent/run_1");
        assert_eq!(d.ahead.argv.last().unwrap(), "origin/main..HEAD");
        let body: serde_json::Value = serde_json::from_str(&d.pull_request.argv[11]).unwrap();
        assert_eq!(body["title"], "Add a /healthz endpoint");
        assert_eq!(body["head"], "fde-agent/run_1");
        assert_eq!(body["base"], "main");
        assert_eq!(body["draft"], true);
        assert_eq!(
            d.pull_request.argv.last().unwrap(),
            "https://api.github.com/repos/sample-org/status-page/pulls"
        );
        // Nothing on the command line names a credential: the gateway adds it.
        assert!(
            !format!("{:?}", d.pull_request.argv)
                .to_lowercase()
                .contains("authorization")
        );
        assert_eq!(title(&"x".repeat(100)).chars().count(), TITLE_CHARS);
    }

    #[test]
    fn reads_only_the_number_from_github_and_builds_the_url() {
        let ok = out(0, "{\"number\":7,\"html_url\":\"https://evil.example/\"}\n201\n");
        assert_eq!(
            created_pull_request(&repo(), &ok),
            Some(PullRequest {
                number: 7,
                url: "https://github.com/sample-org/status-page/pull/7".into()
            })
        );
        for bad in [
            out(0, "{\"message\":\"Validation Failed\"}\n422"),
            out(0, "not json\n201"),
            out(7, "{\"number\":7}\n201"),
            out(0, "201"),
        ] {
            assert_eq!(created_pull_request(&repo(), &bad), None, "{:?}", bad.stdout);
        }
        assert_eq!(commits_ahead(&out(0, "3\n")), Some(3));
        assert_eq!(commits_ahead(&out(128, "")), None);
        assert_eq!(commits_ahead(&out(0, "lots")), None);
    }
}
