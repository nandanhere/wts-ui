use super::*;
use std::{cell::RefCell, process::Command};
use wts_core::workspace::{WorkspacePlanningFolder, WorkspaceProvider, WorkspaceRepositoryRequest};

#[derive(Clone, Copy, PartialEq)]
pub(super) enum MaterializationStage {
    AfterGitReceipt,
    BeforeReviewInbox,
    AfterManifestPublication,
}

type Hook = Box<dyn FnOnce(&Path) -> Result<(), LocalWtsError>>;
thread_local! {
    static HOOK: RefCell<Option<(MaterializationStage, Hook)>> = RefCell::new(None);
}

pub(super) fn run_materialization_test_hook(
    stage: MaterializationStage,
    workspace: &Path,
) -> Result<(), LocalWtsError> {
    let hook = HOOK.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot
            .as_ref()
            .is_some_and(|(expected, _)| *expected == stage)
        {
            slot.take().map(|(_, hook)| hook)
        } else {
            None
        }
    });
    hook.map_or(Ok(()), |hook| hook(workspace))
}

struct ResetHook;
impl Drop for ResetHook {
    fn drop(&mut self) {
        HOOK.with(|slot| slot.borrow_mut().take());
    }
}

fn fail_at(stage: MaterializationStage, hook: impl FnOnce(&Path) + 'static) -> ResetHook {
    HOOK.with(|slot| {
        *slot.borrow_mut() = Some((
            stage,
            Box::new(|path| {
                hook(path);
                Err(LocalWtsError::InvalidMaterializationManifest)
            }),
        ));
    });
    ResetHook
}

struct Fixture {
    _temp: tempfile::TempDir,
    service: LocalWtsService,
    repository: PathBuf,
    repositories: PathBuf,
    workspaces: PathBuf,
    data: PathBuf,
    workspace_id: Uuid,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let repositories = root.join("repositories");
        let repository = repositories.join("fixture");
        fs::create_dir_all(&repository).unwrap();
        git(&repository, &["init", "--initial-branch=main"]);
        git(&repository, &["config", "user.name", "WTS test"]);
        git(&repository, &["config", "user.email", "wts@example.test"]);
        fs::write(repository.join("README.md"), "# Fixture\n").unwrap();
        git(&repository, &["add", "README.md"]);
        git(&repository, &["commit", "-m", "Fixture"]);
        let workspaces = root.join("workspaces");
        let data = root.join("data");
        let service = LocalWtsService::open(&data, "fixture", &workspaces, &repositories).unwrap();
        let workspace_id = service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::RepositorySet {
                        label: "rollback".into(),
                    },
                    title: "Rollback fixture".into(),
                    preferred_provider: WorkspaceProvider::Codex,
                    repositories: vec![WorkspaceRepositoryRequest {
                        repository_id: None,
                        label: "fixture".into(),
                        base_ref: "main".into(),
                    }],
                    runtime: None,
                    planning: Some(WorkspacePlanningSelection {
                        folder: WorkspacePlanningFolder::Plans,
                        format: WorkspacePlanningFormat::Notes,
                    }),
                },
            )
            .unwrap()
            .workspace
            .workspace_id;
        Self {
            _temp: temp,
            service,
            repository,
            repositories,
            workspaces,
            data,
            workspace_id,
        }
    }

    fn assert_git_clean(&self, branch: &str) {
        assert!(git(&self.repository, &["status", "--porcelain"]).is_empty());
        assert_eq!(git(&self.repository, &["branch", "--show-current"]), "main");
        assert!(git(&self.repository, &["branch", "--list", branch]).is_empty());
        assert_eq!(
            git(&self.repository, &["worktree", "list", "--porcelain"])
                .lines()
                .filter(|line| line.starts_with("worktree "))
                .count(),
            1
        );
    }
}

fn git(repository: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[test]
fn materialization_rollback_covers_early_and_final_failures_and_reopens_for_retry() {
    for stage in [
        MaterializationStage::AfterGitReceipt,
        MaterializationStage::BeforeReviewInbox,
    ] {
        let fixture = Fixture::new();
        let preflight = fixture
            .service
            .preflight_workspace(fixture.workspace_id)
            .unwrap();
        assert!(preflight.ready, "{:?}", preflight.blockers);
        let _hook = fail_at(stage, |_| {});
        let result = fixture
            .service
            .materialize_workspace(fixture.workspace_id, &preflight.effect_digest);
        assert!(
            matches!(
                result,
                Err(LocalWtsError::GeneratedFileFailed {
                    cleanup_complete: true
                })
            ),
            "{result:?}"
        );
        assert!(!Path::new(&preflight.workspace_display_path).exists());
        fixture.assert_git_clean(&preflight.branch_name);
        assert!(
            fixture
                .service
                .get_materialization(fixture.workspace_id)
                .unwrap()
                .is_none()
        );
        let reopened = LocalWtsService::open(
            &fixture.data,
            "fixture",
            &fixture.workspaces,
            &fixture.repositories,
        )
        .unwrap();
        let retry = reopened.preflight_workspace(fixture.workspace_id).unwrap();
        assert!(retry.ready, "{:?}", retry.blockers);
        let result = reopened
            .materialize_workspace(fixture.workspace_id, &retry.effect_digest)
            .unwrap();
        assert!(!result.replayed);
        assert!(
            Path::new(&result.materialization.workspace_display_path)
                .join(".wts/review-inbox.json")
                .is_file()
        );
    }
}

#[test]
fn materialization_rollback_keeps_files_edited_during_setup_without_a_success_receipt() {
    let fixture = Fixture::new();
    let preflight = fixture
        .service
        .preflight_workspace(fixture.workspace_id)
        .unwrap();
    let _hook = fail_at(MaterializationStage::BeforeReviewInbox, |root| {
        fs::write(root.join("WTS.md"), "User instructions\n").unwrap();
        fs::write(root.join("plans/PLAN.md"), "User plan\n").unwrap();
        fs::write(root.join("unknown.txt"), "External work\n").unwrap();
    });
    let result = fixture
        .service
        .materialize_workspace(fixture.workspace_id, &preflight.effect_digest);
    assert!(
        matches!(
            result,
            Err(LocalWtsError::GeneratedFileFailed {
                cleanup_complete: false
            })
        ),
        "{result:?}"
    );
    let root = Path::new(&preflight.workspace_display_path);
    assert_eq!(
        fs::read_to_string(root.join("WTS.md")).unwrap(),
        "User instructions\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("plans/PLAN.md")).unwrap(),
        "User plan\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("unknown.txt")).unwrap(),
        "External work\n"
    );
    for leaf in [
        ".wts-workspace.json",
        "CLAUDE.md",
        ".cursorrules",
        "AGENTS.md",
        ".github",
        ".wts",
    ] {
        assert!(!root.join(leaf).exists(), "{leaf} must not remain");
    }
    fixture.assert_git_clean(&preflight.branch_name);
    assert!(
        fixture
            .service
            .get_materialization(fixture.workspace_id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn setup_crash_child() {
    let Ok(encoded) = std::env::var("WTS_SETUP_CRASH_FIXTURE") else {
        return;
    };
    let fixture: serde_json::Value = serde_json::from_str(&encoded).unwrap();
    let service = LocalWtsService::open(
        fixture["data"].as_str().unwrap(),
        "fixture",
        fixture["workspaces"].as_str().unwrap(),
        fixture["repositories"].as_str().unwrap(),
    )
    .unwrap();
    let workspace_id = Uuid::parse_str(fixture["workspaceId"].as_str().unwrap()).unwrap();
    let marker = PathBuf::from(fixture["marker"].as_str().unwrap());
    let stage = match fixture["stage"].as_str().unwrap() {
        "git" => MaterializationStage::AfterGitReceipt,
        "success" => MaterializationStage::AfterManifestPublication,
        _ => MaterializationStage::BeforeReviewInbox,
    };
    let _hook = fail_at(stage, move |_| {
        fs::write(marker, b"checkpoint").unwrap();
        loop {
            std::thread::sleep(Duration::from_millis(25));
        }
    });
    let preflight = service.preflight_workspace(workspace_id).unwrap();
    service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .unwrap();
    panic!("The parent must stop this fixture at its checkpoint.");
}

fn crash_setup(fixture: &Fixture, stage: &str) -> WorkspacePreflight {
    let preflight = fixture
        .service
        .preflight_workspace(fixture.workspace_id)
        .unwrap();
    let marker = fixture.data.join("crash-checkpoint");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "service::materialization_rollback_tests::setup_crash_child",
            "--nocapture",
        ])
        .env(
            "WTS_SETUP_CRASH_FIXTURE",
            serde_json::json!({
                "data": fixture.data, "repositories": fixture.repositories,
                "workspaces": fixture.workspaces, "workspaceId": fixture.workspace_id,
                "marker": marker, "stage": stage,
            })
            .to_string(),
        )
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !marker.exists() && Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            panic!("Crash fixture exited: {status}");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let reached = marker.exists();
    let active_check = if reached && stage != "success" {
        LocalWtsService::open(
            &fixture.data,
            "fixture",
            &fixture.workspaces,
            &fixture.repositories,
        )
        .and_then(|second_host| {
            let review = second_host.preflight_workspace(fixture.workspace_id)?;
            let active = review
                .setup_recovery
                .ok_or(LocalWtsError::NotMaterialized)?;
            let blocked = matches!(
                second_host.recover_workspace_setup(fixture.workspace_id, &active.effect_digest),
                Err(LocalWtsError::RepositorySyncBusy)
            );
            Ok(!active.ready
                && blocked
                && Path::new(&preflight.repositories[0].target_display_path).is_dir())
        })
    } else {
        Ok(true)
    };
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(
        active_check.is_ok_and(|blocked| blocked),
        "Another host must not clean active setup."
    );
    assert!(
        reached,
        "The child must reach the durable setup checkpoint."
    );
    preflight
}

#[test]
fn setup_recovery_survives_host_death_cleans_reviewed_effects_and_retries() {
    for stage in ["git", "generated"] {
        let fixture = Fixture::new();
        let before = crash_setup(&fixture, stage);
        let root = Path::new(&before.workspace_display_path);
        assert!(root.exists());
        assert!(!root.join(".wts-workspace.json").exists());
        let reopened = LocalWtsService::open(
            &fixture.data,
            "fixture",
            &fixture.workspaces,
            &fixture.repositories,
        )
        .unwrap();
        let review = reopened.preflight_workspace(fixture.workspace_id).unwrap();
        let recovery = review
            .setup_recovery
            .expect("An interrupted setup must remain visible after restart.");
        assert!(root.exists(), "Opening WTS must not clean files.");
        assert!(recovery.ready, "{:?}", recovery.blockers);
        assert!(!review.ready);
        assert!(!recovery.paths.is_empty());
        let retry = reopened
            .recover_workspace_setup(fixture.workspace_id, &recovery.effect_digest)
            .unwrap();
        assert!(retry.ready, "{:?}", retry.blockers);
        assert!(retry.setup_recovery.is_none());
        assert!(!root.exists());
        fixture.assert_git_clean(&before.branch_name);
        let repeated = reopened
            .recover_workspace_setup(fixture.workspace_id, &recovery.effect_digest)
            .unwrap();
        assert!(repeated.ready);
        let result = reopened
            .materialize_workspace(fixture.workspace_id, &retry.effect_digest)
            .unwrap();
        assert!(!result.replayed);
        assert!(root.join(".wts-workspace.json").is_file());
        // An old cleanup request cannot delete the later successful workspace.
        assert!(
            reopened
                .recover_workspace_setup(fixture.workspace_id, &recovery.effect_digest)
                .is_err()
        );
        assert!(root.join(".wts-workspace.json").is_file());
    }
}

#[test]
fn setup_recovery_preserves_dirty_ignored_committed_and_replaced_paths() {
    let fixture = Fixture::new();
    let before = crash_setup(&fixture, "generated");
    let root = Path::new(&before.workspace_display_path);
    let clean_review = fixture
        .service
        .preflight_workspace(fixture.workspace_id)
        .unwrap();
    let clean = clean_review
        .setup_recovery
        .expect("The setup receipt must survive process death.");
    let worktree = Path::new(&before.repositories[0].target_display_path);
    fs::write(worktree.join(".gitignore"), "private-data\n").unwrap();
    git(worktree, &["add", ".gitignore"]);
    git(worktree, &["commit", "-m", "Preserved user commit"]);
    fs::write(worktree.join("private-data"), b"private ignored bytes").unwrap();
    fs::write(worktree.join("README.md"), b"user edit").unwrap();
    fs::write(root.join("WTS.md"), b"user instructions").unwrap();
    fs::write(root.join("unknown.txt"), b"external work").unwrap();
    let head = git(worktree, &["rev-parse", "HEAD"]);
    assert!(
        fixture
            .service
            .recover_workspace_setup(fixture.workspace_id, &clean.effect_digest)
            .is_err()
    );
    let reopened = LocalWtsService::open(
        &fixture.data,
        "fixture",
        &fixture.workspaces,
        &fixture.repositories,
    )
    .unwrap();
    let blocked = reopened
        .preflight_workspace(fixture.workspace_id)
        .unwrap()
        .setup_recovery
        .unwrap();
    assert!(!blocked.ready);
    assert!(
        blocked.blockers.iter().any(|item| item.contains("commit")),
        "{:?}",
        blocked.blockers
    );
    assert!(
        blocked.blockers.iter().any(|item| item.contains("ignored")),
        "{:?}",
        blocked.blockers
    );
    assert!(
        blocked
            .paths
            .contains(&root.join("unknown.txt").display().to_string())
    );
    assert!(
        reopened
            .recover_workspace_setup(fixture.workspace_id, &blocked.effect_digest)
            .is_err()
    );
    assert_eq!(git(worktree, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        fs::read(worktree.join("private-data")).unwrap(),
        b"private ignored bytes"
    );
    assert_eq!(fs::read(root.join("WTS.md")).unwrap(), b"user instructions");
    assert_eq!(
        fs::read(root.join("unknown.txt")).unwrap(),
        b"external work"
    );
    assert!(
        root.join("AGENTS.md").is_file(),
        "A blocked review must not partially clean files."
    );
}

#[test]
fn setup_recovery_never_cleans_a_published_success_receipt_after_host_death() {
    let fixture = Fixture::new();
    let before = crash_setup(&fixture, "success");
    let root = Path::new(&before.workspace_display_path);
    let manifest = fs::read(root.join(".wts-workspace.json")).unwrap();
    let reopened = LocalWtsService::open(
        &fixture.data,
        "fixture",
        &fixture.workspaces,
        &fixture.repositories,
    )
    .unwrap();
    assert!(
        reopened
            .preflight_workspace(fixture.workspace_id)
            .unwrap()
            .setup_recovery
            .is_none()
    );
    assert!(
        reopened
            .get_materialization(fixture.workspace_id)
            .unwrap()
            .is_some()
    );
    assert!(
        reopened
            .recover_workspace_setup(fixture.workspace_id, &format!("sha256:{}", "a".repeat(64)))
            .is_err()
    );
    assert_eq!(
        fs::read(root.join(".wts-workspace.json")).unwrap(),
        manifest
    );
    assert!(root.join("plans/PLAN.md").is_file());
}

#[test]
fn setup_recovery_blocks_missing_or_replaced_journal_before_any_git_effect() {
    let fixture = Fixture::new();
    let preflight = fixture
        .service
        .preflight_workspace(fixture.workspace_id)
        .unwrap();
    let directory = fixture.data.join("setup-attempts");
    fs::rename(&directory, fixture.data.join("saved-attempts")).unwrap();
    fs::write(&directory, b"unrelated file").unwrap();
    assert!(
        fixture
            .service
            .materialize_workspace(fixture.workspace_id, &preflight.effect_digest)
            .is_err()
    );
    assert!(!Path::new(&preflight.workspace_display_path).exists());
    fixture.assert_git_clean(&preflight.branch_name);
    assert_eq!(fs::read(directory).unwrap(), b"unrelated file");
}

#[test]
fn setup_recovery_keeps_returned_failure_receipts_and_can_finish_after_files_are_preserved() {
    let fixture = Fixture::new();
    let before = fixture
        .service
        .preflight_workspace(fixture.workspace_id)
        .unwrap();
    let _hook = fail_at(MaterializationStage::BeforeReviewInbox, |root| {
        fs::write(root.join("WTS.md"), b"user instructions").unwrap();
        fs::write(root.join("unknown.txt"), b"external work").unwrap();
    });
    assert!(
        fixture
            .service
            .materialize_workspace(fixture.workspace_id, &before.effect_digest)
            .is_err()
    );
    let root = Path::new(&before.workspace_display_path);
    let reopened = LocalWtsService::open(
        &fixture.data,
        "fixture",
        &fixture.workspaces,
        &fixture.repositories,
    )
    .unwrap();
    let blocked = reopened
        .preflight_workspace(fixture.workspace_id)
        .unwrap()
        .setup_recovery
        .unwrap();
    assert!(!blocked.ready);
    for leaf in ["WTS.md", "unknown.txt"] {
        fs::rename(root.join(leaf), fixture.data.join(leaf)).unwrap();
    }
    assert!(matches!(
        reopened.recover_workspace_setup(fixture.workspace_id, &blocked.effect_digest),
        Err(LocalWtsError::StalePreflight)
    ));
    let ready = reopened
        .preflight_workspace(fixture.workspace_id)
        .unwrap()
        .setup_recovery
        .unwrap();
    assert!(ready.ready, "{:?}", ready.blockers);
    assert!(
        reopened
            .recover_workspace_setup(fixture.workspace_id, &ready.effect_digest)
            .unwrap()
            .ready
    );
    assert_eq!(
        fs::read(fixture.data.join("WTS.md")).unwrap(),
        b"user instructions"
    );
    assert_eq!(
        fs::read(fixture.data.join("unknown.txt")).unwrap(),
        b"external work"
    );
}
