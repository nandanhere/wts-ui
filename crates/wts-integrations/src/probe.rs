use crate::model::{
    BlockingCapability, BrowserJourneyCheckStatus, BrowserJourneyDiagnosticCode,
    BrowserJourneyDiscoverySource, BrowserJourneyReadiness, BrowserJourneyReadinessCheck,
    DiagnosticCode, InstallationState, IntegrationCapability, IntegrationCategory, IntegrationId,
    IntegrationSnapshot, IntegrationStatus, RuntimeState, SetupSnapshot, SetupState,
    VerificationKind, WtsSupport,
};
use crate::open_project::{WTS_OPENPROJECT_TOKEN_ENV, WTS_OPENPROJECT_URL_ENV};
#[cfg(windows)]
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_MAX_OUTPUT_BYTES: usize = 8 * 1024;
const MAX_CONFIGURED_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_HOST_CONFIG_BYTES: u64 = 1024 * 1024;
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(10);
const MCP_ATLASSIAN_IMAGE: &str = "ghcr.io/sooperset/mcp-atlassian:latest";
const WTS_BROWSER_DRIVER_ENV: &str = "WTS_BROWSER_DRIVER";
const WTS_BROWSER_NODE_ENV: &str = "WTS_BROWSER_NODE";
const BROWSER_DRIVER_FILE: &str = "wts-browser-driver.mjs";
const PLAYWRIGHT_RESOLUTION_PROBE: &str = concat!(
    "import { createRequire } from 'node:module';",
    "const localRequire=createRequire(process.argv[1]);",
    "localRequire.resolve('playwright/package.json');"
);
const CHROMIUM_AVAILABILITY_PROBE: &str = concat!(
    "import { createRequire } from 'node:module';",
    "import { accessSync, constants, statSync } from 'node:fs';",
    "const localRequire=createRequire(process.argv[1]);",
    "const { chromium }=localRequire('playwright');",
    "const executable=chromium.executablePath();",
    "if(!executable||!statSync(executable).isFile())process.exit(2);",
    "accessSync(executable,constants.R_OK|constants.X_OK);"
);

pub const WTS_JIRA_MCP_URL_ENV: &str = "WTS_JIRA_MCP_URL";

const EXECUTABLE_PROBES: [ExecutableProbe; 6] = [
    ExecutableProbe {
        id: IntegrationId::Git,
        category: IntegrationCategory::SourceControl,
        executable: "git",
        blocking_capability: BlockingCapability::WorktreeMaterialization,
    },
    ExecutableProbe {
        id: IntegrationId::Vscode,
        category: IntegrationCategory::Editor,
        executable: "code",
        blocking_capability: BlockingCapability::VscodeLaunch,
    },
    ExecutableProbe {
        id: IntegrationId::Codex,
        category: IntegrationCategory::Agent,
        executable: "codex",
        blocking_capability: BlockingCapability::CodexLaunch,
    },
    ExecutableProbe {
        id: IntegrationId::OpenCode,
        category: IntegrationCategory::Agent,
        executable: "opencode",
        blocking_capability: BlockingCapability::OpenCodeLaunch,
    },
    ExecutableProbe {
        id: IntegrationId::Hermes,
        category: IntegrationCategory::Agent,
        executable: "hermes",
        blocking_capability: BlockingCapability::HermesLaunch,
    },
    ExecutableProbe {
        id: IntegrationId::Graphify,
        category: IntegrationCategory::KnowledgeGraph,
        executable: "graphify",
        blocking_capability: BlockingCapability::GraphIndexing,
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ExecutableProbe {
    id: IntegrationId,
    category: IntegrationCategory,
    executable: &'static str,
    blocking_capability: BlockingCapability,
}

#[derive(Clone, Debug)]
enum BrowserFileCandidate {
    Ready {
        path: PathBuf,
        source: BrowserJourneyDiscoverySource,
    },
    Invalid {
        source: BrowserJourneyDiscoverySource,
    },
    Missing,
}

impl ExecutableProbe {
    fn capabilities(self) -> Vec<IntegrationCapability> {
        let capability = match self.id {
            IntegrationId::Git => IntegrationCapability::WorktreeMaterialization,
            IntegrationId::Vscode => IntegrationCapability::WorkspaceLaunch,
            IntegrationId::Warp => IntegrationCapability::TerminalSession,
            IntegrationId::Codex | IntegrationId::OpenCode | IntegrationId::Hermes => {
                IntegrationCapability::AgentSession
            }
            IntegrationId::Graphify => IntegrationCapability::GraphIndexing,
            IntegrationId::JiraMcp => IntegrationCapability::JiraIssueImport,
            IntegrationId::OpenProject => IntegrationCapability::OpenProjectWorkPackageImport,
        };
        vec![capability]
    }

    fn requires_unverified_auth(self) -> bool {
        matches!(
            self.id,
            IntegrationId::Codex | IntegrationId::OpenCode | IntegrationId::Hermes
        )
    }

    fn wts_support(self) -> WtsSupport {
        WtsSupport::Available
    }
}

/// Host-owned configuration signals. Values are booleans so credentials and
/// endpoint URLs cannot cross the detector's public output boundary.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum JiraMcpRegistration {
    #[default]
    None,
    WtsEndpointSignal,
    VscodeRegistration,
    VscodePodmanRegistration,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostIntegrationSignals {
    jira_mcp_registration: JiraMcpRegistration,
    openproject_url_configured: bool,
    openproject_token_configured: bool,
    warp_app_available: bool,
}

impl HostIntegrationSignals {
    pub const fn new(jira_mcp_configured: bool) -> Self {
        Self {
            jira_mcp_registration: if jira_mcp_configured {
                JiraMcpRegistration::WtsEndpointSignal
            } else {
                JiraMcpRegistration::None
            },
            openproject_url_configured: false,
            openproject_token_configured: false,
            warp_app_available: false,
        }
    }

    pub const fn with_openproject(mut self, url_configured: bool, token_configured: bool) -> Self {
        self.openproject_url_configured = url_configured;
        self.openproject_token_configured = token_configured;
        self
    }

    pub const fn with_warp_app(mut self, available: bool) -> Self {
        self.warp_app_available = available;
        self
    }

    /// Treats a non-empty `WTS_JIRA_MCP_URL` as a host-managed configuration
    /// signal. When it is absent, recognizes a Jira MCP registration in VS
    /// Code's user MCP configuration without retaining any command, URL, or
    /// credential value.
    pub fn from_env() -> Self {
        let jira_mcp_registration = if env_value_is_present(WTS_JIRA_MCP_URL_ENV) {
            JiraMcpRegistration::WtsEndpointSignal
        } else if let Some(registration) = vscode_jira_mcp_registration() {
            registration
        } else {
            JiraMcpRegistration::None
        };
        Self {
            jira_mcp_registration,
            openproject_url_configured: env_value_is_present(WTS_OPENPROJECT_URL_ENV),
            openproject_token_configured: env_value_is_present(WTS_OPENPROJECT_TOKEN_ENV),
            warp_app_available: warp_app_is_installed(),
        }
    }

    pub const fn jira_mcp_configured(self) -> bool {
        !matches!(self.jira_mcp_registration, JiraMcpRegistration::None)
    }

    const fn jira_mcp_registration(self) -> JiraMcpRegistration {
        self.jira_mcp_registration
    }

    pub const fn openproject_url_configured(self) -> bool {
        self.openproject_url_configured
    }

    pub const fn openproject_token_configured(self) -> bool {
        self.openproject_token_configured
    }
}

#[cfg(target_os = "macos")]
fn warp_app_is_installed() -> bool {
    Path::new("/Applications/Warp.app").is_dir()
        || std::env::var_os("HOME")
            .map(PathBuf::from)
            .is_some_and(|home| home.join("Applications/Warp.app").is_dir())
}

#[cfg(not(target_os = "macos"))]
const fn warp_app_is_installed() -> bool {
    false
}

fn env_value_is_present(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| !value.is_empty())
}

fn vscode_jira_mcp_registration() -> Option<JiraMcpRegistration> {
    vscode_mcp_config_paths().iter().find_map(|path| {
        let Ok(metadata) = fs::metadata(path) else {
            return None;
        };
        if !metadata.is_file() || metadata.len() > MAX_HOST_CONFIG_BYTES {
            return None;
        }
        fs::read(path)
            .ok()
            .and_then(|contents| classify_jira_mcp_registration(&contents))
    })
}

fn vscode_mcp_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        let user_root = PathBuf::from(home).join("Library/Application Support");
        paths.push(user_root.join("Code/User/mcp.json"));
        paths.push(user_root.join("Code - Insiders/User/mcp.json"));
        paths.push(user_root.join("VSCodium/User/mcp.json"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(home) = std::env::var_os("HOME") {
        let config_root = PathBuf::from(home).join(".config");
        paths.push(config_root.join("Code/User/mcp.json"));
        paths.push(config_root.join("Code - Insiders/User/mcp.json"));
        paths.push(config_root.join("VSCodium/User/mcp.json"));
    }

    #[cfg(windows)]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        let config_root = PathBuf::from(app_data);
        paths.push(config_root.join("Code/User/mcp.json"));
        paths.push(config_root.join("Code - Insiders/User/mcp.json"));
        paths.push(config_root.join("VSCodium/User/mcp.json"));
    }

    paths
}

fn classify_jira_mcp_registration(contents: &[u8]) -> Option<JiraMcpRegistration> {
    let normalized = String::from_utf8_lossy(contents).to_ascii_lowercase();
    let jira_identity = normalized.contains("\"mcp-atlassian\"")
        || normalized.contains("\"jira_url\"")
        || normalized.contains("\"jiraurl\"");
    let server_shape = normalized.contains("\"servers\"")
        && (normalized.contains("\"command\"") || normalized.contains("\"url\""));
    if !jira_identity || !server_shape {
        return None;
    }
    if normalized.contains("\"podman\"") && normalized.contains(MCP_ATLASSIAN_IMAGE) {
        Some(JiraMcpRegistration::VscodePodmanRegistration)
    } else {
        Some(JiraMcpRegistration::VscodeRegistration)
    }
}

/// Resolution is injectable so unit tests and embedding hosts do not depend on
/// the process PATH.
pub trait PathResolver {
    fn resolve(&self, executable: &str) -> Result<Option<PathBuf>, ProbeFailure>;
}

/// Execution is injectable so all detector behavior can be tested without
/// launching machine-local tools.
pub trait CommandRunner {
    fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure>;
}

#[derive(Clone, Copy, Debug)]
pub struct CommandProbe<'a> {
    pub executable: &'a Path,
    pub args: &'a [&'a str],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProbeOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl ProbeOutput {
    pub fn new(stdout: impl Into<Vec<u8>>, stderr: impl Into<Vec<u8>>) -> Self {
        Self {
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    pub fn stdout(&self) -> &[u8] {
        &self.stdout
    }

    pub fn stderr(&self) -> &[u8] {
        &self.stderr
    }
}

/// Failure kinds are intentionally free of raw OS messages, paths, and command
/// output so callers cannot accidentally expose local details.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeFailure {
    Resolution,
    Spawn,
    TimedOut,
    UnsuccessfulExit,
    OutputUnavailable,
}

impl ProbeFailure {
    fn safe_detail(self) -> &'static str {
        match self {
            Self::Resolution => "Executable discovery failed.",
            Self::Spawn => "The executable was found, but its version probe could not start.",
            Self::TimedOut => "The executable version probe timed out.",
            Self::UnsuccessfulExit => "The executable version probe returned an error.",
            Self::OutputUnavailable => "The executable version output could not be read safely.",
        }
    }

    fn diagnostic_code(self) -> DiagnosticCode {
        match self {
            Self::Resolution => DiagnosticCode::ExecutableDiscoveryFailed,
            Self::TimedOut => DiagnosticCode::VersionProbeTimedOut,
            Self::Spawn | Self::UnsuccessfulExit | Self::OutputUnavailable => {
                DiagnosticCode::VersionProbeFailed
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemPathResolver;

impl PathResolver for SystemPathResolver {
    fn resolve(&self, executable: &str) -> Result<Option<PathBuf>, ProbeFailure> {
        if executable.is_empty()
            || Path::new(executable).components().count() != 1
            || executable != Path::new(executable).as_os_str()
        {
            return Err(ProbeFailure::Resolution);
        }

        if let Some(path) = std::env::var_os("PATH") {
            for directory in std::env::split_paths(&path) {
                for candidate in executable_candidates(&directory, executable) {
                    if is_executable_file(&candidate) {
                        return Ok(Some(candidate));
                    }
                }
            }
        }

        // A macOS application launched from Finder does not inherit the user's shell PATH.
        // Check only fixed package-manager directories after the normal PATH lookup.
        #[cfg(target_os = "macos")]
        for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"] {
            for candidate in executable_candidates(Path::new(directory), executable) {
                if is_executable_file(&candidate) {
                    return Ok(Some(candidate));
                }
            }
        }
        Ok(None)
    }
}

fn executable_candidates(directory: &Path, executable: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let executable_path = Path::new(executable);
        if executable_path.extension().is_some() {
            return vec![directory.join(executable)];
        }

        let extensions = std::env::var_os("PATHEXT")
            .map(|value| {
                value
                    .to_string_lossy()
                    .split(';')
                    .filter(|extension| !extension.is_empty())
                    .map(OsString::from)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| {
                vec![
                    OsString::from(".EXE"),
                    OsString::from(".CMD"),
                    OsString::from(".BAT"),
                ]
            });
        let mut candidates = vec![directory.join(executable)];
        candidates.extend(extensions.into_iter().map(|extension| {
            let mut name = OsString::from(executable);
            name.push(extension);
            directory.join(name)
        }));
        candidates
    }

    #[cfg(not(windows))]
    {
        vec![directory.join(executable)]
    }
}

fn is_executable_file(path: &Path) -> bool {
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

#[derive(Clone, Debug)]
pub struct ProcessCommandRunner {
    timeout: Duration,
    max_output_bytes: usize,
}

impl Default for ProcessCommandRunner {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_PROBE_TIMEOUT,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
        }
    }
}

impl ProcessCommandRunner {
    pub fn new(timeout: Duration, max_output_bytes: usize) -> Self {
        Self {
            timeout,
            max_output_bytes: max_output_bytes.clamp(1, MAX_CONFIGURED_OUTPUT_BYTES),
        }
    }
}

impl CommandRunner for ProcessCommandRunner {
    fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
        let mut child = Command::new(probe.executable)
            .args(probe.args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| ProbeFailure::Spawn)?;

        let Some(stdout) = child.stdout.take() else {
            terminate(&mut child);
            return Err(ProbeFailure::OutputUnavailable);
        };
        let Some(stderr) = child.stderr.take() else {
            terminate(&mut child);
            return Err(ProbeFailure::OutputUnavailable);
        };

        let max_output_bytes = self.max_output_bytes;
        let stdout_reader = spawn_reader(stdout, max_output_bytes);
        let stderr_reader = spawn_reader(stderr, max_output_bytes);

        let started_at = Instant::now();
        let exit_status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if started_at.elapsed() < self.timeout => {
                    thread::sleep(PROBE_POLL_INTERVAL);
                }
                Ok(None) => {
                    terminate(&mut child);
                    return Err(ProbeFailure::TimedOut);
                }
                Err(_) => {
                    terminate(&mut child);
                    return Err(ProbeFailure::OutputUnavailable);
                }
            }
        };

        let stdout = receive_reader(
            stdout_reader,
            self.timeout.saturating_sub(started_at.elapsed()),
        )?;
        let stderr = receive_reader(
            stderr_reader,
            self.timeout.saturating_sub(started_at.elapsed()),
        )?;
        if !exit_status.success() {
            return Err(ProbeFailure::UnsuccessfulExit);
        }

        Ok(ProbeOutput { stdout, stderr })
    }
}

fn terminate(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn read_bounded(reader: impl Read, max_output_bytes: usize) -> io::Result<Vec<u8>> {
    let limit = u64::try_from(max_output_bytes.saturating_add(1)).unwrap_or(u64::MAX);
    let mut bytes = Vec::with_capacity(max_output_bytes.min(DEFAULT_MAX_OUTPUT_BYTES));
    reader.take(limit).read_to_end(&mut bytes)?;
    if bytes.len() > max_output_bytes {
        return Err(io::Error::other("probe output exceeded limit"));
    }
    Ok(bytes)
}

fn spawn_reader(
    reader: impl Read + Send + 'static,
    max_output_bytes: usize,
) -> Receiver<io::Result<Vec<u8>>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(read_bounded(reader, max_output_bytes));
    });
    receiver
}

fn receive_reader(
    receiver: Receiver<io::Result<Vec<u8>>>,
    remaining: Duration,
) -> Result<Vec<u8>, ProbeFailure> {
    match receiver.recv_timeout(remaining) {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) => Err(ProbeFailure::OutputUnavailable),
        Err(RecvTimeoutError::Timeout) => Err(ProbeFailure::TimedOut),
    }
}

fn browser_helper_candidate() -> BrowserFileCandidate {
    if let Some(configured) = std::env::var_os(WTS_BROWSER_DRIVER_ENV) {
        return validate_browser_file(
            PathBuf::from(configured),
            BrowserJourneyDiscoverySource::Configured,
            false,
        );
    }
    adjacent_browser_file(BROWSER_DRIVER_FILE).map_or(BrowserFileCandidate::Missing, |path| {
        validate_browser_file(path, BrowserJourneyDiscoverySource::Packaged, false)
    })
}

fn adjacent_browser_file(leaf: &str) -> Option<PathBuf> {
    let candidate = std::env::current_exe().ok()?.parent()?.join(leaf);
    candidate.symlink_metadata().is_ok().then_some(candidate)
}

fn validate_browser_file(
    path: PathBuf,
    source: BrowserJourneyDiscoverySource,
    executable: bool,
) -> BrowserFileCandidate {
    if !path.is_absolute() {
        return BrowserFileCandidate::Invalid { source };
    }
    let Ok(canonical) = path.canonicalize() else {
        return BrowserFileCandidate::Invalid { source };
    };
    let Ok(metadata) = canonical.symlink_metadata() else {
        return BrowserFileCandidate::Invalid { source };
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return BrowserFileCandidate::Invalid { source };
    }
    if executable && !is_executable_file(&canonical) {
        return BrowserFileCandidate::Invalid { source };
    }
    BrowserFileCandidate::Ready {
        path: canonical,
        source,
    }
}

fn readiness_check(
    source: Option<BrowserJourneyDiscoverySource>,
    detail: &str,
) -> BrowserJourneyReadinessCheck {
    BrowserJourneyReadinessCheck {
        status: BrowserJourneyCheckStatus::Ready,
        source,
        detail: detail.to_owned(),
        diagnostic_code: None,
    }
}

fn unavailable_check(
    source: Option<BrowserJourneyDiscoverySource>,
    detail: &str,
    diagnostic_code: BrowserJourneyDiagnosticCode,
) -> BrowserJourneyReadinessCheck {
    BrowserJourneyReadinessCheck {
        status: BrowserJourneyCheckStatus::Unavailable,
        source,
        detail: detail.to_owned(),
        diagnostic_code: Some(diagnostic_code),
    }
}

fn blocked_browser_check() -> BrowserJourneyReadinessCheck {
    BrowserJourneyReadinessCheck {
        status: BrowserJourneyCheckStatus::Blocked,
        source: None,
        detail: "Check skipped until Node and the fixed browser helper are available.".to_owned(),
        diagnostic_code: Some(BrowserJourneyDiagnosticCode::PrerequisiteUnavailable),
    }
}

#[derive(Clone, Debug)]
pub struct IntegrationDetector<R = SystemPathResolver, C = ProcessCommandRunner> {
    resolver: R,
    runner: C,
    host_signals: HostIntegrationSignals,
}

impl Default for IntegrationDetector {
    fn default() -> Self {
        Self {
            resolver: SystemPathResolver,
            runner: ProcessCommandRunner::default(),
            host_signals: HostIntegrationSignals::from_env(),
        }
    }
}

impl<R, C> IntegrationDetector<R, C>
where
    R: PathResolver,
    C: CommandRunner,
{
    pub fn new(resolver: R, runner: C, host_signals: HostIntegrationSignals) -> Self {
        Self {
            resolver,
            runner,
            host_signals,
        }
    }

    pub fn snapshot(&self, repository_count: usize) -> SetupSnapshot {
        self.snapshot_at(repository_count, unix_time_ms())
    }

    /// Deterministic timestamp entry point for hosts and tests that already own
    /// a clock.
    pub fn snapshot_at(&self, repository_count: usize, checked_at_unix_ms: u64) -> SetupSnapshot {
        let mut integrations = EXECUTABLE_PROBES
            .iter()
            .map(|probe| self.detect_executable(*probe, checked_at_unix_ms))
            .collect::<Vec<_>>();
        integrations.push(self.detect_warp(checked_at_unix_ms));
        integrations.push(self.detect_jira(checked_at_unix_ms));
        integrations.push(self.detect_openproject(checked_at_unix_ms));
        let browser_journey_readiness = self.detect_browser_journey();

        SetupSnapshot {
            checked_at_unix_ms,
            repository_count: u64::try_from(repository_count).unwrap_or(u64::MAX),
            integrations,
            browser_journey_readiness: Some(browser_journey_readiness),
        }
    }

    fn detect_warp(&self, checked_at_unix_ms: u64) -> IntegrationSnapshot {
        let available = self.host_signals.warp_app_available;
        IntegrationSnapshot {
            id: IntegrationId::Warp,
            category: IntegrationCategory::Terminal,
            status: if available {
                IntegrationStatus::Ready
            } else {
                IntegrationStatus::NotFound
            },
            installation: if available {
                InstallationState::Detected
            } else {
                InstallationState::Missing
            },
            setup: if available {
                SetupState::NotRequired
            } else {
                SetupState::NeedsDependency
            },
            runtime: RuntimeState::Idle,
            wts_support: WtsSupport::Available,
            verification_kind: VerificationKind::ConfigurationSignal,
            capabilities: vec![IntegrationCapability::TerminalSession],
            version: None,
            detail: Some(
                if available {
                    "Warp.app is installed and can accept workspace CLI handoffs."
                } else {
                    "Warp.app was not found in an Applications folder."
                }
                .to_owned(),
            ),
            diagnostic_code: (!available).then_some(DiagnosticCode::ExecutableMissing),
            last_probe_at: checked_at_unix_ms,
            blocking_for: if available {
                Vec::new()
            } else {
                vec![BlockingCapability::WarpLaunch]
            },
        }
    }

    fn detect_browser_journey(&self) -> BrowserJourneyReadiness {
        self.detect_browser_journey_with_candidates(
            self.browser_node_candidate(),
            browser_helper_candidate(),
        )
    }

    fn detect_browser_journey_with_candidates(
        &self,
        node_candidate: BrowserFileCandidate,
        helper_candidate: BrowserFileCandidate,
    ) -> BrowserJourneyReadiness {
        let (node_path, mut node) = match node_candidate {
            BrowserFileCandidate::Ready { path, source } => {
                let result = self.runner.run(CommandProbe {
                    executable: &path,
                    args: &["--version"],
                });
                let check = if result.is_ok() {
                    readiness_check(
                        Some(source),
                        match source {
                            BrowserJourneyDiscoverySource::Configured => {
                                "Configured Node executable answered a fixed version probe."
                            }
                            BrowserJourneyDiscoverySource::Packaged => {
                                "Packaged Node executable answered a fixed version probe."
                            }
                            BrowserJourneyDiscoverySource::Path => {
                                "Node executable found on PATH answered a fixed version probe."
                            }
                        },
                    )
                } else {
                    unavailable_check(
                        Some(source),
                        "The selected Node executable did not pass the fixed version probe.",
                        BrowserJourneyDiagnosticCode::NodeProbeFailed,
                    )
                };
                (Some(path), check)
            }
            BrowserFileCandidate::Invalid { source } => (
                None,
                unavailable_check(
                    Some(source),
                    "The configured Node executable is not a usable absolute local file.",
                    BrowserJourneyDiagnosticCode::NodeUnavailable,
                ),
            ),
            BrowserFileCandidate::Missing => (
                None,
                unavailable_check(
                    None,
                    "No usable Node executable was configured, packaged, or found on PATH.",
                    BrowserJourneyDiagnosticCode::NodeUnavailable,
                ),
            ),
        };

        let (helper_path, fixed_helper) = match helper_candidate {
            BrowserFileCandidate::Ready { path, source } => (
                Some(path),
                readiness_check(
                    Some(source),
                    match source {
                        BrowserJourneyDiscoverySource::Configured => {
                            "Configured fixed browser helper is a regular local file."
                        }
                        BrowserJourneyDiscoverySource::Packaged => {
                            "Packaged fixed browser helper is a regular local file."
                        }
                        BrowserJourneyDiscoverySource::Path => {
                            "Fixed browser helper was found as a regular local file."
                        }
                    },
                ),
            ),
            BrowserFileCandidate::Invalid { source } => (
                None,
                unavailable_check(
                    Some(source),
                    "The configured fixed browser helper is not a usable absolute local file.",
                    BrowserJourneyDiagnosticCode::FixedHelperInvalid,
                ),
            ),
            BrowserFileCandidate::Missing => (
                None,
                unavailable_check(
                    None,
                    "The fixed browser helper was not configured or packaged beside WTS.",
                    BrowserJourneyDiagnosticCode::FixedHelperUnavailable,
                ),
            ),
        };

        if node.status != BrowserJourneyCheckStatus::Ready {
            return BrowserJourneyReadiness {
                ready: false,
                node,
                fixed_helper,
                playwright: blocked_browser_check(),
                chromium: blocked_browser_check(),
            };
        }
        let Some(node_path) = node_path else {
            node = unavailable_check(
                node.source,
                "The selected Node executable could not be retained safely.",
                BrowserJourneyDiagnosticCode::NodeUnavailable,
            );
            return BrowserJourneyReadiness {
                ready: false,
                node,
                fixed_helper,
                playwright: blocked_browser_check(),
                chromium: blocked_browser_check(),
            };
        };
        if fixed_helper.status != BrowserJourneyCheckStatus::Ready {
            return BrowserJourneyReadiness {
                ready: false,
                node,
                fixed_helper,
                playwright: blocked_browser_check(),
                chromium: blocked_browser_check(),
            };
        }
        let Some(helper_path) = helper_path else {
            return BrowserJourneyReadiness {
                ready: false,
                node,
                fixed_helper: unavailable_check(
                    fixed_helper.source,
                    "The fixed browser helper could not be retained safely.",
                    BrowserJourneyDiagnosticCode::FixedHelperInvalid,
                ),
                playwright: blocked_browser_check(),
                chromium: blocked_browser_check(),
            };
        };
        let Some(helper_argument) = helper_path.to_str() else {
            return BrowserJourneyReadiness {
                ready: false,
                node,
                fixed_helper: unavailable_check(
                    fixed_helper.source,
                    "The fixed browser helper path cannot be represented safely for Node.",
                    BrowserJourneyDiagnosticCode::FixedHelperInvalid,
                ),
                playwright: blocked_browser_check(),
                chromium: blocked_browser_check(),
            };
        };

        let playwright_result = self.runner.run(CommandProbe {
            executable: &node_path,
            args: &[
                "--input-type=module",
                "--eval",
                PLAYWRIGHT_RESOLUTION_PROBE,
                helper_argument,
            ],
        });
        let playwright = match playwright_result {
            Ok(_) => readiness_check(None, "Playwright resolves beside the fixed browser helper."),
            Err(ProbeFailure::UnsuccessfulExit) => {
                return BrowserJourneyReadiness {
                    ready: false,
                    node,
                    fixed_helper,
                    playwright: unavailable_check(
                        None,
                        "Playwright does not resolve beside the fixed browser helper.",
                        BrowserJourneyDiagnosticCode::PlaywrightUnavailable,
                    ),
                    chromium: blocked_browser_check(),
                };
            }
            Err(_) => {
                return BrowserJourneyReadiness {
                    ready: false,
                    node,
                    fixed_helper,
                    playwright: unavailable_check(
                        None,
                        "The bounded Playwright resolution probe could not finish.",
                        BrowserJourneyDiagnosticCode::PlaywrightProbeFailed,
                    ),
                    chromium: blocked_browser_check(),
                };
            }
        };

        let chromium = match self.runner.run(CommandProbe {
            executable: &node_path,
            args: &[
                "--input-type=module",
                "--eval",
                CHROMIUM_AVAILABILITY_PROBE,
                helper_argument,
            ],
        }) {
            Ok(_) => readiness_check(None, "Playwright reports an installed Chromium executable."),
            Err(ProbeFailure::UnsuccessfulExit) => unavailable_check(
                None,
                "Playwright could not find a usable local Chromium executable.",
                BrowserJourneyDiagnosticCode::ChromiumUnavailable,
            ),
            Err(_) => unavailable_check(
                None,
                "The bounded Chromium availability probe could not finish.",
                BrowserJourneyDiagnosticCode::ChromiumProbeFailed,
            ),
        };

        BrowserJourneyReadiness {
            ready: chromium.status == BrowserJourneyCheckStatus::Ready,
            node,
            fixed_helper,
            playwright,
            chromium,
        }
    }

    fn browser_node_candidate(&self) -> BrowserFileCandidate {
        if let Some(configured) = std::env::var_os(WTS_BROWSER_NODE_ENV) {
            return validate_browser_file(
                PathBuf::from(configured),
                BrowserJourneyDiscoverySource::Configured,
                true,
            );
        }
        if let Some(packaged) =
            adjacent_browser_file(if cfg!(windows) { "node.exe" } else { "node" })
        {
            return validate_browser_file(packaged, BrowserJourneyDiscoverySource::Packaged, true);
        }
        match self.resolver.resolve("node") {
            Ok(Some(path)) => {
                validate_browser_file(path, BrowserJourneyDiscoverySource::Path, true)
            }
            Ok(None) | Err(_) => BrowserFileCandidate::Missing,
        }
    }

    fn detect_executable(
        &self,
        probe: ExecutableProbe,
        checked_at_unix_ms: u64,
    ) -> IntegrationSnapshot {
        let path = match self.resolver.resolve(probe.executable) {
            Ok(Some(path)) => path,
            Ok(None) => {
                return unavailable_snapshot(
                    probe,
                    IntegrationStatus::NotFound,
                    InstallationState::Missing,
                    SetupState::NeedsDependency,
                    DiagnosticCode::ExecutableMissing,
                    "Executable was not found on PATH.",
                    checked_at_unix_ms,
                );
            }
            Err(failure) => {
                return unavailable_snapshot(
                    probe,
                    IntegrationStatus::Error,
                    InstallationState::Unsupported,
                    SetupState::Incompatible,
                    failure.diagnostic_code(),
                    failure.safe_detail(),
                    checked_at_unix_ms,
                );
            }
        };

        let output = match self.runner.run(CommandProbe {
            executable: &path,
            args: &["--version"],
        }) {
            Ok(output) => output,
            Err(failure) => {
                return unavailable_snapshot(
                    probe,
                    IntegrationStatus::Error,
                    InstallationState::Detected,
                    SetupState::Incompatible,
                    failure.diagnostic_code(),
                    failure.safe_detail(),
                    checked_at_unix_ms,
                );
            }
        };

        let version = safe_version(output.stdout()).or_else(|| safe_version(output.stderr()));
        if probe.requires_unverified_auth() {
            return IntegrationSnapshot {
                id: probe.id,
                category: probe.category,
                status: IntegrationStatus::NotConfigured,
                installation: InstallationState::Detected,
                setup: SetupState::Unverified,
                runtime: RuntimeState::Idle,
                wts_support: probe.wts_support(),
                verification_kind: VerificationKind::Version,
                capabilities: probe.capabilities(),
                version,
                detail: Some(
                    "Installed; authentication was not inspected by this local probe.".to_owned(),
                ),
                diagnostic_code: Some(DiagnosticCode::AuthenticationNotVerified),
                last_probe_at: checked_at_unix_ms,
                blocking_for: Vec::new(),
            };
        }

        IntegrationSnapshot {
            id: probe.id,
            category: probe.category,
            status: IntegrationStatus::Ready,
            installation: InstallationState::Detected,
            setup: SetupState::NotRequired,
            runtime: RuntimeState::Idle,
            wts_support: probe.wts_support(),
            verification_kind: VerificationKind::Version,
            capabilities: probe.capabilities(),
            version,
            detail: None,
            diagnostic_code: None,
            last_probe_at: checked_at_unix_ms,
            blocking_for: Vec::new(),
        }
    }

    fn detect_jira(&self, checked_at_unix_ms: u64) -> IntegrationSnapshot {
        if self.host_signals.jira_mcp_configured() {
            let adapter_available = !matches!(
                self.host_signals.jira_mcp_registration(),
                JiraMcpRegistration::WtsEndpointSignal
            );
            let detail = match self.host_signals.jira_mcp_registration() {
                JiraMcpRegistration::WtsEndpointSignal => {
                    "Host-managed Jira MCP endpoint signal is present; WTS has not completed an authentication handshake."
                }
                JiraMcpRegistration::VscodeRegistration => {
                    "Jira MCP is registered in VS Code. WTS cannot share that client's session and has not imported or handshaken with it."
                }
                JiraMcpRegistration::VscodePodmanRegistration
                    if self.mcp_atlassian_container_is_running() =>
                {
                    "Jira MCP is configured and running in VS Code over stdio. WTS will start a separate process when you explicitly verify or import."
                }
                JiraMcpRegistration::VscodePodmanRegistration => {
                    "Jira MCP is registered in VS Code over stdio. WTS did not find its external container running and has not imported it."
                }
                JiraMcpRegistration::None => unreachable!("configured signal must have a source"),
            };
            IntegrationSnapshot {
                id: IntegrationId::JiraMcp,
                category: IntegrationCategory::IssueTracker,
                status: IntegrationStatus::NotConfigured,
                installation: InstallationState::Detected,
                setup: SetupState::Unverified,
                runtime: RuntimeState::Idle,
                wts_support: if adapter_available {
                    WtsSupport::Available
                } else {
                    WtsSupport::DetectionOnly
                },
                verification_kind: VerificationKind::ConfigurationSignal,
                capabilities: vec![IntegrationCapability::JiraIssueImport],
                version: None,
                detail: Some(detail.to_owned()),
                diagnostic_code: Some(DiagnosticCode::AuthenticationNotVerified),
                last_probe_at: checked_at_unix_ms,
                blocking_for: if adapter_available {
                    Vec::new()
                } else {
                    vec![BlockingCapability::JiraIssueImport]
                },
            }
        } else {
            IntegrationSnapshot {
                id: IntegrationId::JiraMcp,
                category: IntegrationCategory::IssueTracker,
                status: IntegrationStatus::NotConfigured,
                installation: InstallationState::Missing,
                setup: SetupState::NeedsDependency,
                runtime: RuntimeState::Idle,
                wts_support: WtsSupport::Available,
                verification_kind: VerificationKind::ConfigurationSignal,
                capabilities: vec![IntegrationCapability::JiraIssueImport],
                version: None,
                detail: Some(
                    "Configure a host-managed Jira MCP endpoint to import issues.".to_owned(),
                ),
                diagnostic_code: Some(DiagnosticCode::JiraMcpEndpointNotConfigured),
                last_probe_at: checked_at_unix_ms,
                blocking_for: vec![BlockingCapability::JiraIssueImport],
            }
        }
    }

    fn detect_openproject(&self, checked_at_unix_ms: u64) -> IntegrationSnapshot {
        let url_configured = self.host_signals.openproject_url_configured();
        let token_configured = self.host_signals.openproject_token_configured();
        let (installation, setup, detail, diagnostic_code, blocking_for) = if !url_configured {
            (
                InstallationState::Missing,
                SetupState::NeedsDependency,
                "Configure the OpenProject URL before importing work packages.",
                DiagnosticCode::OpenProjectEndpointNotConfigured,
                vec![BlockingCapability::OpenProjectWorkPackageImport],
            )
        } else if !token_configured {
            (
                InstallationState::Detected,
                SetupState::NeedsAuth,
                "Configure an OpenProject API token before importing work packages.",
                DiagnosticCode::OpenProjectTokenNotConfigured,
                vec![BlockingCapability::OpenProjectWorkPackageImport],
            )
        } else {
            (
                InstallationState::Detected,
                SetupState::Unverified,
                "OpenProject configuration is present; verify the connection before importing work packages.",
                DiagnosticCode::AuthenticationNotVerified,
                Vec::new(),
            )
        };

        IntegrationSnapshot {
            id: IntegrationId::OpenProject,
            category: IntegrationCategory::IssueTracker,
            status: IntegrationStatus::NotConfigured,
            installation,
            setup,
            runtime: RuntimeState::Idle,
            wts_support: WtsSupport::Available,
            verification_kind: VerificationKind::ConfigurationSignal,
            capabilities: vec![IntegrationCapability::OpenProjectWorkPackageImport],
            version: None,
            detail: Some(detail.to_owned()),
            diagnostic_code: Some(diagnostic_code),
            last_probe_at: checked_at_unix_ms,
            blocking_for,
        }
    }

    fn mcp_atlassian_container_is_running(&self) -> bool {
        let Ok(Some(podman)) = self.resolver.resolve("podman") else {
            return false;
        };
        let Ok(output) = self.runner.run(CommandProbe {
            executable: &podman,
            args: &[
                "ps",
                "--filter",
                "ancestor=ghcr.io/sooperset/mcp-atlassian:latest",
                "--format",
                "{{.Image}}",
            ],
        }) else {
            return false;
        };
        String::from_utf8_lossy(output.stdout())
            .lines()
            .any(|line| line.trim() == MCP_ATLASSIAN_IMAGE)
    }
}

fn unavailable_snapshot(
    probe: ExecutableProbe,
    status: IntegrationStatus,
    installation: InstallationState,
    setup: SetupState,
    diagnostic_code: DiagnosticCode,
    detail: &str,
    checked_at_unix_ms: u64,
) -> IntegrationSnapshot {
    IntegrationSnapshot {
        id: probe.id,
        category: probe.category,
        status,
        installation,
        setup,
        runtime: RuntimeState::Idle,
        wts_support: probe.wts_support(),
        verification_kind: VerificationKind::Version,
        capabilities: probe.capabilities(),
        version: None,
        detail: Some(detail.to_owned()),
        diagnostic_code: Some(diagnostic_code),
        last_probe_at: checked_at_unix_ms,
        blocking_for: vec![probe.blocking_capability],
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn safe_version(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    text.lines()
        .flat_map(str::split_whitespace)
        .find_map(safe_version_token)
}

fn safe_version_token(token: &str) -> Option<String> {
    let token = token.trim_matches(|character: char| {
        matches!(
            character,
            ',' | ';' | ':' | '(' | ')' | '[' | ']' | '{' | '}'
        )
    });
    let token = token
        .strip_prefix('v')
        .or_else(|| token.strip_prefix('V'))
        .unwrap_or(token);
    if token.is_empty() || token.len() > 64 {
        return None;
    }

    let mut characters = token.chars();
    if !characters
        .next()
        .is_some_and(|character| character.is_ascii_digit())
    {
        return None;
    }
    if !token.contains('.') {
        return None;
    }
    if !token.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+' | '_')
    }) {
        return None;
    }
    Some(token.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::{BTreeMap, VecDeque};
    use std::sync::Mutex;
    use tempfile::TempDir;

    #[derive(Default)]
    struct FakeResolver {
        paths: BTreeMap<String, Result<Option<PathBuf>, ProbeFailure>>,
    }

    impl FakeResolver {
        fn with_all_found() -> Self {
            let paths = EXECUTABLE_PROBES
                .iter()
                .map(|probe| {
                    (
                        probe.executable.to_owned(),
                        Ok(Some(PathBuf::from(format!(
                            "/test-tools/{}",
                            probe.executable
                        )))),
                    )
                })
                .collect();
            Self { paths }
        }
    }

    impl PathResolver for FakeResolver {
        fn resolve(&self, executable: &str) -> Result<Option<PathBuf>, ProbeFailure> {
            self.paths.get(executable).cloned().unwrap_or(Ok(None))
        }
    }

    struct FakeRunner {
        outputs: BTreeMap<PathBuf, Result<ProbeOutput, ProbeFailure>>,
        calls: Mutex<Vec<(PathBuf, Vec<String>)>>,
    }

    impl FakeRunner {
        fn with_versions() -> Self {
            let versions = [
                ("git", "git version 2.49.0\n"),
                ("code", "1.125.0\ncommit\narm64\n"),
                ("codex", "codex-cli 0.145.0-alpha.27\n"),
                ("opencode", "1.17.4\n"),
                ("hermes", "Hermes Agent v0.19.0 (2026.7.20)\n"),
                ("graphify", "graphify 0.8.42\n"),
            ];
            Self {
                outputs: versions
                    .into_iter()
                    .map(|(executable, version)| {
                        (
                            PathBuf::from(format!("/test-tools/{executable}")),
                            Ok(ProbeOutput::new(version, "")),
                        )
                    })
                    .collect(),
                calls: Mutex::default(),
            }
        }
    }

    impl CommandRunner for FakeRunner {
        fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
            self.calls.lock().expect("calls lock").push((
                probe.executable.to_owned(),
                probe.args.iter().map(ToString::to_string).collect(),
            ));
            self.outputs
                .get(probe.executable)
                .cloned()
                .unwrap_or(Err(ProbeFailure::Spawn))
        }
    }

    struct SequentialRunner {
        results: Mutex<VecDeque<Result<ProbeOutput, ProbeFailure>>>,
        calls: Mutex<Vec<(PathBuf, Vec<String>)>>,
    }

    impl SequentialRunner {
        fn new(results: impl IntoIterator<Item = Result<ProbeOutput, ProbeFailure>>) -> Self {
            Self {
                results: Mutex::new(results.into_iter().collect()),
                calls: Mutex::default(),
            }
        }
    }

    impl CommandRunner for SequentialRunner {
        fn run(&self, probe: CommandProbe<'_>) -> Result<ProbeOutput, ProbeFailure> {
            self.calls.lock().expect("calls lock").push((
                probe.executable.to_owned(),
                probe.args.iter().map(ToString::to_string).collect(),
            ));
            self.results
                .lock()
                .expect("results lock")
                .pop_front()
                .unwrap_or(Err(ProbeFailure::Spawn))
        }
    }

    fn browser_probe_file(root: &TempDir, leaf: &str, executable: bool) -> PathBuf {
        let path = root.path().join(leaf);
        fs::write(&path, b"fixed local fixture").expect("write browser probe fixture");
        #[cfg(unix)]
        if executable {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&path).expect("fixture metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&path, permissions).expect("fixture permissions");
        }
        path.canonicalize().expect("canonical fixture")
    }

    #[test]
    fn emits_stable_camel_case_setup_json() {
        let detector = IntegrationDetector::new(
            FakeResolver::with_all_found(),
            FakeRunner::with_versions(),
            HostIntegrationSignals::new(false),
        );

        let snapshot = detector.snapshot_at(3, 1_721_234_567_890);
        let value = serde_json::to_value(snapshot).expect("serialize setup snapshot");

        assert_eq!(value["checkedAtUnixMs"], json!(1_721_234_567_890_u64));
        assert_eq!(value["repositoryCount"], json!(3));
        assert_eq!(value["integrations"][0]["id"], json!("git"));
        assert_eq!(value["integrations"][0]["category"], json!("sourceControl"));
        assert_eq!(value["integrations"][0]["status"], json!("ready"));
        assert_eq!(value["integrations"][0]["installation"], json!("detected"));
        assert_eq!(value["integrations"][0]["setup"], json!("notRequired"));
        assert_eq!(value["integrations"][0]["runtime"], json!("idle"));
        assert_eq!(value["integrations"][0]["wtsSupport"], json!("available"));
        assert_eq!(
            value["integrations"][0]["verificationKind"],
            json!("version")
        );
        assert_eq!(
            value["integrations"][0]["capabilities"],
            json!(["worktreeMaterialization"])
        );
        assert_eq!(
            value["integrations"][0]["lastProbeAt"],
            json!(1_721_234_567_890_u64)
        );
        assert_eq!(value["integrations"][0]["version"], json!("2.49.0"));
        assert_eq!(value["integrations"][0]["blockingFor"], json!([]));
        assert_eq!(value["integrations"][3]["id"], json!("openCode"));
        assert_eq!(value["integrations"][3]["status"], json!("notConfigured"));
        assert_eq!(value["integrations"][3]["setup"], json!("unverified"));
        assert_eq!(value["integrations"][3]["wtsSupport"], json!("available"));
        assert_eq!(
            value["integrations"][3]["verificationKind"],
            json!("version")
        );
        assert_eq!(
            value["integrations"][3]["diagnosticCode"],
            json!("authenticationNotVerified")
        );
        assert_eq!(value["integrations"][6]["id"], json!("warp"));
        assert_eq!(value["integrations"][6]["category"], json!("terminal"));
        assert_eq!(value["integrations"][6]["status"], json!("notFound"));
        assert_eq!(
            value["integrations"][6]["capabilities"],
            json!(["terminalSession"])
        );
        assert_eq!(
            value["integrations"][6]["blockingFor"],
            json!(["warpLaunch"])
        );
        assert_eq!(value["integrations"][7]["id"], json!("jiraMcp"));
        assert_eq!(value["integrations"][7]["status"], json!("notConfigured"));
        assert_eq!(value["integrations"][7]["wtsSupport"], json!("available"));
        assert_eq!(
            value["integrations"][7]["verificationKind"],
            json!("configurationSignal")
        );
        assert_eq!(
            value["integrations"][7]["blockingFor"],
            json!(["jiraIssueImport"])
        );
        assert!(value["integrations"][7].get("version").is_none());
        assert_eq!(value["integrations"][8]["id"], json!("openProject"));
        assert_eq!(
            value["integrations"][8]["capabilities"],
            json!(["openProjectWorkPackageImport"])
        );
        assert_eq!(
            value["integrations"][8]["blockingFor"],
            json!(["openProjectWorkPackageImport"])
        );
        assert!(value["browserJourneyReadiness"].is_object());
    }

    #[test]
    fn installed_warp_is_ready_for_terminal_handoffs_without_a_cli_probe() {
        let detector = IntegrationDetector::new(
            FakeResolver::with_all_found(),
            FakeRunner::with_versions(),
            HostIntegrationSignals::new(false).with_warp_app(true),
        );

        let snapshot = detector.snapshot_at(0, 73);
        let warp = snapshot
            .integrations
            .iter()
            .find(|integration| integration.id == IntegrationId::Warp)
            .expect("Warp integration");
        assert_eq!(warp.status, IntegrationStatus::Ready);
        assert_eq!(warp.installation, InstallationState::Detected);
        assert_eq!(
            warp.capabilities,
            vec![IntegrationCapability::TerminalSession]
        );
        assert!(warp.blocking_for.is_empty());
    }

    #[test]
    fn browser_readiness_uses_only_fixed_bounded_local_probes() {
        let root = TempDir::new().expect("temp directory");
        let node_path = browser_probe_file(&root, "node", true);
        let helper_path = browser_probe_file(&root, BROWSER_DRIVER_FILE, false);
        let runner = SequentialRunner::new([
            Ok(ProbeOutput::new("v23.10.0 secret-value", "")),
            Ok(ProbeOutput::new("", "")),
            Ok(ProbeOutput::new("", "")),
        ]);
        let detector = IntegrationDetector::new(
            FakeResolver::default(),
            runner,
            HostIntegrationSignals::default(),
        );

        let readiness = detector.detect_browser_journey_with_candidates(
            BrowserFileCandidate::Ready {
                path: node_path.clone(),
                source: BrowserJourneyDiscoverySource::Configured,
            },
            BrowserFileCandidate::Ready {
                path: helper_path.clone(),
                source: BrowserJourneyDiscoverySource::Configured,
            },
        );

        assert!(readiness.ready);
        assert_eq!(readiness.node.status, BrowserJourneyCheckStatus::Ready);
        assert_eq!(
            readiness.fixed_helper.status,
            BrowserJourneyCheckStatus::Ready
        );
        assert_eq!(
            readiness.playwright.status,
            BrowserJourneyCheckStatus::Ready
        );
        assert_eq!(readiness.chromium.status, BrowserJourneyCheckStatus::Ready);

        let calls = detector.runner.calls.lock().expect("calls lock");
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0], (node_path.clone(), vec!["--version".to_owned()]));
        assert_eq!(
            calls[1],
            (
                node_path.clone(),
                vec![
                    "--input-type=module".to_owned(),
                    "--eval".to_owned(),
                    PLAYWRIGHT_RESOLUTION_PROBE.to_owned(),
                    helper_path.to_string_lossy().into_owned(),
                ],
            )
        );
        assert_eq!(
            calls[2],
            (
                node_path,
                vec![
                    "--input-type=module".to_owned(),
                    "--eval".to_owned(),
                    CHROMIUM_AVAILABILITY_PROBE.to_owned(),
                    helper_path.to_string_lossy().into_owned(),
                ],
            )
        );

        let encoded = serde_json::to_string(&readiness).expect("serialize readiness");
        assert!(!encoded.contains(root.path().to_string_lossy().as_ref()));
        assert!(!encoded.contains("secret-value"));
    }

    #[test]
    fn browser_readiness_stops_before_chromium_when_playwright_is_missing() {
        let root = TempDir::new().expect("temp directory");
        let node_path = browser_probe_file(&root, "node", true);
        let helper_path = browser_probe_file(&root, BROWSER_DRIVER_FILE, false);
        let runner = SequentialRunner::new([
            Ok(ProbeOutput::new("v23.10.0", "")),
            Err(ProbeFailure::UnsuccessfulExit),
        ]);
        let detector = IntegrationDetector::new(
            FakeResolver::default(),
            runner,
            HostIntegrationSignals::default(),
        );

        let readiness = detector.detect_browser_journey_with_candidates(
            BrowserFileCandidate::Ready {
                path: node_path,
                source: BrowserJourneyDiscoverySource::Path,
            },
            BrowserFileCandidate::Ready {
                path: helper_path,
                source: BrowserJourneyDiscoverySource::Packaged,
            },
        );

        assert!(!readiness.ready);
        assert_eq!(
            readiness.playwright.diagnostic_code,
            Some(BrowserJourneyDiagnosticCode::PlaywrightUnavailable)
        );
        assert_eq!(
            readiness.chromium.status,
            BrowserJourneyCheckStatus::Blocked
        );
        assert_eq!(detector.runner.calls.lock().expect("calls lock").len(), 2);
    }

    #[test]
    fn browser_readiness_does_not_start_node_when_a_prerequisite_is_invalid() {
        let runner = SequentialRunner::new([]);
        let detector = IntegrationDetector::new(
            FakeResolver::default(),
            runner,
            HostIntegrationSignals::default(),
        );

        let readiness = detector.detect_browser_journey_with_candidates(
            BrowserFileCandidate::Missing,
            BrowserFileCandidate::Invalid {
                source: BrowserJourneyDiscoverySource::Configured,
            },
        );

        assert!(!readiness.ready);
        assert_eq!(
            readiness.node.diagnostic_code,
            Some(BrowserJourneyDiagnosticCode::NodeUnavailable)
        );
        assert_eq!(
            readiness.fixed_helper.diagnostic_code,
            Some(BrowserJourneyDiagnosticCode::FixedHelperInvalid)
        );
        assert_eq!(
            readiness.playwright.status,
            BrowserJourneyCheckStatus::Blocked
        );
        assert!(detector.runner.calls.lock().expect("calls lock").is_empty());
    }

    #[test]
    fn probes_only_fixed_version_arguments_and_parses_sanitized_versions() {
        let runner = FakeRunner::with_versions();
        let detector = IntegrationDetector::new(
            FakeResolver::with_all_found(),
            runner,
            HostIntegrationSignals::new(false),
        );

        let snapshot = detector.snapshot_at(0, 9);
        let versions = snapshot
            .integrations
            .iter()
            .take(6)
            .map(|entry| entry.version.as_deref())
            .collect::<Vec<_>>();
        assert_eq!(
            versions,
            vec![
                Some("2.49.0"),
                Some("1.125.0"),
                Some("0.145.0-alpha.27"),
                Some("1.17.4"),
                Some("0.19.0"),
                Some("0.8.42"),
            ]
        );

        let calls = detector.runner.calls.lock().expect("calls lock");
        assert_eq!(calls.len(), EXECUTABLE_PROBES.len());
        assert!(calls.iter().all(|(_, args)| args == &["--version"]));
    }

    #[test]
    fn missing_git_blocks_materialization_without_blocking_on_agents() {
        let mut resolver = FakeResolver::with_all_found();
        resolver.paths.insert("git".to_owned(), Ok(None));
        resolver.paths.insert("codex".to_owned(), Ok(None));
        let detector = IntegrationDetector::new(
            resolver,
            FakeRunner::with_versions(),
            HostIntegrationSignals::new(false),
        );

        let snapshot = detector.snapshot_at(0, 1);
        let git = &snapshot.integrations[0];
        assert_eq!(git.status, IntegrationStatus::NotFound);
        assert_eq!(
            git.blocking_for,
            vec![BlockingCapability::WorktreeMaterialization]
        );

        let codex = &snapshot.integrations[2];
        assert_eq!(codex.status, IntegrationStatus::NotFound);
        assert_eq!(codex.blocking_for, vec![BlockingCapability::CodexLaunch]);
        assert!(
            !codex
                .blocking_for
                .contains(&BlockingCapability::WorktreeMaterialization)
        );
    }

    #[test]
    fn configured_jira_signal_never_exposes_a_url_or_secret() {
        let detector = IntegrationDetector::new(
            FakeResolver::default(),
            FakeRunner {
                outputs: BTreeMap::new(),
                calls: Mutex::default(),
            },
            HostIntegrationSignals::new(true),
        );

        let snapshot = detector.snapshot_at(0, 1);
        let jira = snapshot
            .integrations
            .iter()
            .find(|integration| integration.id == IntegrationId::JiraMcp)
            .expect("jira entry");
        assert_eq!(jira.status, IntegrationStatus::NotConfigured);
        assert_eq!(jira.installation, InstallationState::Detected);
        assert_eq!(jira.setup, SetupState::Unverified);
        assert_eq!(jira.wts_support, WtsSupport::DetectionOnly);
        assert_eq!(
            jira.verification_kind,
            VerificationKind::ConfigurationSignal
        );
        assert_eq!(jira.version, None);
        assert_eq!(jira.blocking_for, vec![BlockingCapability::JiraIssueImport]);
        let json = serde_json::to_string(&snapshot).expect("serialize snapshot");
        assert!(!json.contains("http"));
        assert!(!json.contains("token"));
        assert!(!json.contains("secret"));
    }

    #[test]
    fn recognizes_vscode_jira_stdio_registration_without_retaining_credentials() {
        let registration = br#"{
          "servers": {
            "mcp-atlassian": {
              "command": "podman",
              "args": ["run", "--rm", "-i", "ghcr.io/sooperset/mcp-atlassian:latest"],
              "env": {
                "JIRA_URL": "https://jira.invalid",
                "JIRA_PERSONAL_TOKEN": "must-never-cross-the-boundary"
              }
            }
          }
        }"#;
        assert_eq!(
            classify_jira_mcp_registration(registration),
            Some(JiraMcpRegistration::VscodePodmanRegistration)
        );
        assert_eq!(
            classify_jira_mcp_registration(br#"{"servers":{"docs":{"command":"docs"}}}"#),
            None
        );
    }

    #[test]
    fn reports_external_vscode_stdio_runtime_without_claiming_a_wts_connection() {
        let mut resolver = FakeResolver::default();
        resolver.paths.insert(
            "podman".to_owned(),
            Ok(Some(PathBuf::from("/test-tools/podman"))),
        );
        let mut runner = FakeRunner {
            outputs: BTreeMap::new(),
            calls: Mutex::default(),
        };
        runner.outputs.insert(
            PathBuf::from("/test-tools/podman"),
            Ok(ProbeOutput::new(format!("{MCP_ATLASSIAN_IMAGE}\n"), "")),
        );
        let detector = IntegrationDetector::new(
            resolver,
            runner,
            HostIntegrationSignals {
                jira_mcp_registration: JiraMcpRegistration::VscodePodmanRegistration,
                ..HostIntegrationSignals::default()
            },
        );

        let snapshot = detector.snapshot_at(0, 1);
        let jira = snapshot
            .integrations
            .iter()
            .find(|integration| integration.id == IntegrationId::JiraMcp)
            .expect("jira entry");
        assert_eq!(jira.installation, InstallationState::Detected);
        assert_eq!(jira.setup, SetupState::Unverified);
        assert_eq!(
            jira.detail.as_deref(),
            Some(
                "Jira MCP is configured and running in VS Code over stdio. WTS will start a separate process when you explicitly verify or import."
            )
        );
        assert_eq!(jira.blocking_for, Vec::<BlockingCapability>::new());
        let calls = detector.runner.calls.lock().expect("calls lock");
        assert!(calls.iter().any(|(_, args)| {
            args == &[
                "ps",
                "--filter",
                "ancestor=ghcr.io/sooperset/mcp-atlassian:latest",
                "--format",
                "{{.Image}}",
            ]
        }));
    }

    #[test]
    fn openproject_detection_is_local_secret_free_and_actionable() {
        let configured = IntegrationDetector::new(
            FakeResolver::default(),
            FakeRunner {
                outputs: BTreeMap::new(),
                calls: Mutex::default(),
            },
            HostIntegrationSignals::new(false).with_openproject(true, true),
        )
        .snapshot_at(0, 73);
        let openproject = configured
            .integrations
            .iter()
            .find(|integration| integration.id == IntegrationId::OpenProject)
            .expect("OpenProject entry");
        assert_eq!(openproject.installation, InstallationState::Detected);
        assert_eq!(openproject.setup, SetupState::Unverified);
        assert_eq!(openproject.wts_support, WtsSupport::Available);
        assert!(openproject.blocking_for.is_empty());
        assert_eq!(
            openproject.capabilities,
            vec![IntegrationCapability::OpenProjectWorkPackageImport]
        );
        let serialized = serde_json::to_string(&configured).expect("serialize snapshot");
        assert!(!serialized.contains("https://openproject.internal"));
        assert!(!serialized.contains("must-never-cross-the-boundary"));

        let token_missing = IntegrationDetector::new(
            FakeResolver::default(),
            FakeRunner {
                outputs: BTreeMap::new(),
                calls: Mutex::default(),
            },
            HostIntegrationSignals::new(false).with_openproject(true, false),
        )
        .snapshot_at(0, 74);
        let openproject = token_missing
            .integrations
            .iter()
            .find(|integration| integration.id == IntegrationId::OpenProject)
            .expect("OpenProject entry");
        assert_eq!(openproject.setup, SetupState::NeedsAuth);
        assert_eq!(
            openproject.diagnostic_code,
            Some(DiagnosticCode::OpenProjectTokenNotConfigured)
        );
        assert_eq!(
            openproject.blocking_for,
            vec![BlockingCapability::OpenProjectWorkPackageImport]
        );
    }

    #[test]
    fn resolver_and_command_failures_are_safe_errors() {
        let mut resolver = FakeResolver::default();
        resolver
            .paths
            .insert("git".to_owned(), Err(ProbeFailure::Resolution));
        resolver.paths.insert(
            "code".to_owned(),
            Ok(Some(PathBuf::from("/test-tools/code"))),
        );
        let mut runner = FakeRunner {
            outputs: BTreeMap::new(),
            calls: Mutex::default(),
        };
        runner.outputs.insert(
            PathBuf::from("/test-tools/code"),
            Err(ProbeFailure::TimedOut),
        );
        let detector =
            IntegrationDetector::new(resolver, runner, HostIntegrationSignals::default());

        let snapshot = detector.snapshot_at(0, 1);
        assert_eq!(snapshot.integrations[0].status, IntegrationStatus::Error);
        assert_eq!(
            snapshot.integrations[0].detail.as_deref(),
            Some("Executable discovery failed.")
        );
        assert_eq!(snapshot.integrations[1].status, IntegrationStatus::Error);
        assert_eq!(
            snapshot.integrations[1].detail.as_deref(),
            Some("The executable version probe timed out.")
        );
    }

    #[test]
    fn unrecognized_or_untrusted_output_is_not_exposed() {
        let mut resolver = FakeResolver::default();
        resolver
            .paths
            .insert("git".to_owned(), Ok(Some(PathBuf::from("/test-tools/git"))));
        let mut runner = FakeRunner {
            outputs: BTreeMap::new(),
            calls: Mutex::default(),
        };
        runner.outputs.insert(
            PathBuf::from("/test-tools/git"),
            Ok(ProbeOutput::new(
                "token=super-secret\n/home/example/private",
                "",
            )),
        );
        let detector =
            IntegrationDetector::new(resolver, runner, HostIntegrationSignals::default());

        let snapshot = detector.snapshot_at(0, 1);
        let git = &snapshot.integrations[0];
        assert_eq!(git.status, IntegrationStatus::Ready);
        assert_eq!(git.version, None);
        assert_eq!(git.detail, None);
        let json = serde_json::to_string(git).expect("serialize git snapshot");
        assert!(!json.contains("super-secret"));
        assert!(!json.contains("/home/alice"));
    }

    #[test]
    fn versions_can_be_read_from_stderr_without_leaking_other_output() {
        let mut resolver = FakeResolver::default();
        resolver
            .paths
            .insert("git".to_owned(), Ok(Some(PathBuf::from("/test-tools/git"))));
        let mut runner = FakeRunner {
            outputs: BTreeMap::new(),
            calls: Mutex::default(),
        };
        runner.outputs.insert(
            PathBuf::from("/test-tools/git"),
            Ok(ProbeOutput::new("", "git version 2.50.1\nignored")),
        );
        let detector =
            IntegrationDetector::new(resolver, runner, HostIntegrationSignals::default());

        let snapshot = detector.snapshot_at(0, 1);
        assert_eq!(snapshot.integrations[0].version.as_deref(), Some("2.50.1"));
    }
}
