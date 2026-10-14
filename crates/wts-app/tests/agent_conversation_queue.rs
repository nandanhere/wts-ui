#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{
    AgentConversation, AgentConversationMessage, AgentConversationMessageRole,
    AgentConversationSource, AgentProvider, CancelAgentConversationMessageRequest,
    ChangeRequestDraftTarget, CreateAgentConversationRequest, ExternalLauncher, JiraIssueTarget,
    LaunchFailure, LocalWtsError, LocalWtsService, ProcessWorkspaceAdapter, RepositoryBaseTarget,
    SendAgentConversationMessageRequest, TerminalProvider, UpdateAgentConversationMessageRequest,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

#[test]
fn selected_regions_share_only_completed_feedback_for_the_same_execution_target() {
    let fixture = QueueFixture::new();
    let other_repository = fixture.conversation(0, 1, "OTHER_REPOSITORY_CONTEXT");
    let other_workspace = fixture.conversation(1, 0, "OTHER_WORKSPACE_CONTEXT");
    let other_provider =
        fixture.conversation_with_provider(0, 0, "OTHER_PROVIDER_CONTEXT", AgentProvider::OpenCode);
    for (index, conversation) in [&other_repository, &other_workspace, &other_provider]
        .into_iter()
        .enumerate()
    {
        let call = index + 1;
        fixture.send(
            &fixture.service,
            conversation,
            &message("UNRELATED_REQUEST"),
        );
        fixture.wait_for_call(call);
        fixture.release(call);
        fixture.wait_for_idle(conversation);
    }

    let first = fixture.conversation(0, 0, "Earlier selected region");
    let current = fixture.conversation(0, 0, "Current selected region");
    let original = message("FIRST_REGION_REQUEST");
    let next = message("CURRENT_REGION_REQUEST");
    let future = message("FUTURE_REQUEST_MUST_NOT_LEAK");
    let cancelled = message("CANCELLED_REQUEST_MUST_NOT_LEAK");
    let full_reply = format!(
        "{} COMPLETE_PRIOR_TAIL",
        "The first fix and its tests. ".repeat(200)
    );
    fixture.response(4, &full_reply, false);
    fixture.send(&fixture.service, &first, &original);
    fixture.wait_for_call(4);
    fixture.send(&fixture.service, &current, &next);
    fixture.send(&fixture.service, &first, &future);
    let accepted = fixture.send(&fixture.service, &first, &cancelled);
    fixture.cancel(&first, &accepted, &cancelled);
    let reopened = fixture.reopen();
    fixture.release(4);
    fixture.wait_for_call(5);

    let context = fixture.context(5, &current, &next);
    assert_eq!(context["source"]["label"], "Current selected region");
    assert_eq!(bodies(&context), vec!["CURRENT_REGION_REQUEST"]);
    let prior = &context["priorFeedback"];
    assert_eq!(prior["omittedTurnCount"], 0);
    let turns = prior["turns"].as_array().expect("shared feedback history");
    assert_eq!(turns.len(), 1);
    assert_eq!(
        turns[0]["conversationId"],
        first.conversation_id.to_string()
    );
    assert_eq!(turns[0]["source"]["label"], "Earlier selected region");
    assert_eq!(bodies(&turns[0]), vec!["FIRST_REGION_REQUEST", &full_reply]);
    let serialized = context.to_string();
    for excluded in [
        "OTHER_REPOSITORY_CONTEXT",
        "OTHER_WORKSPACE_CONTEXT",
        "OTHER_PROVIDER_CONTEXT",
        "UNRELATED_REQUEST",
        "FUTURE_REQUEST_MUST_NOT_LEAK",
        "CANCELLED_REQUEST_MUST_NOT_LEAK",
        "submittedBody",
    ] {
        assert!(
            !serialized.contains(excluded),
            "unexpected context: {excluded}"
        );
    }
    let prompt = fs::read_to_string(fixture.state.join("prompt.5")).unwrap();
    assert!(prompt.contains("priorFeedback"));
    let latest = reopened
        .get_agent_conversation(first.conversation_id)
        .unwrap();
    fixture.cancel(&first, &latest, &future);
    fixture.release(5);
    fixture.wait_for_idle(&current);
    assert_eq!(fixture.call_count(), 5);
}

#[test]
fn workspace_fifo_survives_reopen_and_dispatch_uses_only_the_conversations_prior_turns() {
    let fixture = QueueFixture::new();
    let first = fixture.conversation(0, 0, "First selected region");
    let other = fixture.conversation(0, 1, "Second selected region");
    let initial = message("INITIAL_TASK");
    let next_repository = message("NEXT_REPOSITORY_TASK");
    let followup = message("FOLLOWUP_TASK");
    let future = message("FUTURE_TASK_MUST_NOT_LEAK");
    let full_reply = format!("{} RESPONSE_TAIL", "Complete first answer. ".repeat(200));
    fixture.response(1, &full_reply, false);
    fixture.send(&fixture.service, &first, &initial);
    fixture.wait_for_call(1);

    let queued_other = fixture.send(&fixture.service, &other, &next_repository);
    assert!(
        queued_other.active_session_id.is_none(),
        "another repository in the same workspace must wait"
    );
    fixture.send(&fixture.service, &first, &followup);
    fixture.send(&fixture.service, &first, &future);
    assert_eq!(fixture.call_count(), 1);

    let reopened = fixture.reopen();
    fixture.send(&reopened, &other, &next_repository);
    fixture.release(1);
    fixture.wait_for_call(2);
    fixture.assert_target(2, 0, 1);
    let other_context = fixture.context(2, &other, &next_repository);
    assert_eq!(other_context["source"]["label"], "Second selected region");
    assert_eq!(bodies(&other_context), vec!["NEXT_REPOSITORY_TASK"]);
    assert!(!other_context.to_string().contains("INITIAL_TASK"));

    fixture.release(2);
    fixture.wait_for_call(3);
    fixture.assert_target(3, 0, 0);
    let followup_context = fixture.context(3, &first, &followup);
    assert_eq!(followup_context["source"]["label"], "First selected region");
    assert_eq!(
        bodies(&followup_context),
        vec!["INITIAL_TASK", full_reply.as_str(), "FOLLOWUP_TASK"]
    );
    assert!(
        !followup_context
            .to_string()
            .contains("FUTURE_TASK_MUST_NOT_LEAK")
    );
    assert!(
        !followup_context
            .to_string()
            .contains("NEXT_REPOSITORY_TASK")
    );
    fixture.release(3);
    fixture.wait_for_call(4);
    let future_context = fixture.context(4, &first, &future);
    assert_eq!(
        bodies(&future_context),
        vec![
            "INITIAL_TASK",
            full_reply.as_str(),
            "FOLLOWUP_TASK",
            "Completed turn 3",
            "FUTURE_TASK_MUST_NOT_LEAK"
        ]
    );
    fixture.release(4);
    wait_until(
        || {
            reopened
                .get_agent_conversation(first.conversation_id)
                .unwrap()
                .active_session_id
                .is_none()
        },
        "last queued turn completes",
    );
    assert_eq!(fixture.call_count(), 4);
    assert_eq!(
        fs::read_to_string(fixture.targets[0][0].join("draft.txt")).unwrap(),
        "User draft stays here.\n"
    );
}

#[test]
fn queued_edits_and_cancellation_keep_retry_identity_without_reverting_or_resurrecting_tasks() {
    let fixture = QueueFixture::new();
    let active = fixture.conversation(0, 0, "Active context");
    let queued = fixture.conversation(0, 1, "Queued context");
    fixture.send(&fixture.service, &active, &message("ACTIVE_TASK"));
    fixture.wait_for_call(1);
    let edit_request = message("ORIGINAL_SUBMITTED_TASK");
    let cancel_request = message("CANCELLED_TASK_MUST_NOT_LEAK");
    let final_request = message("FINAL_QUEUED_TASK");
    let accepted = fixture.send(&fixture.service, &queued, &edit_request);
    let edit_id = user_message(&accepted, edit_request.request_id).message_id;
    let accepted = fixture.send(&fixture.service, &queued, &cancel_request);
    let cancel_id = user_message(&accepted, cancel_request.request_id).message_id;
    fixture.send(&fixture.service, &queued, &final_request);

    let first_edit = UpdateAgentConversationMessageRequest {
        request_id: Uuid::new_v4(),
        expected_body: edit_request.body.clone(),
        body: "FIRST_EDIT".to_owned(),
    };
    fixture
        .service
        .update_agent_conversation_message(queued.conversation_id, edit_id, first_edit.clone())
        .unwrap();
    let second_edit = UpdateAgentConversationMessageRequest {
        request_id: Uuid::new_v4(),
        expected_body: first_edit.body.clone(),
        body: "FINAL_EDIT_FOR_DISPATCH".to_owned(),
    };
    fixture
        .service
        .update_agent_conversation_message(queued.conversation_id, edit_id, second_edit.clone())
        .unwrap();
    assert!(
        fixture
            .service
            .update_agent_conversation_message(queued.conversation_id, edit_id, first_edit.clone())
            .is_err()
    );
    let current = fixture
        .service
        .get_agent_conversation(queued.conversation_id)
        .unwrap();
    assert_eq!(
        user_message(&current, edit_request.request_id).body,
        second_edit.body
    );
    assert!(
        fixture
            .service
            .update_agent_conversation_message(
                queued.conversation_id,
                edit_id,
                UpdateAgentConversationMessageRequest {
                    request_id: Uuid::new_v4(),
                    expected_body: edit_request.body.clone(),
                    body: "Stale overwrite".to_owned(),
                }
            )
            .is_err()
    );
    let replay = fixture.send(&fixture.service, &queued, &edit_request);
    assert_eq!(
        user_message(&replay, edit_request.request_id).body,
        second_edit.body
    );
    assert_eq!(
        serde_json::to_value(user_message(&replay, edit_request.request_id)).unwrap()["submittedBody"],
        edit_request.body
    );

    let cancellation = CancelAgentConversationMessageRequest {
        request_id: Uuid::new_v4(),
        expected_body: cancel_request.body.clone(),
    };
    fixture
        .service
        .cancel_agent_conversation_message(queued.conversation_id, cancel_id, cancellation.clone())
        .unwrap();
    let replay = fixture.send(&fixture.service, &queued, &cancel_request);
    assert_eq!(
        message_status(user_message(&replay, cancel_request.request_id)),
        "cancelled"
    );
    assert_eq!(fixture.call_count(), 1);

    fixture.release(1);
    fixture.wait_for_call(2);
    assert_eq!(
        bodies(&fixture.context(2, &queued, &edit_request)),
        vec!["FINAL_EDIT_FOR_DISPATCH"]
    );
    let replay = fixture
        .service
        .update_agent_conversation_message(queued.conversation_id, edit_id, second_edit.clone())
        .unwrap();
    assert_eq!(
        user_message(&replay, edit_request.request_id).body,
        second_edit.body
    );
    assert!(
        fixture
            .service
            .update_agent_conversation_message(
                queued.conversation_id,
                edit_id,
                UpdateAgentConversationMessageRequest {
                    request_id: Uuid::new_v4(),
                    expected_body: second_edit.body.clone(),
                    body: "Too late to edit".to_owned(),
                }
            )
            .is_err()
    );
    assert!(
        fixture
            .service
            .cancel_agent_conversation_message(
                queued.conversation_id,
                edit_id,
                CancelAgentConversationMessageRequest {
                    request_id: Uuid::new_v4(),
                    expected_body: second_edit.body.clone(),
                }
            )
            .is_err()
    );
    fixture
        .service
        .cancel_agent_conversation_message(queued.conversation_id, cancel_id, cancellation)
        .unwrap();
    fixture.release(2);
    fixture.wait_for_call(3);
    let final_context = fixture.context(3, &queued, &final_request);
    assert_eq!(
        bodies(&final_context),
        vec![
            "FINAL_EDIT_FOR_DISPATCH",
            "Completed turn 2",
            "FINAL_QUEUED_TASK"
        ]
    );
    assert!(
        !final_context
            .to_string()
            .contains("CANCELLED_TASK_MUST_NOT_LEAK")
    );
    assert!(
        !final_context
            .to_string()
            .contains("ORIGINAL_SUBMITTED_TASK")
    );
    fixture.release(3);
    wait_until(
        || {
            fixture
                .service
                .get_agent_conversation(queued.conversation_id)
                .unwrap()
                .active_session_id
                .is_none()
        },
        "the final permitted turn completes",
    );
    assert_eq!(fixture.call_count(), 3);
}

#[test]
fn another_workspace_runs_independently_and_a_failed_turn_does_not_poison_the_next_task() {
    let fixture = QueueFixture::new();
    let active = fixture.conversation(0, 0, "Failing context");
    let next = fixture.conversation(0, 1, "Next context");
    let independent = fixture.conversation(1, 0, "Independent context");
    fixture.response(1, "The first provider turn failed.", true);
    fixture.send(&fixture.service, &active, &message("FAIL_THIS_TURN"));
    fixture.wait_for_call(1);
    fixture.send(
        &fixture.service,
        &next,
        &message("CONTINUE_IN_THIS_WORKSPACE"),
    );
    fixture.send(
        &fixture.service,
        &independent,
        &message("INDEPENDENT_WORKSPACE_TASK"),
    );
    fixture.wait_for_call(2);
    fixture.assert_target(2, 1, 0);
    assert!(
        fixture
            .service
            .get_agent_conversation(active.conversation_id)
            .unwrap()
            .active_session_id
            .is_some()
    );
    fixture.release(2);
    wait_until(
        || {
            fixture
                .service
                .get_agent_conversation(independent.conversation_id)
                .unwrap()
                .active_session_id
                .is_none()
        },
        "the independent task completes",
    );
    assert_eq!(fixture.call_count(), 2);
    fixture.release(1);
    fixture.wait_for_call(3);
    fixture.assert_target(3, 0, 1);
    let failed = fixture
        .service
        .get_agent_conversation(active.conversation_id)
        .unwrap();
    let response = failed
        .messages
        .iter()
        .find(|item| item.role == AgentConversationMessageRole::Assistant)
        .unwrap();
    assert_eq!(message_status(response), "failed");
    assert!(response.body.is_empty());
    assert_eq!(
        response.diagnostic.as_deref().unwrap().trim(),
        "The first provider turn failed."
    );
    fixture.release(3);
    wait_until(
        || {
            fixture
                .service
                .get_agent_conversation(next.conversation_id)
                .unwrap()
                .active_session_id
                .is_none()
        },
        "the next task completes after failure",
    );
    assert_eq!(fixture.call_count(), 3);
}

#[test]
fn an_orphaned_provider_keeps_the_workspace_lease_until_exit_then_the_saved_queue_continues() {
    let directory = tempfile::tempdir().unwrap();
    let output = fs::File::create(directory.path().join("host.log")).unwrap();
    let mut host = TestHost(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "queue_orphan_host_fixture", "--nocapture"])
            .env("WTS_QUEUE_HOST_TEST_ROOT", directory.path())
            .stdout(output.try_clone().unwrap())
            .stderr(output)
            .spawn()
            .unwrap(),
    );
    let ready = directory.path().join("host-ready.json");
    wait_until(
        || {
            if let Some(status) = host.0.try_wait().unwrap() {
                panic!(
                    "queue host exited early: {status}: {}",
                    fs::read_to_string(directory.path().join("host.log")).unwrap()
                );
            }
            ready.exists()
        },
        "the fixture host accepts both tasks",
    );
    let details: Value = serde_json::from_slice(&fs::read(ready).unwrap()).unwrap();
    let state = PathBuf::from(details["state"].as_str().unwrap());
    let cleanup = ProcessCleanup(state.clone());
    assert_eq!(
        fs::read_to_string(state.join("parent.1")).unwrap().trim(),
        host.0.id().to_string()
    );
    host.0.kill().unwrap();
    host.0.wait().unwrap();

    let reopened = open_service(
        Path::new(details["data"].as_str().unwrap()),
        Path::new(details["workspaces"].as_str().unwrap()),
        Path::new(details["repositories"].as_str().unwrap()),
        Path::new(details["executable"].as_str().unwrap()),
    );
    let active_id = Uuid::parse_str(details["activeId"].as_str().unwrap()).unwrap();
    let queued_id = Uuid::parse_str(details["queuedId"].as_str().unwrap()).unwrap();
    let original_request: SendAgentConversationMessageRequest =
        serde_json::from_value(details["originalRequest"].clone()).unwrap();
    assert!(
        reopened
            .get_agent_conversation(active_id)
            .unwrap()
            .active_session_id
            .is_some()
    );
    let queued = reopened.get_agent_conversation(queued_id).unwrap();
    assert!(queued.active_session_id.is_none());
    assert_eq!(fs::read_to_string(state.join("count")).unwrap(), "1");
    fs::write(state.join("release.1"), "").unwrap();
    wait_until(
        || state.join("started.2").exists(),
        "the restarted host advances after the orphan exits",
    );
    let interrupted = reopened.get_agent_conversation(active_id).unwrap();
    assert_eq!(
        message_status(user_message(&interrupted, original_request.request_id)),
        "interrupted"
    );
    assert!(interrupted.active_session_id.is_none());
    assert_eq!(
        Path::new(fs::read_to_string(state.join("cwd.2")).unwrap().trim()),
        Path::new(details["queuedTarget"].as_str().unwrap())
            .canonicalize()
            .unwrap()
    );
    let replay = reopened
        .send_agent_conversation_message(active_id, original_request.clone())
        .unwrap();
    assert_eq!(
        message_status(user_message(&replay, original_request.request_id)),
        "interrupted"
    );
    fs::write(state.join("release.2"), "").unwrap();
    wait_until(
        || {
            reopened
                .get_agent_conversation(queued_id)
                .unwrap()
                .active_session_id
                .is_none()
        },
        "the saved task finishes",
    );
    assert_eq!(fs::read_to_string(state.join("count")).unwrap(), "2");
    drop(cleanup);
}

#[test]
fn pending_tasks_remain_visible_past_history_and_cancelling_frees_a_full_workspace_queue() {
    let fixture = QueueFixture::new();
    let active = fixture.conversation(0, 0, "Active before newer history");
    let queued = fixture.conversation(0, 1, "Queued before newer history");
    fixture.send(&fixture.service, &active, &message("ACTIVE_TASK"));
    fixture.wait_for_call(1);
    let first_request = message("FIRST_QUEUED_TASK");
    fixture.send(&fixture.service, &queued, &first_request);
    for index in 0..55 {
        fixture.conversation(0, 0, &format!("Newer empty history {index}"));
    }
    let listed = fixture.service.list_agent_conversations().unwrap();
    assert_eq!(listed.conversations.len(), 52);
    assert!(
        listed
            .conversations
            .iter()
            .any(|item| item.conversation_id == active.conversation_id)
    );
    let visible_queue = listed
        .conversations
        .iter()
        .find(|item| item.conversation_id == queued.conversation_id)
        .expect("pending tasks remain visible beyond fifty newer history records");
    assert_eq!(
        user_message(visible_queue, first_request.request_id).queue_position,
        Some(1)
    );

    for index in 1..64 {
        fixture.send(
            &fixture.service,
            &queued,
            &message(&format!("QUEUED_TASK_{index}")),
        );
    }
    let overflow = message("OVERFLOW_TASK");
    assert!(matches!(
        fixture
            .service
            .send_agent_conversation_message(queued.conversation_id, overflow.clone()),
        Err(LocalWtsError::AgentConversationQueueFull)
    ));
    let full = fixture
        .service
        .get_agent_conversation(queued.conversation_id)
        .unwrap();
    assert_eq!(full.messages.len(), 64);
    assert!(
        !full
            .messages
            .iter()
            .any(|item| item.request_id == Some(overflow.request_id))
    );
    let first = user_message(&full, first_request.request_id);
    fixture
        .service
        .cancel_agent_conversation_message(
            queued.conversation_id,
            first.message_id,
            CancelAgentConversationMessageRequest {
                request_id: Uuid::new_v4(),
                expected_body: first.body.clone(),
            },
        )
        .unwrap();
    let accepted = fixture.send(&fixture.service, &queued, &overflow);
    assert_eq!(
        user_message(&accepted, overflow.request_id).queue_position,
        Some(64)
    );
    assert_eq!(fixture.call_count(), 1);
    for item in accepted
        .messages
        .iter()
        .filter(|item| message_status(item) == "queued")
    {
        fixture
            .service
            .cancel_agent_conversation_message(
                queued.conversation_id,
                item.message_id,
                CancelAgentConversationMessageRequest {
                    request_id: Uuid::new_v4(),
                    expected_body: item.body.clone(),
                },
            )
            .unwrap();
    }
    fixture.release(1);
    wait_until(
        || {
            fixture
                .service
                .get_agent_conversation(active.conversation_id)
                .unwrap()
                .active_session_id
                .is_none()
        },
        "the only running task finishes",
    );
    assert_eq!(fixture.call_count(), 1);
}

#[test]
fn queue_orphan_host_fixture() {
    let Some(root) = std::env::var_os("WTS_QUEUE_HOST_TEST_ROOT").map(PathBuf::from) else {
        return;
    };
    let fixture = QueueFixture::in_directory(tempfile::tempdir_in(&root).unwrap());
    let active = fixture.conversation(0, 0, "Orphan context");
    let queued = fixture.conversation(0, 1, "Saved queue context");
    let request = message("DO_NOT_REPLAY_THE_ORPHAN");
    fixture.send(&fixture.service, &active, &request);
    fixture.wait_for_call(1);
    fixture.send(&fixture.service, &queued, &message("RUN_AFTER_ORPHAN_EXIT"));
    let details = json!({
        "state": fixture.state, "data": fixture.data, "workspaces": fixture.workspaces,
        "repositories": fixture.repositories, "executable": fixture.executable,
        "activeId": active.conversation_id, "queuedId": queued.conversation_id,
        "queuedTarget": fixture.targets[0][1], "originalRequest": request,
    });
    let temporary = root.join("host-ready.tmp");
    fs::write(&temporary, serde_json::to_vec(&details).unwrap()).unwrap();
    fs::rename(temporary, root.join("host-ready.json")).unwrap();
    loop {
        thread::sleep(Duration::from_secs(1));
    }
}

struct TestHost(std::process::Child);
impl Drop for TestHost {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct ProcessCleanup(PathBuf);
impl Drop for ProcessCleanup {
    fn drop(&mut self) {
        let _ = fs::write(self.0.join("release-all"), "");
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let count = fs::read_to_string(self.0.join("count"))
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            if (1..=count).all(|call| self.0.join(format!("finished.{call}")).exists()) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn user_message(conversation: &AgentConversation, request_id: Uuid) -> &AgentConversationMessage {
    conversation
        .messages
        .iter()
        .find(|message| {
            message.role == AgentConversationMessageRole::User
                && message.request_id == Some(request_id)
        })
        .unwrap()
}

fn message_status(message: &AgentConversationMessage) -> String {
    serde_json::to_value(message).unwrap()["status"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn message(body: &str) -> SendAgentConversationMessageRequest {
    SendAgentConversationMessageRequest {
        request_id: Uuid::new_v4(),
        body: body.to_owned(),
    }
}

fn bodies(context: &Value) -> Vec<&str> {
    context["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| message["body"].as_str().unwrap())
        .collect()
}

struct QueueFixture {
    service: LocalWtsService,
    _directory: TempDir,
    data: PathBuf,
    repositories: PathBuf,
    workspaces: PathBuf,
    state: PathBuf,
    executable: PathBuf,
    workspace_ids: Vec<Uuid>,
    targets: Vec<Vec<PathBuf>>,
}

impl QueueFixture {
    fn new() -> Self {
        Self::in_directory(tempfile::tempdir().unwrap())
    }

    fn in_directory(directory: TempDir) -> Self {
        let data = directory.path().join("data");
        let repositories = directory.path().join("repositories");
        let workspaces = directory.path().join("workspaces");
        let state = directory.path().join("fake-process");
        fs::create_dir(&repositories).unwrap();
        fs::create_dir(&state).unwrap();
        for name in ["api", "web"] {
            let repository = repositories.join(name);
            fs::create_dir(&repository).unwrap();
            git(&repository, &["init", "--initial-branch=main"]);
            git(&repository, &["config", "user.name", "WTS Test"]);
            git(
                &repository,
                &["config", "user.email", "wts@example.invalid"],
            );
            fs::write(repository.join("README.md"), "Original source.\n").unwrap();
            git(&repository, &["add", "README.md"]);
            git(&repository, &["commit", "-m", "Initial"]);
        }
        let executable = directory.path().join("fake-codex");
        fs::write(&executable, format!(r#"#!/bin/sh
set -eu
state={}
attempt=0
until mkdir "$state/journal-lock" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 2000 ]; then exit 90; fi
  sleep 0.01
done
count=0
if [ -f "$state/count" ]; then count=$(cat "$state/count"); fi
count=$((count + 1))
printf '%s' "$count" > "$state/count.tmp"
mv "$state/count.tmp" "$state/count"
trap ': > "$state/finished.$count"' EXIT
pwd -P > "$state/cwd.$count"
printf '%s' "$PPID" > "$state/parent.$count"
for arg do prompt=$arg; done
printf '%s' "$prompt" > "$state/prompt.$count"
: > "$state/started.$count"
rmdir "$state/journal-lock"
attempt=0
while [ ! -f "$state/release.$count" ] && [ ! -f "$state/release-all" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 3000 ]; then exit 91; fi
  sleep 0.01
done
if [ -f "$state/fail.$count" ]; then cat "$state/response.$count" >&2; exit 1; fi
printf 'Agent completed turn %s.\n' "$count" >> agent-edits.txt
if [ -f "$state/response.$count" ]; then
  cat "$state/response.$count"
else
  printf '{{"type":"item.completed","item":{{"type":"agent_message","text":"Completed turn %s"}}}}\n' "$count"
fi
printf '\n{{"type":"turn.completed"}}\n' 
"#, quote(&state))).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let service = open_service(&data, &workspaces, &repositories, &executable);
        let mut workspace_ids = Vec::new();
        let mut targets = Vec::new();
        for title in ["First queue workspace", "Independent queue workspace"] {
            let workspace_id = service
                .create_workspace(
                    &Uuid::new_v4().to_string(),
                    CreateWorkspaceRequest {
                        intent: WorkspaceIntent::RepositorySet {
                            label: title.to_owned(),
                        },
                        title: title.to_owned(),
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
            let worktrees = receipt
                .materialization
                .worktrees
                .iter()
                .map(|worktree| PathBuf::from(&worktree.target_display_path))
                .collect::<Vec<_>>();
            for worktree in &worktrees {
                fs::write(worktree.join("draft.txt"), "User draft stays here.\n").unwrap();
            }
            workspace_ids.push(workspace_id);
            targets.push(worktrees);
        }
        Self {
            service,
            _directory: directory,
            data,
            repositories,
            workspaces,
            state,
            executable,
            workspace_ids,
            targets,
        }
    }

    fn conversation(&self, workspace: usize, repository: usize, label: &str) -> AgentConversation {
        self.conversation_with_provider(workspace, repository, label, AgentProvider::Codex)
    }

    fn conversation_with_provider(
        &self,
        workspace: usize,
        repository: usize,
        label: &str,
        provider: AgentProvider,
    ) -> AgentConversation {
        self.service
            .configure_ui_development_repository(self.targets[workspace][repository].clone(), None)
            .unwrap();
        let result = self
            .service
            .create_agent_conversation(CreateAgentConversationRequest {
                request_id: Uuid::new_v4(),
                provider,
                source: AgentConversationSource::Ui {
                    route: "/queue-test".to_owned(),
                    callout_id: "queue.fixture".to_owned(),
                    label: label.to_owned(),
                    selected_text: Some(format!("Original context for {label}")),
                    context: None,
                    capture: None,
                },
            })
            .unwrap();
        assert_eq!(result.workspace_id, self.workspace_ids[workspace]);
        result
    }

    fn wait_for_idle(&self, conversation: &AgentConversation) {
        wait_until(
            || {
                self.service
                    .get_agent_conversation(conversation.conversation_id)
                    .unwrap()
                    .active_session_id
                    .is_none()
            },
            "the selected turn completes",
        );
    }

    fn cancel(
        &self,
        conversation: &AgentConversation,
        accepted: &AgentConversation,
        request: &SendAgentConversationMessageRequest,
    ) {
        self.service
            .cancel_agent_conversation_message(
                conversation.conversation_id,
                user_message(accepted, request.request_id).message_id,
                CancelAgentConversationMessageRequest {
                    request_id: Uuid::new_v4(),
                    expected_body: request.body.clone(),
                },
            )
            .unwrap();
    }

    fn send(
        &self,
        service: &LocalWtsService,
        conversation: &AgentConversation,
        request: &SendAgentConversationMessageRequest,
    ) -> AgentConversation {
        service
            .send_agent_conversation_message(conversation.conversation_id, request.clone())
            .expect("accept the task into its workspace queue")
    }

    fn reopen(&self) -> LocalWtsService {
        open_service(
            &self.data,
            &self.workspaces,
            &self.repositories,
            &self.executable,
        )
    }

    fn call_count(&self) -> usize {
        fs::read_to_string(self.state.join("count"))
            .map(|value| value.parse().unwrap())
            .unwrap_or(0)
    }

    fn wait_for_call(&self, call: usize) {
        wait_until(
            || self.state.join(format!("started.{call}")).exists(),
            "the next permitted process starts",
        );
        assert_eq!(self.call_count(), call);
    }

    fn release(&self, call: usize) {
        fs::write(self.state.join(format!("release.{call}")), "").unwrap();
    }

    fn response(&self, call: usize, body: &str, failed: bool) {
        if failed {
            fs::write(self.state.join(format!("fail.{call}")), "").unwrap();
            fs::write(self.state.join(format!("response.{call}")), body).unwrap();
        } else {
            fs::write(
                self.state.join(format!("response.{call}")),
                format!(
                    "{}\n",
                    json!({"type":"item.completed","item":{"type":"agent_message","text":body}})
                ),
            )
            .unwrap();
        }
    }

    fn assert_target(&self, call: usize, workspace: usize, repository: usize) {
        let cwd = fs::read_to_string(self.state.join(format!("cwd.{call}"))).unwrap();
        assert_eq!(
            Path::new(cwd.trim()),
            self.targets[workspace][repository].canonicalize().unwrap()
        );
    }

    fn context(
        &self,
        call: usize,
        conversation: &AgentConversation,
        request: &SendAgentConversationMessageRequest,
    ) -> Value {
        let path = self.data.join("agent-conversations-v1").join(format!(
            "{}-{}.context.json",
            conversation.conversation_id, request.request_id
        ));
        let prompt = fs::read_to_string(self.state.join(format!("prompt.{call}"))).unwrap();
        let encoded_path = prompt
            .split_once("JSON file at ")
            .expect("agent prompt names the context artifact")
            .1;
        let actual_path = serde_json::Deserializer::from_str(encoded_path)
            .into_iter::<String>()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(Path::new(&actual_path), path.canonicalize().unwrap());
        serde_json::from_slice(&fs::read(actual_path).unwrap()).unwrap()
    }
}

impl Drop for QueueFixture {
    fn drop(&mut self) {
        let _ = fs::write(self.state.join("release-all"), "");
        let deadline = Instant::now() + Duration::from_secs(5);
        while (1..=self.call_count())
            .any(|call| !self.state.join(format!("finished.{call}")).exists())
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn wait_until(mut condition: impl FnMut() -> bool, label: &str) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !condition() {
        assert!(Instant::now() < deadline, "{label}");
        thread::sleep(Duration::from_millis(10));
    }
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"))
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
            .with_agent_executable(AgentProvider::Codex, executable.to_owned())
            .with_agent_executable(AgentProvider::OpenCode, executable.to_owned()),
    )
    .unwrap()
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
