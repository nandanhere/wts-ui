use crate::{
    AgentChangeRequestProposal, AgentMrLinkProposal,
    agent_sessions::{
        CHANGE_REQUEST_PROPOSAL_PREFIX, MR_LINK_PROPOSAL_PREFIX,
        parse_agent_change_request_proposals, parse_agent_mr_link_proposals,
    },
};
use serde::{Deserialize, Serialize, de::IgnoredAny};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
    sync::{Mutex, OnceLock},
};
use uuid::Uuid;

pub const AGENT_OBSERVATION_SCHEMA_VERSION: u32 = 1;
const MAX_CANDIDATE_FILES: usize = 128;
const MAX_DIRECTORY_DEPTH: usize = 4;
const MAX_METADATA_LINE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_EVENT_LINE_BYTES: u64 = 2 * 1024 * 1024;
const STALE_AFTER_MS: i64 = 5 * 60 * 1_000;
const RECENT_EVENT_GRACE_MS: i64 = 30 * 1_000;
const MAX_AGENT_UPDATE_CHARS: usize = 800;
const MAX_AGENT_UPDATE_LINES: usize = 4;
/// WTS keeps at most this many recent agent work periods per session.
const MAX_WORK_PERIODS: usize = 200;

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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mr_link_proposals: Vec<AgentMrLinkProposal>,
    pub started_at_unix_ms: i64,
    pub last_event_at_unix_ms: i64,
    /// Periods in which the agent worked on a turn, oldest first. Time between
    /// turns, when the agent waits for the user, is not included.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub work_periods: Vec<AgentWorkPeriod>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkPeriod {
    pub started_at_unix_ms: i64,
    pub ended_at_unix_ms: i64,
    /// True while the turn has not finished. The end is then the last file change.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ongoing: bool,
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
    let work_periods = event_state.work_periods(candidate.modified_at);
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
        model: event_state.model,
        latest_update: event_state.latest_update,
        update_kind: event_state.update_kind,
        needs_input: event_state.pending_input.values().next().cloned(),
        change_request_proposals: event_state.change_request_proposals,
        mr_link_proposals: event_state.mr_link_proposals,
        started_at_unix_ms: candidate.created_at,
        last_event_at_unix_ms: candidate.modified_at,
        work_periods,
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
    timestamp: Option<String>,
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
    model: Option<String>,
    content: Option<Vec<RolloutContent>>,
    last_agent_message: Option<String>,
    started_at: Option<i64>,
    completed_at: Option<i64>,
    duration_ms: Option<i64>,
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

#[derive(Clone, Default)]
struct EventState {
    active_turns: BTreeSet<String>,
    last_terminal: Option<TerminalEvent>,
    activity: Option<AgentObservationActivity>,
    saw_activity: bool,
    latest_update: Option<String>,
    update_kind: Option<AgentObservationUpdateKind>,
    pending_input: BTreeMap<String, AgentNeedsInput>,
    change_request_proposals: Vec<AgentChangeRequestProposal>,
    mr_link_proposals: Vec<AgentMrLinkProposal>,
    turn_starts: BTreeMap<String, i64>,
    finished_periods: Vec<AgentWorkPeriod>,
    last_agent_signal: Option<i64>,
    split_turns: BTreeSet<String>,
    model: Option<String>,
}

impl EventState {
    fn work_periods(&self, last_change_unix_ms: i64) -> Vec<AgentWorkPeriod> {
        let mut periods = self.finished_periods.clone();
        for (turn_id, started) in &self.turn_starts {
            if self.active_turns.contains(turn_id) {
                periods.push(AgentWorkPeriod {
                    started_at_unix_ms: *started,
                    ended_at_unix_ms: last_change_unix_ms.max(*started),
                    ongoing: true,
                });
            }
        }
        periods.sort_by_key(|period| period.started_at_unix_ms);
        let excess = periods.len().saturating_sub(MAX_WORK_PERIODS);
        periods.drain(..excess);
        periods
    }
}

struct CachedEventState {
    identity: (u64, u64),
    modified: Option<SystemTime>,
    length: u64,
    offset: u64,
    state: EventState,
}

fn read_event_state(path: &Path) -> Option<EventState> {
    static CACHE: OnceLock<Mutex<BTreeMap<PathBuf, CachedEventState>>> = OnceLock::new();
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let identity = (0, metadata.created().ok().and_then(system_time_unix_ms).unwrap_or(0) as u64);
    let length = metadata.len();
    let modified = metadata.modified().ok();
    let mut cache = CACHE.get_or_init(Default::default).lock().ok()?;
    let cached = cache.remove(path).filter(|entry| {
        entry.identity == identity && entry.length <= length
            && (entry.length != length || entry.modified == modified)
    });
    let (mut offset, mut state) = cached.map(|entry| (entry.offset, entry.state)).unwrap_or_default();
    let mut reader = BufReader::new(file);
    reader.seek(SeekFrom::Start(offset)).ok()?;
    let mut line = Vec::new();
    loop {
        line.clear();
        let count = reader.by_ref().take(MAX_EVENT_LINE_BYTES + 1).read_until(b'\n', &mut line).ok()?;
        if count == 0 { break; }
        if line.last() != Some(&b'\n') {
            if count as u64 <= MAX_EVENT_LINE_BYTES { break; }
            // Skip large tool payloads without retaining them in memory.
            if reader.skip_until(b'\n').ok()? == 0 { break; }
            offset = reader.stream_position().ok()?;
            continue;
        }
        offset = reader.stream_position().ok()?;
        let Ok(record) = serde_json::from_slice::<RolloutRecord>(&line) else {
            continue;
        };
        let Some(payload) = record.payload else {
            continue;
        };
        let was_waiting = !state.pending_input.is_empty();
        let timestamp = record.timestamp.as_deref().and_then(rfc3339_to_unix_ms);
        let agent_signal = record.record_type.as_deref() == Some("response_item")
            && (payload.role.as_deref() == Some("assistant")
                || matches!(payload.payload_type.as_deref(), Some("reasoning" | "function_call" | "custom_tool_call" | "function_call_output" | "custom_tool_call_output")));
        match (
            record.record_type.as_deref(),
            payload.payload_type.as_deref(),
        ) {
            (Some("turn_context"), _) => {
                if let Some(model) = payload.model.filter(|model| !model.is_empty() && model.len() <= 200 && !model.chars().any(char::is_control)) {
                    state.model = Some(model);
                }
            }
            (Some("event_msg"), Some("task_started")) => {
                if let Some(turn_id) = payload.turn_id {
                    // A new turn supersedes an interrupted turn without a terminal event.
                    if !state.active_turns.contains(&turn_id) {
                        for (old_id, start) in std::mem::take(&mut state.turn_starts) {
                            if state.active_turns.contains(&old_id)
                                && let Some(end) = state.last_agent_signal
                                && end >= start
                            {
                                state.finished_periods.push(AgentWorkPeriod {
                                    started_at_unix_ms: start, ended_at_unix_ms: end, ongoing: false,
                                });
                            }
                        }
                        state.active_turns.clear();
                    }
                    if let Some(started) = payload.started_at.and_then(seconds_to_unix_ms).or_else(|| record.timestamp.as_deref().and_then(rfc3339_to_unix_ms)) {
                        state.turn_starts.insert(turn_id.clone(), started);
                    }
                    state.active_turns.insert(turn_id);
                }
                state.last_terminal = None;
                state.activity = Some(AgentObservationActivity::Thinking);
                state.saw_activity = true;
                state.latest_update = None;
                state.update_kind = None;
                state.pending_input.clear();
                state.change_request_proposals.clear();
                state.mr_link_proposals.clear();
            }
            (Some("event_msg"), Some("task_complete")) => {
                if let Some(turn_id) = payload.turn_id.as_deref() {
                    state.active_turns.remove(turn_id);
                    let split = state.split_turns.remove(turn_id);
                    let started = state.turn_starts.get(turn_id).copied().or_else(|| {
                        if split { None } else { payload.started_at.and_then(seconds_to_unix_ms) }
                    });
                    let ended = payload.completed_at.and_then(seconds_to_unix_ms).or(timestamp).or_else(|| {
                        started.zip(payload.duration_ms).map(|(start, duration)| start.saturating_add(duration))
                    });
                    if let (Some(start), Some(end)) = (started, ended)
                        && end >= start
                    {
                        state.finished_periods.push(AgentWorkPeriod {
                            started_at_unix_ms: start,
                            ended_at_unix_ms: end,
                            ongoing: false,
                        });
                    }
                    state.turn_starts.remove(turn_id);
                }
                state.last_terminal = Some(TerminalEvent::Completed);
                state.activity = None;
                state.pending_input.clear();
                if let Some(message) = payload.last_agent_message.as_deref() {
                    state.mr_link_proposals = parse_agent_mr_link_proposals(message);
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
                    if let (Some(start), Some(end)) = (
                        state.turn_starts.remove(&turn_id),
                        record.timestamp.as_deref().and_then(rfc3339_to_unix_ms),
                    ) && end >= start
                    {
                        state.finished_periods.push(AgentWorkPeriod {
                            started_at_unix_ms: start,
                            ended_at_unix_ms: end,
                            ongoing: false,
                        });
                    }
                } else {
                    state.active_turns.clear();
                    state.turn_starts.clear();
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
                    let mr_proposals = parse_agent_mr_link_proposals(text);
                    if !mr_proposals.is_empty() {
                        state.mr_link_proposals = mr_proposals;
                    }
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
        let waiting = !state.pending_input.is_empty();
        if !was_waiting && waiting {
            if let Some(end) = timestamp {
                for (turn_id, start) in std::mem::take(&mut state.turn_starts) {
                    state.split_turns.insert(turn_id);
                    if end >= start {
                        state.finished_periods.push(AgentWorkPeriod {
                            started_at_unix_ms: start, ended_at_unix_ms: end, ongoing: false,
                        });
                    }
                }
            }
        } else if was_waiting && !waiting {
            if let Some(start) = timestamp {
                for turn_id in &state.active_turns {
                    state.turn_starts.entry(turn_id.clone()).or_insert(start);
                }
            }
        }
        if agent_signal { state.last_agent_signal = timestamp.or(state.last_agent_signal); }
        let excess = state.finished_periods.len().saturating_sub(MAX_WORK_PERIODS);
        state.finished_periods.drain(..excess);
    }
    while cache.len() >= MAX_CANDIDATE_FILES {
        cache.pop_first();
    }
    cache.insert(path.to_owned(), CachedEventState {
        identity, modified, length, offset, state: state.clone(),
    });
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
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with(CHANGE_REQUEST_PROPOSAL_PREFIX)
                && !line.starts_with(MR_LINK_PROPOSAL_PREFIX)
        })
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

/// Codex writes turn times in whole Unix seconds.
fn seconds_to_unix_ms(seconds: i64) -> Option<i64> {
    (seconds > 0).then(|| seconds.checked_mul(1_000)).flatten()
}

/// Parses the UTC "2026-09-24T05:57:02.677Z" form that Codex writes.
fn rfc3339_to_unix_ms(value: &str) -> Option<i64> {
    let (date, time) = value.strip_suffix('Z')?.split_once('T')?;
    let mut date_parts = date.splitn(3, '-').map(str::parse::<i64>);
    let (year, month, day) = (date_parts.next()?.ok()?, date_parts.next()?.ok()?, date_parts.next()?.ok()?);
    let (clock, fraction) = time.split_once('.').unwrap_or((time, "0"));
    let mut clock_parts = clock.splitn(3, ':').map(str::parse::<i64>);
    let (hour, minute, second) = (clock_parts.next()?.ok()?, clock_parts.next()?.ok()?, clock_parts.next()?.ok()?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let millis = format!("{fraction:0<3}").get(..3)?.parse::<i64>().ok()?;
    // Days from the civil date (Howard Hinnant's algorithm).
    let (y, m) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * m + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) + millis)
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
    fn excludes_time_waiting_for_an_answer_inside_a_turn() {
        let fixture = TempDir::new().unwrap();
        let records = [
            serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"t","started_at":1000}}),
            serde_json::json!({"timestamp":"1970-01-01T00:18:20Z","type":"event_msg","payload":{"type":"request_user_input","call_id":"q"}}),
            serde_json::json!({"timestamp":"1970-01-01T00:28:20Z","type":"event_msg","payload":{"type":"user_input_response","call_id":"q"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"t","started_at":1000,"completed_at":1800}}),
        ];
        let path = write_rollout(fixture.path(), &(records.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n") + "\n"));
        let periods = read_event_state(&path).unwrap().work_periods(1_800_000);
        assert_eq!(periods.len(), 2);
        assert_eq!(periods.iter().map(|p| p.ended_at_unix_ms - p.started_at_unix_ms).sum::<i64>(), 200_000);
        assert!(periods.iter().all(|p| !p.ongoing));
    }

    #[test]
    fn ends_an_orphaned_turn_at_its_last_activity_before_a_new_turn() {
        let fixture = TempDir::new().unwrap();
        let path = write_rollout(fixture.path(), &([
            serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"old","started_at":1000}}).to_string(),
            serde_json::json!({"timestamp":"1970-01-01T00:18:20Z","type":"response_item","payload":{"type":"reasoning"}}).to_string(),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"new","started_at":10000}}).to_string(),
        ].join("\n") + "\n"));
        let periods = read_event_state(&path).unwrap().work_periods(10_100_000);
        assert_eq!(periods.len(), 2);
        assert_eq!(periods[0].ended_at_unix_ms, 1_100_000);
        assert!(!periods[0].ongoing);
        assert_eq!(periods[1].started_at_unix_ms, 10_000_000);
        assert!(periods[1].ongoing);
    }

    #[test]
    fn retains_work_across_large_logs_appends_and_replacement() {
        use std::io::Write;
        let fixture = TempDir::new().unwrap();
        let start = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"t1\",\"started_at\":1000}}\n";
        let path = write_rollout(fixture.path(), start);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        // A large response must not hide the turn start or allocate its full body.
        file.write_all(&vec![b'x'; 9 * 1024 * 1024]).unwrap();
        file.write_all(b"\n").unwrap();
        let state = read_event_state(&path).unwrap();
        assert_eq!(state.work_periods(1_100_000)[0].started_at_unix_ms, 1_000_000);
        assert!(state.work_periods(1_100_000)[0].ongoing);
        // A partially written record must be retried on the next read.
        file.write_all(b"{\"type\":\"event_msg\",\"payload\":").unwrap();
        assert!(read_event_state(&path).unwrap().work_periods(1_100_000)[0].ongoing);
        file.write_all(b"{\"type\":\"task_complete\",\"turn_id\":\"t1\",\"completed_at\":1100}}\n").unwrap();
        let periods = read_event_state(&path).unwrap().work_periods(1_200_000);
        assert_eq!(periods.len(), 1);
        assert_eq!(periods[0].ended_at_unix_ms, 1_100_000);
        assert!(!periods[0].ongoing);
        assert_eq!(read_event_state(&path).unwrap().work_periods(1_200_000), periods);
        fs::write(&path, start.replace("1000", "2000")).unwrap();
        assert_eq!(read_event_state(&path).unwrap().work_periods(2_100_000)[0].started_at_unix_ms, 2_000_000);
        let replacement = fixture.path().join("replacement");
        fs::write(&replacement, start.replace("1000", "3000")).unwrap();
        fs::rename(replacement, &path).unwrap();
        assert_eq!(read_event_state(&path).unwrap().work_periods(3_100_000)[0].started_at_unix_ms, 3_000_000);
    }

    #[test]
    fn observes_an_active_vscode_turn_without_exposing_private_fields() {
        let fixture = TempDir::new().expect("fixture");
        let workspace = fixture.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let session_id = Uuid::new_v4();
        let lines = [
            session_meta(session_id, &workspace),
            serde_json::json!({"type":"turn_context","payload":{"model":"test-model"}}).to_string(),
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
        assert_eq!(observed[0].model.as_deref(), Some("test-model"));
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
    fn reports_agent_work_periods_from_turn_times_and_excludes_waiting_time() {
        let fixture = TempDir::new().expect("fixture");
        let workspace = fixture.path().join("workspace");
        fs::create_dir(&workspace).expect("workspace");
        let session_id = Uuid::new_v4();
        let event = |payload: serde_json::Value, timestamp: &str| {
            serde_json::json!({"timestamp": timestamp, "type": "event_msg", "payload": payload}).to_string()
        };
        let lines = [
            session_meta(session_id, &workspace),
            // Turn 1 runs 15 minutes, then the agent waits for the user for an hour.
            event(serde_json::json!({"type": "task_started", "turn_id": "t1", "started_at": 1_790_229_422}), "2026-09-24T05:57:02.677Z"),
            event(serde_json::json!({"type": "task_complete", "turn_id": "t1", "started_at": 1_790_229_422, "completed_at": 1_790_230_322, "duration_ms": 899_705}), "2026-09-24T06:12:02.275Z"),
            // Turn 2 is stopped by the user after 2 minutes.
            event(serde_json::json!({"type": "task_started", "turn_id": "t2", "started_at": 1_790_233_922}), "2026-09-24T07:12:02.000Z"),
            event(serde_json::json!({"type": "turn_aborted", "turn_id": "t2"}), "2026-09-24T07:14:02.000Z"),
            // Turn 3 still runs.
            event(serde_json::json!({"type": "task_started", "turn_id": "t3", "started_at": 1_790_237_522}), "2026-09-24T08:12:02.000Z"),
        ]
        .join("\n")
            + "\n";
        write_rollout(fixture.path(), &lines);

        let observer = CodexSessionObserver::new(fixture.path().to_owned());
        let observed = observer.observe_at(Uuid::new_v4(), &workspace, now_unix_ms());
        let periods = &observed[0].work_periods;

        assert_eq!(periods.len(), 3);
        assert_eq!(
            periods[0],
            AgentWorkPeriod { started_at_unix_ms: 1_790_229_422_000, ended_at_unix_ms: 1_790_230_322_000, ongoing: false }
        );
        assert_eq!(
            periods[1],
            AgentWorkPeriod { started_at_unix_ms: 1_790_233_922_000, ended_at_unix_ms: 1_790_234_042_000, ongoing: false }
        );
        assert_eq!(periods[2].started_at_unix_ms, 1_790_237_522_000);
        assert!(periods[2].ongoing);
        assert_eq!(rfc3339_to_unix_ms("2026-09-24T05:57:02.677Z"), Some(1_790_229_422_677));
        let wire = serde_json::to_value(&observed[0]).expect("serialized");
        assert_eq!(wire["workPeriods"][0]["startedAtUnixMs"], 1_790_229_422_000_i64);
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
                    "last_agent_message": "Implemented the workspace overview and all checks passed.\nWTS_CHANGE_REQUEST_PROPOSAL: {\"schemaVersion\":1,\"repositoryId\":\"repo_orders\",\"sourceHeadCommitOid\":\"0123456789abcdef0123456789abcdef01234567\",\"title\":\"TASK-42: Validate admission\",\"body\":\"## Summary\\n\\nValidate admission.\",\"issueKeys\":[\"TASK-42\"]}\nWTS_MR_LINK_PROPOSAL: {\"schemaVersion\":1,\"repositoryId\":\"repo_orders\",\"iid\":43}"
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
        assert_eq!(observed[0].mr_link_proposals[0].iid, 43);
        assert_eq!(
            observed[0].change_request_proposals[0].repository_id,
            "repo_orders"
        );
        assert!(
            !observed[0]
                .latest_update
                .as_deref()
                .unwrap_or_default()
                .contains("WTS_CHANGE_REQUEST_PROPOSAL")
        );
        assert!(!observed[0].latest_update.as_deref().unwrap_or_default().contains("WTS_MR_LINK_PROPOSAL"));
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
