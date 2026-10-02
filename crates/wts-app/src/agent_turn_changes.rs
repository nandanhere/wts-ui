//! Private snapshots and host observations for one dispatched feedback request.
#[path = "agent_turn_restore.rs"]
mod restore;
pub use restore::*;
pub(super) fn recover_pending_workspace(
    store: &ConversationStore,
    workspace_id: Uuid,
) -> Result<(), LocalWtsError> {
    restore::recover_pending_workspace(store, workspace_id)
}

use super::*;
use wts_git::{MAX_CHECKPOINT_FILES, MAX_CHECKPOINT_PATCH_BYTES, WorktreeCheckpointCapture};

const MAX_RECORD_BYTES: u64 = 64 * 1024 * 1024;
const COVERAGE: &str = "Changes observed during this task. Other editors can also change these files. Capture covers tracked files and untracked files that Git does not ignore.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTurnChangesState {
    Capturing,
    Ready,
    Incomplete,
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTurnChangesObservation {
    Normal,
    Recovered,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTurnFileStatus {
    Added,
    Modified,
    Deleted,
    TypeChanged,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnCheckpoint {
    pub checkpoint_id: Uuid,
    pub head_commit_oid: String,
    pub branch_name: String,
    pub captured_at_unix_ms: i64,
    pub tree_sha256: String,
    pub index_sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnChangedFile {
    pub file_path: String,
    pub status: AgentTurnFileStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_sha256: Option<String>,
    pub pre_existing_change: bool,
    pub undo_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnChanges {
    pub schema_version: u32,
    pub conversation_id: Uuid,
    pub request_id: Uuid,
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub source_context_sha256: String,
    pub state: AgentTurnChangesState,
    pub observation: AgentTurnChangesObservation,
    pub started_at_unix_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<AgentTurnCheckpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<AgentTurnCheckpoint>,
    pub files: Vec<AgentTurnChangedFile>,
    pub omitted_file_count: usize,
    pub patch: String,
    pub patch_truncated: bool,
    pub detail: String,
}

#[derive(Serialize, Deserialize)]
pub(super) struct StoredTurn {
    pub receipt: AgentTurnChanges,
    pub target: PathBuf,
    pub target_identity: String,
    pub before: Option<WorktreeCheckpointCapture>,
    pub after: Option<WorktreeCheckpointCapture>,
}

fn unavailable(
    conversation: &AgentConversation,
    message: &AgentConversationMessage,
) -> Result<AgentTurnChanges, LocalWtsError> {
    Ok(AgentTurnChanges {
        schema_version: 1, conversation_id: conversation.conversation_id,
        request_id: message.request_id.ok_or(LocalWtsError::AgentConversationNotFound)?,
        session_id: message.session_id.ok_or(LocalWtsError::AgentConversationNotFound)?,
        workspace_id: conversation.workspace_id, repository_id: conversation.repository_id.clone(),
        source_context_sha256: sha256_bytes(&serde_json::to_vec(&conversation.source).map_err(|_| LocalWtsError::AgentConversationUnavailable)?),
        state: AgentTurnChangesState::Unavailable, observation: AgentTurnChangesObservation::Normal,
        started_at_unix_ms: message.created_at_unix_ms, completed_at_unix_ms: None,
        before: None, after: None, files: vec![], omitted_file_count: 0, patch: String::new(), patch_truncated: false,
        detail: "This task has no saved change capture. Review the current files. A new task will capture its own before and after state.".to_owned(),
    })
}

impl LocalWtsService {
    pub fn get_agent_turn_changes(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<AgentTurnChanges, LocalWtsError> {
        let store = &self.inner.agent_conversations;
        let conversation = self.get_agent_conversation(conversation_id)?;
        let message = conversation
            .messages
            .iter()
            .find(|message| {
                message.role == AgentConversationMessageRole::Assistant
                    && message.request_id == Some(request_id)
            })
            .ok_or(LocalWtsError::AgentConversationNotFound)?;
        if !conversation.messages.iter().any(|user| {
            user.role == AgentConversationMessageRole::User
                && user.request_id == Some(request_id)
                && user.session_id == message.session_id
        }) {
            return Err(LocalWtsError::AgentConversationNotFound);
        }
        let expected = unavailable(&conversation, message)?;
        let path = turn_dir(&store.root, expected.session_id).join("receipt.json");
        if !path
            .try_exists()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?
        {
            return Ok(expected);
        }
        let stored = read_record(&path)?;
        if stored.receipt.conversation_id != conversation_id
            || stored.receipt.request_id != request_id
            || stored.receipt.session_id != expected.session_id
            || stored.receipt.workspace_id != expected.workspace_id
            || stored.receipt.repository_id != expected.repository_id
            || stored.receipt.source_context_sha256 != expected.source_context_sha256
        {
            return Err(LocalWtsError::AgentConversationUnavailable);
        }
        let mut receipt = stored.receipt;
        if receipt.state == AgentTurnChangesState::Capturing
            && !matches!(
                message.status,
                AgentConversationMessageStatus::Pending | AgentConversationMessageStatus::Running
            )
        {
            receipt.state = AgentTurnChangesState::Unavailable;
            receipt.detail = "The task ended, but its after state could not be saved. Review the current files. An exact change result is not available for this task.".to_owned();
        }
        Ok(receipt)
    }
}

pub(super) fn turn_dir(root: &Path, session_id: Uuid) -> PathBuf {
    root.join("turn-changes").join(session_id.to_string())
}
pub(super) fn private_dir(path: &Path) -> Result<(), LocalWtsError> {
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink() || !m.is_dir())
    {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    fs::create_dir_all(path).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    }
    Ok(())
}
pub(super) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), LocalWtsError> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or(LocalWtsError::AgentConversationUnavailable)?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        fs::rename(&temporary, path).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
pub(super) fn read_record(path: &Path) -> Result<StoredTurn, LocalWtsError> {
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
    let mut bytes = vec![];
    file.take(MAX_RECORD_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if bytes.len() > MAX_RECORD_BYTES as usize {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    serde_json::from_slice(&bytes).map_err(|_| LocalWtsError::AgentConversationUnavailable)
}
fn save_record(directory: &Path, stored: &StoredTurn) -> Result<(), LocalWtsError> {
    let bytes =
        serde_json::to_vec(stored).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if bytes.len() > MAX_RECORD_BYTES as usize {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    write_private(&directory.join("receipt.json"), &bytes)
}
pub(super) fn target_identity(target: &Path) -> Result<String, LocalWtsError> {
    let metadata = target
        .symlink_metadata()
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(sha256_bytes(
            format!("{}:{}:{}", target.display(), metadata.dev(), metadata.ino()).as_bytes(),
        ))
    }
    #[cfg(not(unix))]
    {
        Err(LocalWtsError::AgentConversationUnavailable)
    }
}
pub(super) fn read_blob_bytes(directory: &Path, hash: &str) -> Result<Vec<u8>, LocalWtsError> {
    use std::io::Read;
    if !valid_sha256(hash) {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(directory.join(hash.trim_start_matches("sha256:")))
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    let metadata = file
        .metadata()
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if !metadata.is_file() || metadata.len() > wts_git::MAX_WORKTREE_SOURCE_BYTES as u64 {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let mut bytes = vec![];
    file.take((wts_git::MAX_WORKTREE_SOURCE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if bytes.len() > wts_git::MAX_WORKTREE_SOURCE_BYTES || sha256_bytes(&bytes) != hash {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    Ok(bytes)
}

pub(super) fn persist_capture(
    directory: &Path,
    mut capture: WorktreeCheckpointCapture,
) -> Result<(AgentTurnCheckpoint, WorktreeCheckpointCapture), LocalWtsError> {
    for file in capture.files.values_mut() {
        if let Some(content) = file
            .raw_content
            .take()
            .or_else(|| file.content.take().map(String::into_bytes))
        {
            let hash = file
                .sha256
                .as_ref()
                .ok_or(LocalWtsError::AgentConversationUnavailable)?;
            let path = directory.join(hash.trim_start_matches("sha256:"));
            if path
                .try_exists()
                .map_err(|_| LocalWtsError::AgentConversationUnavailable)?
            {
                if read_blob_bytes(directory, hash)? != content {
                    return Err(LocalWtsError::AgentConversationUnavailable);
                }
            } else {
                write_private(&path, &content)?;
            }
        }
    }
    let tree = capture
        .files
        .iter()
        .map(|(path, file)| (path, &file.sha256, file.mode, file.unsupported))
        .collect::<Vec<_>>();
    let tree_sha256 = sha256_bytes(
        &serde_json::to_vec(&tree).map_err(|_| LocalWtsError::AgentConversationUnavailable)?,
    );
    let checkpoint = AgentTurnCheckpoint {
        checkpoint_id: Uuid::new_v4(),
        head_commit_oid: capture.head_commit_oid.clone(),
        branch_name: capture.branch_name.clone(),
        captured_at_unix_ms: now_unix_ms(),
        tree_sha256,
        index_sha256: capture.index_sha256.clone(),
    };
    Ok((checkpoint, capture))
}

pub(super) fn begin_turn_capture(
    store: &ConversationStore,
    conversation: &AgentConversation,
    session_id: Uuid,
    target: &Path,
) -> Result<(), LocalWtsError> {
    let message = conversation
        .messages
        .iter()
        .find(|message| {
            message.role == AgentConversationMessageRole::User
                && message.session_id == Some(session_id)
        })
        .ok_or(LocalWtsError::AgentConversationNotFound)?;
    let mut receipt = unavailable(conversation, message)?;
    let parent = store.root.join("turn-changes");
    private_dir(&parent)?;
    let directory = turn_dir(&store.root, receipt.session_id);
    private_dir(&directory)?;
    write_private(&directory.join("empty"), b"")?;
    let target_identity = target_identity(target)?;
    let capture = GitWorktreeService.capture_worktree_checkpoint(target);
    let before = match capture {
        Ok(capture) => {
            let (checkpoint, capture) = persist_capture(&directory, capture)?;
            receipt.before = Some(checkpoint);
            receipt.state = AgentTurnChangesState::Capturing;
            receipt.detail = COVERAGE.to_owned();
            Some(capture)
        }
        Err(_) => {
            receipt.detail = "The before state could not be captured. Review the current files; this task cannot provide a complete change receipt.".to_owned();
            None
        }
    };
    save_record(
        &directory,
        &StoredTurn {
            receipt,
            target: target.to_owned(),
            target_identity,
            before,
            after: None,
        },
    )
}

pub(super) fn finish_turn_capture(
    store: &ConversationStore,
    session_id: Uuid,
    recovered: bool,
) -> Result<(), LocalWtsError> {
    let result = finish_turn_capture_inner(store, session_id, recovered);
    if result.is_err() {
        let directory = turn_dir(&store.root, session_id);
        if let Ok(mut stored) = read_record(&directory.join("receipt.json")) {
            stored.receipt.state = AgentTurnChangesState::Unavailable;
            stored.receipt.completed_at_unix_ms = Some(now_unix_ms());
            stored.receipt.detail = "The task ended, but its after state could not be saved. Check free disk space and app storage permissions. Review the current files; this task has no complete change result.".to_owned();
            let _ = save_record(&directory, &stored);
        }
    }
    result
}

fn finish_turn_capture_inner(
    store: &ConversationStore,
    session_id: Uuid,
    recovered: bool,
) -> Result<(), LocalWtsError> {
    let directory = turn_dir(&store.root, session_id);
    let path = directory.join("receipt.json");
    if !path
        .try_exists()
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?
    {
        return Ok(());
    }
    let mut stored = read_record(&path)?;
    if stored.receipt.completed_at_unix_ms.is_some() {
        return Ok(());
    }
    stored.receipt.observation = if recovered {
        AgentTurnChangesObservation::Recovered
    } else {
        AgentTurnChangesObservation::Normal
    };
    stored.receipt.completed_at_unix_ms = Some(now_unix_ms());
    let capture = if target_identity(&stored.target).ok().as_ref() == Some(&stored.target_identity)
    {
        GitWorktreeService
            .capture_worktree_checkpoint(&stored.target)
            .ok()
    } else {
        None
    };
    if let Some(capture) = capture {
        let (checkpoint, capture) = persist_capture(&directory, capture)?;
        stored.receipt.after = Some(checkpoint);
        stored.after = Some(capture);
    }
    match (&stored.before, &stored.after) {
        (Some(before), Some(after)) => {
            build_changes(&directory, &mut stored.receipt, before, after)?
        }
        _ => {
            stored.receipt.state = AgentTurnChangesState::Unavailable;
            stored.receipt.detail = "A complete before and after capture is not available. The repository may have moved or changed identity. Review the current files.".to_owned();
        }
    }
    save_record(&directory, &stored)
}

fn build_changes(
    directory: &Path,
    receipt: &mut AgentTurnChanges,
    before: &WorktreeCheckpointCapture,
    after: &WorktreeCheckpointCapture,
) -> Result<(), LocalWtsError> {
    let paths = before
        .files
        .keys()
        .chain(after.files.keys())
        .collect::<std::collections::BTreeSet<_>>();
    let mut omitted = before.omitted_file_count.max(after.omitted_file_count)
        + paths.len().saturating_sub(MAX_CHECKPOINT_FILES);
    for path in paths.iter().take(MAX_CHECKPOINT_FILES) {
        let old = before.files.get(*path);
        let new = after.files.get(*path);
        if old.is_some_and(|f| f.unsupported) || new.is_some_and(|f| f.unsupported) {
            continue;
        }
        if (old.is_none() && before.files.len() >= MAX_CHECKPOINT_FILES)
            || (new.is_none() && after.files.len() >= MAX_CHECKPOINT_FILES)
        {
            omitted += 1;
            continue;
        }
        let old_hash = old.and_then(|f| f.sha256.clone());
        let new_hash = new.and_then(|f| f.sha256.clone());
        let old_mode = old.and_then(|f| f.mode);
        let new_mode = new.and_then(|f| f.mode);
        if old_hash == new_hash && old_mode == new_mode {
            continue;
        }
        let status = if old_hash.is_none() {
            AgentTurnFileStatus::Added
        } else if new_hash.is_none() {
            AgentTurnFileStatus::Deleted
        } else {
            AgentTurnFileStatus::Modified
        };
        let binary =
            old.is_some_and(|file| file.is_binary) || new.is_some_and(|file| file.is_binary);
        receipt.files.push(AgentTurnChangedFile {
            file_path: (*path).clone(),
            status,
            before_sha256: old_hash.clone(),
            after_sha256: new_hash.clone(),
            pre_existing_change: old.is_some_and(|f| f.pre_existing_change),
            undo_supported: false,
            detail: binary.then(|| {
                "The exact binary bytes are saved. A text patch is not available for this file."
                    .to_owned()
            }),
        });
        if binary {
            receipt.patch_truncated = true;
            continue;
        }
        let blob_path = |hash: &Option<String>| {
            directory.join(
                hash.as_deref()
                    .map(|h| h.trim_start_matches("sha256:"))
                    .unwrap_or("empty"),
            )
        };
        let (hunks, truncated) = GitWorktreeService
            .checkpoint_blob_patch(&blob_path(&old_hash), &blob_path(&new_hash))
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let quote = |prefix: &str| {
            serde_json::to_string(&format!("{prefix}/{path}")).expect("string serialization")
        };
        let mut patch = format!("diff --git {} {}\n", quote("a"), quote("b"));
        let git_mode = |mode: u32| {
            if mode & 0o111 == 0 {
                0o100644
            } else {
                0o100755
            }
        };
        match status {
            AgentTurnFileStatus::Added => patch.push_str(&format!(
                "new file mode {:06o}\n",
                git_mode(new_mode.unwrap_or(0o644))
            )),
            AgentTurnFileStatus::Deleted => patch.push_str(&format!(
                "deleted file mode {:06o}\n",
                git_mode(old_mode.unwrap_or(0o644))
            )),
            _ if old_mode != new_mode => {
                patch.push_str(&format!(
                    "old mode {:06o}\nnew mode {:06o}\n",
                    git_mode(old_mode.unwrap_or(0o644)),
                    git_mode(new_mode.unwrap_or(0o644))
                ));
            }
            _ => {}
        }
        if !hunks.is_empty() {
            patch.push_str(&format!(
                "--- {}\n+++ {}\n{}",
                if old_hash.is_some() {
                    quote("a")
                } else {
                    "/dev/null".to_owned()
                },
                if new_hash.is_some() {
                    quote("b")
                } else {
                    "/dev/null".to_owned()
                },
                hunks
            ));
        }
        if receipt.patch.len() + patch.len() <= MAX_CHECKPOINT_PATCH_BYTES {
            receipt.patch.push_str(&patch);
        } else {
            receipt.patch_truncated = true;
        }
        receipt.patch_truncated |= truncated;
    }
    receipt.omitted_file_count = omitted;
    receipt.state = if omitted == 0 && before.stable && after.stable {
        AgentTurnChangesState::Ready
    } else {
        AgentTurnChangesState::Incomplete
    };
    receipt.detail = COVERAGE.to_owned();
    if omitted > 0 {
        receipt.detail.push_str(" Some paths were omitted: files must be regular files, at most 2 MiB each, within 2,048 paths and 32 MiB per capture. Symbolic links are not followed.");
    }
    if !before.stable || !after.stable {
        receipt
            .detail
            .push_str(" Git state changed during capture. Treat this receipt as incomplete.");
    }
    if receipt.patch_truncated {
        receipt
            .detail
            .push_str(" The text patch omits binary content or exceeds its 1 MiB limit. Exact bytes remain in the saved file captures.");
    }
    if receipt.observation == AgentTurnChangesObservation::Recovered {
        receipt.detail.push_str(
            " The after state was captured after the host restarted; it can include later edits.",
        );
    }
    Ok(())
}

pub(super) struct TrustedTurnCheckTarget {
    pub target: PathBuf,
    pub receipt: AgentTurnChanges,
    pub expected_digest: String,
    expected_target_identity: String,
    pub conversation: AgentConversation,
}

pub(super) fn canonical_capture_digest(
    capture: &WorktreeCheckpointCapture,
) -> Result<String, LocalWtsError> {
    if !capture.stable
        || capture.omitted_file_count != 0
        || capture.files.values().any(|file| file.unsupported)
    {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let files = capture
        .files
        .iter()
        .filter(|(_, file)| file.sha256.is_some())
        .map(|(path, file)| (path, &file.sha256, file.mode))
        .collect::<Vec<_>>();
    serde_json::to_vec(&(
        files,
        &capture.head_commit_oid,
        &capture.branch_name,
        &capture.index_sha256,
    ))
    .map(|bytes| sha256_bytes(&bytes))
    .map_err(|_| LocalWtsError::AgentConversationUnavailable)
}

pub(super) fn load_check_target(
    service: &LocalWtsService,
    conversation_id: Uuid,
    request_id: Uuid,
) -> Result<TrustedTurnCheckTarget, LocalWtsError> {
    let receipt = service.get_agent_turn_changes(conversation_id, request_id)?;
    if receipt.state != AgentTurnChangesState::Ready
        || receipt.observation != AgentTurnChangesObservation::Normal
        || receipt.after.is_none()
    {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let conversation = service.get_agent_conversation(conversation_id)?;
    let worktree = service.load_source_worktree(receipt.workspace_id, &receipt.repository_id)?;
    let target = PathBuf::from(worktree.target_display_path);
    let stored = read_record(
        &turn_dir(&service.inner.agent_conversations.root, receipt.session_id).join("receipt.json"),
    )?;
    if stored.target != target || target_identity(&target)? != stored.target_identity {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let expected_digest = canonical_capture_digest(
        stored
            .after
            .as_ref()
            .ok_or(LocalWtsError::AgentConversationConflict)?,
    )?;
    Ok(TrustedTurnCheckTarget {
        target,
        receipt,
        expected_digest,
        expected_target_identity: stored.target_identity,
        conversation,
    })
}

pub(super) fn matches_check_target(target: &TrustedTurnCheckTarget) -> Result<bool, LocalWtsError> {
    if target_identity(&target.target)? != target.expected_target_identity {
        return Ok(false);
    }
    let capture = GitWorktreeService
        .capture_worktree_checkpoint(&target.target)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    Ok(canonical_capture_digest(&capture).is_ok_and(|digest| digest == target.expected_digest))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;
    fn git(root: &Path, args: &[&str]) {
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
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn restart_waits_for_process_lease_then_captures_after_before_publishing_idle() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("repo");
        fs::create_dir(&target).unwrap();
        git(&target, &["init", "-b", "main"]);
        git(&target, &["config", "user.name", "Fixture"]);
        git(&target, &["config", "user.email", "fixture@example.test"]);
        fs::write(target.join("file.txt"), "committed\n").unwrap();
        git(&target, &["add", "."]);
        git(&target, &["commit", "-m", "fixture"]);
        fs::write(target.join("file.txt"), "dirty before restart\n").unwrap();
        let data = directory.path().join("data");
        let store = ConversationStore::open(&data).unwrap();
        let session_id = Uuid::new_v4();
        let request_id = Uuid::new_v4();
        let user = AgentConversationMessage {
            message_id: Uuid::new_v4(),
            request_id: Some(request_id),
            submitted_body: None,
            queue_sequence: Some(1),
            queue_position: None,
            last_mutation_request_id: None,
            role: AgentConversationMessageRole::User,
            body: "Change the file".to_owned(),
            status: AgentConversationMessageStatus::Running,
            created_at_unix_ms: now_unix_ms(),
            session_id: Some(session_id),
            error: None,
            progress: None,
            diagnostic: None,
        };
        let mut assistant = user.clone();
        assistant.role = AgentConversationMessageRole::Assistant;
        assistant.message_id = Uuid::new_v4();
        assistant.body.clear();
        assistant.queue_sequence = None;
        let mut conversation = AgentConversation {
            schema_version: 1,
            conversation_id: Uuid::new_v4(),
            workspace_id: Uuid::new_v4(),
            workspace_display_path: target.display().to_string(),
            repository_id: "repo_fixture".to_owned(),
            provider: AgentProvider::Codex,
            source: AgentConversationSource::Ui {
                route: "/".to_owned(),
                callout_id: "fixture".to_owned(),
                label: "Fixture".to_owned(),
                selected_text: None,
                context: None,
                capture: None,
            },
            revision: 1,
            created_at_unix_ms: now_unix_ms(),
            updated_at_unix_ms: now_unix_ms(),
            messages: vec![user, assistant],
            active_session_id: Some(session_id),
            preview: None,
            queue_mutations: vec![],
        };
        store.write(&mut conversation).unwrap();
        let lease = store.turn_lease(&conversation).unwrap();
        begin_turn_capture(&store, &conversation, session_id, &target).unwrap();
        let record_path = turn_dir(&store.root, session_id).join("receipt.json");
        assert_eq!(
            read_record(&record_path).unwrap().receipt.state,
            AgentTurnChangesState::Capturing
        );
        let reopened_while_live = ConversationStore::open(&data).unwrap();
        assert_eq!(
            reopened_while_live
                .read(conversation.conversation_id)
                .unwrap()
                .active_session_id,
            Some(session_id)
        );
        assert!(
            Command::new("/bin/sh")
                .arg("-c")
                .arg("printf 'orphan process result\\n' > file.txt")
                .current_dir(&target)
                .status()
                .unwrap()
                .success()
        );
        drop(lease);
        let recovered = ConversationStore::open(&data).unwrap();
        assert!(
            recovered
                .read(conversation.conversation_id)
                .unwrap()
                .active_session_id
                .is_none()
        );
        let receipt = read_record(&record_path).unwrap().receipt;
        assert_eq!(receipt.observation, AgentTurnChangesObservation::Recovered);
        assert_eq!(receipt.state, AgentTurnChangesState::Ready);
        assert!(receipt.patch.contains("-dirty before restart"));
        assert!(receipt.patch.contains("+orphan process result"));
        fs::write(target.join("file.txt"), "later unrelated work\n").unwrap();
        finish_turn_capture(&recovered, session_id, true).unwrap();
        assert_eq!(read_record(&record_path).unwrap().receipt, receipt);
    }
}
