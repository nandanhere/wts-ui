use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;
use wts_git::{
    GitError, GitWorktreeService, RepositoryRequest, WorkspaceWorktreeRequest,
    WorktreeRemovalRequest,
};

struct TestRepository {
    _directory: TempDir,
    root: PathBuf,
}

impl TestRepository {
    fn new(name: &str) -> Self {
        let directory = tempfile::tempdir().expect("temporary repository");
        let root = directory.path().join(name);
        fs::create_dir(&root).expect("repository directory");
        run(None, ["init", root.to_str().expect("utf8 path")]);
        run(Some(&root), ["config", "user.name", "WTS Test"]);
        run(Some(&root), ["config", "user.email", "wts@example.invalid"]);
        run(Some(&root), ["config", "commit.gpgSign", "false"]);
        fs::write(root.join("README.md"), format!("# {name}\n")).expect("fixture file");
        run(Some(&root), ["add", "README.md"]);
        run(Some(&root), ["commit", "-m", "initial"]);
        run(Some(&root), ["branch", "-M", "main"]);
        Self {
            _directory: directory,
            root,
        }
    }

    fn head_branch(&self) -> String {
        output(Some(&self.root), ["branch", "--show-current"])
            .trim()
            .to_owned()
    }

    fn has_branch(&self, branch: &str) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(["show-ref", "--verify", "--quiet"])
            .arg(format!("refs/heads/{branch}"))
            .status()
            .expect("git")
            .success()
    }
}

#[test]
fn discovers_canonical_repository_metadata_without_network() {
    let repository = TestRepository::new("payments-api");
    run(
        Some(&repository.root),
        [
            "remote",
            "add",
            "origin",
            "https://user:secret@example.com/acme/payments-api.git",
        ],
    );
    let nested = repository.root.join("src/deeper");
    fs::create_dir_all(&nested).expect("nested directory");

    let inspected = GitWorktreeService::new()
        .inspect_repository(&nested)
        .expect("repository inspection");

    assert_eq!(
        inspected.worktree_root,
        repository.root.canonicalize().unwrap()
    );
    assert_eq!(inspected.label, "payments-api");
    assert_eq!(
        inspected.origin_url.as_deref(),
        Some("https://example.com/acme/payments-api.git")
    );
    assert_eq!(inspected.default_branch.name, "main");
    assert_eq!(inspected.default_branch.full_ref, "refs/heads/main");
    assert!(inspected.id.as_str().starts_with("repo_"));
}

#[test]
fn conventional_default_branch_wins_over_current_feature_checkout() {
    let repository = TestRepository::new("payments-api");
    run(
        Some(&repository.root),
        ["checkout", "-b", "feature/current-work"],
    );

    let inspected = GitWorktreeService::new()
        .inspect_repository(&repository.root)
        .expect("repository inspection");

    assert_eq!(repository.head_branch(), "feature/current-work");
    assert_eq!(inspected.default_branch.name, "main");
    assert_eq!(inspected.default_branch.full_ref, "refs/heads/main");
}

#[test]
fn symbolic_origin_head_has_highest_default_branch_precedence() {
    let repository = TestRepository::new("payments-api");
    run(
        Some(&repository.root),
        ["update-ref", "refs/remotes/origin/trunk", "refs/heads/main"],
    );
    run(
        Some(&repository.root),
        [
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/trunk",
        ],
    );

    let inspected = GitWorktreeService::new()
        .inspect_repository(&repository.root)
        .expect("repository inspection");

    assert_eq!(inspected.default_branch.name, "trunk");
    assert_eq!(
        inspected.default_branch.full_ref,
        "refs/remotes/origin/trunk"
    );
    assert_eq!(
        inspected.default_branch.commit_oid,
        output(Some(&repository.root), ["rev-parse", "refs/heads/main"]).trim()
    );
}

#[test]
fn conventional_origin_branch_wins_over_a_sole_local_feature_branch() {
    let repository = TestRepository::new("payments-api");
    run(Some(&repository.root), ["branch", "-M", "feature/local"]);
    run(
        Some(&repository.root),
        [
            "update-ref",
            "refs/remotes/origin/main",
            "refs/heads/feature/local",
        ],
    );

    let inspected = GitWorktreeService::new()
        .inspect_repository(&repository.root)
        .expect("repository inspection");

    assert_eq!(inspected.default_branch.name, "main");
    assert_eq!(
        inspected.default_branch.full_ref,
        "refs/remotes/origin/main"
    );
}

#[test]
fn sole_local_branch_and_current_head_fallbacks_preserve_their_order() {
    let repository = TestRepository::new("payments-api");
    run(Some(&repository.root), ["branch", "-M", "trunk"]);

    let sole = GitWorktreeService::new()
        .inspect_repository(&repository.root)
        .expect("sole branch inspection");
    assert_eq!(sole.default_branch.name, "trunk");
    assert_eq!(sole.default_branch.full_ref, "refs/heads/trunk");

    run(
        Some(&repository.root),
        ["checkout", "-b", "feature/current"],
    );
    let current = GitWorktreeService::new()
        .inspect_repository(&repository.root)
        .expect("current branch inspection");
    assert_eq!(current.default_branch.name, "feature/current");
    assert_eq!(
        current.current_branch_full_ref.as_deref(),
        Some("refs/heads/feature/current")
    );
}

#[test]
fn detached_head_is_not_reported_as_a_current_branch() {
    let repository = TestRepository::new("payments-api");
    run(Some(&repository.root), ["checkout", "--detach"]);

    let inspected = GitWorktreeService::new()
        .inspect_repository(&repository.root)
        .expect("repository inspection");

    assert_eq!(inspected.default_branch.name, "main");
    assert_eq!(inspected.default_branch.full_ref, "refs/heads/main");
    assert_eq!(inspected.current_branch_full_ref, None);
}

#[test]
fn linked_worktrees_share_identity_but_keep_worktree_local_head_state() {
    let repository = TestRepository::new("payments-api");
    let linked = repository
        .root
        .parent()
        .expect("fixture parent")
        .join("linked");
    run(
        Some(&repository.root),
        [
            "worktree",
            "add",
            "-b",
            "feature/linked",
            linked.to_str().expect("utf8 path"),
            "main",
        ],
    );

    let service = GitWorktreeService::new();
    let source = service
        .inspect_repository(&repository.root)
        .expect("source inspection");
    let worktree = service
        .inspect_repository(&linked)
        .expect("linked worktree inspection");

    assert_eq!(source.id, worktree.id);
    assert_eq!(source.git_common_dir, worktree.git_common_dir);
    assert_eq!(
        source.current_branch_full_ref.as_deref(),
        Some("refs/heads/main")
    );
    assert_eq!(
        worktree.current_branch_full_ref.as_deref(),
        Some("refs/heads/feature/linked")
    );
}

#[test]
fn inspects_sha256_repository_when_git_supports_it() {
    let directory = tempfile::tempdir().expect("temporary repository");
    let root = directory.path().join("sha256");
    fs::create_dir(&root).expect("repository directory");
    let init = command(
        None,
        [
            "init",
            "--object-format=sha256",
            root.to_str().expect("utf8 path"),
        ],
    )
    .output()
    .expect("start Git");
    if !init.status.success() {
        eprintln!("Git does not support SHA-256 repositories; skipping fixture");
        return;
    }
    run(Some(&root), ["config", "user.name", "WTS Test"]);
    run(Some(&root), ["config", "user.email", "wts@example.invalid"]);
    run(Some(&root), ["config", "commit.gpgSign", "false"]);
    fs::write(root.join("README.md"), "# sha256\n").expect("fixture file");
    run(Some(&root), ["add", "README.md"]);
    run(Some(&root), ["commit", "-m", "initial"]);
    run(Some(&root), ["branch", "-M", "main"]);

    let inspected = GitWorktreeService::new()
        .inspect_repository(&root)
        .expect("SHA-256 repository inspection");

    assert_eq!(inspected.default_branch.commit_oid.len(), 64);
    assert!(
        inspected
            .default_branch
            .commit_oid
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    );
}

#[test]
fn creates_multiple_worktrees_without_changing_source_checkouts() {
    let first = TestRepository::new("api");
    let second = TestRepository::new("web");
    let workspace = tempfile::tempdir().expect("workspace");
    let service = GitWorktreeService::new();
    let request = WorkspaceWorktreeRequest::new(
        workspace.path(),
        "wts/bug-142",
        vec![
            RepositoryRequest::new(&first.root),
            RepositoryRequest::new(&second.root),
        ],
    );

    let receipt = service
        .materialize_workspace(&request)
        .expect("materialization");

    assert_eq!(receipt.worktrees.len(), 2);
    assert!(
        receipt
            .worktrees
            .iter()
            .all(|entry| entry.target_path.is_dir())
    );
    assert!(first.has_branch("wts/bug-142"));
    assert!(second.has_branch("wts/bug-142"));
    assert_eq!(first.head_branch(), "main");
    assert_eq!(second.head_branch(), "main");
    let canonical_workspace = workspace.path().canonicalize().unwrap();
    for entry in &receipt.worktrees {
        assert_eq!(
            output(Some(&entry.target_path), ["branch", "--show-current"]).trim(),
            "wts/bug-142"
        );
        assert_eq!(
            entry.target_path.parent(),
            Some(canonical_workspace.as_path())
        );
    }
}

#[test]
fn preflight_is_read_only_and_materialize_creates_final_workspace_root() {
    let repository = TestRepository::new("api");
    let workspace_parent = tempfile::tempdir().expect("workspace parent");
    let workspace_root = workspace_parent.path().join("bug-142");
    let service = GitWorktreeService::new();
    let request = WorkspaceWorktreeRequest::new(
        &workspace_root,
        "wts/bug-142",
        vec![RepositoryRequest::new(&repository.root)],
    );

    let plan = service.preflight(&request).expect("preflight");
    assert!(plan.workspace_root_will_be_created());
    assert!(!workspace_root.exists(), "preflight must not write");

    let receipt = service.materialize(plan).expect("materialization");
    assert!(receipt.workspace_root_created);
    assert!(workspace_root.is_dir());
    assert_eq!(receipt.worktrees.len(), 1);

    let rollback = service.rollback(&receipt);
    assert!(rollback.failures.is_empty());
    assert!(rollback.workspace_root_created);
    assert!(rollback.workspace_root_removed);
    assert!(rollback.workspace_root_removal_error.is_none());
    assert!(!workspace_root.exists());
}

#[test]
fn rejects_branch_and_target_path_conflicts_during_preflight() {
    let repository = TestRepository::new("api");
    let workspace = tempfile::tempdir().expect("workspace");
    let service = GitWorktreeService::new();
    let inspected = service.inspect_repository(&repository.root).unwrap();
    let request = WorkspaceWorktreeRequest::new(
        workspace.path(),
        "wts/conflict",
        vec![RepositoryRequest::new(&repository.root)],
    );

    run(Some(&repository.root), ["branch", "wts/conflict", "main"]);
    assert_eq!(service.preflight(&request), Err(GitError::BranchConflict));
    run(Some(&repository.root), ["branch", "-D", "wts/conflict"]);

    fs::create_dir(workspace.path().join(inspected.worktree_leaf())).expect("conflicting target");
    assert_eq!(
        service.preflight(&request),
        Err(GitError::TargetPathConflict)
    );
}

#[test]
fn rolls_back_first_repository_when_second_changes_after_preflight() {
    let first = TestRepository::new("api");
    let second = TestRepository::new("web");
    let workspace_parent = tempfile::tempdir().expect("workspace parent");
    let workspace = workspace_parent.path().join("rollback-workspace");
    let service = GitWorktreeService::new();
    let request = WorkspaceWorktreeRequest::new(
        &workspace,
        "wts/race",
        vec![
            RepositoryRequest::new(&first.root),
            RepositoryRequest::new(&second.root),
        ],
    );
    let plan = service.preflight(&request).expect("preflight");
    let first_target = plan.repositories()[0].target_path.clone();

    // Simulate another local actor taking the second branch after preflight.
    run(Some(&second.root), ["branch", "wts/race", "main"]);
    let error = service.materialize(plan).expect_err("transaction failure");

    assert_eq!(error.cause, GitError::BranchConflict);
    assert_eq!(error.rollback.attempted.len(), 1);
    assert_eq!(error.rollback.removed.len(), 1);
    assert!(error.rollback.failures.is_empty());
    assert!(error.rollback.workspace_root_created);
    assert!(error.rollback.workspace_root_removed);
    assert!(error.rollback.workspace_root_removal_error.is_none());
    assert!(!workspace.exists());
    assert!(!first_target.exists());
    assert!(!first.has_branch("wts/race"));
    // The conflicting branch was not created by the receipt and is preserved.
    assert!(second.has_branch("wts/race"));
    assert_eq!(first.head_branch(), "main");
    assert_eq!(second.head_branch(), "main");
}

#[cfg(unix)]
#[test]
fn rejects_traversal_names_and_existing_target_symlinks() {
    use std::os::unix::fs::symlink;

    let repository = TestRepository::new("api");
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let service = GitWorktreeService::new();
    let traversal = WorkspaceWorktreeRequest::new(
        workspace.path(),
        "../../outside",
        vec![RepositoryRequest::new(&repository.root)],
    );
    assert_eq!(
        service.preflight(&traversal),
        Err(GitError::InvalidBranchName)
    );

    let inspected = service.inspect_repository(&repository.root).unwrap();
    symlink(
        outside.path(),
        workspace.path().join(inspected.worktree_leaf()),
    )
    .expect("target symlink");
    let normal = WorkspaceWorktreeRequest::new(
        workspace.path(),
        "wts/safe",
        vec![RepositoryRequest::new(&repository.root)],
    );
    assert_eq!(
        service.preflight(&normal),
        Err(GitError::TargetPathConflict)
    );
    assert!(outside.path().is_dir());
}

#[test]
fn rejects_workspace_that_overlaps_source_checkout() {
    let repository = TestRepository::new("api");
    let service = GitWorktreeService::new();
    let request = WorkspaceWorktreeRequest::new(
        &repository.root,
        "wts/unsafe",
        vec![RepositoryRequest::new(&repository.root)],
    );
    assert_eq!(
        service.preflight(&request),
        Err(GitError::WorkspaceOverlapsRepository)
    );
}

#[test]
fn manual_removal_accepts_committed_work_and_retains_the_branch() {
    let repository = TestRepository::new("api");
    let workspace_parent = tempfile::tempdir().expect("workspace parent");
    let workspace_root = workspace_parent.path().join("completed-workspace");
    let service = GitWorktreeService::new();
    let receipt = service
        .materialize_workspace(&WorkspaceWorktreeRequest::new(
            &workspace_root,
            "wts/completed",
            vec![RepositoryRequest::new(&repository.root)],
        ))
        .expect("materialize");
    let created = &receipt.worktrees[0];
    fs::write(created.target_path.join("completed.txt"), "done\n").expect("completed file");
    run(Some(&created.target_path), ["add", "completed.txt"]);
    run(
        Some(&created.target_path),
        ["commit", "-m", "complete workspace"],
    );
    let committed_head = output(Some(&created.target_path), ["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    let removal = WorktreeRemovalRequest::new(
        &created.source_repository,
        &receipt.workspace_root,
        &created.target_path,
        created.repository_id.as_str(),
        &created.branch_name,
    );

    let inspection = service
        .inspect_worktree_removal(&removal)
        .expect("removal preflight");
    assert!(inspection.present);
    assert!(!inspection.has_changes);
    assert!(!inspection.has_ignored_files);
    assert_eq!(inspection.head_commit_oid, committed_head);

    service.remove_worktree(&removal).expect("remove worktree");
    assert!(!created.target_path.exists());
    assert!(repository.has_branch("wts/completed"));
    assert_eq!(
        output(
            Some(&repository.root),
            ["rev-parse", "refs/heads/wts/completed"]
        )
        .trim(),
        committed_head
    );
}

#[test]
fn manual_removal_blocks_untracked_and_ignored_files() {
    let repository = TestRepository::new("api");
    fs::write(repository.root.join(".gitignore"), "*.cache\n").expect("ignore file");
    run(Some(&repository.root), ["add", ".gitignore"]);
    run(Some(&repository.root), ["commit", "-m", "add ignore rule"]);
    let workspace_parent = tempfile::tempdir().expect("workspace parent");
    let workspace_root = workspace_parent.path().join("blocked-workspace");
    let service = GitWorktreeService::new();
    let receipt = service
        .materialize_workspace(&WorkspaceWorktreeRequest::new(
            &workspace_root,
            "wts/blocked",
            vec![RepositoryRequest::new(&repository.root)],
        ))
        .expect("materialize");
    let created = &receipt.worktrees[0];
    let removal = WorktreeRemovalRequest::new(
        &created.source_repository,
        &receipt.workspace_root,
        &created.target_path,
        created.repository_id.as_str(),
        &created.branch_name,
    );

    fs::write(created.target_path.join("notes.txt"), "unsaved\n").expect("untracked file");
    let inspection = service
        .inspect_worktree_removal(&removal)
        .expect("dirty inspection");
    assert!(inspection.has_changes);
    assert_eq!(
        service.remove_worktree(&removal),
        Err(GitError::WorktreeHasChanges)
    );

    fs::remove_file(created.target_path.join("notes.txt")).expect("remove untracked");
    fs::write(created.target_path.join("build.cache"), "ignored\n").expect("ignored file");
    let inspection = service
        .inspect_worktree_removal(&removal)
        .expect("ignored inspection");
    assert!(!inspection.has_changes);
    assert!(inspection.has_ignored_files);
    assert_eq!(
        service.remove_worktree(&removal),
        Err(GitError::WorktreeHasIgnoredFiles)
    );
    assert!(created.target_path.is_dir());
    assert!(repository.has_branch("wts/blocked"));
}

#[test]
fn rollback_preserves_ignored_files_and_allows_retry_after_they_are_moved() {
    let repository = TestRepository::new("api");
    fs::write(repository.root.join(".gitignore"), "*.local\n").expect("ignore file");
    run(Some(&repository.root), ["add", ".gitignore"]);
    run(Some(&repository.root), ["commit", "-m", "add ignore rule"]);
    let original_head = output(Some(&repository.root), ["rev-parse", "HEAD"]);
    let workspace_parent = tempfile::tempdir().expect("workspace parent");
    let workspace_root = workspace_parent.path().join("rollback-workspace");
    let service = GitWorktreeService::new();
    let receipt = service
        .materialize_workspace(&WorkspaceWorktreeRequest::new(
            &workspace_root,
            "wts/ignored-rollback",
            vec![RepositoryRequest::new(&repository.root)],
        ))
        .expect("materialize");
    let created = &receipt.worktrees[0];
    let ignored_path = created.target_path.join("notes.local");
    let ignored_bytes = b"User notes that Git does not track.\n";
    fs::write(&ignored_path, ignored_bytes).expect("ignored user file");
    assert!(
        output(Some(&created.target_path), ["status", "--porcelain"]).is_empty(),
        "the fixture must not appear in the ordinary status check"
    );

    let blocked = service.rollback(&receipt);

    assert_eq!(
        fs::read(&ignored_path).expect("rollback must preserve ignored user files"),
        ignored_bytes
    );
    assert_eq!(blocked.failures.len(), 1);
    assert!(blocked.removed.is_empty());
    assert!(!blocked.workspace_root_removed);
    assert!(repository.has_branch("wts/ignored-rollback"));
    assert_eq!(repository.head_branch(), "main");
    assert_eq!(
        output(Some(&repository.root), ["rev-parse", "HEAD"]),
        original_head
    );

    let saved_notes = workspace_parent.path().join("saved-notes.local");
    fs::rename(&ignored_path, &saved_notes).expect("user moves the ignored notes outside");
    let retry = service.rollback(&receipt);
    assert!(retry.failures.is_empty());
    assert!(retry.workspace_root_removed);
    assert!(!workspace_root.exists());
    assert!(!repository.has_branch("wts/ignored-rollback"));
    assert_eq!(fs::read(saved_notes).expect("saved notes"), ignored_bytes);
}

fn run<const N: usize>(repository: Option<&Path>, args: [&str; N]) {
    let status = command(repository, args).status().expect("start Git");
    assert!(status.success(), "Git command failed");
}

fn output<const N: usize>(repository: Option<&Path>, args: [&str; N]) -> String {
    let result = command(repository, args).output().expect("start Git");
    assert!(result.status.success(), "Git command failed");
    String::from_utf8(result.stdout).expect("utf8 Git output")
}

fn command<const N: usize>(repository: Option<&Path>, args: [&str; N]) -> Command {
    let mut command = Command::new("git");
    if let Some(repository) = repository {
        command.arg("-C").arg(repository);
    }
    command.args(args).env("LC_ALL", "C");
    command
}
