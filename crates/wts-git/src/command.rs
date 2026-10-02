use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::{GitError, GitOperation};

const STDOUT_LIMIT: usize = 64 * 1024;
const STDERR_LIMIT: usize = 16 * 1024;
const MAX_CUSTOM_STDOUT_LIMIT: usize = 8 * 1024 * 1024;
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[cfg(test)]
std::thread_local! {
    static MEASURED_GIT_COMMANDS: std::cell::Cell<Option<usize>> =
        const { std::cell::Cell::new(None) };
}

#[derive(Debug)]
pub(crate) struct CommandOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr: Vec<u8>,
    pub stderr_truncated: bool,
}

impl CommandOutput {
    pub fn success_text(&self, operation: GitOperation) -> Result<String, GitError> {
        if self.stdout_truncated {
            return Err(GitError::OutputTooLarge { operation });
        }
        String::from_utf8(self.stdout.clone()).map_err(|_| GitError::InvalidRepositoryMetadata)
    }

    pub fn command_error(&self, operation: GitOperation) -> GitError {
        let detail = sanitize_terminal_text(&self.stderr);
        GitError::CommandFailed {
            operation,
            status: self.status.code(),
            detail: if detail.trim().is_empty() {
                "Git returned no diagnostic".to_owned()
            } else {
                detail.trim().to_owned()
            },
            truncated: self.stderr_truncated,
        }
    }
}

pub(crate) fn git<I, S>(repository: Option<&Path>, args: I) -> Result<CommandOutput, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    git_with_stdout_limit(repository, args, STDOUT_LIMIT)
}

pub(crate) fn git_with_stdout_limit<I, S>(
    repository: Option<&Path>,
    args: I,
    stdout_limit: usize,
) -> Result<CommandOutput, GitError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    #[cfg(test)]
    MEASURED_GIT_COMMANDS.with(|count| {
        if let Some(current) = count.get() {
            count.set(Some(current.saturating_add(1)));
        }
    });

    let stdout_limit = stdout_limit.min(MAX_CUSTOM_STDOUT_LIMIT);
    let mut command = Command::new("git");
    if let Some(repository) = repository {
        command.arg("-C").arg(repository);
    }
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    run_command_with_timeout_and_stdout_limit(&mut command, GIT_COMMAND_TIMEOUT, stdout_limit)
}

#[cfg(test)]
pub(crate) fn measure_git_commands<T>(operation: impl FnOnce() -> T) -> (T, usize) {
    MEASURED_GIT_COMMANDS.with(|count| {
        assert!(
            count.replace(Some(0)).is_none(),
            "nested Git command measurement is unsupported"
        );
        let result = operation();
        let measured = count
            .replace(None)
            .expect("Git command measurement must remain active");
        (result, measured)
    })
}

#[cfg(test)]
fn run_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> Result<CommandOutput, GitError> {
    run_command_with_timeout_and_stdout_limit(command, timeout, STDOUT_LIMIT)
}

fn run_command_with_timeout_and_stdout_limit(
    command: &mut Command,
    timeout: Duration,
    stdout_limit: usize,
) -> Result<CommandOutput, GitError> {
    configure_process_group(command);
    let mut child = command.spawn().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied => GitError::GitUnavailable,
        _ => GitError::Filesystem,
    })?;

    let stdout = child.stdout.take().ok_or(GitError::Filesystem)?;
    let stderr = child.stderr.take().ok_or(GitError::Filesystem)?;
    let (sender, receiver) = mpsc::channel();
    let stdout_sender = sender.clone();
    thread::spawn(move || {
        let _ = stdout_sender.send(StreamResult::Stdout(read_bounded(stdout, stdout_limit)));
    });
    thread::spawn(move || {
        let _ = sender.send(StreamResult::Stderr(read_bounded(stderr, STDERR_LIMIT)));
    });

    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(GitError::Filesystem)?;
    let mut status = None;
    let mut stdout = None;
    let mut stderr = None;

    loop {
        if status.is_none() {
            status = child.try_wait().map_err(|_| GitError::Filesystem)?;
        }
        while let Ok(result) = receiver.try_recv() {
            match result {
                StreamResult::Stdout(result) => stdout = Some(result),
                StreamResult::Stderr(result) => stderr = Some(result),
            }
        }

        if let Some(status) = status
            && stdout.is_some()
            && stderr.is_some()
        {
            let stdout = stdout.take().ok_or(GitError::Filesystem)?;
            let stderr = stderr.take().ok_or(GitError::Filesystem)?;
            let (stdout, stdout_truncated) = stdout.map_err(|_| GitError::Filesystem)?;
            let (stderr, stderr_truncated) = stderr.map_err(|_| GitError::Filesystem)?;
            return Ok(CommandOutput {
                status,
                stdout,
                stdout_truncated,
                stderr,
                stderr_truncated,
            });
        }

        let now = Instant::now();
        if now >= deadline {
            terminate_and_reap(&mut child, status.is_some())?;
            return Err(GitError::CommandTimedOut);
        }
        thread::sleep(COMMAND_POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

enum StreamResult {
    Stdout(io::Result<(Vec<u8>, bool)>),
    Stderr(io::Result<(Vec<u8>, bool)>),
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_and_reap(child: &mut Child, already_reaped: bool) -> Result<(), GitError> {
    let process_group = i32::try_from(child.id()).map_err(|_| GitError::Filesystem)?;
    // SAFETY: `configure_process_group` gives the spawned child a process group
    // whose ID equals its PID. A negative PID targets only that group.
    let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
    if result == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(GitError::Filesystem);
        }
    }
    if !already_reaped {
        child.wait().map_err(|_| GitError::Filesystem)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn terminate_and_reap(child: &mut Child, already_reaped: bool) -> Result<(), GitError> {
    if !already_reaped {
        match child.kill() {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => {}
            Err(_) => return Err(GitError::Filesystem),
        }
        child.wait().map_err(|_| GitError::Filesystem)?;
    }
    Ok(())
}

fn read_bounded<R: Read>(mut reader: R, limit: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut captured = Vec::with_capacity(limit.min(8 * 1024));
    let mut truncated = false;
    let mut buffer = [0_u8; 8 * 1024];

    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let available = limit.saturating_sub(captured.len());
        let retained = available.min(count);
        captured.extend_from_slice(&buffer[..retained]);
        truncated |= retained < count;
    }

    Ok((captured, truncated))
}

pub(crate) fn sanitize_terminal_text(bytes: &[u8]) -> String {
    let lossy = String::from_utf8_lossy(bytes);
    let mut sanitized = String::with_capacity(lossy.len());
    let mut chars = lossy.chars().peekable();

    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        match character {
            '\n' | '\r' | '\t' => sanitized.push(character),
            value if !value.is_control() => sanitized.push(value),
            _ => sanitized.push('\u{fffd}'),
        }
    }

    sanitized
}

#[cfg(test)]
mod tests {
    use super::{run_command_with_timeout, sanitize_terminal_text};
    use crate::GitError;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    fn strips_terminal_escape_sequences_and_controls() {
        let value = sanitize_terminal_text(b"\x1b[31mfailure\x1b[0m\x00\r\nnext");
        assert_eq!(value, "failure\u{fffd}\r\nnext");
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_terminates_and_reaps_a_running_process() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let started = Instant::now();

        let result = run_command_with_timeout(&mut command, Duration::from_millis(80));

        assert!(matches!(result, Err(GitError::CommandTimedOut)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn command_timeout_terminates_descendants_that_hold_output_pipes() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30 & exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let started = Instant::now();

        let result = run_command_with_timeout(&mut command, Duration::from_millis(80));

        assert!(matches!(result, Err(GitError::CommandTimedOut)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
