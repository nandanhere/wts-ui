//! Durable user review choices for a saved task result.
use super::*;
use std::io::Read;

const MAX_DECISIONS: usize = 64;
const MAX_REASON_BYTES: usize = 4_096;
const MAX_RECORD_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTurnDecisionKind {
    Accepted,
    Kept,
    Rejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTurnDecisionsState {
    Ready,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordAgentTurnDecisionRequest {
    pub request_id: Uuid,
    pub expected_revision: u64,
    pub expected_receipt_digest: String,
    pub kind: AgentTurnDecisionKind,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnDecisionCheck {
    pub run_id: Uuid,
    pub check_id: String,
    pub status: AgentTurnCheckStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnDecision {
    pub decision_id: Uuid,
    pub revision: u64,
    pub kind: AgentTurnDecisionKind,
    pub reason: String,
    pub created_at_unix_ms: i64,
    pub after_checkpoint_id: Uuid,
    pub receipt_digest: String,
    pub source_context_sha256: String,
    pub checks_state: AgentTurnChecksState,
    pub checks: Vec<AgentTurnDecisionCheck>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnDecisions {
    pub schema_version: u32,
    pub conversation_id: Uuid,
    pub request_id: Uuid,
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub repository_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_checkpoint_id: Option<Uuid>,
    pub receipt_digest: String,
    pub source_context_sha256: String,
    pub revision: u64,
    pub state: AgentTurnDecisionsState,
    pub checks_state: AgentTurnChecksState,
    pub detail: String,
    pub decisions: Vec<AgentTurnDecision>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDecision {
    request: RecordAgentTurnDecisionRequest,
    decision: AgentTurnDecision,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDecisions {
    schema_version: u32,
    conversation_id: Uuid,
    turn_request_id: Uuid,
    session_id: Uuid,
    workspace_id: Uuid,
    repository_id: String,
    receipt_digest: String,
    records: Vec<StoredDecision>,
}

fn digest(receipt: &AgentTurnChanges) -> Result<String, LocalWtsError> {
    Ok(sha256_bytes(&serde_json::to_vec(receipt).map_err(
        |_| LocalWtsError::AgentConversationUnavailable,
    )?))
}

fn valid_request(request: &RecordAgentTurnDecisionRequest) -> bool {
    !request.request_id.is_nil()
        && request.expected_revision < MAX_DECISIONS as u64
        && request.reason.len() <= MAX_REASON_BYTES
        && !request
            .reason
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        && request
            .expected_receipt_digest
            .strip_prefix("sha256:")
            .is_some_and(|value| {
                value.len() == 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
}

fn record_path(store: &ConversationStore, session_id: Uuid) -> PathBuf {
    store
        .root
        .join("turn-decisions")
        .join(format!("{session_id}.json"))
}

fn read_decisions(
    store: &ConversationStore,
    receipt: &AgentTurnChanges,
) -> Result<StoredDecisions, LocalWtsError> {
    let expected_digest = digest(receipt)?;
    let path = record_path(store, receipt.session_id);
    if path
        .parent()
        .and_then(|parent| parent.symlink_metadata().ok())
        .is_some_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StoredDecisions {
                schema_version: 1,
                conversation_id: receipt.conversation_id,
                turn_request_id: receipt.request_id,
                session_id: receipt.session_id,
                workspace_id: receipt.workspace_id,
                repository_id: receipt.repository_id.clone(),
                receipt_digest: expected_digest,
                records: vec![],
            });
        }
        Err(_) => return Err(LocalWtsError::AgentConversationUnavailable),
    };
    let metadata = file
        .metadata()
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if bytes.len() > MAX_RECORD_BYTES as usize {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let stored: StoredDecisions =
        serde_json::from_slice(&bytes).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if stored.schema_version != 1
        || stored.conversation_id != receipt.conversation_id
        || stored.turn_request_id != receipt.request_id
        || stored.session_id != receipt.session_id
        || stored.workspace_id != receipt.workspace_id
        || stored.repository_id != receipt.repository_id
        || stored.receipt_digest != expected_digest
        || stored.records.len() > MAX_DECISIONS
    {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let mut ids = BTreeSet::new();
    for (index, record) in stored.records.iter().enumerate() {
        let decision = &record.decision;
        let mut run_ids = BTreeSet::new();
        if !valid_request(&record.request)
            || !ids.insert(decision.decision_id)
            || decision.decision_id != record.request.request_id
            || decision.revision != index as u64 + 1
            || record.request.expected_revision != index as u64
            || decision.kind != record.request.kind
            || decision.reason != record.request.reason
            || !(0..=8_640_000_000_000_000).contains(&decision.created_at_unix_ms)
            || decision.receipt_digest != expected_digest
            || record.request.expected_receipt_digest != expected_digest
            || decision.source_context_sha256 != receipt.source_context_sha256
            || Some(decision.after_checkpoint_id)
                != receipt.after.as_ref().map(|after| after.checkpoint_id)
            || decision.checks.len() > 64
            || decision.checks.iter().any(|check| {
                check.run_id.is_nil()
                    || !run_ids.insert(check.run_id)
                    || check.check_id.is_empty()
                    || check.check_id.len() > 128
                    || !check.check_id.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                    })
            })
        {
            return Err(LocalWtsError::AgentConversationUnavailable);
        }
    }
    Ok(stored)
}

fn response(
    receipt: &AgentTurnChanges,
    stored: StoredDecisions,
    checks_state: AgentTurnChecksState,
) -> AgentTurnDecisions {
    let ready = matches!(
        receipt.state,
        AgentTurnChangesState::Ready | AgentTurnChangesState::Incomplete
    ) && receipt.after.is_some()
        && receipt.completed_at_unix_ms.is_some()
        && stored.records.len() < MAX_DECISIONS;
    AgentTurnDecisions {
        schema_version: 1,
        conversation_id: receipt.conversation_id,
        request_id: receipt.request_id,
        session_id: receipt.session_id,
        workspace_id: receipt.workspace_id,
        repository_id: receipt.repository_id.clone(),
        after_checkpoint_id: receipt.after.as_ref().map(|after| after.checkpoint_id),
        receipt_digest: stored.receipt_digest,
        source_context_sha256: receipt.source_context_sha256.clone(),
        revision: stored.records.len() as u64,
        state: if ready { AgentTurnDecisionsState::Ready } else { AgentTurnDecisionsState::Unavailable },
        checks_state,
        detail: if ready {
            "Record your review choice for this saved result. A decision records your choice and check results. It does not apply files or publish changes."
        } else if stored.records.len() >= MAX_DECISIONS {
            "This result has reached its limit of 64 decisions. Review the saved history."
        } else {
            "This task has no saved after state. Review its available changes. A new task will capture a new result."
        }.to_owned(),
        decisions: stored.records.into_iter().map(|record| record.decision).collect(),
    }
}

impl LocalWtsService {
    pub fn get_agent_turn_decisions(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<AgentTurnDecisions, LocalWtsError> {
        let receipt = self.get_agent_turn_changes(conversation_id, request_id)?;
        let checks_state = self
            .get_agent_turn_checks(conversation_id, request_id)
            .map(|checks| checks.state)
            .unwrap_or(AgentTurnChecksState::Unavailable);
        let store = &self.inner.agent_conversations;
        let _guard = store
            .lock
            .lock()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let _disk = store.disk_lock()?;
        Ok(response(
            &receipt,
            read_decisions(store, &receipt)?,
            checks_state,
        ))
    }

    pub fn record_agent_turn_decision(
        &self,
        conversation_id: Uuid,
        turn_request_id: Uuid,
        request: RecordAgentTurnDecisionRequest,
    ) -> Result<AgentTurnDecisions, LocalWtsError> {
        if !valid_request(&request) {
            return Err(LocalWtsError::InvalidAgentConversation);
        }
        let receipt = self.get_agent_turn_changes(conversation_id, turn_request_id)?;
        let checks = self
            .get_agent_turn_checks(conversation_id, turn_request_id)
            .ok();
        let checks_state = checks
            .as_ref()
            .map(|checks| checks.state)
            .unwrap_or(AgentTurnChecksState::Unavailable);
        let store = &self.inner.agent_conversations;
        let _guard = store
            .lock
            .lock()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let _disk = store.disk_lock()?;
        let mut stored = read_decisions(store, &receipt)?;
        if let Some(previous) = stored
            .records
            .iter()
            .find(|record| record.request.request_id == request.request_id)
        {
            if previous.request != request {
                return Err(LocalWtsError::AgentConversationConflict);
            }
            return Ok(response(&receipt, stored, checks_state));
        }
        if request.expected_revision != stored.records.len() as u64
            || request.expected_receipt_digest != stored.receipt_digest
        {
            return Err(LocalWtsError::AgentConversationConflict);
        }
        let after = receipt
            .after
            .as_ref()
            .ok_or(LocalWtsError::InvalidAgentConversation)?;
        if !matches!(
            receipt.state,
            AgentTurnChangesState::Ready | AgentTurnChangesState::Incomplete
        ) || receipt.completed_at_unix_ms.is_none()
            || stored.records.len() >= MAX_DECISIONS
        {
            return Err(LocalWtsError::InvalidAgentConversation);
        }
        let decision = AgentTurnDecision {
            decision_id: request.request_id,
            revision: stored.records.len() as u64 + 1,
            kind: request.kind,
            reason: request.reason.clone(),
            created_at_unix_ms: now_unix_ms(),
            after_checkpoint_id: after.checkpoint_id,
            receipt_digest: stored.receipt_digest.clone(),
            source_context_sha256: receipt.source_context_sha256.clone(),
            checks_state,
            checks: checks
                .map(|checks| {
                    checks
                        .runs
                        .into_iter()
                        .take(64)
                        .map(|run| AgentTurnDecisionCheck {
                            run_id: run.run_id,
                            check_id: run.check_id,
                            status: run.status,
                        })
                        .collect()
                })
                .unwrap_or_default(),
        };
        stored.records.push(StoredDecision { request, decision });
        let path = record_path(store, receipt.session_id);
        turn_changes::private_dir(
            path.parent()
                .ok_or(LocalWtsError::AgentConversationUnavailable)?,
        )?;
        let bytes =
            serde_json::to_vec(&stored).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        if bytes.len() > MAX_RECORD_BYTES as usize {
            return Err(LocalWtsError::AgentConversationStorageFull);
        }
        turn_changes::write_private(&path, &bytes)?;
        Ok(response(&receipt, stored, checks_state))
    }
}
