use std::fmt;
use std::path::PathBuf;

use serde::Serialize;
use thiserror::Error;

use crate::CreatedWorktree;

/// A stable operation category suitable for a local UI error boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitOperation {
    InspectRepository,
    CloneRepository,
    FetchRepository,
    ReadRepositoryMetadata,
    ResolveDefaultBranch,
    ValidateReference,
    PreflightWorktree,
    CreateWorktree,
    RepairWorktree,
    RemoveWorktree,
    RemoveBranch,
    InspectWorktreeChanges,
    ReadWorktreeFile,
    SyncWorktree,
    AlignWorktree,
    InspectIgnoredFiles,
    ReadCommitTree,
    ReadCommitBlob,
}

impl fmt::Display for GitOperation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::InspectRepository => "inspect repository",
            Self::CloneRepository => "clone repository",
            Self::FetchRepository => "fetch repository",
            Self::ReadRepositoryMetadata => "read repository metadata",
            Self::ResolveDefaultBranch => "resolve default branch",
            Self::ValidateReference => "validate Git reference",
            Self::PreflightWorktree => "preflight worktree",
            Self::CreateWorktree => "create worktree",
            Self::RepairWorktree => "repair worktree",
            Self::RemoveWorktree => "remove worktree",
            Self::RemoveBranch => "remove branch",
            Self::InspectWorktreeChanges => "inspect worktree changes",
            Self::ReadWorktreeFile => "read worktree file",
            Self::SyncWorktree => "sync worktree",
            Self::AlignWorktree => "align worktree",
            Self::InspectIgnoredFiles => "inspect ignored files",
            Self::ReadCommitTree => "read commit tree",
            Self::ReadCommitBlob => "read commit blob",
        };
        formatter.write_str(value)
    }
}

/// A bounded, sanitized error. It never contains a command line.
#[derive(Clone, Debug, Error, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum GitError {
    #[error("Git is not installed or could not be started")]
    GitUnavailable,

    #[error("repository path is unavailable")]
    RepositoryPathUnavailable,

    #[error("workspace root is unavailable")]
    WorkspaceRootUnavailable,

    #[error("workspace root must not be a symbolic link")]
    WorkspaceRootSymlink,

    #[error("workspace root could not be removed because it is not empty")]
    WorkspaceRootNotEmpty,

    #[error("path is not a Git worktree")]
    NotAWorktree,

    #[error("bare repositories are not supported")]
    BareRepository,

    #[error("repository metadata is invalid")]
    InvalidRepositoryMetadata,

    #[error("the repository default branch could not be determined locally")]
    DefaultBranchNotFound,

    #[error("the requested base reference is invalid")]
    InvalidBaseReference,

    #[error("the requested base reference does not exist locally")]
    BaseReferenceNotFound,

    #[error("the requested commit object identifier is invalid")]
    InvalidCommitOid,

    #[error("the requested worktree file path is invalid")]
    InvalidWorktreeFilePath,

    #[error("the requested worktree file is unavailable")]
    WorktreeFileUnavailable,

    #[error("the requested worktree file must not be a symbolic link")]
    WorktreeFileSymlink,

    #[error("the requested worktree file is not UTF-8 text")]
    WorktreeFileNotUtf8,

    #[error("the requested worktree file exceeds the accepted byte budget")]
    WorktreeFileTooLarge,

    #[error("the selected commit contains too many runtime candidate files")]
    TooManyCommitFiles,

    #[error("the selected commit tree exceeds the runtime analysis budget")]
    CommitTreeTooLarge,

    #[error("runtime candidate files exceed the accepted byte budget")]
    CommitFilesTooLarge,

    #[error("the workspace branch name is invalid")]
    InvalidBranchName,

    #[error("at least one repository is required")]
    EmptyRepositorySet,

    #[error("the same repository was selected more than once")]
    DuplicateRepository,

    #[error("workspace root overlaps a selected source checkout")]
    WorkspaceOverlapsRepository,

    #[error("the target worktree path already exists")]
    TargetPathConflict,

    #[error("the target branch already exists")]
    BranchConflict,

    #[error("repository state changed after preflight")]
    RepositoryChanged,

    #[error("worktree rollback provenance could not be verified")]
    RollbackProvenanceMismatch,

    #[error("the worktree has tracked, staged, or untracked changes")]
    WorktreeHasChanges,

    #[error("the worktree has local commits")]
    WorktreeHasCommits,

    #[error("the upstream branch cannot be fast-forwarded")]
    NonFastForward,

    #[error("repository alignment preview is stale")]
    StaleAlignment,

    #[error("repository history does not require alignment")]
    AlignmentNotRequired,

    #[error("the repository alignment backup reference conflicts with existing state")]
    BackupRefConflict,

    #[error("the worktree has ignored files")]
    WorktreeHasIgnoredFiles,

    #[error("{operation} failed: {detail}")]
    CommandFailed {
        operation: GitOperation,
        status: Option<i32>,
        detail: String,
        truncated: bool,
    },

    #[error("{operation} returned more output than WTS accepts")]
    OutputTooLarge { operation: GitOperation },

    #[error("Git exceeded the local execution deadline")]
    CommandTimedOut,

    #[error("local filesystem operation failed")]
    Filesystem,
}

/// One residual item that could not be safely removed during rollback.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackFailure {
    pub worktree: CreatedWorktree,
    pub error: GitError,
}

/// The auditable result of rolling back only worktrees from a WTS receipt.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackReceipt {
    pub attempted: Vec<CreatedWorktree>,
    pub removed: Vec<CreatedWorktree>,
    pub failures: Vec<RollbackFailure>,
    pub workspace_root_created: bool,
    pub workspace_root_removed: bool,
    pub workspace_root_removal_error: Option<GitError>,
}

/// A materialization failure plus its completed rollback report.
#[derive(Clone, Debug, Error, Eq, PartialEq, Serialize)]
#[error("worktree materialization failed: {cause}")]
pub struct MaterializeError {
    pub cause: GitError,
    pub rollback: Box<RollbackReceipt>,
}

impl MaterializeError {
    pub(crate) fn before_mutation(cause: GitError) -> Self {
        Self {
            cause,
            rollback: Box::default(),
        }
    }
}

pub(crate) fn path_error(_path: PathBuf) -> GitError {
    // Paths can include usernames or other local information. Keep the public
    // error typed and intentionally omit the raw path.
    GitError::Filesystem
}
