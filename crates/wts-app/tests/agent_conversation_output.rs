#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use serde_json::json;
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{
    AgentConversation, AgentConversationMessageRole, AgentConversationMessageStatus,
    AgentConversationSource, AgentProvider, ChangeRequestDraftTarget,
    CreateAgentConversationRequest, ExternalLauncher, JiraIssueTarget, LaunchFailure,
    LocalWtsService, ProcessWorkspaceAdapter, RepositoryBaseTarget,
    SendAgentConversationMessageRequest, TerminalProvider,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

#[test]
fn final_response_survives_large_tool_streams_and_stderr_without_including_progress() {
    let fixture = OutputFixture::new(false);
    let request_id = Uuid::new_v4();
    let finished = fixture.run(request_id);
    let user = finished
        .messages
        .iter()
        .find(|message| {
            message.role == AgentConversationMessageRole::User
                && message.request_id == Some(request_id)
        })
        .unwrap();
    let assistant = finished
        .messages
        .iter()
        .find(|message| {
            message.role == AgentConversationMessageRole::Assistant
                && message.request_id == Some(request_id)
        })
        .unwrap();
    assert_eq!(user.status, AgentConversationMessageStatus::Completed);
    assert_eq!(assistant.status, AgentConversationMessageStatus::Completed);
    assert_eq!(assistant.body, fixture.final_text);
    assert!(assistant.body.chars().count() > 800);
    assert!(assistant.error.is_none());
    assert!(!assistant.body.contains("PROGRESS_ONLY_MARKER"));
    assert!(!assistant.body.contains("STDERR_DIAGNOSTIC"));
    let value = serde_json::to_value(assistant).unwrap();
    for field in ["body", "progress", "diagnostic", "error"] {
        assert!(
            !value[field]
                .as_str()
                .is_some_and(|text| text.contains('\0')),
            "The {field} field contains a NUL that the client rejects."
        );
    }
    let diagnostic = value["diagnostic"].as_str().unwrap();
    assert!(diagnostic.contains("STDERR_DIAGNOSTIC"));
    assert!(diagnostic.len() <= 16_384);
    assert_eq!(
        fs::read_to_string(fixture.target.join("agent-effect.txt")).unwrap(),
        "The fake provider changed this worktree.\n"
    );
    fixture.assert_private_final_file();
}

#[test]
fn nonzero_exit_keeps_progress_and_specific_error_without_publishing_an_unverified_final_file() {
    let fixture = OutputFixture::new(true);
    let request_id = Uuid::new_v4();
    let finished = fixture.run(request_id);
    let user = finished
        .messages
        .iter()
        .find(|message| {
            message.role == AgentConversationMessageRole::User
                && message.request_id == Some(request_id)
        })
        .unwrap();
    let assistant = finished
        .messages
        .iter()
        .find(|message| {
            message.role == AgentConversationMessageRole::Assistant
                && message.request_id == Some(request_id)
        })
        .unwrap();
    assert_eq!(user.status, AgentConversationMessageStatus::Failed);
    assert_eq!(assistant.status, AgentConversationMessageStatus::Failed);
    assert!(
        assistant.body.is_empty(),
        "A failed process cannot publish its final-file candidate as a completed answer."
    );
    let value = serde_json::to_value(assistant).unwrap();
    for field in ["body", "progress", "diagnostic", "error"] {
        assert!(
            !value[field]
                .as_str()
                .is_some_and(|text| text.contains('\0')),
            "The {field} field contains a NUL that the client rejects."
        );
    }
    assert!(
        value["progress"]
            .as_str()
            .is_some_and(|progress| progress.contains("PROGRESS_ONLY_MARKER")),
        "The failed turn must retain its separate progress evidence."
    );
    assert!(value["progress"].as_str().unwrap().len() <= 65_536);
    let diagnostic = value["diagnostic"].as_str().unwrap();
    assert!(diagnostic.len() <= 16_384);
    assert!(diagnostic.contains("STDERR_DIAGNOSTIC"));
    let error = assistant
        .error
        .as_deref()
        .expect("The failed turn needs a diagnostic.");
    let reason = error
        .find("FAKE_PROVIDER_REJECTED_REQUEST")
        .expect("Retain the specific provider error.");
    if let Some(warning) = error.find("STDERR_DIAGNOSTIC") {
        assert!(
            reason < warning,
            "Show the provider failure before background diagnostics."
        );
    }
    assert!(!error.contains("UNVERIFIED_FINAL_MARKER"));
    assert_eq!(
        fs::read_to_string(fixture.target.join("agent-effect.txt")).unwrap(),
        "The fake provider changed this worktree.\n"
    );
    fixture.assert_private_final_file();
}

#[test]
fn a_full_multibyte_provider_error_and_stderr_stay_within_the_conversation_contract() {
    let provider_error = "診".repeat(5_461) + "!";
    assert_eq!(provider_error.len(), 16_384);
    let fixture = OutputFixture::with_provider_error(true, &provider_error);
    let finished = fixture.run(Uuid::new_v4());
    let assistant = finished
        .messages
        .iter()
        .find(|message| message.role == AgentConversationMessageRole::Assistant)
        .unwrap();
    assert_eq!(assistant.status, AgentConversationMessageStatus::Failed);
    assert!(assistant.body.is_empty());
    let value = serde_json::to_value(assistant).unwrap();
    for field in ["body", "progress", "diagnostic", "error"] {
        assert!(
            !value[field]
                .as_str()
                .is_some_and(|text| text.contains('\0')),
            "The {field} field contains a NUL that the client rejects."
        );
    }
    let diagnostic = value["diagnostic"]
        .as_str()
        .expect("Retain the specific provider diagnostic.");
    assert!(
        diagnostic.len() <= 16_384,
        "The serialized diagnostic exceeds the client byte limit: {}",
        diagnostic.len()
    );
    assert!(diagnostic.contains("診"));
    assert!(diagnostic.ends_with('!'));
}

struct OutputFixture {
    _directory: TempDir,
    service: LocalWtsService,
    conversation: AgentConversation,
    target: PathBuf,
    state: PathBuf,
    final_text: String,
}

impl OutputFixture {
    fn new(failed: bool) -> Self {
        Self::with_provider_error(failed, "FAKE_PROVIDER_REJECTED_REQUEST\0")
    }

    fn with_provider_error(failed: bool, provider_error: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        let source = repositories.join("api");
        let state = directory.path().join("fake-output");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir(&state).unwrap();
        git(&source, &["init", "--initial-branch=main"]);
        git(&source, &["config", "user.name", "WTS Test"]);
        git(&source, &["config", "user.email", "wts@example.invalid"]);
        fs::write(
            source.join("README.md"),
            "Temporary provider output fixture.\n",
        )
        .unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);
        let final_text = if failed {
            "UNVERIFIED_FINAL_MARKER".to_owned()
        } else {
            format!(
                "{}FINAL_RESPONSE_TAIL",
                "The complete final answer stays separate from progress.\n".repeat(80)
            )
        };
        let mut events = format!(
            "{}\n",
            json!({"type":"item.completed","item":{"id":"progress-1","type":"agent_message","text":"PROGRESS_ONLY_MARKER: \0The agent inspected the current file."}})
        );
        for index in 0..90 {
            events.push_str(&format!("{}\n", json!({"type":"item.completed","item":{"id":format!("command-{index}"),"type":"command_execution","command":"read fixture","aggregated_output":"Large tool evidence. ".repeat(1_300),"exit_code":0,"status":"completed"}})));
        }
        if failed {
            events.push_str(&format!(
                "{}\n",
                json!({"type":"error","message":provider_error})
            ));
            events.push_str(&format!(
                "{}\n",
                json!({"type":"turn.failed","error":{"message":provider_error}})
            ));
        } else {
            events.push_str(&format!("{}\n", json!({"type":"item.completed","item":{"id":"final-1","type":"agent_message","text":final_text}})));
            events.push_str(&format!("{}\n", json!({"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}})));
        }
        assert!(events.len() > 1024 * 1024);
        let diagnostics = "STDERR_DIAGNOSTIC: \0background provider warning.\n".repeat(26_000);
        assert!(diagnostics.len() > 1024 * 1024);
        fs::write(state.join("events.jsonl"), events).unwrap();
        fs::write(state.join("stderr.txt"), diagnostics).unwrap();
        fs::write(state.join("final.txt"), &final_text).unwrap();
        let executable = directory.path().join("fake-codex");
        fs::write(
            &executable,
            format!(
                r#"#!/bin/sh
set -eu
state={}
final_path=
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output-last-message' ]; then
    shift
    final_path=$1
  fi
  shift
done
if [ -n "$final_path" ]; then
  test -f "$final_path"
  printf '%s' "$final_path" > "$state/final-path"
  cat "$state/final.txt" > "$final_path"
fi
printf 'The fake provider changed this worktree.\n' > agent-effect.txt
cat "$state/events.jsonl"
cat "$state/stderr.txt" >&2
exit {}
"#,
                quote(&state),
                if failed { 7 } else { 0 }
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let service = LocalWtsService::open_with_repository_roots_launcher_and_adapter(
            directory.path().join("data"),
            "test",
            directory.path().join("workspaces"),
            [repositories],
            NoExternalLaunch,
            ProcessWorkspaceAdapter::default()
                .with_agent_executable(AgentProvider::Codex, executable),
        )
        .unwrap();
        let workspace = service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::RepositorySet {
                        label: "Provider output".to_owned(),
                    },
                    title: "Provider output".to_owned(),
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
        let receipt = service
            .materialize_workspace(workspace.workspace_id, &preflight.effect_digest)
            .unwrap();
        let target = PathBuf::from(&receipt.materialization.worktrees[0].target_display_path);
        service
            .configure_ui_development_repository(target.clone(), None)
            .unwrap();
        let conversation = service
            .create_agent_conversation(CreateAgentConversationRequest {
                request_id: Uuid::new_v4(),
                provider: AgentProvider::Codex,
                source: AgentConversationSource::Ui {
                    route: "/output-test".to_owned(),
                    callout_id: "output.fixture".to_owned(),
                    label: "Provider output fixture".to_owned(),
                    selected_text: None,
                    context: None,
                    capture: None,
                },
            })
            .unwrap();
        Self {
            _directory: directory,
            service,
            conversation,
            target,
            state,
            final_text,
        }
    }

    fn run(&self, request_id: Uuid) -> AgentConversation {
        self.service
            .send_agent_conversation_message(
                self.conversation.conversation_id,
                SendAgentConversationMessageRequest {
                    request_id,
                    body: "Complete the temporary output fixture.".to_owned(),
                },
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let current = self
                .service
                .get_agent_conversation(self.conversation.conversation_id)
                .unwrap();
            if current.messages.iter().any(|message| {
                message.role == AgentConversationMessageRole::User
                    && message.request_id == Some(request_id)
                    && matches!(
                        message.status,
                        AgentConversationMessageStatus::Completed
                            | AgentConversationMessageStatus::Failed
                            | AgentConversationMessageStatus::Interrupted
                    )
            }) {
                assert!(current.active_session_id.is_none());
                return current;
            }
            assert!(
                Instant::now() < deadline,
                "The bounded fake process did not finish."
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn assert_private_final_file(&self) {
        let path = PathBuf::from(
            fs::read_to_string(self.state.join("final-path"))
                .expect("Codex receives a final-output path."),
        );
        let root = self
            ._directory
            .path()
            .join("data/agent-conversations-v1")
            .canonicalize()
            .unwrap();
        assert_eq!(path.parent().unwrap().canonicalize().unwrap(), root);
        assert!(
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(&self.conversation.conversation_id.to_string())
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::read_to_string(path).unwrap(), self.final_text);
    }
}

impl Drop for OutputFixture {
    fn drop(&mut self) {
        if let Ok(current) = self
            .service
            .get_agent_conversation(self.conversation.conversation_id)
            && let Some(id) = current.active_session_id
        {
            let _ = self.service.stop_agent_session(id);
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if self
                    .service
                    .get_agent_conversation(self.conversation.conversation_id)
                    .is_ok_and(|current| current.active_session_id.is_none())
                {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
}
fn git(repository: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
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
}
struct NoExternalLaunch;
impl ExternalLauncher for NoExternalLaunch {
    fn launch_vscode(&self, _: &Path) -> Result<(), LaunchFailure> {
        panic!("Unexpected external launch")
    }
    fn launch_cli(
        &self,
        _: &Path,
        _: AgentProvider,
        _: TerminalProvider,
    ) -> Result<(), LaunchFailure> {
        panic!("Unexpected external launch")
    }
    fn launch_repository_base(&self, _: &RepositoryBaseTarget) -> Result<(), LaunchFailure> {
        panic!("Unexpected external launch")
    }
    fn launch_change_request_draft(
        &self,
        _: &ChangeRequestDraftTarget,
    ) -> Result<(), LaunchFailure> {
        panic!("Unexpected external launch")
    }
    fn launch_jira_issue(&self, _: &JiraIssueTarget) -> Result<(), LaunchFailure> {
        panic!("Unexpected external launch")
    }
}
