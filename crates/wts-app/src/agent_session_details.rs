use crate::{AgentChangeRequestProposal, AgentProvider, AgentSession};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub const AGENT_SESSION_DETAIL_SCHEMA_VERSION: u32 = 1;
const MAX_RETAINED_DETAILS: usize = 256;
const MAX_EVENTS_PER_SESSION: usize = 100;
const MAX_EVENT_SUMMARY_CHARS: usize = 800;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentModelAuthority {
    ProviderDefault,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentModelSelection {
    pub authority: AgentModelAuthority,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSessionEventKind {
    Started,
    Thinking,
    UsesTool,
    EditsFiles,
    RunsCommand,
    Searches,
    AgentUpdate,
    NeedsQuestion,
    NeedsAccess,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSessionEvent {
    pub sequence: u64,
    pub observed_at_unix_ms: i64,
    pub kind: AgentSessionEventKind,
    pub summary: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSessionDetail {
    pub schema_version: u32,
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub provider: AgentProvider,
    pub task: String,
    pub model_selection: AgentModelSelection,
    pub events: Vec<AgentSessionEvent>,
    pub events_truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentProcessEventKind {
    Thinking,
    UsesTool,
    EditsFiles,
    RunsCommand,
    Searches,
    AgentUpdate,
    NeedsQuestion,
    NeedsAccess,
    Completed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentProcessEvent {
    pub kind: AgentProcessEventKind,
    pub summary: String,
    pub change_request_proposals: Vec<AgentChangeRequestProposal>,
}

#[derive(Clone, Default)]
pub(crate) struct AgentSessionDetailStore {
    inner: Arc<Mutex<BTreeMap<Uuid, StoredDetail>>>,
}

struct StoredDetail {
    detail: AgentSessionDetail,
    terminal: bool,
}

impl AgentSessionDetailStore {
    pub(crate) fn begin(&self, session: &AgentSession, task: &str) {
        let Ok(mut details) = self.inner.lock() else {
            return;
        };
        if details.len() >= MAX_RETAINED_DETAILS {
            let oldest_terminal = details
                .iter()
                .filter(|(_, stored)| stored.terminal)
                .min_by_key(|(_, stored)| {
                    stored
                        .detail
                        .events
                        .last()
                        .map(|event| event.observed_at_unix_ms)
                        .unwrap_or(0)
                })
                .map(|(session_id, _)| *session_id);
            let Some(oldest_terminal) = oldest_terminal else {
                return;
            };
            details.remove(&oldest_terminal);
        }
        let started = AgentSessionEvent {
            sequence: 1,
            observed_at_unix_ms: now_unix_ms(),
            kind: AgentSessionEventKind::Started,
            summary: format!("{} starts the task.", provider_name(session.provider)),
        };
        details.insert(
            session.session_id,
            StoredDetail {
                detail: AgentSessionDetail {
                    schema_version: AGENT_SESSION_DETAIL_SCHEMA_VERSION,
                    session_id: session.session_id,
                    workspace_id: session.workspace_id,
                    provider: session.provider,
                    task: task.to_owned(),
                    model_selection: AgentModelSelection {
                        authority: AgentModelAuthority::ProviderDefault,
                        model: None,
                        reasoning_effort: None,
                    },
                    events: vec![started],
                    events_truncated: false,
                },
                terminal: false,
            },
        );
    }

    pub(crate) fn record(&self, session_id: Uuid, event: AgentProcessEvent) {
        let Ok(mut details) = self.inner.lock() else {
            return;
        };
        let Some(stored) = details.get_mut(&session_id) else {
            return;
        };
        let summary = match event.kind {
            AgentProcessEventKind::NeedsQuestion => "Agent has a question.".to_owned(),
            AgentProcessEventKind::NeedsAccess => "Agent needs access.".to_owned(),
            _ => bounded_summary(&event.summary),
        };
        if summary.is_empty() {
            return;
        }
        if stored.detail.events.len() == MAX_EVENTS_PER_SESSION {
            // Keep the start event and the newest bounded progress events.
            stored.detail.events.remove(1);
            stored.detail.events_truncated = true;
        }
        let sequence = stored
            .detail
            .events
            .last()
            .map(|event| event.sequence.saturating_add(1))
            .unwrap_or(1);
        stored.detail.events.push(AgentSessionEvent {
            sequence,
            observed_at_unix_ms: now_unix_ms(),
            kind: event.kind.into(),
            summary,
        });
    }

    pub(crate) fn finish(&self, session_id: Uuid) {
        if let Ok(mut details) = self.inner.lock()
            && let Some(stored) = details.get_mut(&session_id)
        {
            stored.terminal = true;
        }
    }

    pub(crate) fn get(&self, session_id: Uuid) -> Option<AgentSessionDetail> {
        self.inner
            .lock()
            .ok()?
            .get(&session_id)
            .map(|stored| stored.detail.clone())
    }
}

impl From<AgentProcessEventKind> for AgentSessionEventKind {
    fn from(value: AgentProcessEventKind) -> Self {
        match value {
            AgentProcessEventKind::Thinking => Self::Thinking,
            AgentProcessEventKind::UsesTool => Self::UsesTool,
            AgentProcessEventKind::EditsFiles => Self::EditsFiles,
            AgentProcessEventKind::RunsCommand => Self::RunsCommand,
            AgentProcessEventKind::Searches => Self::Searches,
            AgentProcessEventKind::AgentUpdate => Self::AgentUpdate,
            AgentProcessEventKind::NeedsQuestion => Self::NeedsQuestion,
            AgentProcessEventKind::NeedsAccess => Self::NeedsAccess,
            AgentProcessEventKind::Completed => Self::Completed,
        }
    }
}

fn bounded_summary(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .filter(|character| !character.is_control() || *character == '\n')
        .take(MAX_EVENT_SUMMARY_CHARS)
        .collect()
}

fn provider_name(provider: AgentProvider) -> &'static str {
    match provider {
        AgentProvider::Codex => "Codex",
        AgentProvider::OpenCode => "OpenCode",
        AgentProvider::Hermes => "Hermes",
    }
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentSessionCategory, AgentSessionStatus, TerminalProvider};

    fn session() -> AgentSession {
        AgentSession {
            schema_version: 1,
            session_id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
            provider: AgentProvider::Codex,
            terminal: TerminalProvider::Terminal,
            category: AgentSessionCategory::Implementation,
            status: AgentSessionStatus::Running,
            started_at_unix_ms: 1,
            last_heartbeat_at_unix_ms: 1,
            ended_at_unix_ms: None,
            failure: None,
            needs_input: None,
            change_request_proposals: Vec::new(),
        }
    }

    #[test]
    fn detail_keeps_task_and_events_in_memory_with_provider_default_authority() {
        let store = AgentSessionDetailStore::default();
        let session = session();
        store.begin(&session, "Fix the checkout flow.");
        store.record(
            session.session_id,
            AgentProcessEvent {
                kind: AgentProcessEventKind::AgentUpdate,
                summary: "I found the failing boundary.".to_owned(),
                change_request_proposals: Vec::new(),
            },
        );

        let detail = store.get(session.session_id).expect("session detail");
        assert_eq!(detail.task, "Fix the checkout flow.");
        assert_eq!(
            detail.model_selection.authority,
            AgentModelAuthority::ProviderDefault
        );
        assert_eq!(detail.model_selection.model, None);
        assert_eq!(detail.events.len(), 2);
        assert_eq!(detail.events[1].kind, AgentSessionEventKind::AgentUpdate);
    }

    #[test]
    fn detail_bounds_event_count_and_removes_control_text() {
        let store = AgentSessionDetailStore::default();
        let session = session();
        store.begin(&session, "Inspect the workspace.");
        for index in 0..(MAX_EVENTS_PER_SESSION + 10) {
            store.record(
                session.session_id,
                AgentProcessEvent {
                    kind: AgentProcessEventKind::UsesTool,
                    summary: format!("Uses tool {index}.\0private"),
                    change_request_proposals: Vec::new(),
                },
            );
        }

        let detail = store.get(session.session_id).expect("session detail");
        assert_eq!(detail.events.len(), MAX_EVENTS_PER_SESSION);
        assert!(detail.events_truncated);
        assert_eq!(detail.events[0].kind, AgentSessionEventKind::Started);
        assert!(
            detail
                .events
                .iter()
                .all(|event| !event.summary.contains('\0'))
        );
        assert!(
            detail
                .events
                .windows(2)
                .all(|events| events[0].sequence < events[1].sequence)
        );
    }

    #[test]
    fn detail_replaces_private_input_request_text_with_fixed_status() {
        let store = AgentSessionDetailStore::default();
        let session = session();
        store.begin(&session, "Inspect the workspace.");
        store.record(
            session.session_id,
            AgentProcessEvent {
                kind: AgentProcessEventKind::NeedsQuestion,
                summary: "Should I use the private production token?".to_owned(),
                change_request_proposals: Vec::new(),
            },
        );

        let detail = store.get(session.session_id).expect("session detail");
        assert_eq!(detail.events[1].kind, AgentSessionEventKind::NeedsQuestion);
        assert_eq!(detail.events[1].summary, "Agent has a question.");
        assert!(!detail.events[1].summary.contains("token"));
    }
}
