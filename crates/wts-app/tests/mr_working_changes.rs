#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{
    LocalWtsService, WorkspaceGitlabComparisonStatus, WorkspaceRepositorySourceSaveRequest,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

struct Fixture {
    _directory: TempDir,
    service: LocalWtsService,
    workspace_id: Uuid,
    repository_id: String,
    worktree: PathBuf,
    base: String,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        let source = repositories.join("api");
        fs::create_dir_all(&source).unwrap();
        git(&source, &["init", "--initial-branch=main"]);
        git(&source, &["config", "user.name", "WTS Test"]);
        git(&source, &["config", "user.email", "wts@example.invalid"]);
        git(&source, &["config", "commit.gpgSign", "false"]);
        fs::write(source.join("README.md"), "base\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);
        let base = git(&source, &["rev-parse", "HEAD"]);
        git(
            &source,
            &[
                "remote",
                "add",
                "origin",
                "https://gitlab.example.test/catalog/api.git",
            ],
        );
        git(
            &source,
            &[
                "remote",
                "add",
                "upstream",
                "https://gitlab.example.test/trusted/api.git",
            ],
        );
        git(
            &source,
            &["update-ref", "refs/remotes/upstream/main", "HEAD"],
        );
        git(&source, &["config", "branch.main.remote", "upstream"]);
        git(&source, &["config", "branch.main.merge", "refs/heads/main"]);
        let service = LocalWtsService::open(
            directory.path().join("data"),
            "test",
            directory.path().join("workspaces"),
            &repositories,
        )
        .unwrap();
        let workspace_id = service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::RepositorySet {
                        label: "MR working changes".to_owned(),
                    },
                    title: "MR working changes".to_owned(),
                    preferred_provider: WorkspaceProvider::Codex,
                    repositories: vec![WorkspaceRepositoryRequest {
                        repository_id: None,
                        label: "api".to_owned(),
                        base_ref: "main".to_owned(),
                    }],
                    runtime: None,
                    planning: None,
                },
            )
            .unwrap()
            .workspace
            .workspace_id;
        let preflight = service.preflight_workspace(workspace_id).unwrap();
        let materialized = service
            .materialize_workspace(workspace_id, &preflight.effect_digest)
            .unwrap();
        let worktree = &materialized.materialization.worktrees[0];
        Self {
            _directory: directory,
            service,
            workspace_id,
            repository_id: worktree.repository_id.clone(),
            worktree: PathBuf::from(&worktree.target_display_path),
            base,
        }
    }

    fn commit(&self, content: &str) -> String {
        fs::write(self.worktree.join("README.md"), content).unwrap();
        git(&self.worktree, &["add", "README.md"]);
        git(&self.worktree, &["commit", "-m", "Change"]);
        git(&self.worktree, &["rev-parse", "HEAD"])
    }
}

fn git(repository: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(args)
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[test]
fn source_saves_follow_local_commits_and_reject_stale_content() {
    let fixture = Fixture::new();
    fixture.commit("base\nagent commit\n");
    let source = fixture
        .service
        .workspace_repository_source(fixture.workspace_id, &fixture.repository_id, "README.md")
        .unwrap();
    assert_eq!(source.content, "base\nagent commit\n");
    assert!(source.revision.starts_with("sha256:"));
    fs::write(fixture.worktree.join("README.md"), "new agent edit\n").unwrap();
    let stale = fixture.service.save_workspace_repository_source(
        fixture.workspace_id,
        &fixture.repository_id,
        WorkspaceRepositorySourceSaveRequest {
            file_path: "README.md".to_owned(),
            content: "stale user edit\n".to_owned(),
            expected_revision: source.revision,
        },
    );
    assert!(stale.is_err());
    assert_eq!(
        fs::read_to_string(fixture.worktree.join("README.md")).unwrap(),
        "new agent edit\n"
    );
    let current = fixture
        .service
        .workspace_repository_source(fixture.workspace_id, &fixture.repository_id, "README.md")
        .unwrap();
    let saved = fixture
        .service
        .save_workspace_repository_source(
            fixture.workspace_id,
            &fixture.repository_id,
            WorkspaceRepositorySourceSaveRequest {
                file_path: "README.md".to_owned(),
                content: "user edit 😀\r\n".to_owned(),
                expected_revision: current.revision,
            },
        )
        .unwrap();
    assert_eq!(saved.content, "user edit 😀\r\n");
    assert_eq!(
        fs::read_to_string(fixture.worktree.join("README.md")).unwrap(),
        saved.content
    );
    assert_eq!(
        git(&fixture.worktree, &["show", "HEAD:README.md"]),
        "base\nagent commit"
    );
    fs::remove_file(fixture.worktree.join("README.md")).unwrap();
    assert!(
        fixture
            .service
            .save_workspace_repository_source(
                fixture.workspace_id,
                &fixture.repository_id,
                WorkspaceRepositorySourceSaveRequest {
                    file_path: "README.md".to_owned(),
                    content: "recreate".to_owned(),
                    expected_revision: saved.revision,
                }
            )
            .is_err()
    );
    assert!(!fixture.worktree.join("README.md").exists());
}

#[test]
fn source_access_remains_bound_to_the_managed_worktree() {
    let fixture = Fixture::new();
    let source = fixture
        .service
        .workspace_repository_source(fixture.workspace_id, &fixture.repository_id, "README.md")
        .unwrap();
    let outside = fixture._directory.path().join("outside.txt");
    fs::write(&outside, "outside\n").unwrap();
    fs::remove_file(fixture.worktree.join("README.md")).unwrap();
    std::os::unix::fs::symlink(&outside, fixture.worktree.join("README.md")).unwrap();
    assert!(
        fixture
            .service
            .workspace_repository_source(fixture.workspace_id, &fixture.repository_id, "README.md")
            .is_err()
    );
    assert!(
        fixture
            .service
            .save_workspace_repository_source(
                fixture.workspace_id,
                &fixture.repository_id,
                WorkspaceRepositorySourceSaveRequest {
                    file_path: "README.md".to_owned(),
                    content: "overwrite".to_owned(),
                    expected_revision: source.revision,
                }
            )
            .is_err()
    );
    assert_eq!(fs::read_to_string(&outside).unwrap(), "outside\n");
    for path in ["../outside.txt", ".git", ".git/config"] {
        assert!(
            fixture
                .service
                .workspace_repository_source(fixture.workspace_id, &fixture.repository_id, path)
                .is_err()
        );
    }
    assert!(
        fixture
            .service
            .workspace_repository_source(fixture.workspace_id, "other", "README.md")
            .is_err()
    );
    git(&fixture.worktree, &["checkout", "-b", "unexpected"]);
    assert!(
        fixture
            .service
            .workspace_repository_source(fixture.workspace_id, &fixture.repository_id, "README.md")
            .is_err()
    );
}

#[test]
fn mr_comparisons_use_one_trusted_published_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("glab");
    fs::write(
        &executable,
        r#"#!/bin/sh
set -eu
root="$WTS_TEST_MR_WORKING_ROOT"
printf '%s\n' "$4" >> "$root/endpoints"
case "$4" in
 /user) printf '{"id":1,"username":"alice"}' ;;
 /projects/trusted%2Fapi/merge_requests/17/changes) cat "$root/mr.json" ;;
 *) exit 31 ;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut paths = vec![directory.path().to_path_buf()];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "trusted_mr_comparison_child", "--nocapture"])
        .env("WTS_TEST_MR_WORKING_ROOT", directory.path())
        .env("PATH", std::env::join_paths(paths).unwrap())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn trusted_mr_comparison_child() {
    let Some(root) = std::env::var_os("WTS_TEST_MR_WORKING_ROOT").map(PathBuf::from) else {
        return;
    };
    let fixture = Fixture::new();
    let published = fixture.commit("base\npublished\n");
    let branch = git(&fixture.worktree, &["branch", "--show-current"]);
    let mut metadata = serde_json::json!({
        "id": 77, "iid": 17, "title": "Change", "web_url": "https://gitlab.example.test/trusted/api/-/merge_requests/17",
        "state": "opened", "source_branch": branch, "target_branch": "main", "author": {"username":"alice"}, "updated_at":"2026-09-17T00:00:00Z",
        "diff_refs": { "base_sha": fixture.base, "start_sha": fixture.base, "head_sha": published },
        "changes": [{ "old_path":"README.md", "new_path":"README.md", "new_file":false, "deleted_file":false, "renamed_file":false,
            "diff":"@@ -1 +1,2 @@\n base\n+published\n" }], "overflow": false,
    });
    let write_metadata = |value: &serde_json::Value| {
        fs::write(root.join("mr.json"), serde_json::to_vec(value).unwrap()).unwrap()
    };
    write_metadata(&metadata);
    let local_head = fixture.commit("base\npublished\ncommitted\n");
    fs::write(
        fixture.worktree.join("README.md"),
        "base\npublished\ncommitted\nstaged\n",
    )
    .unwrap();
    git(&fixture.worktree, &["add", "README.md"]);
    fs::write(
        fixture.worktree.join("README.md"),
        "base\npublished\ncommitted\nstaged\nunstaged\n",
    )
    .unwrap();
    fs::write(fixture.worktree.join("new.ts"), "untracked\n").unwrap();
    let result = fixture
        .service
        .workspace_gitlab_comparison(fixture.workspace_id, &fixture.repository_id, 17, true)
        .unwrap();
    assert_eq!(result.status, WorkspaceGitlabComparisonStatus::Ready);
    assert_eq!(result.local_head_commit_oid, local_head);
    assert_eq!(result.published.head_commit_oid, published);
    let latest = result.latest_work.unwrap();
    let since = result.since_mr.unwrap();
    assert_eq!(latest.base_commit_oid, fixture.base);
    assert_eq!(since.base_commit_oid, published);
    for line in ["+committed", "+staged", "+unstaged", "+untracked"] {
        assert!(latest.patch.contains(line), "{}", latest.patch);
        assert!(since.patch.contains(line), "{}", since.patch);
        assert!(!result.published.patch.contains(line));
    }
    assert!(latest.patch.contains("+published"));
    assert!(!since.patch.contains("+published"));
    assert!(since.untracked_paths.contains(&"new.ts".to_owned()));
    let endpoints = fs::read_to_string(root.join("endpoints")).unwrap();
    assert_eq!(
        endpoints
            .lines()
            .filter(|line| line.ends_with("/changes"))
            .count(),
        1
    );
    assert!(!endpoints.contains("catalog%2Fapi"));

    metadata["source_branch"] = serde_json::json!("other");
    write_metadata(&metadata);
    assert!(
        fixture
            .service
            .workspace_gitlab_comparison(fixture.workspace_id, &fixture.repository_id, 17, true)
            .is_err()
    );
    metadata["source_branch"] = serde_json::json!(branch);
    metadata["web_url"] =
        serde_json::json!("https://gitlab.example.test/other/api/-/merge_requests/17");
    write_metadata(&metadata);
    assert!(
        fixture
            .service
            .workspace_gitlab_comparison(fixture.workspace_id, &fixture.repository_id, 17, true)
            .is_err()
    );
    metadata["web_url"] =
        serde_json::json!("https://gitlab.example.test/trusted/api/-/merge_requests/17");
    metadata["diff_refs"]["head_sha"] = serde_json::json!("f".repeat(40));
    write_metadata(&metadata);
    let missing = fixture
        .service
        .workspace_gitlab_comparison(fixture.workspace_id, &fixture.repository_id, 17, true)
        .unwrap();
    assert_eq!(
        missing.status,
        WorkspaceGitlabComparisonStatus::MissingCommits
    );
    assert!(missing.latest_work.is_none() && missing.since_mr.is_none());
    metadata["diff_refs"]["head_sha"] = serde_json::json!(local_head);
    write_metadata(&metadata);
    git(&fixture.worktree, &["reset", "--hard", &published]);
    let diverged = fixture
        .service
        .workspace_gitlab_comparison(fixture.workspace_id, &fixture.repository_id, 17, true)
        .unwrap();
    assert_eq!(diverged.status, WorkspaceGitlabComparisonStatus::Diverged);
    assert!(diverged.latest_work.is_none() && diverged.since_mr.is_none());
}
