//! Durable isolated tasks dispatched through the existing conversation queue.
use super::*;
use wts_git::WorktreeCheckpointCapture;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentWorkSetKind {
    Tasks,
    Alternatives,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentWorkItemState {
    Pending,
    Preparing,
    Queued,
    Running,
    Completed,
    Failed,
    Blocked,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkItemRequest {
    pub task_id: Uuid,
    pub title: String,
    pub prompt: String,
    pub depends_on: Vec<Uuid>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAgentWorkSetRequest {
    pub request_id: Uuid,
    pub expected_after_checkpoint_id: Uuid,
    pub kind: AgentWorkSetKind,
    pub tasks: Vec<AgentWorkItemRequest>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkItemCancelRequest {
    pub request_id: Uuid,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkItem {
    pub task_id: Uuid,
    pub title: String,
    pub prompt: String,
    pub depends_on: Vec<Uuid>,
    pub state: AgentWorkItemState,
    pub conversation_id: Uuid,
    pub request_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_display_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_checkpoint_id: Option<Uuid>,
    pub detail: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkSet {
    pub schema_version: u32,
    pub work_set_id: Uuid,
    pub conversation_id: Uuid,
    pub request_id: Uuid,
    pub workspace_id: Uuid,
    pub repository_id: String,
    pub source_checkpoint_id: Uuid,
    pub source_context_sha256: String,
    pub kind: AgentWorkSetKind,
    pub revision: u64,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_mutation_request_id: Option<Uuid>,
    pub tasks: Vec<AgentWorkItem>,
    pub detail: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWorkSetList {
    pub schema_version: u32,
    pub conversation_id: Uuid,
    pub request_id: Uuid,
    pub work_sets: Vec<AgentWorkSet>,
}

pub(super) struct TrustedAgentWorkItem {
    pub work_set_id: Uuid,
    pub task_id: Uuid,
    pub origin_conversation_id: Uuid,
    pub origin_request_id: Uuid,
    pub child_conversation_id: Uuid,
    pub child_request_id: Uuid,
    pub source: turn_changes::TrustedTurnCheckTarget,
    pub candidate: turn_changes::TrustedTurnCheckTarget,
    pub baseline: WorktreeCheckpointCapture,
    pub result: WorktreeCheckpointCapture,
    pub baseline_blob_dir: PathBuf,
    pub result_blob_dir: PathBuf,
}

const MAX_WORK_SETS: usize = 4096;
const MAX_SET_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ACTIVE_ITEMS: usize = 3;
type WorkSetCache = BTreeMap<PathBuf, (std::time::SystemTime, u64, bool)>;
static WORK_SET_CACHE: std::sync::OnceLock<Mutex<WorkSetCache>> = std::sync::OnceLock::new();
fn pending_sets(store: &ConversationStore) -> Result<Vec<StoredWorkSet>, LocalWtsError> {
    let mut cache = WORK_SET_CACHE
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    let mut sets = vec![];
    for id in ids(store)? {
        let path = directory(store, id).join("set.json");
        let metadata = path
            .symlink_metadata()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let modified = metadata
            .modified()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        if cache.get(&path).is_some_and(|(previous, size, pending)| {
            *previous == modified && *size == metadata.len() && !pending
        }) {
            continue;
        }
        let set = read_set(store, id)?;
        let pending = set.view.tasks.iter().any(|task| {
            !terminal(task.state)
                || (task.state == AgentWorkItemState::Cancelled
                    && store
                        .read(task.conversation_id)
                        .is_ok_and(|conversation| conversation_has_work(&conversation)))
        });
        cache.insert(path, (modified, metadata.len(), pending));
        if pending {
            sets.push(set);
        }
    }
    // The cache contains metadata only. Old temporary stores do not need to stay here.
    if cache.len() > MAX_WORK_SETS * 2 {
        cache.retain(|path, _| path.starts_with(root(store)));
    }
    Ok(sets)
}

#[derive(Serialize, Deserialize)]
struct StoredWorkSet {
    request: CreateAgentWorkSetRequest,
    view: AgentWorkSet,
    source_session_id: Uuid,
    source_target_identity: String,
    #[serde(default)]
    cancellations: Vec<CancelReceipt>,
}
#[derive(Serialize, Deserialize)]
struct PreparedInput {
    target_identity: String,
    initial: WorktreeCheckpointCapture,
    desired: WorktreeCheckpointCapture,
    blobs: BTreeMap<String, PathBuf>,
    complete: bool,
}
#[derive(Serialize, Deserialize)]
struct CancelReceipt {
    request: AgentWorkItemCancelRequest,
    task_id: Uuid,
    result: AgentWorkSet,
}

fn root(store: &ConversationStore) -> PathBuf {
    store.root.join("work-sets")
}
fn directory(store: &ConversationStore, id: Uuid) -> PathBuf {
    root(store).join(id.to_string())
}
fn set_lock(store: &ConversationStore, nonblocking: bool) -> Result<fs::File, LocalWtsError> {
    turn_changes::private_dir(&root(store))?;
    lock_conversation_file(&root(store).join(".lock"), nonblocking)
}
fn ids(store: &ConversationStore) -> Result<Vec<Uuid>, LocalWtsError> {
    if !root(store).exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for entry in
        fs::read_dir(root(store)).map_err(|_| LocalWtsError::AgentConversationUnavailable)?
    {
        let entry = entry.map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        if let Some(id) = entry
            .file_name()
            .to_str()
            .and_then(|name| Uuid::parse_str(name).ok())
        {
            if entry
                .file_type()
                .map_err(|_| LocalWtsError::AgentConversationUnavailable)?
                .is_symlink()
            {
                return Err(LocalWtsError::AgentConversationUnavailable);
            }
            result.push(id);
        }
    }
    if result.len() > MAX_WORK_SETS {
        return Err(LocalWtsError::AgentConversationStorageFull);
    }
    result.sort();
    Ok(result)
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path, limit: u64) -> Result<T, LocalWtsError> {
    let metadata = path.symlink_metadata().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            LocalWtsError::AgentConversationNotFound
        } else {
            LocalWtsError::AgentConversationUnavailable
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let bytes =
        read_bounded_file(path, limit).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    serde_json::from_slice(&bytes).map_err(|_| LocalWtsError::AgentConversationUnavailable)
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), LocalWtsError> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if bytes.len() > MAX_SET_BYTES as usize {
        return Err(LocalWtsError::AgentConversationStorageFull);
    }
    turn_changes::write_private(path, &bytes)
}
fn read_set(store: &ConversationStore, id: Uuid) -> Result<StoredWorkSet, LocalWtsError> {
    let set: StoredWorkSet = read_json(&directory(store, id).join("set.json"), MAX_SET_BYTES)?;
    validate_request(&set.request).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if set.view.schema_version != 1
        || set.view.work_set_id != id
        || set.request.request_id != id
        || set.view.tasks.len() != set.request.tasks.len()
        || set.view.revision == 0
        || set.view.source_checkpoint_id != set.request.expected_after_checkpoint_id
        || set.cancellations.len() > 8
        || set.view.kind != set.request.kind
        || set.view.conversation_id.is_nil()
        || set.view.request_id.is_nil()
        || set
            .view
            .tasks
            .iter()
            .zip(&set.request.tasks)
            .any(|(task, request)| {
                task.task_id != request.task_id
                    || task.title != request.title
                    || task.prompt != request.prompt
                    || task.depends_on != request.depends_on
                    || task.conversation_id.is_nil()
                    || task.request_id.is_nil()
            })
    {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let mut mutations = BTreeSet::new();
    for receipt in &set.cancellations {
        if receipt.request.request_id.is_nil()
            || !mutations.insert(receipt.request.request_id)
            || receipt.result.work_set_id != id
            || receipt.result.conversation_id != set.view.conversation_id
            || receipt.result.request_id != set.view.request_id
            || receipt.result.last_mutation_request_id != Some(receipt.request.request_id)
            || receipt.result.revision > set.view.revision
            || !receipt.result.tasks.iter().any(|task| {
                task.task_id == receipt.task_id && task.state == AgentWorkItemState::Cancelled
            })
            || !set.view.tasks.iter().any(|task| {
                task.task_id == receipt.task_id && task.state == AgentWorkItemState::Cancelled
            })
        {
            return Err(LocalWtsError::AgentConversationUnavailable);
        }
    }
    Ok(set)
}
fn save_set(store: &ConversationStore, set: &mut StoredWorkSet) -> Result<(), LocalWtsError> {
    for task in &mut set.view.tasks {
        task.detail = bounded_detail(&task.detail);
    }
    set.view.detail = bounded_detail(&set.view.detail);
    set.view.revision += 1;
    set.view.updated_at_unix_ms = now_unix_ms();
    write_json(
        &directory(store, set.view.work_set_id).join("set.json"),
        set,
    )
}
fn validate_request(request: &CreateAgentWorkSetRequest) -> Result<(), LocalWtsError> {
    if request.request_id.is_nil()
        || request.expected_after_checkpoint_id.is_nil()
        || request.tasks.is_empty()
        || request.tasks.len() > 8
    {
        return Err(LocalWtsError::InvalidAgentConversation);
    }
    let mut ids = BTreeSet::new();
    for task in &request.tasks {
        if task.task_id.is_nil()
            || !ids.insert(task.task_id)
            || task.title.trim().is_empty()
            || task.title.len() > 160
            || task.title.chars().any(char::is_control)
            || task.prompt.trim().is_empty()
            || task.prompt.len() > 16_384
            || task
                .prompt
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            || task.depends_on.len() > 7
            || task
                .depends_on
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                .len()
                != task.depends_on.len()
            || (request.kind == AgentWorkSetKind::Alternatives && !task.depends_on.is_empty())
        {
            return Err(LocalWtsError::InvalidAgentConversation);
        }
    }
    let mut done = BTreeSet::new();
    loop {
        let before = done.len();
        for task in &request.tasks {
            if task.depends_on.iter().all(|id| done.contains(id)) {
                done.insert(task.task_id);
            }
        }
        if done.len() == request.tasks.len() {
            return Ok(());
        }
        if before == done.len() {
            return Err(LocalWtsError::InvalidAgentConversation);
        }
    }
}
fn source_record(
    service: &LocalWtsService,
    set: &StoredWorkSet,
) -> Result<turn_changes::StoredTurn, LocalWtsError> {
    let receipt = service.get_agent_turn_changes(set.view.conversation_id, set.view.request_id)?;
    if receipt.session_id != set.source_session_id
        || receipt.after.as_ref().map(|item| item.checkpoint_id)
            != Some(set.view.source_checkpoint_id)
        || receipt.source_context_sha256 != set.view.source_context_sha256
        || receipt.workspace_id != set.view.workspace_id
        || receipt.repository_id != set.view.repository_id
        || receipt.state != AgentTurnChangesState::Ready
        || receipt.observation != AgentTurnChangesObservation::Normal
    {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let stored = turn_changes::read_record(
        &turn_changes::turn_dir(
            &service.inner.agent_conversations.root,
            set.source_session_id,
        )
        .join("receipt.json"),
    )?;
    if stored.target_identity != set.source_target_identity {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    turn_changes::canonical_capture_digest(
        stored
            .after
            .as_ref()
            .ok_or(LocalWtsError::AgentConversationConflict)?,
    )?;
    Ok(stored)
}
fn terminal(state: AgentWorkItemState) -> bool {
    matches!(
        state,
        AgentWorkItemState::Completed
            | AgentWorkItemState::Failed
            | AgentWorkItemState::Blocked
            | AgentWorkItemState::Cancelled
    )
}

impl LocalWtsService {
    pub fn create_agent_work_set(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
        request: CreateAgentWorkSetRequest,
    ) -> Result<AgentWorkSet, LocalWtsError> {
        validate_request(&request)?;
        let store = &self.inner.agent_conversations;
        let _lock = set_lock(store, false)?;
        match read_set(store, request.request_id) {
            Ok(existing)
                if existing.request == request
                    && existing.view.conversation_id == conversation_id
                    && existing.view.request_id == request_id =>
            {
                return Ok(existing.view);
            }
            Ok(_) => return Err(LocalWtsError::AgentConversationConflict),
            Err(LocalWtsError::AgentConversationNotFound) => {}
            Err(error) => return Err(error),
        }
        let all = ids(store)?;
        if all.len() >= MAX_WORK_SETS
            || store.ids()?.len() + request.tasks.len() > MAX_CONVERSATIONS
        {
            return Err(LocalWtsError::AgentConversationStorageFull);
        }
        if all
            .into_iter()
            .map(|id| read_set(store, id))
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .filter(|set| {
                set.view.conversation_id == conversation_id && set.view.request_id == request_id
            })
            .count()
            >= 64
        {
            return Err(LocalWtsError::AgentConversationLimit);
        }
        let source = turn_changes::load_check_target(self, conversation_id, request_id)?;
        if matches!(
            source.conversation.source,
            AgentConversationSource::WorkItem { .. }
        ) {
            return Err(LocalWtsError::InvalidAgentConversation);
        }
        if source.receipt.after.as_ref().map(|item| item.checkpoint_id)
            != Some(request.expected_after_checkpoint_id)
        {
            return Err(LocalWtsError::AgentConversationConflict);
        }
        let _lease = self.lease_workspace_agent_operation(source.receipt.workspace_id)?;
        if !turn_changes::matches_check_target(&source)? {
            return Err(LocalWtsError::AgentConversationConflict);
        }
        let binding = store.discussion_binding(&source.conversation)?;
        self.verify_conversation_discussion(&source.conversation.source, binding.as_ref())?;
        let now = now_unix_ms();
        let view=AgentWorkSet { schema_version:1,work_set_id:request.request_id,conversation_id,request_id,workspace_id:source.receipt.workspace_id,repository_id:source.receipt.repository_id.clone(),source_checkpoint_id:request.expected_after_checkpoint_id,source_context_sha256:source.receipt.source_context_sha256,kind:request.kind,revision:1,created_at_unix_ms:now,updated_at_unix_ms:now,last_mutation_request_id:None,tasks:request.tasks.iter().map(|task|AgentWorkItem {task_id:task.task_id,title:task.title.clone(),prompt:task.prompt.clone(),depends_on:task.depends_on.clone(),state:AgentWorkItemState::Pending,conversation_id:Uuid::new_v4(),request_id:Uuid::new_v4(),workspace_id:None,repository_id:None,workspace_display_path:None,after_checkpoint_id:None,detail:"This task waits for an isolated workspace and its prerequisites.".into()}).collect(),detail:"Tasks use isolated workspaces. The source workspace stays unchanged. Review each result before integration.".into() };
        let set = StoredWorkSet {
            request,
            view,
            source_session_id: source.receipt.session_id,
            source_target_identity: turn_changes::target_identity(&source.target)?,
            cancellations: vec![],
        };
        turn_changes::private_dir(&directory(store, set.view.work_set_id))?;
        write_json(
            &directory(store, set.view.work_set_id).join("set.json"),
            &set,
        )?;
        Ok(set.view)
    }
    pub fn get_agent_work_set(&self, id: Uuid) -> Result<AgentWorkSet, LocalWtsError> {
        let store = &self.inner.agent_conversations;
        let _lock = set_lock(store, false)?;
        Ok(read_set(store, id)?.view)
    }
    pub fn list_agent_work_sets(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<AgentWorkSetList, LocalWtsError> {
        self.get_agent_turn_changes(conversation_id, request_id)?;
        let store = &self.inner.agent_conversations;
        let _lock = set_lock(store, false)?;
        let mut work_sets = ids(store)?
            .into_iter()
            .map(|id| read_set(store, id))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|set| set.view)
            .filter(|set| set.conversation_id == conversation_id && set.request_id == request_id)
            .collect::<Vec<_>>();
        work_sets.sort_by_key(|set| (set.created_at_unix_ms, set.work_set_id));
        Ok(AgentWorkSetList {
            schema_version: 1,
            conversation_id,
            request_id,
            work_sets,
        })
    }
    pub fn cancel_agent_work_item(
        &self,
        id: Uuid,
        task_id: Uuid,
        request: AgentWorkItemCancelRequest,
    ) -> Result<AgentWorkSet, LocalWtsError> {
        if request.request_id.is_nil() || request.expected_revision == 0 {
            return Err(LocalWtsError::InvalidAgentConversation);
        }
        let store = &self.inner.agent_conversations;
        let _lock = set_lock(store, false)?;
        let mut set = read_set(store, id)?;
        if let Some(receipt) = set
            .cancellations
            .iter()
            .find(|receipt| receipt.request.request_id == request.request_id)
        {
            return if receipt.request == request && receipt.task_id == task_id {
                Ok(receipt.result.clone())
            } else {
                Err(LocalWtsError::AgentConversationConflict)
            };
        }
        refresh_tasks(self, &mut set)?;
        let index = set
            .view
            .tasks
            .iter()
            .position(|item| item.task_id == task_id)
            .ok_or(LocalWtsError::AgentConversationNotFound)?;
        if set.view.revision != request.expected_revision || terminal(set.view.tasks[index].state) {
            return Err(LocalWtsError::AgentConversationConflict);
        }
        set.view.tasks[index].state = AgentWorkItemState::Cancelled;
        set.view.tasks[index].detail =
            "This task was cancelled. Any files already changed stay in its isolated workspace."
                .into();
        set.view.last_mutation_request_id = Some(request.request_id);
        set.view.revision += 1;
        set.view.updated_at_unix_ms = now_unix_ms();
        let receipt = CancelReceipt {
            request,
            task_id,
            result: set.view.clone(),
        };
        set.cancellations.push(receipt);
        write_json(&directory(store, id).join("set.json"), &set)?;
        stop_cancelled_child(self, &set.view.tasks[index]);
        Ok(set.view)
    }
    pub(super) fn pump_agent_work_sets(&self) -> Result<(), LocalWtsError> {
        let store = &self.inner.agent_conversations;
        if !root(store).exists() {
            return Ok(());
        }
        let _lock = set_lock(store, true)?;
        let mut sets = pending_sets(store)?;
        if sets.is_empty() {
            return Ok(());
        }
        for set in &mut sets {
            refresh_tasks(self, set)?;
        }
        let active = store
            .work_conversations()?
            .iter()
            .filter(|conversation| {
                matches!(
                    conversation.source,
                    AgentConversationSource::WorkItem { .. }
                )
            })
            .count();
        let mut slots = MAX_ACTIVE_ITEMS.saturating_sub(active);
        for set in &mut sets {
            for index in 0..set.view.tasks.len() {
                if !matches!(
                    set.view.tasks[index].state,
                    AgentWorkItemState::Pending | AgentWorkItemState::Preparing
                ) {
                    continue;
                }
                let dependencies = set.view.tasks[index].depends_on.clone();
                if dependencies.iter().any(|id| {
                    set.view.tasks.iter().any(|item| {
                        item.task_id == *id
                            && matches!(
                                item.state,
                                AgentWorkItemState::Failed
                                    | AgentWorkItemState::Blocked
                                    | AgentWorkItemState::Cancelled
                            )
                    })
                }) {
                    set.view.tasks[index].state = AgentWorkItemState::Blocked;
                    set.view.tasks[index].detail="A prerequisite did not complete. Review it, then create a new work set to retry.".into();
                    save_set(store, set)?;
                    continue;
                }
                if slots == 0
                    || dependencies.iter().any(|id| {
                        !set.view.tasks.iter().any(|item| {
                            item.task_id == *id && item.state == AgentWorkItemState::Completed
                        })
                    })
                {
                    continue;
                }
                set.view.tasks[index].state = AgentWorkItemState::Preparing;
                save_set(store, set)?;
                match prepare_item(self, set, index) {
                    Ok(()) => {
                        slots -= 1;
                    }
                    Err(error) => {
                        if set.view.tasks[index].state != AgentWorkItemState::Blocked {
                            set.view.tasks[index].state = AgentWorkItemState::Blocked;
                            set.view.tasks[index].detail = format!(
                                "The isolated task could not start: {error}. Review the source and prerequisite files, then create a new work set to retry."
                            );
                        }
                        save_set(store, set)?;
                    }
                }
            }
        }
        Ok(())
    }
}

fn stop_cancelled_child(service: &LocalWtsService, task: &AgentWorkItem) {
    if let Ok(conversation) = service.get_agent_conversation(task.conversation_id) {
        if let Some(session) = conversation.active_session_id {
            let _ = service.stop_agent_session(session);
        }
        for message in &conversation.messages {
            if message.status == AgentConversationMessageStatus::Queued {
                let _ = service.cancel_agent_conversation_message(
                    task.conversation_id,
                    message.message_id,
                    CancelAgentConversationMessageRequest {
                        request_id: task.task_id,
                        expected_body: message.body.clone(),
                    },
                );
            }
        }
    }
}
fn refresh_tasks(service: &LocalWtsService, set: &mut StoredWorkSet) -> Result<(), LocalWtsError> {
    let before = set.view.tasks.clone();
    for task in &mut set.view.tasks {
        if task.state == AgentWorkItemState::Cancelled {
            stop_cancelled_child(service, task);
            continue;
        }
        if terminal(task.state) {
            continue;
        }
        if let Ok(conversation) = service.get_agent_conversation(task.conversation_id)
            && let Some(user) = conversation.messages.iter().find(|message| {
                message.role == AgentConversationMessageRole::User
                    && message.request_id == Some(task.request_id)
            })
        {
            task.state = match user.status {
                AgentConversationMessageStatus::Queued => AgentWorkItemState::Queued,
                AgentConversationMessageStatus::Pending
                | AgentConversationMessageStatus::Running => AgentWorkItemState::Running,
                AgentConversationMessageStatus::Completed => AgentWorkItemState::Completed,
                AgentConversationMessageStatus::Cancelled => AgentWorkItemState::Cancelled,
                _ => AgentWorkItemState::Failed,
            };
            task.detail=match task.state {AgentWorkItemState::Queued=>"This task is in the agent queue.",AgentWorkItemState::Running=>"The agent is active in this isolated workspace.",AgentWorkItemState::Completed=>"The agent finished. Review the observed changes and run checks before integration.",_=>"This task did not complete. Review its output and saved files before a new attempt."}.into();
            if terminal(task.state)
                && let Ok(changes) =
                    service.get_agent_turn_changes(task.conversation_id, task.request_id)
            {
                task.after_checkpoint_id = changes.after.map(|item| item.checkpoint_id);
            }
        }
    }
    if before != set.view.tasks {
        save_set(&service.inner.agent_conversations, set)?;
    }
    Ok(())
}
fn same_file(
    left: Option<&wts_git::CapturedWorktreeFile>,
    right: Option<&wts_git::CapturedWorktreeFile>,
) -> bool {
    left.and_then(|file| file.sha256.as_ref().map(|hash| (hash, file.mode)))
        == right.and_then(|file| file.sha256.as_ref().map(|hash| (hash, file.mode)))
}
fn ancestor(tasks: &[AgentWorkItem], ancestor: Uuid, id: Uuid) -> bool {
    tasks
        .iter()
        .find(|task| task.task_id == id)
        .is_some_and(|task| {
            task.depends_on.contains(&ancestor)
                || task
                    .depends_on
                    .iter()
                    .any(|parent| self::ancestor(tasks, ancestor, *parent))
        })
}
fn desired_input(
    service: &LocalWtsService,
    set: &StoredWorkSet,
    index: usize,
) -> Result<(WorktreeCheckpointCapture, BTreeMap<String, PathBuf>), LocalWtsError> {
    let original = source_record(service, set)?
        .after
        .ok_or(LocalWtsError::AgentConversationConflict)?;
    let mut desired = original.clone();
    let source_dir = turn_changes::turn_dir(
        &service.inner.agent_conversations.root,
        set.source_session_id,
    );
    let mut blobs = original
        .files
        .values()
        .filter_map(|file| {
            file.sha256
                .as_ref()
                .map(|hash| (hash.clone(), source_dir.clone()))
        })
        .collect::<BTreeMap<_, _>>();
    let dependencies = &set.view.tasks[index].depends_on;
    for id in dependencies.iter().filter(|id| {
        !dependencies
            .iter()
            .any(|other| other != *id && ancestor(&set.view.tasks, **id, *other))
    }) {
        let task = set
            .view
            .tasks
            .iter()
            .find(|task| task.task_id == *id)
            .ok_or(LocalWtsError::AgentConversationConflict)?;
        let candidate = load_integration_candidate(service, set.view.work_set_id, task.task_id)?;
        if !turn_changes::matches_check_target(&candidate.candidate)? {
            return Err(LocalWtsError::AgentConversationConflict);
        }
        let paths = original
            .files
            .keys()
            .chain(candidate.result.files.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        for path in paths {
            let incoming = candidate.result.files.get(&path);
            if same_file(original.files.get(&path), incoming) {
                continue;
            }
            if !same_file(desired.files.get(&path), original.files.get(&path))
                && !same_file(desired.files.get(&path), incoming)
            {
                return Err(LocalWtsError::AgentConversationConflict);
            }
            if let Some(file) = incoming {
                desired.files.insert(path, file.clone());
                if let Some(hash) = &file.sha256 {
                    blobs.insert(hash.clone(), candidate.result_blob_dir.clone());
                }
            } else {
                desired.files.remove(&path);
            }
        }
    }
    Ok((desired, blobs))
}
fn prepare_item(
    service: &LocalWtsService,
    set: &mut StoredWorkSet,
    index: usize,
) -> Result<(), LocalWtsError> {
    let store = &service.inner.agent_conversations;
    let source = source_record(service, set)?;
    let task = set.view.tasks[index].clone();
    let source_conversation = service.get_agent_conversation(set.view.conversation_id)?;
    let binding = store.discussion_binding(&source_conversation)?;
    service.verify_conversation_discussion(&source_conversation.source, binding.as_ref())?;
    let repository = service.repository_for_interaction(&set.view.repository_id)?;
    let created = service.create_workspace(
        &task.conversation_id.to_string(),
        CreateWorkspaceRequest {
            intent: WorkspaceIntent::RepositorySet {
                label: format!("Isolated: {}", task.title),
            },
            title: format!("Isolated: {}", task.title),
            preferred_provider: WorkspaceProvider::Codex,
            repositories: vec![WorkspaceRepositoryRequest {
                repository_id: Some(set.view.repository_id.clone()),
                label: repository.label.clone(),
                base_ref: source
                    .after
                    .as_ref()
                    .ok_or(LocalWtsError::AgentConversationConflict)?
                    .head_commit_oid
                    .clone(),
            }],
            runtime: None,
            planning: None,
        },
    )?;
    let workspace_id = created.workspace.workspace_id;
    set.view.tasks[index].workspace_id = Some(workspace_id);
    set.view.tasks[index].repository_id = Some(set.view.repository_id.clone());
    save_set(store, set)?;
    if service
        .load_source_worktree(workspace_id, &set.view.repository_id)
        .is_err()
    {
        let preflight = service.preflight_workspace(workspace_id)?;
        if !preflight.blockers.is_empty() {
            set.view.tasks[index].state = AgentWorkItemState::Blocked;
            set.view.tasks[index].detail = format!(
                "The isolated workspace could not be created. {} Review the workspace setup before a new attempt.",
                preflight
                    .blockers
                    .iter()
                    .map(|blocker| blocker.message.clone())
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            return Err(LocalWtsError::AgentConversationConflict);
        }
        service.materialize_workspace(workspace_id, &preflight.effect_digest)?;
    }
    let worktree = service.load_source_worktree(workspace_id, &set.view.repository_id)?;
    let target = PathBuf::from(&worktree.target_display_path);
    let _lease = service.lease_workspace_agent_operation(workspace_id)?;
    let input_path =
        directory(store, set.view.work_set_id).join(format!("{}.input.json", task.task_id));
    let mut input = match read_json::<PreparedInput>(&input_path, 64 * 1024 * 1024) {
        Ok(input) => input,
        Err(LocalWtsError::AgentConversationNotFound) => {
            let mut initial = service
                .inner
                .git
                .capture_worktree_checkpoint(&target)
                .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
            turn_changes::canonical_capture_digest(&initial)?;
            for file in initial.files.values_mut() {
                file.content = None;
                file.raw_content = None;
            }
            let (mut desired, blobs) = desired_input(service, set, index)?;
            desired.head_commit_oid = initial.head_commit_oid.clone();
            desired.branch_name = initial.branch_name.clone();
            desired.index_sha256 = initial.index_sha256.clone();
            let input = PreparedInput {
                target_identity: turn_changes::target_identity(&target)?,
                initial,
                desired,
                blobs,
                complete: false,
            };
            write_input(&input_path, &input)?;
            input
        }
        Err(error) => return Err(error),
    };
    if input.target_identity != turn_changes::target_identity(&target)? {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let current = service
        .inner
        .git
        .capture_worktree_checkpoint(&target)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if current.head_commit_oid != input.initial.head_commit_oid
        || current.branch_name != input.initial.branch_name
        || current.index_sha256 != input.initial.index_sha256
    {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    turn_changes::canonical_capture_digest(&current)?;
    let paths = current
        .files
        .keys()
        .chain(input.initial.files.keys())
        .chain(input.desired.files.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    for path in &paths {
        if !same_file(current.files.get(path), input.desired.files.get(path))
            && (input.complete
                || !same_file(current.files.get(path), input.initial.files.get(path)))
        {
            return Err(LocalWtsError::AgentConversationConflict);
        }
    }
    for path in &paths {
        if same_file(current.files.get(path), input.desired.files.get(path)) {
            continue;
        }
        let before = current.files.get(path);
        let after = input.desired.files.get(path);
        let content = after
            .and_then(|file| file.sha256.as_ref())
            .map(|hash| {
                turn_changes::read_blob_bytes(
                    input
                        .blobs
                        .get(hash)
                        .ok_or(LocalWtsError::AgentConversationUnavailable)?,
                    hash,
                )
            })
            .transpose()?;
        if content.is_some() {
            service
                .inner
                .git
                .prepare_worktree_source_parent_checked(&target, path, &input.target_identity)
                .map_err(|_| LocalWtsError::AgentConversationConflict)?;
        }
        service
            .inner
            .git
            .restore_worktree_bytes_checked(
                &target,
                path,
                content.as_deref(),
                after.and_then(|file| file.mode),
                before.and_then(|file| file.sha256.as_deref()),
                before.and_then(|file| file.mode),
                &input.target_identity,
            )
            .map_err(|_| LocalWtsError::AgentConversationConflict)?;
    }
    let after = service
        .inner
        .git
        .capture_worktree_checkpoint(&target)
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if turn_changes::canonical_capture_digest(&after)?
        != turn_changes::canonical_capture_digest(&input.desired)?
    {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    input.complete = true;
    write_input(&input_path, &input)?;
    let (workspace_root, _) = service.read_materialization_receipt(workspace_id)?;
    set.view.tasks[index].workspace_display_path = Some(display_path(&workspace_root)?);
    save_set(store, set)?;
    {
        let _guard = store
            .lock
            .lock()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let _disk = store.disk_lock()?;
        let child_source = AgentConversationSource::WorkItem {
            work_set_id: set.view.work_set_id,
            task_id: task.task_id,
            label: task.title.clone(),
            origin_conversation_id: set.view.conversation_id,
            origin_request_id: set.view.request_id,
        };
        match store.read(task.conversation_id) {
            Ok(existing)
                if existing.workspace_id == workspace_id
                    && existing.repository_id == set.view.repository_id
                    && existing.source == child_source => {}
            Ok(_) => return Err(LocalWtsError::AgentConversationConflict),
            Err(LocalWtsError::AgentConversationNotFound) => {
                let now = now_unix_ms();
                let mut child = AgentConversation {
                    queue_mutations: vec![],
                    schema_version: 1,
                    conversation_id: task.conversation_id,
                    workspace_id,
                    workspace_display_path: display_path(&workspace_root)?,
                    repository_id: set.view.repository_id.clone(),
                    provider: source_conversation.provider,
                    source: child_source,
                    revision: 0,
                    created_at_unix_ms: now,
                    updated_at_unix_ms: now,
                    messages: vec![],
                    active_session_id: None,
                    preview: None,
                };
                store.write(&mut child)?;
            }
            Err(error) => return Err(error),
        }
    }
    drop(_lease);
    service.send_agent_conversation_message(
        task.conversation_id,
        SendAgentConversationMessageRequest {
            request_id: task.request_id,
            body: task.prompt,
        },
    )?;
    set.view.tasks[index].state = AgentWorkItemState::Queued;
    set.view.tasks[index].detail = "This task is in the agent queue.".into();
    save_set(store, set)?;
    Ok(())
}

pub(super) fn load_integration_candidate(
    service: &LocalWtsService,
    work_set_id: Uuid,
    task_id: Uuid,
) -> Result<TrustedAgentWorkItem, LocalWtsError> {
    let store = &service.inner.agent_conversations;
    let set = read_set(store, work_set_id)?;
    let task = set
        .view
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .ok_or(LocalWtsError::AgentConversationNotFound)?;
    if task.state != AgentWorkItemState::Completed {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let source_record = source_record(service, &set)?;
    let source =
        turn_changes::load_check_target(service, set.view.conversation_id, set.view.request_id)?;
    let candidate =
        turn_changes::load_check_target(service, task.conversation_id, task.request_id)?;
    if candidate.receipt.workspace_id
        != task
            .workspace_id
            .ok_or(LocalWtsError::AgentConversationConflict)?
        || Some(&candidate.receipt.repository_id) != task.repository_id.as_ref()
        || candidate
            .receipt
            .after
            .as_ref()
            .map(|item| item.checkpoint_id)
            != task.after_checkpoint_id
        || !matches!(candidate.conversation.source,AgentConversationSource::WorkItem {work_set_id:id,task_id:tid,origin_conversation_id,origin_request_id,..} if id==work_set_id && tid==task_id && origin_conversation_id==set.view.conversation_id && origin_request_id==set.view.request_id)
    {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let record = turn_changes::read_record(
        &turn_changes::turn_dir(&store.root, candidate.receipt.session_id).join("receipt.json"),
    )?;
    let baseline = source_record
        .after
        .ok_or(LocalWtsError::AgentConversationConflict)?;
    let result = record
        .after
        .ok_or(LocalWtsError::AgentConversationConflict)?;
    turn_changes::canonical_capture_digest(&result)?;
    Ok(TrustedAgentWorkItem {
        work_set_id,
        task_id,
        origin_conversation_id: set.view.conversation_id,
        origin_request_id: set.view.request_id,
        child_conversation_id: task.conversation_id,
        child_request_id: task.request_id,
        baseline_blob_dir: turn_changes::turn_dir(&store.root, set.source_session_id),
        result_blob_dir: turn_changes::turn_dir(&store.root, candidate.receipt.session_id),
        source,
        candidate,
        baseline,
        result,
    })
}

pub(super) fn verify_child(
    service: &LocalWtsService,
    conversation: &AgentConversation,
) -> Result<Option<PathBuf>, LocalWtsError> {
    let AgentConversationSource::WorkItem {
        work_set_id,
        task_id,
        origin_conversation_id,
        origin_request_id,
        ..
    } = &conversation.source
    else {
        return Ok(None);
    };
    let store = &service.inner.agent_conversations;
    let set = read_set(store, *work_set_id)?;
    let task = set
        .view
        .tasks
        .iter()
        .find(|task| task.task_id == *task_id)
        .ok_or(LocalWtsError::AgentConversationConflict)?;
    if set.view.conversation_id != *origin_conversation_id
        || set.view.request_id != *origin_request_id
        || task.conversation_id != conversation.conversation_id
        || task.workspace_id != Some(conversation.workspace_id)
        || task.repository_id.as_ref() != Some(&conversation.repository_id)
        || task.state == AgentWorkItemState::Cancelled
    {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let input: PreparedInput = read_json(
        &directory(store, *work_set_id).join(format!("{task_id}.input.json")),
        64 * 1024 * 1024,
    )?;
    let worktree =
        service.load_source_worktree(conversation.workspace_id, &conversation.repository_id)?;
    let target = Path::new(&worktree.target_display_path);
    if !input.complete
        || input.target_identity != turn_changes::target_identity(target)?
        || turn_changes::canonical_capture_digest(
            &service
                .inner
                .git
                .capture_worktree_checkpoint(target)
                .map_err(|_| LocalWtsError::AgentConversationUnavailable)?,
        )? != turn_changes::canonical_capture_digest(&input.desired)?
    {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let origin = service.get_agent_conversation(*origin_conversation_id)?;
    let binding = store.discussion_binding(&origin)?;
    service.verify_conversation_discussion(&origin.source, binding.as_ref())?;
    source_record(service, &set)?;
    Ok(matches!(
        origin.source,
        AgentConversationSource::Ui {
            capture: Some(_),
            ..
        }
    )
    .then(|| store.root.join(format!("{}.png", origin.conversation_id))))
}

pub(super) fn child_source_context(
    conversation: &AgentConversation,
    store: &Path,
) -> Result<serde_json::Value, LocalWtsError> {
    let AgentConversationSource::WorkItem {
        work_set_id,
        task_id,
        origin_conversation_id,
        origin_request_id,
        ..
    } = &conversation.source
    else {
        return Err(LocalWtsError::InvalidAgentConversation);
    };
    let writer = ConversationStore {
        root: store.to_owned(),
        previews: work_item_preview::preview_supervisor(),
        lock: Mutex::new(()),
        ui_source: Mutex::new(None),
        work_cache: Mutex::new(BTreeMap::new()),
        #[cfg(test)]
        parsed_records: std::sync::atomic::AtomicUsize::new(0),
    };
    let set = read_set(&writer, *work_set_id)?;
    let task = set
        .view
        .tasks
        .iter()
        .find(|task| task.task_id == *task_id)
        .ok_or(LocalWtsError::AgentConversationConflict)?;
    let origin = writer.read(set.view.conversation_id)?;
    if set.view.conversation_id != *origin_conversation_id
        || set.view.request_id != *origin_request_id
        || task.conversation_id != conversation.conversation_id
        || origin.workspace_id != set.view.workspace_id
        || origin.repository_id != set.view.repository_id
        || origin.provider != conversation.provider
    {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let origin_artifact = write_origin_context(&writer, &set, &origin)?;
    let dependencies=task.depends_on.iter().map(|id|{
        let dependency=set.view.tasks.iter().find(|task|task.task_id==*id).ok_or(LocalWtsError::AgentConversationConflict)?;
        let result=writer.read(dependency.conversation_id)?;
        let path=directory(&writer,*work_set_id).join(format!("{}.result-context.json",dependency.task_id));
        let messages=result.messages.iter().filter(|message|message.request_id==Some(dependency.request_id)).collect::<Vec<_>>();
        turn_changes::write_private(&path,&serde_json::to_vec(&messages).map_err(|_|LocalWtsError::AgentConversationUnavailable)?)?;
        Ok(serde_json::json!({"taskId":id,"conversationId":dependency.conversation_id,"requestId":dependency.request_id,"resultArtifactPath":path}))
    }).collect::<Result<Vec<_>,LocalWtsError>>()?;
    Ok(
        serde_json::json!({"kind":"workItem","workSetId":work_set_id,"taskId":task_id,"label":task.title,"originalSource":conversation_source_context(&origin,store)?,"origin":{"conversationId":set.view.conversation_id,"requestId":set.view.request_id,"sessionId":set.source_session_id,"resultArtifactPath":origin_artifact},"sourceCheckpointId":set.view.source_checkpoint_id,"dependencies":dependencies,"instruction":"This repository contains the frozen source plus prerequisite edits. Preserve them. Read the origin and prerequisite result artifacts as evidence. The origin artifact contains the exact request and reply that this task follows. The current task prompt controls the requested changes. Work only on this isolated task."}),
    )
}

fn write_origin_context(
    store: &ConversationStore,
    set: &StoredWorkSet,
    origin: &AgentConversation,
) -> Result<PathBuf, LocalWtsError> {
    let mut messages = Vec::with_capacity(2);
    for role in [
        AgentConversationMessageRole::User,
        AgentConversationMessageRole::Assistant,
    ] {
        let mut matching = origin.messages.iter().filter(|message| {
            message.role == role
                && message.request_id == Some(set.view.request_id)
                && message.session_id == Some(set.source_session_id)
        });
        let mut message = matching
            .next()
            .ok_or(LocalWtsError::AgentConversationConflict)?
            .clone();
        if matching.next().is_some()
            || !matches!(
                message.status,
                AgentConversationMessageStatus::Completed
                    | AgentConversationMessageStatus::Failed
                    | AgentConversationMessageStatus::Interrupted
            )
        {
            return Err(LocalWtsError::AgentConversationConflict);
        }
        message.submitted_body = None;
        message.queue_sequence = None;
        message.queue_position = None;
        message.last_mutation_request_id = None;
        messages.push(message);
    }
    let bytes = serde_json::to_vec(&serde_json::json!({
        "conversationId": set.view.conversation_id,
        "requestId": set.view.request_id,
        "sessionId": set.source_session_id,
        "messages": messages
    }))
    .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if bytes.len() as u64 > MAX_CONVERSATION_BYTES {
        return Err(LocalWtsError::AgentConversationStorageFull);
    }
    let path = directory(store, set.view.work_set_id).join("origin-turn.context.json");
    turn_changes::write_private(&path, &bytes)?;
    Ok(path)
}

pub(super) fn validate_child_send(
    service: &LocalWtsService,
    conversation: &AgentConversation,
    request: &SendAgentConversationMessageRequest,
) -> Result<(), LocalWtsError> {
    let AgentConversationSource::WorkItem {
        work_set_id,
        task_id,
        ..
    } = &conversation.source
    else {
        return Ok(());
    };
    let set = read_set(&service.inner.agent_conversations, *work_set_id)?;
    let task = set
        .view
        .tasks
        .iter()
        .find(|task| task.task_id == *task_id)
        .ok_or(LocalWtsError::AgentConversationConflict)?;
    if task.conversation_id != conversation.conversation_id
        || task.workspace_id != Some(conversation.workspace_id)
        || task.repository_id.as_ref() != Some(&conversation.repository_id)
        || request.request_id != task.request_id
        || request.body != task.prompt
        || terminal(task.state)
    {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    Ok(())
}

fn write_input(path: &Path, input: &PreparedInput) -> Result<(), LocalWtsError> {
    let bytes =
        serde_json::to_vec(input).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(LocalWtsError::AgentConversationStorageFull);
    }
    turn_changes::write_private(path, &bytes)
}

fn bounded_detail(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars().filter(|character| *character != '\0') {
        if result.len() + character.len_utf8() > 2048 {
            break;
        }
        result.push(character);
    }
    result
}
