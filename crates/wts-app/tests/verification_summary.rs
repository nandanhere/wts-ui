use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{LocalWtsError, LocalWtsService, VerificationStatus};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

struct Fixture {
    directory: TempDir,
    service: LocalWtsService,
    workspace_id: Uuid,
    workspace: PathBuf,
}

impl Fixture {
    fn new(materialized: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        let repository = repositories.join("api");
        fs::create_dir_all(&repository).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "Fixture"],
            vec!["config", "user.email", "fixture@example.test"],
            vec!["config", "commit.gpgsign", "false"],
            vec!["config", "core.hooksPath", "/dev/null"],
        ] {
            assert!(
                Command::new("git")
                    .current_dir(&repository)
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        fs::write(repository.join("README.md"), "# Verification fixture\n").unwrap();
        for args in [vec!["add", "README.md"], vec!["commit", "-m", "Fixture"]] {
            assert!(
                Command::new("git")
                    .current_dir(&repository)
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        let service = LocalWtsService::open(
            directory.path().join("data"),
            "summary-test",
            directory.path().join("workspaces"),
            &repositories,
        )
        .unwrap();
        let workspace = service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::RepositorySet {
                        label: "summary".into(),
                    },
                    title: "Saved verification".into(),
                    preferred_provider: WorkspaceProvider::Codex,
                    repositories: vec![WorkspaceRepositoryRequest {
                        repository_id: None,
                        label: "api".into(),
                        base_ref: "main".into(),
                    }],
                    runtime: None,
                    planning: None,
                },
            )
            .unwrap()
            .workspace;
        if materialized {
            let preflight = service.preflight_workspace(workspace.workspace_id).unwrap();
            assert!(preflight.ready);
            service
                .materialize_workspace(workspace.workspace_id, &preflight.effect_digest)
                .unwrap();
        }
        Self {
            directory,
            service,
            workspace_id: workspace.workspace_id,
            workspace: PathBuf::from(workspace.workspace_display_path),
        }
    }
}

#[test]
fn saved_verification_summary_distinguishes_unknown_and_unmaterialized_workspaces() {
    let fixture = Fixture::new(false);
    assert!(
        fixture
            .service
            .get_workspace_verification_summary(fixture.workspace_id)
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        fixture
            .service
            .get_workspace_verification_summary(Uuid::new_v4()),
        Err(LocalWtsError::WorkspaceNotFound)
    ));
}

#[test]
fn saved_verification_summary_reads_only_bounded_verification_files() {
    let fixture = Fixture::new(true);
    let evidence = fixture.workspace.join(".wts");
    let first = fixture
        .service
        .get_workspace_verification_summary(fixture.workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(first.verification_result.status, VerificationStatus::NotRun);
    fs::write(evidence.join("graph-manifest.json"), "invalid graph data").unwrap();
    fs::write(
        evidence.join("agent-runs/not-a-run.json"),
        "invalid agent data",
    )
    .unwrap();
    fs::remove_file(evidence.join("agent-report.json")).unwrap();
    let summary = fixture
        .service
        .get_workspace_verification_summary(fixture.workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(summary, first);
    assert!(!evidence.join("agent-report.json").exists());
    assert_eq!(
        fs::read_to_string(evidence.join("agent-runs/not-a-run.json")).unwrap(),
        "invalid agent data"
    );
    let wire = serde_json::to_value(summary).unwrap();
    assert_eq!(wire.as_object().unwrap().len(), 5);
    assert!(wire.get("agentRuns").is_none());
}

#[test]
fn saved_verification_summary_rejects_mismatched_context_and_result_identity() {
    let fixture = Fixture::new(true);
    let evidence = fixture.workspace.join(".wts");
    for leaf in [
        "context.json",
        "verification-plan.json",
        "verification-result.json",
    ] {
        let path = evidence.join(leaf);
        let original = fs::read(&path).unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&original).unwrap();
        value["workspaceId"] = serde_json::json!(Uuid::new_v4());
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            matches!(
                fixture
                    .service
                    .get_workspace_verification_summary(fixture.workspace_id),
                Err(LocalWtsError::InvalidWorkspaceEvidence)
            ),
            "{leaf}"
        );
        fs::write(path, original).unwrap();
    }
    fs::write(
        evidence.join("verification-result.json"),
        vec![b' '; 512 * 1024 + 1],
    )
    .unwrap();
    assert!(matches!(
        fixture
            .service
            .get_workspace_verification_summary(fixture.workspace_id),
        Err(LocalWtsError::InvalidWorkspaceEvidence)
    ));
}

#[test]
fn saved_verification_summary_preserves_old_plan_history_and_rejects_foreign_history() {
    let fixture = Fixture::new(true);
    let evidence = fixture.workspace.join(".wts");
    let mut result: serde_json::Value =
        serde_json::from_slice(&fs::read(evidence.join("verification-result.json")).unwrap())
            .unwrap();
    result["status"] = serde_json::json!("failed");
    result["startedAtUnixMs"] = serde_json::json!(100);
    result["completedAtUnixMs"] = serde_json::json!(120);
    result["planRevision"] = serde_json::json!(42);
    fs::write(
        evidence.join("verification-history.json"),
        serde_json::to_vec(&vec![result.clone()]).unwrap(),
    )
    .unwrap();
    let summary = fixture
        .service
        .get_workspace_verification_summary(fixture.workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(summary.verification_history[0].plan_revision, 42);
    assert_eq!(
        summary.verification_history[0].status,
        VerificationStatus::Failed
    );
    result["workspaceId"] = serde_json::json!(Uuid::new_v4());
    fs::write(
        evidence.join("verification-history.json"),
        serde_json::to_vec(&vec![result]).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        fixture
            .service
            .get_workspace_verification_summary(fixture.workspace_id),
        Err(LocalWtsError::InvalidWorkspaceEvidence)
    ));
}

#[cfg(unix)]
#[test]
fn saved_verification_summary_rejects_symlinked_context_and_evidence_root() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new(true);
    let evidence = fixture.workspace.join(".wts");
    let context = evidence.join("context.json");
    let copied = fixture.directory.path().join("context.json");
    fs::rename(&context, &copied).unwrap();
    symlink(&copied, &context).unwrap();
    assert!(matches!(
        fixture
            .service
            .get_workspace_verification_summary(fixture.workspace_id),
        Err(LocalWtsError::InvalidWorkspaceEvidence)
    ));
    fs::remove_file(&context).unwrap();
    fs::rename(copied, context).unwrap();
    let history = evidence.join("verification-history.json");
    fs::remove_file(&history).unwrap();
    symlink(fixture.directory.path().join("missing-history"), &history).unwrap();
    assert!(matches!(
        fixture
            .service
            .get_workspace_verification_summary(fixture.workspace_id),
        Err(LocalWtsError::InvalidWorkspaceEvidence)
    ));
    fs::remove_file(&history).unwrap();
    fs::write(history, "[]").unwrap();
    let moved = fixture.directory.path().join("evidence");
    fs::rename(&evidence, &moved).unwrap();
    symlink(moved, evidence).unwrap();
    assert!(matches!(
        fixture
            .service
            .get_workspace_verification_summary(fixture.workspace_id),
        Err(LocalWtsError::InvalidWorkspaceEvidence)
    ));
}

#[cfg(unix)]
#[test]
fn saved_verification_summary_starts_zero_git_processes() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new(true);
    let bin = fixture.directory.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let marker = fixture.directory.path().join("git-started");
    let git = bin.join("git");
    fs::write(
        &git,
        "#!/bin/sh\nprintf called >> \"$WTS_SUMMARY_GIT_MARKER\"\nexit 71\n",
    )
    .unwrap();
    fs::set_permissions(&git, fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "saved_verification_summary_process_child",
            "--nocapture",
        ])
        .env("WTS_SUMMARY_FIXTURE", fixture.directory.path())
        .env("WTS_SUMMARY_WORKSPACE", fixture.workspace_id.to_string())
        .env("WTS_SUMMARY_GIT_MARKER", &marker)
        .env(
            "PATH",
            format!(
                "{}:{}",
                bin.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        marker.exists(),
        "The authoritative read must exercise the Git process control."
    );
}

#[test]
fn saved_verification_summary_process_child() {
    let Ok(root) = std::env::var("WTS_SUMMARY_FIXTURE") else {
        return;
    };
    let root = Path::new(&root);
    let workspace_id = std::env::var("WTS_SUMMARY_WORKSPACE")
        .unwrap()
        .parse()
        .unwrap();
    let marker = PathBuf::from(std::env::var("WTS_SUMMARY_GIT_MARKER").unwrap());
    let service = LocalWtsService::open(
        root.join("data"),
        "summary-test",
        root.join("workspaces"),
        root.join("repositories"),
    )
    .unwrap();
    let summary = service
        .get_workspace_verification_summary(workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(summary.workspace_id, workspace_id);
    assert!(!marker.exists(), "The saved summary must not run Git.");
    assert!(service.get_workspace_evidence(workspace_id).is_err());
    assert!(
        marker.exists(),
        "The existing authoritative path still runs Git."
    );
}
