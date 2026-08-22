use crate::{
    VerificationCheck, VerificationCheckStatus,
    process::{configure_process_group, terminate_process_group},
};
use std::{
    env,
    io::{self, Read},
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError},
    },
    thread,
    time::{Duration, Instant},
};

const MAX_VERIFICATION_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_VERIFICATION_OUTPUT_BYTES: usize = 1024 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(25);

pub(crate) struct CheckExecution {
    pub(crate) status: VerificationCheckStatus,
    pub(crate) exit_code: Option<i32>,
    pub(crate) duration_ms: u64,
    pub(crate) detail: String,
    pub(crate) log: Vec<u8>,
}

#[cfg(test)]
pub(crate) fn execute_check(check: &VerificationCheck, workspace: &Path) -> CheckExecution {
    execute_check_with_cancellation(check, workspace, &AtomicBool::new(false))
}

pub(crate) fn execute_check_with_cancellation(
    check: &VerificationCheck,
    workspace: &Path,
    cancellation: &AtomicBool,
) -> CheckExecution {
    let started = Instant::now();
    if cancellation.load(Ordering::Acquire) {
        return cancelled(started);
    }
    if !approved_fixed_command(&check.executable, &check.args) {
        return rejected(
            started,
            "The persisted check is not an approved WTS command.",
        );
    }
    if check.timeout_ms == 0 {
        return rejected(
            started,
            "The persisted check does not have a valid time limit.",
        );
    }
    if check
        .environment_names
        .iter()
        .any(|name| name.as_str() != "CI")
    {
        return rejected(
            started,
            "The persisted check requests an unapproved environment value.",
        );
    }
    let working_directory = Path::new(&check.working_directory);
    if !valid_working_directory(workspace, working_directory) {
        return rejected(
            started,
            "The persisted check working directory is outside this workspace.",
        );
    }
    let timeout = Duration::from_millis(check.timeout_ms).min(MAX_VERIFICATION_TIMEOUT);
    let output_limit = usize::try_from(check.output_limit_bytes)
        .unwrap_or(MAX_VERIFICATION_OUTPUT_BYTES)
        .min(MAX_VERIFICATION_OUTPUT_BYTES);

    let mut command = verification_command(&check.executable);
    command
        .args(&check.args)
        .current_dir(working_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if check.environment_names.iter().any(|name| name == "CI") {
        command.env("CI", "1");
    }
    configure_process_group(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return CheckExecution {
                status: VerificationCheckStatus::Failed,
                exit_code: None,
                duration_ms: elapsed_ms(started),
                detail: match error.kind() {
                    io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied => {
                        "The required verification executable is unavailable.".to_owned()
                    }
                    _ => "The verification process could not start.".to_owned(),
                },
                log: Vec::new(),
            };
        }
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = terminate_process_group(&mut child, false);
        return rejected(started, "The verification process output was unavailable.");
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = terminate_process_group(&mut child, false);
        return rejected(started, "The verification process output was unavailable.");
    };
    let stdout_reader = spawn_reader(stdout, output_limit);
    let stderr_reader = spawn_reader(stderr, output_limit);

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if cancellation.load(Ordering::Acquire) => {
                let _ = terminate_process_group(&mut child, false);
                return cancelled(started);
            }
            Ok(None) if started.elapsed() < timeout => thread::sleep(POLL_INTERVAL),
            Ok(None) => {
                let _ = terminate_process_group(&mut child, false);
                return CheckExecution {
                    status: VerificationCheckStatus::TimedOut,
                    exit_code: None,
                    duration_ms: elapsed_ms(started),
                    detail: "The verification check exceeded its time limit.".to_owned(),
                    log: Vec::new(),
                };
            }
            Err(_) => {
                let _ = terminate_process_group(&mut child, false);
                return rejected(started, "The verification process could not be observed.");
            }
        }
    };

    let remaining = timeout.saturating_sub(started.elapsed());
    let stdout = receive_reader(stdout_reader, remaining);
    let stderr = receive_reader(stderr_reader, remaining);
    let (stdout, stderr) = match (stdout, stderr) {
        (Ok(stdout), Ok(stderr)) if stdout.len().saturating_add(stderr.len()) <= output_limit => {
            (stdout, stderr)
        }
        _ => {
            let _ = terminate_process_group(&mut child, true);
            return CheckExecution {
                status: VerificationCheckStatus::Failed,
                exit_code: status.code(),
                duration_ms: elapsed_ms(started),
                detail: "The verification check exceeded its output limit.".to_owned(),
                log: Vec::new(),
            };
        }
    };
    let log = combined_log(&stdout, &stderr);
    CheckExecution {
        status: if status.success() {
            VerificationCheckStatus::Passed
        } else {
            VerificationCheckStatus::Failed
        },
        exit_code: status.code(),
        duration_ms: elapsed_ms(started),
        detail: if status.success() {
            "Check passed.".to_owned()
        } else {
            "Check failed; inspect its bounded local log.".to_owned()
        },
        log,
    }
}

pub(crate) fn approved_fixed_command(executable: &str, args: &[String]) -> bool {
    match executable {
        "cargo" => args == ["test", "--quiet"],
        "npm" => args == ["test", "--silent"],
        "pytest" => args == ["--quiet"],
        "python" | "python3" => args == ["-m", "pytest", "--quiet"],
        "go" => args == ["test", "./..."],
        _ => false,
    }
}

fn valid_working_directory(workspace: &Path, candidate: &Path) -> bool {
    candidate.is_absolute()
        && candidate.starts_with(workspace)
        && candidate
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        && candidate.canonicalize().ok().as_deref() == Some(candidate)
}

fn verification_command(executable: &str) -> Command {
    let mut command = Command::new(executable);
    command.env_clear();
    copy_environment(&mut command);
    command
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "commit.gpgsign")
        .env("GIT_CONFIG_VALUE_0", "false")
        .env("GIT_TERMINAL_PROMPT", "0");
    command
}

fn copy_environment(command: &mut Command) {
    for name in [
        "PATH",
        "HOME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "USERPROFILE",
        "SystemRoot",
        "PATHEXT",
    ] {
        if let Some(value) = env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn rejected(started: Instant, detail: &str) -> CheckExecution {
    CheckExecution {
        status: VerificationCheckStatus::Failed,
        exit_code: None,
        duration_ms: elapsed_ms(started),
        detail: detail.to_owned(),
        log: Vec::new(),
    }
}

fn cancelled(started: Instant) -> CheckExecution {
    CheckExecution {
        status: VerificationCheckStatus::Cancelled,
        exit_code: None,
        duration_ms: elapsed_ms(started),
        detail: "Cancelled by the user.".to_owned(),
        log: Vec::new(),
    }
}

fn read_bounded(reader: impl Read, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::other("verification output exceeded limit"));
    }
    Ok(bytes)
}

fn spawn_reader(reader: impl Read + Send + 'static, limit: usize) -> Receiver<io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(read_bounded(reader, limit));
    });
    receiver
}

fn receive_reader(
    receiver: Receiver<io::Result<Vec<u8>>>,
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "verification output reader timed out",
        )),
        Err(RecvTimeoutError::Disconnected) => {
            Err(io::Error::other("verification output reader disconnected"))
        }
    }
}

fn combined_log(stdout: &[u8], stderr: &[u8]) -> Vec<u8> {
    let mut log = Vec::with_capacity(stdout.len().saturating_add(stderr.len()).saturating_add(32));
    log.extend_from_slice(b"stdout:\n");
    log.extend_from_slice(stdout);
    log.extend_from_slice(b"\n\nstderr:\n");
    log.extend_from_slice(stderr);
    log
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{VerificationCheckKind, VerificationCheckStatus};
    use serde_json::json;
    use std::{fs, sync::Arc};
    use tempfile::tempdir;

    fn check(root: &Path, executable: &str, args: &[&str]) -> VerificationCheck {
        VerificationCheck {
            id: "sample".to_owned(),
            label: "Sample".to_owned(),
            kind: VerificationCheckKind::Unit,
            repository_id: None,
            working_directory: root.to_string_lossy().into_owned(),
            executable: executable.to_owned(),
            args: args.iter().map(|argument| (*argument).to_owned()).collect(),
            timeout_ms: 5_000,
            output_limit_bytes: 4_096,
            required: true,
            environment_names: vec!["CI".to_owned()],
            acceptance_files: Vec::new(),
        }
    }

    #[test]
    fn rejects_commands_outside_the_fixed_verification_registry() {
        let fixture = tempdir().expect("fixture");
        let root = fixture.path().canonicalize().expect("canonical fixture");
        let result = execute_check(&check(&root, "sh", &["-c", "true"]), &root);
        assert_eq!(result.status, VerificationCheckStatus::Failed);
        assert!(result.detail.contains("not an approved"));
    }

    #[test]
    fn rejects_a_deserialized_python_shell_escape_before_spawn() {
        let fixture = tempdir().expect("fixture");
        let root = fixture.path().canonicalize().expect("canonical fixture");
        let marker = root.join("must-not-exist");
        let persisted = json!({
            "id": "python-shell",
            "label": "Unsafe Python",
            "kind": "unit",
            "workingDirectory": root,
            "executable": "python3",
            "args": ["-c", format!("open({:?}, 'w').close()", marker)],
            "timeoutMs": 5_000,
            "outputLimitBytes": 4_096,
            "required": true,
            "environmentNames": ["CI"],
            "acceptanceFiles": []
        });
        let check: VerificationCheck =
            serde_json::from_value(persisted).expect("deserialize persisted check");

        let result = execute_check(&check, &root);

        assert_eq!(result.status, VerificationCheckStatus::Failed);
        assert!(result.detail.contains("not an approved"));
        assert!(!marker.exists(), "unapproved Python command was executed");
    }

    #[test]
    fn accepts_only_exact_repository_native_test_adapters() {
        for (executable, args) in [
            ("cargo", vec!["test", "--quiet"]),
            ("npm", vec!["test", "--silent"]),
            ("pytest", vec!["--quiet"]),
            ("python", vec!["-m", "pytest", "--quiet"]),
            ("python3", vec!["-m", "pytest", "--quiet"]),
            ("go", vec!["test", "./..."]),
        ] {
            assert!(
                approved_fixed_command(
                    executable,
                    &args.into_iter().map(str::to_owned).collect::<Vec<_>>()
                ),
                "{executable} should be approved"
            );
        }

        for (executable, args) in [
            ("pytest", vec!["--quiet", "; rm -rf fixture"]),
            ("pytest", vec!["-c", "pytest.ini"]),
            ("python3", vec!["-c", "print('not pytest')"]),
            ("python", vec!["-m", "pytest", "--quiet", "../../outside"]),
            ("go", vec!["test", "./...", "-exec=sh"]),
            ("go", vec!["test", "../..."]),
            ("go", vec!["env"]),
        ] {
            assert!(
                !approved_fixed_command(
                    executable,
                    &args.into_iter().map(str::to_owned).collect::<Vec<_>>()
                ),
                "{executable} with unsafe or broadened arguments must be rejected"
            );
        }
    }

    #[test]
    fn executes_a_deserialized_python_pytest_adapter_at_the_fixed_boundary() {
        if Command::new("python3").arg("--version").output().is_err() {
            return;
        }
        let fixture = tempdir().expect("fixture");
        let root = fixture.path().canonicalize().expect("canonical fixture");
        fs::create_dir(root.join("pytest")).expect("pytest module");
        fs::write(root.join("pytest/__init__.py"), "").expect("pytest package");
        fs::write(
            root.join("pytest/__main__.py"),
            "import sys\nassert sys.argv == [sys.argv[0], '--quiet']\nprint('bounded pytest adapter')\n",
        )
        .expect("pytest entry point");
        let persisted = json!({
            "id": "python-pytest",
            "label": "Python tests",
            "kind": "unit",
            "workingDirectory": root,
            "executable": "python3",
            "args": ["-m", "pytest", "--quiet"],
            "timeoutMs": 5_000,
            "outputLimitBytes": 4_096,
            "required": true,
            "environmentNames": ["CI"],
            "acceptanceFiles": []
        });
        let check: VerificationCheck =
            serde_json::from_value(persisted).expect("deserialize persisted check");

        let result = execute_check(&check, &root);

        assert_eq!(result.status, VerificationCheckStatus::Passed);
        assert!(String::from_utf8_lossy(&result.log).contains("bounded pytest adapter"));
    }

    #[test]
    fn validates_a_deserialized_go_test_adapter_at_the_fixed_boundary() {
        let fixture = tempdir().expect("fixture");
        let root = fixture.path().canonicalize().expect("canonical fixture");
        let persisted = json!({
            "id": "go-test",
            "label": "Go tests",
            "kind": "unit",
            "workingDirectory": root,
            "executable": "go",
            "args": ["test", "./..."],
            "timeoutMs": 30_000,
            "outputLimitBytes": 64_000,
            "required": true,
            "environmentNames": ["CI"],
            "acceptanceFiles": []
        });
        let check: VerificationCheck =
            serde_json::from_value(persisted).expect("deserialize persisted check");

        assert!(approved_fixed_command(&check.executable, &check.args));
        assert_eq!(check.working_directory, root.to_string_lossy());
        assert_eq!(check.environment_names, ["CI"]);
    }

    #[test]
    #[ignore = "requires an installed, functional external Go toolchain and writable Go cache"]
    fn executes_the_deserialized_go_test_adapter_with_a_real_toolchain() {
        let fixture = tempdir().expect("fixture");
        let root = fixture.path().canonicalize().expect("canonical fixture");
        fs::write(root.join("go.mod"), "module wts.test/fixture\n\ngo 1.20\n").expect("go module");
        fs::write(
            root.join("adapter_test.go"),
            "package fixture\n\nimport \"testing\"\n\nfunc TestAdapter(t *testing.T) {}\n",
        )
        .expect("go test");
        let check = check(&root, "go", &["test", "./..."]);

        let result = execute_check(&check, &root);

        assert_eq!(
            result.status,
            VerificationCheckStatus::Passed,
            "{}",
            String::from_utf8_lossy(&result.log)
        );
    }

    #[test]
    fn rejects_unapproved_environment_requests_and_zero_timeouts_before_spawn() {
        let fixture = tempdir().expect("fixture");
        let root = fixture.path().canonicalize().expect("canonical fixture");
        let mut unapproved_environment = check(&root, "go", &["test", "./..."]);
        unapproved_environment.environment_names = vec!["PATH".to_owned()];
        let result = execute_check(&unapproved_environment, &root);
        assert_eq!(result.status, VerificationCheckStatus::Failed);
        assert!(result.detail.contains("unapproved environment"));

        let mut zero_timeout = check(&root, "pytest", &["--quiet"]);
        zero_timeout.timeout_ms = 0;
        let result = execute_check(&zero_timeout, &root);
        assert_eq!(result.status, VerificationCheckStatus::Failed);
        assert!(result.detail.contains("valid time limit"));
    }

    #[test]
    fn cancellation_is_observed_before_a_verification_process_starts() {
        let fixture = tempdir().expect("fixture");
        let root = fixture.path().canonicalize().expect("canonical fixture");
        let cancellation = AtomicBool::new(true);

        let result = execute_check_with_cancellation(
            &check(&root, "cargo", &["test", "--quiet"]),
            &root,
            &cancellation,
        );

        assert_eq!(result.status, VerificationCheckStatus::Cancelled);
        assert!(result.detail.contains("Cancelled"));
    }

    #[test]
    fn cancellation_terminates_an_active_verification_process_group() {
        let fixture = tempdir().expect("fixture");
        let root = fixture.path().canonicalize().expect("canonical fixture");
        fs::create_dir(root.join("src")).expect("crate src");
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"wts-cancel-fixture\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .expect("crate manifest");
        fs::write(
            root.join("src/lib.rs"),
            "#[test]\nfn waits() { std::thread::sleep(std::time::Duration::from_secs(30)); }\n",
        )
        .expect("crate test");
        let cancellation = Arc::new(AtomicBool::new(false));
        let execution_cancellation = Arc::clone(&cancellation);
        let execution_root = root.clone();
        let handle = thread::spawn(move || {
            execute_check_with_cancellation(
                &check(&execution_root, "cargo", &["test", "--quiet"]),
                &execution_root,
                execution_cancellation.as_ref(),
            )
        });

        thread::sleep(Duration::from_millis(250));
        cancellation.store(true, Ordering::Release);
        let result = handle.join().expect("verification thread");

        assert_eq!(result.status, VerificationCheckStatus::Cancelled);
        assert!(result.duration_ms < 5_000, "cancel took too long");
    }

    #[test]
    fn verification_process_disables_inherited_git_signing() {
        let fixture = tempdir().expect("fixture");
        let root = fixture.path().canonicalize().expect("canonical fixture");
        let run_git = |args: &[&str]| {
            let status = Command::new("git")
                .args(["-C", root.to_str().expect("utf-8 fixture")])
                .args(args)
                .status()
                .expect("run fixture git");
            assert!(status.success(), "git {args:?}");
        };
        run_git(&["init", "--quiet", "--initial-branch=main"]);
        run_git(&["config", "user.name", "WTS Verification"]);
        run_git(&["config", "user.email", "verification@localhost"]);
        run_git(&["config", "commit.gpgSign", "true"]);
        run_git(&["config", "user.signingKey", "missing-test-key"]);
        fs::write(root.join("README.md"), "verification\n").expect("write fixture");
        run_git(&["add", "README.md"]);

        let status = verification_command("git")
            .args(["-C", root.to_str().expect("utf-8 fixture")])
            .args(["commit", "--quiet", "-m", "verification fixture"])
            .status()
            .expect("run isolated verification git");

        assert!(status.success());
    }
}
