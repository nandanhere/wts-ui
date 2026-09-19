//! Explicit, conditional restoration of one task's captured working files.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTurnRestoreAction {
    Restore,
    Remove,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnRestoreFile {
    pub file_path: String,
    pub action: AgentTurnRestoreAction,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnRestoreBlocker {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    pub detail: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTurnRestorePreflightState {
    Ready,
    Blocked,
    Restored,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnRestorePreflight {
    pub schema_version: u32,
    pub conversation_id: Uuid,
    pub request_id: Uuid,
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub repository_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_checkpoint_id: Option<Uuid>,
    pub state: AgentTurnRestorePreflightState,
    pub effect_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_request_id: Option<Uuid>,
    pub files: Vec<AgentTurnRestoreFile>,
    pub blockers: Vec<AgentTurnRestoreBlocker>,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_at_unix_ms: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnRestoreRequest {
    pub request_id: Uuid,
    pub effect_digest: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTurnRestoreResultState {
    Restored,
    Conflict,
    Incomplete,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnRestoreResult {
    pub schema_version: u32,
    pub conversation_id: Uuid,
    pub request_id: Uuid,
    pub restore_request_id: Uuid,
    pub state: AgentTurnRestoreResultState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_at_unix_ms: Option<i64>,
    pub files: Vec<AgentTurnRestoreFile>,
    pub blockers: Vec<AgentTurnRestoreBlocker>,
    pub detail: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct RestoreJournal {
    request: AgentTurnRestoreRequest,
    result: AgentTurnRestoreResult,
    finished: bool,
    #[serde(default)]
    pending_file: Option<AgentTurnRestoreFile>,
}
#[derive(Serialize, Deserialize)]
struct PendingRestore {
    session_id: Uuid,
    restore_request_id: Uuid,
    workspace_id: Uuid,
}

fn blocker(code: &str, path: Option<String>, detail: &str) -> AgentTurnRestoreBlocker {
    AgentTurnRestoreBlocker {
        code: code.to_owned(),
        file_path: path,
        detail: detail.to_owned(),
    }
}
fn pending_path(store: &ConversationStore, workspace_id: Uuid) -> PathBuf {
    store
        .root
        .join(format!("workspace-{workspace_id}.restore.pending"))
}
fn journal_path(directory: &Path, request_id: Uuid) -> PathBuf {
    directory.join(format!("restore-{request_id}.json"))
}
fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, LocalWtsError> {
    use std::io::Read;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
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
    serde_json::from_slice(&bytes).map_err(|_| LocalWtsError::AgentConversationUnavailable)
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), LocalWtsError> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if bytes.len() > MAX_RECORD_BYTES as usize {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    write_private(path, &bytes)
}
fn actions(receipt: &AgentTurnChanges) -> Vec<AgentTurnRestoreFile> {
    receipt
        .files
        .iter()
        .map(|file| AgentTurnRestoreFile {
            file_path: file.file_path.clone(),
            action: if file.before_sha256.is_some() {
                AgentTurnRestoreAction::Restore
            } else {
                AgentTurnRestoreAction::Remove
            },
        })
        .collect()
}
fn effect_digest(receipt: &AgentTurnChanges, files: &[AgentTurnRestoreFile]) -> String {
    sha256_bytes(
        &serde_json::to_vec(&(
            receipt.conversation_id,
            receipt.request_id,
            receipt.session_id,
            &receipt.before,
            &receipt.after,
            files,
        ))
        .expect("receipt serialization"),
    )
}
fn initial_preflight(receipt: &AgentTurnChanges) -> AgentTurnRestorePreflight {
    let files = actions(receipt);
    AgentTurnRestorePreflight { schema_version: 1, conversation_id: receipt.conversation_id, request_id: receipt.request_id, session_id: receipt.session_id, workspace_id: receipt.workspace_id, repository_id: receipt.repository_id.clone(), after_checkpoint_id: receipt.after.as_ref().map(|checkpoint| checkpoint.checkpoint_id), state: AgentTurnRestorePreflightState::Ready, effect_digest: effect_digest(receipt, &files), resume_request_id: None, files, blockers: vec![], detail: "Restore the captured working files to their state before this task. Existing dirty changes from before the task remain. Git history and the index will not change. WTS checks files before each write. Keep other editors and Git tools idle during restore.".to_owned(), restored_at_unix_ms: None }
}
fn historical_result(
    store: &ConversationStore,
    receipt: &AgentTurnChanges,
) -> Result<Option<AgentTurnRestoreResult>, LocalWtsError> {
    let path = turn_dir(&store.root, receipt.session_id).join("restore-completed.json");
    if path
        .try_exists()
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?
    {
        let result: AgentTurnRestoreResult = read_json(&path)?;
        let journal: RestoreJournal = read_json(&journal_path(
            path.parent()
                .ok_or(LocalWtsError::AgentConversationUnavailable)?,
            result.restore_request_id,
        ))?;
        if result.conversation_id != receipt.conversation_id
            || result.request_id != receipt.request_id
            || result.restore_request_id != journal.request.request_id
            || result != journal.result
            || !journal.finished
            || journal.request.effect_digest != effect_digest(receipt, &actions(receipt))
        {
            return Err(LocalWtsError::AgentConversationUnavailable);
        }
        Ok(Some(result))
    } else {
        Ok(None)
    }
}
fn resume_preflight(
    service: &LocalWtsService,
    receipt: &AgentTurnChanges,
    journal: &RestoreJournal,
    mut preflight: AgentTurnRestorePreflight,
) -> Result<AgentTurnRestorePreflight, LocalWtsError> {
    if journal.result.conversation_id != receipt.conversation_id
        || journal.result.request_id != receipt.request_id
        || journal.result.restore_request_id != journal.request.request_id
        || journal.request.effect_digest != effect_digest(receipt, &actions(receipt))
    {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let directory = turn_dir(&service.inner.agent_conversations.root, receipt.session_id);
    let stored = read_record(&directory.join("receipt.json"))?;
    preflight.resume_request_id = Some(journal.request.request_id);
    preflight.effect_digest = journal.request.effect_digest.clone();
    let worktree = service.load_source_worktree(receipt.workspace_id, &receipt.repository_id)?;
    let current = GitWorktreeService
        .capture_worktree_checkpoint(&stored.target)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    let mut observed = journal.clone();
    let expected = mixed_expected_state(&stored, &mut observed, &current)?;
    preflight.files = actions(receipt)
        .into_iter()
        .filter(|file| !observed.result.files.contains(file))
        .collect();
    if Path::new(&worktree.target_display_path) == stored.target
        && target_identity(&stored.target)? == stored.target_identity
        && canonical_capture_digest(&current)
            .is_ok_and(|digest| canonical_capture_digest(&expected).ok().as_ref() == Some(&digest))
    {
        preflight.state = AgentTurnRestorePreflightState::Ready;
        preflight.blockers.clear();
        preflight.detail = "Continue the earlier restore. WTS checked files already restored and the remaining files. Keep other editors and Git tools idle until restore finishes.".to_owned();
    } else {
        preflight.state = AgentTurnRestorePreflightState::Blocked;
        preflight.blockers = vec![blocker(
            "filesChanged",
            None,
            "Files or Git state changed during the earlier restore. Review those changes, then check again. The same restore can continue when its expected file state is restored.",
        )];
    }
    Ok(preflight)
}
fn validate_preflight(
    service: &LocalWtsService,
    receipt: &AgentTurnChanges,
) -> Result<AgentTurnRestorePreflight, LocalWtsError> {
    let store = &service.inner.agent_conversations;
    let mut preflight = initial_preflight(receipt);
    if let Some(result) = historical_result(store, receipt)? {
        preflight.state = if result.state == AgentTurnRestoreResultState::Restored {
            AgentTurnRestorePreflightState::Restored
        } else {
            AgentTurnRestorePreflightState::Blocked
        };
        preflight.restored_at_unix_ms = result.restored_at_unix_ms;
        preflight.files.clear();
        preflight.blockers = result.blockers;
        preflight.detail = if result.state == AgentTurnRestoreResultState::Restored {
            "This task was restored earlier. Files may have changed since that restore.".to_owned()
        } else {
            result.detail
        };
        if result.state == AgentTurnRestoreResultState::Incomplete {
            let directory = turn_dir(&store.root, receipt.session_id);
            let journal: RestoreJournal =
                read_json(&journal_path(&directory, result.restore_request_id))?;
            return resume_preflight(service, receipt, &journal, preflight);
        }
        return Ok(preflight);
    }
    if receipt.state != AgentTurnChangesState::Ready
        || receipt.observation != AgentTurnChangesObservation::Normal
    {
        preflight.blockers.push(blocker("captureUnavailable", None, "Restore needs a complete capture from the original task. Incomplete, recovered, and older captures cannot be restored."));
    }
    if let (Some(before), Some(after)) = (&receipt.before, &receipt.after) {
        if before.head_commit_oid != after.head_commit_oid
            || before.branch_name != after.branch_name
            || before.index_sha256 != after.index_sha256
        {
            preflight.blockers.push(blocker("gitStateChanged", None, "The task changed Git history, branch, or index. This restore only supports working-file changes. Review the Git state first."));
        }
    } else {
        preflight.blockers.push(blocker(
            "captureUnavailable",
            None,
            "The before or after checkpoint is missing.",
        ));
    }
    if preflight.blockers.is_empty() {
        match load_check_target(service, receipt.conversation_id, receipt.request_id) {
            Ok(target) => {
                if !matches_check_target(&target)? { preflight.blockers.push(blocker("filesChanged", None, "Files or Git state changed after the task. Review the later changes before you restore.")); }
                // Creation is confined to existing parent directories; restore does not recreate folders.
                for file in &preflight.files {
                    if file.action == AgentTurnRestoreAction::Restore && !target.target.join(&file.file_path).parent().is_some_and(Path::is_dir) {
                        preflight.blockers.push(blocker("parentMissing", Some(file.file_path.clone()), "The original parent folder is missing. Restore that folder before you retry."));
                    }
                }
            }
            Err(_) => preflight.blockers.push(blocker("workspaceChanged", None, "The workspace path or repository no longer matches this task. Review the workspace before you restore.")),
        }
    }
    if !preflight.blockers.is_empty() {
        preflight.state = AgentTurnRestorePreflightState::Blocked;
        preflight.detail =
            "Restore is blocked. No files were changed. Review the listed conflicts.".to_owned();
    }
    Ok(preflight)
}
fn operation_leases(
    service: &LocalWtsService,
    conversation: &AgentConversation,
) -> Result<(fs::File, fs::File), LocalWtsError> {
    let store = &service.inner.agent_conversations;
    let _guard = store
        .lock
        .lock()
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    let _disk = store.disk_lock()?;
    let mut conversations = store.work_conversations()?;
    for other in &mut conversations {
        store.recover_if_unowned(other)?;
    }
    if conversations.iter().any(|other| {
        other.workspace_id == conversation.workspace_id && other.active_session_id.is_some()
    }) {
        return Err(LocalWtsError::AgentConversationBusy);
    }
    let sessions = service
        .inner
        .agent_sessions
        .list(Some(conversation.workspace_id))
        .map_err(map_agent_session_failure)?;
    if sessions.sessions.iter().any(|session| {
        matches!(
            session.status,
            AgentSessionStatus::Launching
                | AgentSessionStatus::HandoffAccepted
                | AgentSessionStatus::Running
                | AgentSessionStatus::Stopping
        )
    }) {
        return Err(LocalWtsError::AgentConversationBusy);
    }
    let operation = store.workspace_operation_lease(conversation.workspace_id)?;
    let repository = store.turn_lease(conversation)?;
    Ok((operation, repository))
}
impl LocalWtsService {
    pub fn preflight_agent_turn_restore(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<AgentTurnRestorePreflight, LocalWtsError> {
        let receipt = self.get_agent_turn_changes(conversation_id, request_id)?;
        let conversation = self.get_agent_conversation(conversation_id)?;
        match operation_leases(self, &conversation) {
            Ok(_leases) => validate_preflight(self, &receipt),
            Err(LocalWtsError::AgentConversationBusy) => {
                let mut preflight = initial_preflight(&receipt);
                preflight.state = AgentTurnRestorePreflightState::Blocked;
                preflight.blockers.push(blocker("workspaceBusy", None, "An agent or host operation is active in this workspace. Wait for it to finish, then check again."));
                preflight.detail = "Restore is blocked while this workspace is active.".to_owned();
                let marker = pending_path(&self.inner.agent_conversations, receipt.workspace_id);
                if marker
                    .try_exists()
                    .map_err(|_| LocalWtsError::AgentConversationUnavailable)?
                {
                    let pending: PendingRestore = read_json(&marker)?;
                    if pending.session_id == receipt.session_id
                        && pending.workspace_id == receipt.workspace_id
                    {
                        let journal: RestoreJournal = read_json(&journal_path(
                            &turn_dir(&self.inner.agent_conversations.root, receipt.session_id),
                            pending.restore_request_id,
                        ))?;
                        preflight.resume_request_id = Some(journal.request.request_id);
                        preflight.effect_digest = journal.request.effect_digest.clone();
                        let store = &self.inner.agent_conversations;
                        let _guard = store
                            .lock
                            .lock()
                            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
                        let _disk = store.disk_lock()?;
                        if !store.work_conversations()?.iter().any(|other| {
                            other.workspace_id == receipt.workspace_id
                                && other.active_session_id.is_some()
                        }) && let Ok(_operation) = lock_conversation_file(
                            &store.root.join(format!(
                                "workspace-{}.operation.lease",
                                receipt.workspace_id
                            )),
                            true,
                        ) && let Ok(_repository) = store.turn_lease(&conversation)
                        {
                            return resume_preflight(self, &receipt, &journal, preflight);
                        }
                    }
                }
                Ok(preflight)
            }
            Err(error) => Err(error),
        }
    }
    pub fn restore_agent_turn(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
        request: AgentTurnRestoreRequest,
    ) -> Result<AgentTurnRestoreResult, LocalWtsError> {
        if request.request_id.is_nil() || !valid_sha256(&request.effect_digest) {
            return Err(LocalWtsError::InvalidAgentConversation);
        }
        let receipt = self.get_agent_turn_changes(conversation_id, request_id)?;
        let store = &self.inner.agent_conversations;
        let directory = turn_dir(&store.root, receipt.session_id);
        let path = journal_path(&directory, request.request_id);
        if path
            .try_exists()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?
        {
            let journal: RestoreJournal = read_json(&path)?;
            if journal.request != request
                || journal.result.conversation_id != conversation_id
                || journal.result.request_id != request_id
            {
                return Err(LocalWtsError::AgentConversationConflict);
            }
            if journal.finished && journal.result.state != AgentTurnRestoreResultState::Incomplete {
                return Ok(journal.result);
            }
            if !journal.finished {
                recover_pending_workspace(store, receipt.workspace_id)?;
                let recovered: RestoreJournal = read_json(&path)?;
                return if recovered.finished {
                    Ok(recovered.result)
                } else {
                    Err(LocalWtsError::AgentConversationBusy)
                };
            }
            let conversation = self.get_agent_conversation(conversation_id)?;
            let _leases = operation_leases(self, &conversation)?;
            let stored = read_record(&directory.join("receipt.json"))?;
            let worktree =
                self.load_source_worktree(receipt.workspace_id, &receipt.repository_id)?;
            if Path::new(&worktree.target_display_path) != stored.target
                || target_identity(&stored.target)? != stored.target_identity
            {
                return Err(LocalWtsError::AgentConversationConflict);
            }
            let mut retry = journal;
            retry.finished = false;
            retry.result.blockers.clear();
            write_json(&path, &retry)?;
            write_json(
                &pending_path(store, receipt.workspace_id),
                &PendingRestore {
                    session_id: receipt.session_id,
                    restore_request_id: retry.request.request_id,
                    workspace_id: receipt.workspace_id,
                },
            )?;
            apply_restore(store, &stored, &directory, &mut retry)?;
            return Ok(retry.result);
        }
        let conversation = self.get_agent_conversation(conversation_id)?;
        let leases = operation_leases(self, &conversation);
        let preflight = match &leases {
            Ok(_) => validate_preflight(self, &receipt)?,
            Err(LocalWtsError::AgentConversationBusy) => {
                return Err(LocalWtsError::AgentConversationBusy);
            }
            Err(_) => return Err(LocalWtsError::AgentConversationUnavailable),
        };
        let mut result = AgentTurnRestoreResult {
            schema_version: 1,
            conversation_id,
            request_id,
            restore_request_id: request.request_id,
            state: AgentTurnRestoreResultState::Conflict,
            restored_at_unix_ms: None,
            files: vec![],
            blockers: preflight.blockers,
            detail: preflight.detail,
        };
        if preflight.state != AgentTurnRestorePreflightState::Ready
            || preflight.effect_digest != request.effect_digest
            || preflight
                .resume_request_id
                .is_some_and(|id| id != request.request_id)
        {
            if result.blockers.is_empty() {
                result.blockers.push(blocker(
                    "preflightChanged",
                    None,
                    "The restore preview changed. Check the task again before you restore.",
                ));
            }
            private_dir(&store.root.join("turn-changes"))?;
            private_dir(&directory)?;
            write_json(
                &path,
                &RestoreJournal {
                    request,
                    result: result.clone(),
                    finished: true,
                    pending_file: None,
                },
            )?;
            return Ok(result);
        }
        let _leases = leases?;
        let stored = read_record(&directory.join("receipt.json"))?;
        result.state = AgentTurnRestoreResultState::Incomplete;
        result.detail = "The restore is in progress. Keep WTS open until it finishes.".to_owned();
        let mut journal = RestoreJournal {
            request,
            result,
            finished: false,
            pending_file: None,
        };
        write_json(&path, &journal)?;
        write_json(
            &pending_path(store, receipt.workspace_id),
            &PendingRestore {
                session_id: receipt.session_id,
                restore_request_id: journal.request.request_id,
                workspace_id: receipt.workspace_id,
            },
        )?;
        apply_restore(store, &stored, &directory, &mut journal)?;
        Ok(journal.result)
    }
}

fn file_state(file: Option<&wts_git::CapturedWorktreeFile>) -> (Option<&str>, Option<u32>) {
    (
        file.and_then(|file| file.sha256.as_deref()),
        file.and_then(|file| file.mode),
    )
}
fn mixed_expected_state(
    stored: &StoredTurn,
    journal: &mut RestoreJournal,
    capture: &WorktreeCheckpointCapture,
) -> Result<WorktreeCheckpointCapture, LocalWtsError> {
    let before = stored
        .before
        .as_ref()
        .ok_or(LocalWtsError::AgentConversationUnavailable)?;
    let after = stored
        .after
        .as_ref()
        .ok_or(LocalWtsError::AgentConversationUnavailable)?;
    let mut expected = after.clone();
    let files = actions(&stored.receipt);
    // A file write can finish just before the host stops. Recover that effect from exact bytes and mode.
    for file in &files {
        if journal.result.files.contains(file)
            || (journal.pending_file.as_ref() == Some(file)
                && file_state(capture.files.get(&file.file_path))
                    == file_state(before.files.get(&file.file_path)))
        {
            if !journal.result.files.contains(file) {
                journal.result.files.push(file.clone());
            }
            if let Some(original) = before.files.get(&file.file_path) {
                expected
                    .files
                    .insert(file.file_path.clone(), original.clone());
            } else {
                expected.files.remove(&file.file_path);
            }
        }
    }
    Ok(expected)
}
fn apply_restore(
    store: &ConversationStore,
    stored: &StoredTurn,
    directory: &Path,
    journal: &mut RestoreJournal,
) -> Result<(), LocalWtsError> {
    let path = journal_path(directory, journal.request.request_id);
    let before = stored
        .before
        .as_ref()
        .ok_or(LocalWtsError::AgentConversationUnavailable)?;
    let after = stored
        .after
        .as_ref()
        .ok_or(LocalWtsError::AgentConversationUnavailable)?;
    let capture = GitWorktreeService
        .capture_worktree_checkpoint(&stored.target)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    let expected = mixed_expected_state(stored, journal, &capture)?;
    let files = actions(&stored.receipt);
    if target_identity(&stored.target)? != stored.target_identity
        || canonical_capture_digest(&capture).ok() != canonical_capture_digest(&expected).ok()
        || canonical_capture_digest(&capture).is_err()
    {
        journal.result.blockers.push(blocker(
            "filesChanged",
            None,
            "Files or Git state changed during restore. Review the files before you continue.",
        ));
    } else {
        // Validate every private before blob before the first file write.
        let mut contents = BTreeMap::new();
        for file in &files {
            if let Some(hash) = before
                .files
                .get(&file.file_path)
                .and_then(|file| file.sha256.as_deref())
            {
                contents.insert(file.file_path.clone(), read_blob_bytes(directory, hash)?);
            }
        }
        for file in &files {
            if journal.result.files.contains(file) {
                continue;
            }
            let old = before.files.get(&file.file_path);
            let current = after.files.get(&file.file_path);
            let (hash, mode) = file_state(current);
            journal.pending_file = Some(file.clone());
            write_json(&path, journal)?;
            let restored = GitWorktreeService.restore_worktree_bytes_checked(
                &stored.target,
                &file.file_path,
                contents.get(&file.file_path).map(Vec::as_slice),
                old.and_then(|file| file.mode),
                hash,
                mode,
                &stored.target_identity,
            );
            if restored.is_err() {
                journal.result.blockers.push(blocker("fileConflict", Some(file.file_path.clone()), "This file changed or its folder is unavailable. The remaining files were not restored. Review the partial result."));
                break;
            }
            journal.result.files.push(file.clone());
            journal.pending_file = None;
            write_json(&path, journal)?;
        }
    }
    if journal.result.blockers.is_empty() {
        let verified = GitWorktreeService
            .capture_worktree_checkpoint(&stored.target)
            .ok()
            .and_then(|capture| canonical_capture_digest(&capture).ok());
        if verified.is_none()
            || verified != canonical_capture_digest(before).ok()
            || target_identity(&stored.target)? != stored.target_identity
        {
            journal.result.blockers.push(blocker("finalStateChanged", None, "The final file state could not be confirmed. Review the listed effects and current files, then retry this restore."));
        }
    }
    journal.finished = true;
    if journal.result.blockers.is_empty() {
        journal.result.state = AgentTurnRestoreResultState::Restored;
        journal.result.restored_at_unix_ms = Some(now_unix_ms());
        journal.result.detail = "WTS restored the listed working files and checked their captured state. Git history and the index were not changed by this restore.".to_owned();
    } else {
        journal.result.state = AgentTurnRestoreResultState::Incomplete;
        journal.result.detail = "Restore stopped. Review the listed files and conflicts, then retry this restore. Files already restored are checked before the remaining files continue. The private snapshots were kept.".to_owned();
    }
    write_json(&path, journal)?;
    write_json(&directory.join("restore-completed.json"), &journal.result)?;
    fs::remove_file(pending_path(store, stored.receipt.workspace_id))
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    Ok(())
}

pub(super) fn recover_pending_workspace(
    store: &ConversationStore,
    workspace_id: Uuid,
) -> Result<(), LocalWtsError> {
    let marker = pending_path(store, workspace_id);
    if !marker
        .try_exists()
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?
    {
        return Ok(());
    }
    let _lease = match lock_conversation_file(
        &store
            .root
            .join(format!("workspace-{workspace_id}.operation.lease")),
        true,
    ) {
        Ok(lease) => lease,
        Err(LocalWtsError::AgentConversationBusy) => return Ok(()),
        Err(error) => return Err(error),
    };
    let pending: PendingRestore = read_json(&marker)?;
    if pending.workspace_id != workspace_id {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let directory = turn_dir(&store.root, pending.session_id);
    let stored = read_record(&directory.join("receipt.json"))?;
    let conversation = store.read(stored.receipt.conversation_id)?;
    if conversation.workspace_id != workspace_id
        || conversation.repository_id != stored.receipt.repository_id
        || stored.receipt.session_id != pending.session_id
    {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let _repository = match store.turn_lease(&conversation) {
        Ok(lease) => lease,
        Err(LocalWtsError::AgentConversationBusy) => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut journal: RestoreJournal =
        read_json(&journal_path(&directory, pending.restore_request_id))?;
    let expected_files = actions(&stored.receipt);
    let before = stored
        .before
        .as_ref()
        .ok_or(LocalWtsError::AgentConversationUnavailable)?;
    let after = stored
        .after
        .as_ref()
        .ok_or(LocalWtsError::AgentConversationUnavailable)?;
    if journal.result.request_id != stored.receipt.request_id
        || journal.result.conversation_id != stored.receipt.conversation_id
        || journal.request.request_id != pending.restore_request_id
        || journal.result.restore_request_id != journal.request.request_id
        || journal.request.effect_digest != effect_digest(&stored.receipt, &expected_files)
        || stored.receipt.state != AgentTurnChangesState::Ready
        || stored.receipt.observation != AgentTurnChangesObservation::Normal
        || stored.receipt.source_context_sha256
            != sha256_bytes(
                &serde_json::to_vec(&conversation.source)
                    .map_err(|_| LocalWtsError::AgentConversationUnavailable)?,
            )
        || !conversation.messages.iter().any(|message| {
            message.role == AgentConversationMessageRole::Assistant
                && message.request_id == Some(stored.receipt.request_id)
                && message.session_id == Some(stored.receipt.session_id)
        })
        || canonical_capture_digest(before).is_err()
        || canonical_capture_digest(after).is_err()
        || before.head_commit_oid != after.head_commit_oid
        || before.branch_name != after.branch_name
        || before.index_sha256 != after.index_sha256
        || journal
            .result
            .files
            .iter()
            .any(|file| !expected_files.contains(file))
        || journal
            .pending_file
            .as_ref()
            .is_some_and(|file| !expected_files.contains(file))
    {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    if journal.finished {
        write_json(&directory.join("restore-completed.json"), &journal.result)?;
        fs::remove_file(marker).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        return Ok(());
    }
    apply_restore(store, &stored, &directory, &mut journal)
}
