use serde::{Deserialize, Serialize};
use uuid::Uuid;
use wts_core::workspace::{
    RuntimePlanSelection, WorkspacePlanningSelection, WorkspaceRepositoryRequest,
};

pub const MATERIALIZATION_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const MAX_PLANNING_DOCUMENT_BYTES: usize = 256 * 1024;

/// A fixed document in a workspace planning home.
///
/// Callers select a semantic identifier. They cannot provide a filesystem
/// path or file name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspacePlanningDocumentId {
    Readme,
    Plan,
    Findings,
    Kanban,
    ProgramBacklog,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePlanningDocumentDescriptor {
    pub document_id: WorkspacePlanningDocumentId,
    pub file_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePlanningDocumentList {
    pub workspace_id: Uuid,
    pub documents: Vec<WorkspacePlanningDocumentDescriptor>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePlanningDocument {
    pub workspace_id: Uuid,
    pub document_id: WorkspacePlanningDocumentId,
    pub file_name: String,
    pub contents: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateWorkspacePlanningDocumentRequest {
    pub expected_sha256: String,
    pub contents: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewAuthor {
    User,
    Agent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewThreadState {
    Open,
    Resolved,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewAnchorState {
    Current,
    Stale,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewCodeSide {
    Additions,
    Deletions,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReviewTarget {
    PlanningDocument {
        document_id: WorkspacePlanningDocumentId,
        document_sha256: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
    },
    VerificationCheck {
        plan_revision: u64,
        completed_at_unix_ms: i64,
        check_id: String,
    },
    CodeChange {
        repository_id: String,
        base_commit_oid: String,
        head_commit_oid: String,
        patch_sha256: String,
        file_path: String,
        side: ReviewCodeSide,
        line: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewComment {
    pub comment_id: Uuid,
    pub author: ReviewAuthor,
    pub body: String,
    pub created_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReviewThread {
    pub thread_id: Uuid,
    pub workspace_id: Uuid,
    pub target: ReviewTarget,
    pub anchor_state: ReviewAnchorState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_document_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_verification_completed_at_unix_ms: Option<i64>,
    pub state: ReviewThreadState,
    pub revision: u64,
    pub comments: Vec<ReviewComment>,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at_unix_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReviewThreadList {
    pub workspace_id: Uuid,
    pub threads: Vec<WorkspaceReviewThread>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWorkspaceReviewThreadRequest {
    pub target: ReviewTarget,
    pub author: ReviewAuthor,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveWorkspaceReviewThreadRequest {
    pub expected_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryBranchSummary {
    pub name: String,
    pub full_ref: String,
    pub commit_oid: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryAvailableBranch {
    pub name: String,
    pub full_ref: String,
    pub commit_oid: String,
    pub remote: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositorySummary {
    pub id: String,
    pub label: String,
    /// Final path component of the canonical local checkout.
    ///
    /// Git remotes can give a repository a label that differs from its local
    /// directory name. VS Code workspace folders commonly retain that local
    /// name, so imports use this catalog-owned value without trusting a path
    /// supplied by the workspace file.
    pub checkout_leaf: String,
    pub display_path: String,
    /// Other trusted local checkouts that share this repository's Git common
    /// directory. They are used only while resolving imports and deliberately
    /// stay outside the HTTP/desktop wire contract.
    #[serde(skip)]
    pub(crate) checkout_aliases: Vec<RepositoryCheckoutAlias>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_url: Option<String>,
    pub default_branch: RepositoryBranchSummary,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available_branches: Vec<RepositoryAvailableBranch>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepositoryCheckoutAlias {
    pub checkout_leaf: String,
    pub display_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryCatalog {
    pub repository_root_display_path: String,
    pub repositories: Vec<RepositorySummary>,
    pub skipped_entries: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloneRepositoryRequest {
    pub remote_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloneRepositoryResult {
    pub repository: RepositorySummary,
    pub repository_root_display_path: String,
    pub reused_existing: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshRepositoryBranchesRequest {
    pub repository_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshRepositoryBranchesResult {
    pub repository: RepositorySummary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryForge {
    Github,
    Gitlab,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRepositoryBaseResult {
    pub repository_id: String,
    pub forge: RepositoryForge,
    pub host: String,
    pub base_ref: String,
    pub commit_oid: String,
    pub accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenGithubReviewResult {
    pub repository_id: String,
    pub number: u64,
    pub accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenWorkspaceGitlabMergeRequestResult {
    pub repository_id: String,
    pub iid: u64,
    pub accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareWorkspaceChangeRequest {
    pub repository_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenWorkspaceChangeRequestDraft {
    pub repository_id: String,
    pub effect_digest: String,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeRequestWorkItem {
    pub link_id: Uuid,
    pub issue_key: String,
    pub summary: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeRequestCommit {
    pub commit_oid: String,
    pub subject: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceChangeRequestDraft {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub repository_label: String,
    pub forge: RepositoryForge,
    pub host: String,
    pub source_remote_name: String,
    pub source_branch: String,
    pub source_head_commit_oid: String,
    pub target_branch: String,
    pub commit_subject: String,
    pub proposed_by_session_id: Uuid,
    pub proposed_by_provider: AgentProvider,
    pub commits: Vec<ChangeRequestCommit>,
    pub changed_files: Vec<String>,
    pub worktree_clean: bool,
    pub remote_matches: bool,
    pub title: String,
    pub body: String,
    pub work_items: Vec<ChangeRequestWorkItem>,
    pub verification_status: crate::AgentChangeRequestVerificationStatus,
    pub verification_summary: String,
    pub effect_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenWorkspaceChangeRequestResult {
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub forge: RepositoryForge,
    pub host: String,
    pub source_branch: String,
    pub target_branch: String,
    pub source_head_commit_oid: String,
    pub accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeWorkspaceImportRequest {
    pub file_name: String,
    pub contents: String,
    #[serde(skip)]
    pub(crate) import_id: Option<Uuid>,
}

impl CodeWorkspaceImportRequest {
    /// Associates an opaque operation identifier with a transport request.
    ///
    /// The field is deliberately excluded from the wire contract. HTTP and
    /// desktop entry points assign it after deserialization so request payloads
    /// cannot choose or spoof an identifier used by development diagnostics.
    pub fn assign_import_id(&mut self, import_id: Uuid) {
        self.import_id = Some(import_id);
    }

    pub fn import_id(&self) -> Option<Uuid> {
        self.import_id
    }

    pub fn ensure_import_id(&mut self) -> Uuid {
        let import_id = self.import_id.unwrap_or_else(Uuid::new_v4);
        self.import_id = Some(import_id);
        import_id
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeWorkspaceFolderStatus {
    Matched,
    Missing,
    Ambiguous,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeWorkspaceFolderImport {
    pub name: String,
    pub raw_path: String,
    pub status: CodeWorkspaceFolderStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_display_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeWorkspaceImportWarningCode {
    ConfigurationIgnored,
    FolderMissing,
    FolderAmbiguous,
    FolderUnsupported,
    DuplicateRepository,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeWorkspaceImportWarning {
    pub code: CodeWorkspaceImportWarningCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeWorkspaceResolutionBasis {
    AbsolutePath,
    RelativePathSuffix,
    PathBasename,
    ExplicitName,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodeWorkspaceResolutionReason {
    MatchedExactPath,
    MatchedRelativePathSuffix,
    MatchedPathBasename,
    MatchedExplicitName,
    NoCatalogMatch,
    AmbiguousExactPath,
    AmbiguousRelativePathSuffix,
    AmbiguousPathBasename,
    AmbiguousExplicitName,
    UnsupportedFolder,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeWorkspaceMatchAttempt {
    pub basis: CodeWorkspaceResolutionBasis,
    pub value: String,
    pub candidate_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeWorkspaceMatchCandidate {
    pub label: String,
    pub display_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeWorkspaceFolderDiagnostics {
    pub folder_index: u32,
    pub status: CodeWorkspaceFolderStatus,
    pub reason: CodeWorkspaceResolutionReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution_basis: Option<CodeWorkspaceResolutionBasis>,
    pub attempts: Vec<CodeWorkspaceMatchAttempt>,
    pub candidates: Vec<CodeWorkspaceMatchCandidate>,
    pub candidates_truncated: bool,
    pub duplicate_repository: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeWorkspaceCatalogDiagnostics {
    pub repository_root_display_path: String,
    pub repository_count: u32,
    pub skipped_entries: u64,
    pub repositories: Vec<CodeWorkspaceMatchCandidate>,
    pub repositories_truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeWorkspaceImportDiagnostics {
    pub catalog: CodeWorkspaceCatalogDiagnostics,
    pub folders: Vec<CodeWorkspaceFolderDiagnostics>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeWorkspaceImportResult {
    pub import_id: Uuid,
    pub file_name: String,
    pub suggested_title: String,
    pub suggested_repository_set_label: String,
    pub folders: Vec<CodeWorkspaceFolderImport>,
    pub repositories: Vec<WorkspaceRepositoryRequest>,
    pub warnings: Vec<CodeWorkspaceImportWarning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<CodeWorkspaceImportDiagnostics>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PreflightBlockerCode {
    RepositoryMissing,
    RepositoryAmbiguous,
    GitUnavailable,
    BaseReferenceUnavailable,
    BranchConflict,
    TargetConflict,
    UnsafeWorkspacePath,
    RuntimeAnalysisStale,
    GitPreflightFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightBlocker {
    pub code: PreflightBlockerCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_base_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreflightRepository {
    pub repository_id: String,
    pub label: String,
    pub source_display_path: String,
    pub requested_base_ref: String,
    pub resolved_base_ref: String,
    pub base_commit_oid: String,
    pub target_display_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphWorkspaceStatus {
    NotStarted,
    Ready,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphWorkspaceSummary {
    pub status: GraphWorkspaceStatus,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePreflight {
    pub workspace_id: Uuid,
    pub workspace_display_path: String,
    pub code_workspace_display_path: String,
    pub branch_name: String,
    pub ready: bool,
    pub effect_digest: String,
    pub repositories: Vec<PreflightRepository>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimePlanSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<WorkspacePlanningSelection>,
    pub blockers: Vec<PreflightBlocker>,
    pub warnings: Vec<String>,
    pub graph: GraphWorkspaceSummary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterializedWorktree {
    pub repository_id: String,
    pub label: String,
    pub target_display_path: String,
    pub branch_name: String,
    pub base_commit_oid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_state: Option<MaterializedGitState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<MaterializedWorktreeActivity>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterializedWorktreeActivity {
    pub changed_file_count: u32,
    pub commits_ahead: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterializedGitState {
    pub head_commit_oid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_full_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRepositoryDiff {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub repository_label: String,
    pub base_commit_oid: String,
    pub head_commit_oid: String,
    pub patch_sha256: String,
    pub patch: String,
    pub patch_truncated: bool,
    pub untracked_paths: Vec<String>,
    pub untracked_paths_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_graph: Option<WorkspaceRepositoryReviewGraph>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRepositoryFileReview {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub repository_label: String,
    pub base_commit_oid: String,
    pub head_commit_oid: String,
    pub file_path: String,
    pub patch_sha256: String,
    pub content_sha256: String,
    pub content: String,
    pub full_patch: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRepositoryReviewGraph {
    pub graph_sha256: String,
    pub nodes: Vec<WorkspaceRepositoryReviewNode>,
    pub links: Vec<WorkspaceRepositoryReviewLink>,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRepositoryReviewNode {
    pub id: String,
    pub label: String,
    pub source_file: String,
    pub source_location: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRepositoryReviewLink {
    pub source: String,
    pub target: String,
    pub relation: String,
    pub confidence: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceMaterialization {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub workspace_record_version: u64,
    pub effect_digest: String,
    pub workspace_display_path: String,
    pub code_workspace_display_path: String,
    pub branch_name: String,
    pub worktrees: Vec<MaterializedWorktree>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimePlanSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<WorkspacePlanningSelection>,
    pub graph: GraphWorkspaceSummary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterializeWorkspaceResult {
    pub replayed: bool,
    pub materialization: WorkspaceMaterialization,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenWorkspaceResult {
    pub provider: String,
    pub accepted: bool,
    pub workspace_id: Uuid,
    pub code_workspace_display_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCliLaunchResult {
    pub workspace_id: Uuid,
    pub session_id: Uuid,
    pub provider: AgentProvider,
    pub terminal: TerminalProvider,
    pub accepted: bool,
    pub workspace_display_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceAgentBriefResult {
    pub workspace_id: Uuid,
    pub workspace_display_path: String,
    pub brief_display_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalProvider {
    Terminal,
    Warp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentProvider {
    Codex,
    OpenCode,
    Hermes,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRunResult {
    pub workspace_id: Uuid,
    pub provider: AgentProvider,
    pub succeeded: bool,
    pub output: String,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphIndexResult {
    pub workspace_id: Uuid,
    pub status: GraphWorkspaceStatus,
    pub graph_display_path: String,
    pub detail: String,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRepositorySyncResult {
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub repository_label: String,
    pub previous_base_commit_oid: String,
    pub base_commit_oid: String,
    pub updated: bool,
    pub graph_refreshed: bool,
    pub graph_detail: String,
    pub materialization: WorkspaceMaterialization,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRepositoryAlignmentPreflight {
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub repository_label: String,
    pub base_ref: String,
    pub remote_full_ref: String,
    pub current_commit_oid: String,
    pub target_commit_oid: String,
    pub backup_full_ref: String,
    pub effect_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRepositoryAlignmentResult {
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub repository_label: String,
    pub previous_base_commit_oid: String,
    pub base_commit_oid: String,
    pub backup_full_ref: String,
    pub graph_refreshed: bool,
    pub graph_detail: String,
    pub materialization: WorkspaceMaterialization,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceRemovalKind {
    SavedPlan,
    MaterializedWorkspace,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemovalBlockerCode {
    WorkspaceDrift,
    WorktreeChanges,
    IgnoredFiles,
    PlanningDocumentsPresent,
    UnexpectedPath,
    GitUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemovalBlocker {
    pub code: RemovalBlockerCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_label: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemovalWorktreeSummary {
    pub repository_id: String,
    pub label: String,
    pub target_display_path: String,
    pub branch_name: String,
    pub head_commit_oid: String,
    pub present: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemovalProtectedPath {
    pub display_path: String,
    pub entries: Vec<String>,
    pub entries_truncated: bool,
    #[serde(default)]
    pub file_previews: Vec<RemovalProtectedFilePreview>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemovalProtectedFilePreview {
    pub relative_path: String,
    pub contents: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRemovalPreflight {
    pub workspace_id: Uuid,
    pub kind: WorkspaceRemovalKind,
    pub workspace_display_path: String,
    pub ready: bool,
    pub effect_digest: String,
    pub worktrees: Vec<RemovalWorktreeSummary>,
    pub generated_paths: Vec<String>,
    pub protected_paths: Vec<RemovalProtectedPath>,
    pub retained_branches: Vec<String>,
    pub blockers: Vec<RemovalBlocker>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveWorkspaceResult {
    pub workspace_id: Uuid,
    pub replayed: bool,
    pub removed_worktree_count: u32,
    pub retained_branches: Vec<String>,
    pub removed_generated_paths: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JiraIssueImport {
    pub issue_key: String,
    pub summary: Option<String>,
    pub status: Option<String>,
    pub content: String,
    pub suggested_repositories: Vec<String>,
    pub repository_recommendations: Vec<RepositoryRecommendation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceWorkItemProvider {
    Jira,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceWorkItemRole {
    Primary,
    Related,
    CreatedFromWorkspace,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWorkItemSnapshot {
    pub issue_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_url: Option<String>,
    pub fetched_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWorkItemLinkPreview {
    pub schema_version: u8,
    pub workspace_id: Uuid,
    pub provider: WorkspaceWorkItemProvider,
    pub role: WorkspaceWorkItemRole,
    pub snapshot: WorkspaceWorkItemSnapshot,
    pub preview_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewWorkspaceJiraLinkRequest {
    pub issue_key: String,
    pub role: WorkspaceWorkItemRole,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmWorkspaceJiraLinkRequest {
    pub issue_key: String,
    pub role: WorkspaceWorkItemRole,
    pub expected_preview_digest: String,
    pub idempotency_key: Uuid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenWorkspaceJiraPreviewRequest {
    pub issue_key: String,
    pub role: WorkspaceWorkItemRole,
    pub expected_preview_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWorkItemLink {
    pub link_id: Uuid,
    pub workspace_id: Uuid,
    pub provider: WorkspaceWorkItemProvider,
    pub role: WorkspaceWorkItemRole,
    pub snapshot: WorkspaceWorkItemSnapshot,
    pub revision: u64,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmWorkspaceWorkItemLinkResult {
    pub link: WorkspaceWorkItemLink,
    pub replayed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWorkItemLinkList {
    pub schema_version: u8,
    pub workspace_id: Uuid,
    pub links: Vec<WorkspaceWorkItemLink>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnlinkWorkspaceWorkItemRequest {
    pub expected_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenWorkspaceWorkItemRequest {
    pub expected_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenWorkspaceWorkItemResult {
    pub workspace_id: Uuid,
    pub issue_key: String,
    pub accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWorkItemUnlinkResult {
    pub workspace_id: Uuid,
    pub link_id: Uuid,
    pub removed_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JiraCreateProposal {
    pub schema_version: u8,
    pub workspace_id: Uuid,
    pub summary: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_document_sha256: Option<String>,
    pub can_execute: bool,
    pub requires_explicit_approval: bool,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryRecommendationSource {
    Label,
    CheckoutLeaf,
    LocalPath,
    OriginRemote,
    WorkspaceHistory,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryRecommendation {
    pub repository_id: String,
    pub label: String,
    pub confidence: u8,
    pub reason: String,
    pub sources: Vec<RepositoryRecommendationSource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenProjectWorkPackageImport {
    pub work_package_id: u64,
    pub display_id: String,
    pub subject: String,
    pub status: Option<String>,
    pub project: Option<String>,
    pub content: String,
    pub suggested_repositories: Vec<String>,
    pub repository_recommendations: Vec<RepositoryRecommendation>,
}
