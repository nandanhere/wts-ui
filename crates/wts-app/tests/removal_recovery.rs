use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{LocalWtsError, LocalWtsService, RemovalBlockerCode};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspacePlanningFolder, WorkspacePlanningFormat,
    WorkspacePlanningSelection, WorkspaceProvider, WorkspaceRepositoryRequest,
};

struct Fixture {
    _directory: TempDir,
    service: LocalWtsService,
    workspace_id: Uuid,
    workspace: PathBuf,
    worktrees: Vec<PathBuf>,
    branch: String,
}

fn git(path: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .arg("-C")
        .arg(path)
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().to_owned()
}

impl Fixture {
    fn new() -> Self {
        Self::with_planning(None)
    }

    fn with_planning(planning: Option<WorkspacePlanningSelection>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        for label in ["api", "web"] {
            let repository = repositories.join(label);
            fs::create_dir_all(&repository).unwrap();
            git(&repository, &["init", "--initial-branch=main"]);
            git(&repository, &["config", "user.name", "WTS Test"]);
            git(
                &repository,
                &["config", "user.email", "wts@example.invalid"],
            );
            fs::write(repository.join("README.md"), "Keep this commit.\n").unwrap();
            git(&repository, &["add", "README.md"]);
            git(&repository, &["commit", "-m", "Initial"]);
        }
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
                        label: "Removal recovery".to_owned(),
                    },
                    title: "Removal recovery".to_owned(),
                    preferred_provider: WorkspaceProvider::Codex,
                    repositories: ["api", "web"]
                        .into_iter()
                        .map(|label| WorkspaceRepositoryRequest {
                            repository_id: None,
                            label: label.to_owned(),
                            base_ref: "main".to_owned(),
                        })
                        .collect(),
                    runtime: None,
                    planning,
                },
            )
            .unwrap()
            .workspace
            .workspace_id;
        let preflight = service.preflight_workspace(workspace_id).unwrap();
        let receipt = service
            .materialize_workspace(workspace_id, &preflight.effect_digest)
            .unwrap()
            .materialization;
        Self {
            _directory: directory,
            service,
            workspace_id,
            workspace: receipt.workspace_display_path.into(),
            worktrees: receipt
                .worktrees
                .iter()
                .map(|tree| PathBuf::from(&tree.target_display_path))
                .collect(),
            branch: receipt.branch_name,
        }
    }
}

#[cfg(unix)]
#[test]
fn unsafe_planning_entry_returns_a_specific_blocker_instead_of_losing_preflight() {
    let fixture = Fixture::with_planning(Some(WorkspacePlanningSelection {
        folder: WorkspacePlanningFolder::Plans,
        format: WorkspacePlanningFormat::Notes,
    }));
    let outside = fixture._directory.path().join("private-notes");
    fs::write(&outside, "Keep outside content.\n").unwrap();
    let link = fixture.workspace.join("plans/linked-notes.md");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let preflight = fixture
        .service
        .preflight_workspace_removal(fixture.workspace_id)
        .expect("a blocked preflight remains reviewable");
    let blocker = preflight
        .blockers
        .iter()
        .find(|blocker| blocker.code == RemovalBlockerCode::UnexpectedPath)
        .unwrap();
    let json = serde_json::to_value(blocker).unwrap();
    assert_eq!(json["displayPath"], link.to_str().unwrap());
    assert!(json["observed"].as_str().unwrap().contains("symbolic link"));
    assert!(matches!(
        fixture.service.remove_workspace(
            fixture.workspace_id,
            &preflight.effect_digest,
            &Uuid::new_v4().to_string(),
            true
        ),
        Err(LocalWtsError::RemovalBlocked { .. })
    ));
    assert_eq!(
        fs::read_to_string(outside).unwrap(),
        "Keep outside content.\n"
    );
}

#[cfg(unix)]
#[test]
fn replaced_workspace_root_stays_blocked_with_its_recorded_path() {
    let fixture = Fixture::new();
    let moved = fixture
        .workspace
        .parent()
        .unwrap()
        .join("preserved-workspace");
    fs::rename(&fixture.workspace, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &fixture.workspace).unwrap();
    let preflight = fixture
        .service
        .preflight_workspace_removal(fixture.workspace_id)
        .unwrap();
    assert!(!preflight.ready);
    let json = serde_json::to_value(&preflight.blockers[0]).unwrap();
    assert_eq!(json["displayPath"], fixture.workspace.to_str().unwrap());
    assert!(matches!(
        fixture.service.remove_workspace(
            fixture.workspace_id,
            &preflight.effect_digest,
            &Uuid::new_v4().to_string(),
            true
        ),
        Err(LocalWtsError::RemovalBlocked { .. })
    ));
    assert!(moved.join(".wts-workspace.json").is_file());
}

#[test]
fn removes_reconciled_worktrees_on_their_recorded_branches() {
    let fixture = Fixture::new();
    for (index, path) in fixture.worktrees.iter().enumerate() {
        git(path, &["switch", "-c", &format!("feature/review-{index}")]);
    }
    let receipt = fixture
        .service
        .reconcile_workspace(fixture.workspace_id)
        .unwrap();
    let preflight = fixture
        .service
        .preflight_workspace_removal(fixture.workspace_id)
        .unwrap();
    assert!(preflight.ready, "{:?}", preflight.blockers);
    assert_eq!(
        preflight.retained_branches,
        receipt
            .worktrees
            .iter()
            .map(|tree| tree.branch_name.clone())
            .collect::<Vec<_>>()
    );
    let result = fixture
        .service
        .remove_workspace(
            fixture.workspace_id,
            &preflight.effect_digest,
            &Uuid::new_v4().to_string(),
            false,
        )
        .unwrap();
    assert_eq!(result.removed_worktree_count, 2);
    assert!(!fixture.workspace.exists());
    for (index, label) in ["api", "web"].into_iter().enumerate() {
        let source = fixture._directory.path().join("repositories").join(label);
        assert!(
            !git(
                &source,
                &["rev-parse", &format!("refs/heads/feature/review-{index}")]
            )
            .is_empty()
        );
    }
}

#[test]
fn branch_drift_reports_the_path_and_branch_without_duplicate_unknown_path() {
    let fixture = Fixture::new();
    git(
        &fixture.worktrees[0],
        &["switch", "-c", "feature/unrecorded"],
    );
    let preflight = fixture
        .service
        .preflight_workspace_removal(fixture.workspace_id)
        .unwrap();
    assert!(!preflight.ready);
    let blocker = preflight
        .blockers
        .iter()
        .find(|blocker| blocker.code == RemovalBlockerCode::WorkspaceDrift)
        .unwrap();
    let json = serde_json::to_value(blocker).unwrap();
    assert_eq!(json["displayPath"], fixture.worktrees[0].to_str().unwrap());
    assert_eq!(json["expected"], fixture.branch);
    assert_eq!(json["observed"], "feature/unrecorded");
    assert!(!json["recoverySteps"].as_array().unwrap().is_empty());
    assert!(
        !preflight
            .blockers
            .iter()
            .any(|blocker| blocker.code == RemovalBlockerCode::UnexpectedPath)
    );
    assert!(matches!(
        fixture.service.remove_workspace(
            fixture.workspace_id,
            &preflight.effect_digest,
            &Uuid::new_v4().to_string(),
            true
        ),
        Err(LocalWtsError::RemovalBlocked { .. })
    ));
    assert!(fixture.worktrees.iter().all(|path| path.is_dir()));
}

#[test]
fn unknown_root_entry_reports_its_path_and_preserves_all_files() {
    let fixture = Fixture::new();
    let unknown = fixture.workspace.join("notes from review.txt");
    fs::write(&unknown, "Keep these notes.\n").unwrap();
    let preflight = fixture
        .service
        .preflight_workspace_removal(fixture.workspace_id)
        .unwrap();
    let blocker = preflight
        .blockers
        .iter()
        .find(|blocker| blocker.code == RemovalBlockerCode::UnexpectedPath)
        .unwrap();
    let json = serde_json::to_value(blocker).unwrap();
    assert_eq!(json["displayPath"], unknown.to_str().unwrap());
    assert!(
        json["recoverySteps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step.as_str().unwrap().contains("outside"))
    );
    assert!(matches!(
        fixture.service.remove_workspace(
            fixture.workspace_id,
            &preflight.effect_digest,
            &Uuid::new_v4().to_string(),
            true
        ),
        Err(LocalWtsError::RemovalBlocked { .. })
    ));
    assert_eq!(fs::read_to_string(unknown).unwrap(), "Keep these notes.\n");
}

#[cfg(unix)]
#[test]
fn replaced_worktree_link_reports_its_path_and_does_not_follow_the_link() {
    let fixture = Fixture::new();
    let moved = fixture
        .workspace
        .parent()
        .unwrap()
        .join("preserved-worktree");
    fs::rename(&fixture.worktrees[0], &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &fixture.worktrees[0]).unwrap();
    let preflight = fixture
        .service
        .preflight_workspace_removal(fixture.workspace_id)
        .unwrap();
    let blocker = preflight
        .blockers
        .iter()
        .find(|blocker| {
            blocker.code == RemovalBlockerCode::WorkspaceDrift
                && blocker.repository_label.as_deref() == Some("api")
        })
        .unwrap();
    let json = serde_json::to_value(blocker).unwrap();
    assert_eq!(json["displayPath"], fixture.worktrees[0].to_str().unwrap());
    assert!(json["observed"].as_str().unwrap().contains("symbolic link"));
    assert!(matches!(
        fixture.service.remove_workspace(
            fixture.workspace_id,
            &preflight.effect_digest,
            &Uuid::new_v4().to_string(),
            true
        ),
        Err(LocalWtsError::RemovalBlocked { .. })
    ));
    assert!(moved.join("README.md").is_file());
}
