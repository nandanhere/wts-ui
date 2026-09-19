#[path = "conversation_process.rs"]
mod conversation_process;
pub(crate) use conversation_process::{ConversationCapture, ConversationOutput};

use crate::{
    AgentProvider, AgentRunResult, GraphIndexResult, GraphWorkspaceStatus,
    agent_session_details::{AgentProcessEvent, AgentProcessEventKind},
    agent_sessions::{CHANGE_REQUEST_PROPOSAL_PREFIX, parse_agent_change_request_proposals},
    collaboration::{
        CollaborationAdapter, CollaborationAdapterFailure, CollaborationAdapterOutcome,
        CollaborationConfinement, CollaborationInvocation, CollaborationStopReason,
    },
    process::{configure_process_group, terminate_process_group},
};
use serde_json::Value;
use std::{
    ffi::{OsStr, OsString},
    fs,
    io::{self, BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use uuid::Uuid;
use wts_integrations::{PathResolver, SystemPathResolver};

const AGENT_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const GRAPH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_ADAPTER_OUTPUT_BYTES: usize = 1024 * 1024;
// Two full collaboration streams plus the separator used by `preferred_output`
// still fit inside the coordinator's default one-MiB evidence limit.
const MAX_COLLABORATION_STREAM_BYTES: usize = (MAX_ADAPTER_OUTPUT_BYTES / 2) - 1;
const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdapterFailure {
    Unavailable,
    SpawnFailed,
    TimedOut,
    OutputTooLarge,
    GraphFailed,
    Cancelled,
}

/// A confinement-aware non-interactive Codex process adapter.
///
/// The executable is host-owned and the argument contract is fixed: the
/// browser cannot add writable directories, shell fragments, or provider
/// configuration. Every invocation gets a fresh ephemeral Codex session whose
/// current directory and workspace-write sandbox are the coordinator-validated
/// repository worktree scope.
#[derive(Clone, Debug)]
pub struct ProcessCollaborationAdapter {
    codex_executable: OsString,
}

impl Default for ProcessCollaborationAdapter {
    fn default() -> Self {
        Self {
            codex_executable: OsString::from("codex"),
        }
    }
}

impl ProcessCollaborationAdapter {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    fn for_test_executable(executable: impl Into<OsString>) -> Self {
        Self {
            codex_executable: executable.into(),
        }
    }
}

impl CollaborationAdapter for ProcessCollaborationAdapter {
    fn confinement(&self, provider: AgentProvider) -> CollaborationConfinement {
        match provider {
            #[cfg(unix)]
            AgentProvider::Codex => CollaborationConfinement::WorkspaceWriteIsolated,
            #[cfg(not(unix))]
            AgentProvider::Codex => CollaborationConfinement::Unverified,
            AgentProvider::OpenCode | AgentProvider::Hermes | AgentProvider::Copilot => {
                CollaborationConfinement::Unverified
            }
        }
    }

    fn run(&self, invocation: CollaborationInvocation) -> CollaborationAdapterOutcome {
        if self.confinement(invocation.provider())
            != CollaborationConfinement::WorkspaceWriteIsolated
        {
            return CollaborationAdapterOutcome::Failed {
                failure: CollaborationAdapterFailure::Unavailable,
                output:
                    "Confined Codex collaboration is unavailable for this provider or platform."
                        .to_owned(),
            };
        }

        match run_collaboration_codex(&self.codex_executable, &invocation) {
            Ok(output) => {
                let succeeded = output.status.success();
                let text = bounded_codex_output(&output.stdout, &output.stderr, succeeded);
                if succeeded {
                    CollaborationAdapterOutcome::Succeeded { output: text }
                } else {
                    CollaborationAdapterOutcome::Failed {
                        failure: CollaborationAdapterFailure::ProviderFailed,
                        output: text,
                    }
                }
            }
            Err(CollaborationProcessFailure::Stopped(reason)) => {
                CollaborationAdapterOutcome::Stopped(reason)
            }
            Err(CollaborationProcessFailure::Unavailable) => CollaborationAdapterOutcome::Failed {
                failure: CollaborationAdapterFailure::Unavailable,
                output: "The Codex executable is unavailable.".to_owned(),
            },
            Err(CollaborationProcessFailure::SpawnFailed) => CollaborationAdapterOutcome::Failed {
                failure: CollaborationAdapterFailure::SpawnFailed,
                output: "The Codex process could not be started, monitored, or cleaned up."
                    .to_owned(),
            },
            Err(CollaborationProcessFailure::OutputTooLarge) => {
                CollaborationAdapterOutcome::Failed {
                    failure: CollaborationAdapterFailure::ProviderFailed,
                    output: format!(
                        "Codex exceeded the bounded output transport ({} bytes per stream).",
                        MAX_COLLABORATION_STREAM_BYTES
                    ),
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct ProcessWorkspaceAdapter {
    codex_executable: OsString,
    open_code_executable: OsString,
    hermes_executable: OsString,
    copilot_executable: OsString,
    graphify_executable: OsString,
    process_lease: Option<Arc<fs::File>>,
    image_context: Option<PathBuf>,
    conversation_capture: Option<Arc<std::sync::Mutex<ConversationCapture>>>,
    conversation_final_path: Option<PathBuf>,
}

impl Default for ProcessWorkspaceAdapter {
    fn default() -> Self {
        Self {
            codex_executable: OsString::from("codex"),
            open_code_executable: OsString::from("opencode"),
            hermes_executable: OsString::from("hermes"),
            copilot_executable: OsString::from("copilot"),
            graphify_executable: OsString::from("graphify"),
            process_lease: None,
            conversation_capture: None,
            conversation_final_path: None,
            image_context: None,
        }
    }
}

fn resolve_codex_executable(configured: &OsStr) -> OsString {
    if configured == OsStr::new("codex")
        && let Ok(Some(executable)) = SystemPathResolver.resolve("codex")
        && let Ok(executable) = executable.canonicalize()
    {
        return executable.into_os_string();
    }
    resolve_codex_executable_from_home(
        configured,
        std::env::var_os("HOME").as_deref().map(Path::new),
    )
}

fn resolve_codex_executable_from_home(configured: &OsStr, home: Option<&Path>) -> OsString {
    if configured != OsStr::new("codex") {
        return configured.to_os_string();
    }
    let mut candidates = Vec::new();
    if let Some(home) = home {
        candidates.push(home.join(".local/bin/codex"));
        for extensions_root in [
            home.join(".vscode/extensions"),
            home.join(".cursor/extensions"),
        ] {
            let Ok(entries) = fs::read_dir(extensions_root) else {
                continue;
            };
            let mut extension_candidates = entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("openai.chatgpt-")
                })
                .map(|entry| entry.path().join(codex_extension_binary_path()))
                .collect::<Vec<_>>();
            extension_candidates.sort_by(|left, right| right.cmp(left));
            candidates.extend(extension_candidates);
        }
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ]);
    candidates
        .into_iter()
        .find(|candidate| is_codex_executable(candidate))
        .map(PathBuf::into_os_string)
        .unwrap_or_else(|| configured.to_os_string())
}

fn is_codex_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn codex_extension_binary_path() -> &'static Path {
    Path::new("bin/macos-aarch64/codex")
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
fn codex_extension_binary_path() -> &'static Path {
    Path::new("bin/macos-x86_64/codex")
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
fn codex_extension_binary_path() -> &'static Path {
    Path::new("bin/linux-aarch64/codex")
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn codex_extension_binary_path() -> &'static Path {
    Path::new("bin/linux-x86_64/codex")
}

#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
    all(target_os = "linux", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64")
)))]
fn codex_extension_binary_path() -> &'static Path {
    Path::new("bin/codex")
}

fn resolve_copilot_executable(configured: &OsStr) -> OsString {
    let configured_str = configured.to_string_lossy();
    if configured_str != "copilot" {
        return configured.to_os_string();
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home_path = PathBuf::from(home);
        let vscode_bundled = home_path.join(
            "Library/Application Support/Code/User/globalStorage/github.copilot-chat/copilotCli/copilot",
        );
        if vscode_bundled.exists() {
            return vscode_bundled.into_os_string();
        }
    }
    if Path::new("/opt/homebrew/bin/copilot").exists() {
        return OsString::from("/opt/homebrew/bin/copilot");
    }
    if Path::new("/usr/local/bin/copilot").exists() {
        return OsString::from("/usr/local/bin/copilot");
    }
    configured.to_os_string()
}

impl ProcessWorkspaceAdapter {
    pub(crate) fn for_conversation(mut self, final_path: PathBuf) -> Self {
        self.conversation_capture = Some(Arc::new(std::sync::Mutex::new(
            ConversationCapture::default(),
        )));
        self.conversation_final_path = Some(final_path);
        self
    }

    pub(crate) fn conversation_output(
        &self,
        provider: AgentProvider,
        succeeded: bool,
        failure: Option<AdapterFailure>,
    ) -> Option<ConversationOutput> {
        let capture = self.conversation_capture.as_ref()?.lock().ok()?;
        Some(capture.finish(
            provider,
            succeeded,
            failure,
            self.conversation_final_path.as_ref()?,
        ))
    }

    pub(crate) fn with_image_context(mut self, image: Option<PathBuf>) -> Self {
        self.image_context = image;
        self
    }

    pub(crate) fn with_process_lease(mut self, lease: Arc<fs::File>) -> Self {
        self.process_lease = Some(lease);
        self
    }

    pub fn with_agent_executable(
        mut self,
        provider: AgentProvider,
        executable: impl Into<OsString>,
    ) -> Self {
        let executable = executable.into();
        match provider {
            AgentProvider::Codex => self.codex_executable = executable,
            AgentProvider::OpenCode => self.open_code_executable = executable,
            AgentProvider::Hermes => self.hermes_executable = executable,
            AgentProvider::Copilot => self.copilot_executable = executable,
        }
        self
    }

    pub fn with_graphify_executable(mut self, executable: impl Into<OsString>) -> Self {
        self.graphify_executable = executable.into();
        self
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "Keep lifecycle callbacks explicit at the process boundary."
    )]
    pub fn run_agent(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        workspace: &Path,
        prompt: &str,
        cancellation: &Arc<AtomicBool>,
        on_spawn: impl FnMut(),
        heartbeat: impl FnMut(),
        on_event: impl FnMut(AgentProcessEvent),
    ) -> Result<AgentRunResult, AdapterFailure> {
        self.run_agent_with_custom(
            workspace_id,
            provider,
            workspace,
            prompt,
            None,
            cancellation,
            on_spawn,
            heartbeat,
            on_event,
        )
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "Keep lifecycle callbacks explicit at the process boundary."
    )]
    pub fn run_agent_with_custom(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        workspace: &Path,
        prompt: &str,
        agent: Option<&str>,
        cancellation: &Arc<AtomicBool>,
        mut on_spawn: impl FnMut(),
        mut heartbeat: impl FnMut(),
        mut on_event: impl FnMut(AgentProcessEvent),
    ) -> Result<AgentRunResult, AdapterFailure> {
        let mut args = Vec::<OsString>::new();
        let resolved_codex;
        let resolved_copilot;
        let executable = match provider {
            AgentProvider::Codex => {
                args.extend([
                    "exec".into(),
                    "--ephemeral".into(),
                    "--json".into(),
                    "--sandbox".into(),
                    "workspace-write".into(),
                    "-c".into(),
                    "approval_policy=\"never\"".into(),
                    "--skip-git-repo-check".into(),
                    "--cd".into(),
                    workspace.as_os_str().to_owned(),
                ]);
                if let Some(model_name) = agent.filter(|s| !s.trim().is_empty()) {
                    args.extend(["--model".into(), model_name.into()]);
                }
                if let Some(path) = &self.conversation_final_path {
                    args.extend(["--output-last-message".into(), path.as_os_str().to_owned()]);
                }
                if let Some(image) = &self.image_context {
                    args.extend(["--image".into(), image.as_os_str().to_owned()]);
                }
                args.extend(["--".into(), prompt.into()]);
                resolved_codex = resolve_codex_executable(&self.codex_executable);
                &resolved_codex
            }
            AgentProvider::OpenCode => {
                args.extend([
                    "run".into(),
                    "--format".into(),
                    "json".into(),
                    "--dir".into(),
                    workspace.as_os_str().to_owned(),
                ]);
                if let Some(model_name) = agent.filter(|s| !s.trim().is_empty()) {
                    args.extend(["--model".into(), model_name.into()]);
                }
                args.extend([prompt.into()]);
                &self.open_code_executable
            }
            AgentProvider::Hermes => {
                args.extend([
                    "chat".into(),
                    "--query".into(),
                    prompt.into(),
                    "--quiet".into(),
                    "--source".into(),
                    "tool".into(),
                ]);
                &self.hermes_executable
            }
            AgentProvider::Copilot => {
                args.extend([
                    "--allow-all".into(),
                    "--silent".into(),
                    "-C".into(),
                    workspace.as_os_str().to_owned(),
                ]);
                if let Some(model_name) = agent.filter(|s| !s.trim().is_empty()) {
                    args.extend(["--model".into(), model_name.into()]);
                }
                args.extend(["-p".into(), prompt.into()]);
                resolved_copilot = resolve_copilot_executable(&self.copilot_executable);
                &resolved_copilot
            }
        };
        let started_at = Instant::now();
        let output = if let Some(capture) = &self.conversation_capture {
            conversation_process::run_conversation_process(
                executable,
                &args,
                workspace,
                provider,
                conversation_process::CONVERSATION_TIMEOUT,
                cancellation,
                self.process_lease.as_deref(),
                capture,
                &mut on_spawn,
                &mut heartbeat,
                &mut on_event,
            )?
        } else {
            run_bounded_controlled(
                executable,
                &args,
                workspace,
                AGENT_TIMEOUT,
                cancellation,
                self.process_lease.as_deref(),
                &mut on_spawn,
                &mut heartbeat,
                &mut |line| {
                    if provider == AgentProvider::Codex
                        && let Some(event) = parse_codex_event(line)
                    {
                        on_event(event);
                    }
                },
            )?
        };
        let text = preferred_output(&output.stdout, &output.stderr);
        Ok(AgentRunResult {
            workspace_id,
            provider,
            succeeded: output.success,
            output: text,
            duration_ms: elapsed_ms(started_at),
        })
    }

    pub fn index_graph(
        &self,
        workspace_id: Uuid,
        workspace: &Path,
    ) -> Result<GraphIndexResult, AdapterFailure> {
        let args = [
            OsString::from("update"),
            workspace.as_os_str().to_owned(),
            OsString::from("--no-cluster"),
        ];
        let started_at = Instant::now();
        let output = run_bounded(&self.graphify_executable, &args, workspace, GRAPH_TIMEOUT)?;
        if !output.success {
            return Err(AdapterFailure::GraphFailed);
        }
        let graph = workspace.join("graphify-out/graph.json");
        let metadata = graph
            .symlink_metadata()
            .map_err(|_| AdapterFailure::GraphFailed)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(AdapterFailure::GraphFailed);
        }
        Ok(GraphIndexResult {
            workspace_id,
            status: GraphWorkspaceStatus::Ready,
            graph_display_path: graph
                .to_str()
                .ok_or(AdapterFailure::GraphFailed)?
                .to_owned(),
            detail: "Workspace-only structural graph built without an LLM call.".to_owned(),
            duration_ms: elapsed_ms(started_at),
        })
    }
}

struct ProcessOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

struct CollaborationProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CollaborationProcessFailure {
    Stopped(CollaborationStopReason),
    Unavailable,
    SpawnFailed,
    OutputTooLarge,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CollaborationReadFailure {
    Io,
    OutputTooLarge,
}

struct CollaborationReaders {
    stdout: Option<JoinHandle<Result<Vec<u8>, CollaborationReadFailure>>>,
    stderr: Option<JoinHandle<Result<Vec<u8>, CollaborationReadFailure>>>,
    stdout_bytes: Option<Vec<u8>>,
    stderr_bytes: Option<Vec<u8>>,
}

impl CollaborationReaders {
    fn new(stdout: impl Read + Send + 'static, stderr: impl Read + Send + 'static) -> Self {
        Self {
            stdout: Some(spawn_collaboration_reader(stdout)),
            stderr: Some(spawn_collaboration_reader(stderr)),
            stdout_bytes: None,
            stderr_bytes: None,
        }
    }

    fn poll(&mut self) -> Result<(), CollaborationProcessFailure> {
        poll_collaboration_reader(&mut self.stdout, &mut self.stdout_bytes)?;
        poll_collaboration_reader(&mut self.stderr, &mut self.stderr_bytes)
    }

    fn finish(mut self) -> Result<(Vec<u8>, Vec<u8>), CollaborationProcessFailure> {
        let stdout_result = finish_collaboration_reader(&mut self.stdout, &mut self.stdout_bytes);
        let stderr_result = finish_collaboration_reader(&mut self.stderr, &mut self.stderr_bytes);
        stdout_result?;
        stderr_result?;
        Ok((
            self.stdout_bytes.unwrap_or_default(),
            self.stderr_bytes.unwrap_or_default(),
        ))
    }
}

fn run_collaboration_codex(
    executable: &OsStr,
    invocation: &CollaborationInvocation,
) -> Result<CollaborationProcessOutput, CollaborationProcessFailure> {
    invocation
        .checkpoint()
        .map_err(CollaborationProcessFailure::Stopped)?;
    let scope_root = validate_collaboration_scope(invocation.scope_root())?;
    let args = [
        OsString::from("exec"),
        OsString::from("--ephemeral"),
        OsString::from("--json"),
        OsString::from("--sandbox"),
        OsString::from("workspace-write"),
        OsString::from("--ignore-user-config"),
        OsString::from("--strict-config"),
        OsString::from("--disable"),
        OsString::from("plugins"),
        OsString::from("--disable"),
        OsString::from("remote_plugin"),
        OsString::from("--disable"),
        OsString::from("apps"),
        OsString::from("--disable"),
        OsString::from("hooks"),
        OsString::from("--disable"),
        OsString::from("multi_agent"),
        OsString::from("--disable"),
        OsString::from("browser_use"),
        OsString::from("--disable"),
        OsString::from("computer_use"),
        OsString::from("--disable"),
        OsString::from("image_generation"),
        OsString::from("--disable"),
        OsString::from("in_app_browser"),
        OsString::from("-c"),
        OsString::from("approval_policy=\"never\""),
        OsString::from("-c"),
        OsString::from("sandbox_workspace_write.writable_roots=[]"),
        OsString::from("-c"),
        OsString::from("sandbox_workspace_write.network_access=false"),
        OsString::from("-c"),
        OsString::from("sandbox_workspace_write.exclude_tmpdir_env_var=true"),
        OsString::from("-c"),
        OsString::from("sandbox_workspace_write.exclude_slash_tmp=true"),
        OsString::from("-c"),
        OsString::from("shell_environment_policy.inherit=\"core\""),
        OsString::from("--color"),
        OsString::from("never"),
        OsString::from("--skip-git-repo-check"),
        OsString::from("--cd"),
        scope_root.as_os_str().to_owned(),
        // End option parsing before caller-authored prompt content.
        OsString::from("--"),
        OsString::from(invocation.prompt()),
    ];
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(&scope_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    let mut child = command.spawn().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied => {
            CollaborationProcessFailure::Unavailable
        }
        _ => CollaborationProcessFailure::SpawnFailed,
    })?;
    let Some(stdout) = child.stdout.take() else {
        terminate_collaboration_child(&mut child, false);
        return Err(CollaborationProcessFailure::SpawnFailed);
    };
    let Some(stderr) = child.stderr.take() else {
        terminate_collaboration_child(&mut child, false);
        return Err(CollaborationProcessFailure::SpawnFailed);
    };
    let mut readers = CollaborationReaders::new(stdout, stderr);

    let status = loop {
        if let Err(reason) = invocation.checkpoint() {
            terminate_collaboration_child(&mut child, false);
            let _ = readers.finish();
            return Err(CollaborationProcessFailure::Stopped(reason));
        }
        if let Err(failure) = readers.poll() {
            terminate_collaboration_child(&mut child, false);
            let _ = readers.finish();
            return Err(failure);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                // The root process was reaped by `try_wait`. Clean any helper
                // that outlived it before waiting for EOF on inherited pipes.
                if terminate_process_group(&mut child, true).is_err() {
                    return Err(CollaborationProcessFailure::SpawnFailed);
                }
                break status;
            }
            Ok(None) => thread::sleep(POLL_INTERVAL.min(invocation.remaining())),
            Err(_) => {
                terminate_collaboration_child(&mut child, false);
                let _ = readers.finish();
                return Err(CollaborationProcessFailure::SpawnFailed);
            }
        }
    };
    let (stdout, stderr) = readers.finish()?;
    Ok(CollaborationProcessOutput {
        status,
        stdout,
        stderr,
    })
}

fn validate_collaboration_scope(scope_root: &Path) -> Result<PathBuf, CollaborationProcessFailure> {
    let canonical =
        fs::canonicalize(scope_root).map_err(|_| CollaborationProcessFailure::SpawnFailed)?;
    let metadata = canonical
        .symlink_metadata()
        .map_err(|_| CollaborationProcessFailure::SpawnFailed)?;
    if canonical != scope_root || !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(CollaborationProcessFailure::SpawnFailed);
    }
    Ok(canonical)
}

fn terminate_collaboration_child(child: &mut Child, already_reaped: bool) {
    if terminate_process_group(child, already_reaped).is_err() && !already_reaped {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn spawn_collaboration_reader(
    mut reader: impl Read + Send + 'static,
) -> JoinHandle<Result<Vec<u8>, CollaborationReadFailure>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        reader
            .by_ref()
            .take((MAX_COLLABORATION_STREAM_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| CollaborationReadFailure::Io)?;
        if bytes.len() > MAX_COLLABORATION_STREAM_BYTES {
            return Err(CollaborationReadFailure::OutputTooLarge);
        }
        Ok(bytes)
    })
}

fn poll_collaboration_reader(
    reader: &mut Option<JoinHandle<Result<Vec<u8>, CollaborationReadFailure>>>,
    bytes: &mut Option<Vec<u8>>,
) -> Result<(), CollaborationProcessFailure> {
    if reader.as_ref().is_some_and(JoinHandle::is_finished) {
        finish_collaboration_reader(reader, bytes)?;
    }
    Ok(())
}

fn finish_collaboration_reader(
    reader: &mut Option<JoinHandle<Result<Vec<u8>, CollaborationReadFailure>>>,
    bytes: &mut Option<Vec<u8>>,
) -> Result<(), CollaborationProcessFailure> {
    let Some(reader) = reader.take() else {
        return Ok(());
    };
    let result = reader
        .join()
        .map_err(|_| CollaborationProcessFailure::SpawnFailed)?;
    *bytes = Some(match result {
        Ok(bytes) => bytes,
        Err(CollaborationReadFailure::Io) => {
            return Err(CollaborationProcessFailure::SpawnFailed);
        }
        Err(CollaborationReadFailure::OutputTooLarge) => {
            return Err(CollaborationProcessFailure::OutputTooLarge);
        }
    });
    Ok(())
}

fn run_bounded(
    executable: impl AsRef<OsStr>,
    args: &[OsString],
    current_dir: &Path,
    timeout: Duration,
) -> Result<ProcessOutput, AdapterFailure> {
    let cancellation = Arc::new(AtomicBool::new(false));
    run_bounded_controlled(
        executable,
        args,
        current_dir,
        timeout,
        &cancellation,
        None,
        &mut || {},
        &mut || {},
        &mut |_| {},
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "Keep lifecycle callbacks explicit at the process boundary."
)]
fn run_bounded_controlled(
    executable: impl AsRef<OsStr>,
    args: &[OsString],
    current_dir: &Path,
    timeout: Duration,
    cancellation: &Arc<AtomicBool>,
    lease: Option<&fs::File>,
    on_spawn: &mut impl FnMut(),
    heartbeat: &mut impl FnMut(),
    on_stdout_line: &mut impl FnMut(&[u8]),
) -> Result<ProcessOutput, AdapterFailure> {
    if cancellation.load(Ordering::Acquire) {
        return Err(AdapterFailure::Cancelled);
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(current_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    inherit_process_lease(&mut command, lease);
    let mut child = command.spawn().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied => AdapterFailure::Unavailable,
        _ => AdapterFailure::SpawnFailed,
    })?;
    let stdout = child.stdout.take().ok_or(AdapterFailure::SpawnFailed)?;
    let stderr = child.stderr.take().ok_or(AdapterFailure::SpawnFailed)?;
    let stdout_reader = spawn_line_reader(stdout);
    let stderr_reader = spawn_reader(stderr);
    on_spawn();
    let started_at = Instant::now();
    let mut last_heartbeat = started_at;
    let status = loop {
        drain_line_reader(&stdout_reader, on_stdout_line)?;
        if cancellation.load(Ordering::Acquire) {
            let _ = terminate_process_group(&mut child, false);
            return Err(AdapterFailure::Cancelled);
        }
        if last_heartbeat.elapsed() >= Duration::from_secs(10) {
            heartbeat();
            last_heartbeat = Instant::now();
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                // The root exited. Reap its helpers before waiting for inherited output pipes.
                terminate_process_group(&mut child, true)
                    .map_err(|_| AdapterFailure::SpawnFailed)?;
                break status;
            }
            Ok(None) if started_at.elapsed() < timeout => thread::sleep(POLL_INTERVAL),
            Ok(None) => {
                let _ = terminate_process_group(&mut child, false);
                return Err(AdapterFailure::TimedOut);
            }
            Err(_) => {
                let _ = terminate_process_group(&mut child, false);
                return Err(AdapterFailure::SpawnFailed);
            }
        }
    };
    let remaining = timeout.saturating_sub(started_at.elapsed());
    let stdout =
        receive_line_reader(stdout_reader, remaining, on_stdout_line).inspect_err(|_| {
            let _ = terminate_process_group(&mut child, true);
        })?;
    let stderr = receive_reader(stderr_reader, remaining).inspect_err(|_| {
        let _ = terminate_process_group(&mut child, true);
    })?;
    Ok(ProcessOutput {
        success: status.success(),
        stdout,
        stderr,
    })
}

pub(crate) fn inherit_process_lease(command: &mut Command, lease: Option<&fs::File>) {
    #[cfg(unix)]
    if let Some(lease) = lease {
        use std::os::{fd::AsRawFd, unix::process::CommandExt};
        let descriptor = lease.as_raw_fd();
        // Change only the child descriptor. Other host subprocesses cannot inherit this lease.
        unsafe {
            command.pre_exec(move || {
                let flags = libc::fcntl(descriptor, libc::F_GETFD);
                if flags < 0
                    || libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    let _ = (command, lease);
}

fn read_bounded(reader: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_ADAPTER_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_ADAPTER_OUTPUT_BYTES {
        return Err(io::Error::other("adapter output exceeded limit"));
    }
    Ok(bytes)
}

fn spawn_reader(reader: impl Read + Send + 'static) -> Receiver<io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(read_bounded(reader));
    });
    receiver
}

struct LineReader {
    lines: Receiver<Vec<u8>>,
    output: Receiver<io::Result<Vec<u8>>>,
}

fn spawn_line_reader(reader: impl Read + Send + 'static) -> LineReader {
    let (line_sender, lines) = mpsc::channel();
    let (output_sender, output_receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(reader.take((MAX_ADAPTER_OUTPUT_BYTES + 1) as u64));
        let mut output = Vec::new();
        let result = loop {
            let mut line = Vec::new();
            let read = match reader.read_until(b'\n', &mut line) {
                Ok(read) => read,
                Err(error) => break Err(error),
            };
            if read == 0 {
                break Ok(output);
            }
            if output.len().saturating_add(line.len()) > MAX_ADAPTER_OUTPUT_BYTES {
                break Err(io::Error::other("adapter output exceeded limit"));
            }
            output.extend_from_slice(&line);
            if line_sender.send(line).is_err() {
                return;
            }
        };
        let _ = output_sender.send(result);
    });
    LineReader {
        lines,
        output: output_receiver,
    }
}

fn drain_line_reader(
    reader: &LineReader,
    on_line: &mut impl FnMut(&[u8]),
) -> Result<(), AdapterFailure> {
    loop {
        match reader.lines.try_recv() {
            Ok(line) => on_line(&line),
            Err(mpsc::TryRecvError::Empty) => return Ok(()),
            Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
        }
    }
}

fn receive_line_reader(
    reader: LineReader,
    timeout: Duration,
    on_line: &mut impl FnMut(&[u8]),
) -> Result<Vec<u8>, AdapterFailure> {
    let output = match reader.output.recv_timeout(timeout) {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err(AdapterFailure::OutputTooLarge),
        Err(RecvTimeoutError::Timeout) => return Err(AdapterFailure::TimedOut),
        Err(RecvTimeoutError::Disconnected) => return Err(AdapterFailure::SpawnFailed),
    };
    for line in reader.lines.try_iter() {
        on_line(&line);
    }
    Ok(output)
}

fn receive_reader(
    receiver: Receiver<io::Result<Vec<u8>>>,
    timeout: Duration,
) -> Result<Vec<u8>, AdapterFailure> {
    match receiver.recv_timeout(timeout) {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(_)) => Err(AdapterFailure::OutputTooLarge),
        Err(RecvTimeoutError::Timeout) => Err(AdapterFailure::TimedOut),
        Err(RecvTimeoutError::Disconnected) => Err(AdapterFailure::SpawnFailed),
    }
}

fn preferred_output(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(stderr).trim().to_owned();
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n\n{stderr}"),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => "The provider completed without textual output.".to_owned(),
    }
}

fn parse_codex_event(line: &[u8]) -> Option<AgentProcessEvent> {
    let event = serde_json::from_slice::<Value>(line).ok()?;
    let event_type = event.get("type").and_then(Value::as_str)?;
    match event_type {
        "turn.started" => Some(managed_event(
            AgentProcessEventKind::Thinking,
            "Codex analyzes the task.",
        )),
        "turn.completed" => Some(managed_event(
            AgentProcessEventKind::Completed,
            "Codex completed the task.",
        )),
        "item.started" | "item.completed" => {
            let item = event.get("item")?;
            let item_type = item.get("type").and_then(Value::as_str)?;
            match item_type {
                "request_user_input" | "user_input_request" if event_type == "item.started" => {
                    Some(managed_event(
                        AgentProcessEventKind::NeedsQuestion,
                        "Agent has a question.",
                    ))
                }
                "approval_request" | "exec_approval_request" | "apply_patch_approval_request"
                    if event_type == "item.started" =>
                {
                    Some(managed_event(
                        AgentProcessEventKind::NeedsAccess,
                        "Agent needs access.",
                    ))
                }
                "agent_message" if event_type == "item.completed" => {
                    let text = item.get("text").and_then(Value::as_str)?;
                    let change_request_proposals = parse_agent_change_request_proposals(text);
                    bounded_agent_message(text)
                        .or_else(|| {
                            (!change_request_proposals.is_empty())
                                .then(|| "Codex prepared a change request.".to_owned())
                        })
                        .map(|summary| AgentProcessEvent {
                            kind: AgentProcessEventKind::AgentUpdate,
                            summary,
                            change_request_proposals,
                        })
                }
                "reasoning" => Some(managed_event(
                    AgentProcessEventKind::Thinking,
                    "Codex analyzes the task.",
                )),
                "command_execution" => Some(managed_event(
                    AgentProcessEventKind::RunsCommand,
                    "Codex runs a command.",
                )),
                "file_change" => Some(managed_event(
                    AgentProcessEventKind::EditsFiles,
                    "Codex edits files.",
                )),
                "web_search" => Some(managed_event(
                    AgentProcessEventKind::Searches,
                    "Codex searches for information.",
                )),
                "mcp_tool_call" | "tool_call" => Some(managed_event(
                    AgentProcessEventKind::UsesTool,
                    "Codex uses a tool.",
                )),
                _ => None,
            }
        }
        _ => None,
    }
}

fn managed_event(kind: AgentProcessEventKind, summary: &str) -> AgentProcessEvent {
    AgentProcessEvent {
        kind,
        summary: summary.to_owned(),
        change_request_proposals: Vec::new(),
    }
}

fn bounded_agent_message(value: &str) -> Option<String> {
    let normalized = value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with(CHANGE_REQUEST_PROPOSAL_PREFIX))
        .take(4)
        .collect::<Vec<_>>()
        .join("\n");
    if normalized.is_empty() {
        return None;
    }
    let summary = normalized
        .chars()
        .filter(|character| !character.is_control() || *character == '\n')
        .take(800)
        .collect::<String>();
    (!summary.trim().is_empty()).then_some(summary)
}

fn bounded_codex_output(stdout: &[u8], stderr: &[u8], succeeded: bool) -> String {
    let stderr_text = String::from_utf8_lossy(stderr).trim().to_owned();
    let final_message = stdout
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter_map(|event| {
            if event.get("type").and_then(Value::as_str) != Some("item.completed") {
                return None;
            }
            let item = event.get("item")?;
            if item.get("type").and_then(Value::as_str) != Some("agent_message") {
                return None;
            }
            item.get("text").and_then(Value::as_str).map(str::to_owned)
        })
        .next_back();
    let output = match (final_message, stderr_text.is_empty(), succeeded) {
        (Some(message), _, true) | (Some(message), true, false) => message.trim().to_owned(),
        (Some(message), false, false) => format!("{}\n\n{}", message.trim(), stderr_text),
        (None, _, _) => preferred_output(stdout, stderr),
    };
    bound_utf8(output, MAX_ADAPTER_OUTPUT_BYTES)
}

fn bound_utf8(mut output: String, maximum_bytes: usize) -> String {
    if output.len() <= maximum_bytes {
        return output;
    }
    let mut boundary = maximum_bytes;
    while !output.is_char_boundary(boundary) {
        boundary -= 1;
    }
    output.truncate(boundary);
    output
}

fn elapsed_ms(started_at: Instant) -> u64 {
    u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::{
        CollaborationControl, CollaborationCoordinator, CollaborationLimits, CollaborationPlan,
        CollaborationTask, CollaborationTaskId, CollaborationTaskState,
    };
    use std::{fs, thread, time::Duration};
    use tempfile::tempdir;

    #[test]
    fn codex_resolver_finds_the_vscode_extension_binary() {
        let directory = tempdir().expect("temporary directory");
        let executable = directory
            .path()
            .join(".vscode/extensions/openai.chatgpt-26.900.0")
            .join(codex_extension_binary_path());
        fs::create_dir_all(executable.parent().expect("executable parent"))
            .expect("extension directory");
        fs::write(&executable, b"fake codex").expect("Codex executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
                .expect("executable permissions");
        }

        assert_eq!(
            resolve_codex_executable_from_home(OsStr::new("codex"), Some(directory.path())),
            executable.into_os_string(),
        );
    }

    #[test]
    fn codex_resolver_preserves_a_configured_executable() {
        let configured = OsStr::new("/trusted/tools/codex");
        assert_eq!(
            resolve_codex_executable_from_home(configured, None),
            configured,
        );
    }

    #[cfg(unix)]
    fn fake_codex(executable: &Path, marker: &str, mode: u32) {
        use std::os::unix::fs::PermissionsExt;

        fs::create_dir_all(executable.parent().expect("executable parent"))
            .expect("executable directory");
        fs::write(
            executable,
            format!("#!/bin/sh\nprintf '%s\\n' '{marker}'\n"),
        )
        .expect("fake Codex executable");
        fs::set_permissions(executable, fs::Permissions::from_mode(mode))
            .expect("executable permissions");
    }

    #[cfg(unix)]
    fn run_fake_codex(executable: OsString, workspace: &Path) -> AgentRunResult {
        ProcessWorkspaceAdapter::default()
            .with_agent_executable(AgentProvider::Codex, executable)
            .run_agent(
                Uuid::nil(),
                AgentProvider::Codex,
                workspace,
                "Inspect the fixture.",
                &Arc::new(AtomicBool::new(false)),
                || {},
                || {},
                |_| {},
            )
            .expect("fake Codex process")
    }

    #[cfg(unix)]
    #[test]
    fn codex_agent_runs_the_path_executable_before_home_fallbacks() {
        let directory = tempdir().expect("temporary directory");
        let path_directory = directory.path().join("path-bin");
        let home = directory.path().join("home");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace directory");
        fake_codex(&path_directory.join("codex"), "PATH_CODEX", 0o700);
        fake_codex(&home.join(".local/bin/codex"), "FALLBACK_CODEX", 0o700);

        for search_path in [path_directory.into_os_string(), OsString::from("path-bin")] {
            let child = Command::new(std::env::current_exe().expect("test executable"))
                .args([
                    "--exact",
                    "adapter::tests::codex_agent_path_resolution_child",
                    "--nocapture",
                ])
                .current_dir(directory.path())
                .env("WTS_TEST_CODEX_WORKSPACE", &workspace)
                .env("HOME", &home)
                .env("PATH", search_path)
                .output()
                .expect("isolated test process");

            assert!(
                child.status.success(),
                "isolated Codex process failed: {}{}",
                String::from_utf8_lossy(&child.stdout),
                String::from_utf8_lossy(&child.stderr),
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_agent_path_resolution_child() {
        let Some(workspace) = std::env::var_os("WTS_TEST_CODEX_WORKSPACE") else {
            return;
        };
        let result = run_fake_codex(OsString::from("codex"), Path::new(&workspace));
        assert!(result.succeeded);
        assert_eq!(result.output, "PATH_CODEX");
    }

    #[cfg(unix)]
    #[test]
    fn codex_agent_skips_a_home_fallback_without_execute_permission() {
        let directory = tempdir().expect("temporary directory");
        fake_codex(
            &directory.path().join(".local/bin/codex"),
            "UNEXECUTABLE_CODEX",
            0o600,
        );
        let extension = directory
            .path()
            .join(".vscode/extensions/openai.chatgpt-26.900.0")
            .join(codex_extension_binary_path());
        fake_codex(&extension, "EXTENSION_CODEX", 0o700);

        let executable =
            resolve_codex_executable_from_home(OsStr::new("codex"), Some(directory.path()));
        let result = run_fake_codex(executable, directory.path());

        assert!(result.succeeded);
        assert_eq!(result.output, "EXTENSION_CODEX");
    }

    #[test]
    fn collaboration_confinement_is_codex_only() {
        let adapter = ProcessCollaborationAdapter::default();
        #[cfg(unix)]
        assert_eq!(
            adapter.confinement(AgentProvider::Codex),
            CollaborationConfinement::WorkspaceWriteIsolated
        );
        #[cfg(not(unix))]
        assert_eq!(
            adapter.confinement(AgentProvider::Codex),
            CollaborationConfinement::Unverified
        );
        assert_eq!(
            adapter.confinement(AgentProvider::OpenCode),
            CollaborationConfinement::Unverified
        );
        assert_eq!(
            adapter.confinement(AgentProvider::Hermes),
            CollaborationConfinement::Unverified
        );
    }

    #[cfg(unix)]
    #[test]
    fn conversation_child_keeps_exclusive_lease_after_host_descriptor_closes() {
        use std::{io::Write, os::fd::AsRawFd};
        let directory = tempdir().unwrap();
        let path = directory.path().join("turn.lease");
        let lease = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        assert_eq!(
            unsafe { libc::flock(lease.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        let mut command = Command::new("sh");
        command.args(["-c", "read release"]).stdin(Stdio::piped());
        inherit_process_lease(&mut command, Some(&lease));
        let mut child = command.spawn().unwrap();
        drop(lease);
        let contender = fs::OpenOptions::new().write(true).open(&path).unwrap();
        let result = unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result == 0 {
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_UN) };
        }
        child.stdin.take().unwrap().write_all(b"release\n").unwrap();
        assert!(child.wait().unwrap().success());
        assert_ne!(
            result, 0,
            "a surviving child must block another workspace writer"
        );
        assert_eq!(
            unsafe { libc::flock(contender.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn controlled_agent_run_cancels_and_reaps_the_owned_process_group() {
        let directory = tempdir().expect("temporary directory");
        let descendant_file = directory.path().join("agent-descendant.pid");
        let args = vec![
            OsString::from("-c"),
            OsString::from("sleep 30 & child=$!; printf '%s' \"$child\" > \"$1\"; wait"),
            OsString::from("wts-agent-test"),
            descendant_file.as_os_str().to_owned(),
        ];
        let cancellation = Arc::new(AtomicBool::new(false));
        let worker_cancellation = Arc::clone(&cancellation);
        let workdir = directory.path().to_owned();
        let worker = thread::spawn(move || {
            run_bounded_controlled(
                "sh",
                &args,
                &workdir,
                Duration::from_secs(5),
                &worker_cancellation,
                None,
                &mut || {},
                &mut || {},
                &mut |_| {},
            )
        });
        let descendant = wait_for_pid(&descendant_file);

        cancellation.store(true, Ordering::Release);
        assert!(matches!(
            worker.join().expect("worker"),
            Err(AdapterFailure::Cancelled)
        ));
        assert_process_gone(descendant);
    }

    #[cfg(unix)]
    #[test]
    fn exited_provider_does_not_wait_for_inherited_output_pipes() {
        for (redirect, code) in [("", "0"), (">&2", "7")] {
            let directory = tempdir().unwrap();
            let pid_path = directory.path().join("descendant.pid");
            let script = format!(
                "sleep 30 {redirect} & child=$!; printf '%s' \"$child\" > \"$1\"; printf '%s\\n' '{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"FINAL_REPLY_MARKER\"}}}}' '{{\"type\":\"turn.completed\"}}'; printf '%s\\n' 'provider diagnostic' >&2; exit {code}"
            );
            let mut events = Vec::new();
            let output = run_bounded_controlled(
                "/bin/sh",
                &[
                    "-c".into(),
                    script.into(),
                    "wts-inherited-pipe".into(),
                    pid_path.as_os_str().to_owned(),
                ],
                directory.path(),
                Duration::from_secs(2),
                &Arc::new(AtomicBool::new(false)),
                None,
                &mut || {},
                &mut || {},
                &mut |line| {
                    if let Some(event) = parse_codex_event(line) {
                        events.push(event);
                    }
                },
            )
            .expect("a reaped provider must not wait for inherited pipes");
            assert_eq!(output.success, code == "0");
            assert!(String::from_utf8_lossy(&output.stdout).contains("FINAL_REPLY_MARKER"));
            assert!(String::from_utf8_lossy(&output.stderr).contains("provider diagnostic"));
            assert!(
                events
                    .iter()
                    .any(|event| event.kind == AgentProcessEventKind::Completed)
            );
            assert_process_gone(wait_for_pid(&pid_path));
        }
    }

    #[cfg(unix)]
    #[test]
    fn codex_progress_is_reported_before_process_exit_without_private_event_fields() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temporary directory");
        let executable = directory.path().join("fake-codex-progress");
        fs::write(
            &executable,
            r#"#!/bin/sh
printf '%s\n' '{"type":"item.completed","item":{"type":"reasoning","text":"private reasoning"}}'
printf '%s\n' '{"type":"item.started","item":{"type":"command_execution","command":"secret command"}}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"I found the failing boundary."}}'
while [ ! -f .codex-progress-release ]; do sleep 0.05; done
printf '%s\n' '{"type":"turn.completed","usage":{"secret":"private usage"}}'
"#,
        )
        .expect("fake Codex executable");
        let mut permissions = fs::metadata(&executable)
            .expect("executable metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).expect("executable permissions");
        let adapter = ProcessWorkspaceAdapter::default()
            .with_agent_executable(AgentProvider::Codex, executable);
        let workspace = directory.path().to_owned();
        let cancellation = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            adapter.run_agent(
                Uuid::new_v4(),
                AgentProvider::Codex,
                &workspace,
                "Inspect the failure.",
                &cancellation,
                || {},
                || {},
                |event| {
                    let _ = sender.send(event);
                },
            )
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut progress = Vec::new();
        while Instant::now() < deadline {
            if let Ok(event) = receiver.recv_timeout(Duration::from_millis(50)) {
                progress.push(event);
                if progress
                    .iter()
                    .any(|event| event.kind == AgentProcessEventKind::AgentUpdate)
                {
                    break;
                }
            }
        }

        let finished_before_release = worker.is_finished();
        fs::write(directory.path().join(".codex-progress-release"), "release")
            .expect("release the fake Codex process");
        let outcome = worker.join().expect("agent worker");

        assert!(!finished_before_release);
        assert!(
            progress
                .iter()
                .any(|event| event.kind == AgentProcessEventKind::RunsCommand)
        );
        assert!(progress.iter().any(|event| {
            event.kind == AgentProcessEventKind::AgentUpdate
                && event.summary == "I found the failing boundary."
        }));
        assert!(progress.iter().all(|event| {
            !event.summary.contains("private") && !event.summary.contains("secret")
        }));
        assert!(outcome.is_ok());
    }

    #[test]
    fn codex_control_only_progress_is_not_serialized_as_an_empty_update() {
        let event = serde_json::json!({"type":"item.completed","item":{"type":"agent_message","text":"\0"}});
        assert!(parse_codex_event(&serde_json::to_vec(&event).unwrap()).is_none());
    }

    #[test]
    fn codex_input_requests_emit_only_fixed_safe_status() {
        let question = parse_codex_event(
            serde_json::json!({
                "type": "item.started",
                "item": {
                    "type": "request_user_input",
                    "questions": [{"question": "private question with secret context"}]
                }
            })
            .to_string()
            .as_bytes(),
        )
        .expect("question event");
        assert_eq!(question.kind, AgentProcessEventKind::NeedsQuestion);
        assert_eq!(question.summary, "Agent has a question.");

        let access = parse_codex_event(
            serde_json::json!({
                "type": "item.started",
                "item": {
                    "type": "approval_request",
                    "command": "private command --token secret",
                    "justification": "private reason"
                }
            })
            .to_string()
            .as_bytes(),
        )
        .expect("access event");
        assert_eq!(access.kind, AgentProcessEventKind::NeedsAccess);
        assert_eq!(access.summary, "Agent needs access.");
        assert!(!question.summary.contains("private"));
        assert!(!access.summary.contains("secret"));
    }

    #[test]
    fn codex_agent_message_extracts_bounded_change_request_proposals() {
        let event = parse_codex_event(
            serde_json::json!({
                "type": "item.completed",
                "item": {
                    "type": "agent_message",
                    "text": "Pushed and verified.\nWTS_CHANGE_REQUEST_PROPOSAL: {\"schemaVersion\":1,\"repositoryId\":\"repo_checkout\",\"sourceHeadCommitOid\":\"0123456789abcdef0123456789abcdef01234567\",\"title\":\"PLATFORM-42: Validate admission\",\"body\":\"## Summary\\n\\nValidate admission.\",\"issueKeys\":[\"PLATFORM-42\"]}"
                }
            })
            .to_string()
            .as_bytes(),
        )
        .expect("agent update");
        assert_eq!(event.summary, "Pushed and verified.");
        assert_eq!(event.change_request_proposals.len(), 1);
        assert_eq!(
            event.change_request_proposals[0].repository_id,
            "repo_checkout"
        );
        assert_eq!(
            event.change_request_proposals[0].issue_keys,
            vec!["PLATFORM-42"]
        );
        assert!(!event.summary.contains("WTS_CHANGE_REQUEST_PROPOSAL"));
    }

    #[cfg(unix)]
    #[test]
    fn codex_arguments_are_fixed_and_option_like_prompts_are_positional() {
        let fixture = fake_codex_fixture();
        let prompt = "-option-looking-prompt";
        let report = execute_one(
            ProcessCollaborationAdapter::for_test_executable(&fixture.executable),
            &fixture.workspace,
            prompt,
            Duration::from_secs(5),
            &CollaborationControl::default(),
        );

        assert_eq!(report.tasks[0].state, CollaborationTaskState::Succeeded);
        assert_eq!(report.tasks[0].output, "finished safely");
        let arguments = fs::read_to_string(fixture.workspace.join("adapter-args"))
            .expect("recorded arguments")
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        assert_eq!(
            arguments,
            vec![
                "exec",
                "--ephemeral",
                "--json",
                "--sandbox",
                "workspace-write",
                "--ignore-user-config",
                "--strict-config",
                "--disable",
                "plugins",
                "--disable",
                "remote_plugin",
                "--disable",
                "apps",
                "--disable",
                "hooks",
                "--disable",
                "multi_agent",
                "--disable",
                "browser_use",
                "--disable",
                "computer_use",
                "--disable",
                "image_generation",
                "--disable",
                "in_app_browser",
                "-c",
                "approval_policy=\"never\"",
                "-c",
                "sandbox_workspace_write.writable_roots=[]",
                "-c",
                "sandbox_workspace_write.network_access=false",
                "-c",
                "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                "-c",
                "sandbox_workspace_write.exclude_slash_tmp=true",
                "-c",
                "shell_environment_policy.inherit=\"core\"",
                "--color",
                "never",
                "--skip-git-repo-check",
                "--cd",
                fixture.workspace.to_str().expect("UTF-8 fixture path"),
                "--",
                prompt,
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_terminates_and_reaps_the_owned_descendant_group() {
        let fixture = fake_codex_fixture();
        let adapter = ProcessCollaborationAdapter::for_test_executable(fixture.executable.clone());
        let coordinator = CollaborationCoordinator::new(adapter, CollaborationLimits::default())
            .expect("coordinator");
        let task_id = CollaborationTaskId::parse("cancel-agent").expect("task ID");
        let plan = single_task_plan(
            task_id.clone(),
            &fixture.workspace,
            "wait-for-cancel",
            Duration::from_secs(5),
        );
        let control = CollaborationControl::default();
        let worker_control = control.clone();
        let worker =
            thread::spawn(move || coordinator.execute(plan, &worker_control).expect("report"));
        let descendant_file = fixture.workspace.join("descendant.pid");
        let descendant = wait_for_pid(&descendant_file);

        assert!(control.cancel_task(&task_id));
        let report = worker.join().expect("coordinator thread");

        assert_eq!(report.tasks[0].state, CollaborationTaskState::Cancelled);
        assert_process_gone(descendant);
    }

    #[cfg(unix)]
    #[test]
    fn deadline_terminates_and_reaps_the_owned_descendant_group() {
        let fixture = fake_codex_fixture();
        let report = execute_one(
            ProcessCollaborationAdapter::for_test_executable(&fixture.executable),
            &fixture.workspace,
            "wait-for-cancel",
            Duration::from_secs(2),
            &CollaborationControl::default(),
        );

        assert_eq!(report.tasks[0].state, CollaborationTaskState::TimedOut);
        assert_process_gone(wait_for_pid(&fixture.workspace.join("descendant.pid")));
    }

    #[cfg(unix)]
    #[test]
    fn nonzero_codex_exit_is_a_provider_failure_with_bounded_diagnostics() {
        let fixture = fake_codex_fixture();
        let report = execute_one(
            ProcessCollaborationAdapter::for_test_executable(&fixture.executable),
            &fixture.workspace,
            "provider-failure",
            Duration::from_secs(5),
            &CollaborationControl::default(),
        );

        assert_eq!(
            report.tasks[0].state,
            CollaborationTaskState::ProviderFailed
        );
        assert_eq!(
            report.tasks[0].failure,
            Some(CollaborationAdapterFailure::ProviderFailed)
        );
        assert_eq!(report.tasks[0].output, "provider rejected request");
    }

    #[cfg(unix)]
    #[test]
    fn oversized_provider_output_is_bounded_and_kills_descendants() {
        let fixture = fake_codex_fixture();
        let report = execute_one(
            ProcessCollaborationAdapter::for_test_executable(&fixture.executable),
            &fixture.workspace,
            "overflow",
            Duration::from_secs(5),
            &CollaborationControl::default(),
        );

        assert_eq!(
            report.tasks[0].state,
            CollaborationTaskState::ProviderFailed
        );
        assert_eq!(
            report.tasks[0].failure,
            Some(CollaborationAdapterFailure::ProviderFailed)
        );
        assert!(report.tasks[0].output.len() <= MAX_ADAPTER_OUTPUT_BYTES);
        assert!(report.tasks[0].output.contains("bounded output transport"));
        assert_process_gone(wait_for_pid(&fixture.workspace.join("descendant.pid")));
    }

    #[cfg(unix)]
    struct FakeCodexFixture {
        _directory: tempfile::TempDir,
        executable: PathBuf,
        workspace: PathBuf,
    }

    #[cfg(unix)]
    fn fake_codex_fixture() -> FakeCodexFixture {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("temporary fixture");
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let workspace = workspace.canonicalize().expect("canonical workspace");
        let executable = directory.path().join("fake-codex");
        fs::write(
            &executable,
            r#"#!/bin/sh
printf '%s\n' "$@" > "$PWD/adapter-args"
prompt=
for argument in "$@"; do
  prompt=$argument
done
case "$prompt" in
  wait-for-cancel)
    sleep 30 &
    descendant=$!
    printf '%s' "$descendant" > "$PWD/descendant.pid"
    wait "$descendant"
    ;;
  overflow)
    sleep 30 &
    descendant=$!
    printf '%s' "$descendant" > "$PWD/descendant.pid"
    dd if=/dev/zero bs=600000 count=1 2>/dev/null | tr '\000' 'x'
    wait "$descendant"
    ;;
  provider-failure)
    printf '%s\n' 'provider rejected request' >&2
    exit 9
    ;;
  *)
    printf '%s\n' 'non-fatal provider warning' >&2
    printf '%s\n' \
      '{"type":"thread.started","thread_id":"test"}' \
      '{"type":"item.completed","item":{"type":"agent_message","text":"finished safely"}}'
    ;;
esac
"#,
        )
        .expect("fake executable");
        let mut permissions = fs::metadata(&executable)
            .expect("fake executable metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).expect("executable permissions");
        FakeCodexFixture {
            _directory: directory,
            executable,
            workspace,
        }
    }

    #[cfg(unix)]
    fn execute_one(
        adapter: ProcessCollaborationAdapter,
        workspace: &Path,
        prompt: &str,
        timeout: Duration,
        control: &CollaborationControl,
    ) -> crate::collaboration::CollaborationReport {
        CollaborationCoordinator::new(adapter, CollaborationLimits::default())
            .expect("coordinator")
            .execute(
                single_task_plan(
                    CollaborationTaskId::parse("agent-task").expect("task ID"),
                    workspace,
                    prompt,
                    timeout,
                ),
                control,
            )
            .expect("report")
    }

    #[cfg(unix)]
    fn single_task_plan(
        task_id: CollaborationTaskId,
        workspace: &Path,
        prompt: &str,
        timeout: Duration,
    ) -> CollaborationPlan {
        CollaborationPlan {
            collaboration_id: Uuid::new_v4(),
            tasks: vec![CollaborationTask {
                task_id,
                workspace_id: Uuid::new_v4(),
                workspace_root: workspace.to_owned(),
                scope_root: workspace.to_owned(),
                provider: AgentProvider::Codex,
                prompt: prompt.to_owned(),
                phase: 0,
                timeout,
            }],
        }
    }

    #[cfg(unix)]
    fn wait_for_pid(path: &Path) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(value) = fs::read_to_string(path)
                && let Ok(process_id) = value.parse::<i32>()
            {
                return process_id;
            }
            assert!(
                Instant::now() < deadline,
                "fake provider did not publish a numeric PID at {}",
                path.display()
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    fn assert_process_gone(process_id: i32) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            // SAFETY: signal zero checks only whether the process exists.
            let result = unsafe { libc::kill(process_id, 0) };
            if result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "descendant process {process_id} survived adapter cleanup"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
