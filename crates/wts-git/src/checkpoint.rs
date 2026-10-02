//! Read-only working-file capture for host-authored task receipts.
use crate::{GitError, GitOperation, GitWorktreeService, command::git_with_stdout_limit};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub const MAX_CHECKPOINT_FILES: usize = 2048;
pub const MAX_CHECKPOINT_TOTAL_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_CHECKPOINT_PATCH_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedWorktreeFile {
    pub file_path: String,
    pub content: Option<String>,
    #[serde(default)]
    pub raw_content: Option<Vec<u8>>,
    #[serde(default)]
    pub is_binary: bool,
    pub sha256: Option<String>,
    pub mode: Option<u32>,
    pub unsupported: bool,
    pub pre_existing_change: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCheckpointCapture {
    pub head_commit_oid: String,
    pub branch_name: String,
    pub index_sha256: String,
    pub files: BTreeMap<String, CapturedWorktreeFile>,
    pub omitted_file_count: usize,
    pub stable: bool,
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn command(root: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    let output = git_with_stdout_limit(
        Some(root),
        ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false"]
            .into_iter()
            .chain(args.iter().copied()),
        8 * 1024 * 1024,
    )?;
    if !output.status.success() {
        return Err(output.command_error(GitOperation::InspectWorktreeChanges));
    }
    if output.stdout_truncated {
        return Err(GitError::OutputTooLarge {
            operation: GitOperation::InspectWorktreeChanges,
        });
    }
    Ok(output.stdout)
}
fn paths(bytes: &[u8]) -> Result<BTreeSet<String>, GitError> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
        .map(|value| {
            String::from_utf8(value.to_vec()).map_err(|_| GitError::InvalidWorktreeFilePath)
        })
        .collect()
}
fn metadata(root: &Path) -> Result<(String, String, String, BTreeSet<String>), GitError> {
    let head = String::from_utf8(command(root, &["rev-parse", "--verify", "HEAD"])?)
        .map_err(|_| GitError::InvalidRepositoryMetadata)?
        .trim()
        .to_owned();
    let branch = String::from_utf8(command(root, &["symbolic-ref", "--short", "HEAD"])?)
        .map_err(|_| GitError::InvalidRepositoryMetadata)?
        .trim()
        .to_owned();
    let index = digest(&command(root, &["ls-files", "--stage", "-z"])?);
    let files = paths(&command(
        root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )?)?;
    Ok((head, branch, index, files))
}
impl GitWorktreeService {
    pub fn capture_worktree_checkpoint(
        &self,
        root: &Path,
    ) -> Result<WorktreeCheckpointCapture, GitError> {
        let before = metadata(root)?;
        let mut dirty = paths(&command(
            root,
            &[
                "diff",
                "--no-ext-diff",
                "--no-renames",
                "--name-only",
                "-z",
                "HEAD",
                "--",
            ],
        )?)?;
        dirty.extend(paths(&command(
            root,
            &["ls-files", "--others", "--exclude-standard", "-z"],
        )?)?);
        let mut files = BTreeMap::new();
        let mut omitted = before.3.len().saturating_sub(MAX_CHECKPOINT_FILES);
        let mut total = 0;
        for path in before.3.iter().take(MAX_CHECKPOINT_FILES) {
            if path.len() > 4096 || path.chars().any(char::is_control) {
                omitted += 1;
                continue;
            }
            let mut file = CapturedWorktreeFile {
                file_path: path.clone(),
                content: None,
                raw_content: None,
                is_binary: false,
                sha256: None,
                mode: None,
                unsupported: false,
                pre_existing_change: dirty.contains(path),
            };
            match self.checkpoint_source_bytes(root, path) {
                Ok(Some((bytes, mode))) if total + bytes.len() <= MAX_CHECKPOINT_TOTAL_BYTES => {
                    total += bytes.len();
                    file.sha256 = Some(digest(&bytes));
                    file.mode = Some(mode);
                    file.is_binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
                    if file.is_binary {
                        file.raw_content = Some(bytes);
                    } else {
                        file.content = Some(
                            String::from_utf8(bytes).map_err(|_| GitError::WorktreeFileNotUtf8)?,
                        );
                    }
                }
                Ok(None) => {}
                _ => {
                    file.unsupported = true;
                    omitted += 1;
                }
            }
            files.insert(path.clone(), file);
        }
        let stable_files = files.values().filter(|file| !file.unsupported).all(|file| {
            match self.checkpoint_source_bytes(root, &file.file_path) {
                Ok(Some((source, mode))) => {
                    file.sha256.as_ref() == Some(&digest(&source)) && file.mode == Some(mode)
                }
                Ok(None) => file.sha256.is_none(),
                Err(_) => false,
            }
        });
        let stable = stable_files && metadata(root).is_ok_and(|after| before == after);
        Ok(WorktreeCheckpointCapture {
            head_commit_oid: before.0,
            branch_name: before.1,
            index_sha256: before.2,
            files,
            omitted_file_count: omitted,
            stable,
        })
    }

    /// Diff private captured blobs. Neither argument is a worktree path.
    pub fn checkpoint_blob_patch(
        &self,
        before: &Path,
        after: &Path,
    ) -> Result<(String, bool), GitError> {
        use std::ffi::OsStr;
        let args: Vec<&OsStr> = vec![
            OsStr::new("diff"),
            OsStr::new("--no-index"),
            OsStr::new("--no-ext-diff"),
            OsStr::new("--no-textconv"),
            OsStr::new("--no-color"),
            OsStr::new("--unified=3"),
            OsStr::new("--"),
            before.as_os_str(),
            after.as_os_str(),
        ];
        let output = git_with_stdout_limit(None, args, MAX_CHECKPOINT_PATCH_BYTES)?;
        if !matches!(output.status.code(), Some(0 | 1)) {
            return Err(output.command_error(GitOperation::InspectWorktreeChanges));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let hunks = text
            .find("\n@@ ")
            .map(|offset| &text[offset + 1..])
            .unwrap_or("");
        Ok((hunks.to_owned(), output.stdout_truncated))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink, process::Command};
    fn git(root: &Path, args: &[&str]) {
        assert!(
            Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    #[test]
    fn checkpoint_reads_dirty_bytes_without_touching_index_and_confines_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "commit.gpgsign", "false"]);
        git(&root, &["config", "core.hooksPath", "/dev/null"]);
        git(&root, &["config", "user.name", "Fixture"]);
        git(&root, &["config", "user.email", "fixture@example.test"]);
        fs::write(root.join("tracked.txt"), "committed\n").unwrap();
        fs::write(root.join("deleted.txt"), "delete me\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "fixture"]);
        fs::write(root.join("tracked.txt"), "staged\n").unwrap();
        git(&root, &["add", "tracked.txt"]);
        fs::write(root.join("tracked.txt"), "dirty before task\n").unwrap();
        fs::remove_file(root.join("deleted.txt")).unwrap();
        fs::write(root.join("new.txt"), "untracked before task\n").unwrap();
        fs::write(root.join("binary.dat"), b"binary\0data").unwrap();
        fs::write(temp.path().join("private"), "OUTSIDE_SECRET").unwrap();
        symlink(temp.path().join("private"), root.join("link")).unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();
        let captured = GitWorktreeService
            .capture_worktree_checkpoint(&root)
            .unwrap();
        assert_eq!(
            captured.files["tracked.txt"].content.as_deref(),
            Some("dirty before task\n")
        );
        assert!(captured.files["tracked.txt"].pre_existing_change);
        assert_eq!(
            captured.files["new.txt"].content.as_deref(),
            Some("untracked before task\n")
        );
        assert!(captured.files["deleted.txt"].content.is_none());
        assert!(!captured.files["deleted.txt"].unsupported);
        assert!(captured.files["link"].unsupported);
        assert!(!captured.files["binary.dat"].unsupported);
        assert!(captured.files["binary.dat"].is_binary);
        assert_eq!(
            captured.files["binary.dat"].raw_content.as_deref(),
            Some(b"binary\0data".as_slice())
        );
        assert_eq!(captured.omitted_file_count, 1);
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        assert!(
            !serde_json::to_string(&captured)
                .unwrap()
                .contains("OUTSIDE_SECRET")
        );
    }
    #[test]
    fn checkpoint_limits_count_omitted_files_and_bytes_without_losing_supported_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "Fixture"]);
        git(root, &["config", "user.email", "fixture@example.test"]);
        git(
            root,
            &[
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        );
        for number in 0..17 {
            fs::write(
                root.join(format!("large-{number:02}.txt")),
                vec![b'x'; crate::MAX_WORKTREE_SOURCE_BYTES],
            )
            .unwrap();
        }
        fs::write(
            root.join("oversized.txt"),
            vec![b'x'; crate::MAX_WORKTREE_SOURCE_BYTES + 1],
        )
        .unwrap();
        let captured = GitWorktreeService
            .capture_worktree_checkpoint(root)
            .unwrap();
        assert_eq!(captured.omitted_file_count, 2);
        assert_eq!(
            captured
                .files
                .values()
                .filter_map(|file| file.content.as_ref())
                .map(String::len)
                .sum::<usize>(),
            MAX_CHECKPOINT_TOTAL_BYTES
        );
        for number in 0..17 {
            fs::remove_file(root.join(format!("large-{number:02}.txt"))).unwrap();
        }
        fs::remove_file(root.join("oversized.txt")).unwrap();
        for number in 0..MAX_CHECKPOINT_FILES + 1 {
            fs::write(root.join(format!("small-{number:04}.txt")), "small").unwrap();
        }
        let captured = GitWorktreeService
            .capture_worktree_checkpoint(root)
            .unwrap();
        assert_eq!(captured.files.len(), MAX_CHECKPOINT_FILES);
        assert_eq!(captured.omitted_file_count, 1);
    }
}
