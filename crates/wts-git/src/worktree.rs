use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::command::git;
use crate::commit::read_runtime_candidate_blobs;
use crate::error::path_error;
use crate::repository::{
    clone_repository, commit_for_local_branch, current_branch_full_ref, fetch_remote_repository,
    fetch_repository, inspect_repository, local_branch_exists, remote_display_url, resolve_base,
    resolve_remote_base, resolve_tracking_remote, validate_branch_name,
};
use crate::{
    CommitCandidateBlob, GitError, GitOperation, MaterializeError, RepositoryInspection,
    ResolvedBase, RollbackFailure, RollbackReceipt,
};

#[cfg(test)]
std::thread_local! {
    static AFTER_REVALIDATE_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
fn set_after_revalidate_hook(hook: impl FnOnce() + 'static) {
    AFTER_REVALIDATE_HOOK.with(|current| {
        assert!(
            current.borrow_mut().replace(Box::new(hook)).is_none(),
            "only one materialization race hook may be installed"
        );
    });
}

#[cfg(test)]
fn run_after_revalidate_hook() {
    AFTER_REVALIDATE_HOOK.with(|current| {
        if let Some(hook) = current.borrow_mut().take() {
            hook();
        }
    });
}

/// One repository selected by the trusted host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepositoryRequest {
    trusted_path: PathBuf,
    base_ref: Option<String>,
}

impl RepositoryRequest {
    pub fn new(trusted_path: impl Into<PathBuf>) -> Self {
        Self {
            trusted_path: trusted_path.into(),
            base_ref: None,
        }
    }

    pub fn with_base_ref(mut self, base_ref: impl Into<String>) -> Self {
        self.base_ref = Some(base_ref.into());
        self
    }

    pub fn trusted_path(&self) -> &Path {
        &self.trusted_path
    }

    pub fn base_ref(&self) -> Option<&str> {
        self.base_ref.as_deref()
    }
}

/// A multi-repository worktree request. `workspace_root` is a Rust-host-owned
/// directory; callers must not populate it from browser JSON.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceWorktreeRequest {
    workspace_root: PathBuf,
    branch_name: String,
    repositories: Vec<RepositoryRequest>,
}

impl WorkspaceWorktreeRequest {
    pub fn new(
        workspace_root: impl Into<PathBuf>,
        branch_name: impl Into<String>,
        repositories: Vec<RepositoryRequest>,
    ) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            branch_name: branch_name.into(),
            repositories,
        }
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn branch_name(&self) -> &str {
        &self.branch_name
    }

    pub fn repositories(&self) -> &[RepositoryRequest] {
        &self.repositories
    }
}

/// One immutable preflight result.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedWorktree {
    pub repository: RepositoryInspection,
    pub base: ResolvedBase,
    pub target_path: PathBuf,
    pub branch_name: String,
}

/// An immutable plan. It can only be constructed by [`GitWorktreeService`].
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePlan {
    workspace_root: PathBuf,
    workspace_root_will_be_created: bool,
    branch_name: String,
    repositories: Vec<PlannedWorktree>,
}

impl WorktreePlan {
    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn branch_name(&self) -> &str {
        &self.branch_name
    }

    pub fn workspace_root_will_be_created(&self) -> bool {
        self.workspace_root_will_be_created
    }

    pub fn repositories(&self) -> &[PlannedWorktree] {
        &self.repositories
    }
}

/// A worktree that this exact WTS transaction successfully created.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorktree {
    pub repository_id: crate::RepositoryId,
    pub repository_label: String,
    pub source_repository: PathBuf,
    pub target_path: PathBuf,
    pub branch_name: String,
    pub base_commit_oid: String,
}

/// Receipt required for a future explicit rollback.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReceipt {
    pub workspace_root: PathBuf,
    pub workspace_root_created: bool,
    pub branch_name: String,
    pub worktrees: Vec<CreatedWorktree>,
}

/// Trusted inputs for inspecting or removing one WTS-created worktree.
///
/// The source checkout, workspace root, target path, repository identity, and
/// branch all come from the Rust host. Removal never accepts a browser-owned
/// path and never deletes the retained local branch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeRemovalRequest {
    source_repository: PathBuf,
    workspace_root: PathBuf,
    target_path: PathBuf,
    repository_id: String,
    branch_name: String,
}

impl WorktreeRemovalRequest {
    pub fn new(
        source_repository: impl Into<PathBuf>,
        workspace_root: impl Into<PathBuf>,
        target_path: impl Into<PathBuf>,
        repository_id: impl Into<String>,
        branch_name: impl Into<String>,
    ) -> Self {
        Self {
            source_repository: source_repository.into(),
            workspace_root: workspace_root.into(),
            target_path: target_path.into(),
            repository_id: repository_id.into(),
            branch_name: branch_name.into(),
        }
    }

    pub fn target_path(&self) -> &Path {
        &self.target_path
    }
}

/// Read-only removal state for one provenance-verified worktree.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemovalInspection {
    pub repository_id: String,
    pub repository_label: String,
    pub target_path: PathBuf,
    pub branch_name: String,
    pub head_commit_oid: String,
    pub present: bool,
    pub has_changes: bool,
    pub has_ignored_files: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeActivity {
    pub changed_file_count: u32,
    pub commits_ahead: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchPublicationInspection {
    pub branch_name: String,
    pub head_commit_oid: String,
    pub commit_subject: String,
    pub upstream_full_ref: String,
    pub upstream_remote_name: String,
    pub upstream_branch_name: String,
    pub upstream_commit_oid: String,
    pub remote_url: String,
    pub ahead: u32,
    pub behind: u32,
    pub changed_file_count: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchChangeCommit {
    pub commit_oid: String,
    pub subject: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchChangeInventory {
    pub commits: Vec<BranchChangeCommit>,
    pub files: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    pub patch: String,
    pub patch_truncated: bool,
    pub untracked_paths: Vec<String>,
    pub untracked_paths_truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeFileReview {
    pub file_path: String,
    pub content: String,
    pub full_patch: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSync {
    pub previous_commit_oid: String,
    pub commit_oid: String,
    pub remote_full_ref: String,
    pub remote_url: Option<String>,
    pub updated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAlignmentPreview {
    pub previous_commit_oid: String,
    pub target_commit_oid: String,
    pub remote_full_ref: String,
    pub backup_full_ref: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAlignment {
    pub previous_commit_oid: String,
    pub commit_oid: String,
    pub remote_full_ref: String,
    pub remote_url: Option<String>,
    pub backup_full_ref: String,
}

fn commit_for_ref(repository: &Path, full_ref: &str) -> Result<String, GitError> {
    if !full_ref.starts_with("refs/remotes/") || full_ref.contains(['\0', '\n', '\r', '\t', ' ']) {
        return Err(GitError::InvalidRepositoryMetadata);
    }
    let output = crate::command::git(Some(repository), ["rev-parse", "--verify", full_ref, "--"])?;
    if !output.status.success() {
        return Err(output.command_error(GitOperation::InspectWorktreeChanges));
    }
    let commit = output
        .success_text(GitOperation::InspectWorktreeChanges)?
        .trim()
        .to_owned();
    if !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(GitError::InvalidRepositoryMetadata);
    }
    Ok(commit)
}

/// Local Git facade. It is intentionally stateless and performs no network IO.
#[derive(Clone, Copy, Debug, Default)]
pub struct GitWorktreeService;

impl GitWorktreeService {
    pub fn new() -> Self {
        Self
    }

    pub fn inspect_repository(
        &self,
        trusted_path: impl AsRef<Path>,
    ) -> Result<RepositoryInspection, GitError> {
        inspect_repository(trusted_path.as_ref())
    }

    /// Clone one caller-validated remote into an exact host-owned target.
    ///
    /// The orchestration layer must validate the remote and derive the target
    /// below a configured repository root. This method never invokes a shell.
    pub fn clone_repository(
        &self,
        remote_url: &str,
        target_path: impl AsRef<Path>,
    ) -> Result<RepositoryInspection, GitError> {
        clone_repository(remote_url, target_path.as_ref())
    }

    /// Refresh cached `origin/*` refs for one host-owned repository.
    pub fn fetch_repository(
        &self,
        trusted_path: impl AsRef<Path>,
    ) -> Result<RepositoryInspection, GitError> {
        fetch_repository(trusted_path.as_ref())
    }

    /// Fetch `origin` and advance one exact, clean managed worktree to the
    /// saved branch's remote commit. User changes and local commits are never
    /// merged, rebased, reset, or overwritten.
    pub fn sync_clean_worktree_to_remote_base(
        &self,
        trusted_path: impl AsRef<Path>,
        expected_base_commit_oid: &str,
        requested_base: &str,
    ) -> Result<WorktreeSync, GitError> {
        if !matches!(expected_base_commit_oid.len(), 40 | 64)
            || !expected_base_commit_oid
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GitError::InvalidCommitOid);
        }
        let trusted_path = trusted_path.as_ref();
        let before = inspect_repository(trusted_path)?;
        let head = self.head_commit_oid(&before.worktree_root)?;
        let activity =
            self.inspect_worktree_activity(&before.worktree_root, expected_base_commit_oid)?;
        if activity.changed_file_count != 0 {
            return Err(GitError::WorktreeHasChanges);
        }
        if worktree_has_ignored_files(&before.worktree_root)? {
            return Err(GitError::WorktreeHasIgnoredFiles);
        }
        if head != expected_base_commit_oid || activity.commits_ahead != 0 {
            return Err(GitError::WorktreeHasCommits);
        }

        let tracking = resolve_tracking_remote(&before, requested_base)?;
        let remote_url = remote_display_url(&before, &tracking.name)?;
        let fetched = fetch_remote_repository(&before, &tracking.name)?;
        let remote = resolve_remote_base(&fetched, requested_base, &tracking)?;
        let head_after_fetch = self.head_commit_oid(&before.worktree_root)?;
        let activity_after_fetch =
            self.inspect_worktree_activity(&before.worktree_root, expected_base_commit_oid)?;
        if activity_after_fetch.changed_file_count != 0 {
            return Err(GitError::WorktreeHasChanges);
        }
        if worktree_has_ignored_files(&before.worktree_root)? {
            return Err(GitError::WorktreeHasIgnoredFiles);
        }
        if head_after_fetch != head || activity_after_fetch.commits_ahead != 0 {
            return Err(GitError::WorktreeHasCommits);
        }
        if remote.commit_oid == head {
            return Ok(WorktreeSync {
                previous_commit_oid: head.clone(),
                commit_oid: head,
                remote_full_ref: remote.full_ref,
                remote_url,
                updated: false,
            });
        }

        let ancestor = crate::command::git(
            Some(&before.worktree_root),
            [
                "merge-base",
                "--is-ancestor",
                head.as_str(),
                remote.commit_oid.as_str(),
            ],
        )?;
        if ancestor.status.code() == Some(1) {
            return Err(GitError::NonFastForward);
        }
        if !ancestor.status.success() {
            return Err(ancestor.command_error(GitOperation::SyncWorktree));
        }
        let merged = crate::command::git(
            Some(&before.worktree_root),
            [
                "-c",
                "core.hooksPath=/dev/null",
                "merge",
                "--ff-only",
                remote.commit_oid.as_str(),
            ],
        )?;
        if !merged.status.success() {
            return Err(merged.command_error(GitOperation::SyncWorktree));
        }
        let current = self.head_commit_oid(&before.worktree_root)?;
        if current != remote.commit_oid {
            return Err(GitError::RepositoryChanged);
        }
        let activity_after_merge =
            self.inspect_worktree_activity(&before.worktree_root, &current)?;
        if activity_after_merge.changed_file_count != 0 || activity_after_merge.commits_ahead != 0 {
            return Err(GitError::RepositoryChanged);
        }
        if worktree_has_ignored_files(&before.worktree_root)? {
            return Err(GitError::RepositoryChanged);
        }
        Ok(WorktreeSync {
            previous_commit_oid: head,
            commit_oid: current,
            remote_full_ref: remote.full_ref,
            remote_url,
            updated: true,
        })
    }

    /// Fetch and preview a history alignment without moving the managed branch.
    pub fn preview_clean_worktree_alignment(
        &self,
        trusted_path: impl AsRef<Path>,
        expected_base_commit_oid: &str,
        requested_base: &str,
    ) -> Result<WorktreeAlignmentPreview, GitError> {
        if !matches!(expected_base_commit_oid.len(), 40 | 64)
            || !expected_base_commit_oid
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GitError::InvalidCommitOid);
        }
        let trusted_path = trusted_path.as_ref();
        let before = inspect_repository(trusted_path)?;
        let head = self.head_commit_oid(&before.worktree_root)?;
        self.require_registered_clean_head(&before.worktree_root, expected_base_commit_oid, &head)?;

        let tracking = resolve_tracking_remote(&before, requested_base)?;
        let fetched = fetch_remote_repository(&before, &tracking.name)?;
        let remote = resolve_remote_base(&fetched, requested_base, &tracking)?;
        let head_after_fetch = self.head_commit_oid(&before.worktree_root)?;
        self.require_registered_clean_head(
            &before.worktree_root,
            expected_base_commit_oid,
            &head_after_fetch,
        )?;
        if head_after_fetch != head {
            return Err(GitError::RepositoryChanged);
        }
        if remote.commit_oid == head {
            return Err(GitError::AlignmentNotRequired);
        }
        let ancestor = crate::command::git(
            Some(&before.worktree_root),
            [
                "merge-base",
                "--is-ancestor",
                head.as_str(),
                remote.commit_oid.as_str(),
            ],
        )?;
        if ancestor.status.success() {
            return Err(GitError::AlignmentNotRequired);
        }
        if ancestor.status.code() != Some(1) {
            return Err(ancestor.command_error(GitOperation::AlignWorktree));
        }
        Ok(WorktreeAlignmentPreview {
            previous_commit_oid: head.clone(),
            target_commit_oid: remote.commit_oid,
            remote_full_ref: remote.full_ref,
            backup_full_ref: format!("refs/wts/backups/{head}"),
        })
    }

    /// Align a clean managed worktree to a previously reviewed divergent ref.
    pub fn align_clean_worktree_to_remote_base(
        &self,
        trusted_path: impl AsRef<Path>,
        expected_base_commit_oid: &str,
        requested_base: &str,
        expected_target_commit_oid: &str,
        expected_remote_full_ref: &str,
        expected_backup_full_ref: &str,
    ) -> Result<WorktreeAlignment, GitError> {
        let trusted_path = trusted_path.as_ref();
        let preview = self.preview_clean_worktree_alignment(
            trusted_path,
            expected_base_commit_oid,
            requested_base,
        )?;
        if preview.target_commit_oid != expected_target_commit_oid
            || preview.remote_full_ref != expected_remote_full_ref
            || preview.backup_full_ref != expected_backup_full_ref
        {
            return Err(GitError::StaleAlignment);
        }
        let repository = inspect_repository(trusted_path)?;
        let tracking = resolve_tracking_remote(&repository, requested_base)?;
        let remote_url = remote_display_url(&repository, &tracking.name)?;
        let head = self.head_commit_oid(&repository.worktree_root)?;
        self.require_registered_clean_head(
            &repository.worktree_root,
            expected_base_commit_oid,
            &head,
        )?;

        let existing_backup =
            crate::repository::commit_for_ref(&repository.worktree_root, &preview.backup_full_ref)?;
        if existing_backup.as_deref().is_some_and(|oid| oid != head) {
            return Err(GitError::BackupRefConflict);
        }
        if existing_backup.is_none() {
            let zero_oid = "0".repeat(head.len());
            let backup = crate::command::git(
                Some(&repository.worktree_root),
                [
                    "update-ref",
                    preview.backup_full_ref.as_str(),
                    head.as_str(),
                    zero_oid.as_str(),
                ],
            )?;
            if !backup.status.success() {
                return Err(backup.command_error(GitOperation::AlignWorktree));
            }
        }
        let aligned = crate::command::git(
            Some(&repository.worktree_root),
            [
                "-c",
                "core.hooksPath=/dev/null",
                "reset",
                "--hard",
                preview.target_commit_oid.as_str(),
            ],
        )?;
        if !aligned.status.success() {
            return Err(aligned.command_error(GitOperation::AlignWorktree));
        }
        let current = self.head_commit_oid(&repository.worktree_root)?;
        if current != preview.target_commit_oid {
            return Err(GitError::RepositoryChanged);
        }
        let activity = self.inspect_worktree_activity(&repository.worktree_root, &current)?;
        if activity.changed_file_count != 0
            || activity.commits_ahead != 0
            || worktree_has_ignored_files(&repository.worktree_root)?
        {
            return Err(GitError::RepositoryChanged);
        }
        Ok(WorktreeAlignment {
            previous_commit_oid: preview.previous_commit_oid,
            commit_oid: current,
            remote_full_ref: preview.remote_full_ref,
            remote_url,
            backup_full_ref: preview.backup_full_ref,
        })
    }

    fn require_registered_clean_head(
        &self,
        worktree_root: &Path,
        expected_base_commit_oid: &str,
        head: &str,
    ) -> Result<(), GitError> {
        let activity = self.inspect_worktree_activity(worktree_root, expected_base_commit_oid)?;
        if activity.changed_file_count != 0 {
            return Err(GitError::WorktreeHasChanges);
        }
        if worktree_has_ignored_files(worktree_root)? {
            return Err(GitError::WorktreeHasIgnoredFiles);
        }
        if head != expected_base_commit_oid || activity.commits_ahead != 0 {
            return Err(GitError::WorktreeHasCommits);
        }
        Ok(())
    }

    /// Re-inspect a host-owned checkout and resolve one locally available
    /// branch to an exact commit. The path must come from the trusted host;
    /// callers never supply it over the browser or WebView boundary.
    pub fn inspect_repository_base(
        &self,
        trusted_path: impl AsRef<Path>,
        requested_base: &str,
    ) -> Result<(RepositoryInspection, ResolvedBase), GitError> {
        let repository = inspect_repository(trusted_path.as_ref())?;
        let base = resolve_base(&repository, Some(requested_base))?;
        Ok((repository, base))
    }

    /// Resolve the display-safe URL for the remote that owns a saved base.
    /// The remote can have any valid Git remote name, such as `upstream`.
    pub fn tracking_remote_url(
        &self,
        trusted_path: impl AsRef<Path>,
        requested_base: &str,
    ) -> Result<Option<String>, GitError> {
        let repository = inspect_repository(trusted_path.as_ref())?;
        let tracking = resolve_tracking_remote(&repository, requested_base)?;
        remote_display_url(&repository, &tracking.name)
    }

    pub fn head_commit_oid(&self, trusted_path: impl AsRef<Path>) -> Result<String, GitError> {
        let repository = inspect_repository(trusted_path.as_ref())?;
        let full_ref = repository
            .current_branch_full_ref
            .as_deref()
            .ok_or(GitError::InvalidRepositoryMetadata)?;
        let branch_name = full_ref
            .strip_prefix("refs/heads/")
            .ok_or(GitError::InvalidRepositoryMetadata)?;
        commit_for_local_branch(&repository, branch_name)?
            .ok_or(GitError::InvalidRepositoryMetadata)
    }

    pub fn inspect_worktree_activity(
        &self,
        trusted_path: impl AsRef<Path>,
        base_commit_oid: &str,
    ) -> Result<WorktreeActivity, GitError> {
        if !matches!(base_commit_oid.len(), 40 | 64)
            || !base_commit_oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GitError::InvalidCommitOid);
        }
        let repository = inspect_repository(trusted_path.as_ref())?;
        let status = crate::command::git(
            Some(&repository.worktree_root),
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )?;
        if !status.status.success() {
            return Err(status.command_error(GitOperation::InspectWorktreeChanges));
        }
        if status.stdout_truncated {
            return Err(GitError::OutputTooLarge {
                operation: GitOperation::InspectWorktreeChanges,
            });
        }
        let changed_file_count = status
            .stdout
            .split(|byte| *byte == 0)
            .filter(|entry| entry.len() >= 3 && entry[2] == b' ')
            .count();
        let range = format!("{base_commit_oid}..HEAD");
        let ahead = crate::command::git(
            Some(&repository.worktree_root),
            ["rev-list", "--count", range.as_str(), "--"],
        )?;
        if !ahead.status.success() {
            return Err(ahead.command_error(GitOperation::InspectWorktreeChanges));
        }
        let commits_ahead = ahead
            .success_text(GitOperation::InspectWorktreeChanges)?
            .trim()
            .parse::<u32>()
            .map_err(|_| GitError::InvalidRepositoryMetadata)?;
        Ok(WorktreeActivity {
            changed_file_count: u32::try_from(changed_file_count)
                .map_err(|_| GitError::InvalidRepositoryMetadata)?,
            commits_ahead,
        })
    }

    /// Observe whether the current branch is represented by its cached
    /// tracking branch. This method performs no network IO.
    pub fn inspect_branch_publication(
        &self,
        trusted_path: impl AsRef<Path>,
    ) -> Result<BranchPublicationInspection, GitError> {
        let repository = inspect_repository(trusted_path.as_ref())?;
        let branch_name = repository
            .current_branch_full_ref
            .as_deref()
            .and_then(|value| value.strip_prefix("refs/heads/"))
            .filter(|value| !value.is_empty())
            .ok_or(GitError::InvalidRepositoryMetadata)?
            .to_owned();
        let upstream_full_ref = repository
            .upstream_full_ref
            .clone()
            .ok_or(GitError::InvalidRepositoryMetadata)?;
        let upstream = upstream_full_ref
            .strip_prefix("refs/remotes/")
            .ok_or(GitError::InvalidRepositoryMetadata)?;
        let (upstream_remote_name, upstream_branch_name) = upstream
            .split_once('/')
            .filter(|(remote, branch)| !remote.is_empty() && !branch.is_empty())
            .ok_or(GitError::InvalidRepositoryMetadata)?;
        let upstream_remote_name = upstream_remote_name.to_owned();
        let upstream_branch_name = upstream_branch_name.to_owned();
        let remote_url = remote_display_url(&repository, &upstream_remote_name)?
            .ok_or(GitError::InvalidRepositoryMetadata)?;
        let head_commit_oid = self.head_commit_oid(&repository.worktree_root)?;
        let upstream_commit_oid = commit_for_ref(&repository.worktree_root, &upstream_full_ref)?;
        let counts = crate::command::git(
            Some(&repository.worktree_root),
            [
                "rev-list",
                "--left-right",
                "--count",
                &format!("{upstream_full_ref}...HEAD"),
                "--",
            ],
        )?;
        if !counts.status.success() {
            return Err(counts.command_error(GitOperation::InspectWorktreeChanges));
        }
        let counts = counts.success_text(GitOperation::InspectWorktreeChanges)?;
        let mut counts = counts.split_whitespace();
        let behind = counts
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or(GitError::InvalidRepositoryMetadata)?;
        let ahead = counts
            .next()
            .and_then(|value| value.parse::<u32>().ok())
            .ok_or(GitError::InvalidRepositoryMetadata)?;
        if counts.next().is_some() {
            return Err(GitError::InvalidRepositoryMetadata);
        }
        let status = crate::command::git(
            Some(&repository.worktree_root),
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )?;
        if !status.status.success() || status.stdout_truncated {
            return Err(GitError::InvalidRepositoryMetadata);
        }
        let changed_file_count = status
            .stdout
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
            .count()
            .try_into()
            .map_err(|_| GitError::InvalidRepositoryMetadata)?;
        let subject = crate::command::git(
            Some(&repository.worktree_root),
            ["show", "-s", "--format=%s", "HEAD", "--"],
        )?;
        if !subject.status.success() {
            return Err(subject.command_error(GitOperation::InspectWorktreeChanges));
        }
        let commit_subject = subject
            .success_text(GitOperation::InspectWorktreeChanges)?
            .trim()
            .chars()
            .take(256)
            .collect::<String>();
        Ok(BranchPublicationInspection {
            branch_name,
            head_commit_oid,
            commit_subject,
            upstream_full_ref,
            upstream_remote_name,
            upstream_branch_name,
            upstream_commit_oid,
            remote_url,
            ahead,
            behind,
            changed_file_count,
        })
    }

    pub fn inspect_branch_change_inventory(
        &self,
        trusted_path: impl AsRef<Path>,
        base_commit_oid: &str,
        head_commit_oid: &str,
    ) -> Result<BranchChangeInventory, GitError> {
        let repository = inspect_repository(trusted_path.as_ref())?;
        let valid_oid = |value: &str| {
            matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        };
        if !valid_oid(base_commit_oid) || !valid_oid(head_commit_oid) {
            return Err(GitError::InvalidRepositoryMetadata);
        }
        let range = format!("{base_commit_oid}..{head_commit_oid}");
        let log = crate::command::git(
            Some(&repository.worktree_root),
            [
                "log",
                "--format=%H%x09%s",
                "--reverse",
                range.as_str(),
                "--",
            ],
        )?;
        if !log.status.success() || log.stdout_truncated {
            return Err(GitError::InvalidRepositoryMetadata);
        }
        let commits = log
            .success_text(GitOperation::InspectWorktreeChanges)?
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| {
                let (commit_oid, subject) = line
                    .split_once('\t')
                    .ok_or(GitError::InvalidRepositoryMetadata)?;
                if !valid_oid(commit_oid) {
                    return Err(GitError::InvalidRepositoryMetadata);
                }
                Ok(BranchChangeCommit {
                    commit_oid: commit_oid.to_owned(),
                    subject: subject
                        .chars()
                        .filter(|character| !character.is_control())
                        .take(512)
                        .collect(),
                })
            })
            .collect::<Result<Vec<_>, GitError>>()?;
        if commits.is_empty() || commits.len() > 256 {
            return Err(GitError::InvalidRepositoryMetadata);
        }
        let diff = crate::command::git(
            Some(&repository.worktree_root),
            [
                "diff",
                "--name-only",
                "-z",
                base_commit_oid,
                head_commit_oid,
                "--",
            ],
        )?;
        if !diff.status.success() || diff.stdout_truncated {
            return Err(GitError::InvalidRepositoryMetadata);
        }
        let files = diff
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| {
                let path =
                    std::str::from_utf8(path).map_err(|_| GitError::InvalidRepositoryMetadata)?;
                if path.chars().any(char::is_control) || path.len() > 4_096 {
                    return Err(GitError::InvalidRepositoryMetadata);
                }
                Ok(path.to_owned())
            })
            .collect::<Result<Vec<_>, GitError>>()?;
        if files.is_empty() || files.len() > 2_048 {
            return Err(GitError::InvalidRepositoryMetadata);
        }
        Ok(BranchChangeInventory { commits, files })
    }

    /// Reads one bounded patch from a trusted worktree without changing Git.
    pub fn inspect_worktree_diff(
        &self,
        trusted_path: impl AsRef<Path>,
        base_commit_oid: &str,
    ) -> Result<WorktreeDiff, GitError> {
        const PATCH_LIMIT: usize = 1024 * 1024;
        const UNTRACKED_PATH_LIMIT: usize = 256;

        if !matches!(base_commit_oid.len(), 40 | 64)
            || !base_commit_oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GitError::InvalidCommitOid);
        }
        let repository = inspect_repository(trusted_path.as_ref())?;
        let tracked_patch = crate::command::git_with_stdout_limit(
            Some(&repository.worktree_root),
            [
                "diff",
                "--no-ext-diff",
                "--no-color",
                "--find-renames",
                "--unified=3",
                base_commit_oid,
                "--",
            ],
            PATCH_LIMIT,
        )?;
        if !tracked_patch.status.success() {
            return Err(tracked_patch.command_error(GitOperation::InspectWorktreeChanges));
        }

        let untracked = crate::command::git(
            Some(&repository.worktree_root),
            ["ls-files", "--others", "--exclude-standard", "-z"],
        )?;
        if !untracked.status.success() {
            return Err(untracked.command_error(GitOperation::InspectWorktreeChanges));
        }
        if untracked.stdout_truncated {
            return Err(GitError::OutputTooLarge {
                operation: GitOperation::InspectWorktreeChanges,
            });
        }
        let mut paths = untracked
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| String::from_utf8(path.to_vec()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| GitError::InvalidRepositoryMetadata)?;
        let untracked_paths_truncated = paths.len() > UNTRACKED_PATH_LIMIT;
        paths.truncate(UNTRACKED_PATH_LIMIT);

        let mut patch = tracked_patch.stdout;
        let mut patch_truncated = tracked_patch.stdout_truncated;
        for path in &paths {
            if patch_truncated {
                break;
            }
            let remaining = PATCH_LIMIT.saturating_sub(patch.len());
            if remaining == 0 {
                patch_truncated = true;
                break;
            }
            let untracked_patch = crate::command::git_with_stdout_limit(
                Some(&repository.worktree_root),
                [
                    OsString::from("diff"),
                    OsString::from("--no-index"),
                    OsString::from("--no-ext-diff"),
                    OsString::from("--no-color"),
                    OsString::from("--"),
                    OsString::from("/dev/null"),
                    OsString::from(path),
                ],
                remaining,
            )?;
            if untracked_patch.status.code() != Some(1) {
                return Err(untracked_patch.command_error(GitOperation::InspectWorktreeChanges));
            }
            patch.extend_from_slice(&untracked_patch.stdout);
            patch_truncated = untracked_patch.stdout_truncated;
        }

        Ok(WorktreeDiff {
            patch: String::from_utf8_lossy(&patch).into_owned(),
            patch_truncated,
            untracked_paths: paths,
            untracked_paths_truncated,
        })
    }

    /// Reads one complete UTF-8 file from a trusted worktree without changing Git.
    pub fn read_worktree_file_review(
        &self,
        trusted_path: impl AsRef<Path>,
        base_commit_oid: &str,
        file_path: &str,
    ) -> Result<WorktreeFileReview, GitError> {
        const FILE_LIMIT: u64 = 2 * 1024 * 1024;
        const FULL_PATCH_LIMIT: usize = 8 * 1024 * 1024;

        if !matches!(base_commit_oid.len(), 40 | 64)
            || !base_commit_oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GitError::InvalidCommitOid);
        }
        let relative_path = validate_worktree_file_path(file_path)?;
        let repository = inspect_repository(trusted_path.as_ref())?;
        let root = repository
            .worktree_root
            .canonicalize()
            .map_err(|_| GitError::RepositoryPathUnavailable)?;
        let bytes = match read_safe_worktree_file(&root, &relative_path, FILE_LIMIT) {
            Ok(bytes) => bytes,
            Err(GitError::WorktreeFileUnavailable) => read_regular_base_blob(
                &repository.worktree_root,
                base_commit_oid,
                file_path,
                FILE_LIMIT as usize,
            )?,
            Err(error) => return Err(error),
        };
        let content = String::from_utf8(bytes).map_err(|_| GitError::WorktreeFileNotUtf8)?;

        let tracked_patch = crate::command::git_with_stdout_limit(
            Some(&repository.worktree_root),
            [
                OsString::from("diff"),
                OsString::from("--no-ext-diff"),
                OsString::from("--no-color"),
                OsString::from("--find-renames"),
                OsString::from("--unified=4194304"),
                OsString::from(base_commit_oid),
                OsString::from("--"),
                OsString::from(file_path),
            ],
            FULL_PATCH_LIMIT,
        )?;
        if !tracked_patch.status.success() {
            return Err(tracked_patch.command_error(GitOperation::ReadWorktreeFile));
        }
        if tracked_patch.stdout_truncated {
            return Err(GitError::WorktreeFileTooLarge);
        }
        let mut full_patch = tracked_patch.stdout;
        if full_patch.is_empty() {
            let untracked_patch = crate::command::git_with_stdout_limit(
                Some(&repository.worktree_root),
                [
                    OsString::from("diff"),
                    OsString::from("--no-index"),
                    OsString::from("--no-ext-diff"),
                    OsString::from("--no-color"),
                    OsString::from("--unified=4194304"),
                    OsString::from("--"),
                    OsString::from("/dev/null"),
                    OsString::from(file_path),
                ],
                FULL_PATCH_LIMIT,
            )?;
            if untracked_patch.status.code() == Some(1) {
                if untracked_patch.stdout_truncated {
                    return Err(GitError::WorktreeFileTooLarge);
                }
                full_patch = untracked_patch.stdout;
            } else if !untracked_patch.status.success() {
                return Err(untracked_patch.command_error(GitOperation::ReadWorktreeFile));
            }
        }
        let full_patch =
            String::from_utf8(full_patch).map_err(|_| GitError::WorktreeFileNotUtf8)?;

        Ok(WorktreeFileReview {
            file_path: file_path.to_owned(),
            content,
            full_patch,
        })
    }

    /// Read bounded runtime-related files from one exact, locally available
    /// commit without observing or mutating the checkout.
    pub fn read_runtime_candidate_blobs(
        &self,
        trusted_path: impl AsRef<Path>,
        commit_oid: &str,
    ) -> Result<Vec<CommitCandidateBlob>, GitError> {
        let repository = inspect_repository(trusted_path.as_ref())?;
        read_runtime_candidate_blobs(&repository.worktree_root, commit_oid)
    }

    pub fn preflight(&self, request: &WorkspaceWorktreeRequest) -> Result<WorktreePlan, GitError> {
        if request.repositories.is_empty() {
            return Err(GitError::EmptyRepositorySet);
        }

        let (workspace_root, workspace_root_will_be_created) =
            resolve_workspace_root(&request.workspace_root)?;

        let mut repository_ids = BTreeSet::new();
        let mut repositories = Vec::with_capacity(request.repositories.len());
        for requested in &request.repositories {
            let repository = inspect_repository(&requested.trusted_path)?;
            if !repository_ids.insert(repository.id.clone()) {
                return Err(GitError::DuplicateRepository);
            }
            if paths_overlap(&workspace_root, &repository.worktree_root) {
                return Err(GitError::WorkspaceOverlapsRepository);
            }
            validate_branch_name(&repository, &request.branch_name)?;
            if local_branch_exists(&repository, &request.branch_name)? {
                return Err(GitError::BranchConflict);
            }

            let base = resolve_base(&repository, requested.base_ref.as_deref())?;
            let target_path = workspace_root.join(repository.worktree_leaf());
            ensure_clean_target(&workspace_root, &target_path)?;
            repositories.push(PlannedWorktree {
                repository,
                base,
                target_path,
                branch_name: request.branch_name.clone(),
            });
        }

        Ok(WorktreePlan {
            workspace_root,
            workspace_root_will_be_created,
            branch_name: request.branch_name.clone(),
            repositories,
        })
    }

    /// Execute a preflight plan. If any repository fails, all previously
    /// created entries are rolled back in reverse order and reported.
    pub fn materialize(&self, plan: WorktreePlan) -> Result<WorktreeReceipt, MaterializeError> {
        let workspace_root_created = self
            .prepare_workspace_root(&plan)
            .map_err(MaterializeError::before_mutation)?;
        let mut created = Vec::with_capacity(plan.repositories.len());

        for planned in &plan.repositories {
            if let Err(cause) = self.revalidate_entry(&plan, planned) {
                let rollback = self.rollback_transaction(
                    &created,
                    workspace_root_created.then_some(plan.workspace_root.as_path()),
                );
                return Err(MaterializeError {
                    cause,
                    rollback: Box::new(rollback),
                });
            }

            #[cfg(test)]
            run_after_revalidate_hook();

            let target = planned.target_path.as_os_str().to_owned();
            let args = [
                OsString::from("worktree"),
                OsString::from("add"),
                OsString::from("--no-track"),
                OsString::from("-b"),
                OsString::from(&planned.branch_name),
                target,
                // Resolve the human-readable ref during preflight and use its
                // pinned object ID for the mutation. The ref check above still
                // rejects an already-stale plan, while this exact OID closes
                // the race if the ref moves after that check.
                OsString::from(&planned.base.commit_oid),
            ];
            let output = git(Some(&planned.repository.worktree_root), args).map_err(|cause| {
                let rollback = self.rollback_failed_step(
                    &created,
                    planned,
                    workspace_root_created.then_some(plan.workspace_root.as_path()),
                );
                MaterializeError {
                    cause,
                    rollback: Box::new(rollback),
                }
            })?;
            if !output.status.success() {
                let cause = output.command_error(GitOperation::CreateWorktree);
                let rollback = self.rollback_failed_step(
                    &created,
                    planned,
                    workspace_root_created.then_some(plan.workspace_root.as_path()),
                );
                return Err(MaterializeError {
                    cause,
                    rollback: Box::new(rollback),
                });
            }

            created.push(created_worktree(planned));
        }

        Ok(WorktreeReceipt {
            workspace_root: plan.workspace_root,
            workspace_root_created,
            branch_name: plan.branch_name,
            worktrees: created,
        })
    }

    pub fn materialize_workspace(
        &self,
        request: &WorkspaceWorktreeRequest,
    ) -> Result<WorktreeReceipt, MaterializeError> {
        let plan = self
            .preflight(request)
            .map_err(MaterializeError::before_mutation)?;
        self.materialize(plan)
    }

    /// Repair Git's host-owned metadata after WTS moves a linked worktree.
    pub fn repair_moved_worktree(&self, trusted_path: impl AsRef<Path>) -> Result<(), GitError> {
        let trusted_path = trusted_path.as_ref();
        let repository = inspect_repository(trusted_path)?;
        let output = git(
            Some(&repository.worktree_root),
            [
                OsString::from("worktree"),
                OsString::from("repair"),
                trusted_path.as_os_str().to_owned(),
            ],
        )?;
        if !output.status.success() {
            return Err(output.command_error(GitOperation::RepairWorktree));
        }
        inspect_repository(trusted_path)?;
        Ok(())
    }

    /// Roll back a successful receipt. Provenance is checked before each
    /// removal, so paths not created by this receipt are never removed.
    pub fn rollback(&self, receipt: &WorktreeReceipt) -> RollbackReceipt {
        self.rollback_transaction(
            &receipt.worktrees,
            receipt
                .workspace_root_created
                .then_some(receipt.workspace_root.as_path()),
        )
    }

    /// Inspect one exact WTS worktree without mutating it.
    ///
    /// A missing target is a valid retry state as long as the trusted source
    /// repository and retained branch still match the receipt.
    pub fn inspect_worktree_removal(
        &self,
        request: &WorktreeRemovalRequest,
    ) -> Result<WorktreeRemovalInspection, GitError> {
        let source = inspect_repository(&request.source_repository)?;
        if source.id.as_str() != request.repository_id {
            return Err(GitError::RollbackProvenanceMismatch);
        }
        validate_removal_paths(request)?;
        let branch_head = commit_for_local_branch(&source, &request.branch_name)?
            .ok_or(GitError::RollbackProvenanceMismatch)?;

        let target_metadata = match request.target_path.symlink_metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(WorktreeRemovalInspection {
                    repository_id: request.repository_id.clone(),
                    repository_label: source.label,
                    target_path: request.target_path.clone(),
                    branch_name: request.branch_name.clone(),
                    head_commit_oid: branch_head,
                    present: false,
                    has_changes: false,
                    has_ignored_files: false,
                });
            }
            Err(_) => return Err(GitError::Filesystem),
        };
        if target_metadata.file_type().is_symlink() || !target_metadata.is_dir() {
            return Err(GitError::RollbackProvenanceMismatch);
        }
        let target = request
            .target_path
            .canonicalize()
            .map_err(|_| GitError::RollbackProvenanceMismatch)?;
        if target != request.target_path {
            return Err(GitError::RollbackProvenanceMismatch);
        }
        let target_repository = inspect_repository(&target)?;
        if target_repository.id != source.id
            || target_repository.git_common_dir != source.git_common_dir
        {
            return Err(GitError::RollbackProvenanceMismatch);
        }
        let expected_ref = format!("refs/heads/{}", request.branch_name);
        if current_branch_full_ref(&target)?.as_deref() != Some(expected_ref.as_str()) {
            return Err(GitError::RollbackProvenanceMismatch);
        }
        let head_commit_oid = commit_for_local_branch(&target_repository, &request.branch_name)?
            .ok_or(GitError::RollbackProvenanceMismatch)?;
        if head_commit_oid != branch_head {
            return Err(GitError::RollbackProvenanceMismatch);
        }

        let status = git(
            Some(&target),
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )?;
        if !status.status.success() {
            return Err(status.command_error(GitOperation::InspectWorktreeChanges));
        }
        let has_changes = !status
            .success_text(GitOperation::InspectWorktreeChanges)?
            .is_empty();

        let ignored = git(
            Some(&target),
            [
                "ls-files",
                "--others",
                "--ignored",
                "--exclude-standard",
                "-z",
            ],
        )?;
        if !ignored.status.success() {
            return Err(ignored.command_error(GitOperation::InspectIgnoredFiles));
        }
        let has_ignored_files = !ignored
            .success_text(GitOperation::InspectIgnoredFiles)?
            .is_empty();

        Ok(WorktreeRemovalInspection {
            repository_id: request.repository_id.clone(),
            repository_label: source.label,
            target_path: target,
            branch_name: request.branch_name.clone(),
            head_commit_oid,
            present: true,
            has_changes,
            has_ignored_files,
        })
    }

    /// Remove one clean, provenance-verified worktree while retaining its
    /// branch. Git's non-force removal is deliberately used as a final guard.
    pub fn remove_worktree(
        &self,
        request: &WorktreeRemovalRequest,
    ) -> Result<WorktreeRemovalInspection, GitError> {
        let inspection = self.inspect_worktree_removal(request)?;
        if !inspection.present {
            return Ok(inspection);
        }
        if inspection.has_changes {
            return Err(GitError::WorktreeHasChanges);
        }
        if inspection.has_ignored_files {
            return Err(GitError::WorktreeHasIgnoredFiles);
        }
        let args = [
            OsString::from("worktree"),
            OsString::from("remove"),
            OsString::from("--"),
            request.target_path.as_os_str().to_owned(),
        ];
        let output = git(Some(&request.source_repository), args)?;
        if !output.status.success() {
            return Err(output.command_error(GitOperation::RemoveWorktree));
        }
        Ok(inspection)
    }

    /// Remove one provenance-verified worktree after the caller has obtained
    /// explicit approval to discard its uncommitted and ignored files. The
    /// retained local branch is not removed.
    pub fn force_remove_worktree(
        &self,
        request: &WorktreeRemovalRequest,
    ) -> Result<WorktreeRemovalInspection, GitError> {
        let inspection = self.inspect_worktree_removal(request)?;
        if !inspection.present {
            return Ok(inspection);
        }
        let args = [
            OsString::from("worktree"),
            OsString::from("remove"),
            OsString::from("--force"),
            OsString::from("--"),
            request.target_path.as_os_str().to_owned(),
        ];
        let output = git(Some(&request.source_repository), args)?;
        if !output.status.success() {
            return Err(output.command_error(GitOperation::RemoveWorktree));
        }
        Ok(inspection)
    }

    fn prepare_workspace_root(&self, plan: &WorktreePlan) -> Result<bool, GitError> {
        if !plan.workspace_root_will_be_created {
            let (current, will_create) = resolve_workspace_root(&plan.workspace_root)?;
            if will_create || current != plan.workspace_root {
                return Err(GitError::RepositoryChanged);
            }
            return Ok(false);
        }

        let (current, will_create) = resolve_workspace_root(&plan.workspace_root)?;
        if !will_create || current != plan.workspace_root {
            return Err(GitError::RepositoryChanged);
        }
        fs::create_dir(&plan.workspace_root).map_err(|_| GitError::Filesystem)?;
        match plan.workspace_root.canonicalize() {
            Ok(canonical) if canonical == plan.workspace_root => Ok(true),
            _ => {
                // The directory was just created by this call. Remove it only
                // if it is still the same empty directory.
                let _ = remove_created_workspace_root(&plan.workspace_root);
                Err(GitError::RepositoryChanged)
            }
        }
    }

    fn revalidate_entry(
        &self,
        plan: &WorktreePlan,
        entry: &PlannedWorktree,
    ) -> Result<(), GitError> {
        let root = plan
            .workspace_root
            .canonicalize()
            .map_err(|_| GitError::WorkspaceRootUnavailable)?;
        if root != plan.workspace_root {
            return Err(GitError::RepositoryChanged);
        }
        ensure_clean_target(&root, &entry.target_path)?;

        let current = inspect_repository(&entry.repository.worktree_root)?;
        if current.id != entry.repository.id
            || current.git_common_dir != entry.repository.git_common_dir
        {
            return Err(GitError::RepositoryChanged);
        }
        validate_branch_name(&current, &entry.branch_name)?;
        if local_branch_exists(&current, &entry.branch_name)? {
            return Err(GitError::BranchConflict);
        }
        let current_base = resolve_base(&current, Some(&entry.base.full_ref))?;
        if current_base.commit_oid != entry.base.commit_oid {
            return Err(GitError::RepositoryChanged);
        }
        Ok(())
    }

    fn rollback_entries(&self, entries: &[CreatedWorktree]) -> RollbackReceipt {
        let mut receipt = RollbackReceipt::default();
        for entry in entries.iter().rev() {
            receipt.attempted.push(entry.clone());
            match self.rollback_one(entry) {
                Ok(()) => receipt.removed.push(entry.clone()),
                Err(error) => receipt.failures.push(RollbackFailure {
                    worktree: entry.clone(),
                    error,
                }),
            }
        }
        receipt
    }

    fn rollback_transaction(
        &self,
        entries: &[CreatedWorktree],
        created_workspace_root: Option<&Path>,
    ) -> RollbackReceipt {
        let mut receipt = self.rollback_entries(entries);
        if let Some(root) = created_workspace_root {
            receipt.workspace_root_created = true;
            match remove_created_workspace_root(root) {
                Ok(()) => receipt.workspace_root_removed = true,
                Err(error) => {
                    receipt.workspace_root_removal_error = Some(error);
                }
            }
        }
        receipt
    }

    fn rollback_failed_step(
        &self,
        previously_created: &[CreatedWorktree],
        failed: &PlannedWorktree,
        created_workspace_root: Option<&Path>,
    ) -> RollbackReceipt {
        let mut proven = previously_created.to_vec();
        if self.failed_step_created_worktree(failed) {
            proven.push(created_worktree(failed));
        }
        self.rollback_transaction(&proven, created_workspace_root)
    }

    fn failed_step_created_worktree(&self, planned: &PlannedWorktree) -> bool {
        let Ok(target) = planned.target_path.canonicalize() else {
            return false;
        };
        if target != planned.target_path {
            return false;
        }
        let Ok(repository) = inspect_repository(&target) else {
            return false;
        };
        if repository.id != planned.repository.id {
            return false;
        }
        let expected_ref = format!("refs/heads/{}", planned.branch_name);
        matches!(
            current_branch_full_ref(&target),
            Ok(Some(current)) if current == expected_ref
        )
    }

    fn rollback_one(&self, entry: &CreatedWorktree) -> Result<(), GitError> {
        let source = inspect_repository(&entry.source_repository)?;
        if source.id != entry.repository_id {
            return Err(GitError::RollbackProvenanceMismatch);
        }

        let target = entry
            .target_path
            .canonicalize()
            .map_err(|_| GitError::RollbackProvenanceMismatch)?;
        if target != entry.target_path {
            return Err(GitError::RollbackProvenanceMismatch);
        }
        let target_repository = inspect_repository(&target)?;
        if target_repository.id != entry.repository_id {
            return Err(GitError::RollbackProvenanceMismatch);
        }
        let expected_ref = format!("refs/heads/{}", entry.branch_name);
        if current_branch_full_ref(&target)?.as_deref() != Some(&expected_ref) {
            return Err(GitError::RollbackProvenanceMismatch);
        }
        if commit_for_local_branch(&source, &entry.branch_name)?.as_deref()
            != Some(&entry.base_commit_oid)
        {
            return Err(GitError::RollbackProvenanceMismatch);
        }
        let status = git(
            Some(&target),
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )?;
        if !status.status.success() {
            return Err(status.command_error(GitOperation::RemoveWorktree));
        }
        if !status
            .success_text(GitOperation::RemoveWorktree)?
            .is_empty()
        {
            return Err(GitError::RollbackProvenanceMismatch);
        }

        let args = [
            OsString::from("worktree"),
            OsString::from("remove"),
            OsString::from("--force"),
            OsString::from("--"),
            target.as_os_str().to_owned(),
        ];
        let output = git(Some(&source.worktree_root), args)?;
        if !output.status.success() {
            return Err(output.command_error(GitOperation::RemoveWorktree));
        }

        // Delete only if the ref still has the exact expected value. update-ref
        // performs this comparison atomically, unlike a check followed by
        // `git branch -D`.
        let output = git(
            Some(&source.worktree_root),
            ["update-ref", "-d", &expected_ref, &entry.base_commit_oid],
        )?;
        if !output.status.success() {
            return Err(output.command_error(GitOperation::RemoveBranch));
        }
        Ok(())
    }
}

fn read_safe_worktree_file(
    root: &Path,
    relative_path: &Path,
    file_limit: u64,
) -> Result<Vec<u8>, GitError> {
    let mut candidate = root.to_path_buf();
    for component in relative_path.components() {
        let Component::Normal(segment) = component else {
            return Err(GitError::InvalidWorktreeFilePath);
        };
        candidate.push(segment);
        let metadata =
            fs::symlink_metadata(&candidate).map_err(|_| GitError::WorktreeFileUnavailable)?;
        if metadata.file_type().is_symlink() {
            return Err(GitError::WorktreeFileSymlink);
        }
    }
    let metadata = fs::metadata(&candidate).map_err(|_| GitError::WorktreeFileUnavailable)?;
    if !metadata.is_file() {
        return Err(GitError::WorktreeFileUnavailable);
    }
    if metadata.len() > file_limit {
        return Err(GitError::WorktreeFileTooLarge);
    }
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|_| GitError::WorktreeFileUnavailable)?;
    if !canonical_candidate.starts_with(root) {
        return Err(GitError::WorktreeFileSymlink);
    }
    let bytes = fs::read(&canonical_candidate).map_err(|_| GitError::Filesystem)?;
    if bytes.len() as u64 > file_limit {
        return Err(GitError::WorktreeFileTooLarge);
    }
    Ok(bytes)
}

fn read_regular_base_blob(
    repository: &Path,
    base_commit_oid: &str,
    file_path: &str,
    file_limit: usize,
) -> Result<Vec<u8>, GitError> {
    let tree_entry = crate::command::git_with_stdout_limit(
        Some(repository),
        [
            OsString::from("ls-tree"),
            OsString::from("-z"),
            OsString::from(base_commit_oid),
            OsString::from("--"),
            OsString::from(file_path),
        ],
        4096,
    )?;
    if !tree_entry.status.success() {
        return Err(tree_entry.command_error(GitOperation::ReadCommitTree));
    }
    if tree_entry.stdout_truncated {
        return Err(GitError::WorktreeFileUnavailable);
    }
    let record = tree_entry
        .stdout
        .strip_suffix(&[0])
        .unwrap_or(&tree_entry.stdout);
    let record = std::str::from_utf8(record).map_err(|_| GitError::WorktreeFileUnavailable)?;
    let (metadata, returned_path) = record
        .split_once('\t')
        .ok_or(GitError::WorktreeFileUnavailable)?;
    if returned_path != file_path {
        return Err(GitError::WorktreeFileUnavailable);
    }
    let mut metadata = metadata.split_whitespace();
    let mode = metadata.next();
    let object_type = metadata.next();
    let oid = metadata.next();
    if metadata.next().is_some()
        || !matches!(mode, Some("100644" | "100755"))
        || object_type != Some("blob")
    {
        return Err(GitError::WorktreeFileUnavailable);
    }
    let oid = oid.ok_or(GitError::WorktreeFileUnavailable)?;
    let blob = crate::command::git_with_stdout_limit(
        Some(repository),
        [
            OsString::from("cat-file"),
            OsString::from("blob"),
            oid.into(),
        ],
        file_limit,
    )?;
    if !blob.status.success() {
        return Err(blob.command_error(GitOperation::ReadCommitBlob));
    }
    if blob.stdout_truncated {
        return Err(GitError::WorktreeFileTooLarge);
    }
    Ok(blob.stdout)
}

fn created_worktree(planned: &PlannedWorktree) -> CreatedWorktree {
    CreatedWorktree {
        repository_id: planned.repository.id.clone(),
        repository_label: planned.repository.label.clone(),
        source_repository: planned.repository.worktree_root.clone(),
        target_path: planned.target_path.clone(),
        branch_name: planned.branch_name.clone(),
        base_commit_oid: planned.base.commit_oid.clone(),
    }
}

fn ensure_clean_target(root: &Path, target: &Path) -> Result<(), GitError> {
    if target.parent() != Some(root) {
        return Err(GitError::TargetPathConflict);
    }
    match target.symlink_metadata() {
        Ok(_) => Err(GitError::TargetPathConflict),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(path_error(target.to_path_buf())),
    }
}

fn worktree_has_ignored_files(target: &Path) -> Result<bool, GitError> {
    let ignored = git(
        Some(target),
        [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
        ],
    )?;
    if !ignored.status.success() {
        return Err(ignored.command_error(GitOperation::InspectIgnoredFiles));
    }
    Ok(!ignored
        .success_text(GitOperation::InspectIgnoredFiles)?
        .is_empty())
}

fn validate_removal_paths(request: &WorktreeRemovalRequest) -> Result<(), GitError> {
    if !request.workspace_root.is_absolute()
        || !request.target_path.is_absolute()
        || request.workspace_root.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
        || request.target_path.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
        || request.target_path.parent() != Some(request.workspace_root.as_path())
    {
        return Err(GitError::RollbackProvenanceMismatch);
    }
    if let Ok(metadata) = request.workspace_root.symlink_metadata() {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(GitError::RollbackProvenanceMismatch);
        }
        let canonical = request
            .workspace_root
            .canonicalize()
            .map_err(|_| GitError::RollbackProvenanceMismatch)?;
        if canonical != request.workspace_root {
            return Err(GitError::RollbackProvenanceMismatch);
        }
    } else if request.target_path.exists() {
        return Err(GitError::RollbackProvenanceMismatch);
    }
    Ok(())
}

fn validate_worktree_file_path(file_path: &str) -> Result<PathBuf, GitError> {
    const MAX_PATH_BYTES: usize = 4_096;
    const MAX_COMPONENTS: usize = 64;

    if file_path.is_empty()
        || file_path.len() > MAX_PATH_BYTES
        || file_path.contains('\0')
        || file_path.contains('\\')
        || file_path.chars().any(char::is_control)
        || Path::new(file_path).is_absolute()
    {
        return Err(GitError::InvalidWorktreeFilePath);
    }
    let path = PathBuf::from(file_path);
    let mut components = 0_usize;
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(GitError::InvalidWorktreeFilePath);
        }
        components += 1;
        if components > MAX_COMPONENTS {
            return Err(GitError::InvalidWorktreeFilePath);
        }
    }
    if components == 0 {
        return Err(GitError::InvalidWorktreeFilePath);
    }
    Ok(path)
}

fn resolve_workspace_root(path: &Path) -> Result<(PathBuf, bool), GitError> {
    if !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return Err(GitError::WorkspaceRootUnavailable);
    }

    match path.symlink_metadata() {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(GitError::WorkspaceRootSymlink);
            }
            if !metadata.is_dir() {
                return Err(GitError::WorkspaceRootUnavailable);
            }
            let canonical = path
                .canonicalize()
                .map_err(|_| GitError::WorkspaceRootUnavailable)?;
            Ok((canonical, false))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or(GitError::WorkspaceRootUnavailable)?;
            let leaf = path.file_name().ok_or(GitError::WorkspaceRootUnavailable)?;
            let parent = parent
                .canonicalize()
                .map_err(|_| GitError::WorkspaceRootUnavailable)?;
            if !parent.is_dir() {
                return Err(GitError::WorkspaceRootUnavailable);
            }
            let candidate = parent.join(leaf);
            match candidate.symlink_metadata() {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok((candidate, true)),
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    Err(GitError::WorkspaceRootSymlink)
                }
                Ok(_) => Err(GitError::WorkspaceRootUnavailable),
                Err(_) => Err(GitError::Filesystem),
            }
        }
        Err(_) => Err(GitError::WorkspaceRootUnavailable),
    }
}

fn remove_created_workspace_root(root: &Path) -> Result<(), GitError> {
    match root.symlink_metadata() {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(GitError::Filesystem),
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(GitError::RollbackProvenanceMismatch);
        }
        Ok(_) => {}
    }
    let canonical = root
        .canonicalize()
        .map_err(|_| GitError::RollbackProvenanceMismatch)?;
    if canonical != root {
        return Err(GitError::RollbackProvenanceMismatch);
    }
    match fs::remove_dir(root) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => {
            Err(GitError::WorkspaceRootNotEmpty)
        }
        Err(_) => Err(GitError::Filesystem),
    }
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn moved_base_ref_after_revalidation_cannot_change_materialized_commit() {
        let repository_directory = tempfile::tempdir().expect("repository temporary directory");
        let repository_root = repository_directory.path().join("api");
        fs::create_dir(&repository_root).expect("repository directory");
        run(
            None,
            ["init", repository_root.to_str().expect("UTF-8 path")],
        );
        run(Some(&repository_root), ["config", "user.name", "WTS Test"]);
        run(
            Some(&repository_root),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(
            Some(&repository_root),
            ["config", "commit.gpgSign", "false"],
        );
        fs::write(repository_root.join("README.md"), "# api\n").expect("initial file");
        run(Some(&repository_root), ["add", "README.md"]);
        run(Some(&repository_root), ["commit", "-m", "initial"]);
        run(Some(&repository_root), ["branch", "-M", "main"]);
        let pinned_oid = output(Some(&repository_root), ["rev-parse", "HEAD"]);

        // Keep a locally available future commit without moving `main` until
        // the injected point between WTS revalidation and `worktree add`.
        run(Some(&repository_root), ["checkout", "-b", "future-base"]);
        fs::write(repository_root.join("future.txt"), "future\n").expect("future file");
        run(Some(&repository_root), ["add", "future.txt"]);
        run(Some(&repository_root), ["commit", "-m", "future"]);
        let moved_oid = output(Some(&repository_root), ["rev-parse", "HEAD"]);
        run(Some(&repository_root), ["checkout", "main"]);

        let workspace_parent = tempfile::tempdir().expect("workspace parent");
        let workspace_root = workspace_parent.path().join("workspace");
        let service = GitWorktreeService::new();
        let plan = service
            .preflight(&WorkspaceWorktreeRequest::new(
                &workspace_root,
                "wts/pinned-race",
                vec![RepositoryRequest::new(&repository_root).with_base_ref("main")],
            ))
            .expect("preflight");
        assert_eq!(plan.repositories()[0].base.commit_oid, pinned_oid);

        let hook_repository = repository_root.clone();
        let hook_pinned = pinned_oid.clone();
        let hook_moved = moved_oid.clone();
        set_after_revalidate_hook(move || {
            // The expected-old argument makes the fixture's ref move atomic.
            run(
                Some(&hook_repository),
                ["update-ref", "refs/heads/main", &hook_moved, &hook_pinned],
            );
        });

        let receipt = service.materialize(plan).expect("materialization");
        let created = &receipt.worktrees[0];

        assert_eq!(
            output(Some(&repository_root), ["rev-parse", "refs/heads/main"]),
            moved_oid,
            "the race fixture must move the selected ref"
        );
        assert_eq!(
            output(Some(&created.target_path), ["rev-parse", "HEAD"]),
            pinned_oid,
            "worktree creation must use the preflight-pinned object ID"
        );
        assert_eq!(
            output(
                Some(&repository_root),
                ["rev-parse", "refs/heads/wts/pinned-race"]
            ),
            pinned_oid
        );
        assert_eq!(created.base_commit_oid, pinned_oid);

        let rollback = service.rollback(&receipt);
        assert!(rollback.failures.is_empty());
        assert!(rollback.workspace_root_removed);
    }

    #[test]
    fn worktree_activity_reports_changed_files_and_commits_ahead_of_base() {
        let repository_directory = tempfile::tempdir().expect("repository temporary directory");
        let repository_root = repository_directory.path().join("activity");
        fs::create_dir(&repository_root).expect("repository directory");
        run(
            None,
            ["init", repository_root.to_str().expect("UTF-8 path")],
        );
        run(Some(&repository_root), ["config", "user.name", "WTS Test"]);
        run(
            Some(&repository_root),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(
            Some(&repository_root),
            ["config", "commit.gpgSign", "false"],
        );
        fs::write(repository_root.join("README.md"), "base\n").expect("base file");
        run(Some(&repository_root), ["add", "README.md"]);
        run(Some(&repository_root), ["commit", "-m", "base"]);
        let base_oid = output(Some(&repository_root), ["rev-parse", "HEAD"]);
        fs::write(repository_root.join("committed.txt"), "committed\n").expect("committed file");
        run(Some(&repository_root), ["add", "committed.txt"]);
        run(Some(&repository_root), ["commit", "-m", "ahead"]);
        fs::write(repository_root.join("README.md"), "changed\n").expect("changed file");
        fs::write(repository_root.join("untracked.txt"), "untracked\n").expect("untracked file");

        let activity = GitWorktreeService::new()
            .inspect_worktree_activity(&repository_root, &base_oid)
            .expect("inspect activity");

        assert_eq!(activity.changed_file_count, 2);
        assert_eq!(activity.commits_ahead, 1);
    }

    #[test]
    fn worktree_diff_includes_committed_tracked_and_untracked_work() {
        let repository_directory = tempfile::tempdir().expect("repository temporary directory");
        let repository_root = repository_directory.path().join("diff");
        fs::create_dir(&repository_root).expect("repository directory");
        run(
            None,
            ["init", repository_root.to_str().expect("UTF-8 path")],
        );
        run(Some(&repository_root), ["config", "user.name", "WTS Test"]);
        run(
            Some(&repository_root),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(
            Some(&repository_root),
            ["config", "commit.gpgSign", "false"],
        );
        fs::write(repository_root.join("README.md"), "base\n").expect("base file");
        run(Some(&repository_root), ["add", "README.md"]);
        run(Some(&repository_root), ["commit", "-m", "base"]);
        let base_oid = output(Some(&repository_root), ["rev-parse", "HEAD"]);
        fs::write(repository_root.join("committed.txt"), "committed\n").expect("committed file");
        run(Some(&repository_root), ["add", "committed.txt"]);
        run(Some(&repository_root), ["commit", "-m", "ahead"]);
        fs::write(repository_root.join("README.md"), "changed\n").expect("changed file");
        fs::write(repository_root.join("untracked.txt"), "untracked\n").expect("untracked file");

        let diff = GitWorktreeService::new()
            .inspect_worktree_diff(&repository_root, &base_oid)
            .expect("inspect diff");

        assert!(diff.patch.contains("diff --git a/README.md b/README.md"));
        assert!(
            diff.patch
                .contains("diff --git a/committed.txt b/committed.txt")
        );
        assert!(
            diff.patch
                .contains("diff --git a/untracked.txt b/untracked.txt")
        );
        assert!(diff.patch.contains("+untracked"));
        assert_eq!(diff.untracked_paths, ["untracked.txt"]);
        assert!(!diff.patch_truncated);
        assert!(!diff.untracked_paths_truncated);
    }

    #[test]
    fn worktree_diff_bounds_untracked_file_content() {
        let repository_directory = tempfile::tempdir().expect("repository temporary directory");
        let repository_root = repository_directory.path().join("diff");
        fs::create_dir(&repository_root).expect("repository directory");
        run(
            None,
            ["init", repository_root.to_str().expect("UTF-8 path")],
        );
        run(Some(&repository_root), ["config", "user.name", "WTS Test"]);
        run(
            Some(&repository_root),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(
            Some(&repository_root),
            ["config", "commit.gpgSign", "false"],
        );
        fs::write(repository_root.join("README.md"), "base\n").expect("base file");
        run(Some(&repository_root), ["add", "README.md"]);
        run(Some(&repository_root), ["commit", "-m", "base"]);
        let base_oid = output(Some(&repository_root), ["rev-parse", "HEAD"]);
        fs::write(
            repository_root.join("large.txt"),
            vec![b'x'; 2 * 1024 * 1024],
        )
        .expect("large untracked file");

        let diff = GitWorktreeService::new()
            .inspect_worktree_diff(&repository_root, &base_oid)
            .expect("inspect diff");

        assert_eq!(diff.untracked_paths, ["large.txt"]);
        assert!(diff.patch.len() <= 1024 * 1024);
        assert!(diff.patch_truncated);
    }

    #[test]
    fn worktree_diff_keeps_initial_context_bounded_for_a_large_file() {
        let repository_directory = tempfile::tempdir().expect("repository temporary directory");
        let repository_root = repository_directory.path().join("full-context-diff");
        fs::create_dir(&repository_root).expect("repository directory");
        run(
            None,
            ["init", repository_root.to_str().expect("UTF-8 path")],
        );
        run(Some(&repository_root), ["config", "user.name", "WTS Test"]);
        run(
            Some(&repository_root),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(
            Some(&repository_root),
            ["config", "commit.gpgSign", "false"],
        );
        let original = (1..=20_000)
            .map(|line| format!("unchanged line {line}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(repository_root.join("complete.txt"), &original).expect("base file");
        run(Some(&repository_root), ["add", "complete.txt"]);
        run(Some(&repository_root), ["commit", "-m", "base"]);
        let base_oid = output(Some(&repository_root), ["rev-parse", "HEAD"]);
        fs::write(
            repository_root.join("complete.txt"),
            original.replace("unchanged line 10000", "changed line 10000"),
        )
        .expect("changed file");

        let diff = GitWorktreeService::new()
            .inspect_worktree_diff(&repository_root, &base_oid)
            .expect("inspect bounded diff");

        assert!(diff.patch.len() < 8 * 1024);
        assert!(!diff.patch.contains(" unchanged line 1\n"));
        assert!(!diff.patch.contains(" unchanged line 20000\n"));
        assert!(diff.patch.contains("-unchanged line 10000"));
        assert!(diff.patch.contains("+changed line 10000"));
        assert!(!diff.patch_truncated);
    }

    #[test]
    fn complete_file_review_reads_full_utf8_content_only_after_request() {
        let repository_directory = tempfile::tempdir().expect("repository temporary directory");
        let repository_root = repository_directory.path().join("full-file-review");
        fs::create_dir(&repository_root).expect("repository directory");
        run(
            None,
            ["init", repository_root.to_str().expect("UTF-8 path")],
        );
        run(Some(&repository_root), ["config", "user.name", "WTS Test"]);
        run(
            Some(&repository_root),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(
            Some(&repository_root),
            ["config", "commit.gpgSign", "false"],
        );
        let original = (1..=200)
            .map(|line| format!("neutral line {line}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::create_dir(repository_root.join("src")).expect("source directory");
        fs::write(repository_root.join("src/complete.txt"), &original).expect("base file");
        run(Some(&repository_root), ["add", "src/complete.txt"]);
        run(Some(&repository_root), ["commit", "-m", "base"]);
        let base_oid = output(Some(&repository_root), ["rev-parse", "HEAD"]);
        let changed = original.replace("neutral line 100", "changed line 100");
        fs::write(repository_root.join("src/complete.txt"), &changed).expect("changed file");

        let review = GitWorktreeService::new()
            .read_worktree_file_review(&repository_root, &base_oid, "src/complete.txt")
            .expect("complete file review");

        assert_eq!(review.file_path, "src/complete.txt");
        assert_eq!(review.content, changed);
        assert!(review.full_patch.contains(" neutral line 1"));
        assert!(review.full_patch.contains(" neutral line 200"));
        assert!(review.full_patch.contains("-neutral line 100"));
        assert!(review.full_patch.contains("+changed line 100"));
    }

    #[test]
    fn complete_file_review_reads_deleted_text_from_the_exact_base_commit() {
        let repository_directory = tempfile::tempdir().expect("repository temporary directory");
        let repository_root = repository_directory.path().join("deleted-file-review");
        fs::create_dir(&repository_root).expect("repository directory");
        run(
            None,
            ["init", repository_root.to_str().expect("UTF-8 path")],
        );
        run(Some(&repository_root), ["config", "user.name", "WTS Test"]);
        run(
            Some(&repository_root),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(
            Some(&repository_root),
            ["config", "commit.gpgSign", "false"],
        );
        fs::write(repository_root.join("removed.txt"), "first\nsecond\n").expect("base file");
        run(Some(&repository_root), ["add", "removed.txt"]);
        run(Some(&repository_root), ["commit", "-m", "base"]);
        let base_oid = output(Some(&repository_root), ["rev-parse", "HEAD"]);
        fs::remove_file(repository_root.join("removed.txt")).expect("delete file");

        let review = GitWorktreeService::new()
            .read_worktree_file_review(&repository_root, &base_oid, "removed.txt")
            .expect("deleted file review");

        assert_eq!(review.content, "first\nsecond\n");
        assert!(review.full_patch.contains("-first"));
        assert!(review.full_patch.contains("-second"));
    }

    #[test]
    fn complete_file_review_rejects_unsafe_non_text_and_oversize_files() {
        let repository_directory = tempfile::tempdir().expect("repository temporary directory");
        let repository_root = repository_directory.path().join("bounded-file-review");
        fs::create_dir(&repository_root).expect("repository directory");
        run(
            None,
            ["init", repository_root.to_str().expect("UTF-8 path")],
        );
        run(Some(&repository_root), ["config", "user.name", "WTS Test"]);
        run(
            Some(&repository_root),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(
            Some(&repository_root),
            ["config", "commit.gpgSign", "false"],
        );
        fs::write(repository_root.join("README.md"), "base\n").expect("base file");
        run(Some(&repository_root), ["add", "README.md"]);
        run(Some(&repository_root), ["commit", "-m", "base"]);
        let oid = output(Some(&repository_root), ["rev-parse", "HEAD"]);
        fs::write(repository_root.join("binary.bin"), [0xff, 0xfe]).expect("binary file");
        fs::write(
            repository_root.join("large.txt"),
            vec![b'x'; 2 * 1024 * 1024 + 1],
        )
        .expect("large file");
        let service = GitWorktreeService::new();

        assert_eq!(
            service.read_worktree_file_review(&repository_root, &oid, "../outside.txt"),
            Err(GitError::InvalidWorktreeFilePath)
        );
        assert_eq!(
            service.read_worktree_file_review(&repository_root, &oid, "binary.bin"),
            Err(GitError::WorktreeFileNotUtf8)
        );
        assert_eq!(
            service.read_worktree_file_review(&repository_root, &oid, "large.txt"),
            Err(GitError::WorktreeFileTooLarge)
        );
    }

    #[cfg(unix)]
    #[test]
    fn complete_file_review_rejects_symbolic_links() {
        use std::os::unix::fs::symlink;

        let repository_directory = tempfile::tempdir().expect("repository temporary directory");
        let repository_root = repository_directory.path().join("symlink-file-review");
        fs::create_dir(&repository_root).expect("repository directory");
        run(
            None,
            ["init", repository_root.to_str().expect("UTF-8 path")],
        );
        run(Some(&repository_root), ["config", "user.name", "WTS Test"]);
        run(
            Some(&repository_root),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(
            Some(&repository_root),
            ["config", "commit.gpgSign", "false"],
        );
        fs::write(repository_root.join("README.md"), "base\n").expect("base file");
        run(Some(&repository_root), ["add", "README.md"]);
        run(Some(&repository_root), ["commit", "-m", "base"]);
        let oid = output(Some(&repository_root), ["rev-parse", "HEAD"]);
        fs::write(repository_directory.path().join("outside.txt"), "secret\n")
            .expect("outside file");
        symlink(
            repository_directory.path().join("outside.txt"),
            repository_root.join("linked.txt"),
        )
        .expect("symlink");

        assert_eq!(
            GitWorktreeService::new().read_worktree_file_review(
                &repository_root,
                &oid,
                "linked.txt",
            ),
            Err(GitError::WorktreeFileSymlink)
        );
    }

    #[test]
    fn sync_clean_worktree_uses_the_base_branch_tracking_remote() {
        let fixture = SyncFixture::new();
        fixture.rename_managed_remote("upstream");
        let previous = output(Some(&fixture.managed), ["rev-parse", "HEAD"]);
        let current = fixture.push_upstream_commit("upstream.txt", "current\n");

        let result = GitWorktreeService::new()
            .sync_clean_worktree_to_remote_base(&fixture.managed, &previous, "develop")
            .expect("sync clean worktree");

        assert!(result.updated);
        assert_eq!(result.previous_commit_oid, previous);
        assert_eq!(result.commit_oid, current);
        assert_eq!(result.remote_full_ref, "refs/remotes/upstream/develop");
        assert_eq!(result.remote_url.as_deref(), fixture.remote.to_str());
        assert_eq!(
            output(Some(&fixture.managed), ["rev-parse", "HEAD"]),
            current
        );
        assert_eq!(
            fs::read_to_string(fixture.managed.join("upstream.txt")).expect("synced file"),
            "current\n"
        );
    }

    #[test]
    fn sync_preserves_dirty_and_locally_committed_worktrees() {
        let dirty = SyncFixture::new();
        let dirty_head = output(Some(&dirty.managed), ["rev-parse", "HEAD"]);
        dirty.push_upstream_commit("remote.txt", "remote\n");
        fs::write(dirty.managed.join("local.txt"), "local\n").expect("local file");
        assert_eq!(
            GitWorktreeService::new().sync_clean_worktree_to_remote_base(
                &dirty.managed,
                &dirty_head,
                "develop",
            ),
            Err(GitError::WorktreeHasChanges)
        );
        assert_eq!(
            output(Some(&dirty.managed), ["rev-parse", "HEAD"]),
            dirty_head
        );
        assert_eq!(
            fs::read_to_string(dirty.managed.join("local.txt")).expect("preserved local file"),
            "local\n"
        );

        let ahead = SyncFixture::new();
        let registered = output(Some(&ahead.managed), ["rev-parse", "HEAD"]);
        fs::write(ahead.managed.join("local-commit.txt"), "local\n").expect("local commit file");
        run(Some(&ahead.managed), ["add", "local-commit.txt"]);
        run(Some(&ahead.managed), ["commit", "-m", "local commit"]);
        let local_head = output(Some(&ahead.managed), ["rev-parse", "HEAD"]);
        ahead.push_upstream_commit("remote.txt", "remote\n");
        assert_eq!(
            GitWorktreeService::new().sync_clean_worktree_to_remote_base(
                &ahead.managed,
                &registered,
                "develop",
            ),
            Err(GitError::WorktreeHasCommits)
        );
        assert_eq!(
            output(Some(&ahead.managed), ["rev-parse", "HEAD"]),
            local_head
        );

        let ignored = SyncFixture::new();
        let ignored_head = output(Some(&ignored.managed), ["rev-parse", "HEAD"]);
        fs::write(ignored.managed.join(".git/info/exclude"), "ignored.local\n")
            .expect("local exclude");
        fs::write(ignored.managed.join("ignored.local"), "preserve\n").expect("ignored local file");
        assert_eq!(
            GitWorktreeService::new().sync_clean_worktree_to_remote_base(
                &ignored.managed,
                &ignored_head,
                "develop",
            ),
            Err(GitError::WorktreeHasIgnoredFiles)
        );
        assert_eq!(
            fs::read_to_string(ignored.managed.join("ignored.local"))
                .expect("preserved ignored file"),
            "preserve\n"
        );
    }

    #[test]
    fn alignment_preserves_the_divergent_commit_before_moving_the_clean_worktree() {
        let fixture = SyncFixture::new();
        fixture.rename_managed_remote("upstream");
        fs::write(fixture.managed.join("workspace.txt"), "workspace\n").expect("workspace file");
        run(Some(&fixture.managed), ["add", "workspace.txt"]);
        run(Some(&fixture.managed), ["commit", "-m", "workspace commit"]);
        let previous = output(Some(&fixture.managed), ["rev-parse", "HEAD"]);
        let target = fixture.push_upstream_commit("upstream.txt", "upstream\n");
        let service = GitWorktreeService::new();

        let preview = service
            .preview_clean_worktree_alignment(&fixture.managed, &previous, "develop")
            .expect("preview alignment");
        assert_eq!(preview.previous_commit_oid, previous);
        assert_eq!(preview.target_commit_oid, target);
        assert_eq!(preview.remote_full_ref, "refs/remotes/upstream/develop");
        assert_eq!(
            preview.backup_full_ref,
            format!("refs/wts/backups/{previous}")
        );
        assert_eq!(
            output(Some(&fixture.managed), ["rev-parse", "HEAD"]),
            previous
        );

        let result = service
            .align_clean_worktree_to_remote_base(
                &fixture.managed,
                &previous,
                "develop",
                &preview.target_commit_oid,
                &preview.remote_full_ref,
                &preview.backup_full_ref,
            )
            .expect("align worktree");

        assert_eq!(result.commit_oid, target);
        assert_eq!(result.remote_url.as_deref(), fixture.remote.to_str());
        assert_eq!(
            output(
                Some(&fixture.managed),
                ["rev-parse", &preview.backup_full_ref]
            ),
            previous
        );
        assert_eq!(
            output(Some(&fixture.managed), ["rev-parse", "HEAD"]),
            target
        );
        assert!(!fixture.managed.join("workspace.txt").exists());
        assert_eq!(
            fs::read_to_string(fixture.managed.join("upstream.txt")).expect("upstream file"),
            "upstream\n"
        );
    }

    struct SyncFixture {
        _directory: tempfile::TempDir,
        remote: PathBuf,
        upstream: PathBuf,
        managed: PathBuf,
    }

    impl SyncFixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().expect("sync fixture directory");
            let remote = directory.path().join("remote.git");
            let upstream = directory.path().join("upstream");
            let managed = directory.path().join("managed");
            run(
                None,
                ["init", "--bare", remote.to_str().expect("remote path")],
            );
            run(
                None,
                [
                    "clone",
                    remote.to_str().expect("remote path"),
                    upstream.to_str().expect("upstream path"),
                ],
            );
            configure_fixture_repository(&upstream);
            fs::write(upstream.join("README.md"), "base\n").expect("base file");
            run(Some(&upstream), ["add", "README.md"]);
            run(Some(&upstream), ["commit", "-m", "base"]);
            run(Some(&upstream), ["branch", "-M", "develop"]);
            run(Some(&upstream), ["push", "-u", "origin", "develop"]);
            run(
                None,
                [
                    "clone",
                    "--branch",
                    "develop",
                    remote.to_str().expect("remote path"),
                    managed.to_str().expect("managed path"),
                ],
            );
            configure_fixture_repository(&managed);
            Self {
                _directory: directory,
                remote,
                upstream,
                managed,
            }
        }

        fn push_upstream_commit(&self, leaf: &str, contents: &str) -> String {
            fs::write(self.upstream.join(leaf), contents).expect("upstream file");
            run(Some(&self.upstream), ["add", leaf]);
            run(Some(&self.upstream), ["commit", "-m", "upstream change"]);
            run(Some(&self.upstream), ["push", "origin", "develop"]);
            let commit = output(Some(&self.upstream), ["rev-parse", "HEAD"]);
            assert!(self.remote.exists());
            commit
        }

        fn rename_managed_remote(&self, name: &str) {
            run(Some(&self.managed), ["remote", "rename", "origin", name]);
            assert_eq!(
                output(
                    Some(&self.managed),
                    ["config", "--get", "branch.develop.remote"]
                ),
                name
            );
        }
    }

    fn configure_fixture_repository(repository: &Path) {
        run(Some(repository), ["config", "user.name", "WTS Test"]);
        run(
            Some(repository),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(Some(repository), ["config", "commit.gpgSign", "false"]);
    }

    fn run<const N: usize>(repository: Option<&Path>, args: [&str; N]) {
        let status = command(repository, args)
            .status()
            .expect("start fixture Git");
        assert!(status.success(), "fixture Git command failed");
    }

    fn output<const N: usize>(repository: Option<&Path>, args: [&str; N]) -> String {
        let output = command(repository, args)
            .output()
            .expect("start fixture Git");
        assert!(output.status.success(), "fixture Git command failed");
        String::from_utf8(output.stdout)
            .expect("UTF-8 Git output")
            .trim()
            .to_owned()
    }

    fn command<const N: usize>(repository: Option<&Path>, args: [&str; N]) -> Command {
        let mut command = Command::new("git");
        if let Some(repository) = repository {
            command.arg("-C").arg(repository);
        }
        command
            .args(args)
            .env("LC_ALL", "C")
            .env("GIT_TERMINAL_PROMPT", "0");
        command
    }
}
