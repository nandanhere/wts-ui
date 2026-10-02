use crate::{AgentProvider, ObservedAgentSession, TerminalProvider};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use uuid::Uuid;

pub const AGENT_SESSION_SCHEMA_VERSION: u32 = 1;
const SESSION_FILE: &str = "agent-sessions-v1.json";
const MAX_SESSION_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RETAINED_SESSIONS: usize = 4_096;
const STALE_HEARTBEAT_AFTER_MS: i64 = 5 * 60 * 1_000;
pub(crate) const CHANGE_REQUEST_PROPOSAL_PREFIX: &str = "WTS_CHANGE_REQUEST_PROPOSAL:";
pub(crate) const MR_LINK_PROPOSAL_PREFIX: &str = "WTS_MR_LINK_PROPOSAL:";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMrLinkProposal {
    pub schema_version: u32,
    pub repository_id: String,
    pub iid: u64,
}

pub(crate) fn parse_agent_mr_link_proposals(value: &str) -> Vec<AgentMrLinkProposal> {
    value
        .lines()
        .filter_map(|line| line.trim().strip_prefix(MR_LINK_PROPOSAL_PREFIX))
        .filter(|json| json.len() <= 512)
        .filter_map(|json| serde_json::from_str::<AgentMrLinkProposal>(json.trim()).ok())
        .filter(valid_mr_link_proposal)
        .take(16)
        .collect()
}

fn valid_mr_link_proposal(proposal: &AgentMrLinkProposal) -> bool {
    proposal.schema_version == 1
        && !proposal.repository_id.is_empty()
        && proposal.repository_id.len() <= 160
        && proposal.repository_id.trim() == proposal.repository_id
        && proposal.iid > 0
        && proposal.iid <= 9_007_199_254_740_991
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSessionCategory {
    #[default]
    Uncategorized,
    Ideation,
    Investigation,
    Implementation,
    Verification,
    Review,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSessionStatus {
    Launching,
    HandoffAccepted,
    Running,
    Stopping,
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSessionFailure {
    LaunchRejected,
    ProviderFailed,
    ProcessExited,
    StaleHeartbeat,
    LaunchOutcomeUnknown,
    UserStopped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentChangeRequestProposal {
    pub schema_version: u32,
    pub repository_id: String,
    pub source_head_commit_oid: String,
    pub title: String,
    pub body: String,
    pub issue_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<AgentChangeRequestVerification>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentChangeRequestVerificationStatus {
    #[default]
    NotReported,
    Passed,
    Partial,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentChangeRequestVerification {
    pub status: AgentChangeRequestVerificationStatus,
    pub summary: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSession {
    pub schema_version: u32,
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub provider: AgentProvider,
    pub terminal: TerminalProvider,
    pub category: AgentSessionCategory,
    pub status: AgentSessionStatus,
    pub started_at_unix_ms: i64,
    pub last_heartbeat_at_unix_ms: i64,
    pub ended_at_unix_ms: Option<i64>,
    pub failure: Option<AgentSessionFailure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_input: Option<crate::AgentNeedsInput>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub change_request_proposals: Vec<AgentChangeRequestProposal>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mr_link_proposals: Vec<AgentMrLinkProposal>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSessionList {
    pub schema_version: u32,
    pub sessions: Vec<AgentSession>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observed_sessions: Vec<ObservedAgentSession>,
}

#[derive(Debug, Error)]
pub enum AgentSessionStoreError {
    #[error("agent session storage is unavailable")]
    Unavailable,
    #[error("agent session storage is invalid")]
    Invalid,
    #[error("agent session was not found")]
    NotFound,
    #[error("agent session is no longer running")]
    NotRunning,
}

#[derive(Clone)]
pub(crate) struct AgentSessionStore {
    root: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl AgentSessionStore {
    pub(crate) fn open(data_dir: &Path) -> Result<Self, AgentSessionStoreError> {
        if !data_dir.is_absolute()
            || data_dir
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        {
            return Err(AgentSessionStoreError::Invalid);
        }
        fs::create_dir_all(data_dir).map_err(|_| AgentSessionStoreError::Unavailable)?;
        set_private_directory_permissions(data_dir)?;
        let root = data_dir
            .canonicalize()
            .map_err(|_| AgentSessionStoreError::Unavailable)?;
        let store = Self {
            root,
            lock: Arc::new(Mutex::new(())),
        };
        let guard = store.acquire()?;
        if !store.path().exists() {
            store.write_locked(&AgentSessionList {
                schema_version: AGENT_SESSION_SCHEMA_VERSION,
                sessions: Vec::new(),
                observed_sessions: Vec::new(),
            })?;
        } else {
            let mut list = store.read_locked()?;
            if recover_orphaned(&mut list.sessions, now_unix_ms()?) {
                store.write_locked(&list)?;
            }
        }
        drop(guard);
        Ok(store)
    }

    pub(crate) fn start(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        terminal: TerminalProvider,
        category: AgentSessionCategory,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        self.start_at(workspace_id, provider, terminal, category, now_unix_ms()?)
    }

    pub(crate) fn begin_launch(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        terminal: TerminalProvider,
        category: AgentSessionCategory,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        let now = now_unix_ms()?;
        let _guard = self.acquire()?;
        let mut list = self.read_locked()?;
        recover_stale(&mut list.sessions, now);
        prune_terminal_sessions(&mut list.sessions);
        let session = AgentSession {
            schema_version: AGENT_SESSION_SCHEMA_VERSION,
            session_id: Uuid::new_v4(),
            workspace_id,
            provider,
            terminal,
            category,
            status: AgentSessionStatus::Launching,
            started_at_unix_ms: now,
            last_heartbeat_at_unix_ms: now,
            ended_at_unix_ms: None,
            failure: None,
            needs_input: None,
            change_request_proposals: Vec::new(),
            mr_link_proposals: Vec::new(),
        };
        list.sessions.push(session.clone());
        self.write_locked(&list)?;
        Ok(session)
    }

    pub(crate) fn accept_handoff(
        &self,
        session_id: Uuid,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        self.update_launch_at(
            session_id,
            now_unix_ms()?,
            AgentSessionStatus::HandoffAccepted,
            None,
        )
    }

    pub(crate) fn accept_owned_process(
        &self,
        session_id: Uuid,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        self.update_launch_at(
            session_id,
            now_unix_ms()?,
            AgentSessionStatus::Running,
            None,
        )
    }

    pub(crate) fn fail_launch(
        &self,
        session_id: Uuid,
        failure: AgentSessionFailure,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        self.update_launch_at(
            session_id,
            now_unix_ms()?,
            AgentSessionStatus::Failed,
            Some(failure),
        )
    }

    pub(crate) fn reject_launch(
        &self,
        session_id: Uuid,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        self.update_launch_at(
            session_id,
            now_unix_ms()?,
            AgentSessionStatus::Failed,
            Some(AgentSessionFailure::LaunchRejected),
        )
    }

    pub(crate) fn heartbeat(
        &self,
        session_id: Uuid,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        self.update_running_at(session_id, now_unix_ms()?, None)
    }

    pub(crate) fn set_needs_input(
        &self,
        session_id: Uuid,
        needs_input: Option<crate::AgentNeedsInput>,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        let now = now_unix_ms()?;
        let _guard = self.acquire()?;
        let mut list = self.read_locked()?;
        recover_stale(&mut list.sessions, now);
        let session = list
            .sessions
            .iter_mut()
            .find(|session| session.session_id == session_id)
            .ok_or(AgentSessionStoreError::NotFound)?;
        if session.status != AgentSessionStatus::Running {
            self.write_locked(&list)?;
            return Err(AgentSessionStoreError::NotRunning);
        }
        session.last_heartbeat_at_unix_ms = now;
        if session.needs_input != needs_input {
            session.needs_input = needs_input;
        }
        let session = session.clone();
        self.write_locked(&list)?;
        Ok(session)
    }

    pub(crate) fn set_change_request_proposals(
        &self,
        session_id: Uuid,
        proposals: Vec<AgentChangeRequestProposal>,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        if proposals.len() > 16 || proposals.iter().any(|proposal| !valid_proposal(proposal)) {
            return Err(AgentSessionStoreError::Invalid);
        }
        let now = now_unix_ms()?;
        let _guard = self.acquire()?;
        let mut list = self.read_locked()?;
        recover_stale(&mut list.sessions, now);
        let session = list
            .sessions
            .iter_mut()
            .find(|session| session.session_id == session_id)
            .ok_or(AgentSessionStoreError::NotFound)?;
        if !matches!(
            session.status,
            AgentSessionStatus::Running | AgentSessionStatus::Stopping
        ) {
            self.write_locked(&list)?;
            return Err(AgentSessionStoreError::NotRunning);
        }
        session.last_heartbeat_at_unix_ms = now;
        session.change_request_proposals = proposals;
        let session = session.clone();
        self.write_locked(&list)?;
        Ok(session)
    }

    pub(crate) fn set_mr_link_proposals(
        &self,
        session_id: Uuid,
        proposals: Vec<AgentMrLinkProposal>,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        if proposals.len() > 16 || proposals.iter().any(|proposal| !valid_mr_link_proposal(proposal))
        {
            return Err(AgentSessionStoreError::Invalid);
        }
        let _guard = self.acquire()?;
        let mut list = self.read_locked()?;
        let session = list
            .sessions
            .iter_mut()
            .find(|session| session.session_id == session_id)
            .ok_or(AgentSessionStoreError::NotFound)?;
        if !matches!(
            session.status,
            AgentSessionStatus::Running | AgentSessionStatus::Stopping
        ) {
            return Err(AgentSessionStoreError::NotRunning);
        }
        session.mr_link_proposals = proposals;
        let session = session.clone();
        self.write_locked(&list)?;
        Ok(session)
    }

    pub(crate) fn finish(&self, session_id: Uuid) -> Result<AgentSession, AgentSessionStoreError> {
        self.update_running_at(
            session_id,
            now_unix_ms()?,
            Some((AgentSessionStatus::Completed, None)),
        )
    }

    pub(crate) fn fail(
        &self,
        session_id: Uuid,
        failure: AgentSessionFailure,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        self.update_running_at(
            session_id,
            now_unix_ms()?,
            Some((AgentSessionStatus::Failed, Some(failure))),
        )
    }

    pub(crate) fn request_stop(
        &self,
        session_id: Uuid,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        let now = now_unix_ms()?;
        let _guard = self.acquire()?;
        let mut list = self.read_locked()?;
        let session = list
            .sessions
            .iter_mut()
            .find(|session| session.session_id == session_id)
            .ok_or(AgentSessionStoreError::NotFound)?;
        if !matches!(
            session.status,
            AgentSessionStatus::Launching | AgentSessionStatus::Running
        ) {
            return Err(AgentSessionStoreError::NotRunning);
        }
        session.status = AgentSessionStatus::Stopping;
        session.needs_input = None;
        session.last_heartbeat_at_unix_ms = now;
        let session = session.clone();
        self.write_locked(&list)?;
        Ok(session)
    }

    pub(crate) fn interrupt(
        &self,
        session_id: Uuid,
        failure: AgentSessionFailure,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        self.update_running_at(
            session_id,
            now_unix_ms()?,
            Some((AgentSessionStatus::Interrupted, Some(failure))),
        )
    }

    pub(crate) fn list(
        &self,
        workspace_id: Option<Uuid>,
    ) -> Result<AgentSessionList, AgentSessionStoreError> {
        self.list_at(workspace_id, now_unix_ms()?)
    }

    fn start_at(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        terminal: TerminalProvider,
        category: AgentSessionCategory,
        now: i64,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        let _guard = self.acquire()?;
        let mut list = self.read_locked()?;
        recover_stale(&mut list.sessions, now);
        prune_terminal_sessions(&mut list.sessions);
        let session = AgentSession {
            schema_version: AGENT_SESSION_SCHEMA_VERSION,
            session_id: Uuid::new_v4(),
            workspace_id,
            provider,
            terminal,
            category,
            status: AgentSessionStatus::Running,
            started_at_unix_ms: now,
            last_heartbeat_at_unix_ms: now,
            ended_at_unix_ms: None,
            failure: None,
            needs_input: None,
            change_request_proposals: Vec::new(),
            mr_link_proposals: Vec::new(),
        };
        list.sessions.push(session.clone());
        self.write_locked(&list)?;
        Ok(session)
    }

    fn update_running_at(
        &self,
        session_id: Uuid,
        now: i64,
        terminal: Option<(AgentSessionStatus, Option<AgentSessionFailure>)>,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        let _guard = self.acquire()?;
        let mut list = self.read_locked()?;
        recover_stale(&mut list.sessions, now);
        let session = list
            .sessions
            .iter_mut()
            .find(|session| session.session_id == session_id)
            .ok_or(AgentSessionStoreError::NotFound)?;
        if !matches!(
            session.status,
            AgentSessionStatus::Running | AgentSessionStatus::Stopping
        ) {
            self.write_locked(&list)?;
            return Err(AgentSessionStoreError::NotRunning);
        }
        session.last_heartbeat_at_unix_ms = now;
        if let Some((status, failure)) = terminal {
            session.status = status;
            session.ended_at_unix_ms = (status != AgentSessionStatus::Stopping).then_some(now);
            session.failure = failure;
            session.needs_input = None;
        }
        let session = session.clone();
        self.write_locked(&list)?;
        Ok(session)
    }

    fn update_launch_at(
        &self,
        session_id: Uuid,
        now: i64,
        status: AgentSessionStatus,
        failure: Option<AgentSessionFailure>,
    ) -> Result<AgentSession, AgentSessionStoreError> {
        let _guard = self.acquire()?;
        let mut list = self.read_locked()?;
        recover_stale(&mut list.sessions, now);
        let session = list
            .sessions
            .iter_mut()
            .find(|session| session.session_id == session_id)
            .ok_or(AgentSessionStoreError::NotFound)?;
        if session.status != AgentSessionStatus::Launching {
            self.write_locked(&list)?;
            return Err(AgentSessionStoreError::NotRunning);
        }
        session.last_heartbeat_at_unix_ms = now;
        session.status = status;
        session.ended_at_unix_ms = (status != AgentSessionStatus::Running).then_some(now);
        session.failure = failure;
        if status != AgentSessionStatus::Running {
            session.needs_input = None;
        }
        let session = session.clone();
        self.write_locked(&list)?;
        Ok(session)
    }

    fn list_at(
        &self,
        workspace_id: Option<Uuid>,
        now: i64,
    ) -> Result<AgentSessionList, AgentSessionStoreError> {
        let _guard = self.acquire()?;
        let mut list = self.read_locked()?;
        if recover_stale(&mut list.sessions, now) {
            self.write_locked(&list)?;
        }
        if let Some(workspace_id) = workspace_id {
            list.sessions
                .retain(|session| session.workspace_id == workspace_id);
        }
        list.sessions.sort_by(|left, right| {
            right
                .started_at_unix_ms
                .cmp(&left.started_at_unix_ms)
                .then_with(|| left.session_id.cmp(&right.session_id))
        });
        Ok(list)
    }

    fn acquire(&self) -> Result<MutexGuard<'_, ()>, AgentSessionStoreError> {
        self.lock
            .lock()
            .map_err(|_| AgentSessionStoreError::Unavailable)
    }

    fn path(&self) -> PathBuf {
        self.root.join(SESSION_FILE)
    }

    fn read_locked(&self) -> Result<AgentSessionList, AgentSessionStoreError> {
        let path = self.path();
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| AgentSessionStoreError::Unavailable)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_SESSION_FILE_BYTES
        {
            return Err(AgentSessionStoreError::Invalid);
        }
        let bytes = fs::read(path).map_err(|_| AgentSessionStoreError::Unavailable)?;
        let mut list: AgentSessionList =
            serde_json::from_slice(&bytes).map_err(|_| AgentSessionStoreError::Invalid)?;
        if list.schema_version != AGENT_SESSION_SCHEMA_VERSION
            || list.sessions.len() > MAX_RETAINED_SESSIONS
            || list.sessions.iter().any(|session| !valid_session(session))
        {
            return Err(AgentSessionStoreError::Invalid);
        }
        list.observed_sessions.clear();
        Ok(list)
    }

    fn write_locked(&self, list: &AgentSessionList) -> Result<(), AgentSessionStoreError> {
        let bytes = serde_json::to_vec_pretty(list).map_err(|_| AgentSessionStoreError::Invalid)?;
        if bytes.len() as u64 > MAX_SESSION_FILE_BYTES {
            return Err(AgentSessionStoreError::Invalid);
        }
        let temporary = self
            .root
            .join(format!(".agent-sessions-{}.tmp", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| AgentSessionStoreError::Unavailable)?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, self.path())?;
            Ok::<(), std::io::Error>(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(AgentSessionStoreError::Unavailable);
        }
        Ok(())
    }
}

fn valid_session(session: &AgentSession) -> bool {
    session.schema_version == AGENT_SESSION_SCHEMA_VERSION
        && !session.session_id.is_nil()
        && !session.workspace_id.is_nil()
        && session.started_at_unix_ms >= 0
        && session.last_heartbeat_at_unix_ms >= session.started_at_unix_ms
        && match session.status {
            AgentSessionStatus::Launching => {
                session.ended_at_unix_ms.is_none()
                    && session.failure.is_none()
                    && session.needs_input.is_none()
            }
            AgentSessionStatus::HandoffAccepted => {
                session.ended_at_unix_ms.is_some()
                    && session.failure.is_none()
                    && session.needs_input.is_none()
            }
            AgentSessionStatus::Running => {
                session.ended_at_unix_ms.is_none()
                    && session.failure.is_none()
                    && session
                        .needs_input
                        .as_ref()
                        .is_none_or(crate::AgentNeedsInput::is_valid)
            }
            AgentSessionStatus::Stopping => {
                session.ended_at_unix_ms.is_none()
                    && session.failure.is_none()
                    && session.needs_input.is_none()
            }
            AgentSessionStatus::Completed => {
                session.ended_at_unix_ms.is_some()
                    && session.failure.is_none()
                    && session.needs_input.is_none()
            }
            AgentSessionStatus::Failed | AgentSessionStatus::Interrupted => {
                session.ended_at_unix_ms.is_some()
                    && session.failure.is_some()
                    && session.needs_input.is_none()
            }
        }
        && session
            .ended_at_unix_ms
            .is_none_or(|ended| ended >= session.last_heartbeat_at_unix_ms)
        && session.change_request_proposals.len() <= 16
        && session.change_request_proposals.iter().all(valid_proposal)
        && session.mr_link_proposals.len() <= 16
        && session.mr_link_proposals.iter().all(valid_mr_link_proposal)
}

#[cfg(test)]
mod mr_link_tests {
    use super::*;

    #[test]
    fn parses_only_bounded_numeric_mr_hints() {
        let parsed = parse_agent_mr_link_proposals(
            "WTS_MR_LINK_PROPOSAL: {\"schemaVersion\":1,\"repositoryId\":\"repo_senzu\",\"iid\":43}\n\
             WTS_MR_LINK_PROPOSAL: {\"schemaVersion\":1,\"repositoryId\":\"repo_senzu\",\"iid\":0}\n\
             WTS_MR_LINK_PROPOSAL: {\"schemaVersion\":1,\"repositoryId\":\"repo_senzu\",\"iid\":44,\"url\":\"https://other.example\"}",
        );
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].repository_id, "repo_senzu");
        assert_eq!(parsed[0].iid, 43);
    }
}

pub(crate) fn valid_proposal(proposal: &AgentChangeRequestProposal) -> bool {
    proposal.schema_version == 1
        && !proposal.repository_id.is_empty()
        && proposal.repository_id.len() <= 160
        && proposal.repository_id.trim() == proposal.repository_id
        && matches!(proposal.source_head_commit_oid.len(), 40 | 64)
        && proposal
            .source_head_commit_oid
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        && !proposal.title.trim().is_empty()
        && proposal.title.chars().count() <= 256
        && !proposal.body.trim().is_empty()
        && proposal.body.chars().count() <= 16_000
        && proposal.issue_keys.len() <= 16
        && proposal.issue_keys.iter().all(|key| {
            let Some((project, number)) = key.split_once('-') else {
                return false;
            };
            !project.is_empty()
                && project.len() <= 32
                && project
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
                && !number.is_empty()
                && number.len() <= 16
                && number.bytes().all(|byte| byte.is_ascii_digit())
        })
        && proposal.verification.as_ref().is_none_or(|verification| {
            !verification.summary.trim().is_empty()
                && verification.summary.chars().count() <= 1_024
                && verification
                    .summary
                    .chars()
                    .all(|character| !character.is_control() || character == '\n')
        })
        && proposal
            .title
            .chars()
            .chain(proposal.body.chars())
            .all(|character| !character.is_control() || character == '\n' || character == '\t')
}

pub(crate) fn parse_agent_change_request_proposals(value: &str) -> Vec<AgentChangeRequestProposal> {
    value
        .lines()
        .filter_map(|line| line.trim().strip_prefix(CHANGE_REQUEST_PROPOSAL_PREFIX))
        .filter_map(|json| serde_json::from_str::<AgentChangeRequestProposal>(json.trim()).ok())
        .filter(valid_proposal)
        .take(16)
        .collect()
}

fn recover_stale(sessions: &mut [AgentSession], now: i64) -> bool {
    let mut changed = false;
    for session in sessions {
        if now.saturating_sub(session.last_heartbeat_at_unix_ms) > STALE_HEARTBEAT_AFTER_MS {
            match session.status {
                AgentSessionStatus::Launching => {
                    session.status = AgentSessionStatus::Interrupted;
                    session.ended_at_unix_ms = Some(now);
                    session.failure = Some(AgentSessionFailure::LaunchOutcomeUnknown);
                    session.needs_input = None;
                    changed = true;
                }
                AgentSessionStatus::Running | AgentSessionStatus::Stopping => {
                    session.status = AgentSessionStatus::Interrupted;
                    session.ended_at_unix_ms = Some(now);
                    session.failure = Some(AgentSessionFailure::StaleHeartbeat);
                    session.needs_input = None;
                    changed = true;
                }
                _ => {}
            }
        }
    }
    changed
}

fn recover_orphaned(sessions: &mut [AgentSession], now: i64) -> bool {
    let mut changed = false;
    for session in sessions {
        let failure = match session.status {
            AgentSessionStatus::Launching => Some(AgentSessionFailure::LaunchOutcomeUnknown),
            AgentSessionStatus::Running | AgentSessionStatus::Stopping => {
                Some(AgentSessionFailure::ProcessExited)
            }
            _ => None,
        };
        if let Some(failure) = failure {
            session.status = AgentSessionStatus::Interrupted;
            session.last_heartbeat_at_unix_ms = now;
            session.ended_at_unix_ms = Some(now);
            session.failure = Some(failure);
            session.needs_input = None;
            changed = true;
        }
    }
    changed
}

fn prune_terminal_sessions(sessions: &mut Vec<AgentSession>) {
    if sessions.len() < MAX_RETAINED_SESSIONS {
        return;
    }
    if let Some((index, _)) = sessions
        .iter()
        .enumerate()
        .filter(|(_, session)| {
            !matches!(
                session.status,
                AgentSessionStatus::Launching
                    | AgentSessionStatus::Running
                    | AgentSessionStatus::Stopping
            )
        })
        .min_by_key(|(_, session)| (session.started_at_unix_ms, session.session_id))
    {
        sessions.remove(index);
    }
}

fn now_unix_ms() -> Result<i64, AgentSessionStoreError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AgentSessionStoreError::Unavailable)?;
    i64::try_from(elapsed.as_millis()).map_err(|_| AgentSessionStoreError::Unavailable)
}

fn set_private_directory_permissions(path: &Path) -> Result<(), AgentSessionStoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| AgentSessionStoreError::Unavailable)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use tempfile::TempDir;

    fn store() -> (TempDir, AgentSessionStore) {
        let fixture = TempDir::new().expect("temporary data directory");
        let store = AgentSessionStore::open(fixture.path()).expect("agent session store");
        (fixture, store)
    }

    #[test]
    fn lifecycle_is_persisted_without_prompt_or_transcript_content() {
        let (fixture, store) = store();
        let workspace_id = Uuid::new_v4();
        let started = store
            .start_at(
                workspace_id,
                AgentProvider::Codex,
                TerminalProvider::Warp,
                AgentSessionCategory::Investigation,
                1_000,
            )
            .expect("start");
        store
            .update_running_at(started.session_id, 2_000, None)
            .expect("heartbeat");
        store
            .update_running_at(
                started.session_id,
                3_000,
                Some((AgentSessionStatus::Completed, None)),
            )
            .expect("finish");

        let bytes = fs::read(fixture.path().join(SESSION_FILE)).expect("persisted ledger");
        let text = String::from_utf8(bytes.clone()).expect("UTF-8 ledger");
        assert!(!text.contains("prompt"));
        assert!(!text.contains("transcript"));
        assert!(!text.contains("output"));
        let json: Value = serde_json::from_slice(&bytes).expect("serialized contract");
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["sessions"][0]["workspaceId"], workspace_id.to_string());
        assert_eq!(json["sessions"][0]["provider"], "codex");
        assert_eq!(json["sessions"][0]["terminal"], "warp");
        assert_eq!(json["sessions"][0]["category"], "investigation");
        assert_eq!(json["sessions"][0]["status"], "completed");
        assert_eq!(json["sessions"][0]["startedAtUnixMs"], 1_000);
        assert_eq!(json["sessions"][0]["lastHeartbeatAtUnixMs"], 3_000);
        assert_eq!(json["sessions"][0]["endedAtUnixMs"], 3_000);
        assert!(json["sessions"][0]["failure"].is_null());

        let reopened = AgentSessionStore::open(fixture.path()).expect("reopen");
        let sessions = reopened
            .list_at(Some(workspace_id), 3_100)
            .expect("read persisted sessions");
        assert_eq!(sessions.sessions.len(), 1);
        assert_eq!(sessions.sessions[0].status, AgentSessionStatus::Completed);
    }

    #[test]
    fn managed_input_signal_is_persisted_with_fixed_text_and_cleared() {
        let (fixture, store) = store();
        let started = store
            .start_at(
                Uuid::new_v4(),
                AgentProvider::Codex,
                TerminalProvider::Terminal,
                AgentSessionCategory::Implementation,
                now_unix_ms().expect("current time"),
            )
            .expect("start managed session");

        let pending = store
            .set_needs_input(started.session_id, Some(crate::AgentNeedsInput::access()))
            .expect("record access request");
        assert_eq!(pending.needs_input, Some(crate::AgentNeedsInput::access()));
        let persisted =
            fs::read_to_string(fixture.path().join(SESSION_FILE)).expect("persisted sessions");
        assert!(persisted.contains("Agent needs access."));
        assert!(!persisted.contains("prompt"));
        assert!(!persisted.contains("transcript"));

        let resumed = store
            .set_needs_input(started.session_id, None)
            .expect("clear access request");
        assert_eq!(resumed.needs_input, None);
        assert_eq!(
            store
                .list_at(
                    Some(started.workspace_id),
                    resumed.last_heartbeat_at_unix_ms
                )
                .expect("list managed session")
                .sessions[0]
                .needs_input,
            None
        );
    }

    #[test]
    fn opens_a_version_one_ledger_without_the_optional_input_signal() {
        let fixture = TempDir::new().expect("temporary data directory");
        let session_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();
        fs::write(
            fixture.path().join(SESSION_FILE),
            serde_json::json!({
                "schemaVersion": 1,
                "sessions": [{
                    "schemaVersion": 1,
                    "sessionId": session_id,
                    "workspaceId": workspace_id,
                    "provider": "codex",
                    "terminal": "terminal",
                    "category": "implementation",
                    "status": "completed",
                    "startedAtUnixMs": 1_000,
                    "lastHeartbeatAtUnixMs": 2_000,
                    "endedAtUnixMs": 2_000,
                    "failure": null
                }]
            })
            .to_string(),
        )
        .expect("legacy session ledger");

        let store = AgentSessionStore::open(fixture.path()).expect("open compatible ledger");
        let sessions = store
            .list_at(Some(workspace_id), 3_000)
            .expect("list compatible session");
        assert_eq!(sessions.sessions[0].session_id, session_id);
        assert_eq!(sessions.sessions[0].needs_input, None);
    }

    #[test]
    fn rejects_a_persisted_input_signal_with_arbitrary_detail() {
        let fixture = TempDir::new().expect("temporary data directory");
        fs::write(
            fixture.path().join(SESSION_FILE),
            serde_json::json!({
                "schemaVersion": 1,
                "sessions": [{
                    "schemaVersion": 1,
                    "sessionId": Uuid::new_v4(),
                    "workspaceId": Uuid::new_v4(),
                    "provider": "codex",
                    "terminal": "terminal",
                    "category": "implementation",
                    "status": "running",
                    "startedAtUnixMs": 1_000,
                    "lastHeartbeatAtUnixMs": 2_000,
                    "endedAtUnixMs": null,
                    "failure": null,
                    "needsInput": {
                        "kind": "question",
                        "detail": "Should I use the private production token?"
                    }
                }]
            })
            .to_string(),
        )
        .expect("invalid session ledger");

        assert!(matches!(
            AgentSessionStore::open(fixture.path()),
            Err(AgentSessionStoreError::Invalid)
        ));
    }

    #[test]
    fn change_request_proposal_is_persisted_against_only_its_session() {
        let (fixture, store) = store();
        let workspace_id = Uuid::new_v4();
        let proposing = store
            .start(
                workspace_id,
                AgentProvider::Codex,
                TerminalProvider::Terminal,
                AgentSessionCategory::Implementation,
            )
            .expect("start proposing session");
        let other = store
            .start(
                workspace_id,
                AgentProvider::Codex,
                TerminalProvider::Terminal,
                AgentSessionCategory::Review,
            )
            .expect("start other session");
        let proposal = AgentChangeRequestProposal {
            schema_version: 1,
            repository_id: "repo_checkout".to_owned(),
            source_head_commit_oid: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            title: "PLATFORM-42: Validate admission".to_owned(),
            body: "## Summary\n\nValidate admission.".to_owned(),
            issue_keys: vec!["PLATFORM-42".to_owned()],
            verification: Some(AgentChangeRequestVerification {
                status: AgentChangeRequestVerificationStatus::Passed,
                summary: "Targeted checks passed.".to_owned(),
            }),
        };
        store
            .set_change_request_proposals(proposing.session_id, vec![proposal.clone()])
            .expect("record proposal");
        drop(store);

        let reopened = AgentSessionStore::open(fixture.path()).expect("reopen store");
        let sessions = reopened
            .list(Some(workspace_id))
            .expect("list persisted sessions");
        assert_eq!(
            sessions
                .sessions
                .iter()
                .find(|session| session.session_id == proposing.session_id)
                .expect("proposing session")
                .change_request_proposals,
            vec![proposal]
        );
        assert!(
            sessions
                .sessions
                .iter()
                .find(|session| session.session_id == other.session_id)
                .expect("other session")
                .change_request_proposals
                .is_empty()
        );
    }

    #[test]
    fn mr_link_hint_is_persisted_only_for_the_reporting_session() {
        let (fixture, store) = store();
        let workspace_id = Uuid::new_v4();
        let reporting = store
            .start(
                workspace_id,
                AgentProvider::Codex,
                TerminalProvider::Terminal,
                AgentSessionCategory::Implementation,
            )
            .expect("start reporting session");
        let other = store
            .start(
                workspace_id,
                AgentProvider::Codex,
                TerminalProvider::Terminal,
                AgentSessionCategory::Review,
            )
            .expect("start other session");
        store
            .set_mr_link_proposals(
                reporting.session_id,
                vec![AgentMrLinkProposal {
                    schema_version: 1,
                    repository_id: "repo_senzu".to_owned(),
                    iid: 43,
                }],
            )
            .expect("save hint");
        store.finish(reporting.session_id).expect("finish session");
        let reopened = AgentSessionStore::open(fixture.path()).expect("reopen ledger");
        let sessions = reopened.list(Some(workspace_id)).expect("list sessions");
        assert_eq!(
            sessions.sessions.iter().find(|session| session.session_id == reporting.session_id)
                .unwrap().mr_link_proposals[0].iid,
            43
        );
        assert!(
            sessions.sessions.iter().find(|session| session.session_id == other.session_id)
                .unwrap().mr_link_proposals.is_empty()
        );
    }

    #[test]
    fn live_owned_session_is_interrupted_and_persisted_immediately_on_reopen() {
        let (fixture, store) = store();
        let started = store
            .start_at(
                Uuid::new_v4(),
                AgentProvider::Hermes,
                TerminalProvider::Terminal,
                AgentSessionCategory::Implementation,
                5_000,
            )
            .expect("start");
        drop(store);

        let reopened = AgentSessionStore::open(fixture.path()).expect("reopen");
        let recovered = reopened
            .list_at(None, 5_001)
            .expect("read recovered session");
        assert_eq!(
            recovered.sessions[0].status,
            AgentSessionStatus::Interrupted
        );
        assert_eq!(
            recovered.sessions[0].failure,
            Some(AgentSessionFailure::ProcessExited)
        );
        assert!(recovered.sessions[0].ended_at_unix_ms.is_some());

        let persisted: AgentSessionList = serde_json::from_slice(
            &fs::read(fixture.path().join(SESSION_FILE)).expect("persisted recovery"),
        )
        .expect("valid recovered ledger");
        assert_eq!(persisted.sessions[0].session_id, started.session_id);
        assert_eq!(
            persisted.sessions[0].status,
            AgentSessionStatus::Interrupted
        );
    }

    #[test]
    fn terminal_handoff_is_not_reported_as_observed_running_time() {
        let (_fixture, store) = store();
        let launch = store
            .begin_launch(
                Uuid::new_v4(),
                AgentProvider::Codex,
                TerminalProvider::Warp,
                AgentSessionCategory::Uncategorized,
            )
            .expect("begin launch");
        assert_eq!(launch.status, AgentSessionStatus::Launching);
        let handoff = store
            .accept_handoff(launch.session_id)
            .expect("accept handoff");
        assert_eq!(handoff.status, AgentSessionStatus::HandoffAccepted);
        assert!(handoff.ended_at_unix_ms.is_some());

        let much_later = handoff.started_at_unix_ms + STALE_HEARTBEAT_AFTER_MS * 10;
        let persisted = store.list_at(None, much_later).expect("list handoff");
        assert_eq!(
            persisted.sessions[0].status,
            AgentSessionStatus::HandoffAccepted
        );
        assert_eq!(persisted.sessions[0].failure, None);
    }

    #[test]
    fn stale_launch_intent_is_recovered_as_unknown_not_running() {
        let (_fixture, store) = store();
        let launch = store
            .begin_launch(
                Uuid::new_v4(),
                AgentProvider::Hermes,
                TerminalProvider::Terminal,
                AgentSessionCategory::Uncategorized,
            )
            .expect("begin launch");
        let much_later = launch.started_at_unix_ms + STALE_HEARTBEAT_AFTER_MS + 1;
        let recovered = store.list_at(None, much_later).expect("recover launch");
        assert_eq!(
            recovered.sessions[0].status,
            AgentSessionStatus::Interrupted
        );
        assert_eq!(
            recovered.sessions[0].failure,
            Some(AgentSessionFailure::LaunchOutcomeUnknown)
        );
    }

    #[test]
    fn owned_launch_is_not_running_until_spawn_and_spawn_failure_is_terminal() {
        let (_fixture, store) = store();
        let launched = store
            .begin_launch(
                Uuid::new_v4(),
                AgentProvider::Codex,
                TerminalProvider::Terminal,
                AgentSessionCategory::Implementation,
            )
            .expect("begin launch");
        assert_eq!(launched.status, AgentSessionStatus::Launching);
        assert!(launched.ended_at_unix_ms.is_none());

        let running = store
            .accept_owned_process(launched.session_id)
            .expect("accept owned process");
        assert_eq!(running.status, AgentSessionStatus::Running);
        assert!(running.ended_at_unix_ms.is_none());

        let failed_launch = store
            .begin_launch(
                Uuid::new_v4(),
                AgentProvider::OpenCode,
                TerminalProvider::Terminal,
                AgentSessionCategory::Review,
            )
            .expect("begin failed launch");
        let failed = store
            .fail_launch(failed_launch.session_id, AgentSessionFailure::ProcessExited)
            .expect("persist spawn failure");
        assert_eq!(failed.status, AgentSessionStatus::Failed);
        assert_eq!(failed.failure, Some(AgentSessionFailure::ProcessExited));
        assert!(failed.ended_at_unix_ms.is_some());
    }

    #[test]
    fn launching_owned_session_is_interrupted_immediately_on_reopen() {
        let (fixture, store) = store();
        let launched = store
            .begin_launch(
                Uuid::new_v4(),
                AgentProvider::Hermes,
                TerminalProvider::Terminal,
                AgentSessionCategory::Investigation,
            )
            .expect("begin launch");
        drop(store);

        let reopened = AgentSessionStore::open(fixture.path()).expect("reopen");
        let recovered = reopened.list(None).expect("recovered sessions");
        assert_eq!(recovered.sessions[0].session_id, launched.session_id);
        assert_eq!(
            recovered.sessions[0].status,
            AgentSessionStatus::Interrupted
        );
        assert_eq!(
            recovered.sessions[0].failure,
            Some(AgentSessionFailure::LaunchOutcomeUnknown)
        );
    }

    #[test]
    fn terminal_session_rejects_later_heartbeat_without_rewriting_state() {
        let (_fixture, store) = store();
        let started = store
            .start_at(
                Uuid::new_v4(),
                AgentProvider::OpenCode,
                TerminalProvider::Terminal,
                AgentSessionCategory::Review,
                10_000,
            )
            .expect("start");
        store
            .update_running_at(
                started.session_id,
                11_000,
                Some((
                    AgentSessionStatus::Failed,
                    Some(AgentSessionFailure::ProviderFailed),
                )),
            )
            .expect("fail");
        assert!(matches!(
            store.update_running_at(started.session_id, 12_000, None),
            Err(AgentSessionStoreError::NotRunning)
        ));
        let persisted = store.list_at(None, 12_000).expect("list");
        assert_eq!(persisted.sessions[0].last_heartbeat_at_unix_ms, 11_000);
        assert_eq!(
            persisted.sessions[0].failure,
            Some(AgentSessionFailure::ProviderFailed)
        );
    }

    #[cfg(unix)]
    #[test]
    fn ledger_file_and_directory_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let (fixture, _store) = store();
        assert_eq!(
            fs::metadata(fixture.path())
                .expect("directory metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(fixture.path().join(SESSION_FILE))
                .expect("file metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
