#![cfg(unix)]

use std::{
    fs,
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;
use wts_app::{
    AgentConversation, AgentConversationMessageStatus, AgentConversationSource, AgentProvider,
    AgentTurnChangesState, AgentWorkItemRequest, AgentWorkItemState, AgentWorkSetKind,
    CreateAgentConversationRequest, CreateAgentWorkSetRequest, LocalWtsService,
    ProcessExternalLauncher, ProcessWorkspaceAdapter, SendAgentConversationMessageRequest,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspacePlanningFolder, WorkspacePlanningFormat,
    WorkspacePlanningSelection, WorkspaceProvider, WorkspaceRepositoryRequest,
};

#[test]
#[ignore = "Creates a retained, isolated native inspection fixture. Starts only its fake provider."]
fn prepare_isolated_native_candidate_fixture() {
    assert_eq!(
        std::env::var("WTS_PREPARE_NATIVE_FIXTURE").as_deref(),
        Ok("1")
    );
    let directory = tempfile::Builder::new()
        .prefix("wts-native-candidate-")
        .tempdir()
        .unwrap();
    let root = directory.path().canonicalize().unwrap();
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let repositories = root.join("repositories");
    let source = repositories.join("wts-ui");
    fs::create_dir_all(source.join("ui")).unwrap();
    copy_tree(&project.join("ui/src"), &source.join("ui/src"));
    for file in [
        "index.html",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
    ] {
        fs::copy(project.join("ui").join(file), source.join("ui").join(file)).unwrap();
    }
    fs::write(source.join("ui/vite.config.ts"), "import {defineConfig} from 'vite'; import react from '@vitejs/plugin-react'; export default defineConfig({plugins:[react()]});\n").unwrap();
    fs::write(source.join(".gitignore"), "ui/node_modules\nui/dist\n").unwrap();
    git(&source, &["init", "-b", "main"]);
    git(&source, &["config", "user.name", "WTS Native Fixture"]);
    git(
        &source,
        &["config", "user.email", "native-fixture@localhost"],
    );
    git(&source, &["add", "."]);
    git(
        &source,
        &["commit", "-m", "Create the isolated native fixture"],
    );
    let base_head = git(&source, &["rev-parse", "HEAD"]);
    let base_index = fs::read(source.join(".git/index")).unwrap();
    let installed = project.join("ui/node_modules").canonicalize().unwrap();
    std::os::unix::fs::symlink(&installed, source.join("ui/node_modules")).unwrap();
    let node = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(node.status.success());
    let node = String::from_utf8(node.stdout).unwrap().trim().to_owned();
    let launch_log = root.join("fake-provider-launches.jsonl");
    let fake_provider = root.join("fixture-provider");
    fs::write(&fake_provider, format!(r#"#!{node}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),final=args[args.indexOf('--output-last-message')+1];
if(!final) throw Error('The fixture needs a final output file.');
fs.appendFileSync({launch_log},JSON.stringify({{cwd:process.cwd()}})+'\n');
if(fs.existsSync('fixture-parent.txt')) {{
  const label=path.basename(path.dirname(process.cwd()));
  const file='ui/index.html';
  const marker='<aside id="native-candidate-marker" style="position:fixed;top:4px;right:4px;z-index:2147483646;padding:6px;background:#155e75;color:white;font:13px system-ui">Candidate: '+label+'</aside>';
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('</body>',marker+'</body>'));
  fs.writeFileSync(final,'The isolated candidate contains its visible fixture marker. Open its result and native preview.');
}} else {{
  fs.writeFileSync('fixture-parent.txt','The parent fixture task completed.\n');
  fs.writeFileSync(final,'The parent fixture task completed. Two saved alternatives are available for native inspection.');
}}
process.stdout.write(JSON.stringify({{type:'turn.completed'}})+'\n');
"#, launch_log = serde_json::to_string(&launch_log).unwrap())).unwrap();
    fs::set_permissions(&fake_provider, fs::Permissions::from_mode(0o700)).unwrap();
    let service = LocalWtsService::open_with_repository_roots_launcher_and_adapter(
        root.join("data"),
        "local-default",
        root.join("workspaces"),
        [repositories.clone()],
        ProcessExternalLauncher,
        ProcessWorkspaceAdapter::default()
            .with_agent_executable(AgentProvider::Codex, fake_provider),
    )
    .unwrap();
    let workspace = service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "Native preview fixture".into(),
                },
                title: "Native preview fixture".into(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![WorkspaceRepositoryRequest {
                    repository_id: None,
                    label: "wts-ui".into(),
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
        .workspace;
    let preflight = service.preflight_workspace(workspace.workspace_id).unwrap();
    let materialized = service
        .materialize_workspace(workspace.workspace_id, &preflight.effect_digest)
        .unwrap();
    let target = PathBuf::from(&materialized.materialization.worktrees[0].target_display_path);
    std::os::unix::fs::symlink(&installed, target.join("ui/node_modules")).unwrap();
    service
        .configure_ui_development_repository(target.clone(), None)
        .unwrap();
    let conversation = service
        .create_agent_conversation(CreateAgentConversationRequest {
            request_id: Uuid::new_v4(),
            provider: AgentProvider::Codex,
            source: AgentConversationSource::Ui {
                route: format!("/sessions/{}/planning", workspace.workspace_id),
                callout_id: "planning.document".into(),
                label: "Planning document".into(),
                selected_text: Some("Native fixture. No provider request is needed.".into()),
                context: None,
                capture: None,
            },
        })
        .unwrap();
    let request_id = Uuid::new_v4();
    service
        .send_agent_conversation_message(
            conversation.conversation_id,
            SendAgentConversationMessageRequest {
                request_id,
                body: "Prepare the isolated native inspection fixture.".into(),
            },
        )
        .unwrap();
    wait_completed(&service, conversation.conversation_id);
    let receipt = service
        .get_agent_turn_changes(conversation.conversation_id, request_id)
        .unwrap();
    assert_eq!(receipt.state, AgentTurnChangesState::Ready);
    let set = service
        .create_agent_work_set(
            conversation.conversation_id,
            request_id,
            CreateAgentWorkSetRequest {
                request_id: Uuid::new_v4(),
                expected_after_checkpoint_id: receipt.after.unwrap().checkpoint_id,
                kind: AgentWorkSetKind::Alternatives,
                tasks: ["Compact candidate", "Spacious candidate"]
                    .into_iter()
                    .map(|title| AgentWorkItemRequest {
                        task_id: Uuid::new_v4(),
                        title: title.into(),
                        prompt: "Add the candidate fixture marker.".into(),
                        depends_on: vec![],
                    })
                    .collect(),
            },
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(90);
    let set = loop {
        let current = service.get_agent_work_set(set.work_set_id).unwrap();
        if current
            .tasks
            .iter()
            .all(|task| task.state == AgentWorkItemState::Completed)
        {
            break current;
        }
        assert!(
            current.tasks.iter().all(|task| !matches!(
                task.state,
                AgentWorkItemState::Failed | AgentWorkItemState::Blocked
            )),
            "{current:?}"
        );
        assert!(
            Instant::now() < deadline,
            "The fixture alternatives did not finish: {current:?}"
        );
        thread::sleep(Duration::from_millis(40));
    };
    let mut candidates = vec![];
    for task in &set.tasks {
        let child = wait_completed(&service, task.conversation_id);
        let changes = service
            .get_agent_turn_changes(task.conversation_id, task.request_id)
            .unwrap();
        assert_eq!(changes.state, AgentTurnChangesState::Ready);
        assert!(changes.patch.contains("native-candidate-marker"));
        let materialized = service
            .get_materialization(child.workspace_id)
            .unwrap()
            .unwrap();
        let candidate = PathBuf::from(&materialized.worktrees[0].target_display_path);
        assert!(candidate.starts_with(&root));
        candidates.push(serde_json::json!({"title":task.title,"taskId":task.task_id,"workspaceId":child.workspace_id,"repositoryId":child.repository_id,"source":candidate}));
    }
    assert_eq!(fs::read_to_string(&launch_log).unwrap().lines().count(), 3);
    assert_eq!(git(&source, &["rev-parse", "HEAD"]), base_head);
    assert_eq!(fs::read(source.join(".git/index")).unwrap(), base_index);
    assert!(
        !fs::read_to_string(target.join("ui/index.html"))
            .unwrap()
            .contains("native-candidate-marker")
    );
    assert!(
        service
            .list_agent_conversations()
            .unwrap()
            .conversations
            .iter()
            .all(is_complete)
    );
    drop(service);

    let port = TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let origin = format!("http://127.0.0.1:{port}");
    let deny_bin = root.join("deny-bin");
    fs::create_dir(&deny_bin).unwrap();
    for command in [
        "codex",
        "opencode",
        "hermes",
        "copilot",
        "graphify",
        "claude",
        "agent",
        "cursor-agent",
        "gemini",
        "aider",
        "glab",
        "gh",
    ] {
        let path = deny_bin.join(command);
        fs::write(&path, "#!/bin/sh\nprintf '%s\\n' 'This native fixture blocks provider and remote CLI requests.' >&2\nexit 78\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let config = serde_json::json!({
        "identifier":format!("dev.wts.nativefixture.{}", Uuid::new_v4().simple()),
        "productName":"WTS Native Fixture",
        "build":{"devUrl":origin,"beforeDevCommand":null},
        "app":{"windows":[{"label":"main","title":"WTS Native Fixture","url":format!("/sessions/{}/planning",workspace.workspace_id),"width":1440,"height":900,"incognito":true}],
          "security":{"devCsp":{"default-src":format!("'self' {origin}"),"connect-src":format!("'self' ipc: http://ipc.localhost {origin} ws://127.0.0.1:{port}"),"font-src":"'self' data:","img-src":"'self' blob: data:","script-src":"'self'","style-src":"'self' 'unsafe-inline'"}}}
    });
    fs::write(
        root.join("tauri.fixture.json"),
        serde_json::to_vec_pretty(&config).unwrap(),
    )
    .unwrap();
    let manifest = serde_json::json!({
        "schemaVersion":1,"root":root,"project":project,"node":node,"origin":origin,"port":port,"source":source,"target":target,
        "workspaceId":workspace.workspace_id,"conversationId":conversation.conversation_id,"requestId":request_id,"workSetId":set.work_set_id,"candidates":candidates,
        "environment":{"WTS_DATA_DIR":root.join("data"),"WTS_WORKSPACE_ROOT":root.join("workspaces"),"WTS_REPOSITORY_ROOTS":repositories,"WTS_UI_REPOSITORY_ROOT":target},
        "denyBin":deny_bin,"fakeProviderLaunches":3,"activeOrQueuedTasks":0,"nativeConfig":root.join("tauri.fixture.json"),"nativeTargetDirectory":root.join("native-target")
    });
    fs::write(
        root.join("fixture.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let root = directory.keep();
    println!(
        "Native fixture prepared. No desktop app started. Manifest: {}",
        root.join("fixture.json").display()
    );
}

fn is_complete(conversation: &AgentConversation) -> bool {
    conversation.active_session_id.is_none()
        && !conversation.messages.is_empty()
        && conversation
            .messages
            .iter()
            .all(|message| message.status == AgentConversationMessageStatus::Completed)
}

fn wait_completed(service: &LocalWtsService, id: Uuid) -> AgentConversation {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let conversation = service.get_agent_conversation(id).unwrap();
        if is_complete(&conversation) {
            return conversation;
        }
        assert!(
            !conversation.messages.iter().any(|message| matches!(
                message.status,
                AgentConversationMessageStatus::Failed
                    | AgentConversationMessageStatus::Interrupted
            )),
            "{conversation:?}"
        );
        assert!(
            Instant::now() < deadline,
            "The fixture turn did not finish."
        );
        thread::sleep(Duration::from_millis(40));
    }
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        assert!(
            !kind.is_symlink(),
            "The fixture copies regular source files only."
        );
        if kind.is_dir() {
            copy_tree(&entry.path(), &target.join(entry.file_name()));
        } else {
            assert!(kind.is_file());
            fs::copy(entry.path(), target.join(entry.file_name())).unwrap();
        }
    }
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
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
