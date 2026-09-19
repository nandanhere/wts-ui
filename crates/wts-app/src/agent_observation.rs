use crate::{
    AgentChangeRequestProposal,
    agent_sessions::{CHANGE_REQUEST_PROPOSAL_PREFIX, parse_agent_change_request_proposals},
};
use serde::{Deserialize, Serialize, de::IgnoredAny};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub const AGENT_OBSERVATION_SCHEMA_VERSION: u32 = 1;
const MAX_CANDIDATE_FILES: usize = 128;
const MAX_DIRECTORY_DEPTH: usize = 4;
const MAX_METADATA_LINE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_EVENT_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const STALE_AFTER_MS: i64 = 5 * 60 * 1_000;
const RECENT_EVENT_GRACE_MS: i64 = 30 * 1_000;
const MAX_AGENT_UPDATE_CHARS: usize = 800;
const MAX_AGENT_UPDATE_LINES: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentObservationSource {
    CodexVscodeRollout,
    CopilotVscodeSnapshot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ObservedAgentProvider {
    Codex,
    Copilot,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentObservationStatus {
    Working,
    Idle,
    Interrupted,
    Stale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentObservationActivity {
    Thinking,
    UsingTools,
    Editing,
    RunningCommand,
    Searching,
    Delegating,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentObservationUpdateKind {
    Progress,
    Completion,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentNeedsInputKind {
    Question,
    Access,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNeedsInput {
    pub kind: AgentNeedsInputKind,
    pub detail: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentNeedsInputWire {
    kind: AgentNeedsInputKind,
    detail: String,
}

impl<'de> Deserialize<'de> for AgentNeedsInput {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = AgentNeedsInputWire::deserialize(deserializer)?;
        let value = Self {
            kind: wire.kind,
            detail: wire.detail,
        };
        if !value.is_valid() {
            return Err(serde::de::Error::custom(
                "agent input detail does not match its fixed kind",
            ));
        }
        Ok(value)
    }
}

impl AgentNeedsInput {
    pub(crate) fn question() -> Self {
        Self {
            kind: AgentNeedsInputKind::Question,
            detail: "Agent has a question.".to_owned(),
        }
    }

    pub(crate) fn access() -> Self {
        Self {
            kind: AgentNeedsInputKind::Access,
            detail: "Agent needs access.".to_owned(),
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        matches!(
            (self.kind, self.detail.as_str()),
            (AgentNeedsInputKind::Question, "Agent has a question.")
                | (AgentNeedsInputKind::Access, "Agent needs access.")
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedAgentSession {
    pub schema_version: u32,
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub provider: ObservedAgentProvider,
    pub source: AgentObservationSource,
    pub status: AgentObservationStatus,
    pub activity: Option<AgentObservationActivity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_update: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_kind: Option<AgentObservationUpdateKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_input: Option<AgentNeedsInput>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub change_request_proposals: Vec<AgentChangeRequestProposal>,
    pub started_at_unix_ms: i64,
    pub last_event_at_unix_ms: i64,
}

#[derive(Clone)]
pub(crate) struct CodexSessionObserver {
    sessions_root: Option<PathBuf>,
}

impl CodexSessionObserver {
    pub(crate) fn from_environment() -> Self {
        let codex_home = env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")));
        let sessions_root = codex_home
            .filter(|path| valid_absolute_path(path))
            .map(|path| path.join("sessions"));
        Self { sessions_root }
    }

    #[cfg(test)]
    fn new(sessions_root: PathBuf) -> Self {
        Self {
            sessions_root: Some(sessions_root),
        }
    }

    pub(crate) fn observe(
        &self,
        workspace_id: Uuid,
        workspace_path: &Path,
    ) -> Vec<ObservedAgentSession> {
        self.observe_workspaces_at(&[(workspace_id, workspace_path.to_owned())], now_unix_ms())
    }

    pub(crate) fn observe_workspaces(
        &self,
        workspaces: &[(Uuid, PathBuf)],
    ) -> Vec<ObservedAgentSession> {
        self.observe_workspaces_at(workspaces, now_unix_ms())
    }

    #[cfg(test)]
    fn observe_at(
        &self,
        workspace_id: Uuid,
        workspace_path: &Path,
        now: i64,
    ) -> Vec<ObservedAgentSession> {
        self.observe_workspaces_at(&[(workspace_id, workspace_path.to_owned())], now)
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
        if valid_workspaces.is_empty() {
            return Vec::new();
        }
        // Prefer the most specific workspace when saved workspace roots overlap.
        valid_workspaces.sort_by_key(|(_, path)| std::cmp::Reverse(path.components().count()));
        let Some(root) = self.sessions_root.as_deref() else {
            return Vec::new();
        };
        let mut candidates = Vec::new();
        collect_candidates(root, 0, &mut candidates);
        candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.modified_at));
        candidates.truncate(MAX_CANDIDATE_FILES);

        let mut observed = candidates
            .into_iter()
            .filter_map(|candidate| observe_candidate(&candidate, &valid_workspaces, now))
            .collect::<Vec<_>>();
        observed.sort_by(|left, right| {
            right
                .last_event_at_unix_ms
                .cmp(&left.last_event_at_unix_ms)
                .then_with(|| left.session_id.cmp(&right.session_id))
        });
        observed
    }
}

struct Candidate {
    path: PathBuf,
    created_at: i64,
    modified_at: i64,
}

fn collect_candidates(root: &Path, depth: usize, candidates: &mut Vec<Candidate>) {
    if depth > MAX_DIRECTORY_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_candidates(&path, depth + 1, candidates);
            continue;
        }
        if !metadata.is_file() || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        let Some(modified_at) = metadata.modified().ok().and_then(system_time_unix_ms) else {
            continue;
        };
        let created_at = metadata
            .created()
            .ok()
            .and_then(system_time_unix_ms)
            .unwrap_or(modified_at);
        candidates.push(Candidate {
            path,
            created_at,
            modified_at,
        });
    }
}

fn observe_candidate(
    candidate: &Candidate,
    workspaces: &[&(Uuid, PathBuf)],
    now: i64,
) -> Option<ObservedAgentSession> {
    let metadata = read_session_metadata(&candidate.path)?;
    if metadata.originator.as_deref() != Some("codex_vscode")
        || metadata.source.as_deref() != Some("vscode")
    {
        return None;
    }
    let cwd = Path::new(metadata.cwd.as_deref()?);
    if !valid_absolute_path(cwd) {
        return None;
    }
    let workspace_id = matching_workspace_id(cwd, workspaces)?;
    let session_id = Uuid::parse_str(metadata.id.as_deref()?).ok()?;
    let event_state = read_event_state(&candidate.path)?;
    let age = now.saturating_sub(candidate.modified_at);
    let status = if !event_state.active_turns.is_empty() {
        if age > STALE_AFTER_MS {
            AgentObservationStatus::Stale
        } else {
            AgentObservationStatus::Working
        }
    } else {
        match event_state.last_terminal {
            Some(TerminalEvent::Interrupted) => AgentObservationStatus::Interrupted,
            Some(TerminalEvent::Completed) => AgentObservationStatus::Idle,
            None if event_state.saw_activity && age <= RECENT_EVENT_GRACE_MS => {
                AgentObservationStatus::Working
            }
            None => AgentObservationStatus::Idle,
        }
    };
    Some(ObservedAgentSession {
        schema_version: AGENT_OBSERVATION_SCHEMA_VERSION,
        session_id,
        workspace_id,
        provider: ObservedAgentProvider::Codex,
        source: AgentObservationSource::CodexVscodeRollout,
        status,
        activity: event_state.activity,
        model: None,
        latest_update: event_state.latest_update,
        update_kind: event_state.update_kind,
        needs_input: event_state.pending_input.values().next().cloned(),
        change_request_proposals: event_state.change_request_proposals,
        started_at_unix_ms: candidate.created_at,
        last_event_at_unix_ms: candidate.modified_at,
    })
}

pub(crate) fn matching_workspace_id(cwd: &Path, workspaces: &[&(Uuid, PathBuf)]) -> Option<Uuid> {
    if let Some((workspace_id, _)) = workspaces
        .iter()
        .find(|(_, workspace_path)| cwd.starts_with(workspace_path))
    {
        return Some(*workspace_id);
    }

    workspaces
        .iter()
        .find_map(|(workspace_id, workspace_path)| {
            let workspace_parent = workspace_path.parent()?;
            let relative_cwd = cwd.strip_prefix(workspace_parent).ok()?;
            let previous_workspace_leaf = match relative_cwd.components().next()? {
                Component::Normal(leaf) => leaf.to_str()?,
                _ => return None,
            };
            let workspace_id_text = workspace_id.to_string();
            let prefix = previous_workspace_leaf.strip_suffix(&workspace_id_text)?;
            prefix.ends_with('-').then_some(*workspace_id)
        })
}

#[derive(Default, Deserialize)]
struct RolloutRecord {
    #[serde(rename = "type")]
    record_type: Option<String>,
    payload: Option<RolloutPayload>,
    #[serde(flatten)]
    _ignored: std::collections::BTreeMap<String, IgnoredAny>,
}

#[derive(Default, Deserialize)]
struct RolloutPayload {
    #[serde(rename = "type")]
    payload_type: Option<String>,
    id: Option<String>,
    originator: Option<String>,
    cwd: Option<String>,
    source: Option<serde_json::Value>,
    turn_id: Option<String>,
    name: Option<String>,
    call_id: Option<String>,
    arguments: Option<String>,
    input: Option<String>,
    role: Option<String>,
    phase: Option<String>,
    content: Option<Vec<RolloutContent>>,
    last_agent_message: Option<String>,
    #[serde(flatten)]
    _ignored: std::collections::BTreeMap<String, IgnoredAny>,
}

#[derive(Default, Deserialize)]
struct RolloutContent {
    #[serde(rename = "type")]
    content_type: Option<String>,
    text: Option<String>,
    #[serde(flatten)]
    _ignored: std::collections::BTreeMap<String, IgnoredAny>,
}

struct SessionMetadata {
    id: Option<String>,
    originator: Option<String>,
    cwd: Option<String>,
    source: Option<String>,
}

fn read_session_metadata(path: &Path) -> Option<SessionMetadata> {
    let file = File::open(path).ok()?;
    let mut line = Vec::new();
    let mut reader = BufReader::new(file).take(MAX_METADATA_LINE_BYTES + 1);
    reader.read_until(b'\n', &mut line).ok()?;
    if line.len() as u64 > MAX_METADATA_LINE_BYTES || !line.ends_with(b"\n") {
        return None;
    }
    let record: RolloutRecord = serde_json::from_slice(&line).ok()?;
    if record.record_type.as_deref() != Some("session_meta") {
        return None;
    }
    let payload = record.payload?;
    Some(SessionMetadata {
        id: payload.id,
        originator: payload.originator,
        cwd: payload.cwd,
        source: payload
            .source
            .and_then(|source| source.as_str().map(str::to_owned)),
    })
}

#[derive(Clone, Copy)]
enum TerminalEvent {
    Completed,
    Interrupted,
}

#[derive(Default)]
struct EventState {
    active_turns: BTreeSet<String>,
    last_terminal: Option<TerminalEvent>,
    activity: Option<AgentObservationActivity>,
    saw_activity: bool,
    latest_update: Option<String>,
    update_kind: Option<AgentObservationUpdateKind>,
    pending_input: BTreeMap<String, AgentNeedsInput>,
    change_request_proposals: Vec<AgentChangeRequestProposal>,
}

fn read_event_state(path: &Path) -> Option<EventState> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(MAX_EVENT_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity(length.saturating_sub(start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    if start > 0 {
        let newline = bytes.iter().position(|byte| *byte == b'\n')?;
        bytes.drain(..=newline);
    }

    let mut state = EventState::default();
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let Ok(record) = serde_json::from_slice::<RolloutRecord>(line) else {
            continue;
        };
        let Some(payload) = record.payload else {
            continue;
        };
        match (
            record.record_type.as_deref(),
            payload.payload_type.as_deref(),
        ) {
            (Some("event_msg"), Some("task_started")) => {
                if let Some(turn_id) = payload.turn_id {
                    state.active_turns.insert(turn_id);
                }
                state.last_terminal = None;
                state.activity = Some(AgentObservationActivity::Thinking);
                state.saw_activity = true;
                state.latest_update = None;
                state.update_kind = None;
                state.pending_input.clear();
                state.change_request_proposals.clear();
            }
            (Some("event_msg"), Some("task_complete")) => {
                if let Some(turn_id) = payload.turn_id {
                    state.active_turns.remove(&turn_id);
                }
                state.last_terminal = Some(TerminalEvent::Completed);
                state.activity = None;
                state.pending_input.clear();
                if let Some(message) = payload.last_agent_message.as_deref() {
                    let proposals = parse_agent_change_request_proposals(message);
                    if !proposals.is_empty() {
                        state.change_request_proposals = proposals;
                    }
                }
                if let Some(update) = payload
                    .last_agent_message
                    .as_deref()
                    .and_then(bounded_agent_update)
                {
                    state.latest_update = Some(update);
                    state.update_kind = Some(AgentObservationUpdateKind::Completion);
                }
            }
            (Some("event_msg"), Some("turn_aborted")) => {
                if let Some(turn_id) = payload.turn_id {
                    state.active_turns.remove(&turn_id);
                } else {
                    state.active_turns.clear();
                }
                state.last_terminal = Some(TerminalEvent::Interrupted);
                state.activity = None;
                state.pending_input.clear();
            }
            (Some("event_msg"), Some("web_search_end")) => {
                state.activity = Some(AgentObservationActivity::Searching);
                state.saw_activity = true;
            }
            (Some("event_msg"), Some("sub_agent_activity")) => {
                state.activity = Some(AgentObservationActivity::Delegating);
                state.saw_activity = true;
            }
            (Some("response_item"), Some("reasoning")) => {
                state.activity = Some(AgentObservationActivity::Thinking);
                state.saw_activity = true;
            }
            (Some("response_item"), Some("message"))
                if payload.role.as_deref() == Some("assistant") =>
            {
                let proposal_text = payload.content.as_deref().and_then(|content| {
                    content.iter().rev().find_map(|item| {
                        (item.content_type.as_deref() == Some("output_text"))
                            .then_some(item.text.as_deref())
                            .flatten()
                    })
                });
                if let Some(text) = proposal_text {
                    let proposals = parse_agent_change_request_proposals(text);
                    if !proposals.is_empty() {
                        state.change_request_proposals = proposals;
                    }
                }
                let update = payload.content.as_deref().and_then(|content| {
                    content.iter().rev().find_map(|item| {
                        (item.content_type.as_deref() == Some("output_text"))
                            .then_some(item.text.as_deref())
                            .flatten()
                            .and_then(bounded_agent_update)
                    })
                });
                if let Some(update) = update {
                    state.latest_update = Some(update);
                    state.update_kind = Some(if payload.phase.as_deref() == Some("commentary") {
                        AgentObservationUpdateKind::Progress
                    } else {
                        AgentObservationUpdateKind::Completion
                    });
                }
            }
            (Some("response_item"), Some("function_call" | "custom_tool_call")) => {
                if let Some(request) = input_request_for_tool(
                    payload.name.as_deref(),
                    payload.arguments.as_deref().or(payload.input.as_deref()),
                ) {
                    state.pending_input.insert(
                        input_call_key(payload.call_id.as_deref(), payload.name.as_deref()),
                        request,
                    );
                    state.activity = None;
                } else {
                    state.activity = Some(activity_for_tool(payload.name.as_deref()));
                }
                state.saw_activity = true;
            }
            (Some("response_item"), Some("function_call_output" | "custom_tool_call_output")) => {
                if let Some(call_id) = payload.call_id.as_deref() {
                    state.pending_input.remove(call_id);
                }
            }
            (Some("event_msg"), Some("request_user_input" | "user_input_request")) => {
                state.pending_input.insert(
                    input_call_key(payload.call_id.as_deref(), Some("request_user_input")),
                    AgentNeedsInput::question(),
                );
                state.activity = None;
                state.saw_activity = true;
            }
            (
                Some("event_msg"),
                Some("approval_request" | "exec_approval_request" | "apply_patch_approval_request"),
            ) => {
                state.pending_input.insert(
                    input_call_key(payload.call_id.as_deref(), Some("approval_request")),
                    AgentNeedsInput::access(),
                );
                state.activity = None;
                state.saw_activity = true;
            }
            (Some("event_msg"), Some("user_input_response" | "approval_response")) => {
                if let Some(call_id) = payload.call_id.as_deref() {
                    state.pending_input.remove(call_id);
                } else {
                    state.pending_input.clear();
                }
            }
            _ => {}
        }
    }
    Some(state)
}

fn input_call_key(call_id: Option<&str>, tool_name: Option<&str>) -> String {
    call_id.or(tool_name).unwrap_or("agent-input").to_owned()
}

fn input_request_for_tool(name: Option<&str>, arguments: Option<&str>) -> Option<AgentNeedsInput> {
    let full_name = name?;
    let name = full_name.rsplit(['.', ':']).next().unwrap_or(full_name);
    match name {
        "request_user_input" | "requestUserInput" => Some(AgentNeedsInput::question()),
        "request_approval" | "requestApproval" | "request_permission" => {
            Some(AgentNeedsInput::access())
        }
        "exec" | "exec_command" if arguments.is_some_and(requests_escalated_access) => {
            Some(AgentNeedsInput::access())
        }
        _ => None,
    }
}

fn requests_escalated_access(arguments: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(arguments)
        .ok()
        .and_then(|value| {
            value
                .get("sandbox_permissions")
                .or_else(|| value.get("sandboxPermissions"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|value| value == "require_escalated")
}

fn bounded_agent_update(value: &str) -> Option<String> {
    let lines = value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with(CHANGE_REQUEST_PROPOSAL_PREFIX))
        .take(MAX_AGENT_UPDATE_LINES)
        .collect::<Vec<_>>();
    let normalized = lines.join("\n");
    if normalized.is_empty() {
        return None;
    }
    let mut bounded = normalized
        .chars()
        .filter(|character| !character.is_control() || *character == '\n')
        .take(MAX_AGENT_UPDATE_CHARS)
        .collect::<String>();
    if normalized.chars().count() > MAX_AGENT_UPDATE_CHARS {
        bounded.push('…');
    }
    Some(bounded)
}

fn activity_for_tool(name: Option<&str>) -> AgentObservationActivity {
    match name {
        Some("apply_patch" | "write_file" | "edit_file") => AgentObservationActivity::Editing,
        Some("exec" | "exec_command" | "write_stdin") => AgentObservationActivity::RunningCommand,
        Some(name) if name.contains("search") || name.contains("web") => {
            AgentObservationActivity::Searching
        }
        Some(name) if name.contains("agent") || name.contains("delegate") => {
            AgentObservationActivity::Delegating
        }
        _ => AgentObservationActivity::UsingTools,
    }
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

    fn write_rollout(root: &Path, contents: &str) -> PathBuf {
        let day = root.join("2026/08/03");
        fs::create_dir_all(&day).expect("session day");
        let path = day.join("rollout-test.jsonl");
        fs::write(&path, contents).expect("rollout fixture");
        path
    }

    fn session_meta(session_id: Uuid, cwd: &Path) -> String {
        serde_json::json!({
            "timestamp": "2026-08-03T10:00:00.000Z",
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "originator": "codex_vscode",
                "source": "vscode",
                "cwd": cwd,
                "base_instructions": "private instructions that must not enter the observation"
            }
        })
        .to_string()
    }

    #[test]
    fn observes_an_active_vscode_turn_without_exposing_private_fields() {
        let fixture = TempDir::new().expect("fixture");
        let workspace = fixture.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let session_id = Uuid::new_v4();
        let lines = [
            session_meta(session_id, &workspace),
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-1"}
            })
            .to_string(),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "phase": "commentary",
                    "content": [{
                        "type": "output_text",
                        "text": "Updated the workspace card hierarchy."
                    }]
                }
            })
            .to_string(),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "name": "exec",
                    "input": "secret command arguments"
                }
            })
            .to_string(),
        ]
        .join("\n")
            + "\n";
        write_rollout(fixture.path(), &lines);

        let observer = CodexSessionObserver::new(fixture.path().to_owned());
        let observed = observer.observe_at(Uuid::new_v4(), &workspace, now_unix_ms());

        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].session_id, session_id);
        assert_eq!(observed[0].status, AgentObservationStatus::Working);
        assert_eq!(
            observed[0].activity,
            Some(AgentObservationActivity::RunningCommand)
        );
        assert_eq!(
            observed[0].latest_update.as_deref(),
            Some("Updated the workspace card hierarchy.")
        );
        assert_eq!(
            observed[0].update_kind,
            Some(AgentObservationUpdateKind::Progress)
        );
        let serialized = serde_json::to_string(&observed).expect("serialized observation");
        assert!(!serialized.contains("private instructions"));
        assert!(!serialized.contains("secret command"));
    }

    #[test]
    fn reports_idle_after_the_matching_turn_completes() {
        let fixture = TempDir::new().expect("fixture");
        let workspace = fixture.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let session_id = Uuid::new_v4();
        let lines = [
            session_meta(session_id, &workspace),
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-1"}
            })
            .to_string(),
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "task_complete",
                    "turn_id": "turn-1",
                    "last_agent_message": "Implemented the workspace overview and all checks passed.\nWTS_CHANGE_REQUEST_PROPOSAL: {\"schemaVersion\":1,\"repositoryId\":\"repo_checkout\",\"sourceHeadCommitOid\":\"0123456789abcdef0123456789abcdef01234567\",\"title\":\"PLATFORM-42: Validate admission\",\"body\":\"## Summary\\n\\nValidate admission.\",\"issueKeys\":[\"PLATFORM-42\"]}"
                }
            })
            .to_string(),
        ]
        .join("\n")
            + "\n";
        write_rollout(fixture.path(), &lines);

        let observer = CodexSessionObserver::new(fixture.path().to_owned());
        let observed = observer.observe_at(Uuid::new_v4(), &workspace, now_unix_ms());

        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].status, AgentObservationStatus::Idle);
        assert_eq!(observed[0].activity, None);
        assert_eq!(
            observed[0].latest_update.as_deref(),
            Some("Implemented the workspace overview and all checks passed.")
        );
        assert_eq!(
            observed[0].update_kind,
            Some(AgentObservationUpdateKind::Completion)
        );
        assert_eq!(observed[0].change_request_proposals.len(), 1);
        assert_eq!(
            observed[0].change_request_proposals[0].repository_id,
            "repo_checkout"
        );
        assert!(
            !observed[0]
                .latest_update
                .as_deref()
                .unwrap_or_default()
                .contains("WTS_CHANGE_REQUEST_PROPOSAL")
        );
    }

    #[test]
    fn reports_a_bounded_question_without_exposing_the_prompt() {
        let fixture = TempDir::new().expect("fixture");
        let workspace = fixture.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let session_id = Uuid::new_v4();
        let lines = [
            session_meta(session_id, &workspace),
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-1"}
            })
            .to_string(),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "request_user_input",
                    "call_id": "question-1",
                    "arguments": serde_json::json!({
                        "questions": [{"question": "private question with a secret"}]
                    }).to_string()
                }
            })
            .to_string(),
        ]
        .join("\n")
            + "\n";
        write_rollout(fixture.path(), &lines);

        let observed = CodexSessionObserver::new(fixture.path().to_owned()).observe_at(
            Uuid::new_v4(),
            &workspace,
            now_unix_ms(),
        );

        assert_eq!(observed[0].needs_input, Some(AgentNeedsInput::question()));
        let serialized = serde_json::to_string(&observed).expect("serialized observation");
        assert!(!serialized.contains("private question"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn reports_only_the_fixed_access_detail_and_clears_it_after_the_tool_result() {
        let fixture = TempDir::new().expect("fixture");
        let workspace = fixture.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let session_id = Uuid::new_v4();
        let access_call = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "access-1",
                    "input": serde_json::json!({
                        "cmd": "private command --token secret",
                        "justification": "private access reason",
                        "sandbox_permissions": "require_escalated"
                }).to_string()
            }
        })
        .to_string();
        let pending_lines = [
            session_meta(session_id, &workspace),
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-1"}
            })
            .to_string(),
            access_call.clone(),
        ]
        .join("\n")
            + "\n";
        let path = write_rollout(fixture.path(), &pending_lines);
        let observer = CodexSessionObserver::new(fixture.path().to_owned());

        let pending = observer.observe_at(Uuid::new_v4(), &workspace, now_unix_ms());
        assert_eq!(pending[0].needs_input, Some(AgentNeedsInput::access()));
        let serialized = serde_json::to_string(&pending).expect("serialized observation");
        assert!(!serialized.contains("private command"));
        assert!(!serialized.contains("private access reason"));
        assert!(!serialized.contains("secret"));

        let resolved_lines = [
            session_meta(session_id, &workspace),
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-1"}
            })
            .to_string(),
            access_call,
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "access-1",
                    "output": "private command output"
                }
            })
            .to_string(),
        ]
        .join("\n")
            + "\n";
        fs::write(path, resolved_lines).expect("resolved rollout");

        let resolved = observer.observe_at(Uuid::new_v4(), &workspace, now_unix_ms());
        assert_eq!(resolved[0].needs_input, None);
    }

    #[test]
    fn ignores_sessions_for_another_workspace_or_client() {
        let fixture = TempDir::new().expect("fixture");
        let workspace = fixture.path().join("workspace");
        let other = fixture.path().join("other");
        fs::create_dir(&workspace).expect("workspace");
        fs::create_dir(&other).expect("other workspace");
        write_rollout(
            fixture.path(),
            &(session_meta(Uuid::new_v4(), &other) + "\n"),
        );

        let observer = CodexSessionObserver::new(fixture.path().to_owned());
        assert!(
            observer
                .observe_at(Uuid::new_v4(), &workspace, now_unix_ms())
                .is_empty()
        );
    }

    #[test]
    fn maps_one_global_scan_to_the_matching_saved_workspace() {
        let fixture = TempDir::new().expect("fixture");
        let first_workspace = fixture.path().join("first-workspace");
        let second_workspace = fixture.path().join("second-workspace");
        fs::create_dir(&first_workspace).expect("first workspace");
        fs::create_dir(&second_workspace).expect("second workspace");
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let lines = [
            session_meta(session_id, &second_workspace),
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-1"}
            })
            .to_string(),
            serde_json::json!({
                "type": "response_item",
                "payload": {"type": "custom_tool_call", "name": "apply_patch"}
            })
            .to_string(),
        ]
        .join("\n")
            + "\n";
        write_rollout(fixture.path(), &lines);

        let observer = CodexSessionObserver::new(fixture.path().to_owned());
        let observed = observer.observe_workspaces_at(
            &[(first_id, first_workspace), (second_id, second_workspace)],
            now_unix_ms(),
        );

        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].workspace_id, second_id);
        assert_eq!(observed[0].session_id, session_id);
        assert_eq!(
            observed[0].activity,
            Some(AgentObservationActivity::Editing)
        );
    }

    #[test]
    fn maps_an_active_vscode_turn_after_the_workspace_is_renamed() {
        let fixture = TempDir::new().expect("fixture");
        let workspace_id = Uuid::new_v4();
        let current_workspace = fixture.path().join(format!("new-title-{workspace_id}"));
        let previous_workspace = fixture.path().join(format!("old-title-{workspace_id}"));
        let previous_worktree = previous_workspace.join("repository--repo_123");
        fs::create_dir(&current_workspace).expect("current workspace");
        let session_id = Uuid::new_v4();
        let lines = [
            session_meta(session_id, &previous_worktree),
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "task_started", "turn_id": "turn-after-rename"}
            })
            .to_string(),
            serde_json::json!({
                "type": "response_item",
                "payload": {"type": "custom_tool_call", "name": "exec"}
            })
            .to_string(),
        ]
        .join("\n")
            + "\n";
        write_rollout(fixture.path(), &lines);

        let observer = CodexSessionObserver::new(fixture.path().to_owned());
        let observed = observer.observe_at(workspace_id, &current_workspace, now_unix_ms());

        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0].workspace_id, workspace_id);
        assert_eq!(observed[0].session_id, session_id);
        assert_eq!(observed[0].status, AgentObservationStatus::Working);
    }

    #[test]
    fn bounds_agent_authored_updates_without_copying_control_text() {
        let oversized = format!("{}\u{0007}", "x".repeat(900));
        let update = bounded_agent_update(&oversized).expect("bounded update");

        assert!(!update.contains('\u{0007}'));
        assert_eq!(update.chars().count(), MAX_AGENT_UPDATE_CHARS + 1);
        assert!(update.ends_with('…'));

        let lines = bounded_agent_update("first\nsecond\nthird\nfourth\nfifth")
            .expect("line-bounded update");
        assert_eq!(lines.lines().count(), 4);
        assert!(!lines.contains("fifth"));
    }
}
