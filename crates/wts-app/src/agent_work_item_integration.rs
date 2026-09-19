//! Explicit integration of a checked isolated candidate into its original working files.
use super::*;
use std::io::Read;
use turn_checks::VerifiedTurnChecks;
use wts_git::{CapturedWorktreeFile, WorktreeCheckpointCapture};

const MAX_JOURNAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FILES: usize = 2048;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentWorkItemIntegrationPreflightState {
    Ready,
    Blocked,
    Integrated,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentWorkItemIntegrationResultState {
    Integrated,
    Conflict,
    Incomplete,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkItemIntegrationFile {
    pub file_path: String,
    pub status: AgentTurnFileStatus,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkItemIntegrationBlocker {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    pub detail: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkItemIntegrationPreflight {
    pub schema_version: u32,
    pub work_set_id: Uuid,
    pub task_id: Uuid,
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub source_conversation_id: Uuid,
    pub source_request_id: Uuid,
    pub source_after_checkpoint_id: Uuid,
    pub candidate_workspace_id: Uuid,
    pub candidate_conversation_id: Uuid,
    pub candidate_request_id: Uuid,
    pub candidate_after_checkpoint_id: Uuid,
    pub state: AgentWorkItemIntegrationPreflightState,
    pub effect_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_request_id: Option<Uuid>,
    pub files: Vec<AgentWorkItemIntegrationFile>,
    pub check_run_ids: Vec<Uuid>,
    pub blockers: Vec<AgentWorkItemIntegrationBlocker>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrated_at_unix_ms: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrateAgentWorkItemRequest {
    pub request_id: Uuid,
    pub effect_digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkItemIntegrationResult {
    pub schema_version: u32,
    pub work_set_id: Uuid,
    pub task_id: Uuid,
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub integration_request_id: Uuid,
    pub state: AgentWorkItemIntegrationResultState,
    pub files: Vec<AgentWorkItemIntegrationFile>,
    pub blockers: Vec<AgentWorkItemIntegrationBlocker>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrated_at_unix_ms: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct IntegrationJournal {
    request: IntegrateAgentWorkItemRequest,
    preflight: AgentWorkItemIntegrationPreflight,
    proof: VerifiedTurnChecks,
    target_identity: String,
    source_session_id: Uuid,
    candidate_session_id: Uuid,
    result: AgentWorkItemIntegrationResult,
    pending_file: Option<AgentWorkItemIntegrationFile>,
    finished: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingIntegration {
    work_set_id: Uuid,
    task_id: Uuid,
    workspace_id: Uuid,
    request_id: Uuid,
}

fn blocker(code: &str, file_path: Option<String>, detail: &str) -> AgentWorkItemIntegrationBlocker {
    AgentWorkItemIntegrationBlocker {
        code: code.to_owned(),
        file_path,
        detail: detail.to_owned(),
    }
}
fn pending_path(store: &ConversationStore, workspace_id: Uuid) -> PathBuf {
    store
        .root
        .join(format!("workspace-{workspace_id}.integration.pending"))
}
fn journal_path(
    store: &ConversationStore,
    work_set_id: Uuid,
    task_id: Uuid,
) -> Result<PathBuf, LocalWtsError> {
    if work_set_id.is_nil() || task_id.is_nil() {
        return Err(LocalWtsError::InvalidAgentConversation);
    }
    let root = store.root.join("work-item-integrations");
    let set = root.join(work_set_id.to_string());
    let item = set.join(task_id.to_string());
    for directory in [&root, &set, &item] {
        match directory.symlink_metadata() {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err(LocalWtsError::AgentConversationUnavailable);
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(LocalWtsError::AgentConversationUnavailable);
            }
            _ => {}
        }
    }
    Ok(item.join("integration.json"))
}
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, LocalWtsError> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(LocalWtsError::AgentConversationUnavailable),
    };
    let metadata = file
        .metadata()
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if !metadata.is_file() || metadata.len() > MAX_JOURNAL_BYTES {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let mut bytes = vec![];
    file.take(MAX_JOURNAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if bytes.len() > MAX_JOURNAL_BYTES as usize {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), LocalWtsError> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if bytes.len() > MAX_JOURNAL_BYTES as usize {
        return Err(LocalWtsError::AgentConversationLimit);
    }
    turn_changes::write_private(path, &bytes)
}
fn read_journal(
    store: &ConversationStore,
    set: Uuid,
    task: Uuid,
) -> Result<Option<IntegrationJournal>, LocalWtsError> {
    let Some(journal) = read_json::<IntegrationJournal>(&journal_path(store, set, task)?)? else {
        return Ok(None);
    };
    if journal.preflight.work_set_id != set
        || journal.preflight.task_id != task
        || journal.result.work_set_id != set
        || journal.result.task_id != task
        || journal.result.schema_version != 1
        || journal.preflight.schema_version != 1
        || journal.request.request_id.is_nil()
        || journal.result.integration_request_id != journal.request.request_id
        || journal.result.workspace_id != journal.preflight.workspace_id
        || journal.result.repository_id != journal.preflight.repository_id
        || journal.request.effect_digest != journal.preflight.effect_digest
        || journal.preflight.files.len() > MAX_FILES
        || journal.result.files.len() > journal.preflight.files.len()
        || journal
            .result
            .files
            .iter()
            .any(|file| !journal.preflight.files.contains(file))
        || journal
            .pending_file
            .as_ref()
            .is_some_and(|file| !journal.preflight.files.contains(file))
        || journal.proof.after_checkpoint_id != journal.preflight.candidate_after_checkpoint_id
        || journal.source_session_id.is_nil()
        || journal.candidate_session_id.is_nil()
        || journal.proof.checks.is_empty()
        || journal.proof.checks.len() > 64
        || !valid_digest(&journal.request.effect_digest)
        || journal
            .preflight
            .files
            .iter()
            .any(|file| !valid_file_path(&file.file_path))
        || (journal.result.state == AgentWorkItemIntegrationResultState::Integrated
            && (!journal.finished
                || journal.result.integrated_at_unix_ms.is_none()
                || !journal.result.blockers.is_empty()
                || journal.pending_file.is_some()
                || journal.result.files.len() != journal.preflight.files.len()))
    {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let unique = journal
        .result
        .files
        .iter()
        .map(|file| &file.file_path)
        .collect::<BTreeSet<_>>();
    if unique.len() != journal.result.files.len()
        || journal
            .preflight
            .files
            .iter()
            .map(|file| &file.file_path)
            .collect::<BTreeSet<_>>()
            .len()
            != journal.preflight.files.len()
    {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    Ok(Some(journal))
}
fn file_state(file: Option<&CapturedWorktreeFile>) -> (Option<&str>, Option<u32>) {
    (
        file.and_then(|file| file.sha256.as_deref()),
        file.and_then(|file| file.mode),
    )
}
fn changes(
    baseline: &WorktreeCheckpointCapture,
    result: &WorktreeCheckpointCapture,
) -> Result<Vec<AgentWorkItemIntegrationFile>, LocalWtsError> {
    turn_changes::canonical_capture_digest(baseline)?;
    turn_changes::canonical_capture_digest(result)?;
    let keys = baseline
        .files
        .keys()
        .chain(result.files.keys())
        .collect::<BTreeSet<_>>();
    let mut changed = vec![];
    for path in keys {
        let before = file_state(baseline.files.get(path));
        let after = file_state(result.files.get(path));
        if before == after {
            continue;
        }
        changed.push(AgentWorkItemIntegrationFile {
            file_path: path.clone(),
            status: match (before.0, after.0) {
                (None, Some(_)) => AgentTurnFileStatus::Added,
                (Some(_), None) => AgentTurnFileStatus::Deleted,
                _ => AgentTurnFileStatus::Modified,
            },
        });
    }
    if changed.len() > MAX_FILES {
        return Err(LocalWtsError::AgentConversationLimit);
    }
    Ok(changed)
}

fn initial_preflight(
    item: &work_sets::TrustedAgentWorkItem,
) -> Result<AgentWorkItemIntegrationPreflight, LocalWtsError> {
    let source = &item.source.receipt;
    let candidate = &item.candidate.receipt;
    Ok(AgentWorkItemIntegrationPreflight {
        schema_version: 1,
        work_set_id: item.work_set_id,
        task_id: item.task_id,
        workspace_id: source.workspace_id,
        repository_id: source.repository_id.clone(),
        source_conversation_id: item.origin_conversation_id,
        source_request_id: item.origin_request_id,
        source_after_checkpoint_id: source
            .after
            .as_ref()
            .ok_or(LocalWtsError::AgentConversationConflict)?
            .checkpoint_id,
        candidate_workspace_id: candidate.workspace_id,
        candidate_conversation_id: item.child_conversation_id,
        candidate_request_id: item.child_request_id,
        candidate_after_checkpoint_id: candidate
            .after
            .as_ref()
            .ok_or(LocalWtsError::AgentConversationConflict)?
            .checkpoint_id,
        state: AgentWorkItemIntegrationPreflightState::Blocked,
        effect_digest: String::new(),
        resume_request_id: None,
        files: changes(&item.baseline, &item.result)?,
        check_run_ids: vec![],
        blockers: vec![],
        detail: "Check the isolated candidate and the original workspace before integration."
            .to_owned(),
        integrated_at_unix_ms: None,
    })
}
fn effect_digest(
    item: &work_sets::TrustedAgentWorkItem,
    files: &[AgentWorkItemIntegrationFile],
    proof: Option<&VerifiedTurnChecks>,
) -> Result<String, LocalWtsError> {
    // Later passes of the same immutable checks verify the same effect.
    let descriptors = proof.map(|proof| {
        (
            proof.after_checkpoint_id,
            proof.plan_revision,
            proof
                .checks
                .iter()
                .map(|check| &check.check)
                .collect::<Vec<_>>(),
        )
    });
    Ok(sha256_bytes(
        &serde_json::to_vec(&(
            item.work_set_id,
            item.task_id,
            item.origin_conversation_id,
            item.origin_request_id,
            item.child_conversation_id,
            item.child_request_id,
            &item.source.receipt.source_context_sha256,
            &item.candidate.receipt.source_context_sha256,
            &item.source.receipt.after,
            &item.candidate.receipt.after,
            &item.source.target,
            turn_changes::target_identity(&item.source.target)?,
            turn_changes::canonical_capture_digest(&item.baseline)?,
            turn_changes::canonical_capture_digest(&item.result)?,
            files,
            descriptors,
        ))
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?,
    ))
}
fn expected_target(
    item: &work_sets::TrustedAgentWorkItem,
    journal: Option<&mut IntegrationJournal>,
    current: &WorktreeCheckpointCapture,
) -> WorktreeCheckpointCapture {
    let mut expected = item.baseline.clone();
    if let Some(journal) = journal {
        for file in &journal.preflight.files {
            if journal.result.files.contains(file)
                || (journal.pending_file.as_ref() == Some(file)
                    && file_state(current.files.get(&file.file_path))
                        == file_state(item.result.files.get(&file.file_path)))
            {
                if !journal.result.files.contains(file) {
                    journal.result.files.push(file.clone());
                }
                if let Some(desired) = item.result.files.get(&file.file_path) {
                    expected
                        .files
                        .insert(file.file_path.clone(), desired.clone());
                } else {
                    expected.files.remove(&file.file_path);
                }
            }
        }
    }
    expected
}
fn matches_capture(
    expected: &WorktreeCheckpointCapture,
    current: &WorktreeCheckpointCapture,
) -> bool {
    turn_changes::canonical_capture_digest(expected)
        .ok()
        .zip(turn_changes::canonical_capture_digest(current).ok())
        .is_some_and(|(left, right)| left == right)
}
fn validate_journal_identity(
    item: &work_sets::TrustedAgentWorkItem,
    journal: &IntegrationJournal,
) -> Result<(), LocalWtsError> {
    let current = initial_preflight(item)?;
    let saved = &journal.preflight;
    if saved.workspace_id != current.workspace_id
        || saved.repository_id != current.repository_id
        || saved.source_conversation_id != current.source_conversation_id
        || saved.source_request_id != current.source_request_id
        || saved.source_after_checkpoint_id != current.source_after_checkpoint_id
        || saved.candidate_workspace_id != current.candidate_workspace_id
        || saved.candidate_conversation_id != current.candidate_conversation_id
        || saved.candidate_request_id != current.candidate_request_id
        || saved.candidate_after_checkpoint_id != current.candidate_after_checkpoint_id
        || saved.files != current.files
        || journal.target_identity != turn_changes::target_identity(&item.source.target)?
        || journal.source_session_id != item.source.receipt.session_id
        || journal.candidate_session_id != item.candidate.receipt.session_id
        || journal.request.effect_digest
            != effect_digest(item, &current.files, Some(&journal.proof))?
    {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    Ok(())
}
fn operation_leases(
    service: &LocalWtsService,
    item: &work_sets::TrustedAgentWorkItem,
    journal: Option<&IntegrationJournal>,
) -> Result<Vec<fs::File>, LocalWtsError> {
    let store = &service.inner.agent_conversations;
    let workspaces = [
        item.source.receipt.workspace_id,
        item.candidate.receipt.workspace_id,
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    let mut leases = vec![];
    for workspace_id in &workspaces {
        if service
            .inner
            .agent_sessions
            .list(Some(*workspace_id))
            .map_err(map_agent_session_failure)?
            .sessions
            .iter()
            .any(|session| {
                matches!(
                    session.status,
                    AgentSessionStatus::Launching
                        | AgentSessionStatus::HandoffAccepted
                        | AgentSessionStatus::Running
                        | AgentSessionStatus::Stopping
                )
            })
        {
            return Err(LocalWtsError::AgentConversationBusy);
        }
        let marker = read_json::<PendingIntegration>(&pending_path(store, *workspace_id))?;
        let operation = if let Some(marker) = marker {
            let saved = journal.ok_or(LocalWtsError::AgentConversationBusy)?;
            if marker.workspace_id != *workspace_id
                || marker.work_set_id != item.work_set_id
                || marker.task_id != item.task_id
                || marker.request_id != saved.request.request_id
                || *workspace_id != item.source.receipt.workspace_id
            {
                return Err(LocalWtsError::AgentConversationBusy);
            }
            if store
                .root
                .join(format!("workspace-{workspace_id}.restore.pending"))
                .symlink_metadata()
                .is_ok()
            {
                return Err(LocalWtsError::AgentConversationBusy);
            }
            lock_conversation_file(
                &store
                    .root
                    .join(format!("workspace-{workspace_id}.operation.lease")),
                true,
            )?
        } else {
            store.workspace_operation_lease(*workspace_id)?
        };
        leases.push(operation);
    }
    for id in store.ids()? {
        let conversation = store.read(id)?;
        if workspaces.contains(&conversation.workspace_id)
            && conversation.active_session_id.is_some()
        {
            return Err(LocalWtsError::AgentConversationBusy);
        }
    }
    leases.push(store.turn_lease(&item.source.conversation)?);
    leases.push(store.turn_lease(&item.candidate.conversation)?);
    Ok(leases)
}
fn current_preflight(
    service: &LocalWtsService,
    item: &work_sets::TrustedAgentWorkItem,
    journal: Option<&mut IntegrationJournal>,
) -> Result<
    (
        AgentWorkItemIntegrationPreflight,
        Option<VerifiedTurnChecks>,
    ),
    LocalWtsError,
> {
    let mut result = initial_preflight(item)?;
    if result.files.iter().any(|file| {
        [
            (
                item.baseline.files.get(&file.file_path),
                &item.baseline_blob_dir,
            ),
            (
                item.result.files.get(&file.file_path),
                &item.result_blob_dir,
            ),
        ]
        .into_iter()
        .any(|(captured, directory)| {
            captured
                .and_then(|file| file.sha256.as_deref())
                .is_some_and(|hash| turn_changes::read_blob_bytes(directory, hash).is_err())
        })
    }) {
        result.blockers.push(blocker("captureUnavailable", None, "Saved files for this integration are unavailable. Review the current files and run a new task to capture a new result."));
    }
    let proof = match turn_checks::integration_check_proof(service, &item.candidate) {
        Ok(proof) => Some(proof),
        Err(LocalWtsError::VerificationCheckUnavailable) => {
            result.blockers.push(blocker("noChecks", None, "This candidate has no supported host checks. Open its workspace verification to add a supported check, then run it."));
            None
        }
        Err(_) => {
            result.blockers.push(blocker("checksNotPassed", None, "Run every saved check in the candidate workspace. Each latest result must pass against this candidate's recorded files and current check plan."));
            None
        }
    };
    if let Some(proof) = &proof {
        result.check_run_ids = proof.checks.iter().map(|check| check.run_id).collect();
    }
    let current = GitWorktreeService
        .capture_worktree_checkpoint(&item.source.target)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    let expected = if let Some(journal) = journal {
        validate_journal_identity(item, journal)?;
        result.resume_request_id = Some(journal.request.request_id);
        expected_target(item, Some(journal), &current)
    } else {
        item.baseline.clone()
    };
    if !matches_capture(&expected, &current)
        || turn_changes::target_identity(&item.source.target).is_err()
        || (result.resume_request_id.is_none()
            && !turn_changes::matches_check_target(&item.source).unwrap_or(false))
    {
        result.blockers.push(blocker("targetChanged", None, "The original workspace changed after this work set started. Review those changes. Start a new work set from the current result to keep later edits."));
    }
    if !turn_changes::matches_check_target(&item.candidate).unwrap_or(false) {
        result.blockers.push(blocker("candidateChanged", None, "The candidate changed after its saved result. Review its current files and run a new task to capture them."));
    }
    if result.files.is_empty() {
        result.blockers.push(blocker("noChanges", None, "This candidate has no file changes to integrate. Keep it as a comparison or select another candidate."));
    }
    result.effect_digest = effect_digest(item, &result.files, proof.as_ref())?;
    if result.blockers.is_empty() {
        result.state = AgentWorkItemIntegrationPreflightState::Ready;
        result.detail = if result.resume_request_id.is_some() {
            "Continue this integration. WTS checked completed file effects and the remaining files. Keep other editors and Git tools idle until it finishes."
        } else {
            "Apply this checked candidate's file changes to the original workspace. WTS preserves its existing files, Git history, and index. Keep other editors and Git tools idle until it finishes."
        }.to_owned();
    } else {
        result.detail = "Resolve the listed conditions before integration. The candidate and its saved changes remain available.".to_owned();
    }
    Ok((result, proof))
}
fn save_journal(
    store: &ConversationStore,
    journal: &IntegrationJournal,
) -> Result<(), LocalWtsError> {
    let path = journal_path(
        store,
        journal.preflight.work_set_id,
        journal.preflight.task_id,
    )?;
    for directory in [
        store.root.join("work-item-integrations"),
        store
            .root
            .join("work-item-integrations")
            .join(journal.preflight.work_set_id.to_string()),
        path.parent()
            .ok_or(LocalWtsError::AgentConversationUnavailable)?
            .to_owned(),
    ] {
        turn_changes::private_dir(&directory)?;
    }
    write_json(&path, journal)
}
fn terminal_preflight(journal: &IntegrationJournal) -> AgentWorkItemIntegrationPreflight {
    let mut preview = journal.preflight.clone();
    preview.state = AgentWorkItemIntegrationPreflightState::Integrated;
    preview.resume_request_id = None;
    preview.integrated_at_unix_ms = journal.result.integrated_at_unix_ms;
    preview.detail = "This candidate was integrated. The saved result records that operation. Later workspace edits remain unchanged.".to_owned();
    preview.blockers.clear();
    preview
}
fn result_for(
    preflight: &AgentWorkItemIntegrationPreflight,
    request_id: Uuid,
) -> AgentWorkItemIntegrationResult {
    AgentWorkItemIntegrationResult {
        schema_version: 1,
        work_set_id: preflight.work_set_id,
        task_id: preflight.task_id,
        workspace_id: preflight.workspace_id,
        repository_id: preflight.repository_id.clone(),
        integration_request_id: request_id,
        state: AgentWorkItemIntegrationResultState::Conflict,
        files: vec![],
        blockers: preflight.blockers.clone(),
        detail: preflight.detail.clone(),
        integrated_at_unix_ms: None,
    }
}

impl LocalWtsService {
    pub fn preflight_agent_work_item_integration(
        &self,
        work_set_id: Uuid,
        task_id: Uuid,
    ) -> Result<AgentWorkItemIntegrationPreflight, LocalWtsError> {
        let store = &self.inner.agent_conversations;
        {
            let _guard = store
                .lock
                .lock()
                .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
            let _disk = store.disk_lock()?;
            if let Some(journal) = read_journal(store, work_set_id, task_id)?
                && journal.finished
                && journal.result.state == AgentWorkItemIntegrationResultState::Integrated
            {
                return Ok(terminal_preflight(&journal));
            }
        }
        let item = work_sets::load_integration_candidate(self, work_set_id, task_id)?;
        let _verification = match self.inner.verification_lock.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => {
                let mut preview = initial_preflight(&item)?;
                preview.effect_digest = effect_digest(&item, &preview.files, None)?;
                preview.blockers.push(blocker("workspaceBusy", None, "A host verification task is active. Wait for it to finish, then check integration again."));
                return Ok(preview);
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(LocalWtsError::AgentConversationUnavailable);
            }
        };
        let _guard = store
            .lock
            .lock()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let _disk = store.disk_lock()?;
        let mut journal = read_journal(store, work_set_id, task_id)?;
        if let Some(saved) = &journal
            && saved.finished
            && saved.result.state == AgentWorkItemIntegrationResultState::Integrated
        {
            return Ok(terminal_preflight(saved));
        }
        let _leases = match operation_leases(self, &item, journal.as_ref()) {
            Ok(leases) => leases,
            Err(LocalWtsError::AgentConversationBusy) => {
                let mut preview = initial_preflight(&item)?;
                preview.effect_digest = effect_digest(&item, &preview.files, None)?;
                preview.blockers.push(blocker("workspaceBusy", None, "Another WTS task is active in the original or candidate workspace. Wait for it to finish, then check integration again."));
                return Ok(preview);
            }
            Err(error) => return Err(error),
        };
        current_preflight(self, &item, journal.as_mut()).map(|(preview, _)| preview)
    }
    pub fn integrate_agent_work_item(
        &self,
        work_set_id: Uuid,
        task_id: Uuid,
        request: IntegrateAgentWorkItemRequest,
    ) -> Result<AgentWorkItemIntegrationResult, LocalWtsError> {
        if request.request_id.is_nil() || !valid_digest(&request.effect_digest) {
            return Err(LocalWtsError::InvalidAgentConversation);
        }
        let store = &self.inner.agent_conversations;
        {
            let _guard = store
                .lock
                .lock()
                .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
            let _disk = store.disk_lock()?;
            if let Some(journal) = read_journal(store, work_set_id, task_id)? {
                if journal.request != request {
                    return Err(LocalWtsError::AgentConversationConflict);
                }
                if journal.finished
                    && journal.result.state == AgentWorkItemIntegrationResultState::Integrated
                {
                    return Ok(journal.result);
                }
            }
        }
        let item = work_sets::load_integration_candidate(self, work_set_id, task_id)?;
        let _verification =
            self.inner
                .verification_lock
                .try_lock()
                .map_err(|error| match error {
                    std::sync::TryLockError::WouldBlock => LocalWtsError::AgentConversationBusy,
                    std::sync::TryLockError::Poisoned(_) => {
                        LocalWtsError::AgentConversationUnavailable
                    }
                })?;
        let _guard = store
            .lock
            .lock()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let _disk = store.disk_lock()?;
        let mut previous = read_journal(store, work_set_id, task_id)?;
        if let Some(journal) = &previous {
            if journal.request != request {
                return Err(LocalWtsError::AgentConversationConflict);
            }
            if journal.finished
                && journal.result.state == AgentWorkItemIntegrationResultState::Integrated
            {
                return Ok(journal.result.clone());
            }
        }
        let _leases = operation_leases(self, &item, previous.as_ref())?;
        let (preflight, proof) = current_preflight(self, &item, previous.as_mut())?;
        let mut result = result_for(&preflight, request.request_id);
        if preflight.state != AgentWorkItemIntegrationPreflightState::Ready
            || preflight.effect_digest != request.effect_digest
        {
            if result.blockers.is_empty() {
                result.blockers.push(blocker("preflightChanged", None, "The integration preview changed. Check the candidate again before integration."));
            }
            if let Some(previous) = previous {
                result.state = AgentWorkItemIntegrationResultState::Incomplete;
                result.files = previous.result.files;
                result.detail = "The earlier integration remains incomplete. Its confirmed file effects are listed. Review the current conditions before you continue.".to_owned();
            }
            return Ok(result);
        }
        result.state = AgentWorkItemIntegrationResultState::Incomplete;
        result.detail = "Integration is in progress. Keep WTS open until it finishes.".to_owned();
        let mut journal = if let Some(mut journal) = previous {
            journal.finished = false;
            journal.result.blockers.clear();
            journal.proof = proof.ok_or(LocalWtsError::AgentConversationConflict)?;
            journal
        } else {
            IntegrationJournal {
                request,
                preflight,
                proof: proof.ok_or(LocalWtsError::AgentConversationConflict)?,
                target_identity: turn_changes::target_identity(&item.source.target)?,
                source_session_id: item.source.receipt.session_id,
                candidate_session_id: item.candidate.receipt.session_id,
                result,
                pending_file: None,
                finished: false,
            }
        };
        save_journal(store, &journal)?;
        write_json(
            &pending_path(store, item.source.receipt.workspace_id),
            &PendingIntegration {
                work_set_id,
                task_id,
                workspace_id: item.source.receipt.workspace_id,
                request_id: journal.request.request_id,
            },
        )?;
        apply_integration(store, &item, &mut journal)?;
        Ok(journal.result)
    }
}
fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
fn valid_file_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.contains('\\')
        && !path.chars().any(char::is_control)
        && path.split('/').count() <= 64
        && path.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.eq_ignore_ascii_case(".git")
        })
}

fn apply_integration(
    store: &ConversationStore,
    item: &work_sets::TrustedAgentWorkItem,
    journal: &mut IntegrationJournal,
) -> Result<(), LocalWtsError> {
    let current = GitWorktreeService
        .capture_worktree_checkpoint(&item.source.target)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    let expected = expected_target(item, Some(journal), &current);
    if !matches_capture(&expected, &current)
        || turn_changes::target_identity(&item.source.target)? != journal.target_identity
    {
        journal.result.blockers.push(blocker("targetChanged", None, "The original workspace changed before integration. Review the current files before you continue."));
    } else {
        let mut contents = BTreeMap::new();
        // Read and validate all private blobs before the first working-file write.
        for file in &journal.preflight.files {
            if let Some(hash) = item
                .result
                .files
                .get(&file.file_path)
                .and_then(|file| file.sha256.as_deref())
            {
                contents.insert(
                    file.file_path.clone(),
                    turn_changes::read_blob_bytes(&item.result_blob_dir, hash)?,
                );
            }
        }
        for file in journal.preflight.files.clone() {
            if journal.result.files.contains(&file) {
                continue;
            }
            if turn_changes::target_identity(&item.source.target)? != journal.target_identity {
                return Err(LocalWtsError::AgentConversationConflict);
            }
            let desired = item.result.files.get(&file.file_path);
            let (hash, mode) = file_state(item.baseline.files.get(&file.file_path));
            journal.pending_file = Some(file.clone());
            save_journal(store, journal)?;
            if contents.contains_key(&file.file_path)
                && GitWorktreeService
                    .prepare_worktree_source_parent_checked(
                        &item.source.target,
                        &file.file_path,
                        &journal.target_identity,
                    )
                    .is_err()
            {
                journal.result.blockers.push(blocker("fileConflict", Some(file.file_path.clone()), "The destination folder is unavailable or changed. Review the listed effects, then continue this integration."));
                break;
            }
            let applied = GitWorktreeService.restore_worktree_bytes_checked(
                &item.source.target,
                &file.file_path,
                contents.get(&file.file_path).map(Vec::as_slice),
                desired.and_then(|file| file.mode),
                hash,
                mode,
                &journal.target_identity,
            );
            if applied.is_err() {
                journal.result.blockers.push(blocker("fileConflict", Some(file.file_path.clone()), "This file or its folder changed. The remaining files were not applied. Review the listed effects, then continue this integration."));
                break;
            }
            journal.result.files.push(file);
            journal.pending_file = None;
            save_journal(store, journal)?;
        }
    }
    if journal.result.blockers.is_empty() {
        let mut expected = item.baseline.clone();
        for file in &journal.preflight.files {
            if let Some(desired) = item.result.files.get(&file.file_path) {
                expected
                    .files
                    .insert(file.file_path.clone(), desired.clone());
            } else {
                expected.files.remove(&file.file_path);
            }
        }
        if !GitWorktreeService
            .capture_worktree_checkpoint(&item.source.target)
            .is_ok_and(|current| matches_capture(&expected, &current))
            || turn_changes::target_identity(&item.source.target)? != journal.target_identity
        {
            journal.result.blockers.push(blocker("finalStateChanged", None, "WTS could not confirm the final file state. Review the listed effects and current files, then continue this integration."));
        }
    }
    journal.finished = true;
    if journal.result.blockers.is_empty() {
        journal.result.state = AgentWorkItemIntegrationResultState::Integrated;
        journal.result.integrated_at_unix_ms = Some(now_unix_ms());
        journal.result.detail = "WTS applied the listed candidate files and checked the final state. Git history, the index, and other original files remain unchanged. Alternative candidates remain available.".to_owned();
    } else {
        journal.result.state = AgentWorkItemIntegrationResultState::Incomplete;
        journal.result.detail = "Integration stopped. Review the listed effects and conditions. Continue the same integration to apply the remaining files. Candidate snapshots remain available.".to_owned();
    }
    save_journal(store, journal)?;
    fs::remove_file(pending_path(store, item.source.receipt.workspace_id))
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    Ok(())
}

pub(super) fn recover_pending_workspace(
    store: &ConversationStore,
    workspace_id: Uuid,
) -> Result<(), LocalWtsError> {
    let path = pending_path(store, workspace_id);
    let Some(marker) = read_json::<PendingIntegration>(&path)? else {
        return Ok(());
    };
    let mut journal = read_journal(store, marker.work_set_id, marker.task_id)?
        .ok_or(LocalWtsError::AgentConversationUnavailable)?;
    if marker.workspace_id != workspace_id
        || journal.preflight.workspace_id != workspace_id
        || journal.request.request_id != marker.request_id
    {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let _lease = lock_conversation_file(
        &store
            .root
            .join(format!("workspace-{workspace_id}.operation.lease")),
        true,
    )?;
    if !journal.finished {
        let source = turn_changes::read_record(
            &turn_changes::turn_dir(&store.root, journal.source_session_id).join("receipt.json"),
        )?;
        let candidate = turn_changes::read_record(
            &turn_changes::turn_dir(&store.root, journal.candidate_session_id).join("receipt.json"),
        )?;
        if source.receipt.session_id != journal.source_session_id
            || candidate.receipt.session_id != journal.candidate_session_id
            || source.receipt.conversation_id != journal.preflight.source_conversation_id
            || source.receipt.request_id != journal.preflight.source_request_id
            || source.receipt.workspace_id != workspace_id
            || source.receipt.repository_id != journal.preflight.repository_id
            || candidate.receipt.conversation_id != journal.preflight.candidate_conversation_id
            || candidate.receipt.request_id != journal.preflight.candidate_request_id
            || candidate.receipt.workspace_id != journal.preflight.candidate_workspace_id
            || source
                .receipt
                .after
                .as_ref()
                .map(|checkpoint| checkpoint.checkpoint_id)
                != Some(journal.preflight.source_after_checkpoint_id)
            || candidate
                .receipt
                .after
                .as_ref()
                .map(|checkpoint| checkpoint.checkpoint_id)
                != Some(journal.preflight.candidate_after_checkpoint_id)
            || source.target_identity != journal.target_identity
        {
            return Err(LocalWtsError::AgentConversationUnavailable);
        }
        let baseline = source
            .after
            .as_ref()
            .ok_or(LocalWtsError::AgentConversationUnavailable)?;
        let desired = candidate
            .after
            .as_ref()
            .ok_or(LocalWtsError::AgentConversationUnavailable)?;
        if changes(baseline, desired)? != journal.preflight.files {
            return Err(LocalWtsError::AgentConversationUnavailable);
        }
        journal.result.blockers.clear();
        if let Some(file) = journal.pending_file.clone() {
            let current = (turn_changes::target_identity(&source.target).ok().as_ref()
                == Some(&journal.target_identity))
            .then(|| {
                GitWorktreeService
                    .capture_worktree_checkpoint(&source.target)
                    .ok()
            })
            .flatten();
            if current.as_ref().is_some_and(|current| {
                file_state(current.files.get(&file.file_path))
                    == file_state(desired.files.get(&file.file_path))
            }) {
                if !journal.result.files.contains(&file) {
                    journal.result.files.push(file);
                }
                journal.pending_file = None;
            } else if current.as_ref().is_some_and(|current| {
                file_state(current.files.get(&file.file_path))
                    == file_state(baseline.files.get(&file.file_path))
            }) {
                journal.pending_file = None;
            } else {
                journal.result.blockers.push(blocker("fileEffectUnknown", Some(file.file_path), "This file changed before WTS could confirm the pending write. Review its current contents before you continue."));
            }
        }
        journal.finished = true;
        journal.result.state = AgentWorkItemIntegrationResultState::Incomplete;
        journal.result.blockers.push(blocker("hostStopped", None, "The host stopped before integration finished. WTS saved the confirmed file effects. Review them, then continue the same integration if its expected files still match."));
        journal.result.detail = "Integration stopped before its final result was saved. The workspace is available. Saved file effects remain attached to this integration.".to_owned();
        save_journal(store, &journal)?;
    }
    fs::remove_file(path).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    Ok(())
}
