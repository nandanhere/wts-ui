use serde::{Deserialize, Serialize};

/// Stable identifiers for integrations understood by the local WTS binary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntegrationId {
    Git,
    Vscode,
    Warp,
    Codex,
    OpenCode,
    Hermes,
    Graphify,
    JiraMcp,
    OpenProject,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntegrationCategory {
    SourceControl,
    Editor,
    Terminal,
    Agent,
    KnowledgeGraph,
    IssueTracker,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntegrationStatus {
    Ready,
    NotConfigured,
    NotFound,
    Error,
}

/// Whether a local executable or host-owned endpoint signal was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallationState {
    Missing,
    Detected,
    Unsupported,
}

/// Configuration readiness is intentionally separate from installation. A
/// successful `--version` probe cannot prove that an agent is authenticated.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupState {
    NotRequired,
    NeedsAuth,
    /// The lightweight detector deliberately did not inspect authentication or
    /// provider configuration, so readiness cannot be asserted either way.
    Unverified,
    NeedsDependency,
    Ready,
    Incompatible,
}

/// Whether WTS can currently use the detected integration for its advertised
/// capability, or only report local discovery evidence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WtsSupport {
    Available,
    DetectionOnly,
}

/// The fixed, secret-free signal used to produce this snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationKind {
    Version,
    ConfigurationSignal,
}

/// No detector probe starts a provider runtime, so normal discovery reports
/// `idle`. The other values are available to later runtime supervisors.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeState {
    Idle,
    Starting,
    Running,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntegrationCapability {
    WorktreeMaterialization,
    WorkspaceLaunch,
    TerminalSession,
    AgentSession,
    GraphIndexing,
    JiraIssueImport,
    OpenProjectWorkPackageImport,
}

/// Machine-readable, secret-free reasons for a non-ready state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticCode {
    ExecutableMissing,
    ExecutableDiscoveryFailed,
    VersionProbeFailed,
    VersionProbeTimedOut,
    AuthenticationNotVerified,
    JiraMcpEndpointNotConfigured,
    OpenProjectEndpointNotConfigured,
    OpenProjectTokenNotConfigured,
}

/// A feature that cannot be used while the associated integration is not
/// ready. These are intentionally narrower than overall WTS readiness.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockingCapability {
    WorktreeMaterialization,
    VscodeLaunch,
    WarpLaunch,
    CodexLaunch,
    OpenCodeLaunch,
    HermesLaunch,
    GraphIndexing,
    JiraIssueImport,
    OpenProjectWorkPackageImport,
}

/// The result of one bounded prerequisite check for local browser journeys.
///
/// Details are selected from fixed WTS-owned messages. Paths, command output,
/// environment values, and credentials never cross this contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserJourneyCheckStatus {
    Ready,
    Unavailable,
    Blocked,
}

/// How WTS selected a local browser-runner file, without exposing its path.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserJourneyDiscoverySource {
    Configured,
    Packaged,
    Path,
}

/// Stable, secret-free reasons why a browser-journey prerequisite is not
/// ready.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserJourneyDiagnosticCode {
    NodeUnavailable,
    NodeProbeFailed,
    FixedHelperUnavailable,
    FixedHelperInvalid,
    PlaywrightUnavailable,
    PlaywrightProbeFailed,
    ChromiumUnavailable,
    ChromiumProbeFailed,
    PrerequisiteUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserJourneyReadinessCheck {
    pub status: BrowserJourneyCheckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<BrowserJourneyDiscoverySource>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_code: Option<BrowserJourneyDiagnosticCode>,
}

/// Local-only readiness for the deterministic Playwright journey runner.
///
/// This is deliberately separate from provider integrations: Node,
/// Playwright, and Chromium support deterministic verification and do not
/// represent an agent account or remote service.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserJourneyReadiness {
    pub ready: bool,
    pub node: BrowserJourneyReadinessCheck,
    pub fixed_helper: BrowserJourneyReadinessCheck,
    pub playwright: BrowserJourneyReadinessCheck,
    pub chromium: BrowserJourneyReadinessCheck,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationSnapshot {
    pub id: IntegrationId,
    pub category: IntegrationCategory,
    /// Convenience roll-up for compact UI badges. The independent dimensions
    /// below remain authoritative for setup flows.
    pub status: IntegrationStatus,
    pub installation: InstallationState,
    pub setup: SetupState,
    pub runtime: RuntimeState,
    pub wts_support: WtsSupport,
    pub verification_kind: VerificationKind,
    pub capabilities: Vec<IntegrationCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_code: Option<DiagnosticCode>,
    pub last_probe_at: u64,
    pub blocking_for: Vec<BlockingCapability>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupSnapshot {
    pub checked_at_unix_ms: u64,
    pub repository_count: u64,
    pub integrations: Vec<IntegrationSnapshot>,
    /// Optional for wire compatibility with setup snapshots produced before
    /// local browser journeys existed. The WTS application service always
    /// populates it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_journey_readiness: Option<BrowserJourneyReadiness>,
}
