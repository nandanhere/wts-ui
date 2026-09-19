use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use tempfile::TempDir;
use wts_git::{
    GitError, GitWorktreeService, RepositoryRequest, WorkspaceWorktreeRequest,
    WorktreeMaterializationProgress,
};

struct Fixture {
    directory: TempDir,
    repositories: Vec<PathBuf>,
    workspace: PathBuf,
}

impl Fixture {
    fn new(count: usize) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repositories = (0..count)
            .map(|index| {
                let root = directory.path().join(format!("repository-{index}"));
                fs::create_dir(&root).unwrap();
                git(&root, &["init"]);
                git(&root, &["config", "user.name", "WTS Test"]);
                git(&root, &["config", "user.email", "wts@example.invalid"]);
                git(&root, &["config", "commit.gpgSign", "false"]);
                fs::write(root.join("README.md"), "Original repository contents.\n").unwrap();
                fs::write(root.join(".gitignore"), "*.local\n").unwrap();
                git(&root, &["add", "README.md", ".gitignore"]);
                git(&root, &["commit", "-m", "initial"]);
                git(&root, &["branch", "-M", "main"]);
                root
            })
            .collect();
        let workspace = directory.path().join("workspace");
        Self {
            directory,
            repositories,
            workspace,
        }
    }

    fn plan(&self) -> wts_git::WorktreePlan {
        GitWorktreeService::new()
            .preflight(&WorkspaceWorktreeRequest::new(
                &self.workspace,
                "wts/observed",
                self.repositories
                    .iter()
                    .map(RepositoryRequest::new)
                    .collect(),
            ))
            .unwrap()
    }
}

#[test]
fn observer_persists_intent_and_verified_receipts_before_the_next_step() {
    let fixture = Fixture::new(2);
    let journal = fixture.directory.path().join("progress.json");
    let mut events = Vec::new();
    let receipt = GitWorktreeService::new()
        .materialize_observed(fixture.plan(), |event| {
            match event {
                WorktreeMaterializationProgress::Starting { plan } => {
                    assert!(!plan.workspace_root().exists());
                    for repository in &fixture.repositories {
                        assert!(!has_branch(repository));
                    }
                }
                WorktreeMaterializationProgress::RootPrepared { receipt } => {
                    assert!(receipt.workspace_root.is_dir());
                    assert!(receipt.workspace_root_created);
                    assert!(receipt.worktrees.is_empty());
                }
                WorktreeMaterializationProgress::WorktreeStarting { receipt, planned } => {
                    assert!(!planned.target_path.exists());
                    assert!(!has_branch(&planned.repository.worktree_root));
                    assert_eq!(
                            receipt.worktrees.len(),
                            events
                                .iter()
                                .filter(|event: &&serde_json::Value| event["stage"]
                                    == "worktreeCreated")
                                .count()
                        );
                }
                WorktreeMaterializationProgress::WorktreeCreated { receipt } => {
                    let created = receipt.worktrees.last().unwrap();
                    assert!(created.target_path.join("README.md").is_file());
                    assert_eq!(
                        git_text(&created.target_path, &["rev-parse", "HEAD"]),
                        created.base_commit_oid
                    );
                    assert!(has_branch(&created.source_repository));
                }
                WorktreeMaterializationProgress::Completed { receipt } => {
                    assert_eq!(receipt.worktrees.len(), 2);
                }
                WorktreeMaterializationProgress::RolledBack { .. } => {
                    panic!("successful setup cannot report rollback")
                }
            }
            events.push(serde_json::to_value(event).unwrap());
            fs::write(&journal, serde_json::to_vec(&events).unwrap())
                .map_err(|_| GitError::MaterializationObserverFailed)?;
            fs::File::open(&journal).unwrap().sync_all().unwrap();
            Ok(())
        })
        .expect("observed setup");
    let saved: Vec<serde_json::Value> =
        serde_json::from_slice(&fs::read(journal).unwrap()).unwrap();
    assert_eq!(
        saved
            .iter()
            .map(|event| event["stage"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "starting",
            "rootPrepared",
            "worktreeStarting",
            "worktreeCreated",
            "worktreeStarting",
            "worktreeCreated",
            "completed"
        ]
    );
    assert_eq!(
        saved.last().unwrap()["receipt"],
        serde_json::to_value(&receipt).unwrap()
    );
    assert!(
        GitWorktreeService::new()
            .rollback(&receipt)
            .failures
            .is_empty()
    );
}

#[test]
fn observer_storage_failure_rolls_back_only_verified_effects() {
    for failed_stage in [
        "starting",
        "rootPrepared",
        "worktreeStarting",
        "worktreeCreated",
        "completed",
    ] {
        for existing_root in [false, true] {
            let fixture = Fixture::new(1);
            if existing_root {
                fs::create_dir(&fixture.workspace).unwrap();
                fs::write(fixture.workspace.join("user.txt"), "Keep this user file.\n").unwrap();
            }
            let unavailable_journal = fixture.directory.path().join("journal-is-a-directory");
            fs::create_dir(&unavailable_journal).unwrap();
            let mut events = Vec::new();
            let error = GitWorktreeService::new()
                .materialize_observed(fixture.plan(), |event| {
                    let encoded = serde_json::to_value(event).unwrap();
                    let should_fail =
                        encoded["stage"] == failed_stage || encoded["stage"] == "rolledBack";
                    events.push(encoded);
                    if should_fail {
                        fs::write(&unavailable_journal, b"cannot persist here")
                            .map_err(|_| GitError::MaterializationObserverFailed)?;
                    }
                    Ok(())
                })
                .expect_err("storage failure must stop setup");
            assert_eq!(
                error.cause,
                GitError::MaterializationObserverFailed,
                "{failed_stage}"
            );
            assert!(!has_branch(&fixture.repositories[0]), "{failed_stage}");
            if existing_root {
                assert_eq!(
                    fs::read_to_string(fixture.workspace.join("user.txt")).unwrap(),
                    "Keep this user file.\n"
                );
                assert_eq!(fs::read_dir(&fixture.workspace).unwrap().count(), 1);
            } else {
                assert!(!fixture.workspace.exists(), "{failed_stage}");
            }
            assert!(error.rollback.failures.is_empty());
            if failed_stage == "starting" {
                assert_eq!(events.len(), 1);
            } else {
                assert_eq!(events.last().unwrap()["stage"], "rolledBack");
                assert_eq!(
                    events.last().unwrap()["rollback"],
                    serde_json::to_value(&error.rollback).unwrap()
                );
            }
        }
    }
}

#[test]
fn observer_revalidates_after_persisting_intent_and_preserves_an_unrelated_target() {
    let fixture = Fixture::new(1);
    let plan = fixture.plan();
    let target = plan.repositories()[0].target_path.clone();
    let mut last_event = serde_json::Value::Null;
    let error = GitWorktreeService::new()
        .materialize_observed(plan, |event| {
            if let WorktreeMaterializationProgress::WorktreeStarting { planned, .. } = event {
                fs::create_dir(&planned.target_path).unwrap();
                fs::write(
                    planned.target_path.join("user.txt"),
                    "Unrelated user files.\n",
                )
                .unwrap();
            }
            last_event = serde_json::to_value(event).unwrap();
            Ok(())
        })
        .expect_err("target appeared while the host saved intent");
    assert_eq!(error.cause, GitError::TargetPathConflict);
    assert!(error.rollback.attempted.is_empty());
    assert!(!has_branch(&fixture.repositories[0]));
    assert_eq!(
        fs::read_to_string(target.join("user.txt")).unwrap(),
        "Unrelated user files.\n"
    );
    assert_eq!(last_event["stage"], "rolledBack");
    assert!(
        last_event["receipt"]["worktrees"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(last_event["unconfirmedWorktree"].is_null());
}

#[test]
fn observer_records_retained_ignored_worktree_after_a_later_git_failure() {
    let fixture = Fixture::new(2);
    let plan = fixture.plan();
    let first_target = plan.repositories()[0].target_path.clone();
    let second_target = plan.repositories()[1].target_path.clone();
    let journal = fixture.directory.path().join("terminal.json");
    let mut events = Vec::new();
    let error = GitWorktreeService::new()
        .materialize_observed(plan, |event| {
            events.push(serde_json::to_value(event).unwrap());
            if let WorktreeMaterializationProgress::WorktreeCreated { receipt } = event
                && receipt.worktrees.len() == 1
            {
                fs::write(
                    first_target.join("notes.local"),
                    "Keep the ignored user notes.\n",
                )
                .unwrap();
                git(
                    &fixture.repositories[1],
                    &["branch", "wts/observed", "main"],
                );
            }
            fs::write(&journal, serde_json::to_vec(event).unwrap())
                .map_err(|_| GitError::MaterializationObserverFailed)
        })
        .expect_err("second repository branch conflict");
    assert_eq!(error.cause, GitError::BranchConflict);
    assert_eq!(error.rollback.failures.len(), 1);
    assert_eq!(
        error.rollback.failures[0].error,
        GitError::WorktreeHasIgnoredFiles
    );
    assert_eq!(
        fs::read_to_string(first_target.join("notes.local")).unwrap(),
        "Keep the ignored user notes.\n"
    );
    assert!(!second_target.exists());
    assert!(
        fixture
            .repositories
            .iter()
            .all(|repository| has_branch(repository))
    );
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(journal).unwrap()).unwrap();
    assert_eq!(saved["stage"], "rolledBack");
    assert_eq!(saved["receipt"]["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(
        saved["rollback"],
        serde_json::to_value(&error.rollback).unwrap()
    );
    assert!(saved["unconfirmedWorktree"].is_null());
    assert_eq!(
        events
            .iter()
            .filter(|event| event["stage"] == "worktreeStarting")
            .count(),
        1
    );
}

#[cfg(unix)]
#[test]
fn observer_does_not_promote_an_unverified_git_result_to_an_owned_receipt() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = Fixture::new(1);
    let plan = fixture.plan();
    let target = plan.repositories()[0].target_path.clone();
    let hook = fixture.repositories[0].join(".git/hooks/post-checkout");
    fs::write(&hook, "#!/bin/sh\nset -eu\nprintf '%s\\n' 'External replacement contents.' > README.md\nprintf '%s\\n' 'This is no longer a Git link.' > .git\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    let journal = fixture.directory.path().join("unconfirmed.json");
    let mut verified_count = 0;
    let result = GitWorktreeService::new().materialize_observed(plan, |event| {
        if matches!(
            event,
            WorktreeMaterializationProgress::WorktreeCreated { .. }
        ) {
            verified_count += 1;
        }
        fs::write(&journal, serde_json::to_vec(event).unwrap())
            .map_err(|_| GitError::MaterializationObserverFailed)
    });
    assert!(
        result.is_err(),
        "unverified checkout must not report success"
    );
    assert_eq!(verified_count, 0);
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(journal).unwrap()).unwrap();
    assert_eq!(saved["stage"], "rolledBack");
    assert!(saved["receipt"]["worktrees"].as_array().unwrap().is_empty());
    assert!(
        saved["rollback"]["attempted"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        saved["unconfirmedWorktree"]["targetPath"],
        target.to_str().unwrap()
    );
    assert_eq!(
        fs::read_to_string(target.join("README.md")).unwrap(),
        "External replacement contents.\n"
    );
    assert!(has_branch(&fixture.repositories[0]));
}

fn git(repository: &Path, args: &[&str]) {
    let result = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(args)
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

fn git_text(repository: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(args)
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert!(result.status.success());
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

fn has_branch(repository: &Path) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["show-ref", "--verify", "--quiet", "refs/heads/wts/observed"])
        .status()
        .unwrap()
        .success()
}
