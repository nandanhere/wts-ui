#![cfg(unix)]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{
    AgentConversation, AgentConversationSource, AgentProvider, AgentTurnCheckStatus,
    AgentTurnChecksState, CreateAgentConversationRequest, LocalWtsService, ProcessWorkspaceAdapter,
    RunAgentTurnCheckRequest, SendAgentConversationMessageRequest,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

#[test]
fn host_check_runs_the_saved_command_once_and_replay_survives_reopen() {
    let fixture = Fixture::new();
    let turn = fixture.run();
    let discovered = fixture
        .service
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    assert_eq!(discovered.state, AgentTurnChecksState::Ready);
    assert_eq!(discovered.checks.len(), 1);
    let request = RunAgentTurnCheckRequest {
        request_id: Uuid::new_v4(),
        check_id: discovered.checks[0].check_id.clone(),
        expected_after_checkpoint_id: discovered.after_checkpoint_id.unwrap(),
        expected_plan_revision: discovered.checks[0].plan_revision,
    };
    let result = fixture
        .service
        .run_agent_turn_check(fixture.conversation.conversation_id, turn, request.clone())
        .unwrap();
    assert_eq!(result.runs.len(), 1);
    assert_eq!(
        result.runs[0].status,
        AgentTurnCheckStatus::Passed,
        "{:?}",
        result.runs[0]
    );
    assert!(
        result.runs[0]
            .output
            .contains("HOST_CHECK_EXECUTED_ON_RECORDED_CODE")
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join(".check-count")).unwrap(),
        "x"
    );
    let reopened = fixture.open();
    let replay = reopened
        .run_agent_turn_check(fixture.conversation.conversation_id, turn, request.clone())
        .unwrap();
    assert_eq!(replay.runs, result.runs);
    assert_eq!(
        fs::read_to_string(fixture.target.join(".check-count")).unwrap(),
        "x"
    );
    let mut changed = request;
    changed.check_id = "different-check".to_owned();
    assert!(
        reopened
            .run_agent_turn_check(fixture.conversation.conversation_id, turn, changed)
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("draft.txt")).unwrap(),
        "unrelated private draft\n"
    );
}

#[test]
fn source_changes_before_or_during_a_check_never_receive_a_pass() {
    for before in [true, false] {
        let fixture = Fixture::new();
        let turn = fixture.run();
        let discovered = fixture
            .service
            .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
            .unwrap();
        let request = RunAgentTurnCheckRequest {
            request_id: Uuid::new_v4(),
            check_id: discovered.checks[0].check_id.clone(),
            expected_after_checkpoint_id: discovered.after_checkpoint_id.unwrap(),
            expected_plan_revision: discovered.checks[0].plan_revision,
        };
        if before {
            fs::write(
                fixture.target.join("tracked.txt"),
                "edited after the task\n",
            )
            .unwrap();
        } else {
            fs::write(fixture.target.join(".check-mode"), "change").unwrap();
        }
        let result = fixture
            .service
            .run_agent_turn_check(fixture.conversation.conversation_id, turn, request)
            .unwrap();
        assert_eq!(result.state, AgentTurnChecksState::Stale);
        assert_eq!(result.runs[0].status, AgentTurnCheckStatus::Stale);
        assert_eq!(fixture.target.join(".check-count").exists(), !before);
        assert_ne!(
            fixture
                .service
                .get_workspace_evidence(fixture.conversation.workspace_id)
                .unwrap()
                .unwrap()
                .verification_result
                .status,
            wts_app::VerificationStatus::Running,
            "A rejected bound check must not leave Workspace Verify active."
        );
    }
}

#[test]
fn failed_host_check_retains_bounded_complete_utf8_output() {
    let fixture = Fixture::new();
    let turn = fixture.run();
    let discovered = fixture
        .service
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    fs::write(fixture.target.join(".check-mode"), "fail").unwrap();
    let result = fixture
        .service
        .run_agent_turn_check(
            fixture.conversation.conversation_id,
            turn,
            RunAgentTurnCheckRequest {
                request_id: Uuid::new_v4(),
                check_id: discovered.checks[0].check_id.clone(),
                expected_after_checkpoint_id: discovered.after_checkpoint_id.unwrap(),
                expected_plan_revision: discovered.checks[0].plan_revision,
            },
        )
        .unwrap();
    assert_eq!(result.runs[0].status, AgentTurnCheckStatus::Failed);
    assert_eq!(result.runs[0].exit_code, Some(7), "{:?}", result.runs[0]);
    assert!(result.runs[0].output_truncated);
    assert!(result.runs[0].output.len() <= 65_536);
    assert!(result.runs[0].output.contains('😀'));
    assert!(!result.runs[0].output.contains('�'));
}

#[test]
fn running_check_excludes_agent_writers_and_duplicate_replay_does_not_run_again() {
    let fixture = Fixture::new();
    let turn = fixture.run();
    let discovered = fixture
        .service
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    let request = RunAgentTurnCheckRequest {
        request_id: Uuid::new_v4(),
        check_id: discovered.checks[0].check_id.clone(),
        expected_after_checkpoint_id: discovered.after_checkpoint_id.unwrap(),
        expected_plan_revision: discovered.checks[0].plan_revision,
    };
    fs::write(fixture.target.join(".check-mode"), "wait").unwrap();
    let _release = ReleaseCheck(fixture.target.join(".check-release"));
    let service = fixture.service.clone();
    let id = fixture.conversation.conversation_id;
    let running_request = request.clone();
    let worker = thread::spawn(move || service.run_agent_turn_check(id, turn, running_request));
    wait_until(|| fixture.target.join(".check-entered").exists());
    let reopened = fixture.open();
    let replay = reopened.run_agent_turn_check(id, turn, request).unwrap();
    assert_eq!(replay.runs[0].status, AgentTurnCheckStatus::Running);
    assert_eq!(
        fs::read_to_string(fixture.target.join(".check-count")).unwrap(),
        "x"
    );
    assert!(matches!(
        fixture.service.run_agent(
            fixture.conversation.workspace_id,
            AgentProvider::Codex,
            "Temporary fixture request"
        ),
        Err(wts_app::LocalWtsError::AgentConversationBusy)
    ));
    assert!(matches!(
        fixture.service.launch_agent_session(
            fixture.conversation.workspace_id,
            AgentProvider::Codex,
            "Temporary fixture request",
            wts_app::AgentSessionCategory::Implementation
        ),
        Err(wts_app::LocalWtsError::AgentConversationBusy)
    ));
    assert!(matches!(
        fixture.service.start_agent_session(
            fixture.conversation.workspace_id,
            AgentProvider::Codex,
            wts_app::TerminalProvider::Terminal,
            wts_app::AgentSessionCategory::Implementation
        ),
        Err(wts_app::LocalWtsError::AgentConversationBusy)
    ));
    assert!(matches!(
        fixture.service.open_workspace_cli(
            fixture.conversation.workspace_id,
            AgentProvider::Codex,
            wts_app::TerminalProvider::Terminal
        ),
        Err(wts_app::LocalWtsError::AgentConversationBusy)
    ));
    let queued = fixture
        .service
        .send_agent_conversation_message(
            id,
            SendAgentConversationMessageRequest {
                request_id: Uuid::new_v4(),
                body: "Another temporary task".to_owned(),
            },
        )
        .unwrap();
    assert!(
        queued
            .messages
            .iter()
            .any(|message| message.status == wts_app::AgentConversationMessageStatus::Queued)
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join(".agent-count")).unwrap(),
        "x"
    );
    fs::write(fixture.target.join(".check-release"), "release").unwrap();
    let completed = worker.join().unwrap().unwrap();
    assert_eq!(completed.runs[0].status, AgentTurnCheckStatus::Passed);
    wait_until(|| {
        fs::read_to_string(fixture.target.join(".agent-count")).is_ok_and(|value| value == "xx")
    });
    wait_until(|| {
        fixture
            .service
            .get_agent_conversation(id)
            .is_ok_and(|value| value.active_session_id.is_none())
    });
}

#[test]
fn trusted_active_agent_session_blocks_checks_until_it_finishes() {
    let fixture = Fixture::new();
    let turn = fixture.run();
    let discovered = fixture
        .service
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    let request = RunAgentTurnCheckRequest {
        request_id: Uuid::new_v4(),
        check_id: discovered.checks[0].check_id.clone(),
        expected_after_checkpoint_id: discovered.after_checkpoint_id.unwrap(),
        expected_plan_revision: discovered.checks[0].plan_revision,
    };
    let session = fixture
        .service
        .start_agent_session(
            fixture.conversation.workspace_id,
            AgentProvider::Codex,
            wts_app::TerminalProvider::Terminal,
            wts_app::AgentSessionCategory::Implementation,
        )
        .unwrap();
    let blocked = fixture.service.run_agent_turn_check(
        fixture.conversation.conversation_id,
        turn,
        request.clone(),
    );
    assert!(matches!(
        blocked,
        Err(wts_app::LocalWtsError::AgentConversationBusy)
    ));
    assert!(!fixture.target.join(".check-count").exists());
    fixture
        .service
        .finish_agent_session(session.session_id)
        .unwrap();
    let completed = fixture
        .service
        .run_agent_turn_check(fixture.conversation.conversation_id, turn, request)
        .unwrap();
    assert_eq!(completed.runs[0].status, AgentTurnCheckStatus::Passed);
}

#[test]
fn escaped_output_still_fits_the_private_terminal_record() {
    let fixture = Fixture::new();
    let turn = fixture.run();
    let discovered = fixture
        .service
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    fs::write(fixture.target.join(".check-mode"), "escaped").unwrap();
    let result = fixture
        .service
        .run_agent_turn_check(
            fixture.conversation.conversation_id,
            turn,
            RunAgentTurnCheckRequest {
                request_id: Uuid::new_v4(),
                check_id: discovered.checks[0].check_id.clone(),
                expected_after_checkpoint_id: discovered.after_checkpoint_id.unwrap(),
                expected_plan_revision: discovered.checks[0].plan_revision,
            },
        )
        .unwrap();
    assert_eq!(result.runs[0].status, AgentTurnCheckStatus::Passed);
    assert!(result.runs[0].output_truncated);
    assert_eq!(result.runs[0].output.len(), 65_536);
    assert!(result.runs[0].output.contains('\t'));
    assert_eq!(
        fixture
            .open()
            .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
            .unwrap()
            .runs,
        result.runs
    );
}

#[test]
fn saved_check_changes_at_the_same_revision_do_not_dispatch_after_lock_wait() {
    let fixture = Fixture::new();
    let turn = fixture.run();
    let discovered = fixture
        .service
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    let request = check_request(&discovered);
    fs::write(fixture.target.join(".check-mode"), "wait").unwrap();
    let _release = ReleaseCheck(fixture.target.join(".check-release"));
    let service = fixture.service.clone();
    let workspace_id = fixture.conversation.workspace_id;
    let check_id = request.check_id.clone();
    let existing =
        thread::spawn(move || service.run_workspace_verification_check(workspace_id, &check_id));
    wait_until(|| fixture.target.join(".check-entered").exists());
    let service = fixture.service.clone();
    let id = fixture.conversation.conversation_id;
    let bound = thread::spawn(move || service.run_agent_turn_check(id, turn, request));
    wait_until(|| {
        fixture
            .service
            .get_agent_turn_checks(id, turn)
            .is_ok_and(|value| {
                value
                    .runs
                    .iter()
                    .any(|run| run.status == AgentTurnCheckStatus::Running)
            })
    });
    let workspace = fixture
        .service
        .get_workspace(workspace_id)
        .unwrap()
        .unwrap();
    let path = Path::new(&workspace.workspace_display_path).join(".wts/verification-plan.json");
    let mut plan: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    plan["checks"][0]["label"] = "A changed saved check at the same revision".into();
    fs::write(path, serde_json::to_vec(&plan).unwrap()).unwrap();
    fs::write(fixture.target.join(".check-release"), "release").unwrap();
    existing.join().unwrap().unwrap();
    let result = bound.join().unwrap().unwrap();
    assert_eq!(result.runs[0].status, AgentTurnCheckStatus::Blocked);
    assert_eq!(
        fs::read_to_string(fixture.target.join(".check-count")).unwrap(),
        "x"
    );
}

#[test]
fn check_child_keeps_writer_exclusion_after_its_temporary_host_is_killed() {
    let fixture = Fixture::new();
    let turn = fixture.run();
    let discovered = fixture
        .service
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    let request = check_request(&discovered);
    let state_path = fixture.directory.path().join("child-host.json");
    fs::write(&state_path, serde_json::to_vec(&serde_json::json!({
        "root": fixture.directory.path(), "conversationId": fixture.conversation.conversation_id,
        "turnRequestId": turn, "request": request,
    })).unwrap()).unwrap();
    fs::write(fixture.target.join(".check-mode"), "wait").unwrap();
    let _release = ReleaseCheck(fixture.target.join(".check-release"));
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "run_saved_check_in_child_host",
            "--nocapture",
        ])
        .env("WTS_CHECK_PROCESS_STATE", &state_path)
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    wait_until(|| fixture.target.join(".check-entered").exists());
    child.kill().unwrap();
    child.wait().unwrap();
    let reopened = fixture.open();
    let running = reopened
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    assert_eq!(
        running.runs[0].status,
        AgentTurnCheckStatus::Running,
        "The child must retain the lease after its host exits."
    );
    assert!(matches!(
        reopened.run_agent(
            fixture.conversation.workspace_id,
            AgentProvider::Codex,
            "Temporary fixture request"
        ),
        Err(wts_app::LocalWtsError::AgentConversationBusy)
    ));
    fs::write(fixture.target.join(".check-release"), "release").unwrap();
    wait_until(|| {
        reopened
            .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
            .is_ok_and(|value| value.runs[0].status == AgentTurnCheckStatus::Interrupted)
    });
    let replay = reopened
        .run_agent_turn_check(fixture.conversation.conversation_id, turn, request)
        .unwrap();
    assert_eq!(replay.runs[0].status, AgentTurnCheckStatus::Interrupted);
    assert_eq!(
        reopened
            .get_workspace_evidence(fixture.conversation.workspace_id)
            .unwrap()
            .unwrap()
            .verification_result
            .status,
        wts_app::VerificationStatus::Blocked,
        "Recover the same abandoned Workspace Verify run."
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join(".check-count")).unwrap(),
        "x"
    );
    fs::remove_file(fixture.target.join(".check-release")).unwrap();
    fs::remove_file(fixture.target.join(".check-entered")).unwrap();
    let service = reopened.clone();
    let workspace_id = fixture.conversation.workspace_id;
    let check_id = discovered.checks[0].check_id.clone();
    let newer =
        thread::spawn(move || service.run_workspace_verification_check(workspace_id, &check_id));
    wait_until(|| fixture.target.join(".check-entered").exists());
    reopened
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    assert_eq!(
        reopened
            .get_workspace_evidence(workspace_id)
            .unwrap()
            .unwrap()
            .verification_result
            .status,
        wts_app::VerificationStatus::Running
    );
    fs::write(fixture.target.join(".check-release"), "release").unwrap();
    let newer = newer.join().unwrap().unwrap().verification_result;
    reopened
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    assert_eq!(
        reopened
            .get_workspace_evidence(workspace_id)
            .unwrap()
            .unwrap()
            .verification_result,
        newer,
        "Recovery must preserve a newer verification run."
    );
}

#[test]
#[ignore = "An isolated parent test starts and stops this temporary host."]
fn run_saved_check_in_child_host() {
    let state: serde_json::Value = serde_json::from_slice(
        &fs::read(
            std::env::var_os("WTS_CHECK_PROCESS_STATE")
                .expect("The parent supplies its temporary fixture."),
        )
        .unwrap(),
    )
    .unwrap();
    let root = Path::new(state["root"].as_str().unwrap());
    let service = open_service(root, &root.join("repositories"), &root.join("fake-codex"));
    service
        .run_agent_turn_check(
            Uuid::parse_str(state["conversationId"].as_str().unwrap()).unwrap(),
            Uuid::parse_str(state["turnRequestId"].as_str().unwrap()).unwrap(),
            serde_json::from_value(state["request"].clone()).unwrap(),
        )
        .unwrap();
}

fn check_request(discovered: &wts_app::AgentTurnChecks) -> RunAgentTurnCheckRequest {
    RunAgentTurnCheckRequest {
        request_id: Uuid::new_v4(),
        check_id: discovered.checks[0].check_id.clone(),
        expected_after_checkpoint_id: discovered.after_checkpoint_id.unwrap(),
        expected_plan_revision: discovered.checks[0].plan_revision,
    }
}

#[test]
fn absent_checks_and_incomplete_source_capture_have_explicit_unavailable_states() {
    let fixture = Fixture::with_checks(false);
    let turn = fixture.run();
    let result = fixture
        .service
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    assert_eq!(result.state, AgentTurnChecksState::NoChecks);
    assert!(result.checks.is_empty());
    assert!(result.detail.contains("workspace verification"));

    let fixture = Fixture::new();
    std::os::unix::fs::symlink("tracked.txt", fixture.target.join("unsupported-link")).unwrap();
    let turn = fixture.run();
    let result = fixture
        .service
        .get_agent_turn_checks(fixture.conversation.conversation_id, turn)
        .unwrap();
    assert_eq!(result.state, AgentTurnChecksState::Unavailable);
    assert!(result.checks.is_empty());
    assert!(result.detail.contains("current local changes"));
}

struct ReleaseCheck(PathBuf);
impl Drop for ReleaseCheck {
    fn drop(&mut self) {
        let _ = fs::write(&self.0, "release");
    }
}
fn wait_until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "The fixture process did not reach its boundary."
        );
        thread::sleep(Duration::from_millis(20));
    }
}

struct Fixture {
    directory: TempDir,
    service: LocalWtsService,
    conversation: AgentConversation,
    target: PathBuf,
    executable: PathBuf,
    repositories: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        Self::with_checks(true)
    }

    fn with_checks(supported_checks: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        let source = repositories.join("api");
        fs::create_dir_all(&source).unwrap();
        git(&source, &["init", "-b", "main"]);
        git(&source, &["config", "user.name", "Fixture"]);
        git(&source, &["config", "user.email", "fixture@example.test"]);
        fs::write(source.join("tracked.txt"), "committed\n").unwrap();
        fs::write(source.join(".gitignore"), ".check-*\n.agent-count\n").unwrap();
        fs::write(
            source.join("package.json"),
            r#"{"name":"wts-check-fixture","version":"1.0.0","scripts":{"test":"node check.cjs"}}"#,
        )
        .unwrap();
        fs::write(
            source.join("check.cjs"),
            r#"const fs = require('node:fs');
const mode = fs.existsSync('.check-mode') ? fs.readFileSync('.check-mode','utf8') : '';
fs.appendFileSync('.check-count','x');
fs.writeFileSync('.check-entered','yes');
if (mode === 'wait') {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10000;
  while (!fs.existsSync('.check-release') && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20);
  if (!fs.existsSync('.check-release')) process.exit(9);
}
if (mode === 'change') fs.writeFileSync('tracked.txt','changed during check\n');
if (mode === 'fail') { console.log('😀'.repeat(33000)); process.exit(7); }
if (mode === 'escaped') console.log('\t'.repeat(65536));
if (fs.readFileSync('tracked.txt','utf8') !== 'task result 1\n') process.exit(3);
console.log('HOST_CHECK_EXECUTED_ON_RECORDED_CODE');
"#,
        )
        .unwrap();
        fs::write(source.join("deleted.txt"), "deleted during task\n").unwrap();
        if !supported_checks {
            fs::remove_file(source.join("package.json")).unwrap();
            fs::remove_file(source.join("check.cjs")).unwrap();
        }
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "fixture"]);
        let executable = directory.path().join("fake-codex");
        fs::write(
            &executable,
            format!(
                r#"#!/bin/sh
set -eu
final=
while [ "$#" -gt 0 ]; do
 if [ "$1" = '--output-last-message' ]; then shift; final=$1; fi
 shift
done
printf x >> .agent-count
number=1
printf 'task result %s\n' "$number" > tracked.txt
printf 'created during task %s\n' "$number" > created.txt
rm -f deleted.txt
: > empty.txt
printf 'Done with task %s.' "$number" > "$final"
printf '%s\n' '{{"type":"turn.completed"}}'
exit {}
"#,
                0
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let service = open_service(directory.path(), &repositories, &executable);
        let workspace = service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::RepositorySet {
                        label: "Receipt fixture".to_owned(),
                    },
                    title: "Receipt fixture".to_owned(),
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
            .workspace;
        let preflight = service.preflight_workspace(workspace.workspace_id).unwrap();
        let materialized = service
            .materialize_workspace(workspace.workspace_id, &preflight.effect_digest)
            .unwrap();
        let target = PathBuf::from(&materialized.materialization.worktrees[0].target_display_path);
        fs::write(target.join("tracked.txt"), "staged before task\n").unwrap();
        git(&target, &["add", "tracked.txt"]);
        fs::write(target.join("tracked.txt"), "dirty before task\n").unwrap();
        fs::write(target.join("draft.txt"), "unrelated private draft\n").unwrap();
        service
            .configure_ui_development_repository(target.clone(), None)
            .unwrap();
        let conversation = service
            .create_agent_conversation(CreateAgentConversationRequest {
                request_id: Uuid::new_v4(),
                provider: AgentProvider::Codex,
                source: AgentConversationSource::Ui {
                    route: "/receipt".to_owned(),
                    callout_id: "receipt.fixture".to_owned(),
                    label: "Receipt fixture".to_owned(),
                    selected_text: None,
                    context: None,
                    capture: None,
                },
            })
            .unwrap();
        Self {
            directory,
            service,
            conversation,
            target,
            executable,
            repositories,
        }
    }
    fn run(&self) -> Uuid {
        let request_id = Uuid::new_v4();
        self.service
            .send_agent_conversation_message(
                self.conversation.conversation_id,
                SendAgentConversationMessageRequest {
                    request_id,
                    body: "Change the fixture files.".to_owned(),
                },
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let current = self
                .service
                .get_agent_conversation(self.conversation.conversation_id)
                .unwrap();
            if current.active_session_id.is_none()
                && current.messages.iter().any(|message| {
                    message.request_id == Some(request_id) && message.session_id.is_some()
                })
            {
                return request_id;
            }
            assert!(
                Instant::now() < deadline,
                "The fake turn did not finish: {current:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn open(&self) -> LocalWtsService {
        open_service(self.directory.path(), &self.repositories, &self.executable)
    }
}
fn open_service(root: &Path, repositories: &Path, executable: &Path) -> LocalWtsService {
    LocalWtsService::open_with_repository_roots_launcher_and_adapter(
        root.join("data"),
        "test",
        root.join("workspaces"),
        [repositories.to_owned()],
        NoExternalLaunch,
        ProcessWorkspaceAdapter::default()
            .with_agent_executable(AgentProvider::Codex, executable.to_owned()),
    )
    .unwrap()
}
fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
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
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

struct NoExternalLaunch;
impl wts_app::ExternalLauncher for NoExternalLaunch {
    fn launch_vscode(&self, _: &Path) -> Result<(), wts_app::LaunchFailure> {
        Err(wts_app::LaunchFailure::Rejected)
    }
    fn launch_cli(
        &self,
        _: &Path,
        _: AgentProvider,
        _: wts_app::TerminalProvider,
    ) -> Result<(), wts_app::LaunchFailure> {
        Err(wts_app::LaunchFailure::Rejected)
    }
    fn launch_repository_base(
        &self,
        _: &wts_app::RepositoryBaseTarget,
    ) -> Result<(), wts_app::LaunchFailure> {
        Err(wts_app::LaunchFailure::Rejected)
    }
    fn launch_change_request_draft(
        &self,
        _: &wts_app::ChangeRequestDraftTarget,
    ) -> Result<(), wts_app::LaunchFailure> {
        Err(wts_app::LaunchFailure::Rejected)
    }
    fn launch_jira_issue(
        &self,
        _: &wts_app::JiraIssueTarget,
    ) -> Result<(), wts_app::LaunchFailure> {
        Err(wts_app::LaunchFailure::Rejected)
    }
}
