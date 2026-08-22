//! Safe Git inspection, explicit repository cloning, and worktree
//! materialization for WTS.
//!
//! This crate has no embedded network client: an explicit clone delegates to
//! the installed Git CLI so the user's credential helper or SSH agent can
//! participate. It never accepts a target path from a browser request.
//! Repository paths, clone destinations, and the workspace root come from the
//! trusted Rust host. All Git invocations use typed
//! [`std::process::Command`] arguments; no shell is involved.

mod command;
mod commit;
mod error;
mod repository;
mod worktree;

pub use commit::{
    CommitCandidateBlob, CommitCandidateKind, MAX_RUNTIME_CANDIDATE_BLOB_BYTES,
    MAX_RUNTIME_CANDIDATE_FILES, MAX_RUNTIME_CANDIDATE_TOTAL_BYTES,
};
pub use error::{GitError, GitOperation, MaterializeError, RollbackFailure, RollbackReceipt};
pub use repository::{
    AvailableBranch, DefaultBranch, RepositoryId, RepositoryInspection, ResolvedBase,
};
pub use worktree::{
    BranchChangeCommit, BranchChangeInventory, BranchPublicationInspection, CreatedWorktree,
    GitWorktreeService, PlannedWorktree, RepositoryRequest, WorkspaceWorktreeRequest,
    WorktreeActivity, WorktreeAlignment, WorktreeAlignmentPreview, WorktreeDiff,
    WorktreeFileReview, WorktreePlan, WorktreeReceipt, WorktreeRemovalInspection,
    WorktreeRemovalRequest, WorktreeSync,
};
