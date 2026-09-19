use std::collections::{BTreeMap, BTreeSet};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

use hex::ToHex;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::command::{CommandOutput, git};
use crate::{GitError, GitOperation};

/// Stable identity for one local Git repository, shared by all of its worktrees.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct RepositoryId(String);

impl RepositoryId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A branch inferred entirely from local repository state.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultBranch {
    pub name: String,
    pub full_ref: String,
    pub commit_oid: String,
}

/// A branch currently available as a local or cached `origin/*` ref.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableBranch {
    pub name: String,
    pub full_ref: String,
    pub commit_oid: String,
    pub remote: bool,
}

/// A validated, locally available branch selected as a worktree base.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedBase {
    pub requested: String,
    pub name: String,
    pub full_ref: String,
    pub commit_oid: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TrackingRemote {
    pub name: String,
    pub branch: String,
}

/// Canonical local metadata. The original browser-facing request never supplies
/// any of these authority-bearing paths.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInspection {
    pub id: RepositoryId,
    pub label: String,
    pub worktree_root: PathBuf,
    pub git_common_dir: PathBuf,
    pub current_branch_full_ref: Option<String>,
    pub upstream_full_ref: Option<String>,
    pub origin_url: Option<String>,
    pub default_branch: DefaultBranch,
    pub available_branches: Vec<AvailableBranch>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RepositoryCloneOptions {
    pub branch: Option<String>,
    pub shallow: bool,
}

impl RepositoryInspection {
    /// A readable, traversal-free directory name unique to this repository.
    pub fn worktree_leaf(&self) -> String {
        format!("{}--{}", slug(&self.label), &self.id.as_str()[..12])
    }
}

struct RepositoryMetadata {
    worktree_root: PathBuf,
    git_common_dir: PathBuf,
}

#[derive(Default)]
struct RefSnapshot {
    refs: BTreeMap<String, Option<String>>,
    local_branches: BTreeSet<String>,
    origin_head: Option<String>,
    current_branch_full_ref: Option<String>,
    upstream_full_ref: Option<String>,
}

pub(crate) fn inspect_repository(trusted_path: &Path) -> Result<RepositoryInspection, GitError> {
    let supplied = trusted_path
        .canonicalize()
        .map_err(|_| GitError::RepositoryPathUnavailable)?;
    if !supplied.is_dir() {
        return Err(GitError::RepositoryPathUnavailable);
    }

    let metadata = read_repository_metadata(&supplied)?;
    let worktree_root = metadata.worktree_root;
    let git_common_dir = metadata.git_common_dir;

    let origin_url = optional_config(&worktree_root, "remote.origin.url")?
        .and_then(|value| sanitize_origin_url(value.trim()));
    let label = origin_url
        .as_deref()
        .and_then(label_from_origin)
        .or_else(|| {
            worktree_root
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "repository".to_owned());
    let refs = read_ref_snapshot(&worktree_root)?;
    let default_branch = resolve_default_branch(&worktree_root, &refs)?;
    let available_branches = available_branches(&refs);
    let current_branch_full_ref = refs.current_branch_full_ref;
    let upstream_full_ref = refs.upstream_full_ref;

    let identity_input = git_common_dir.to_string_lossy();
    let mut hasher = Sha256::new();
    hasher.update(b"wts-local-repository-v1\0");
    hasher.update(identity_input.as_bytes());
    let id = RepositoryId(format!("repo_{}", hasher.finalize().encode_hex::<String>()));

    Ok(RepositoryInspection {
        id,
        label,
        worktree_root,
        git_common_dir,
        current_branch_full_ref,
        upstream_full_ref,
        origin_url,
        default_branch,
        available_branches,
    })
}

pub(crate) fn clone_repository(
    remote_url: &str,
    target_path: &Path,
    options: &RepositoryCloneOptions,
) -> Result<RepositoryInspection, GitError> {
    if let Some(branch) = options.branch.as_deref() {
        if branch.len() > 256 || !valid_user_ref(branch) {
            return Err(GitError::InvalidBranchName);
        }
        let validation = git(None, ["check-ref-format", "--branch", branch])?;
        if !validation.status.success() {
            return Err(GitError::InvalidBranchName);
        }
    }
    let mut arguments = vec![
        OsString::from("clone"),
        OsString::from("--origin"),
        OsString::from("origin"),
    ];
    if options.shallow {
        arguments.extend([
            OsString::from("--depth"),
            OsString::from("1"),
            OsString::from("--single-branch"),
        ]);
    }
    if let Some(branch) = &options.branch {
        arguments.extend([OsString::from("--branch"), OsString::from(branch)]);
    }
    arguments.extend([
        OsString::from("--"),
        OsString::from(remote_url),
        target_path.as_os_str().to_owned(),
    ]);
    let output = git(None, arguments)?;
    if !output.status.success() {
        return Err(output.command_error(GitOperation::CloneRepository));
    }
    inspect_repository(target_path)
}

pub(crate) fn fetch_repository(trusted_path: &Path) -> Result<RepositoryInspection, GitError> {
    let repository = inspect_repository(trusted_path)?;
    if repository.origin_url.is_none() {
        return Err(GitError::InvalidRepositoryMetadata);
    }
    fetch_remote_repository(&repository, "origin")
}

pub(crate) fn fetch_remote_repository(
    repository: &RepositoryInspection,
    remote_name: &str,
) -> Result<RepositoryInspection, GitError> {
    let remotes = remote_names(&repository.worktree_root)?;
    if !valid_remote_name(remote_name) || !remotes.contains(remote_name) {
        return Err(GitError::InvalidRepositoryMetadata);
    }
    let refspec = format!("+refs/heads/*:refs/remotes/{remote_name}/*");
    let output = git(
        Some(&repository.worktree_root),
        [
            OsString::from("fetch"),
            OsString::from("--prune"),
            OsString::from("--no-tags"),
            OsString::from("--no-recurse-submodules"),
            OsString::from(remote_name),
            OsString::from(refspec),
        ],
    )?;
    if !output.status.success() {
        return Err(output.command_error(GitOperation::FetchRepository));
    }
    inspect_repository(&repository.worktree_root)
}

pub(crate) fn remote_display_url(
    repository: &RepositoryInspection,
    remote_name: &str,
) -> Result<Option<String>, GitError> {
    let remotes = remote_names(&repository.worktree_root)?;
    if !valid_remote_name(remote_name) || !remotes.contains(remote_name) {
        return Err(GitError::InvalidRepositoryMetadata);
    }
    optional_config(
        &repository.worktree_root,
        &format!("remote.{remote_name}.url"),
    )
    .map(|value| value.and_then(|url| sanitize_origin_url(url.trim())))
}

fn read_repository_metadata(supplied: &Path) -> Result<RepositoryMetadata, GitError> {
    // `--git-common-dir` is relative to Git's current directory when it is not
    // absolute, so resolve it against `supplied`, not the top-level checkout.
    // Keeping these queries in one process also makes the paths describe the
    // same repository observation.
    let output = git(
        Some(supplied),
        [
            "rev-parse",
            "--is-inside-work-tree",
            "--is-bare-repository",
            "--show-toplevel",
            "--git-common-dir",
        ],
    )?;
    let text = output.success_text(GitOperation::InspectRepository)?;
    let mut lines = text.lines();
    let inside = lines.next();

    // A bare repository prints `false` for the first query and then fails
    // `--show-toplevel`. The former implementation returned NotAWorktree at
    // that first observation, so preserve that result even though this batched
    // command exits unsuccessfully later.
    if inside == Some("false") {
        return Err(GitError::NotAWorktree);
    }
    if !output.status.success() {
        return Err(output.command_error(GitOperation::InspectRepository));
    }
    if inside != Some("true") {
        return Err(GitError::InvalidRepositoryMetadata);
    }

    match lines.next() {
        Some("true") => return Err(GitError::BareRepository),
        Some("false") => {}
        _ => return Err(GitError::InvalidRepositoryMetadata),
    }
    let top_level = lines
        .next()
        .filter(|value| !value.is_empty())
        .ok_or(GitError::InvalidRepositoryMetadata)?;
    let common = lines
        .next()
        .filter(|value| !value.is_empty())
        .ok_or(GitError::InvalidRepositoryMetadata)?;
    if lines.next().is_some() {
        return Err(GitError::InvalidRepositoryMetadata);
    }

    let worktree_root = PathBuf::from(top_level)
        .canonicalize()
        .map_err(|_| GitError::InvalidRepositoryMetadata)?;
    let common = PathBuf::from(common);
    let git_common_dir = if common.is_absolute() {
        common
    } else {
        supplied.join(common)
    }
    .canonicalize()
    .map_err(|_| GitError::InvalidRepositoryMetadata)?;

    Ok(RepositoryMetadata {
        worktree_root,
        git_common_dir,
    })
}

fn read_ref_snapshot(root: &Path) -> Result<RefSnapshot, GitError> {
    let output = git(
        Some(root),
        [
            "for-each-ref",
            "--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)%00%(symref)%00%(HEAD)%00%(upstream)",
            "--sort=refname",
            "refs/heads/",
            "refs/remotes/origin/",
        ],
    )?;
    let text = checked_text(output, GitOperation::ResolveDefaultBranch)?;
    let mut snapshot = RefSnapshot::default();

    for record in text.lines() {
        let fields = record.split('\0').collect::<Vec<_>>();
        let [
            full_ref,
            object_type,
            object_oid,
            peeled_type,
            peeled_oid,
            symref,
            head,
            upstream,
        ] = fields.as_slice()
        else {
            return Err(GitError::InvalidRepositoryMetadata);
        };
        if !full_ref.starts_with("refs/heads/") && !full_ref.starts_with("refs/remotes/origin/") {
            return Err(GitError::InvalidRepositoryMetadata);
        }

        let commit_oid =
            commit_oid_from_snapshot(object_type, object_oid, peeled_type, peeled_oid)?;
        if snapshot
            .refs
            .insert((*full_ref).to_owned(), commit_oid)
            .is_some()
        {
            return Err(GitError::InvalidRepositoryMetadata);
        }

        if let Some(name) = full_ref.strip_prefix("refs/heads/") {
            snapshot.local_branches.insert(name.to_owned());
        }
        if *full_ref == "refs/remotes/origin/HEAD"
            && !symref.is_empty()
            && snapshot.origin_head.replace((*symref).to_owned()).is_some()
        {
            return Err(GitError::InvalidRepositoryMetadata);
        }
        if head.trim() == "*" {
            if snapshot
                .current_branch_full_ref
                .replace((*full_ref).to_owned())
                .is_some()
            {
                return Err(GitError::InvalidRepositoryMetadata);
            }
            if !upstream.is_empty()
                && (!upstream.starts_with("refs/")
                    || upstream.bytes().any(|byte| byte.is_ascii_control())
                    || upstream.len() > 1024
                    || snapshot
                        .upstream_full_ref
                        .replace((*upstream).to_owned())
                        .is_some())
            {
                return Err(GitError::InvalidRepositoryMetadata);
            }
        } else if !head.trim().is_empty() {
            return Err(GitError::InvalidRepositoryMetadata);
        }
    }

    Ok(snapshot)
}

fn commit_oid_from_snapshot(
    object_type: &str,
    object_oid: &str,
    peeled_type: &str,
    peeled_oid: &str,
) -> Result<Option<String>, GitError> {
    let oid = match (object_type, peeled_type) {
        ("commit", _) => Some(object_oid),
        (_, "commit") => Some(peeled_oid),
        _ => None,
    };
    oid.map(|oid| {
        if is_hex_oid(oid) {
            Ok(oid.to_owned())
        } else {
            Err(GitError::InvalidRepositoryMetadata)
        }
    })
    .transpose()
}

fn available_branches(snapshot: &RefSnapshot) -> Vec<AvailableBranch> {
    let mut branches = BTreeMap::<String, AvailableBranch>::new();
    for (full_ref, commit_oid) in &snapshot.refs {
        let Some(commit_oid) = commit_oid.as_ref() else {
            continue;
        };
        if let Some(name) = full_ref.strip_prefix("refs/heads/") {
            branches.insert(
                name.to_owned(),
                AvailableBranch {
                    name: name.to_owned(),
                    full_ref: full_ref.clone(),
                    commit_oid: commit_oid.clone(),
                    remote: false,
                },
            );
            continue;
        }
        let Some(name) = full_ref.strip_prefix("refs/remotes/origin/") else {
            continue;
        };
        if name == "HEAD" || branches.contains_key(name) {
            continue;
        }
        branches.insert(
            name.to_owned(),
            AvailableBranch {
                name: name.to_owned(),
                full_ref: full_ref.clone(),
                commit_oid: commit_oid.clone(),
                remote: true,
            },
        );
    }
    branches.into_values().collect()
}

pub(crate) fn resolve_base(
    repository: &RepositoryInspection,
    requested: Option<&str>,
) -> Result<ResolvedBase, GitError> {
    let Some(requested) = requested else {
        return Ok(ResolvedBase {
            requested: repository.default_branch.name.clone(),
            name: repository.default_branch.name.clone(),
            full_ref: repository.default_branch.full_ref.clone(),
            commit_oid: repository.default_branch.commit_oid.clone(),
        });
    };
    let requested = requested.to_owned();
    validate_ref_input(&requested)?;
    if matches!(requested.len(), 40 | 64) && requested.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        let object = git(
            Some(&repository.worktree_root),
            ["cat-file", "-t", &requested],
        )?;
        if !object.status.success() || object.stdout != b"commit\n" {
            return Err(GitError::BaseReferenceNotFound);
        }
        let commit_oid = requested.to_ascii_lowercase();
        return Ok(ResolvedBase {
            requested,
            name: commit_oid.clone(),
            full_ref: commit_oid.clone(),
            commit_oid,
        });
    }

    let (name, candidates) = if let Some(name) = requested.strip_prefix("refs/heads/") {
        (name.to_owned(), vec![format!("refs/heads/{name}")])
    } else if let Some(name) = requested.strip_prefix("refs/remotes/origin/") {
        (name.to_owned(), vec![format!("refs/remotes/origin/{name}")])
    } else if let Some(name) = requested.strip_prefix("origin/") {
        (name.to_owned(), vec![format!("refs/remotes/origin/{name}")])
    } else {
        (
            requested.clone(),
            vec![
                format!("refs/heads/{requested}"),
                format!("refs/remotes/origin/{requested}"),
            ],
        )
    };
    let format = git(
        Some(&repository.worktree_root),
        ["check-ref-format", "--branch", &name],
    )?;
    if !format.status.success() {
        return Err(GitError::InvalidBaseReference);
    }

    for full_ref in candidates {
        if let Some(commit_oid) = commit_for_ref(&repository.worktree_root, &full_ref)? {
            return Ok(ResolvedBase {
                requested,
                name,
                full_ref,
                commit_oid,
            });
        }
    }

    Err(GitError::BaseReferenceNotFound)
}

pub(crate) fn resolve_remote_base(
    repository: &RepositoryInspection,
    requested: &str,
    tracking: &TrackingRemote,
) -> Result<ResolvedBase, GitError> {
    if !valid_remote_name(&tracking.name) {
        return Err(GitError::InvalidRepositoryMetadata);
    }
    let name = tracking.branch.as_str();
    let format = git(
        Some(&repository.worktree_root),
        ["check-ref-format", "--branch", name],
    )?;
    if !format.status.success() {
        return Err(GitError::InvalidBaseReference);
    }
    let full_ref = format!("refs/remotes/{}/{name}", tracking.name);
    let commit_oid = commit_for_ref(&repository.worktree_root, &full_ref)?
        .ok_or(GitError::BaseReferenceNotFound)?;
    Ok(ResolvedBase {
        requested: requested.to_owned(),
        name: name.to_owned(),
        full_ref,
        commit_oid,
    })
}

pub(crate) fn resolve_tracking_remote(
    repository: &RepositoryInspection,
    requested: &str,
) -> Result<TrackingRemote, GitError> {
    if !valid_user_ref(requested) {
        return Err(GitError::InvalidBaseReference);
    }
    let remotes = remote_names(&repository.worktree_root)?;
    let requested = requested.strip_prefix("refs/heads/").unwrap_or(requested);

    let (explicit_remote, branch) =
        if let Some(remote_ref) = requested.strip_prefix("refs/remotes/") {
            let (remote, branch) = remote_ref
                .split_once('/')
                .ok_or(GitError::InvalidBaseReference)?;
            (Some(remote), branch)
        } else if let Some((remote, branch)) = requested.split_once('/') {
            let local_ref = format!("refs/heads/{requested}");
            let local_tracking = optional_config(
                &repository.worktree_root,
                &format!("branch.{requested}.remote"),
            )?;
            if local_tracking.is_none()
                && commit_for_ref(&repository.worktree_root, &local_ref)?.is_none()
                && remotes.contains(remote)
            {
                (Some(remote), branch)
            } else {
                (None, requested)
            }
        } else {
            (None, requested)
        };
    let format = git(
        Some(&repository.worktree_root),
        ["check-ref-format", "--branch", branch],
    )?;
    if !format.status.success() {
        return Err(GitError::InvalidBaseReference);
    }

    let configured_remote = optional_config(
        &repository.worktree_root,
        &format!("branch.{branch}.remote"),
    )?
    .map(|remote| remote.trim().to_owned())
    .filter(|remote| remotes.contains(remote.as_str()));
    let remote = if let Some(explicit_remote) = explicit_remote {
        if !remotes.contains(explicit_remote) {
            return Err(GitError::InvalidRepositoryMetadata);
        }
        explicit_remote.to_owned()
    } else if let Some(configured_remote) = configured_remote {
        configured_remote
    } else if remotes.contains("origin") {
        "origin".to_owned()
    } else {
        let mut matching = Vec::new();
        for remote in &remotes {
            let full_ref = format!("refs/remotes/{remote}/{branch}");
            if commit_for_ref(&repository.worktree_root, &full_ref)?.is_some() {
                matching.push(remote.clone());
            }
        }
        if matching.len() != 1 {
            return Err(GitError::InvalidRepositoryMetadata);
        }
        matching.remove(0)
    };
    if !valid_remote_name(&remote) {
        return Err(GitError::InvalidRepositoryMetadata);
    }
    Ok(TrackingRemote {
        name: remote,
        branch: branch.to_owned(),
    })
}

pub(crate) fn validate_branch_name(
    repository: &RepositoryInspection,
    name: &str,
) -> Result<(), GitError> {
    if !valid_user_ref(name) {
        return Err(GitError::InvalidBranchName);
    }
    let output = git(
        Some(&repository.worktree_root),
        ["check-ref-format", "--branch", name],
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(GitError::InvalidBranchName)
    }
}

pub(crate) fn local_branch_exists(
    repository: &RepositoryInspection,
    name: &str,
) -> Result<bool, GitError> {
    let full_ref = format!("refs/heads/{name}");
    let output = git(
        Some(&repository.worktree_root),
        ["show-ref", "--verify", "--quiet", &full_ref],
    )?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(output.command_error(GitOperation::PreflightWorktree)),
    }
}

pub(crate) fn current_branch_full_ref(worktree: &Path) -> Result<Option<String>, GitError> {
    let output = git(Some(worktree), ["symbolic-ref", "--quiet", "HEAD"])?;
    match output.status.code() {
        Some(0) => {
            let value = output.success_text(GitOperation::ReadRepositoryMetadata)?;
            Ok(Some(value.trim().to_owned()))
        }
        Some(1) => Ok(None),
        _ => Err(output.command_error(GitOperation::ReadRepositoryMetadata)),
    }
}

pub(crate) fn commit_for_local_branch(
    repository: &RepositoryInspection,
    name: &str,
) -> Result<Option<String>, GitError> {
    commit_for_ref(&repository.worktree_root, &format!("refs/heads/{name}"))
}

fn resolve_default_branch(root: &Path, snapshot: &RefSnapshot) -> Result<DefaultBranch, GitError> {
    if let Some(full_ref) = snapshot.origin_head.as_deref()
        && let Some(name) = full_ref.strip_prefix("refs/remotes/origin/")
        && let Some(commit_oid) = snapshot_commit_for_ref(root, snapshot, full_ref)?
    {
        return Ok(DefaultBranch {
            name: name.to_owned(),
            full_ref: full_ref.to_owned(),
            commit_oid,
        });
    }

    for name in ["main", "master"] {
        let full_ref = format!("refs/heads/{name}");
        if let Some(commit_oid) = snapshot_commit_for_ref(root, snapshot, &full_ref)? {
            return Ok(DefaultBranch {
                name: name.to_owned(),
                full_ref,
                commit_oid,
            });
        }
    }
    for name in ["main", "master"] {
        let full_ref = format!("refs/remotes/origin/{name}");
        if let Some(commit_oid) = snapshot_commit_for_ref(root, snapshot, &full_ref)? {
            return Ok(DefaultBranch {
                name: name.to_owned(),
                full_ref,
                commit_oid,
            });
        }
    }

    if snapshot.local_branches.len() == 1 {
        let name = snapshot
            .local_branches
            .first()
            .ok_or(GitError::DefaultBranchNotFound)?;
        let full_ref = format!("refs/heads/{name}");
        if let Some(commit_oid) = snapshot_commit_for_ref(root, snapshot, &full_ref)? {
            return Ok(DefaultBranch {
                name: name.to_owned(),
                full_ref,
                commit_oid,
            });
        }
    }

    // Current HEAD is deliberately last. Looking at it before conventional
    // branches would mistake a developer's feature checkout for the default.
    if let Some(full_ref) = snapshot.current_branch_full_ref.as_deref()
        && let Some(name) = full_ref.strip_prefix("refs/heads/")
        && let Some(commit_oid) = snapshot_commit_for_ref(root, snapshot, full_ref)?
    {
        return Ok(DefaultBranch {
            name: name.to_owned(),
            full_ref: full_ref.to_owned(),
            commit_oid,
        });
    }

    Err(GitError::DefaultBranchNotFound)
}

fn snapshot_commit_for_ref(
    root: &Path,
    snapshot: &RefSnapshot,
    full_ref: &str,
) -> Result<Option<String>, GitError> {
    match snapshot.refs.get(full_ref) {
        None => Ok(None),
        Some(Some(commit_oid)) => Ok(Some(commit_oid.clone())),
        // Git branch refs normally point directly to commits. Preserve the old
        // `^{commit}` behavior for deliberately unusual refs rather than
        // treating a non-commit object ID as a valid base.
        Some(None) => commit_for_ref(root, full_ref),
    }
}

pub(crate) fn commit_for_ref(root: &Path, full_ref: &str) -> Result<Option<String>, GitError> {
    let expression = format!("{full_ref}^{{commit}}");
    let output = git(
        Some(root),
        ["rev-parse", "--verify", "--quiet", &expression],
    )?;
    match output.status.code() {
        Some(0) => {
            let oid = output.success_text(GitOperation::ValidateReference)?;
            let oid = oid.trim();
            if is_hex_oid(oid) {
                Ok(Some(oid.to_owned()))
            } else {
                Err(GitError::InvalidRepositoryMetadata)
            }
        }
        Some(1) => Ok(None),
        _ => Err(output.command_error(GitOperation::ValidateReference)),
    }
}

fn optional_config(root: &Path, key: &str) -> Result<Option<String>, GitError> {
    let output = git(Some(root), ["config", "--get", key])?;
    match output.status.code() {
        Some(0) => {
            let value = output.success_text(GitOperation::ReadRepositoryMetadata)?;
            Ok(Some(value))
        }
        Some(1) => Ok(None),
        _ => Err(output.command_error(GitOperation::ReadRepositoryMetadata)),
    }
}

fn remote_names(root: &Path) -> Result<BTreeSet<String>, GitError> {
    let output = git(Some(root), ["remote"])?;
    let text = checked_text(output, GitOperation::ReadRepositoryMetadata)?;
    text.lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| {
            valid_remote_name(name)
                .then(|| name.to_owned())
                .ok_or(GitError::InvalidRepositoryMetadata)
        })
        .collect()
}

fn checked_text(output: CommandOutput, operation: GitOperation) -> Result<String, GitError> {
    if !output.status.success() {
        return Err(output.command_error(operation));
    }
    output.success_text(operation)
}

fn valid_user_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.starts_with('-')
        && !value.contains('\0')
        && !value.contains('\n')
        && !value.contains('\r')
}

fn valid_remote_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
}

fn validate_ref_input(value: &str) -> Result<(), GitError> {
    if !valid_user_ref(value)
        || value.starts_with("refs/tags/")
        || (value.starts_with("refs/")
            && !value.starts_with("refs/heads/")
            && !value.starts_with("refs/remotes/origin/"))
    {
        return Err(GitError::InvalidBaseReference);
    }
    Ok(())
}

fn is_hex_oid(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sanitize_origin_url(value: &str) -> Option<String> {
    // Query strings and fragments are not needed to identify a repository and
    // commonly carry access tokens. Apply this to every origin form (including
    // SCP-style and local paths) before retaining anything for display.
    let metadata_end = value.find(['?', '#']).unwrap_or(value.len());
    let display_origin = &value[..metadata_end];
    if display_origin.is_empty() {
        return None;
    }

    if let Some((helper, _)) = display_origin.split_once("::")
        && is_remote_helper_name(helper)
    {
        // `ext::` is an arbitrary command line, so there is no reliable safe
        // subset to display. Other opaque helper addresses have the same
        // problem; retain only helper origins whose address contains a URI we
        // can sanitize below.
        if helper.eq_ignore_ascii_case("ext") || !display_origin.contains("://") {
            return None;
        }
    }

    if let Some(separator) = display_origin.find("://") {
        let authority_start = separator + "://".len();
        let remainder = &display_origin[authority_start..];
        let authority_end = remainder.find('/').unwrap_or(remainder.len());
        let (authority, path) = remainder.split_at(authority_end);
        if let Some(at) = authority.rfind('@') {
            // The last `@` terminates URL userinfo. Using it instead of the
            // first also prevents a malformed password containing `@` from
            // leaking its trailing portion.
            return Some(format!(
                "{}{}{}",
                &display_origin[..authority_start],
                &authority[at + 1..],
                path
            ));
        }
    }

    // SCP-style Git origins (`git@host:group/repository.git`) carry a
    // transport username before the host. It is not needed for display or for
    // deriving a forge URL, so remove it just as URL userinfo is removed
    // above. Require the colon separator after the final `@` to avoid
    // rewriting ordinary local paths containing that character.
    if !display_origin.contains("://")
        && let Some(at) = display_origin.rfind('@')
        && display_origin[at + 1..].contains(':')
    {
        return Some(display_origin[at + 1..].to_owned());
    }

    Some(display_origin.to_owned())
}

fn is_remote_helper_name(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

fn label_from_origin(origin: &str) -> Option<String> {
    // Keep this helper safe when called independently from repository
    // inspection; labels must never be derived from token-bearing metadata.
    let sanitized = sanitize_origin_url(origin)?;
    let trimmed = sanitized.trim_end_matches('/');
    let leaf = trimmed
        .rsplit(['/', ':'])
        .next()?
        .strip_suffix(".git")
        .unwrap_or_else(|| trimmed.rsplit(['/', ':']).next().unwrap_or(trimmed));
    if leaf.is_empty() {
        None
    } else {
        Some(leaf.to_owned())
    }
}

pub(crate) fn slug(value: &str) -> String {
    let mut output = String::with_capacity(value.len().min(48));
    let mut pending_dash = false;
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            if pending_dash && !output.is_empty() && output.len() < 48 {
                output.push('-');
            }
            pending_dash = false;
            if output.len() < 48 {
                output.push(character.to_ascii_lowercase());
            }
        } else {
            pending_dash = true;
        }
        if output.len() >= 48 {
            break;
        }
    }
    output
        .trim_end_matches('-')
        .to_owned()
        .if_empty("repository")
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_owned()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        RepositoryCloneOptions, clone_repository, inspect_repository, is_hex_oid,
        label_from_origin, sanitize_origin_url, slug,
    };
    use crate::command::measure_git_commands;
    use std::{fs, path::Path, process::Command};

    #[test]
    fn origin_metadata_is_safe_and_readable() {
        let cases = [
            (
                "https://user:password-marker@example.com/acme/api.git?token=query-marker#fragment-marker",
                "https://example.com/acme/api.git",
            ),
            (
                "http://user:p@ssword-marker@example.com/acme/api.git#fragment-marker",
                "http://example.com/acme/api.git",
            ),
            (
                "ssh://git:password-marker@example.com:2222/acme/api.git?token=query-marker",
                "ssh://example.com:2222/acme/api.git",
            ),
            (
                "https://example.com/acme/api.git?token=query-marker",
                "https://example.com/acme/api.git",
            ),
            (
                "git@example.com:acme/api.git?token=query-marker#fragment-marker",
                "example.com:acme/api.git",
            ),
            (
                "git+ssh://git:password-marker@example.com/acme/api.git?token=query-marker#fragment-marker",
                "git+ssh://example.com/acme/api.git",
            ),
            (
                "custom-transport://user:password-marker@example.com/acme/api.git?token=query-marker",
                "custom-transport://example.com/acme/api.git",
            ),
            (
                "acme-helper::https://user:password-marker@example.com/acme/api.git#fragment-marker",
                "acme-helper::https://example.com/acme/api.git",
            ),
        ];

        for (origin, expected) in cases {
            let sanitized = sanitize_origin_url(origin).expect("displayable origin");
            assert_eq!(sanitized, expected);
            assert!(!sanitized.contains("password-marker"));
            assert!(!sanitized.contains("query-marker"));
            assert!(!sanitized.contains("fragment-marker"));
            assert_eq!(label_from_origin(origin), Some("api".to_owned()));
        }

        assert_eq!(
            sanitize_origin_url(
                "ext::ssh -i password-marker git@example.com %S api.git?token=query-marker"
            ),
            None
        );
        assert_eq!(
            sanitize_origin_url("opaque-helper::password-marker@host/api.git#fragment-marker"),
            None
        );
        assert_eq!(slug("../../Payments API"), "payments-api");
    }

    #[test]
    fn inspection_serialization_never_contains_origin_secrets() {
        const PASSWORD_SENTINEL: &str = "WTS_PASSWORD_SENTINEL";
        const QUERY_SENTINEL: &str = "WTS_QUERY_SENTINEL";
        const FRAGMENT_SENTINEL: &str = "WTS_FRAGMENT_SENTINEL";

        let directory = tempfile::tempdir().expect("temporary repository");
        let root = directory.path().join("safe-api");
        fs::create_dir(&root).expect("repository directory");
        run(None, ["init", root.to_str().expect("utf8 path")]);
        run(Some(&root), ["config", "user.name", "WTS Test"]);
        run(Some(&root), ["config", "user.email", "wts@example.invalid"]);
        run(Some(&root), ["config", "commit.gpgSign", "false"]);
        fs::write(root.join("README.md"), "# safe api\n").expect("fixture file");
        run(Some(&root), ["add", "README.md"]);
        run(Some(&root), ["commit", "-m", "initial"]);
        run(Some(&root), ["branch", "-M", "main"]);

        let helper_origin = format!(
            "acme-helper::git+ssh://git:{PASSWORD_SENTINEL}@example.com/acme/safe-api.git?access_token={QUERY_SENTINEL}#{FRAGMENT_SENTINEL}"
        );
        run(
            Some(&root),
            ["remote", "add", "origin", helper_origin.as_str()],
        );

        let inspection = inspect_repository(&root).expect("repository inspection");
        assert_eq!(inspection.label, "safe-api");
        assert_eq!(
            inspection.origin_url.as_deref(),
            Some("acme-helper::git+ssh://example.com/acme/safe-api.git")
        );

        let serialized = serde_json::to_string(&inspection).expect("serialized inspection");
        for sentinel in [PASSWORD_SENTINEL, QUERY_SENTINEL, FRAGMENT_SENTINEL] {
            assert!(
                !serialized.contains(sentinel),
                "serialized inspection leaked {sentinel}"
            );
            assert!(
                !inspection.label.contains(sentinel),
                "repository label leaked {sentinel}"
            );
        }

        let ext_origin = format!(
            "ext::ssh -o SendEnv={PASSWORD_SENTINEL} git@example.com %S safe-api.git?access_token={QUERY_SENTINEL}#{FRAGMENT_SENTINEL}"
        );
        run(
            Some(&root),
            ["config", "remote.origin.url", ext_origin.as_str()],
        );
        let ext_inspection = inspect_repository(&root).expect("ext repository inspection");
        assert_eq!(ext_inspection.label, "safe-api");
        assert_eq!(ext_inspection.origin_url, None);

        let ext_serialized =
            serde_json::to_string(&ext_inspection).expect("serialized ext inspection");
        for sentinel in [PASSWORD_SENTINEL, QUERY_SENTINEL, FRAGMENT_SENTINEL] {
            assert!(
                !ext_serialized.contains(sentinel),
                "serialized ext inspection leaked {sentinel}"
            );
            assert!(
                !ext_inspection.label.contains(sentinel),
                "ext repository label leaked {sentinel}"
            );
        }
    }

    #[test]
    fn clone_uses_typed_arguments_and_returns_inspected_repository() {
        let directory = tempfile::tempdir().expect("temporary repository");
        let source = directory.path().join("source-api");
        fs::create_dir(&source).expect("source repository directory");
        run(None, ["init", source.to_str().expect("utf8 path")]);
        run(Some(&source), ["config", "user.name", "WTS Test"]);
        run(
            Some(&source),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(Some(&source), ["config", "commit.gpgSign", "false"]);
        fs::write(source.join("README.md"), "# source api\n").expect("fixture file");
        run(Some(&source), ["add", "README.md"]);
        run(Some(&source), ["commit", "-m", "initial"]);
        run(Some(&source), ["branch", "-M", "main"]);
        run(Some(&source), ["branch", "dev-local"]);

        let target = directory.path().join("cloned-api");
        let inspection = clone_repository(
            source.to_str().expect("utf8 source path"),
            &target,
            &RepositoryCloneOptions::default(),
        )
        .expect("clone repository");

        assert_eq!(
            inspection.worktree_root,
            target.canonicalize().expect("target")
        );
        assert_eq!(inspection.default_branch.name, "main");
        assert_eq!(inspection.origin_url.as_deref(), source.to_str(),);
        assert!(
            inspection
                .available_branches
                .iter()
                .any(|branch| branch.name == "dev-local" && branch.remote)
        );
        assert!(
            !inspection
                .available_branches
                .iter()
                .any(|branch| branch.name == "develop")
        );
    }

    #[test]
    fn clone_can_limit_history_and_remote_refs_to_one_branch() {
        let directory = tempfile::tempdir().expect("temporary repository");
        let source = directory.path().join("large-source");
        fs::create_dir(&source).expect("source repository directory");
        run(None, ["init", source.to_str().expect("utf8 path")]);
        run(Some(&source), ["config", "user.name", "WTS Test"]);
        run(
            Some(&source),
            ["config", "user.email", "wts@example.invalid"],
        );
        run(Some(&source), ["config", "commit.gpgSign", "false"]);
        fs::write(source.join("README.md"), "first\n").expect("fixture file");
        run(Some(&source), ["add", "README.md"]);
        run(Some(&source), ["commit", "-m", "first"]);
        run(Some(&source), ["branch", "-M", "master"]);
        run(Some(&source), ["branch", "feature/large-history"]);
        fs::write(source.join("README.md"), "second\n").expect("fixture file");
        run(Some(&source), ["commit", "-am", "second"]);

        let target = directory.path().join("shallow-master");
        let inspection = clone_repository(
            &format!("file://{}", source.display()),
            &target,
            &RepositoryCloneOptions {
                branch: Some("master".to_owned()),
                shallow: true,
            },
        )
        .expect("clone master");

        assert_eq!(inspection.default_branch.name, "master");
        let remote_refs = Command::new("git")
            .current_dir(&target)
            .args([
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/remotes/origin",
            ])
            .output()
            .expect("list cloned remote refs");
        assert!(remote_refs.status.success());
        assert_eq!(
            String::from_utf8_lossy(&remote_refs.stdout).trim(),
            "origin/master"
        );
        let count = Command::new("git")
            .current_dir(&target)
            .args(["rev-list", "--count", "HEAD"])
            .output()
            .expect("count shallow history");
        assert!(count.status.success());
        assert_eq!(String::from_utf8_lossy(&count.stdout).trim(), "1");
    }

    #[test]
    fn common_repository_inspection_uses_three_git_processes() {
        let directory = tempfile::tempdir().expect("temporary repository");
        let root = directory.path().join("api");
        fs::create_dir(&root).expect("repository directory");
        run(None, ["init", root.to_str().expect("utf8 path")]);
        run(Some(&root), ["config", "user.name", "WTS Test"]);
        run(Some(&root), ["config", "user.email", "wts@example.invalid"]);
        run(Some(&root), ["config", "commit.gpgSign", "false"]);
        fs::write(root.join("README.md"), "# api\n").expect("fixture file");
        run(Some(&root), ["add", "README.md"]);
        run(Some(&root), ["commit", "-m", "initial"]);
        run(Some(&root), ["branch", "-M", "main"]);

        let (inspection, commands) = measure_git_commands(|| inspect_repository(&root));

        assert_eq!(
            inspection
                .expect("repository inspection")
                .default_branch
                .name,
            "main"
        );
        assert_eq!(
            commands, 3,
            "the legacy common inspection path required eight Git processes"
        );
    }

    #[test]
    fn accepts_sha1_and_sha256_object_ids() {
        assert!(is_hex_oid(&"a".repeat(40)));
        assert!(is_hex_oid(&"b".repeat(64)));
        assert!(!is_hex_oid(&"c".repeat(63)));
    }

    fn run<const N: usize>(repository: Option<&Path>, args: [&str; N]) {
        let mut command = Command::new("git");
        if let Some(repository) = repository {
            command.arg("-C").arg(repository);
        }
        let status = command
            .args(args)
            .env("LC_ALL", "C")
            .status()
            .expect("start Git");
        assert!(status.success(), "Git command failed");
    }
}
