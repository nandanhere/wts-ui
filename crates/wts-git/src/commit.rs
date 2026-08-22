use std::ffi::OsString;
use std::path::{Component, Path};

use serde::Serialize;

use crate::command::git_with_stdout_limit;
use crate::{GitError, GitOperation};

/// Maximum number of exact-commit files considered by the runtime analyzer.
pub const MAX_RUNTIME_CANDIDATE_FILES: usize = 128;
/// Maximum accepted size of one candidate file.
pub const MAX_RUNTIME_CANDIDATE_BLOB_BYTES: usize = 256 * 1024;
/// Maximum accepted bytes across all candidate files in one repository.
pub const MAX_RUNTIME_CANDIDATE_TOTAL_BYTES: usize = 1024 * 1024;

const TREE_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

/// One allowlisted regular file read from a specific Git commit.
///
/// `path` comes from Git's tree, and `bytes` come from the blob OID in that
/// same tree. The checkout and index are never consulted.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitCandidateBlob {
    pub path: String,
    pub kind: CommitCandidateKind,
    #[serde(skip)]
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommitCandidateKind {
    StackManifest,
    PackageManifest,
    Dockerfile,
    EnvironmentExample,
    ComposeManifest,
}

struct TreeEntry {
    path: String,
    oid: String,
    kind: CommitCandidateKind,
}

/// Read the small, allowlisted set of runtime-related files from an exact
/// commit. This operation is local-only, performs no checkout, and has fixed
/// file-count, per-file, aggregate, and command-output limits.
pub(crate) fn read_runtime_candidate_blobs(
    repository: &Path,
    commit_oid: &str,
) -> Result<Vec<CommitCandidateBlob>, GitError> {
    if !valid_oid(commit_oid) {
        return Err(GitError::InvalidCommitOid);
    }

    let args = [
        OsString::from("ls-tree"),
        OsString::from("-r"),
        OsString::from("-z"),
        OsString::from("--full-tree"),
        OsString::from(commit_oid),
    ];
    let output = git_with_stdout_limit(Some(repository), args, TREE_OUTPUT_LIMIT)?;
    if !output.status.success() {
        return Err(output.command_error(GitOperation::ReadCommitTree));
    }
    if output.stdout_truncated {
        return Err(GitError::CommitTreeTooLarge);
    }

    let mut entries = parse_tree_entries(&output.stdout)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    entries.dedup_by(|left, right| left.path == right.path);
    if entries.len() > MAX_RUNTIME_CANDIDATE_FILES {
        return Err(GitError::TooManyCommitFiles);
    }

    let mut total_bytes = 0_usize;
    let mut blobs = Vec::with_capacity(entries.len());
    for entry in entries {
        let output = git_with_stdout_limit(
            Some(repository),
            [
                OsString::from("cat-file"),
                OsString::from("blob"),
                entry.oid.into(),
            ],
            MAX_RUNTIME_CANDIDATE_BLOB_BYTES,
        )?;
        if !output.status.success() {
            return Err(output.command_error(GitOperation::ReadCommitBlob));
        }
        if output.stdout_truncated {
            return Err(GitError::CommitFilesTooLarge);
        }
        total_bytes = total_bytes
            .checked_add(output.stdout.len())
            .ok_or(GitError::CommitFilesTooLarge)?;
        if total_bytes > MAX_RUNTIME_CANDIDATE_TOTAL_BYTES {
            return Err(GitError::CommitFilesTooLarge);
        }
        blobs.push(CommitCandidateBlob {
            path: entry.path,
            kind: entry.kind,
            bytes: output.stdout,
        });
    }
    Ok(blobs)
}

fn parse_tree_entries(bytes: &[u8]) -> Result<Vec<TreeEntry>, GitError> {
    let mut entries = Vec::new();
    for record in bytes.split(|byte| *byte == 0) {
        if record.is_empty() {
            continue;
        }
        let record =
            std::str::from_utf8(record).map_err(|_| GitError::InvalidRepositoryMetadata)?;
        let (metadata, path) = record
            .split_once('\t')
            .ok_or(GitError::InvalidRepositoryMetadata)?;
        let mut metadata = metadata.split(' ');
        let mode = metadata.next();
        let object_type = metadata.next();
        let oid = metadata.next();
        if metadata.next().is_some() {
            return Err(GitError::InvalidRepositoryMetadata);
        }
        // Symlinks and submodules are intentionally excluded.
        if !matches!(mode, Some("100644" | "100755")) || object_type != Some("blob") {
            continue;
        }
        let Some(oid) = oid.filter(|value| valid_oid(value)) else {
            return Err(GitError::InvalidRepositoryMetadata);
        };
        let Some(kind) = classify_path(path) else {
            continue;
        };
        if !safe_tree_path(path) {
            continue;
        }
        entries.push(TreeEntry {
            path: path.to_owned(),
            oid: oid.to_owned(),
            kind,
        });
    }
    Ok(entries)
}

fn classify_path(path: &str) -> Option<CommitCandidateKind> {
    let name = path.rsplit('/').next()?;
    match name {
        "wts-stack.json" => Some(CommitCandidateKind::StackManifest),
        "package.json" => Some(CommitCandidateKind::PackageManifest),
        "Dockerfile" => Some(CommitCandidateKind::Dockerfile),
        ".env.example" | ".env.sample" => Some(CommitCandidateKind::EnvironmentExample),
        "compose.yaml" | "compose.yml" | "docker-compose.yaml" | "docker-compose.yml" => {
            Some(CommitCandidateKind::ComposeManifest)
        }
        value if value.starts_with("Dockerfile.") && value.len() > "Dockerfile.".len() => {
            Some(CommitCandidateKind::Dockerfile)
        }
        _ => None,
    }
}

fn safe_tree_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.chars().any(char::is_control)
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && Path::new(path).components().count() <= 32
}

fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_only_allowlisted_runtime_files() {
        assert_eq!(
            classify_path("services/api/wts-stack.json"),
            Some(CommitCandidateKind::StackManifest)
        );
        assert_eq!(
            classify_path("Dockerfile.dev"),
            Some(CommitCandidateKind::Dockerfile)
        );
        assert_eq!(classify_path(".env"), None);
        assert_eq!(classify_path("secrets.env.example.bak"), None);
    }

    #[test]
    fn rejects_unsafe_tree_paths_and_object_ids() {
        assert!(!safe_tree_path("../package.json"));
        assert!(!safe_tree_path("/package.json"));
        assert!(!safe_tree_path("service/\n/package.json"));
        assert!(safe_tree_path("service/package.json"));
        assert!(valid_oid(&"a".repeat(40)));
        assert!(valid_oid(&"b".repeat(64)));
        assert!(!valid_oid("HEAD"));
    }
}
