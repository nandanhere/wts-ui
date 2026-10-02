use std::path::Path;

use serde::Serialize;

use crate::{GitError, GitWorktreeService, WorktreeDiff};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeComparisonStatus {
    Ready,
    MissingCommits,
    Diverged,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeComparison {
    pub status: WorktreeComparisonStatus,
    pub local_head_commit_oid: String,
    pub latest_work: Option<WorktreeDiff>,
    pub since_mr: Option<WorktreeDiff>,
}

impl GitWorktreeService {
    pub fn inspect_worktree_comparison(
        &self,
        root: impl AsRef<Path>,
        base_commit_oid: &str,
        published_head_commit_oid: &str,
    ) -> Result<WorktreeComparison, GitError> {
        use crate::{GitOperation, command::git};
        let root = root.as_ref();
        for oid in [base_commit_oid, published_head_commit_oid] {
            if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(GitError::InvalidCommitOid);
            }
        }
        let local_head_commit_oid = self.head_commit_oid(root)?;
        let unavailable = |status| WorktreeComparison {
            status,
            local_head_commit_oid: local_head_commit_oid.clone(),
            latest_work: None,
            since_mr: None,
        };
        for oid in [base_commit_oid, published_head_commit_oid] {
            if !git(Some(root), ["cat-file", "-e", &format!("{oid}^{{commit}}")])?
                .status
                .success()
            {
                return Ok(unavailable(WorktreeComparisonStatus::MissingCommits));
            }
        }
        for (base, head) in [
            (base_commit_oid, published_head_commit_oid),
            (published_head_commit_oid, local_head_commit_oid.as_str()),
        ] {
            let ancestor = git(Some(root), ["merge-base", "--is-ancestor", base, head])?;
            if ancestor.status.code() == Some(1) {
                return Ok(unavailable(WorktreeComparisonStatus::Diverged));
            }
            if !ancestor.status.success() {
                return Err(ancestor.command_error(GitOperation::InspectWorktreeChanges));
            }
        }
        let latest_work = self.inspect_worktree_diff(root, base_commit_oid)?;
        let since_mr = self.inspect_worktree_diff(root, published_head_commit_oid)?;
        if self.head_commit_oid(root)? != local_head_commit_oid
            || latest_work != self.inspect_worktree_diff(root, base_commit_oid)?
            || since_mr != self.inspect_worktree_diff(root, published_head_commit_oid)?
            || self.head_commit_oid(root)? != local_head_commit_oid
        {
            return Err(GitError::RepositoryChanged);
        }
        Ok(WorktreeComparison {
            status: WorktreeComparisonStatus::Ready,
            local_head_commit_oid,
            latest_work: Some(latest_work),
            since_mr: Some(since_mr),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command};

    fn git(root: &Path, args: &[&str]) -> String {
        let result = Command::new("git")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env_remove("GIT_CONFIG_COUNT")
            .env_remove("GIT_CONFIG_PARAMETERS")
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-C",
            ])
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8(result.stdout).unwrap().trim().to_owned()
    }

    fn fixture() -> (tempfile::TempDir, String, String) {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-b", "main"]);
        git(root.path(), &["config", "user.name", "WTS Test"]);
        git(
            root.path(),
            &["config", "user.email", "wts@example.invalid"],
        );
        fs::write(root.path().join("source.txt"), "base\n").unwrap();
        git(root.path(), &["add", "source.txt"]);
        git(root.path(), &["commit", "-m", "base"]);
        let base = git(root.path(), &["rev-parse", "HEAD"]);
        fs::write(root.path().join("source.txt"), "published\n").unwrap();
        git(root.path(), &["commit", "-am", "published"]);
        let head = git(root.path(), &["rev-parse", "HEAD"]);
        (root, base, head)
    }

    #[test]
    fn comparison_includes_unpushed_staged_unstaged_and_untracked_files_without_mutation() {
        let (root, base, published) = fixture();
        fs::write(root.path().join("committed.txt"), "local commit\n").unwrap();
        git(root.path(), &["add", "committed.txt"]);
        git(root.path(), &["commit", "-m", "local"]);
        fs::write(root.path().join("staged.txt"), "staged\n").unwrap();
        git(root.path(), &["add", "staged.txt"]);
        fs::write(root.path().join("source.txt"), "unstaged\n").unwrap();
        fs::write(root.path().join("new.txt"), "untracked\n").unwrap();
        let before = git(root.path(), &["status", "--porcelain=v1"]);
        let head = git(root.path(), &["rev-parse", "HEAD"]);
        let result = GitWorktreeService::new()
            .inspect_worktree_comparison(root.path(), &base, &published)
            .unwrap();
        assert_eq!(result.status, WorktreeComparisonStatus::Ready);
        assert_eq!(result.local_head_commit_oid, head);
        let latest = result.latest_work.unwrap();
        let since = result.since_mr.unwrap();
        assert!(latest.patch.contains("-base\n+unstaged"));
        assert!(since.patch.contains("-published\n+unstaged"));
        for patch in [latest.patch, since.patch] {
            for text in ["+local commit", "+staged", "+untracked"] {
                assert!(patch.contains(text), "{patch}");
            }
        }
        assert_eq!(git(root.path(), &["rev-parse", "HEAD"]), head);
        assert_eq!(git(root.path(), &["status", "--porcelain=v1"]), before);
    }

    #[test]
    fn comparison_reports_missing_and_diverged_history_without_rewriting_it() {
        let (root, base, published) = fixture();
        let service = GitWorktreeService::new();
        assert_eq!(
            service
                .inspect_worktree_comparison(root.path(), &base, &"f".repeat(40))
                .unwrap()
                .status,
            WorktreeComparisonStatus::MissingCommits
        );
        git(root.path(), &["checkout", "-b", "diverged", &base]);
        fs::write(root.path().join("source.txt"), "different\n").unwrap();
        git(root.path(), &["commit", "-am", "different"]);
        let result = service
            .inspect_worktree_comparison(root.path(), &base, &published)
            .unwrap();
        assert_eq!(result.status, WorktreeComparisonStatus::Diverged);
        assert!(result.latest_work.is_none());
        assert!(result.since_mr.is_none());
        assert_eq!(git(root.path(), &["branch", "--show-current"]), "diverged");
        assert_eq!(
            fs::read_to_string(root.path().join("source.txt")).unwrap(),
            "different\n"
        );
    }
}
