#![cfg(unix)]

use std::{
    fs,
    os::unix::{fs::PermissionsExt, io::AsRawFd},
    path::{Path, PathBuf},
    process::{Child, Command},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{
    AgentConversationSource, AgentProvider, CancelAgentConversationMessageRequest,
    CreateAgentConversationRequest, LocalWtsError, LocalWtsService, ProcessExternalLauncher,
    ProcessWorkspaceAdapter, SendAgentConversationMessageRequest,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

#[test]
fn active_agent_and_queued_work_block_removal_after_service_reopen() {
    let fixture = Fixture::new();
    let conversation = fixture
        .service
        .create_agent_conversation(CreateAgentConversationRequest {
            request_id: Uuid::new_v4(),
            provider: AgentProvider::Codex,
            source: AgentConversationSource::Ui {
                route: "/fixture".into(),
                callout_id: "removal.fixture".into(),
                label: "Removal fixture".into(),
                selected_text: None,
                context: None,
                capture: None,
            },
        })
        .unwrap();
    fixture
        .service
        .send_agent_conversation_message(
            conversation.conversation_id,
            SendAgentConversationMessageRequest {
                request_id: Uuid::new_v4(),
                body: "Wait without changing files.".into(),
            },
        )
        .unwrap();
    fixture.wait_started();
    let queued = fixture
        .service
        .send_agent_conversation_message(
            conversation.conversation_id,
            SendAgentConversationMessageRequest {
                request_id: Uuid::new_v4(),
                body: "Wait for the earlier request.".into(),
            },
        )
        .unwrap();
    let queued_message = queued
        .messages
        .iter()
        .find(|message| message.body == "Wait for the earlier request.")
        .unwrap();
    let reopened = fixture.open();
    assert_active_blocker(&reopened, fixture.workspace_id);
    assert!(matches!(
        reopened.remove_workspace(
            fixture.workspace_id,
            &fixture.digest,
            &Uuid::new_v4().to_string(),
            false
        ),
        Err(LocalWtsError::RemovalBlocked { .. })
    ));
    assert!(fixture.target.join("README.md").is_file());
    reopened
        .cancel_agent_conversation_message(
            conversation.conversation_id,
            queued_message.message_id,
            CancelAgentConversationMessageRequest {
                request_id: Uuid::new_v4(),
                expected_body: queued_message.body.clone(),
            },
        )
        .unwrap();
    fixture.release();
    wait_until(|| {
        reopened
            .get_agent_conversation(conversation.conversation_id)
            .unwrap()
            .active_session_id
            .is_none()
    });
    let ready = reopened
        .preflight_workspace_removal(fixture.workspace_id)
        .unwrap();
    assert!(ready.ready, "{ready:?}");
    reopened
        .remove_workspace(
            fixture.workspace_id,
            &ready.effect_digest,
            &Uuid::new_v4().to_string(),
            false,
        )
        .unwrap();
    assert!(!fixture.workspace.exists());
    assert!(fixture.source.join("README.md").is_file());
}

#[test]
fn manual_session_blocks_removal_without_a_conversation_record() {
    let fixture = Fixture::new();
    let session = fixture
        .service
        .start_agent_session(
            fixture.workspace_id,
            AgentProvider::Codex,
            wts_app::TerminalProvider::Terminal,
            wts_app::AgentSessionCategory::Uncategorized,
        )
        .unwrap();
    assert_active_blocker(&fixture.service, fixture.workspace_id);
    assert!(matches!(
        fixture.service.remove_workspace(
            fixture.workspace_id,
            &fixture.digest,
            &Uuid::new_v4().to_string(),
            true
        ),
        Err(LocalWtsError::RemovalBlocked { .. })
    ));
    assert!(fixture.target.join("README.md").is_file());
    fixture
        .service
        .finish_agent_session(session.session_id)
        .unwrap();
    assert!(
        fixture
            .service
            .preflight_workspace_removal(fixture.workspace_id)
            .unwrap()
            .ready
    );
}

#[test]
fn deletion_rechecks_a_process_lease_after_an_earlier_ready_preflight() {
    let fixture = Fixture::new();
    let lease = fixture.data.join("agent-conversations-v1").join(format!(
        "workspace-{}.operation.lease",
        fixture.workspace_id
    ));
    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "removal_lease_child"])
        .env("WTS_REMOVAL_TEST_LEASE", &lease)
        .env("WTS_REMOVAL_TEST_READY", fixture.started())
        .env("WTS_REMOVAL_TEST_RELEASE", fixture.released())
        .spawn()
        .unwrap();
    let mut child = OwnedChild {
        child,
        release: fixture.released(),
    };
    fixture.wait_started();
    let reopened = fixture.open();
    let result = reopened.remove_workspace(
        fixture.workspace_id,
        &fixture.digest,
        &Uuid::new_v4().to_string(),
        false,
    );
    assert!(
        matches!(result, Err(LocalWtsError::RemovalBlocked { .. })),
        "{result:?}"
    );
    assert_active_blocker(&reopened, fixture.workspace_id);
    assert!(fixture.target.join("README.md").is_file());
    fixture.release();
    assert!(child.child.wait().unwrap().success());
    let ready = reopened
        .preflight_workspace_removal(fixture.workspace_id)
        .unwrap();
    assert!(ready.ready);
    reopened
        .remove_workspace(
            fixture.workspace_id,
            &ready.effect_digest,
            &Uuid::new_v4().to_string(),
            false,
        )
        .unwrap();
    assert!(!fixture.workspace.exists());
}

#[test]
fn verification_process_blocks_removal_until_its_terminal_result() {
    let fixture = Fixture::new();
    let service = fixture.service.clone();
    let workspace_id = fixture.workspace_id;
    let handle = thread::spawn(move || service.run_workspace_verification(workspace_id));
    let deadline = Instant::now() + Duration::from_secs(25);
    while !fixture.started().exists() {
        if handle.is_finished() {
            let result = handle.join().unwrap();
            let logs = result.as_ref().ok().map(|evidence| {
                evidence
                    .verification_result
                    .checks
                    .iter()
                    .filter_map(|check| check.log_display_path.as_ref())
                    .map(|path| fs::read_to_string(path).unwrap_or_default())
                    .collect::<Vec<_>>()
            });
            panic!("Verification ended before its process gate: {logs:?}");
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }
    assert_active_blocker(&fixture.service, fixture.workspace_id);
    let result = fixture.service.remove_workspace(
        fixture.workspace_id,
        &fixture.digest,
        &Uuid::new_v4().to_string(),
        false,
    );
    assert!(
        matches!(result, Err(LocalWtsError::RemovalBlocked { .. })),
        "{result:?}"
    );
    assert!(fixture.target.join("README.md").is_file());
    fixture.release();
    handle.join().unwrap().unwrap();
    assert!(
        fixture
            .service
            .preflight_workspace_removal(fixture.workspace_id)
            .unwrap()
            .ready
    );
}

#[test]
#[ignore = "Owned subprocess helper for removal lease tests."]
fn removal_lease_child() {
    let Some(path) = std::env::var_os("WTS_REMOVAL_TEST_LEASE") else {
        return;
    };
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .unwrap();
    // This child owns only the lease in its parent's temporary fixture.
    assert_eq!(
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    fs::write(std::env::var_os("WTS_REMOVAL_TEST_READY").unwrap(), "ready").unwrap();
    let release = PathBuf::from(std::env::var_os("WTS_REMOVAL_TEST_RELEASE").unwrap());
    wait_until(|| release.exists());
}

fn assert_active_blocker(service: &LocalWtsService, workspace_id: Uuid) {
    let preflight = service.preflight_workspace_removal(workspace_id).unwrap();
    assert!(
        !preflight.ready,
        "An active operation must block removal: {preflight:?}"
    );
    let json = serde_json::to_value(preflight).unwrap();
    let blocker = json["blockers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|blocker| blocker["code"] == "activeOperation")
        .expect("A specific active-operation blocker is required");
    assert!(blocker["displayPath"].as_str().is_some());
    assert!(!blocker["recoverySteps"].as_array().unwrap().is_empty());
}

struct OwnedChild {
    child: Child,
    release: PathBuf,
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = fs::write(&self.release, "release");
        let _ = self.child.wait();
    }
}

struct Fixture {
    directory: TempDir,
    data: PathBuf,
    repositories: PathBuf,
    source: PathBuf,
    executable: PathBuf,
    service: LocalWtsService,
    workspace_id: Uuid,
    workspace: PathBuf,
    target: PathBuf,
    digest: String,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        let source = repositories.join("api");
        fs::create_dir_all(&source).unwrap();
        git(&source, &["init", "-b", "main"]);
        git(&source, &["config", "user.name", "Fixture"]);
        git(&source, &["config", "user.email", "fixture@example.test"]);
        fs::write(source.join("README.md"), "Keep this source.\n").unwrap();
        let script = format!(
            "const fs = require('node:fs'); fs.writeFileSync({}, 'ready'); const timer = setInterval(() => {{ if (fs.existsSync({})) {{ clearInterval(timer); }} }}, 20); setTimeout(() => process.exit(0), 20000).unref();",
            serde_json::to_string(&directory.path().join("started")).unwrap(),
            serde_json::to_string(&directory.path().join("release")).unwrap()
        );
        fs::write(source.join("wait.cjs"), script).unwrap();
        fs::write(
            source.join("package.json"),
            r#"{"name":"removal-fixture","scripts":{"test":"node wait.cjs"}}"#,
        )
        .unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "fixture"]);
        let executable = directory.path().join("fake-codex");
        fs::write(&executable, format!("#!/bin/sh\nset -eu\nfinal=\nwhile [ \"$#\" -gt 0 ]; do\n if [ \"$1\" = '--output-last-message' ]; then shift; final=$1; fi\n shift\ndone\ntouch '{}'\ncount=0\nwhile [ ! -f '{}' ]; do\n sleep 0.02\n count=$((count + 1))\n [ \"$count\" -lt 1000 ] || exit 2\ndone\nprintf '%s' 'The fixture did not change.' > \"$final\"\nprintf '%s\\n' '{{\"type\":\"turn.completed\"}}'\n", directory.path().join("started").display(), directory.path().join("release").display())).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let data = directory.path().join("data");
        let service = open_service(&data, directory.path(), &repositories, &executable);
        let workspace = service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::RepositorySet {
                        label: "Removal operation".into(),
                    },
                    title: "Removal operation".into(),
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
        let preflight = service.preflight_workspace(workspace.workspace_id).unwrap();
        let receipt = service
            .materialize_workspace(workspace.workspace_id, &preflight.effect_digest)
            .unwrap()
            .materialization;
        let target = PathBuf::from(&receipt.worktrees[0].target_display_path);
        service
            .configure_ui_development_repository(target.clone(), None)
            .unwrap();
        let ready = service
            .preflight_workspace_removal(workspace.workspace_id)
            .unwrap();
        assert!(ready.ready, "{ready:?}");
        Self {
            directory,
            data,
            repositories,
            source,
            executable,
            service,
            workspace_id: workspace.workspace_id,
            workspace: receipt.workspace_display_path.into(),
            target,
            digest: ready.effect_digest,
        }
    }
    fn open(&self) -> LocalWtsService {
        open_service(
            &self.data,
            self.directory.path(),
            &self.repositories,
            &self.executable,
        )
    }
    fn started(&self) -> PathBuf {
        self.directory.path().join("started")
    }
    fn released(&self) -> PathBuf {
        self.directory.path().join("release")
    }
    fn wait_started(&self) {
        wait_until(|| self.started().exists());
    }
    fn release(&self) {
        fs::write(self.released(), "release").unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::write(self.released(), "release");
    }
}
fn open_service(
    data: &Path,
    root: &Path,
    repositories: &Path,
    executable: &Path,
) -> LocalWtsService {
    LocalWtsService::open_with_repository_roots_launcher_and_adapter(
        data,
        "test",
        root.join("workspaces"),
        [repositories.to_owned()],
        ProcessExternalLauncher,
        ProcessWorkspaceAdapter::default()
            .with_agent_executable(AgentProvider::Codex, executable.to_owned()),
    )
    .unwrap()
}
fn wait_until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(25);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "The owned fixture did not reach its gate."
        );
        thread::sleep(Duration::from_millis(20));
    }
}
fn git(root: &Path, args: &[&str]) {
    let result = Command::new("git")
        .arg("-C")
        .arg(root)
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
}
