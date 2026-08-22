use crate::{
    AGENT_OBSERVATION_SCHEMA_VERSION, AgentObservationActivity, AgentObservationSource,
    AgentObservationStatus, ObservedAgentProvider, ObservedAgentSession,
    agent_observation::matching_workspace_id,
};
use serde::Deserialize;
use std::{
    env, fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use url::Url;
use uuid::Uuid;

const MAX_STORAGE_BUCKETS: usize = 256;
const MAX_SESSION_FILES_PER_BUCKET: usize = 64;
const MAX_WORKSPACE_FILE_BYTES: u64 = 48 * 1024;
const MAX_SESSION_FILE_BYTES: u64 = 4 * 1024 * 1024;
const STALE_AFTER_MS: i64 = 5 * 60 * 1_000;
const SUPPORTED_SNAPSHOT_VERSION: u32 = 3;
const COPILOT_EXTENSION_ID: &str = "github.copilot-chat";
const MAX_MODEL_CHARS: usize = 120;

#[derive(Clone)]
pub(crate) struct CopilotSessionObserver {
    workspace_storage_root: Option<PathBuf>,
}

impl CopilotSessionObserver {
    pub(crate) fn from_environment() -> Self {
        let workspace_storage_root = env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|path| valid_absolute_path(path))
            .map(|home| {
                home.join("Library")
                    .join("Application Support")
                    .join("Code")
                    .join("User")
                    .join("workspaceStorage")
            });
        Self {
            workspace_storage_root,
        }
    }

    #[cfg(test)]
    fn new(workspace_storage_root: PathBuf) -> Self {
        Self {
            workspace_storage_root: Some(workspace_storage_root),
        }
    }

    pub(crate) fn observe_workspaces(
        &self,
        workspaces: &[(Uuid, PathBuf)],
    ) -> Vec<ObservedAgentSession> {
        self.observe_workspaces_at(workspaces, now_unix_ms())
    }

    fn observe_workspaces_at(
        &self,
        workspaces: &[(Uuid, PathBuf)],
        now: i64,
    ) -> Vec<ObservedAgentSession> {
        let mut valid_workspaces = workspaces
            .iter()
            .filter(|(_, path)| valid_absolute_path(path))
            .collect::<Vec<_>>();
        valid_workspaces.sort_by_key(|(_, path)| std::cmp::Reverse(path.components().count()));
        if valid_workspaces.is_empty() {
            return Vec::new();
        }
        let Some(root) = self.workspace_storage_root.as_deref() else {
            return Vec::new();
        };
        let Ok(entries) = fs::read_dir(root) else {
            return Vec::new();
        };

        let mut buckets = entries
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).ok()?;
                (metadata.is_dir() && !metadata.file_type().is_symlink()).then_some(path)
            })
            .collect::<Vec<_>>();
        buckets.sort();
        buckets.truncate(MAX_STORAGE_BUCKETS);

        let mut observed = Vec::new();
        for bucket in buckets {
            let Some(workspace_anchor) = read_workspace_anchor(&bucket.join("workspace.json"))
            else {
                continue;
            };
            let Some(workspace_id) = matching_workspace_id(&workspace_anchor, &valid_workspaces)
            else {
                continue;
            };
            observe_bucket(&bucket, workspace_id, now, &mut observed);
        }
        observed.sort_by(|left, right| {
            right
                .last_event_at_unix_ms
                .cmp(&left.last_event_at_unix_ms)
                .then_with(|| left.session_id.cmp(&right.session_id))
        });
        observed
    }
}

fn observe_bucket(
    bucket: &Path,
    workspace_id: Uuid,
    now: i64,
    observed: &mut Vec<ObservedAgentSession>,
) {
    let sessions = bucket.join("chatSessions");
    let Ok(entries) = fs::read_dir(sessions) else {
        return;
    };
    let mut candidates = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).ok()?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || path.extension().and_then(|value| value.to_str()) != Some("json")
                || metadata.len() > MAX_SESSION_FILE_BYTES
            {
                return None;
            }
            let modified_at = metadata.modified().ok().and_then(system_time_unix_ms)?;
            Some((path, modified_at))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.1.cmp(&left.1));
    candidates.truncate(MAX_SESSION_FILES_PER_BUCKET);
    observed.extend(
        candidates.into_iter().filter_map(|(path, modified_at)| {
            observe_snapshot(&path, workspace_id, modified_at, now)
        }),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceStorageLocation {
    folder: Option<String>,
    workspace: Option<String>,
}

fn read_workspace_anchor(path: &Path) -> Option<PathBuf> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_WORKSPACE_FILE_BYTES
    {
        return None;
    }
    let location: WorkspaceStorageLocation = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let uri = match (location.folder, location.workspace) {
        (Some(uri), None) | (None, Some(uri)) => uri,
        _ => return None,
    };
    let path = Url::parse(&uri).ok()?.to_file_path().ok()?;
    valid_absolute_path(&path).then_some(path)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSnapshot {
    version: u32,
    session_id: String,
    creation_date: i64,
    last_message_date: i64,
    input_state: Option<InputState>,
    requests: Vec<ChatRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputState {
    selected_model: Option<SelectedModel>,
}

#[derive(Deserialize)]
struct SelectedModel {
    metadata: SelectedModelMetadata,
}

#[derive(Deserialize)]
struct SelectedModelMetadata {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    agent: ChatAgent,
    model_id: Option<String>,
    model_state: Option<ModelState>,
    result: Option<ChatResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAgent {
    extension_id: ExtensionIdentifier,
}

#[derive(Deserialize)]
struct ExtensionIdentifier {
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelState {
    completed_at: Option<i64>,
}

#[derive(Deserialize)]
struct ChatResult {
    metadata: Option<ChatResultMetadata>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatResultMetadata {
    resolved_model: Option<String>,
}

fn observe_snapshot(
    path: &Path,
    workspace_id: Uuid,
    modified_at: i64,
    now: i64,
) -> Option<ObservedAgentSession> {
    let snapshot: SessionSnapshot = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if snapshot.version != SUPPORTED_SNAPSHOT_VERSION
        || snapshot.creation_date < 0
        || snapshot.last_message_date < snapshot.creation_date
    {
        return None;
    }
    let last_request = snapshot.requests.last()?;
    if !last_request
        .agent
        .extension_id
        .value
        .eq_ignore_ascii_case(COPILOT_EXTENSION_ID)
    {
        return None;
    }
    let session_id = Uuid::parse_str(&snapshot.session_id).ok()?;
    let model = last_request
        .result
        .as_ref()
        .and_then(|result| result.metadata.as_ref())
        .and_then(|metadata| metadata.resolved_model.as_deref())
        .and_then(bounded_model)
        .or_else(|| last_request.model_id.as_deref().and_then(bounded_model))
        .or_else(|| {
            snapshot
                .input_state
                .as_ref()?
                .selected_model
                .as_ref()
                .and_then(|model| bounded_model(&model.metadata.id))
        });
    let completed = last_request.result.is_some()
        || last_request
            .model_state
            .as_ref()
            .and_then(|state| state.completed_at)
            .is_some();
    let status = if completed {
        AgentObservationStatus::Idle
    } else if now.saturating_sub(modified_at) <= STALE_AFTER_MS {
        AgentObservationStatus::Working
    } else {
        AgentObservationStatus::Stale
    };
    Some(ObservedAgentSession {
        schema_version: AGENT_OBSERVATION_SCHEMA_VERSION,
        session_id,
        workspace_id,
        provider: ObservedAgentProvider::Copilot,
        source: AgentObservationSource::CopilotVscodeSnapshot,
        status,
        activity: (!completed).then_some(AgentObservationActivity::Thinking),
        model,
        latest_update: None,
        update_kind: None,
        needs_input: None,
        change_request_proposals: Vec::new(),
        started_at_unix_ms: snapshot.creation_date,
        last_event_at_unix_ms: snapshot.last_message_date,
    })
}

fn bounded_model(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_MODEL_CHARS
        || value.chars().any(|character| character.is_control())
    {
        return None;
    }
    Some(value.to_owned())
}

fn valid_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
}

fn system_time_unix_ms(time: SystemTime) -> Option<i64> {
    let duration = time.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_millis()).ok()
}

fn now_unix_ms() -> i64 {
    system_time_unix_ms(SystemTime::now()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_workspace_bucket(root: &Path, workspace: &Path) -> PathBuf {
        let bucket = root.join("bucket");
        fs::create_dir_all(bucket.join("chatSessions")).expect("session directory");
        fs::write(
            bucket.join("workspace.json"),
            serde_json::json!({
                "workspace": Url::from_file_path(workspace.join("saved.code-workspace"))
                    .unwrap()
                    .to_string()
            })
            .to_string(),
        )
        .expect("workspace storage location");
        bucket
    }

    fn snapshot(session_id: Uuid, completed_at: Option<i64>) -> serde_json::Value {
        serde_json::json!({
            "version": 3,
            "sessionId": session_id,
            "creationDate": 1_000,
            "lastMessageDate": 2_000,
            "inputState": {
                "inputText": "private user prompt",
                "selectedModel": {"metadata": {"id": "copilot/auto", "name": "private"}}
            },
            "requests": [{
                "message": {"text": "private user prompt"},
                "agent": {"extensionId": {"value": "GitHub.copilot-chat"}},
                "modelId": "claude-sonnet-4.6",
                "modelState": {"value": 1, "completedAt": completed_at},
                "response": [{"value": "private assistant response"}]
            }]
        })
    }

    #[test]
    fn observes_only_sanitized_copilot_snapshot_metadata() {
        let fixture = TempDir::new().expect("fixture");
        let workspace = fixture.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let bucket = write_workspace_bucket(fixture.path(), &workspace);
        let session_id = Uuid::new_v4();
        fs::write(
            bucket.join("chatSessions/session.json"),
            snapshot(session_id, None).to_string(),
        )
        .expect("snapshot");

        let workspace_id = Uuid::new_v4();
        let observed = CopilotSessionObserver::new(fixture.path().to_owned())
            .observe_workspaces_at(&[(workspace_id, workspace)], now_unix_ms());

        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].session_id, session_id);
        assert_eq!(observed[0].workspace_id, workspace_id);
        assert_eq!(observed[0].provider, ObservedAgentProvider::Copilot);
        assert_eq!(observed[0].status, AgentObservationStatus::Working);
        assert_eq!(observed[0].model.as_deref(), Some("claude-sonnet-4.6"));
        let serialized = serde_json::to_string(&observed).expect("serialized observation");
        assert!(!serialized.contains("private user prompt"));
        assert!(!serialized.contains("private assistant response"));
    }

    #[test]
    fn reports_completed_snapshot_as_idle() {
        let fixture = TempDir::new().expect("fixture");
        let workspace = fixture.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let bucket = write_workspace_bucket(fixture.path(), &workspace);
        fs::write(
            bucket.join("chatSessions/session.json"),
            snapshot(Uuid::new_v4(), Some(2_000)).to_string(),
        )
        .expect("snapshot");

        let observed = CopilotSessionObserver::new(fixture.path().to_owned())
            .observe_workspaces_at(&[(Uuid::new_v4(), workspace)], now_unix_ms());

        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].status, AgentObservationStatus::Idle);
        assert_eq!(observed[0].activity, None);
    }

    #[test]
    fn ignores_patch_logs_unknown_versions_and_other_agents() {
        let fixture = TempDir::new().expect("fixture");
        let workspace = fixture.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let bucket = write_workspace_bucket(fixture.path(), &workspace);
        fs::write(
            bucket.join("chatSessions/active.jsonl"),
            serde_json::json!({"kind": 0, "v": snapshot(Uuid::new_v4(), None)}).to_string(),
        )
        .expect("patch log");
        let mut unknown = snapshot(Uuid::new_v4(), None);
        unknown["version"] = serde_json::json!(4);
        fs::write(
            bucket.join("chatSessions/unknown.json"),
            unknown.to_string(),
        )
        .expect("unknown snapshot");
        let mut other = snapshot(Uuid::new_v4(), None);
        other["requests"][0]["agent"]["extensionId"]["value"] = serde_json::json!("other.agent");
        fs::write(bucket.join("chatSessions/other.json"), other.to_string())
            .expect("other snapshot");

        let observed = CopilotSessionObserver::new(fixture.path().to_owned())
            .observe_workspaces_at(&[(Uuid::new_v4(), workspace)], now_unix_ms());

        assert!(observed.is_empty());
    }

    #[test]
    fn does_not_map_a_storage_bucket_outside_the_trusted_workspace() {
        let fixture = TempDir::new().expect("fixture");
        let workspace = fixture.path().join("workspace");
        let other = fixture.path().join("other");
        fs::create_dir(&workspace).expect("workspace");
        fs::create_dir(&other).expect("other");
        let bucket = write_workspace_bucket(fixture.path(), &other);
        fs::write(
            bucket.join("chatSessions/session.json"),
            snapshot(Uuid::new_v4(), None).to_string(),
        )
        .expect("snapshot");

        let observed = CopilotSessionObserver::new(fixture.path().to_owned())
            .observe_workspaces_at(&[(Uuid::new_v4(), workspace)], now_unix_ms());

        assert!(observed.is_empty());
    }
}
