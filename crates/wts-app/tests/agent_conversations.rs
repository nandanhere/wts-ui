#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant},
};

use base64::Engine;
use serde_json::{Value, json};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{
    AgentConversation, AgentConversationCapture, AgentConversationMessageRole,
    AgentConversationMessageStatus, AgentConversationSource, AgentProvider,
    ChangeRequestDraftTarget, CreateAgentConversationRequest, ExternalLauncher, JiraIssueTarget,
    LaunchFailure, LocalWtsError, LocalWtsService, ProcessWorkspaceAdapter, RepositoryBaseTarget,
    SendAgentConversationMessageRequest, TerminalProvider,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

#[test]
fn full_agent_result_and_followup_survive_reopen_in_the_same_dirty_worktree() {
    let fixture = Fixture::new(false);
    let source = fixture.source();
    let create = CreateAgentConversationRequest {
        request_id: Uuid::new_v4(),
        provider: AgentProvider::Codex,
        source: source.clone(),
    };
    let conversation = fixture
        .service
        .create_agent_conversation(create.clone())
        .expect("create conversation");
    assert_eq!(conversation.workspace_id, fixture.workspace_id);
    assert_eq!(conversation.repository_id, fixture.repository_id);
    assert_eq!(
        conversation
            .preview
            .as_ref()
            .map(|preview| preview.url.as_str()),
        Some("http://localhost:1420")
    );
    assert_eq!(
        fixture.service.create_agent_conversation(create).unwrap(),
        conversation
    );

    let first_body = "Fix the selected toolbar. Preserve my current edits.";
    let first_request = Uuid::new_v4();
    let full_response = format!(
        "{}\nFINAL_RESPONSE_TAIL",
        "Complete agent result. ".repeat(250)
    );
    fixture.respond(&full_response, false);
    fixture.send(
        &fixture.service,
        conversation.conversation_id,
        first_request,
        first_body,
    );
    let completed = wait_for_completed(&fixture.service, conversation.conversation_id);
    assert_eq!(completed.messages.len(), 2);
    assert_eq!(completed.messages[1].body, full_response);
    assert_eq!(
        completed.messages[1].status,
        AgentConversationMessageStatus::Completed
    );
    assert!(completed.messages[1].error.is_none());
    assert_eq!(completed.messages[0].body, first_body);
    assert_eq!(fixture.call_count(), 1);
    fixture.assert_process_target(1);
    let first_context = fixture.context(conversation.conversation_id, first_request);
    assert_eq!(first_context["messages"].as_array().unwrap().len(), 1);
    assert_eq!(first_context["messages"][0]["body"], first_body);
    assert_eq!(
        first_context["source"]["selectedText"],
        source_selected_text(&source)
    );
    assert_eq!(
        first_context["source"]["context"],
        "The user selected this region."
    );
    let capture = first_context["source"]["capture"]["artifactPath"]
        .as_str()
        .unwrap();
    assert_eq!(
        Path::new(capture),
        fixture
            .data
            .canonicalize()
            .unwrap()
            .join("agent-conversations-v1")
            .join(format!("{}.png", conversation.conversation_id))
    );
    assert_eq!(fs::read(capture).unwrap(), fixture.capture_bytes());
    assert!(
        fs::read_to_string(fixture.state.join("args.1"))
            .unwrap()
            .contains(&format!("--image\n{capture}\n")),
        "Codex receives the selected screenshot as an image attachment"
    );
    assert!(!first_context.to_string().contains("data:image/png;base64,"));
    assert_eq!(
        fs::metadata(capture).unwrap().permissions().mode() & 0o777,
        0o600
    );

    let reopened = fixture.reopen();
    assert_eq!(
        reopened
            .get_agent_conversation(conversation.conversation_id)
            .unwrap(),
        completed
    );
    assert_eq!(
        reopened.list_agent_conversations().unwrap().conversations,
        vec![completed.clone()]
    );
    assert_eq!(
        fixture.send(
            &reopened,
            conversation.conversation_id,
            first_request,
            first_body
        ),
        completed
    );
    assert_eq!(fixture.call_count(), 1);

    let followup_id = Uuid::new_v4();
    let followup = format!("{} FOLLOWUP_TAIL", "界".repeat(16_000));
    fixture.respond("The follow-up is complete.", false);
    fixture.send(
        &reopened,
        conversation.conversation_id,
        followup_id,
        &followup,
    );
    let followed_up = wait_for_completed(&reopened, conversation.conversation_id);
    assert_eq!(followed_up.messages.len(), 4);
    assert_eq!(followed_up.messages[0..2], completed.messages);
    assert_eq!(followed_up.messages[2].body, followup);
    assert_eq!(followed_up.messages[3].body, "The follow-up is complete.");
    let followup_context = fixture.context(conversation.conversation_id, followup_id);
    assert_eq!(followup_context["messages"].as_array().unwrap().len(), 3);
    assert_eq!(followup_context["messages"][0]["body"], first_body);
    assert_eq!(followup_context["messages"][1]["body"], full_response);
    assert_eq!(followup_context["messages"][2]["body"], followup);
    assert_eq!(followup_context["source"], first_context["source"]);
    assert!(fixture.prompt(2).contains("FOLLOWUP_TAIL"));
    fixture.assert_process_target(2);
    assert_eq!(fixture.call_count(), 2);
    assert_eq!(git(&fixture.worktree, &["rev-parse", "HEAD"]), fixture.head);
    assert_eq!(
        fs::read_to_string(fixture.worktree.join("draft.txt")).unwrap(),
        "unsaved user draft\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.worktree.join("README.md")).unwrap(),
        "user change\nagent edit\nagent edit\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.source_repository.join("README.md")).unwrap(),
        "original\n"
    );
    assert_eq!(
        fixture
            .reopen()
            .get_agent_conversation(conversation.conversation_id)
            .unwrap(),
        followed_up
    );
}

#[test]
fn concurrent_sends_allow_one_process_and_duplicate_replays_never_launch_another() {
    let fixture = Fixture::new(true);
    let conversation = fixture.create();
    let requests = [
        SendAgentConversationMessageRequest {
            request_id: Uuid::new_v4(),
            body: "First requested change".to_owned(),
        },
        SendAgentConversationMessageRequest {
            request_id: Uuid::new_v4(),
            body: "Second requested change".to_owned(),
        },
    ];
    let barrier = Arc::new(Barrier::new(3));
    let workers = requests
        .iter()
        .cloned()
        .map(|request| {
            let service = fixture.service.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                service.send_agent_conversation_message(conversation.conversation_id, request)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert!(results.iter().all(Result::is_ok));
    wait_until(
        || fixture.state.join("started.1").exists(),
        "fake agent starts",
    );
    let pending = fixture
        .service
        .get_agent_conversation(conversation.conversation_id)
        .unwrap();
    assert_eq!(pending.messages.len(), 3);
    assert_eq!(
        pending
            .messages
            .iter()
            .filter(|message| message.status == AgentConversationMessageStatus::Queued)
            .count(),
        1
    );
    assert_eq!(fixture.call_count(), 1);
    for request in &requests {
        fixture
            .service
            .send_agent_conversation_message(conversation.conversation_id, request.clone())
            .unwrap();
        assert!(matches!(
            fixture.service.send_agent_conversation_message(
                conversation.conversation_id,
                SendAgentConversationMessageRequest {
                    request_id: request.request_id,
                    body: "Different body".to_owned()
                }
            ),
            Err(LocalWtsError::AgentConversationConflict)
        ));
    }
    assert_eq!(fixture.call_count(), 1);
    fixture.release();
    let completed = wait_for_completed(&fixture.service, conversation.conversation_id);
    assert_eq!(completed.messages.len(), 4);
    for request in &requests {
        assert_eq!(
            fixture
                .service
                .send_agent_conversation_message(conversation.conversation_id, request.clone())
                .unwrap(),
            completed
        );
    }
    assert_eq!(fixture.call_count(), 2);
}

#[test]
fn failed_agent_output_remains_readable_and_only_an_explicit_followup_starts_a_new_process() {
    let fixture = Fixture::new(false);
    let conversation = fixture.create();
    fixture.respond(
        "Authentication required. Sign in to the selected provider.",
        true,
    );
    let request_id = Uuid::new_v4();
    fixture.send(
        &fixture.service,
        conversation.conversation_id,
        request_id,
        "Review this UI region",
    );
    let failed = wait_for_completed(&fixture.service, conversation.conversation_id);
    assert_eq!(
        failed.messages[1].status,
        AgentConversationMessageStatus::Failed
    );
    assert_eq!(
        failed.messages[1].diagnostic.as_deref().unwrap().trim(),
        "Authentication required. Sign in to the selected provider."
    );
    assert!(failed.messages[1].error.is_some());
    assert_eq!(
        fixture.send(
            &fixture.service,
            conversation.conversation_id,
            request_id,
            "Review this UI region"
        ),
        failed
    );
    assert_eq!(fixture.call_count(), 1);
    fixture.respond("The explicit follow-up completed.", false);
    fixture.send(
        &fixture.service,
        conversation.conversation_id,
        Uuid::new_v4(),
        "I signed in. Continue the review.",
    );
    let retried = wait_for_completed(&fixture.service, conversation.conversation_id);
    assert_eq!(retried.messages.len(), 4);
    assert_eq!(retried.messages[1], failed.messages[1]);
    assert_eq!(
        retried.messages[3].status,
        AgentConversationMessageStatus::Completed
    );
    assert_eq!(fixture.call_count(), 2);
}

#[test]
fn a_reopened_host_keeps_a_live_turn_and_queues_another_conversation_in_its_worktree() {
    let fixture = Fixture::new(true);
    let first = fixture.create();
    let second = fixture.create();
    let first_request_id = Uuid::new_v4();
    let started = fixture.send(
        &fixture.service,
        first.conversation_id,
        first_request_id,
        "Complete the first change",
    );
    wait_until(
        || fixture.state.join("started.1").exists(),
        "fake agent starts",
    );
    let reopened = fixture.reopen();
    let active = reopened
        .get_agent_conversation(first.conversation_id)
        .unwrap();
    assert_eq!(active.active_session_id, started.active_session_id);
    assert!(active.active_session_id.is_some());
    assert!(
        !active
            .messages
            .iter()
            .any(|message| { message.status == AgentConversationMessageStatus::Interrupted })
    );
    let next_request = Uuid::new_v4();
    let queued = fixture.send(
        &reopened,
        second.conversation_id,
        next_request,
        "A second writer must wait",
    );
    assert!(queued.active_session_id.is_none());
    assert_eq!(
        queued.messages[0].status,
        AgentConversationMessageStatus::Queued
    );
    let replayed = fixture.send(
        &reopened,
        first.conversation_id,
        first_request_id,
        "Complete the first change",
    );
    assert_eq!(replayed.messages.len(), 2);
    assert_eq!(replayed.active_session_id, started.active_session_id);
    assert_eq!(fixture.call_count(), 1);
    fixture.release();
    let completed = wait_for_completed(&reopened, first.conversation_id);
    assert_eq!(
        completed.messages[1].status,
        AgentConversationMessageStatus::Completed
    );
    let second_completed = wait_for_completed(&reopened, second.conversation_id);
    assert_eq!(
        second_completed.messages[1].status,
        AgentConversationMessageStatus::Completed
    );
    assert_eq!(fixture.call_count(), 2);
    fixture.assert_process_target(2);
}

struct Fixture {
    service: LocalWtsService,
    _directory: TempDir,
    data: PathBuf,
    repositories: PathBuf,
    workspaces: PathBuf,
    source_repository: PathBuf,
    worktree: PathBuf,
    workspace_id: Uuid,
    repository_id: String,
    state: PathBuf,
    executable: PathBuf,
    head: String,
}

#[test]
fn a_host_configured_checkout_creates_one_dedicated_workspace_and_reuses_its_dirty_files() {
    let fixture = Fixture::new(false);
    let service = open_service(
        &fixture.data,
        &fixture.workspaces,
        &fixture.repositories,
        &fixture.executable,
    );
    let workspace_count = service.list_workspaces().unwrap().workspaces.len();
    assert!(matches!(
        service.create_agent_conversation(CreateAgentConversationRequest {
            request_id: Uuid::new_v4(),
            provider: AgentProvider::Codex,
            source: fixture.source(),
        }),
        Err(LocalWtsError::AgentConversationSourceUnavailable)
    ));
    assert_eq!(
        service.list_workspaces().unwrap().workspaces.len(),
        workspace_count
    );
    assert!(
        service
            .list_agent_conversations()
            .unwrap()
            .conversations
            .is_empty()
    );
    assert!(!fixture.state.join("count").exists());
    service
        .configure_ui_development_repository(
            fixture.source_repository.clone(),
            Some("http://localhost:1420".to_owned()),
        )
        .unwrap();
    let first = service
        .create_agent_conversation(CreateAgentConversationRequest {
            request_id: Uuid::new_v4(),
            provider: AgentProvider::Codex,
            source: fixture.source(),
        })
        .expect("create dedicated UI workspace");
    assert_ne!(first.workspace_id, fixture.workspace_id);
    assert!(first.preview.is_none());
    assert_eq!(
        service.list_workspaces().unwrap().workspaces.len(),
        workspace_count + 1
    );
    let materialization = service
        .get_materialization(first.workspace_id)
        .unwrap()
        .unwrap();
    let worktree = PathBuf::from(&materialization.worktrees[0].target_display_path);
    assert_ne!(worktree, fixture.source_repository);
    assert_ne!(worktree, fixture.worktree);
    fs::write(worktree.join("README.md"), "dedicated user edit\n").unwrap();
    fs::write(worktree.join("draft.txt"), "dedicated draft\n").unwrap();
    drop(service);

    let reopened = open_service(
        &fixture.data,
        &fixture.workspaces,
        &fixture.repositories,
        &fixture.executable,
    );
    reopened
        .configure_ui_development_repository(
            fixture.source_repository.clone(),
            Some("http://localhost:1420".to_owned()),
        )
        .unwrap();
    let second = reopened
        .create_agent_conversation(CreateAgentConversationRequest {
            request_id: Uuid::new_v4(),
            provider: AgentProvider::Codex,
            source: fixture.source(),
        })
        .expect("reuse dedicated UI workspace");
    assert_ne!(second.conversation_id, first.conversation_id);
    assert_eq!(second.workspace_id, first.workspace_id);
    assert_eq!(second.repository_id, first.repository_id);
    assert_eq!(
        reopened.list_workspaces().unwrap().workspaces.len(),
        workspace_count + 1
    );
    fixture.send(
        &reopened,
        second.conversation_id,
        Uuid::new_v4(),
        "Continue the dedicated workspace change",
    );
    let completed = wait_for_completed(&reopened, second.conversation_id);
    assert_eq!(
        completed.messages[1].status,
        AgentConversationMessageStatus::Completed
    );
    let cwd = fs::read_to_string(fixture.state.join("cwd.1")).unwrap();
    assert_eq!(Path::new(cwd.trim()), worktree.canonicalize().unwrap());
    assert_eq!(
        fs::read_to_string(worktree.join("README.md")).unwrap(),
        "dedicated user edit\nagent edit\n"
    );
    assert_eq!(
        fs::read_to_string(worktree.join("draft.txt")).unwrap(),
        "dedicated draft\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.source_repository.join("README.md")).unwrap(),
        "original\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.worktree.join("README.md")).unwrap(),
        "user change\n"
    );
}

impl Fixture {
    fn new(gated: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        let repositories = directory.path().join("repositories");
        let workspaces = directory.path().join("workspaces");
        let state = directory.path().join("fake-agent-state");
        fs::create_dir(&repositories).unwrap();
        fs::create_dir(&state).unwrap();
        let source_repository = repositories.join("app");
        fs::create_dir(&source_repository).unwrap();
        git(&source_repository, &["init", "--initial-branch=main"]);
        git(&source_repository, &["config", "user.name", "WTS Test"]);
        git(
            &source_repository,
            &["config", "user.email", "wts@example.invalid"],
        );
        fs::write(source_repository.join("README.md"), "original\n").unwrap();
        git(&source_repository, &["add", "README.md"]);
        git(&source_repository, &["commit", "-m", "initial"]);
        let executable = directory.path().join("fake-codex");
        fs::write(
            &executable,
            format!(
                r#"#!/bin/sh
set -eu
state={}
count=0
if [ -f "$state/count" ]; then count=$(cat "$state/count"); fi
count=$((count + 1))
printf '%s' "$count" > "$state/count"
trap ': > "$state/finished.$count"' EXIT
pwd -P > "$state/cwd.$count"
printf '%s\n' "$@" > "$state/args.$count"
for arg do prompt=$arg; done
printf '%s' "$prompt" > "$state/prompt.$count"
: > "$state/started.$count"
attempt=0
while [ ! -f "$state/release" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 2000 ]; then exit 91; fi
  sleep 0.01
done
if [ -f "$state/fail" ]; then cat "$state/response" >&2; exit 1; fi
printf 'agent edit\n' >> README.md
cat "$state/response"
printf '\n{{"type":"turn.completed"}}\n'
"#,
                shell_quote(&state)
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let service = open_service(&data, &workspaces, &repositories, &executable);
        let workspace_id = service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::RepositorySet {
                        label: "Conversation fixture".to_owned(),
                    },
                    title: "Conversation fixture".to_owned(),
                    preferred_provider: WorkspaceProvider::Codex,
                    repositories: vec![WorkspaceRepositoryRequest {
                        repository_id: None,
                        label: "app".to_owned(),
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
        let receipt = service
            .materialize_workspace(workspace_id, &preflight.effect_digest)
            .unwrap();
        let worktree = PathBuf::from(&receipt.materialization.worktrees[0].target_display_path);
        let repository_id = receipt.materialization.worktrees[0].repository_id.clone();
        let head = git(&worktree, &["rev-parse", "HEAD"]);
        fs::write(worktree.join("README.md"), "user change\n").unwrap();
        fs::write(worktree.join("draft.txt"), "unsaved user draft\n").unwrap();
        service
            .configure_ui_development_repository(
                worktree.clone(),
                Some("http://localhost:1420".to_owned()),
            )
            .unwrap();
        let fixture = Self {
            service,
            _directory: directory,
            data,
            repositories,
            workspaces,
            source_repository,
            worktree,
            workspace_id,
            repository_id,
            state,
            executable,
            head,
        };
        fixture.respond("The requested change is complete.", false);
        if !gated {
            fixture.release();
        }
        fixture
    }

    fn capture_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[0, 0, 0, 255]).unwrap();
        }
        bytes
    }

    fn source(&self) -> AgentConversationSource {
        AgentConversationSource::Ui {
            route: "/workspaces/example".to_owned(),
            callout_id: "workspace.toolbar".to_owned(),
            label: "Workspace toolbar".to_owned(),
            selected_text: Some(format!("{} SOURCE_TAIL", "界".repeat(12_000))),
            context: Some("The user selected this region.".to_owned()),
            capture: Some(AgentConversationCapture {
                mime_type: "image/png".to_owned(),
                data_url: format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(self.capture_bytes())
                ),
                width: 1,
                height: 1,
            }),
        }
    }

    fn create(&self) -> AgentConversation {
        self.service
            .create_agent_conversation(CreateAgentConversationRequest {
                request_id: Uuid::new_v4(),
                provider: AgentProvider::Codex,
                source: self.source(),
            })
            .unwrap()
    }

    fn send(
        &self,
        service: &LocalWtsService,
        id: Uuid,
        request_id: Uuid,
        body: &str,
    ) -> AgentConversation {
        service
            .send_agent_conversation_message(
                id,
                SendAgentConversationMessageRequest {
                    request_id,
                    body: body.to_owned(),
                },
            )
            .expect("send conversation message")
    }

    fn reopen(&self) -> LocalWtsService {
        let service = open_service(
            &self.data,
            &self.workspaces,
            &self.repositories,
            &self.executable,
        );
        service
            .configure_ui_development_repository(
                self.worktree.clone(),
                Some("http://localhost:1420".to_owned()),
            )
            .unwrap();
        service
    }

    fn respond(&self, body: &str, failed: bool) {
        if failed {
            fs::write(self.state.join("fail"), "").unwrap();
            fs::write(self.state.join("response"), body).unwrap();
        } else {
            let _ = fs::remove_file(self.state.join("fail"));
            fs::write(
                self.state.join("response"),
                format!(
                    "{}\n",
                    json!({"type":"item.completed","item":{"type":"agent_message","text":body}})
                ),
            )
            .unwrap();
        }
    }

    fn release(&self) {
        fs::write(self.state.join("release"), "").unwrap();
    }

    fn call_count(&self) -> usize {
        fs::read_to_string(self.state.join("count"))
            .unwrap()
            .parse()
            .unwrap()
    }

    fn prompt(&self, call: usize) -> String {
        fs::read_to_string(self.state.join(format!("prompt.{call}"))).unwrap()
    }

    fn context(&self, id: Uuid, request: Uuid) -> Value {
        let path = self
            .data
            .join("agent-conversations-v1")
            .join(format!("{id}-{request}.context.json"));
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(
            self.prompt(self.call_count())
                .contains(path.to_str().unwrap())
        );
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn assert_process_target(&self, call: usize) {
        let cwd = fs::read_to_string(self.state.join(format!("cwd.{call}"))).unwrap();
        assert_eq!(Path::new(cwd.trim()), self.worktree.canonicalize().unwrap());
        let args = fs::read_to_string(self.state.join(format!("args.{call}"))).unwrap();
        assert!(args.starts_with("exec\n--ephemeral\n--json\n"));
        assert!(args.contains("--sandbox\nworkspace-write\n"));
        assert!(args.contains("approval_policy=\"never\""));
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::write(self.state.join("release"), "");
        let Ok(count) = fs::read_to_string(self.state.join("count")) else {
            return;
        };
        let finished = self.state.join(format!("finished.{count}"));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !finished.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn source_selected_text(source: &AgentConversationSource) -> &str {
    match source {
        AgentConversationSource::Ui {
            selected_text: Some(text),
            ..
        } => text,
        _ => panic!("UI source"),
    }
}

fn wait_for_completed(service: &LocalWtsService, id: Uuid) -> AgentConversation {
    wait_until(
        || {
            let conversation = service.get_agent_conversation(id).unwrap();
            conversation.active_session_id.is_none()
                && !conversation
                    .messages
                    .iter()
                    .any(|message| message.status == AgentConversationMessageStatus::Queued)
        },
        "agent turn completes",
    );
    let result = service.get_agent_conversation(id).unwrap();
    assert!(
        result
            .messages
            .iter()
            .any(|message| message.role == AgentConversationMessageRole::Assistant)
    );
    result
}

fn wait_until(mut condition: impl FnMut() -> bool, label: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !condition() {
        assert!(Instant::now() < deadline, "{label}");
        thread::sleep(Duration::from_millis(10));
    }
}

fn open_service(
    data: &Path,
    workspaces: &Path,
    repositories: &Path,
    executable: &Path,
) -> LocalWtsService {
    LocalWtsService::open_with_repository_roots_launcher_and_adapter(
        data,
        "test",
        workspaces,
        [repositories.to_owned()],
        NoExternalLaunch,
        ProcessWorkspaceAdapter::default()
            .with_agent_executable(AgentProvider::Codex, executable.to_owned()),
    )
    .expect("fixture service")
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
}

fn git(repository: &Path, args: &[&str]) -> String {
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
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

struct NoExternalLaunch;

impl ExternalLauncher for NoExternalLaunch {
    fn launch_vscode(&self, _: &Path) -> Result<(), LaunchFailure> {
        panic!("unexpected external launch")
    }
    fn launch_cli(
        &self,
        _: &Path,
        _: AgentProvider,
        _: TerminalProvider,
    ) -> Result<(), LaunchFailure> {
        panic!("unexpected external launch")
    }
    fn launch_repository_base(&self, _: &RepositoryBaseTarget) -> Result<(), LaunchFailure> {
        panic!("unexpected external launch")
    }
    fn launch_change_request_draft(
        &self,
        _: &ChangeRequestDraftTarget,
    ) -> Result<(), LaunchFailure> {
        panic!("unexpected external launch")
    }
    fn launch_jira_issue(&self, _: &JiraIssueTarget) -> Result<(), LaunchFailure> {
        panic!("unexpected external launch")
    }
}
