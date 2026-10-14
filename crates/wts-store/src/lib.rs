//! Durable, local-only workspace records.
//!
//! `WorkspaceStore` owns the SQLite projection and append-only creation event.
//! `WorkspaceService` is the host-facing facade. Both deliberately accept only
//! validated intent DTOs; the workspace root comes from Rust host
//! configuration, never from a creation request.

mod model;
mod sqlite;

pub use model::{
    ConfirmStoredWorkItemLinkResult, CreateWorkspaceResult, MAX_REVIEW_COMMENT_BYTES,
    MAX_REVIEW_THREADS_PER_WORKSPACE, MAX_WORK_ITEM_BROWSER_URL_BYTES, MAX_WORK_ITEM_CONTENT_BYTES,
    MAX_WORK_ITEM_ISSUE_KEY_BYTES, MAX_WORK_ITEM_STATUS_BYTES, MAX_WORK_ITEM_SUMMARY_BYTES,
    ObservedWorkItem, StoredReviewAuthor, StoredReviewComment, StoredReviewTarget,
    StoredReviewThread, StoredReviewThreadState, StoredWorkItemProvider, StoredWorkItemRole,
    StoredWorkItemSnapshot, StoredWorkItemUnlinkResult, StoredWorkspaceWorkItemLink,
    TombstoneWorkspaceResult, WORKSPACE_RECORD_SCHEMA_VERSION, WORKSPACE_RECORD_VERSION,
    WorkspaceBoardPlacementMode, WorkspaceBoardPlacementSummary, WorkspaceLifecycleSummary,
    WorkspaceList, WorkspaceRecord, WorkspaceRepositoryPlan, WorkspaceTombstone, WorkspaceView,
    WorkspaceWorkflowSummary,
};
pub use sqlite::{WorkspaceService, WorkspaceStore, WorkspaceStoreError, renamed_workspace_leaf};
