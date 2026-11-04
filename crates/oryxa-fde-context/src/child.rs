//! Extraction in a child process with hard limits (lead decision on #57). The ingest worker runs
//! its own binary as `extract <content-type>`, writes the file to its stdin and reads the text back
//! from its stdout, at most [`MAX_OUTPUT_BYTES`]. Before the child runs it gets limits on CPU time,
//! address space, file size, core dumps and open files, and no environment, so no credentials.
//! The parent kills it at a wall-clock deadline. A child that is killed or fails is a failed
//! document, never a retry: lopdf's load, which nothing in-process can interrupt, is bounded too.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, Instant};

use oryxa_fde_store::ContentType;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::extract::{ExtractError, MAX_TEXT_CHARS, extract_guarded};
use crate::{ContextError, MAX_DOCUMENT_BYTES};

/// The text a child may send back: [`MAX_TEXT_CHARS`] characters of up to four bytes each.
pub const MAX_OUTPUT_BYTES: usize = MAX_TEXT_CHARS * 4;
/// How long the child's own in-process deadline gives a document; the parent's wall-clock limit
/// is a little longer, so a slow document usually ends as `too_slow` from the child itself.
const CHILD_DEADLINE: Duration = Duration::from_secs(120);

/// What one extraction may use.
#[derive(Debug, Clone, Copy)]
pub struct ChildLimits {
    /// CPU time; past it the kernel stops the child.
    pub cpu: Duration,
    /// Address space (Linux only).
    pub memory: u64,
    /// Wall-clock time; past it the parent kills the child.
    pub wall: Duration,
}

impl Default for ChildLimits {
    fn default() -> Self {
        Self {
            cpu: Duration::from_secs(120),
            memory: 1 << 30,
            wall: Duration::from_secs(130),
        }
    }
}

/// Runs extraction in a child process: by default the ingest binary itself.
#[derive(Debug, Clone)]
pub struct ChildExtractor {
    program: PathBuf,
    /// Arguments before `extract <content-type>`; empty for the ingest binary.
    args: Vec<OsString>,
    limits: ChildLimits,
}

/// Exit codes of the child for each way it can fail; 0 is text on stdout.
const EXIT_USAGE: i32 = 2;
fn exit_code(e: ExtractError) -> i32 {
    match e {
        ExtractError::Unreadable => 3,
        ExtractError::Empty => 4,
        ExtractError::TooLarge => 5,
        ExtractError::TooSlow => 6,
    }
}

impl ChildExtractor {
    pub fn new(program: impl Into<PathBuf>, args: Vec<OsString>, limits: ChildLimits) -> Self {
        Self {
            program: program.into(),
            args,
            limits,
        }
    }

    /// The running binary, which must handle `extract` (the ingest worker does), with the default
    /// limits.
    pub fn this_binary() -> std::io::Result<Self> {
        Ok(Self::new(std::env::current_exe()?, Vec::new(), ChildLimits::default()))
    }

    /// The document's text, or why it has none. `Err` only if the child could not be started at
    /// all, which is the worker's problem, not the document's.
    pub async fn extract(
        &self,
        content_type: ContentType,
        bytes: Vec<u8>,
    ) -> Result<Result<String, ExtractError>, ContextError> {
        let started = Instant::now();
        let limits = self.limits;
        let mut cmd = tokio::process::Command::new(&self.program);
        cmd.args(&self.args)
            .arg("extract")
            .arg(content_type.as_str())
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // SAFETY: between fork and exec only setrlimit runs, which is async-signal-safe, on values
        // computed before the fork.
        unsafe {
            cmd.pre_exec(move || set_limits(&limits));
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| ContextError::Config(format!("cannot start the extractor: {e}")))?;
        let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err(ContextError::Config("extractor pipes missing".into()));
        };
        let write = async move {
            // A child that exits early (a limit, a bad file) closes its end: that is not an error
            // here, its exit status says what happened.
            let _ = stdin.write_all(&bytes).await;
            drop(stdin);
        };
        let read = async move {
            let mut out = Vec::new();
            let mut capped = stdout.take(MAX_OUTPUT_BYTES as u64 + 1);
            capped.read_to_end(&mut out).await.map(|_| out)
        };
        let Ok(((), out)) = tokio::time::timeout(limits.wall, async { tokio::join!(write, read) }).await else {
            return Ok(Err(stop(&mut child, ExtractError::TooSlow).await));
        };
        let Ok(out) = out else {
            return Ok(Err(stop(&mut child, ExtractError::Unreadable).await));
        };
        if out.len() > MAX_OUTPUT_BYTES {
            return Ok(Err(stop(&mut child, ExtractError::TooLarge).await));
        }
        let left = limits.wall.saturating_sub(started.elapsed());
        let Ok(status) = tokio::time::timeout(left, child.wait()).await else {
            return Ok(Err(stop(&mut child, ExtractError::TooSlow).await));
        };
        let status = status.map_err(|e| ContextError::Config(format!("extractor wait: {e}")))?;
        Ok(outcome(status, out))
    }
}

/// Kills the child and waits for it, so nothing is left running; returns `why`.
async fn stop(child: &mut tokio::process::Child, why: ExtractError) -> ExtractError {
    let _ = child.start_kill();
    let _ = child.wait().await;
    why
}

/// What the child's exit means for the document.
fn outcome(status: ExitStatus, out: Vec<u8>) -> Result<String, ExtractError> {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(0), _) => String::from_utf8(out).map_err(|_| ExtractError::Unreadable),
        (Some(3), _) => Err(ExtractError::Unreadable),
        (Some(4), _) => Err(ExtractError::Empty),
        (Some(5), _) => Err(ExtractError::TooLarge),
        (Some(6), _) => Err(ExtractError::TooSlow),
        // Out of CPU time (SIGXCPU, then SIGKILL at the hard limit).
        (None, Some(libc::SIGXCPU | libc::SIGKILL)) => Err(ExtractError::TooSlow),
        // Out of address space: an allocation fails and the child aborts, or its stack overflows.
        (None, Some(libc::SIGABRT | libc::SIGSEGV | libc::SIGBUS)) => Err(ExtractError::TooLarge),
        _ => Err(ExtractError::Unreadable),
    }
}

/// Runs in the child between fork and exec.
fn set_limits(limits: &ChildLimits) -> std::io::Result<()> {
    let set = |resource, soft: u64, hard: u64| {
        let limit = libc::rlimit {
            rlim_cur: soft,
            rlim_max: hard,
        };
        // SAFETY: setrlimit reads the struct we pass and nothing else.
        if unsafe { libc::setrlimit(resource, &limit) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    };
    let cpu = limits.cpu.as_secs().max(1);
    set(libc::RLIMIT_CPU, cpu, cpu + 1)?;
    // ponytail: macOS refuses RLIMIT_AS (EINVAL), so local runs there have no memory limit; the
    // worker runs on Linux.
    if cfg!(target_os = "linux") {
        set(libc::RLIMIT_AS, limits.memory, limits.memory)?;
    }
    // It writes no file and leaves no core; it needs its three pipes and little else.
    set(libc::RLIMIT_FSIZE, 0, 0)?;
    set(libc::RLIMIT_CORE, 0, 0)?;
    set(libc::RLIMIT_NOFILE, 32, 32)?;
    Ok(())
}

/// The child's side of `extract <content-type>`: the file on stdin, the text on stdout, and an
/// exit code that says how it went. Returns the exit code.
pub fn child_main(content_type: Option<&str>) -> i32 {
    let Some(content_type) = content_type.and_then(ContentType::parse) else {
        return EXIT_USAGE;
    };
    let mut bytes = Vec::new();
    if std::io::stdin()
        .take(MAX_DOCUMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > MAX_DOCUMENT_BYTES
    {
        return exit_code(ExtractError::TooLarge);
    }
    match extract_guarded(content_type, &bytes, Instant::now() + CHILD_DEADLINE) {
        Ok(text) => {
            let mut out = std::io::stdout().lock();
            if out.write_all(text.as_bytes()).and_then(|()| out.flush()).is_err() {
                return exit_code(ExtractError::Unreadable);
            }
            0
        }
        Err(e) => exit_code(e),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::process::ExitStatusExt;

    use super::*;

    fn sh(script: &str, limits: ChildLimits) -> ChildExtractor {
        ChildExtractor::new("/bin/sh", vec!["-c".into(), script.into(), "sh".into()], limits)
    }

    fn quick() -> ChildLimits {
        ChildLimits {
            cpu: Duration::from_secs(1),
            memory: 256 << 20,
            wall: Duration::from_secs(2),
        }
    }

    #[test]
    fn every_way_a_child_can_end_has_a_meaning() {
        let exit = |code: i32| ExitStatus::from_raw(code << 8);
        let signal = ExitStatus::from_raw;
        assert_eq!(outcome(exit(0), b"text".to_vec()), Ok("text".into()));
        assert_eq!(outcome(exit(0), vec![0xff, 0xfe]), Err(ExtractError::Unreadable));
        for e in [
            ExtractError::Unreadable,
            ExtractError::Empty,
            ExtractError::TooLarge,
            ExtractError::TooSlow,
        ] {
            assert_eq!(outcome(exit(exit_code(e)), Vec::new()), Err(e));
        }
        assert_eq!(outcome(exit(101), Vec::new()), Err(ExtractError::Unreadable));
        assert_eq!(outcome(signal(libc::SIGXCPU), Vec::new()), Err(ExtractError::TooSlow));
        assert_eq!(outcome(signal(libc::SIGKILL), Vec::new()), Err(ExtractError::TooSlow));
        assert_eq!(outcome(signal(libc::SIGABRT), Vec::new()), Err(ExtractError::TooLarge));
        assert_eq!(
            outcome(signal(libc::SIGTERM), Vec::new()),
            Err(ExtractError::Unreadable)
        );
    }

    #[tokio::test]
    async fn the_child_runs_under_its_limits_with_no_environment() {
        let probe = sh(
            r#"cat >/dev/null; echo "cpu=$(ulimit -t) fsize=$(ulimit -f) home=[$HOME]"; ulimit -v"#,
            quick(),
        );
        let text = probe
            .extract(ContentType::Text, b"some file".to_vec())
            .await
            .unwrap()
            .unwrap();
        let mut lines = text.lines();
        assert_eq!(lines.next(), Some("cpu=1 fsize=0 home=[]"));
        // The address-space limit is set on Linux only (macOS refuses it).
        if cfg!(target_os = "linux") {
            assert_eq!(lines.next(), Some(((256 << 20) / 1024).to_string().as_str()));
        }
    }

    #[tokio::test]
    async fn a_child_past_its_limits_is_stopped_and_the_document_fails() {
        // Past the wall clock: killed by the parent.
        let started = Instant::now();
        let sleeper = sh("sleep 30", quick());
        let r = sleeper.extract(ContentType::Pdf, Vec::new()).await.unwrap();
        assert_eq!(r, Err(ExtractError::TooSlow));
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        // Past its CPU time: stopped by the kernel, not by the parent's wall clock. One second of
        // CPU can take several of wall time on a busy machine, so the wall clock here is long and
        // the test only asks that the child ended well before it.
        let mut long_wall = quick();
        long_wall.wall = Duration::from_secs(60);
        let started = Instant::now();
        let spinner = sh("while :; do :; done", long_wall);
        assert_eq!(
            spinner.extract(ContentType::Pdf, Vec::new()).await.unwrap(),
            Err(ExtractError::TooSlow)
        );
        assert!(started.elapsed() < Duration::from_secs(45), "{:?}", started.elapsed());
        // More text than any document may give: cut off.
        let talker = sh("yes", quick());
        assert_eq!(
            talker.extract(ContentType::Pdf, Vec::new()).await.unwrap(),
            Err(ExtractError::TooLarge)
        );
        // A program that cannot start is the worker's problem, not the document's.
        let missing = ChildExtractor::new("/nonexistent/extractor", Vec::new(), quick());
        assert!(missing.extract(ContentType::Pdf, Vec::new()).await.is_err());
    }
}
