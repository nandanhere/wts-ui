use crate::{AgentProvider, GraphWorkspaceStatus};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use thiserror::Error;
use uuid::Uuid;
use wts_core::workspace::{WorkspaceIntent, WorkspaceProvider};

pub const WORKSPACE_EVIDENCE_SCHEMA_VERSION: u32 = 1;
pub const EVIDENCE_DIRECTORY: &str = ".wts";
pub const MAX_AGENT_REPORT_BYTES: usize = 512 * 1024;

const CONTEXT_FILE: &str = "context.json";
const GRAPH_MANIFEST_FILE: &str = "graph-manifest.json";
const VERIFICATION_PLAN_FILE: &str = "verification-plan.json";
const VERIFICATION_RESULT_FILE: &str = "verification-result.json";
const VERIFICATION_HISTORY_FILE: &str = "verification-history.json";
const AGENT_REPORT_FILE: &str = "agent-report.json";
const AGENT_RUNS_DIRECTORY: &str = "agent-runs";
const LOGS_DIRECTORY: &str = "logs";
const MAX_EVIDENCE_FILE_BYTES: usize = 512 * 1024;
const MAX_LOG_FILE_BYTES: usize = 1024 * 1024;
const MAX_AGENT_RUNS: usize = 256;
const MAX_AGENT_RUN_BYTES: u64 = 4 * 1024 * 1024;
const MAX_VERIFICATION_HISTORY: usize = 10;
const MAX_AGENT_FINDINGS: usize = 128;
const MAX_AGENT_NEXT_ACTIONS: usize = 64;
const MAX_AGENT_PROPOSED_CHECKS: usize = 64;
const MAX_AGENT_VALIDATION_FLOWS: usize = 32;
const MAX_AGENT_FLOWS: usize = 128;
const MAX_ENVIRONMENT_REQUIREMENTS: usize = 256;
const MAX_ENVIRONMENT_SETUP_STEPS: usize = 128;
const MAX_ENVIRONMENT_UNRESOLVED: usize = 128;
const MAX_VALIDATION_FLOW_STEPS: usize = 64;
const MAX_AGENT_FLOW_STEPS: usize = 128;
const MAX_FINDING_EVIDENCE: usize = 16;
const MAX_FLOW_TEXT_ITEMS: usize = 64;
const MAX_PROPOSAL_ARGUMENTS: usize = 16;
const MAX_PROPOSAL_ENVIRONMENT_NAMES: usize = 16;
const MAX_AGENT_SUMMARY_CHARS: usize = 16 * 1024;
const MAX_FINDING_TITLE_CHARS: usize = 256;
const MAX_FINDING_DETAIL_CHARS: usize = 8 * 1024;
const MAX_FINDING_EVIDENCE_CHARS: usize = 1_024;
const MAX_NEXT_ACTION_CHARS: usize = 2_048;
const MAX_PROPOSAL_REASON_CHARS: usize = 4 * 1024;
const MAX_PROPOSAL_ARGUMENT_CHARS: usize = 1_024;
const MAX_VALIDATION_TEXT_CHARS: usize = 4 * 1024;
const MAX_PROPOSED_TIMEOUT_MS: u64 = 15 * 60 * 1_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceEvidence {
    pub context: WorkspaceEvidenceContext,
    pub graph_manifest: WorkspaceGraphManifest,
    pub verification_plan: WorkspaceVerificationPlan,
    pub verification_result: WorkspaceVerificationResult,
    #[serde(default)]
    pub verification_history: Vec<WorkspaceVerificationResult>,
    pub agent_report: WorkspaceAgentReport,
    pub agent_runs: Vec<AgentRunSummary>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentReportStatus {
    NotReported,
    Ready,
    Invalid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentFindingSeverity {
    Info,
    Warning,
    Critical,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentReportCoverage {
    #[default]
    Unassessed,
    Partial,
    Complete,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSkippedRepository {
    pub repository_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentReportScope {
    pub coverage: AgentReportCoverage,
    #[serde(default)]
    pub graph_status: WorkspaceGraphEvidenceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_sha256: Option<String>,
    pub reviewed_repository_ids: Vec<String>,
    pub unresolved_repository_ids: Vec<String>,
    pub skipped_repositories: Vec<AgentSkippedRepository>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentFlowKind {
    User,
    Service,
    Operational,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentFlowEvidence {
    pub repository_id: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentFlowStep {
    pub id: String,
    pub repository_id: String,
    pub component: String,
    pub action: String,
    pub evidence: Vec<AgentFlowEvidence>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentFlow {
    pub id: String,
    pub title: String,
    pub kind: AgentFlowKind,
    pub actors: Vec<String>,
    pub entry_points: Vec<String>,
    pub steps: Vec<AgentFlowStep>,
    pub expected_outcome: String,
    pub risks: Vec<String>,
    pub existing_coverage: Vec<String>,
    pub verification_candidate_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentEnvironmentStatus {
    #[default]
    Unassessed,
    Planned,
    NeedsInput,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentEnvironmentRequirementKind {
    Toolchain,
    Configuration,
    Secret,
    Service,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentEnvironmentRequirementSource {
    Repository,
    Generated,
    User,
    External,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEnvironmentRequirement {
    pub id: String,
    pub repository_id: String,
    pub kind: AgentEnvironmentRequirementKind,
    pub name: String,
    pub required: bool,
    pub source: AgentEnvironmentRequirementSource,
    pub detail: String,
    pub evidence: Vec<AgentFlowEvidence>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEnvironmentSetupStep {
    pub id: String,
    pub repository_id: String,
    pub working_directory: String,
    pub action: String,
    pub command: Vec<String>,
    pub evidence: Vec<AgentFlowEvidence>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEnvironmentPlan {
    pub status: AgentEnvironmentStatus,
    pub summary: String,
    pub requirements: Vec<AgentEnvironmentRequirement>,
    pub setup_steps: Vec<AgentEnvironmentSetupStep>,
    pub unresolved: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentFinding {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub severity: AgentFindingSeverity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<String>,
    pub evidence: Vec<String>,
    #[serde(default)]
    pub flow_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentProposedCheck {
    pub id: String,
    pub label: String,
    pub kind: VerificationCheckKind,
    pub repository_id: String,
    pub working_directory: String,
    pub executable: String,
    pub args: Vec<String>,
    pub timeout_ms: u64,
    pub environment_names: Vec<String>,
    pub reason: String,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentValidationStep {
    pub id: String,
    pub action: String,
    pub expected: String,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentValidationFlow {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub prerequisites: Vec<String>,
    pub steps: Vec<AgentValidationStep>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceAgentReport {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub status: AgentReportStatus,
    pub display_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at_unix_ms: Option<i64>,
    pub summary: String,
    pub scope: AgentReportScope,
    pub environment: AgentEnvironmentPlan,
    pub flows: Vec<AgentFlow>,
    pub findings: Vec<AgentFinding>,
    pub next_actions: Vec<String>,
    pub proposed_checks: Vec<AgentProposedCheck>,
    pub validation_flows: Vec<AgentValidationFlow>,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentReportDocument {
    schema_version: u32,
    workspace_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at_unix_ms: Option<i64>,
    summary: String,
    #[serde(default)]
    scope: AgentReportScope,
    #[serde(default)]
    environment: AgentEnvironmentPlan,
    #[serde(default)]
    flows: Vec<AgentFlow>,
    findings: Vec<AgentFinding>,
    next_actions: Vec<String>,
    #[serde(default)]
    proposed_checks: Vec<AgentProposedCheck>,
    #[serde(default)]
    validation_flows: Vec<AgentValidationFlow>,
}

impl AgentReportDocument {
    fn empty(workspace_id: Uuid) -> Self {
        Self {
            schema_version: WORKSPACE_EVIDENCE_SCHEMA_VERSION,
            workspace_id,
            updated_at_unix_ms: None,
            summary: String::new(),
            scope: AgentReportScope::default(),
            environment: AgentEnvironmentPlan::default(),
            flows: Vec::new(),
            findings: Vec::new(),
            next_actions: Vec::new(),
            proposed_checks: Vec::new(),
            validation_flows: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceEvidenceContext {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub workspace_record_version: u64,
    pub title: String,
    pub intent: WorkspaceIntent,
    pub preferred_provider: WorkspaceProvider,
    pub branch_name: String,
    pub workspace_display_path: String,
    pub code_workspace_display_path: String,
    pub evidence_display_path: String,
    pub created_at_unix_ms: i64,
    pub wts_version: String,
    pub repositories: Vec<EvidenceRepository>,
    pub allowed_repository_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceRepository {
    pub repository_id: String,
    pub label: String,
    pub requested_base_ref: String,
    pub resolved_base_ref: String,
    pub base_commit_oid: String,
    pub worktree_display_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceGraphEvidenceStatus {
    NotStarted,
    Ready,
    Failed,
}

impl Default for WorkspaceGraphEvidenceStatus {
    fn default() -> Self {
        Self::NotStarted
    }
}

impl From<GraphWorkspaceStatus> for WorkspaceGraphEvidenceStatus {
    fn from(status: GraphWorkspaceStatus) -> Self {
        match status {
            GraphWorkspaceStatus::NotStarted => Self::NotStarted,
            GraphWorkspaceStatus::Ready => Self::Ready,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceGraphManifest {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub status: WorkspaceGraphEvidenceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_display_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexed_at_unix_ms: Option<i64>,
    pub indexed_repositories: Vec<GraphIndexedRepository>,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphIndexedRepository {
    pub repository_id: String,
    pub commit_oid: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceVerificationPlan {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub revision: u64,
    pub updated_at_unix_ms: i64,
    pub checks: Vec<VerificationCheck>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationCheckKind {
    Unit,
    Integration,
    Ui,
    Contract,
    Lint,
    Build,
    Custom,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationCheck {
    pub id: String,
    pub label: String,
    pub kind: VerificationCheckKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<String>,
    pub working_directory: String,
    pub executable: String,
    pub args: Vec<String>,
    pub timeout_ms: u64,
    pub output_limit_bytes: u64,
    pub required: bool,
    pub environment_names: Vec<String>,
    pub acceptance_files: Vec<AcceptanceFileDigest>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptanceFileDigest {
    pub display_path: String,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationStatus {
    NotRun,
    Running,
    Passed,
    Failed,
    Blocked,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationCheckStatus {
    Pending,
    Running,
    Passed,
    Failed,
    TimedOut,
    Skipped,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceVerificationResult {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub plan_revision: u64,
    pub status: VerificationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_unix_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub checks: Vec<VerificationCheckResult>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationCheckResult {
    pub check_id: String,
    pub status: VerificationCheckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_unix_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_display_path: Option<String>,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentRunState {
    Running,
    Succeeded,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentRunFailure {
    Unavailable,
    SpawnFailed,
    TimedOut,
    OutputTooLarge,
    ProviderFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunSummary {
    pub schema_version: u32,
    pub run_id: Uuid,
    pub workspace_id: Uuid,
    pub provider: AgentProvider,
    pub state: AgentRunState,
    pub started_at_unix_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub prompt_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<AgentRunFailure>,
}

#[derive(Debug, Error)]
pub(crate) enum EvidenceStoreError {
    #[error("workspace evidence is unavailable")]
    Unavailable,
    #[error("workspace evidence is invalid")]
    Invalid,
}

#[derive(Debug, Error)]
pub enum AgentReportPublishError {
    #[error("run wts-report from an absolute materialized workspace path")]
    InvalidWorkspacePath,
    #[error("workspace evidence is unavailable: expected a trusted .wts/context.json")]
    EvidenceUnavailable,
    #[error("workspace evidence is invalid: {0}")]
    InvalidContext(String),
    #[error("agent report exceeds the {MAX_AGENT_REPORT_BYTES}-byte limit")]
    ReportTooLarge,
    #[error("agent report JSON is invalid at line {line}, column {column}: {message}")]
    InvalidJson {
        line: usize,
        column: usize,
        message: String,
    },
    #[error("agent report field {field} is invalid: {message}")]
    InvalidReport { field: String, message: String },
    #[error("could not atomically publish .wts/agent-report.json")]
    PublishUnavailable,
}

/// Validate and atomically publish an agent-authored workspace report.
///
/// The workspace context remains the authority for the workspace identity,
/// repository identities, worktree paths, and the small allowlist of commands
/// that may be proposed for verification. Validation completes before the
/// existing report is replaced.
pub fn publish_agent_report(
    workspace: &Path,
    report_bytes: &[u8],
) -> Result<PathBuf, AgentReportPublishError> {
    if !workspace.is_absolute() {
        return Err(AgentReportPublishError::InvalidWorkspacePath);
    }
    if report_bytes.len() > MAX_AGENT_REPORT_BYTES {
        return Err(AgentReportPublishError::ReportTooLarge);
    }

    let store =
        EvidenceStore::open(workspace).map_err(|_| AgentReportPublishError::EvidenceUnavailable)?;
    let context = read_json::<WorkspaceEvidenceContext>(&store.root, CONTEXT_FILE)
        .map_err(|_| AgentReportPublishError::EvidenceUnavailable)?;
    let graph_manifest = read_json::<WorkspaceGraphManifest>(&store.root, GRAPH_MANIFEST_FILE)
        .map_err(|_| AgentReportPublishError::EvidenceUnavailable)?;
    validate_agent_report_context(workspace, &store.root, &context)
        .map_err(AgentReportPublishError::InvalidContext)?;

    let report = serde_json::from_slice::<AgentReportDocument>(report_bytes).map_err(|error| {
        AgentReportPublishError::InvalidJson {
            line: error.line(),
            column: error.column(),
            message: error.to_string(),
        }
    })?;
    validate_agent_report_document(&report, &context, &graph_manifest)?;

    atomic_replace_json(&store.root, AGENT_REPORT_FILE, &report)
        .map_err(|_| AgentReportPublishError::PublishUnavailable)?;
    Ok(store.root.join(AGENT_REPORT_FILE))
}

pub(crate) struct EvidenceStore {
    workspace: PathBuf,
    root: PathBuf,
}

#[derive(Clone, Copy)]
struct AgentRunRetention {
    maximum_count: usize,
    maximum_bytes: u64,
}

const AGENT_RUN_RETENTION: AgentRunRetention = AgentRunRetention {
    maximum_count: MAX_AGENT_RUNS,
    maximum_bytes: MAX_AGENT_RUN_BYTES,
};

struct StoredAgentRun {
    leaf: String,
    bytes: u64,
    summary: AgentRunSummary,
}

impl EvidenceStore {
    pub(crate) fn create(workspace: &Path) -> Result<Self, EvidenceStoreError> {
        let store = Self::new(workspace)?;
        match store.root.symlink_metadata() {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err(EvidenceStoreError::Invalid),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&store.root).map_err(|_| EvidenceStoreError::Unavailable)?;
            }
            Err(_) => return Err(EvidenceStoreError::Unavailable),
        }
        store.validate_root()?;
        for leaf in [AGENT_RUNS_DIRECTORY, LOGS_DIRECTORY] {
            let directory = store.root.join(leaf);
            match directory.symlink_metadata() {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => return Err(EvidenceStoreError::Invalid),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&directory).map_err(|_| EvidenceStoreError::Unavailable)?;
                }
                Err(_) => return Err(EvidenceStoreError::Unavailable),
            }
            validate_direct_directory(&store.root, &directory, leaf)?;
        }
        Ok(store)
    }

    pub(crate) fn open(workspace: &Path) -> Result<Self, EvidenceStoreError> {
        let store = Self::new(workspace)?;
        store.validate_root()?;
        validate_direct_directory(
            &store.root,
            &store.root.join(AGENT_RUNS_DIRECTORY),
            AGENT_RUNS_DIRECTORY,
        )?;
        validate_direct_directory(
            &store.root,
            &store.root.join(LOGS_DIRECTORY),
            LOGS_DIRECTORY,
        )?;
        Ok(store)
    }

    fn new(workspace: &Path) -> Result<Self, EvidenceStoreError> {
        if !workspace.is_absolute() {
            return Err(EvidenceStoreError::Invalid);
        }
        Ok(Self {
            workspace: workspace.to_owned(),
            root: workspace.join(EVIDENCE_DIRECTORY),
        })
    }

    pub(crate) fn write_initial(
        &self,
        context: &WorkspaceEvidenceContext,
        graph: &WorkspaceGraphManifest,
        plan: &WorkspaceVerificationPlan,
        result: &WorkspaceVerificationResult,
    ) -> Result<(), EvidenceStoreError> {
        self.write(CONTEXT_FILE, context)?;
        self.write(GRAPH_MANIFEST_FILE, graph)?;
        self.write(VERIFICATION_PLAN_FILE, plan)?;
        self.write(VERIFICATION_RESULT_FILE, result)?;
        self.write(
            VERIFICATION_HISTORY_FILE,
            &Vec::<WorkspaceVerificationResult>::new(),
        )?;
        self.write(
            AGENT_REPORT_FILE,
            &AgentReportDocument::empty(context.workspace_id),
        )
    }

    pub(crate) fn write_graph(
        &self,
        graph: &WorkspaceGraphManifest,
    ) -> Result<(), EvidenceStoreError> {
        self.write(GRAPH_MANIFEST_FILE, graph)
    }

    pub(crate) fn write_context(
        &self,
        context: &WorkspaceEvidenceContext,
    ) -> Result<(), EvidenceStoreError> {
        self.write(CONTEXT_FILE, context)
    }

    pub(crate) fn write_verification_plan(
        &self,
        plan: &WorkspaceVerificationPlan,
    ) -> Result<(), EvidenceStoreError> {
        self.write(VERIFICATION_PLAN_FILE, plan)
    }

    pub(crate) fn write_verification_result(
        &self,
        result: &WorkspaceVerificationResult,
    ) -> Result<(), EvidenceStoreError> {
        self.write(VERIFICATION_RESULT_FILE, result)?;
        if terminal_verification_result(result) {
            let mut history = self.read_verification_history()?;
            history.retain(|snapshot| {
                snapshot.workspace_id != result.workspace_id
                    || snapshot.plan_revision != result.plan_revision
                    || snapshot.started_at_unix_ms != result.started_at_unix_ms
            });
            history.insert(0, result.clone());
            history.truncate(MAX_VERIFICATION_HISTORY);
            self.write(VERIFICATION_HISTORY_FILE, &history)?;
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn write_verification_log(
        &self,
        check_id: &str,
        bytes: &[u8],
    ) -> Result<PathBuf, EvidenceStoreError> {
        if check_id.is_empty()
            || !check_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            || bytes.len() > MAX_LOG_FILE_BYTES
        {
            return Err(EvidenceStoreError::Invalid);
        }
        self.validate_root()?;
        let logs = self.root.join(LOGS_DIRECTORY);
        validate_direct_directory(&self.root, &logs, LOGS_DIRECTORY)?;
        let leaf = format!("{check_id}.log");
        atomic_replace_bytes(&logs, &leaf, bytes, MAX_LOG_FILE_BYTES)?;
        Ok(logs.join(leaf))
    }

    pub(crate) fn write_agent_run(&self, run: &AgentRunSummary) -> Result<(), EvidenceStoreError> {
        self.write_agent_run_with_retention(run, AGENT_RUN_RETENTION)
    }

    fn write_agent_run_with_retention(
        &self,
        run: &AgentRunSummary,
        retention: AgentRunRetention,
    ) -> Result<(), EvidenceStoreError> {
        self.validate_root()?;
        let runs = self.root.join(AGENT_RUNS_DIRECTORY);
        validate_direct_directory(&self.root, &runs, AGENT_RUNS_DIRECTORY)?;
        let leaf = format!("{}.json", run.run_id);
        atomic_replace_json(&runs, &leaf, run)?;
        self.retain_agent_runs(Some(run.run_id), retention)
            .map(|_| ())
    }

    pub(crate) fn read(&self) -> Result<WorkspaceEvidence, EvidenceStoreError> {
        self.validate_root()?;
        let context: WorkspaceEvidenceContext = read_json(&self.root, CONTEXT_FILE)?;
        let graph_manifest = read_json(&self.root, GRAPH_MANIFEST_FILE)?;
        let verification_plan = read_json(&self.root, VERIFICATION_PLAN_FILE)?;
        let verification_result = read_json(&self.root, VERIFICATION_RESULT_FILE)?;
        let verification_history = self.read_verification_history()?;
        if !self.root.join(AGENT_REPORT_FILE).exists() {
            let _ = self.write(
                AGENT_REPORT_FILE,
                &AgentReportDocument::empty(context.workspace_id),
            );
        }
        let agent_report = self.read_agent_report(&context, &graph_manifest);
        let agent_runs = self.read_agent_runs()?;
        Ok(WorkspaceEvidence {
            context,
            graph_manifest,
            verification_plan,
            verification_result,
            verification_history,
            agent_report,
            agent_runs,
        })
    }

    pub(crate) fn relocate_paths(
        &self,
        previous_workspace: &Path,
        current_workspace: &Path,
    ) -> Result<(), EvidenceStoreError> {
        if !previous_workspace.is_absolute()
            || !current_workspace.is_absolute()
            || previous_workspace == current_workspace
        {
            return Err(EvidenceStoreError::Invalid);
        }
        self.validate_root()?;
        for leaf in [
            CONTEXT_FILE,
            GRAPH_MANIFEST_FILE,
            VERIFICATION_PLAN_FILE,
            VERIFICATION_RESULT_FILE,
            VERIFICATION_HISTORY_FILE,
            AGENT_REPORT_FILE,
        ] {
            relocate_json_paths(&self.root, leaf, previous_workspace, current_workspace)?;
        }

        let runs = self.root.join(AGENT_RUNS_DIRECTORY);
        validate_direct_directory(&self.root, &runs, AGENT_RUNS_DIRECTORY)?;
        let mut entries = fs::read_dir(&runs)
            .map_err(|_| EvidenceStoreError::Unavailable)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| EvidenceStoreError::Unavailable)?;
        entries.sort_by_key(|entry| entry.file_name());
        if entries.len() > MAX_AGENT_RUNS {
            return Err(EvidenceStoreError::Invalid);
        }
        for entry in entries {
            let leaf = entry
                .file_name()
                .into_string()
                .map_err(|_| EvidenceStoreError::Invalid)?;
            if !leaf.ends_with(".json") {
                return Err(EvidenceStoreError::Invalid);
            }
            relocate_json_paths(&runs, &leaf, previous_workspace, current_workspace)?;
        }
        Ok(())
    }

    pub(crate) fn update_code_workspace_path(
        &self,
        code_workspace_display_path: &str,
    ) -> Result<(), EvidenceStoreError> {
        self.validate_root()?;
        if code_workspace_display_path.trim().is_empty()
            || !Path::new(code_workspace_display_path).is_absolute()
        {
            return Err(EvidenceStoreError::Invalid);
        }
        let mut context: WorkspaceEvidenceContext = read_json(&self.root, CONTEXT_FILE)?;
        context.code_workspace_display_path = code_workspace_display_path.to_owned();
        atomic_replace_json(&self.root, CONTEXT_FILE, &context)
    }

    fn read_agent_report(
        &self,
        context: &WorkspaceEvidenceContext,
        graph_manifest: &WorkspaceGraphManifest,
    ) -> WorkspaceAgentReport {
        let display_path = format!(
            "{}/{}",
            context.evidence_display_path.trim_end_matches('/'),
            AGENT_REPORT_FILE
        );
        let path = self.root.join(AGENT_REPORT_FILE);
        if !path.exists() {
            return WorkspaceAgentReport {
                schema_version: WORKSPACE_EVIDENCE_SCHEMA_VERSION,
                workspace_id: context.workspace_id,
                status: AgentReportStatus::NotReported,
                display_path,
                updated_at_unix_ms: None,
                summary: String::new(),
                scope: AgentReportScope::default(),
                environment: AgentEnvironmentPlan::default(),
                flows: Vec::new(),
                findings: Vec::new(),
                next_actions: Vec::new(),
                proposed_checks: Vec::new(),
                validation_flows: Vec::new(),
                detail: "No agent report has been published.".to_owned(),
            };
        }
        let document = read_json::<AgentReportDocument>(&self.root, AGENT_REPORT_FILE);
        let Ok(document) = document else {
            return invalid_agent_report(context.workspace_id, display_path);
        };
        if !valid_agent_report_document(&document, context, graph_manifest) {
            return invalid_agent_report(context.workspace_id, display_path);
        }
        let reported = document.updated_at_unix_ms.is_some()
            || !document.summary.is_empty()
            || document.scope.coverage != AgentReportCoverage::Unassessed
            || document.environment.status != AgentEnvironmentStatus::Unassessed
            || !document.flows.is_empty()
            || !document.findings.is_empty()
            || !document.next_actions.is_empty()
            || !document.proposed_checks.is_empty()
            || !document.validation_flows.is_empty();
        WorkspaceAgentReport {
            schema_version: document.schema_version,
            workspace_id: document.workspace_id,
            status: if reported {
                AgentReportStatus::Ready
            } else {
                AgentReportStatus::NotReported
            },
            display_path,
            updated_at_unix_ms: document.updated_at_unix_ms,
            summary: document.summary,
            scope: document.scope,
            environment: document.environment,
            flows: document.flows,
            findings: document.findings,
            next_actions: document.next_actions,
            proposed_checks: document.proposed_checks,
            validation_flows: document.validation_flows,
            detail: if reported {
                "Agent-authored notes loaded. WTS has not independently verified them.".to_owned()
            } else {
                "No agent report has been published.".to_owned()
            },
        }
    }

    fn read_verification_history(
        &self,
    ) -> Result<Vec<WorkspaceVerificationResult>, EvidenceStoreError> {
        if !self.root.join(VERIFICATION_HISTORY_FILE).exists() {
            return Ok(Vec::new());
        }
        let history =
            read_json::<Vec<WorkspaceVerificationResult>>(&self.root, VERIFICATION_HISTORY_FILE)?;
        if history.len() > MAX_VERIFICATION_HISTORY
            || history
                .iter()
                .any(|result| !terminal_verification_result(result))
        {
            return Err(EvidenceStoreError::Invalid);
        }
        Ok(history)
    }

    fn write(&self, leaf: &str, value: &impl Serialize) -> Result<(), EvidenceStoreError> {
        self.validate_root()?;
        atomic_replace_json(&self.root, leaf, value)
    }

    fn read_agent_runs(&self) -> Result<Vec<AgentRunSummary>, EvidenceStoreError> {
        self.retain_agent_runs(None, AGENT_RUN_RETENTION)
    }

    fn retain_agent_runs(
        &self,
        protected_run_id: Option<Uuid>,
        retention: AgentRunRetention,
    ) -> Result<Vec<AgentRunSummary>, EvidenceStoreError> {
        let runs = self.root.join(AGENT_RUNS_DIRECTORY);
        validate_direct_directory(&self.root, &runs, AGENT_RUNS_DIRECTORY)?;
        let entries = fs::read_dir(&runs)
            .map_err(|_| EvidenceStoreError::Unavailable)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| EvidenceStoreError::Unavailable)?;

        let mut stored = Vec::with_capacity(entries.len());
        for name in entries {
            let leaf = name.to_str().ok_or(EvidenceStoreError::Invalid)?;
            let run_id = leaf
                .strip_suffix(".json")
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or(EvidenceStoreError::Invalid)?;
            let path = fixed_child(&runs, leaf)?;
            let metadata = path
                .symlink_metadata()
                .map_err(|_| EvidenceStoreError::Unavailable)?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() > MAX_EVIDENCE_FILE_BYTES as u64
            {
                return Err(EvidenceStoreError::Invalid);
            }
            let summary: AgentRunSummary = read_json(&runs, leaf)?;
            if summary.run_id != run_id {
                return Err(EvidenceStoreError::Invalid);
            }
            stored.push(StoredAgentRun {
                leaf: leaf.to_owned(),
                bytes: metadata.len(),
                summary,
            });
        }

        stored.sort_by(|left, right| {
            let left_is_protected = Some(left.summary.run_id) == protected_run_id;
            let right_is_protected = Some(right.summary.run_id) == protected_run_id;
            right_is_protected
                .cmp(&left_is_protected)
                .then_with(|| {
                    agent_run_recency(&right.summary).cmp(&agent_run_recency(&left.summary))
                })
                .then_with(|| {
                    right
                        .summary
                        .started_at_unix_ms
                        .cmp(&left.summary.started_at_unix_ms)
                })
                .then_with(|| right.summary.run_id.cmp(&left.summary.run_id))
        });

        let mut retained_count = 0usize;
        let mut retained_bytes = 0u64;
        for candidate in &stored {
            if retained_count == retention.maximum_count {
                break;
            }
            let Some(next_bytes) = retained_bytes.checked_add(candidate.bytes) else {
                break;
            };
            if next_bytes > retention.maximum_bytes {
                break;
            }
            retained_count += 1;
            retained_bytes = next_bytes;
        }

        let mut pruned = stored.split_off(retained_count);
        let removed_any = !pruned.is_empty();
        pruned.sort_by(|left, right| left.leaf.cmp(&right.leaf));
        for candidate in pruned {
            let path = fixed_child(&runs, &candidate.leaf)?;
            let metadata = path
                .symlink_metadata()
                .map_err(|_| EvidenceStoreError::Unavailable)?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() != candidate.bytes
            {
                return Err(EvidenceStoreError::Invalid);
            }
            let current: AgentRunSummary = read_json(&runs, &candidate.leaf)?;
            if current != candidate.summary {
                return Err(EvidenceStoreError::Invalid);
            }
            fs::remove_file(path).map_err(|_| EvidenceStoreError::Unavailable)?;
        }
        if removed_any {
            let _ = File::open(&runs).and_then(|directory| directory.sync_all());
        }

        Ok(stored
            .into_iter()
            .map(|candidate| candidate.summary)
            .collect())
    }

    fn validate_root(&self) -> Result<(), EvidenceStoreError> {
        validate_direct_directory(&self.workspace, &self.root, EVIDENCE_DIRECTORY)
    }
}

fn agent_run_recency(run: &AgentRunSummary) -> i64 {
    run.completed_at_unix_ms
        .unwrap_or(run.started_at_unix_ms)
        .max(run.started_at_unix_ms)
}

fn terminal_verification_result(result: &WorkspaceVerificationResult) -> bool {
    matches!(
        result.status,
        VerificationStatus::Passed
            | VerificationStatus::Failed
            | VerificationStatus::Blocked
            | VerificationStatus::Cancelled
    ) && result.completed_at_unix_ms.is_some()
}

fn invalid_agent_report(workspace_id: Uuid, display_path: String) -> WorkspaceAgentReport {
    WorkspaceAgentReport {
        schema_version: WORKSPACE_EVIDENCE_SCHEMA_VERSION,
        workspace_id,
        status: AgentReportStatus::Invalid,
        display_path,
        updated_at_unix_ms: None,
        summary: String::new(),
        scope: AgentReportScope::default(),
        environment: AgentEnvironmentPlan::default(),
        flows: Vec::new(),
        findings: Vec::new(),
        next_actions: Vec::new(),
        proposed_checks: Vec::new(),
        validation_flows: Vec::new(),
        detail: "The agent report is malformed or outside the allowed workspace scope.".to_owned(),
    }
}

fn validate_agent_report_context(
    workspace: &Path,
    evidence_root: &Path,
    context: &WorkspaceEvidenceContext,
) -> Result<(), String> {
    if context.schema_version != WORKSPACE_EVIDENCE_SCHEMA_VERSION {
        return Err(format!(
            "context schemaVersion must be {WORKSPACE_EVIDENCE_SCHEMA_VERSION}"
        ));
    }
    let workspace_canonical = trusted_directory(workspace, "workspaceDisplayPath")?;
    let context_workspace = trusted_directory(
        Path::new(&context.workspace_display_path),
        "workspaceDisplayPath",
    )?;
    if context_workspace != workspace_canonical {
        return Err("context workspaceDisplayPath does not identify this workspace".to_owned());
    }
    let evidence_canonical = trusted_directory(evidence_root, "evidenceDisplayPath")?;
    let context_evidence = trusted_directory(
        Path::new(&context.evidence_display_path),
        "evidenceDisplayPath",
    )?;
    if context_evidence != evidence_canonical {
        return Err("context evidenceDisplayPath does not identify this .wts directory".to_owned());
    }

    let mut repository_ids = std::collections::BTreeSet::new();
    for (index, repository) in context.repositories.iter().enumerate() {
        if !valid_agent_id(&repository.repository_id) {
            return Err(format!(
                "repositories[{index}].repositoryId contains unsupported characters"
            ));
        }
        if !repository_ids.insert(repository.repository_id.as_str()) {
            return Err(format!("repositories[{index}].repositoryId is duplicated"));
        }
        let worktree = trusted_directory(
            Path::new(&repository.worktree_display_path),
            &format!("repositories[{index}].worktreeDisplayPath"),
        )?;
        if !worktree.starts_with(&workspace_canonical) || worktree == workspace_canonical {
            return Err(format!(
                "repositories[{index}].worktreeDisplayPath must be inside this workspace"
            ));
        }
    }

    let allowed_ids = context
        .allowed_repository_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    if allowed_ids.len() != context.allowed_repository_ids.len() || allowed_ids != repository_ids {
        return Err(
            "allowedRepositoryIds must contain each context repository exactly once".to_owned(),
        );
    }
    Ok(())
}

fn trusted_directory(path: &Path, field: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{field} must be absolute"));
    }
    let metadata = path
        .symlink_metadata()
        .map_err(|_| format!("{field} does not identify an existing directory"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "{field} must identify a directory and may not be a symbolic link"
        ));
    }
    path.canonicalize()
        .map_err(|_| format!("{field} could not be resolved"))
}

fn trusted_nested_working_directory(repository_root: &Path, candidate: &Path) -> bool {
    let Ok(root) = trusted_directory(repository_root, "repository worktree") else {
        return false;
    };
    if !candidate.is_absolute() {
        return false;
    }
    let Ok(relative) = candidate.strip_prefix(repository_root) else {
        return false;
    };
    if relative
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return relative.as_os_str().is_empty() && candidate == repository_root;
    }
    let mut current = repository_root.to_owned();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return false;
        };
        current.push(component);
        let Ok(metadata) = current.symlink_metadata() else {
            return false;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return false;
        }
    }
    candidate
        .canonicalize()
        .is_ok_and(|canonical| canonical == root || canonical.starts_with(&root))
}

fn valid_agent_report_document(
    report: &AgentReportDocument,
    context: &WorkspaceEvidenceContext,
    graph_manifest: &WorkspaceGraphManifest,
) -> bool {
    validate_agent_report_document(report, context, graph_manifest).is_ok()
}

fn validate_agent_report_document(
    report: &AgentReportDocument,
    context: &WorkspaceEvidenceContext,
    graph_manifest: &WorkspaceGraphManifest,
) -> Result<(), AgentReportPublishError> {
    if report.schema_version != WORKSPACE_EVIDENCE_SCHEMA_VERSION {
        return invalid_report(
            "schemaVersion",
            format!("must be {WORKSPACE_EVIDENCE_SCHEMA_VERSION}"),
        );
    }
    if report.workspace_id != context.workspace_id {
        return invalid_report(
            "workspaceId",
            "must exactly match .wts/context.json".to_owned(),
        );
    }
    if report
        .updated_at_unix_ms
        .is_some_and(|timestamp| timestamp < 0)
    {
        return invalid_report(
            "updatedAtUnixMs",
            "must be a non-negative Unix timestamp".to_owned(),
        );
    }
    if report.summary.chars().count() > MAX_AGENT_SUMMARY_CHARS {
        return invalid_report(
            "summary",
            format!("must not exceed {MAX_AGENT_SUMMARY_CHARS} characters"),
        );
    }
    validate_agent_report_scope(&report.scope, context, graph_manifest)?;
    validate_agent_environment_plan(&report.environment, &report.scope, context)?;
    if report.flows.len() > MAX_AGENT_FLOWS {
        return invalid_report(
            "flows",
            format!("must not contain more than {MAX_AGENT_FLOWS} items"),
        );
    }
    if report.findings.len() > MAX_AGENT_FINDINGS {
        return invalid_report(
            "findings",
            format!("must not contain more than {MAX_AGENT_FINDINGS} items"),
        );
    }
    if report.next_actions.len() > MAX_AGENT_NEXT_ACTIONS {
        return invalid_report(
            "nextActions",
            format!("must not contain more than {MAX_AGENT_NEXT_ACTIONS} items"),
        );
    }
    if report.proposed_checks.len() > MAX_AGENT_PROPOSED_CHECKS {
        return invalid_report(
            "proposedChecks",
            format!("must not contain more than {MAX_AGENT_PROPOSED_CHECKS} items"),
        );
    }
    if report.validation_flows.len() > MAX_AGENT_VALIDATION_FLOWS {
        return invalid_report(
            "validationFlows",
            format!("must not contain more than {MAX_AGENT_VALIDATION_FLOWS} items"),
        );
    }

    for (index, action) in report.next_actions.iter().enumerate() {
        if action.trim().is_empty() || action.chars().count() > MAX_NEXT_ACTION_CHARS {
            return invalid_report(
                format!("nextActions[{index}]"),
                format!("must be non-empty and at most {MAX_NEXT_ACTION_CHARS} characters"),
            );
        }
    }

    if !unique_ids(report.findings.iter().map(|finding| finding.id.as_str())) {
        return invalid_report("findings", "finding ids must be unique".to_owned());
    }
    for (index, finding) in report.findings.iter().enumerate() {
        let field = |name: &str| format!("findings[{index}].{name}");
        if !valid_agent_id(&finding.id) {
            return invalid_report(
                field("id"),
                "must contain only letters, digits, period, hyphen, or underscore".to_owned(),
            );
        }
        if finding.title.trim().is_empty()
            || finding.title.chars().count() > MAX_FINDING_TITLE_CHARS
        {
            return invalid_report(
                field("title"),
                format!("must be non-empty and at most {MAX_FINDING_TITLE_CHARS} characters"),
            );
        }
        if finding.detail.chars().count() > MAX_FINDING_DETAIL_CHARS {
            return invalid_report(
                field("detail"),
                format!("must not exceed {MAX_FINDING_DETAIL_CHARS} characters"),
            );
        }
        validate_evidence_list(&finding.evidence, &field("evidence"))?;
        if let Some(repository_id) = &finding.repository_id
            && !context
                .allowed_repository_ids
                .iter()
                .any(|allowed| allowed == repository_id)
        {
            return invalid_report(
                field("repositoryId"),
                "must name a repository from .wts/context.json".to_owned(),
            );
        }
        if finding.flow_ids.len() > MAX_AGENT_FLOWS
            || !unique_ids(finding.flow_ids.iter().map(String::as_str))
        {
            return invalid_report(
                field("flowIds"),
                "must contain unique bounded flow ids".to_owned(),
            );
        }
        for flow_id in &finding.flow_ids {
            if !report.flows.iter().any(|flow| flow.id == *flow_id) {
                return invalid_report(
                    field("flowIds"),
                    format!("references unknown flow {flow_id}"),
                );
            }
        }
    }

    if !unique_ids(report.proposed_checks.iter().map(|check| check.id.as_str())) {
        return invalid_report("proposedChecks", "check ids must be unique".to_owned());
    }
    for (index, check) in report.proposed_checks.iter().enumerate() {
        validate_agent_proposed_check(check, context, index)?;
    }

    if !unique_ids(report.validation_flows.iter().map(|flow| flow.id.as_str())) {
        return invalid_report("validationFlows", "flow ids must be unique".to_owned());
    }
    for (index, flow) in report.validation_flows.iter().enumerate() {
        validate_agent_validation_flow(flow, index)?;
    }
    if !unique_ids(report.flows.iter().map(|flow| flow.id.as_str())) {
        return invalid_report("flows", "flow ids must be unique".to_owned());
    }
    for (index, flow) in report.flows.iter().enumerate() {
        validate_agent_flow(flow, &report.scope, &report.proposed_checks, context, index)?;
    }
    Ok(())
}

fn validate_agent_environment_plan(
    environment: &AgentEnvironmentPlan,
    scope: &AgentReportScope,
    context: &WorkspaceEvidenceContext,
) -> Result<(), AgentReportPublishError> {
    if environment.status == AgentEnvironmentStatus::Unassessed {
        if environment != &AgentEnvironmentPlan::default() {
            return invalid_report(
                "environment.status",
                "unassessed environment setup must use an empty default plan".to_owned(),
            );
        }
        return Ok(());
    }
    if scope.coverage == AgentReportCoverage::Unassessed
        || scope.graph_status != WorkspaceGraphEvidenceStatus::Ready
    {
        return invalid_report(
            "environment.status",
            "an assessed environment setup requires graph-backed repository coverage".to_owned(),
        );
    }
    if !valid_validation_text(&environment.summary) {
        return invalid_report(
            "environment.summary",
            format!("must be non-empty and at most {MAX_VALIDATION_TEXT_CHARS} characters"),
        );
    }
    if environment.requirements.len() > MAX_ENVIRONMENT_REQUIREMENTS {
        return invalid_report(
            "environment.requirements",
            format!("must not contain more than {MAX_ENVIRONMENT_REQUIREMENTS} items"),
        );
    }
    if environment.setup_steps.len() > MAX_ENVIRONMENT_SETUP_STEPS {
        return invalid_report(
            "environment.setupSteps",
            format!("must not contain more than {MAX_ENVIRONMENT_SETUP_STEPS} items"),
        );
    }
    if environment.unresolved.len() > MAX_ENVIRONMENT_UNRESOLVED
        || environment
            .unresolved
            .iter()
            .any(|item| !valid_validation_text(item))
    {
        return invalid_report(
            "environment.unresolved",
            format!("must contain at most {MAX_ENVIRONMENT_UNRESOLVED} bounded entries"),
        );
    }
    match environment.status {
        AgentEnvironmentStatus::Planned if !environment.unresolved.is_empty() => {
            return invalid_report(
                "environment.status",
                "planned setup cannot contain unresolved items".to_owned(),
            );
        }
        AgentEnvironmentStatus::NeedsInput | AgentEnvironmentStatus::Blocked
            if environment.unresolved.is_empty() =>
        {
            return invalid_report(
                "environment.status",
                "needsInput and blocked setup plans require at least one unresolved item"
                    .to_owned(),
            );
        }
        _ => {}
    }
    if environment.requirements.is_empty() && environment.setup_steps.is_empty() {
        return invalid_report(
            "environment",
            "an assessed setup plan must contain a requirement or setup step".to_owned(),
        );
    }
    if !unique_ids(
        environment
            .requirements
            .iter()
            .map(|requirement| requirement.id.as_str()),
    ) {
        return invalid_report(
            "environment.requirements",
            "requirement ids must be unique".to_owned(),
        );
    }
    for (index, requirement) in environment.requirements.iter().enumerate() {
        let field = |name: &str| format!("environment.requirements[{index}].{name}");
        validate_environment_repository(
            &requirement.repository_id,
            scope,
            context,
            &field("repositoryId"),
        )?;
        if !valid_agent_id(&requirement.id) {
            return invalid_report(
                field("id"),
                "must contain only letters, digits, period, hyphen, or underscore".to_owned(),
            );
        }
        if !valid_validation_text(&requirement.name) || !valid_validation_text(&requirement.detail)
        {
            return invalid_report(
                field("detail"),
                format!(
                    "name and detail must be non-empty and at most {MAX_VALIDATION_TEXT_CHARS} characters"
                ),
            );
        }
        validate_environment_evidence(
            &requirement.evidence,
            &requirement.repository_id,
            context,
            &field("evidence"),
        )?;
    }
    if !unique_ids(environment.setup_steps.iter().map(|step| step.id.as_str())) {
        return invalid_report(
            "environment.setupSteps",
            "setup step ids must be unique".to_owned(),
        );
    }
    for (index, step) in environment.setup_steps.iter().enumerate() {
        let field = |name: &str| format!("environment.setupSteps[{index}].{name}");
        let repository = validate_environment_repository(
            &step.repository_id,
            scope,
            context,
            &field("repositoryId"),
        )?;
        if !valid_agent_id(&step.id) || !valid_validation_text(&step.action) {
            return invalid_report(
                field("id"),
                "id and action must be non-empty bounded values".to_owned(),
            );
        }
        if !trusted_nested_working_directory(
            Path::new(&repository.worktree_display_path),
            Path::new(&step.working_directory),
        ) {
            return invalid_report(
                field("workingDirectory"),
                "must identify an existing non-symlink directory in the stated repository"
                    .to_owned(),
            );
        }
        if step.command.is_empty()
            || step.command.len() > MAX_PROPOSAL_ARGUMENTS + 1
            || step.command.iter().any(|argument| {
                argument.is_empty() || argument.chars().count() > MAX_PROPOSAL_ARGUMENT_CHARS
            })
        {
            return invalid_report(
                field("command"),
                "must contain a bounded executable and argument vector".to_owned(),
            );
        }
        validate_environment_evidence(
            &step.evidence,
            &step.repository_id,
            context,
            &field("evidence"),
        )?;
    }
    Ok(())
}

fn validate_environment_repository<'a>(
    repository_id: &str,
    scope: &AgentReportScope,
    context: &'a WorkspaceEvidenceContext,
    field: &str,
) -> Result<&'a EvidenceRepository, AgentReportPublishError> {
    let Some(repository) = context
        .repositories
        .iter()
        .find(|repository| repository.repository_id == repository_id)
    else {
        return invalid_report(
            field,
            "must name a repository from .wts/context.json".to_owned(),
        );
    };
    if !scope
        .reviewed_repository_ids
        .iter()
        .any(|reviewed| reviewed == repository_id)
    {
        return invalid_report(
            field,
            "must name a repository listed in scope.reviewedRepositoryIds".to_owned(),
        );
    }
    Ok(repository)
}

fn validate_environment_evidence(
    evidence: &[AgentFlowEvidence],
    repository_id: &str,
    context: &WorkspaceEvidenceContext,
    field: &str,
) -> Result<(), AgentReportPublishError> {
    if evidence.is_empty() || evidence.len() > MAX_FINDING_EVIDENCE {
        return invalid_report(
            field,
            format!("must contain between 1 and {MAX_FINDING_EVIDENCE} entries"),
        );
    }
    let repository = context
        .repositories
        .iter()
        .find(|repository| repository.repository_id == repository_id)
        .expect("repository was validated before environment evidence");
    for (index, item) in evidence.iter().enumerate() {
        let item_field = format!("{field}[{index}]");
        if item.repository_id != repository_id {
            return invalid_report(
                format!("{item_field}.repositoryId"),
                "must match the containing environment item repositoryId".to_owned(),
            );
        }
        validate_flow_evidence_path(item, repository, &item_field)?;
    }
    Ok(())
}

fn invalid_report<T>(
    field: impl Into<String>,
    message: String,
) -> Result<T, AgentReportPublishError> {
    Err(AgentReportPublishError::InvalidReport {
        field: field.into(),
        message,
    })
}

fn validate_agent_report_scope(
    scope: &AgentReportScope,
    context: &WorkspaceEvidenceContext,
    graph_manifest: &WorkspaceGraphManifest,
) -> Result<(), AgentReportPublishError> {
    if scope.coverage == AgentReportCoverage::Unassessed {
        if scope != &AgentReportScope::default() {
            return invalid_report(
                "scope.coverage",
                "unassessed coverage must use an empty default scope".to_owned(),
            );
        }
        return Ok(());
    }
    if graph_manifest.schema_version != WORKSPACE_EVIDENCE_SCHEMA_VERSION
        || graph_manifest.workspace_id != context.workspace_id
    {
        return invalid_report(
            "scope.graphStatus",
            "trusted graph manifest does not match this workspace".to_owned(),
        );
    }
    if scope.graph_status != graph_manifest.status {
        return invalid_report(
            "scope.graphStatus",
            "must match the current trusted graph manifest".to_owned(),
        );
    }
    match scope.graph_status {
        WorkspaceGraphEvidenceStatus::Ready => {
            let Some(report_digest) = scope.graph_sha256.as_deref() else {
                return invalid_report(
                    "scope.graphSha256",
                    "is required when graphStatus is ready".to_owned(),
                );
            };
            if !valid_sha256(report_digest)
                || graph_manifest.graph_sha256.as_deref() != Some(report_digest)
            {
                return invalid_report(
                    "scope.graphSha256",
                    "must exactly match the current trusted graph manifest digest".to_owned(),
                );
            }
        }
        WorkspaceGraphEvidenceStatus::NotStarted | WorkspaceGraphEvidenceStatus::Failed => {
            if scope.graph_sha256.is_some() {
                return invalid_report(
                    "scope.graphSha256",
                    "must be absent unless graphStatus is ready".to_owned(),
                );
            }
        }
    }

    let allowed = context
        .allowed_repository_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let reviewed = scope
        .reviewed_repository_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let unresolved = scope
        .unresolved_repository_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    let skipped = scope
        .skipped_repositories
        .iter()
        .map(|item| item.repository_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    if reviewed.len() != scope.reviewed_repository_ids.len()
        || unresolved.len() != scope.unresolved_repository_ids.len()
        || skipped.len() != scope.skipped_repositories.len()
    {
        return invalid_report(
            "scope",
            "repository ids must be unique within each coverage group".to_owned(),
        );
    }
    for (index, item) in scope.skipped_repositories.iter().enumerate() {
        if !valid_validation_text(&item.reason) {
            return invalid_report(
                format!("scope.skippedRepositories[{index}].reason"),
                format!("must be non-empty and at most {MAX_VALIDATION_TEXT_CHARS} characters"),
            );
        }
    }
    let overlap = reviewed
        .intersection(&unresolved)
        .next()
        .or_else(|| reviewed.intersection(&skipped).next())
        .or_else(|| unresolved.intersection(&skipped).next());
    if overlap.is_some() {
        return invalid_report(
            "scope",
            "each repository must appear in exactly one coverage group".to_owned(),
        );
    }
    let accounted = reviewed
        .union(&unresolved)
        .copied()
        .collect::<std::collections::BTreeSet<_>>()
        .union(&skipped)
        .copied()
        .collect::<std::collections::BTreeSet<_>>();

    match scope.coverage {
        AgentReportCoverage::Unassessed => unreachable!("handled above"),
        AgentReportCoverage::Complete => {
            if reviewed != allowed || !unresolved.is_empty() || !skipped.is_empty() {
                return invalid_report(
                    "scope.coverage",
                    "complete coverage requires every workspace repository to be reviewed"
                        .to_owned(),
                );
            }
        }
        AgentReportCoverage::Partial => {
            if accounted != allowed
                || reviewed.is_empty()
                || unresolved.is_empty() && skipped.is_empty()
            {
                return invalid_report(
                    "scope.coverage",
                    "partial coverage must review at least one repository and account for every other repository as unresolved or skipped".to_owned(),
                );
            }
        }
    }
    Ok(())
}

fn validate_agent_flow(
    flow: &AgentFlow,
    scope: &AgentReportScope,
    proposed_checks: &[AgentProposedCheck],
    context: &WorkspaceEvidenceContext,
    index: usize,
) -> Result<(), AgentReportPublishError> {
    let field = |name: &str| format!("flows[{index}].{name}");
    if scope.coverage == AgentReportCoverage::Unassessed {
        return invalid_report(
            field("id"),
            "flows require partial or complete repository coverage".to_owned(),
        );
    }
    if !valid_agent_id(&flow.id) {
        return invalid_report(
            field("id"),
            "must contain only letters, digits, period, hyphen, or underscore".to_owned(),
        );
    }
    if flow.title.trim().is_empty() || flow.title.chars().count() > MAX_FINDING_TITLE_CHARS {
        return invalid_report(
            field("title"),
            format!("must be non-empty and at most {MAX_FINDING_TITLE_CHARS} characters"),
        );
    }
    validate_flow_text_list(&flow.actors, &field("actors"), true)?;
    validate_flow_text_list(&flow.entry_points, &field("entryPoints"), true)?;
    validate_flow_text_list(&flow.risks, &field("risks"), false)?;
    validate_flow_text_list(&flow.existing_coverage, &field("existingCoverage"), false)?;
    if !valid_validation_text(&flow.expected_outcome) {
        return invalid_report(
            field("expectedOutcome"),
            format!("must be non-empty and at most {MAX_VALIDATION_TEXT_CHARS} characters"),
        );
    }
    if flow.steps.is_empty() || flow.steps.len() > MAX_AGENT_FLOW_STEPS {
        return invalid_report(
            field("steps"),
            format!("must contain between 1 and {MAX_AGENT_FLOW_STEPS} steps"),
        );
    }
    if !unique_ids(flow.steps.iter().map(|step| step.id.as_str())) {
        return invalid_report(field("steps"), "step ids must be unique".to_owned());
    }
    for (step_index, step) in flow.steps.iter().enumerate() {
        validate_agent_flow_step(step, scope, context, index, step_index)?;
    }
    if flow.verification_candidate_ids.len() > MAX_AGENT_PROPOSED_CHECKS
        || !unique_ids(flow.verification_candidate_ids.iter().map(String::as_str))
    {
        return invalid_report(
            field("verificationCandidateIds"),
            "must contain unique bounded check ids".to_owned(),
        );
    }
    for candidate_id in &flow.verification_candidate_ids {
        if !proposed_checks
            .iter()
            .any(|check| check.id == *candidate_id)
        {
            return invalid_report(
                field("verificationCandidateIds"),
                format!("references unknown proposed check {candidate_id}"),
            );
        }
    }
    Ok(())
}

fn validate_agent_flow_step(
    step: &AgentFlowStep,
    scope: &AgentReportScope,
    context: &WorkspaceEvidenceContext,
    flow_index: usize,
    step_index: usize,
) -> Result<(), AgentReportPublishError> {
    let field = |name: &str| format!("flows[{flow_index}].steps[{step_index}].{name}");
    if !valid_agent_id(&step.id) {
        return invalid_report(
            field("id"),
            "must contain only letters, digits, period, hyphen, or underscore".to_owned(),
        );
    }
    let Some(repository) = context
        .repositories
        .iter()
        .find(|repository| repository.repository_id == step.repository_id)
    else {
        return invalid_report(
            field("repositoryId"),
            "must name a repository from .wts/context.json".to_owned(),
        );
    };
    if !scope
        .reviewed_repository_ids
        .iter()
        .any(|repository_id| repository_id == &step.repository_id)
    {
        return invalid_report(
            field("repositoryId"),
            "must name a repository listed in scope.reviewedRepositoryIds".to_owned(),
        );
    }
    if !valid_validation_text(&step.component) {
        return invalid_report(
            field("component"),
            format!("must be non-empty and at most {MAX_VALIDATION_TEXT_CHARS} characters"),
        );
    }
    if !valid_validation_text(&step.action) {
        return invalid_report(
            field("action"),
            format!("must be non-empty and at most {MAX_VALIDATION_TEXT_CHARS} characters"),
        );
    }
    if step.evidence.is_empty() || step.evidence.len() > MAX_FINDING_EVIDENCE {
        return invalid_report(
            field("evidence"),
            format!("must contain between 1 and {MAX_FINDING_EVIDENCE} entries"),
        );
    }
    for (evidence_index, evidence) in step.evidence.iter().enumerate() {
        let evidence_field =
            format!("flows[{flow_index}].steps[{step_index}].evidence[{evidence_index}]");
        if evidence.repository_id != step.repository_id {
            return invalid_report(
                format!("{evidence_field}.repositoryId"),
                "must match the containing step repositoryId".to_owned(),
            );
        }
        validate_flow_evidence_path(evidence, repository, &evidence_field)?;
    }
    Ok(())
}

fn validate_flow_evidence_path(
    evidence: &AgentFlowEvidence,
    repository: &EvidenceRepository,
    field: &str,
) -> Result<(), AgentReportPublishError> {
    if evidence.path.is_empty()
        || evidence.path.chars().count() > MAX_FINDING_EVIDENCE_CHARS
        || Path::new(&evidence.path).is_absolute()
        || Path::new(&evidence.path)
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return invalid_report(
            format!("{field}.path"),
            "must be a bounded relative path inside the stated repository".to_owned(),
        );
    }
    let root = trusted_directory(
        Path::new(&repository.worktree_display_path),
        &format!("{field}.repositoryId"),
    )
    .map_err(|message| AgentReportPublishError::InvalidReport {
        field: format!("{field}.repositoryId"),
        message,
    })?;
    let candidate = root.join(&evidence.path);
    let canonical =
        candidate
            .canonicalize()
            .map_err(|_| AgentReportPublishError::InvalidReport {
                field: format!("{field}.path"),
                message: "must identify existing evidence inside the stated repository".to_owned(),
            })?;
    if !canonical.starts_with(&root) || canonical == root {
        return invalid_report(
            format!("{field}.path"),
            "must remain inside the stated repository".to_owned(),
        );
    }
    if evidence.line.is_some_and(|line| line == 0)
        || evidence.line.is_some() && !canonical.is_file()
    {
        return invalid_report(
            format!("{field}.line"),
            "must be a positive line number on file evidence".to_owned(),
        );
    }
    Ok(())
}

fn validate_flow_text_list(
    values: &[String],
    field: &str,
    required: bool,
) -> Result<(), AgentReportPublishError> {
    if (required && values.is_empty())
        || values.len() > MAX_FLOW_TEXT_ITEMS
        || values.iter().any(|value| !valid_validation_text(value))
    {
        return invalid_report(
            field,
            format!(
                "must contain {} and at most {MAX_FLOW_TEXT_ITEMS} bounded entries",
                if required {
                    "at least one entry"
                } else {
                    "zero or more entries"
                }
            ),
        );
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn validate_agent_proposed_check(
    check: &AgentProposedCheck,
    context: &WorkspaceEvidenceContext,
    index: usize,
) -> Result<(), AgentReportPublishError> {
    let field = |name: &str| format!("proposedChecks[{index}].{name}");
    let Some(repository) = context
        .repositories
        .iter()
        .find(|repository| repository.repository_id == check.repository_id)
    else {
        return invalid_report(
            field("repositoryId"),
            "must name a repository from .wts/context.json".to_owned(),
        );
    };
    if !valid_agent_id(&check.id) {
        return invalid_report(
            field("id"),
            "must contain only letters, digits, period, hyphen, or underscore".to_owned(),
        );
    }
    if check.label.trim().is_empty() || check.label.chars().count() > MAX_FINDING_TITLE_CHARS {
        return invalid_report(
            field("label"),
            format!("must be non-empty and at most {MAX_FINDING_TITLE_CHARS} characters"),
        );
    }
    if !trusted_nested_working_directory(
        Path::new(&repository.worktree_display_path),
        Path::new(&check.working_directory),
    ) {
        return invalid_report(
            field("workingDirectory"),
            format!(
                "must identify a non-symlink directory at or beneath repository {} worktreeDisplayPath",
                check.repository_id
            ),
        );
    }
    if check.args.len() > MAX_PROPOSAL_ARGUMENTS
        || check.args.iter().any(|argument| {
            argument.is_empty() || argument.chars().count() > MAX_PROPOSAL_ARGUMENT_CHARS
        })
    {
        return invalid_report(
            field("args"),
            format!("must contain at most {MAX_PROPOSAL_ARGUMENTS} non-empty bounded arguments"),
        );
    }
    if !crate::verification::approved_fixed_command(&check.executable, &check.args) {
        return invalid_report(
            field("executable"),
            "supported commands are `cargo test --quiet`, `npm test --silent`, `pytest --quiet`, `python[3] -m pytest --quiet`, and `go test ./...`".to_owned(),
        );
    }
    if check.timeout_ms == 0 || check.timeout_ms > MAX_PROPOSED_TIMEOUT_MS {
        return invalid_report(
            field("timeoutMs"),
            format!("must be between 1 and {MAX_PROPOSED_TIMEOUT_MS} milliseconds"),
        );
    }
    if check.environment_names.len() > MAX_PROPOSAL_ENVIRONMENT_NAMES
        || check.environment_names.iter().any(|name| name != "CI")
    {
        return invalid_report(
            field("environmentNames"),
            "may contain only the trusted CI environment name".to_owned(),
        );
    }
    if check.reason.trim().is_empty() || check.reason.chars().count() > MAX_PROPOSAL_REASON_CHARS {
        return invalid_report(
            field("reason"),
            format!("must be non-empty and at most {MAX_PROPOSAL_REASON_CHARS} characters"),
        );
    }
    validate_evidence_list(&check.evidence, &field("evidence"))
}

fn validate_agent_validation_flow(
    flow: &AgentValidationFlow,
    index: usize,
) -> Result<(), AgentReportPublishError> {
    let field = |name: &str| format!("validationFlows[{index}].{name}");
    if !valid_agent_id(&flow.id) {
        return invalid_report(
            field("id"),
            "must contain only letters, digits, period, hyphen, or underscore".to_owned(),
        );
    }
    if flow.title.trim().is_empty() || flow.title.chars().count() > MAX_FINDING_TITLE_CHARS {
        return invalid_report(
            field("title"),
            format!("must be non-empty and at most {MAX_FINDING_TITLE_CHARS} characters"),
        );
    }
    if !valid_validation_text(&flow.goal) {
        return invalid_report(
            field("goal"),
            format!("must be non-empty and at most {MAX_VALIDATION_TEXT_CHARS} characters"),
        );
    }
    if flow.prerequisites.len() > MAX_FINDING_EVIDENCE
        || flow
            .prerequisites
            .iter()
            .any(|item| !valid_validation_text(item))
    {
        return invalid_report(
            field("prerequisites"),
            format!("must contain at most {MAX_FINDING_EVIDENCE} non-empty bounded prerequisites"),
        );
    }
    if flow.steps.is_empty() || flow.steps.len() > MAX_VALIDATION_FLOW_STEPS {
        return invalid_report(
            field("steps"),
            format!("must contain between 1 and {MAX_VALIDATION_FLOW_STEPS} steps"),
        );
    }
    if !unique_ids(flow.steps.iter().map(|step| step.id.as_str())) {
        return invalid_report(field("steps"), "step ids must be unique".to_owned());
    }
    for (step_index, step) in flow.steps.iter().enumerate() {
        let step_field =
            |name: &str| format!("validationFlows[{index}].steps[{step_index}].{name}");
        if !valid_agent_id(&step.id) {
            return invalid_report(
                step_field("id"),
                "must contain only letters, digits, period, hyphen, or underscore".to_owned(),
            );
        }
        if !valid_validation_text(&step.action) {
            return invalid_report(
                step_field("action"),
                format!("must be non-empty and at most {MAX_VALIDATION_TEXT_CHARS} characters"),
            );
        }
        if !valid_validation_text(&step.expected) {
            return invalid_report(
                step_field("expected"),
                format!("must be non-empty and at most {MAX_VALIDATION_TEXT_CHARS} characters"),
            );
        }
        validate_evidence_list(&step.evidence, &step_field("evidence"))?;
    }
    Ok(())
}

fn valid_agent_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_evidence_text(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= MAX_FINDING_EVIDENCE_CHARS
}

fn validate_evidence_list(evidence: &[String], field: &str) -> Result<(), AgentReportPublishError> {
    if evidence.len() > MAX_FINDING_EVIDENCE
        || evidence.iter().any(|item| !valid_evidence_text(item))
    {
        return invalid_report(
            field,
            format!(
                "must contain at most {MAX_FINDING_EVIDENCE} non-empty entries of at most {MAX_FINDING_EVIDENCE_CHARS} characters"
            ),
        );
    }
    Ok(())
}

fn valid_validation_text(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= MAX_VALIDATION_TEXT_CHARS
}

fn unique_ids<'a>(mut ids: impl Iterator<Item = &'a str>) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    ids.all(|id| seen.insert(id))
}

fn validate_direct_directory(
    parent: &Path,
    candidate: &Path,
    expected_leaf: &str,
) -> Result<(), EvidenceStoreError> {
    if candidate.parent() != Some(parent)
        || candidate.file_name().and_then(|name| name.to_str()) != Some(expected_leaf)
    {
        return Err(EvidenceStoreError::Invalid);
    }
    let metadata = candidate
        .symlink_metadata()
        .map_err(|_| EvidenceStoreError::Unavailable)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(EvidenceStoreError::Invalid);
    }
    Ok(())
}

fn read_json<T: DeserializeOwned>(parent: &Path, leaf: &str) -> Result<T, EvidenceStoreError> {
    let path = fixed_child(parent, leaf)?;
    let metadata = path
        .symlink_metadata()
        .map_err(|_| EvidenceStoreError::Unavailable)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() as usize > MAX_EVIDENCE_FILE_BYTES
    {
        return Err(EvidenceStoreError::Invalid);
    }
    let bytes = fs::read(path).map_err(|_| EvidenceStoreError::Unavailable)?;
    serde_json::from_slice(&bytes).map_err(|_| EvidenceStoreError::Invalid)
}

fn relocate_json_paths(
    parent: &Path,
    leaf: &str,
    previous_workspace: &Path,
    current_workspace: &Path,
) -> Result<(), EvidenceStoreError> {
    let mut value: serde_json::Value = read_json(parent, leaf)?;
    let previous = previous_workspace
        .to_str()
        .ok_or(EvidenceStoreError::Invalid)?;
    let current = current_workspace
        .to_str()
        .ok_or(EvidenceStoreError::Invalid)?;
    relocate_json_value(&mut value, previous, current);
    atomic_replace_json(parent, leaf, &value)
}

fn relocate_json_value(value: &mut serde_json::Value, previous: &str, current: &str) {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                relocate_json_value(value, previous, current);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values_mut() {
                relocate_json_value(value, previous, current);
            }
        }
        serde_json::Value::String(text) => {
            if text == previous {
                *text = current.to_owned();
            } else if let Some(suffix) = text.strip_prefix(previous)
                && suffix.starts_with(std::path::MAIN_SEPARATOR)
            {
                *text = format!("{current}{suffix}");
            }
        }
        _ => {}
    }
}

fn atomic_replace_json(
    parent: &Path,
    leaf: &str,
    value: &impl Serialize,
) -> Result<(), EvidenceStoreError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| EvidenceStoreError::Invalid)?;
    atomic_replace_bytes(parent, leaf, &bytes, MAX_EVIDENCE_FILE_BYTES)
}

fn atomic_replace_bytes(
    parent: &Path,
    leaf: &str,
    bytes: &[u8],
    maximum_bytes: usize,
) -> Result<(), EvidenceStoreError> {
    let path = fixed_child(parent, leaf)?;
    if let Ok(metadata) = path.symlink_metadata() {
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() as usize > maximum_bytes
        {
            return Err(EvidenceStoreError::Invalid);
        }
    }
    if bytes.len() > maximum_bytes {
        return Err(EvidenceStoreError::Invalid);
    }
    let temp_leaf = format!(".{leaf}.{}.tmp", Uuid::new_v4().simple());
    let temp = fixed_child(parent, &temp_leaf)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|_| EvidenceStoreError::Unavailable)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, &path)?;
        let _ = File::open(parent).and_then(|directory| directory.sync_all());
        Ok::<(), std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
        return Err(EvidenceStoreError::Unavailable);
    }
    Ok(())
}

fn fixed_child(parent: &Path, leaf: &str) -> Result<PathBuf, EvidenceStoreError> {
    if leaf.is_empty()
        || leaf == "."
        || leaf == ".."
        || leaf.contains('/')
        || leaf.contains('\\')
        || leaf.contains('\0')
    {
        return Err(EvidenceStoreError::Invalid);
    }
    Ok(parent.join(leaf))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{TempDir, tempdir};

    #[test]
    fn cancelled_verification_statuses_use_the_public_camel_case_contract() {
        assert_eq!(
            serde_json::to_string(&VerificationStatus::Cancelled).expect("verification status"),
            "\"cancelled\""
        );
        assert_eq!(
            serde_json::to_string(&VerificationCheckStatus::Cancelled)
                .expect("verification check status"),
            "\"cancelled\""
        );
    }

    #[test]
    fn workspace_evidence_deserializes_without_legacy_verification_history() {
        let workspace_id = Uuid::from_u128(1);
        let result = completed_verification_result(1);
        let evidence = WorkspaceEvidence {
            context: WorkspaceEvidenceContext {
                schema_version: WORKSPACE_EVIDENCE_SCHEMA_VERSION,
                workspace_id,
                workspace_record_version: 1,
                title: "Legacy workspace".to_owned(),
                intent: WorkspaceIntent::RepositorySet {
                    label: "Legacy".to_owned(),
                },
                preferred_provider: WorkspaceProvider::Codex,
                branch_name: "wts/legacy".to_owned(),
                workspace_display_path: "/tmp/legacy".to_owned(),
                code_workspace_display_path: "/tmp/legacy/workspace.code-workspace".to_owned(),
                evidence_display_path: "/tmp/legacy/.wts".to_owned(),
                created_at_unix_ms: 1,
                wts_version: "0.1.0".to_owned(),
                repositories: Vec::new(),
                allowed_repository_ids: Vec::new(),
            },
            graph_manifest: WorkspaceGraphManifest {
                schema_version: WORKSPACE_EVIDENCE_SCHEMA_VERSION,
                workspace_id,
                status: WorkspaceGraphEvidenceStatus::NotStarted,
                graph_display_path: None,
                graph_sha256: None,
                indexed_at_unix_ms: None,
                indexed_repositories: Vec::new(),
                detail: String::new(),
            },
            verification_plan: WorkspaceVerificationPlan {
                schema_version: WORKSPACE_EVIDENCE_SCHEMA_VERSION,
                workspace_id,
                revision: 1,
                updated_at_unix_ms: 1,
                checks: Vec::new(),
            },
            verification_result: result.clone(),
            verification_history: vec![result],
            agent_report: invalid_agent_report(
                workspace_id,
                "/tmp/legacy/.wts/agent-report.json".to_owned(),
            ),
            agent_runs: Vec::new(),
        };
        let mut legacy = serde_json::to_value(evidence).expect("workspace evidence JSON");
        legacy
            .as_object_mut()
            .expect("workspace evidence object")
            .remove("verificationHistory");

        let decoded =
            serde_json::from_value::<WorkspaceEvidence>(legacy).expect("legacy workspace evidence");

        assert!(decoded.verification_history.is_empty());
    }

    fn completed_verification_result(sequence: u64) -> WorkspaceVerificationResult {
        WorkspaceVerificationResult {
            schema_version: WORKSPACE_EVIDENCE_SCHEMA_VERSION,
            workspace_id: Uuid::from_u128(1),
            plan_revision: sequence,
            status: if sequence % 2 == 0 {
                VerificationStatus::Passed
            } else {
                VerificationStatus::Failed
            },
            started_at_unix_ms: Some(sequence as i64 * 100),
            completed_at_unix_ms: Some(sequence as i64 * 100 + 25),
            duration_ms: Some(25),
            checks: Vec::new(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn verification_history_persists_the_ten_most_recent_completed_runs() {
        let (_fixture, store) = evidence_store();
        for sequence in 1..=12 {
            store
                .write_verification_result(&completed_verification_result(sequence))
                .expect("completed verification result");
        }
        let running = WorkspaceVerificationResult {
            status: VerificationStatus::Running,
            completed_at_unix_ms: None,
            duration_ms: None,
            ..completed_verification_result(13)
        };
        store
            .write_verification_result(&running)
            .expect("running verification result");

        let reopened = EvidenceStore::open(&store.workspace).expect("reopen evidence");
        let history = reopened
            .read_verification_history()
            .expect("verification history");

        assert_eq!(history.len(), MAX_VERIFICATION_HISTORY);
        assert_eq!(
            history
                .iter()
                .map(|result| result.plan_revision)
                .collect::<Vec<_>>(),
            (3..=12).rev().collect::<Vec<_>>()
        );
        assert!(
            history
                .iter()
                .all(|result| result.completed_at_unix_ms.is_some())
        );
        assert_eq!(
            serde_json::from_slice::<Vec<WorkspaceVerificationResult>>(
                &fs::read(store.root.join(VERIFICATION_HISTORY_FILE))
                    .expect("persisted verification history")
            )
            .expect("verification history JSON"),
            history
        );
    }

    fn evidence_store() -> (TempDir, EvidenceStore) {
        let fixture = tempdir().expect("fixture");
        let workspace = fixture.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let store = EvidenceStore::create(&workspace).expect("evidence store");
        (fixture, store)
    }

    fn running_agent_run(
        workspace_id: Uuid,
        sequence: usize,
        started_at_unix_ms: i64,
    ) -> AgentRunSummary {
        AgentRunSummary {
            schema_version: WORKSPACE_EVIDENCE_SCHEMA_VERSION,
            run_id: Uuid::from_u128(sequence as u128 + 1),
            workspace_id,
            provider: AgentProvider::Codex,
            state: AgentRunState::Running,
            started_at_unix_ms,
            completed_at_unix_ms: None,
            duration_ms: None,
            prompt_sha256: "a".repeat(64),
            output_sha256: None,
            failure: None,
        }
    }

    fn succeeded_agent_run(
        workspace_id: Uuid,
        sequence: usize,
        started_at_unix_ms: i64,
    ) -> AgentRunSummary {
        AgentRunSummary {
            state: AgentRunState::Succeeded,
            completed_at_unix_ms: Some(started_at_unix_ms + 10),
            duration_ms: Some(10),
            output_sha256: Some("b".repeat(64)),
            ..running_agent_run(workspace_id, sequence, started_at_unix_ms)
        }
    }

    fn seed_agent_run(store: &EvidenceStore, run: &AgentRunSummary) {
        let runs = store.root.join(AGENT_RUNS_DIRECTORY);
        let leaf = format!("{}.json", run.run_id);
        atomic_replace_json(&runs, &leaf, run).expect("seed agent run");
    }

    fn agent_run_file_bytes(store: &EvidenceStore, run: &AgentRunSummary) -> u64 {
        store
            .root
            .join(AGENT_RUNS_DIRECTORY)
            .join(format!("{}.json", run.run_id))
            .metadata()
            .expect("agent run metadata")
            .len()
    }

    #[test]
    fn read_repairs_legacy_count_overflow_and_keeps_newest_runs() {
        let (_fixture, store) = evidence_store();
        let workspace_id = Uuid::new_v4();
        let overflow = 9usize;
        for sequence in 0..(MAX_AGENT_RUNS + overflow) {
            seed_agent_run(
                &store,
                &running_agent_run(workspace_id, sequence, sequence as i64),
            );
        }

        let retained = store.read_agent_runs().expect("retained agent runs");

        assert_eq!(retained.len(), MAX_AGENT_RUNS);
        assert_eq!(
            retained.first().map(|run| run.started_at_unix_ms),
            Some((MAX_AGENT_RUNS + overflow - 1) as i64)
        );
        assert_eq!(
            retained.last().map(|run| run.started_at_unix_ms),
            Some(overflow as i64)
        );
        assert_eq!(
            fs::read_dir(store.root.join(AGENT_RUNS_DIRECTORY))
                .expect("agent run directory")
                .count(),
            MAX_AGENT_RUNS
        );
    }

    #[test]
    fn byte_retention_keeps_the_newest_prefix_within_the_budget() {
        let (_fixture, store) = evidence_store();
        let workspace_id = Uuid::new_v4();
        let runs = (0..5)
            .map(|sequence| succeeded_agent_run(workspace_id, sequence, sequence as i64))
            .collect::<Vec<_>>();
        for run in &runs {
            seed_agent_run(&store, run);
        }
        let newest_two_bytes =
            agent_run_file_bytes(&store, &runs[4]) + agent_run_file_bytes(&store, &runs[3]);

        let retained = store
            .retain_agent_runs(
                None,
                AgentRunRetention {
                    maximum_count: MAX_AGENT_RUNS,
                    maximum_bytes: newest_two_bytes,
                },
            )
            .expect("byte-bounded retention");

        assert_eq!(
            retained
                .iter()
                .map(|run| run.started_at_unix_ms)
                .collect::<Vec<_>>(),
            vec![4, 3]
        );
        let retained_bytes = retained
            .iter()
            .map(|run| agent_run_file_bytes(&store, run))
            .sum::<u64>();
        assert!(retained_bytes <= newest_two_bytes);
        assert_eq!(
            fs::read_dir(store.root.join(AGENT_RUNS_DIRECTORY))
                .expect("agent run directory")
                .count(),
            2
        );
    }

    #[test]
    fn retention_protects_the_just_written_run_during_clock_regression() {
        let (_fixture, store) = evidence_store();
        let workspace_id = Uuid::new_v4();
        for sequence in 0..3 {
            seed_agent_run(
                &store,
                &running_agent_run(workspace_id, sequence, 100 + sequence as i64),
            );
        }
        let current = running_agent_run(workspace_id, 10, 1);
        store
            .write_agent_run_with_retention(
                &current,
                AgentRunRetention {
                    maximum_count: 3,
                    maximum_bytes: MAX_AGENT_RUN_BYTES,
                },
            )
            .expect("write current run");
        let retained = store.read_agent_runs().expect("retained runs");

        assert_eq!(retained.len(), 3);
        assert!(retained.iter().any(|run| run.run_id == current.run_id));
        assert!(retained.iter().any(|run| run.started_at_unix_ms == 102));
        assert!(retained.iter().any(|run| run.started_at_unix_ms == 101));
        assert!(!retained.iter().any(|run| run.started_at_unix_ms == 100));
    }

    #[cfg(unix)]
    #[test]
    fn pruning_rejects_symlinked_run_without_touching_its_target() {
        let (fixture, store) = evidence_store();
        let workspace_id = Uuid::new_v4();
        let valid = running_agent_run(workspace_id, 1, 1);
        seed_agent_run(&store, &valid);
        let outside = fixture.path().join("outside.json");
        fs::write(&outside, b"outside evidence").expect("outside evidence");
        let symlink_id = Uuid::from_u128(99);
        let symlink = store
            .root
            .join(AGENT_RUNS_DIRECTORY)
            .join(format!("{symlink_id}.json"));
        std::os::unix::fs::symlink(&outside, &symlink).expect("run symlink");

        assert!(matches!(
            store.retain_agent_runs(
                None,
                AgentRunRetention {
                    maximum_count: 1,
                    maximum_bytes: MAX_AGENT_RUN_BYTES,
                }
            ),
            Err(EvidenceStoreError::Invalid)
        ));
        assert_eq!(
            fs::read(&outside).expect("outside evidence remains"),
            b"outside evidence"
        );
        assert!(
            symlink
                .symlink_metadata()
                .expect("symlink remains")
                .file_type()
                .is_symlink()
        );
        assert!(
            store
                .root
                .join(AGENT_RUNS_DIRECTORY)
                .join(format!("{}.json", valid.run_id))
                .is_file()
        );
    }

    #[test]
    fn rejects_symlinked_evidence_directory() {
        let fixture = tempdir().expect("fixture");
        let workspace = fixture.path().join("workspace");
        let outside = fixture.path().join("outside");
        fs::create_dir(&workspace).expect("workspace");
        fs::create_dir(&outside).expect("outside");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, workspace.join(EVIDENCE_DIRECTORY))
                .expect("symlink");
            assert!(matches!(
                EvidenceStore::create(&workspace),
                Err(EvidenceStoreError::Invalid)
            ));
        }
    }

    #[test]
    fn fixed_child_rejects_path_traversal() {
        let parent = Path::new("/tmp/evidence");
        assert!(fixed_child(parent, "../context.json").is_err());
        assert!(fixed_child(parent, "nested/context.json").is_err());
        assert!(fixed_child(parent, "context.json").is_ok());
    }
}
