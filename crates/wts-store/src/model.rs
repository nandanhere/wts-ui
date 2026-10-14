use serde::{Deserialize, Serialize};
use uuid::Uuid;
use wts_core::workspace::{
    RuntimePlanSelection, WorkspaceIntent, WorkspaceMaterializationState, WorkspacePhase,
    WorkspacePlanningSelection, WorkspaceProvider, WorkspaceWorkflowState,
};

pub const WORKSPACE_RECORD_SCHEMA_VERSION: u32 = 1;
pub const WORKSPACE_RECORD_VERSION: u64 = 1;
pub const MAX_WORK_ITEM_ISSUE_KEY_BYTES: usize = 64;
pub const MAX_WORK_ITEM_SUMMARY_BYTES: usize = 512;
pub const MAX_WORK_ITEM_STATUS_BYTES: usize = 128;
pub const MAX_WORK_ITEM_CONTENT_BYTES: usize = 64 * 1024;
pub const MAX_WORK_ITEM_BROWSER_URL_BYTES: usize = 2 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRepositoryPlan {
    pub request_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<String>,
    pub label: String,
    pub base_ref: String,
    pub worktree_leaf: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRecord {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub record_version: u64,
    pub intent: WorkspaceIntent,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub preferred_provider: WorkspaceProvider,
    pub phase: WorkspacePhase,
    pub repositories: Vec<WorkspaceRepositoryPlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimePlanSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<WorkspacePlanningSelection>,
    pub workspace_root_id: String,
    pub workspace_leaf: String,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceView {
    pub schema_version: u32,
    pub workspace_id: Uuid,
    pub record_version: u64,
    pub intent: WorkspaceIntent,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub preferred_provider: WorkspaceProvider,
    pub phase: WorkspacePhase,
    pub repositories: Vec<WorkspaceRepositoryPlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimePlanSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<WorkspacePlanningSelection>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observed_work_items: Vec<ObservedWorkItem>,
    pub workspace_root_id: String,
    pub workspace_leaf: String,
    pub workspace_display_path: String,
    pub lifecycle: WorkspaceLifecycleSummary,
    pub workflow: WorkspaceWorkflowSummary,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

/// Durable, user-controlled workflow state stored outside `record_json`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceWorkflowSummary {
    pub state: WorkspaceWorkflowState,
    pub revision: u64,
    pub updated_at_unix_ms: i64,
    pub placement: WorkspaceBoardPlacementSummary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceBoardPlacementMode {
    Automatic,
    Pinned,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceBoardPlacementSummary {
    pub mode: WorkspaceBoardPlacementMode,
    pub rank: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StoredWorkItemProvider {
    Jira,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StoredWorkItemRole {
    Primary,
    Related,
    CreatedFromWorkspace,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredWorkItemSnapshot {
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
pub struct StoredWorkspaceWorkItemLink {
    pub link_id: Uuid,
    pub workspace_id: Uuid,
    pub provider: StoredWorkItemProvider,
    pub role: StoredWorkItemRole,
    pub snapshot: StoredWorkItemSnapshot,
    pub revision: u64,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmStoredWorkItemLinkResult {
    pub link: StoredWorkspaceWorkItemLink,
    pub replayed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredWorkItemUnlinkResult {
    pub workspace_id: Uuid,
    pub link_id: Uuid,
    pub removed_revision: u64,
}

pub const MAX_REVIEW_COMMENT_BYTES: usize = 16 * 1024;
pub const MAX_REVIEW_THREADS_PER_WORKSPACE: usize = 2_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StoredReviewAuthor {
    User,
    Agent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StoredReviewThreadState {
    Open,
    Resolved,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StoredReviewTarget {
    PlanningDocument {
        document_id: String,
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
        side: String,
        line: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredReviewComment {
    pub comment_id: Uuid,
    pub author: StoredReviewAuthor,
    pub body: String,
    pub created_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredReviewThread {
    pub thread_id: Uuid,
    pub workspace_id: Uuid,
    pub target: StoredReviewTarget,
    pub state: StoredReviewThreadState,
    pub revision: u64,
    pub comments: Vec<StoredReviewComment>,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at_unix_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedWorkItem {
    pub issue_key: String,
    pub source_files: Vec<String>,
    pub observed_at_unix_ms: i64,
}

/// A persisted, last-known observation for list rendering.
///
/// `Unknown` is emitted only for records created by an older WTS version until
/// the application performs a bounded manifest-only observation. This summary
/// never replaces authoritative materialization validation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceLifecycleSummary {
    pub materialization_state: WorkspaceMaterializationState,
    pub worktree_count: u32,
    pub observed_at_unix_ms: Option<i64>,
}

impl WorkspaceLifecycleSummary {
    pub fn unknown() -> Self {
        Self {
            materialization_state: WorkspaceMaterializationState::Unknown,
            worktree_count: 0,
            observed_at_unix_ms: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceList {
    pub workspace_root_id: String,
    pub workspace_root_display_path: String,
    pub workspaces: Vec<WorkspaceView>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWorkspaceResult {
    pub workspace: WorkspaceView,
    pub replayed: bool,
}

/// Durable receipt for an append-only workspace removal tombstone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceTombstone {
    pub workspace_id: Uuid,
    pub idempotency_key: Uuid,
    pub effect_digest: String,
    pub result_json: String,
    pub removed_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TombstoneWorkspaceResult {
    pub tombstone: WorkspaceTombstone,
    pub replayed: bool,
}
