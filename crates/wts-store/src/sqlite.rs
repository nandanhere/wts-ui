use crate::model::{
    ConfirmStoredWorkItemLinkResult, CreateWorkspaceResult, MAX_REVIEW_COMMENT_BYTES,
    MAX_REVIEW_THREADS_PER_WORKSPACE, MAX_WORK_ITEM_BROWSER_URL_BYTES, MAX_WORK_ITEM_CONTENT_BYTES,
    MAX_WORK_ITEM_ISSUE_KEY_BYTES, MAX_WORK_ITEM_STATUS_BYTES, MAX_WORK_ITEM_SUMMARY_BYTES,
    ObservedWorkItem, StoredReviewAuthor, StoredReviewComment, StoredReviewTarget,
    StoredReviewThread, StoredReviewThreadState, StoredWorkItemProvider, StoredWorkItemRole,
    StoredWorkItemSnapshot, StoredWorkItemUnlinkResult, StoredWorkspaceWorkItemLink,
    TombstoneWorkspaceResult, WORKSPACE_RECORD_SCHEMA_VERSION, WORKSPACE_RECORD_VERSION,
    WorkspaceBoardPlacementMode, WorkspaceBoardPlacementSummary, WorkspaceLifecycleSummary,
    WorkspaceList, WorkspaceRecord, WorkspaceRepositoryPlan, WorkspaceTombstone, WorkspaceView,
    WorkspaceWorkflowSummary,
};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use uuid::Uuid;
use wts_core::workspace::{
    CreateWorkspaceRequest, FollowWorkspaceAgentRequest, PlaceWorkspaceOnBoardRequest,
    RenameWorkspaceRequest, TransitionWorkspaceWorkflowRequest, WorkspaceIntent,
    WorkspaceMaterializationState, WorkspacePhase, WorkspaceRepositoryRequest,
    WorkspaceValidationError, WorkspaceWorkflowState,
};

const DATABASE_FILE_NAME: &str = "wts-v1.sqlite3";
const STORE_SCHEMA_VERSION: i64 = 11;
// Covers the complete, bounded core contract (32 repositories plus 32
// services with eight configured ports each), including store-owned UUIDs and
// worktree leaves. This is intentionally larger than the HTTP body limit
// because the native transport has no equivalent request envelope.
const MAX_RECORD_JSON_BYTES: usize = 256 * 1024;
const MAX_TOMBSTONE_RESULT_JSON_BYTES: usize = 64 * 1024;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const CREATE_EVENT_TYPE: &str = "workspace.created.v1";
const TOMBSTONE_EVENT_TYPE: &str = "workspace.removed.v1";
const WORKFLOW_EVENT_TYPE: &str = "workspace.workflow-transitioned.v1";
const BOARD_PLACED_EVENT_TYPE: &str = "workspace.board-placed.v1";
const BOARD_FOLLOW_AGENT_EVENT_TYPE: &str = "workspace.board-follow-agent.v1";
const BOARD_AUTO_TRANSITIONED_EVENT_TYPE: &str = "workspace.board-auto-transitioned.v1";
const WORK_ITEM_LINKED_EVENT_TYPE: &str = "workspace.work-item-linked.v1";
const WORK_ITEM_UNLINKED_EVENT_TYPE: &str = "workspace.work-item-unlinked.v1";

#[derive(Debug, Error)]
pub enum WorkspaceStoreError {
    #[error("WTS data directory must be an absolute path")]
    DataDirectoryMustBeAbsolute,
    #[error("workspace root must be an absolute path")]
    WorkspaceRootMustBeAbsolute,
    #[error("workspace root may not contain parent-directory components")]
    InvalidWorkspaceRoot,
    #[error("workspace root must be valid UTF-8")]
    NonUtf8WorkspaceRoot,
    #[error("workspace root identifier is invalid")]
    InvalidWorkspaceRootId,
    #[error("idempotency key must be a non-nil UUID")]
    InvalidIdempotencyKey,
    #[error("idempotency key was already used for another workspace request")]
    IdempotencyConflict { idempotency_key: Uuid },
    #[error("workspace removal idempotency key was already used for another request")]
    TombstoneIdempotencyConflict { idempotency_key: Uuid },
    #[error("workspace has already been removed")]
    WorkspaceAlreadyTombstoned { workspace_id: Uuid },
    #[error("workspace was not found")]
    WorkspaceNotFound { workspace_id: Uuid },
    #[error("workspace workflow revision changed")]
    WorkspaceWorkflowConflict { expected: u64, actual: u64 },
    #[error("workspace board placement is invalid")]
    InvalidWorkspaceBoardPlacement,
    #[error("workspace review thread is invalid")]
    InvalidReviewThread,
    #[error("workspace review comment exceeds the store limit")]
    ReviewCommentTooLarge,
    #[error("workspace review thread was not found")]
    ReviewThreadNotFound { thread_id: Uuid },
    #[error("workspace review thread revision changed")]
    ReviewThreadConflict { expected: u64, actual: u64 },
    #[error("workspace work-item link is invalid")]
    InvalidWorkItemLink,
    #[error("workspace work-item link confirmation is stale")]
    StaleWorkItemLinkPreview,
    #[error("workspace work-item link idempotency key was already used for another request")]
    WorkItemLinkIdempotencyConflict { idempotency_key: Uuid },
    #[error("workspace already has this work-item link")]
    WorkItemLinkAlreadyExists,
    #[error("workspace already has a primary work-item link")]
    PrimaryWorkItemLinkAlreadyExists,
    #[error("workspace work-item link was not found")]
    WorkItemLinkNotFound { link_id: Uuid },
    #[error("workspace work-item link revision changed")]
    WorkItemLinkConflict { expected: u64, actual: u64 },
    #[error("workspace removal effect digest is invalid")]
    InvalidEffectDigest,
    #[error("workspace store schema version {found} is newer than this application supports")]
    UnsupportedSchemaVersion { found: i64 },
    #[error("workspace record is corrupt: {0}")]
    CorruptRecord(String),
    #[error("workspace record belongs to an unavailable root: {0}")]
    UnknownWorkspaceRoot(String),
    #[error("system clock is before the Unix epoch")]
    InvalidSystemClock,
    #[error(transparent)]
    Validation(#[from] WorkspaceValidationError),
    #[error("workspace store filesystem operation failed")]
    Io(#[source] std::io::Error),
    #[error("workspace store database operation failed")]
    Database(#[source] rusqlite::Error),
    #[error("workspace store serialization failed")]
    Serialization(#[source] serde_json::Error),
}

impl From<std::io::Error> for WorkspaceStoreError {
    fn from(source: std::io::Error) -> Self {
        Self::Io(source)
    }
}

impl From<rusqlite::Error> for WorkspaceStoreError {
    fn from(source: rusqlite::Error) -> Self {
        Self::Database(source)
    }
}

impl From<serde_json::Error> for WorkspaceStoreError {
    fn from(source: serde_json::Error) -> Self {
        Self::Serialization(source)
    }
}

#[derive(Clone, Debug)]
struct WorkspaceRoot {
    id: String,
    path: PathBuf,
    display_path: String,
}

impl WorkspaceRoot {
    fn new(id: String, path: PathBuf) -> Result<Self, WorkspaceStoreError> {
        if !valid_root_id(&id) {
            return Err(WorkspaceStoreError::InvalidWorkspaceRootId);
        }
        if !path.is_absolute() {
            return Err(WorkspaceStoreError::WorkspaceRootMustBeAbsolute);
        }
        if path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(WorkspaceStoreError::InvalidWorkspaceRoot);
        }
        let display_path = path
            .to_str()
            .ok_or(WorkspaceStoreError::NonUtf8WorkspaceRoot)?
            .to_owned();
        Ok(Self {
            id,
            path,
            display_path,
        })
    }
}

#[derive(Clone, Debug)]
struct StoreInner {
    database_path: PathBuf,
    workspace_root: WorkspaceRoot,
}

#[derive(Clone, Debug)]
pub struct WorkspaceStore {
    inner: Arc<StoreInner>,
}

#[derive(Clone, Debug)]
pub struct WorkspaceService {
    store: WorkspaceStore,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCreatedEvent<'a> {
    schema_version: u32,
    event_id: Uuid,
    event_type: &'static str,
    idempotency_key: Uuid,
    request_digest: &'a str,
    workspace: &'a WorkspaceRecord,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceTombstoneEvent<'a> {
    schema_version: u32,
    event_id: Uuid,
    event_type: &'static str,
    workspace_id: Uuid,
    idempotency_key: Uuid,
    effect_digest: &'a str,
    removed_at_unix_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceWorkflowEvent {
    schema_version: u32,
    event_id: Uuid,
    event_type: &'static str,
    workspace_id: Uuid,
    from_state: WorkspaceWorkflowState,
    to_state: WorkspaceWorkflowState,
    workflow_revision: u64,
    created_at_unix_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBoardPlacementEvent {
    schema_version: u32,
    event_id: Uuid,
    event_type: &'static str,
    workspace_id: Uuid,
    from_state: WorkspaceWorkflowState,
    to_state: WorkspaceWorkflowState,
    from_mode: WorkspaceBoardPlacementMode,
    to_mode: WorkspaceBoardPlacementMode,
    from_rank: u64,
    to_rank: u64,
    workflow_revision: u64,
    created_at_unix_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceWorkItemLinkedEvent<'a> {
    schema_version: u32,
    event_id: Uuid,
    event_type: &'static str,
    link: &'a StoredWorkspaceWorkItemLink,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceWorkItemUnlinkedEvent<'a> {
    schema_version: u32,
    event_id: Uuid,
    event_type: &'static str,
    workspace_id: Uuid,
    link_id: Uuid,
    removed_revision: u64,
    issue_key: &'a str,
    created_at_unix_ms: i64,
}

impl WorkspaceStore {
    pub fn open(
        data_dir: impl AsRef<Path>,
        workspace_root_id: impl Into<String>,
        workspace_root_path: impl AsRef<Path>,
    ) -> Result<Self, WorkspaceStoreError> {
        let data_dir = data_dir.as_ref();
        if !data_dir.is_absolute() {
            return Err(WorkspaceStoreError::DataDirectoryMustBeAbsolute);
        }
        fs::create_dir_all(data_dir)?;
        set_private_directory_permissions(data_dir)?;
        let data_dir = data_dir.canonicalize()?;

        let workspace_root = WorkspaceRoot::new(
            workspace_root_id.into(),
            workspace_root_path.as_ref().to_path_buf(),
        )?;
        let database_path = data_dir.join(DATABASE_FILE_NAME);
        let store = Self {
            inner: Arc::new(StoreInner {
                database_path,
                workspace_root,
            }),
        };
        store.initialize()?;
        Ok(store)
    }

    pub fn list(&self) -> Result<WorkspaceList, WorkspaceStoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT workspace.workspace_id, workspace.record_version,
                    workspace.record_json, workspace.updated_at_unix_ms,
                    length(workspace.record_json),
                    lifecycle.workspace_record_version,
                    lifecycle.materialization_state,
                    lifecycle.worktree_count,
                    lifecycle.observed_at_unix_ms
             FROM workspace_projection AS workspace
             LEFT JOIN workspace_lifecycle_projection AS lifecycle
               ON lifecycle.workspace_id = workspace.workspace_id
             WHERE NOT EXISTS (
                SELECT 1 FROM workspace_tombstone_events AS tombstone
                WHERE tombstone.workspace_id = workspace.workspace_id
             )
             ORDER BY workspace.updated_at_unix_ms DESC,
                      workspace.workspace_id ASC",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(RawProjection {
                    workspace_id: row.get(0)?,
                    record_version: row.get(1)?,
                    record_json: row.get(2)?,
                    updated_at_unix_ms: row.get(3)?,
                    json_bytes: row.get(4)?,
                    lifecycle_record_version: row.get(5)?,
                    materialization_state: row.get(6)?,
                    worktree_count: row.get(7)?,
                    observed_at_unix_ms: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let workspaces = rows
            .into_iter()
            .map(|raw| {
                let decoded = decode_projection(raw)?;
                self.view(decoded.record, decoded.lifecycle)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(WorkspaceList {
            workspace_root_id: self.inner.workspace_root.id.clone(),
            workspace_root_display_path: self.inner.workspace_root.display_path.clone(),
            workspaces,
        })
    }

    pub fn get(&self, workspace_id: Uuid) -> Result<Option<WorkspaceView>, WorkspaceStoreError> {
        let connection = self.connection()?;
        load_projection(&connection, &workspace_id.to_string())?
            .map(|decoded| self.view(decoded.record, decoded.lifecycle))
            .transpose()
    }

    pub fn transition_workflow(
        &self,
        workspace_id: Uuid,
        request: TransitionWorkspaceWorkflowRequest,
    ) -> Result<WorkspaceWorkflowSummary, WorkspaceStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if load_projection(&transaction, &workspace_id.to_string())?.is_none() {
            return Err(WorkspaceStoreError::WorkspaceNotFound { workspace_id });
        }
        let current = load_workflow(&transaction, workspace_id)?;
        if request.expected_revision != current.revision {
            return Err(WorkspaceStoreError::WorkspaceWorkflowConflict {
                expected: request.expected_revision,
                actual: current.revision,
            });
        }
        if current.placement.mode == WorkspaceBoardPlacementMode::Pinned
            || request.state == current.state
        {
            transaction.commit()?;
            return Ok(current);
        }

        let updated_at_unix_ms = unix_time_ms()?;
        if current.state != request.state {
            let source = load_lane_workspace_ids(&transaction, current.state, Some(workspace_id))?;
            apply_lane_order(&transaction, &source, updated_at_unix_ms)?;
        }
        let mut target = load_lane_workspace_ids(&transaction, request.state, Some(workspace_id))?;
        target.push(workspace_id);
        apply_lane_order(&transaction, &target, updated_at_unix_ms)?;
        let target_rank = u64::try_from(target.len() - 1).map_err(|_| {
            WorkspaceStoreError::CorruptRecord("workspace board rank overflowed".into())
        })?;
        let summary = persist_workflow_change(
            &transaction,
            workspace_id,
            &current,
            request.state,
            WorkspaceBoardPlacementMode::Automatic,
            target_rank,
            BOARD_AUTO_TRANSITIONED_EVENT_TYPE,
            updated_at_unix_ms,
        )?;
        transaction.commit()?;
        Ok(summary)
    }

    pub fn place_workspace_on_board(
        &self,
        workspace_id: Uuid,
        request: PlaceWorkspaceOnBoardRequest,
    ) -> Result<WorkspaceWorkflowSummary, WorkspaceStoreError> {
        if request.before_workspace_id.is_some() && request.after_workspace_id.is_some() {
            return Err(WorkspaceStoreError::InvalidWorkspaceBoardPlacement);
        }
        let anchor = request.before_workspace_id.or(request.after_workspace_id);
        if anchor.is_some_and(|anchor| anchor.is_nil() || anchor == workspace_id) {
            return Err(WorkspaceStoreError::InvalidWorkspaceBoardPlacement);
        }

        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if load_projection(&transaction, &workspace_id.to_string())?.is_none() {
            return Err(WorkspaceStoreError::WorkspaceNotFound { workspace_id });
        }
        let current = load_workflow(&transaction, workspace_id)?;
        if request.expected_revision != current.revision {
            return Err(WorkspaceStoreError::WorkspaceWorkflowConflict {
                expected: request.expected_revision,
                actual: current.revision,
            });
        }

        let mut target = load_lane_workspace_ids(&transaction, request.state, Some(workspace_id))?;
        let insertion_index = match anchor {
            Some(anchor) => {
                let index = target
                    .iter()
                    .position(|candidate| *candidate == anchor)
                    .ok_or(WorkspaceStoreError::InvalidWorkspaceBoardPlacement)?;
                if request.after_workspace_id.is_some() {
                    index + 1
                } else {
                    index
                }
            }
            None => target.len(),
        };
        target.insert(insertion_index, workspace_id);

        let updated_at_unix_ms = unix_time_ms()?;
        if current.state != request.state {
            let source = load_lane_workspace_ids(&transaction, current.state, Some(workspace_id))?;
            apply_lane_order(&transaction, &source, updated_at_unix_ms)?;
        }
        apply_lane_order(&transaction, &target, updated_at_unix_ms)?;
        let target_rank = u64::try_from(insertion_index).map_err(|_| {
            WorkspaceStoreError::CorruptRecord("workspace board rank overflowed".into())
        })?;
        let summary = persist_workflow_change(
            &transaction,
            workspace_id,
            &current,
            request.state,
            WorkspaceBoardPlacementMode::Pinned,
            target_rank,
            BOARD_PLACED_EVENT_TYPE,
            updated_at_unix_ms,
        )?;
        transaction.commit()?;
        Ok(summary)
    }

    pub fn follow_workspace_agent(
        &self,
        workspace_id: Uuid,
        request: FollowWorkspaceAgentRequest,
    ) -> Result<WorkspaceWorkflowSummary, WorkspaceStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if load_projection(&transaction, &workspace_id.to_string())?.is_none() {
            return Err(WorkspaceStoreError::WorkspaceNotFound { workspace_id });
        }
        let current = load_workflow(&transaction, workspace_id)?;
        if request.expected_revision != current.revision {
            return Err(WorkspaceStoreError::WorkspaceWorkflowConflict {
                expected: request.expected_revision,
                actual: current.revision,
            });
        }
        if current.placement.mode == WorkspaceBoardPlacementMode::Automatic {
            transaction.commit()?;
            return Ok(current);
        }
        let updated_at_unix_ms = unix_time_ms()?;
        let summary = persist_workflow_change(
            &transaction,
            workspace_id,
            &current,
            current.state,
            WorkspaceBoardPlacementMode::Automatic,
            current.placement.rank,
            BOARD_FOLLOW_AGENT_EVENT_TYPE,
            updated_at_unix_ms,
        )?;
        transaction.commit()?;
        Ok(summary)
    }

    pub fn confirm_work_item_link(
        &self,
        workspace_id: Uuid,
        idempotency_key: &str,
        preview_digest: &str,
        provider: StoredWorkItemProvider,
        role: StoredWorkItemRole,
        snapshot: StoredWorkItemSnapshot,
    ) -> Result<ConfirmStoredWorkItemLinkResult, WorkspaceStoreError> {
        let idempotency_key = parse_idempotency_key(idempotency_key)?;
        validate_sha256_digest(preview_digest)
            .map_err(|_| WorkspaceStoreError::StaleWorkItemLinkPreview)?;
        validate_work_item_snapshot(&snapshot)?;

        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if load_projection(&transaction, &workspace_id.to_string())?.is_none() {
            return Err(WorkspaceStoreError::WorkspaceNotFound { workspace_id });
        }
        if let Some((stored_workspace_id, stored_digest, result_json)) = transaction
            .query_row(
                "SELECT workspace_id, preview_digest, result_json
                 FROM workspace_work_item_link_confirmations
                 WHERE idempotency_key = ?1",
                [idempotency_key.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
        {
            if stored_workspace_id != workspace_id.to_string() || stored_digest != preview_digest {
                return Err(WorkspaceStoreError::WorkItemLinkIdempotencyConflict {
                    idempotency_key,
                });
            }
            let link: StoredWorkspaceWorkItemLink = serde_json::from_str(&result_json)
                .map_err(|error| WorkspaceStoreError::CorruptRecord(error.to_string()))?;
            validate_work_item_link(&link)?;
            transaction.commit()?;
            return Ok(ConfirmStoredWorkItemLinkResult {
                link,
                replayed: true,
            });
        }

        if load_work_item_link_by_issue(&transaction, workspace_id, provider, &snapshot.issue_key)?
            .is_some()
        {
            return Err(WorkspaceStoreError::WorkItemLinkAlreadyExists);
        }
        if role == StoredWorkItemRole::Primary
            && transaction.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM workspace_work_item_links
                    WHERE workspace_id = ?1 AND role = 'primary'
                 )",
                [workspace_id.to_string()],
                |row| row.get::<_, bool>(0),
            )?
        {
            return Err(WorkspaceStoreError::PrimaryWorkItemLinkAlreadyExists);
        }

        let link_id = Uuid::new_v4();
        let created_at_unix_ms = unix_time_ms()?;
        let link = StoredWorkspaceWorkItemLink {
            link_id,
            workspace_id,
            provider,
            role,
            snapshot,
            revision: 1,
            created_at_unix_ms,
            updated_at_unix_ms: created_at_unix_ms,
        };
        validate_work_item_link(&link)?;
        transaction.execute(
            "INSERT INTO workspace_work_item_links (
                link_id, workspace_id, provider, issue_key, role, summary, status,
                content, browser_url, fetched_at_unix_ms, revision,
                created_at_unix_ms, updated_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11)",
            params![
                link.link_id.to_string(),
                workspace_id.to_string(),
                work_item_provider_storage(provider),
                link.snapshot.issue_key,
                work_item_role_storage(role),
                link.snapshot.summary,
                link.snapshot.status,
                link.snapshot.content,
                link.snapshot.browser_url,
                link.snapshot.fetched_at_unix_ms,
                created_at_unix_ms,
            ],
        )?;
        let event_id = Uuid::new_v4();
        let event_json = serde_json::to_string(&WorkspaceWorkItemLinkedEvent {
            schema_version: 1,
            event_id,
            event_type: WORK_ITEM_LINKED_EVENT_TYPE,
            link: &link,
        })?;
        transaction.execute(
            "INSERT INTO workspace_work_item_link_events (
                event_id, workspace_id, link_id, event_type, link_revision,
                event_json, created_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
            params![
                event_id.to_string(),
                workspace_id.to_string(),
                link.link_id.to_string(),
                WORK_ITEM_LINKED_EVENT_TYPE,
                event_json,
                created_at_unix_ms,
            ],
        )?;
        let result_json = serde_json::to_string(&link)?;
        transaction.execute(
            "INSERT INTO workspace_work_item_link_confirmations (
                idempotency_key, workspace_id, preview_digest, result_json,
                created_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                idempotency_key.to_string(),
                workspace_id.to_string(),
                preview_digest,
                result_json,
                created_at_unix_ms,
            ],
        )?;
        transaction.commit()?;
        Ok(ConfirmStoredWorkItemLinkResult {
            link,
            replayed: false,
        })
    }

    pub fn confirmed_work_item_link_replay(
        &self,
        workspace_id: Uuid,
        idempotency_key: &str,
        preview_digest: &str,
    ) -> Result<Option<ConfirmStoredWorkItemLinkResult>, WorkspaceStoreError> {
        let idempotency_key = parse_idempotency_key(idempotency_key)?;
        validate_sha256_digest(preview_digest)
            .map_err(|_| WorkspaceStoreError::StaleWorkItemLinkPreview)?;
        let connection = self.connection()?;
        let Some((stored_workspace_id, stored_digest, result_json)) = connection
            .query_row(
                "SELECT workspace_id, preview_digest, result_json
                 FROM workspace_work_item_link_confirmations
                 WHERE idempotency_key = ?1",
                [idempotency_key.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
        else {
            return Ok(None);
        };
        if stored_workspace_id != workspace_id.to_string() || stored_digest != preview_digest {
            return Err(WorkspaceStoreError::WorkItemLinkIdempotencyConflict { idempotency_key });
        }
        let link: StoredWorkspaceWorkItemLink = serde_json::from_str(&result_json)
            .map_err(|error| WorkspaceStoreError::CorruptRecord(error.to_string()))?;
        validate_work_item_link(&link)?;
        Ok(Some(ConfirmStoredWorkItemLinkResult {
            link,
            replayed: true,
        }))
    }

    pub fn list_work_item_links(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<StoredWorkspaceWorkItemLink>, WorkspaceStoreError> {
        let connection = self.connection()?;
        if load_projection(&connection, &workspace_id.to_string())?.is_none() {
            return Err(WorkspaceStoreError::WorkspaceNotFound { workspace_id });
        }
        load_work_item_links(&connection, workspace_id)
    }

    pub fn unlink_work_item_link(
        &self,
        workspace_id: Uuid,
        link_id: Uuid,
        expected_revision: u64,
    ) -> Result<StoredWorkItemUnlinkResult, WorkspaceStoreError> {
        if expected_revision == 0 {
            return Err(WorkspaceStoreError::InvalidWorkItemLink);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if load_projection(&transaction, &workspace_id.to_string())?.is_none() {
            return Err(WorkspaceStoreError::WorkspaceNotFound { workspace_id });
        }
        let link = load_work_item_link(&transaction, workspace_id, link_id)?
            .ok_or(WorkspaceStoreError::WorkItemLinkNotFound { link_id })?;
        if link.revision != expected_revision {
            return Err(WorkspaceStoreError::WorkItemLinkConflict {
                expected: expected_revision,
                actual: link.revision,
            });
        }
        let changed = transaction.execute(
            "DELETE FROM workspace_work_item_links
             WHERE workspace_id = ?1 AND link_id = ?2 AND revision = ?3",
            params![
                workspace_id.to_string(),
                link_id.to_string(),
                i64::try_from(expected_revision)
                    .map_err(|_| WorkspaceStoreError::InvalidWorkItemLink)?,
            ],
        )?;
        if changed != 1 {
            return Err(WorkspaceStoreError::WorkItemLinkConflict {
                expected: expected_revision,
                actual: link.revision,
            });
        }
        let created_at_unix_ms = unix_time_ms()?;
        let event_id = Uuid::new_v4();
        let event_json = serde_json::to_string(&WorkspaceWorkItemUnlinkedEvent {
            schema_version: 1,
            event_id,
            event_type: WORK_ITEM_UNLINKED_EVENT_TYPE,
            workspace_id,
            link_id,
            removed_revision: link.revision,
            issue_key: &link.snapshot.issue_key,
            created_at_unix_ms,
        })?;
        transaction.execute(
            "INSERT INTO workspace_work_item_link_events (
                event_id, workspace_id, link_id, event_type, link_revision,
                event_json, created_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event_id.to_string(),
                workspace_id.to_string(),
                link_id.to_string(),
                WORK_ITEM_UNLINKED_EVENT_TYPE,
                i64::try_from(link.revision)
                    .map_err(|_| WorkspaceStoreError::InvalidWorkItemLink)?,
                event_json,
                created_at_unix_ms,
            ],
        )?;
        transaction.commit()?;
        Ok(StoredWorkItemUnlinkResult {
            workspace_id,
            link_id,
            removed_revision: link.revision,
        })
    }

    pub fn list_review_threads(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<StoredReviewThread>, WorkspaceStoreError> {
        let connection = self.connection()?;
        if load_projection(&connection, &workspace_id.to_string())?.is_none() {
            return Err(WorkspaceStoreError::WorkspaceNotFound { workspace_id });
        }
        let mut threads = load_review_threads(&connection, workspace_id)?;
        threads.extend(load_verification_review_threads(&connection, workspace_id)?);
        threads.extend(load_code_review_threads(&connection, workspace_id)?);
        threads.sort_by(|left, right| {
            right
                .updated_at_unix_ms
                .cmp(&left.updated_at_unix_ms)
                .then_with(|| left.thread_id.cmp(&right.thread_id))
        });
        Ok(threads)
    }

    pub fn create_review_thread(
        &self,
        workspace_id: Uuid,
        target: StoredReviewTarget,
        author: StoredReviewAuthor,
        body: &str,
    ) -> Result<StoredReviewThread, WorkspaceStoreError> {
        validate_review_target(&target)?;
        let body = normalize_review_body(body)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if load_projection(&transaction, &workspace_id.to_string())?.is_none() {
            return Err(WorkspaceStoreError::WorkspaceNotFound { workspace_id });
        }
        let thread_count: i64 = transaction.query_row(
            "SELECT
                (SELECT count(*) FROM workspace_review_threads WHERE workspace_id = ?1)
                +
                (SELECT count(*) FROM workspace_verification_review_threads WHERE workspace_id = ?1)
                +
                (SELECT count(*) FROM workspace_code_review_threads WHERE workspace_id = ?1)",
            [workspace_id.to_string()],
            |row| row.get(0),
        )?;
        if usize::try_from(thread_count).unwrap_or(usize::MAX) >= MAX_REVIEW_THREADS_PER_WORKSPACE {
            return Err(WorkspaceStoreError::InvalidReviewThread);
        }

        let thread_id = Uuid::new_v4();
        let comment_id = Uuid::new_v4();
        let created_at_unix_ms = unix_time_ms()?;
        match &target {
            StoredReviewTarget::PlanningDocument {
                document_id,
                document_sha256,
                line,
            } => {
                transaction.execute(
                    "INSERT INTO workspace_review_threads (
                        thread_id, workspace_id, target_kind, target_document_id,
                        target_document_sha256, target_line, state, revision,
                        created_at_unix_ms, updated_at_unix_ms, resolved_at_unix_ms
                     ) VALUES (?1, ?2, 'planning_document', ?3, ?4, ?5, 'open', 1, ?6, ?6, NULL)",
                    params![
                        thread_id.to_string(),
                        workspace_id.to_string(),
                        document_id,
                        document_sha256,
                        line.map(i64::from),
                        created_at_unix_ms,
                    ],
                )?;
                transaction.execute(
                    "INSERT INTO workspace_review_comments (
                        comment_id, thread_id, author, body, created_at_unix_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        comment_id.to_string(),
                        thread_id.to_string(),
                        review_author_storage(author),
                        body,
                        created_at_unix_ms,
                    ],
                )?;
            }
            StoredReviewTarget::VerificationCheck {
                plan_revision,
                completed_at_unix_ms,
                check_id,
            } => {
                transaction.execute(
                    "INSERT INTO workspace_verification_review_threads (
                        thread_id, workspace_id, target_kind, target_plan_revision,
                        target_completed_at_unix_ms, target_check_id, state, revision,
                        created_at_unix_ms, updated_at_unix_ms, resolved_at_unix_ms
                     ) VALUES (?1, ?2, 'verification_check', ?3, ?4, ?5, 'open', 1, ?6, ?6, NULL)",
                    params![
                        thread_id.to_string(),
                        workspace_id.to_string(),
                        i64::try_from(*plan_revision)
                            .map_err(|_| WorkspaceStoreError::InvalidReviewThread)?,
                        completed_at_unix_ms,
                        check_id,
                        created_at_unix_ms,
                    ],
                )?;
                transaction.execute(
                    "INSERT INTO workspace_verification_review_comments (
                        comment_id, thread_id, author, body, created_at_unix_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        comment_id.to_string(),
                        thread_id.to_string(),
                        review_author_storage(author),
                        body,
                        created_at_unix_ms,
                    ],
                )?;
            }
            StoredReviewTarget::CodeChange {
                repository_id,
                base_commit_oid,
                head_commit_oid,
                patch_sha256,
                file_path,
                side,
                line,
            } => {
                transaction.execute(
                    "INSERT INTO workspace_code_review_threads (
                        thread_id, workspace_id, target_kind, target_repository_id,
                        target_base_commit_oid, target_head_commit_oid, target_patch_sha256,
                        target_file_path, target_side, target_line, state, revision,
                        created_at_unix_ms, updated_at_unix_ms, resolved_at_unix_ms
                     ) VALUES (?1, ?2, 'code_change', ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                               'open', 1, ?10, ?10, NULL)",
                    params![
                        thread_id.to_string(),
                        workspace_id.to_string(),
                        repository_id,
                        base_commit_oid,
                        head_commit_oid,
                        patch_sha256,
                        file_path,
                        side,
                        i64::from(*line),
                        created_at_unix_ms,
                    ],
                )?;
                transaction.execute(
                    "INSERT INTO workspace_code_review_comments (
                        comment_id, thread_id, author, body, created_at_unix_ms
                     ) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        comment_id.to_string(),
                        thread_id.to_string(),
                        review_author_storage(author),
                        body,
                        created_at_unix_ms,
                    ],
                )?;
            }
        }
        transaction.commit()?;
        Ok(StoredReviewThread {
            thread_id,
            workspace_id,
            target,
            state: StoredReviewThreadState::Open,
            revision: 1,
            comments: vec![StoredReviewComment {
                comment_id,
                author,
                body,
                created_at_unix_ms,
            }],
            created_at_unix_ms,
            updated_at_unix_ms: created_at_unix_ms,
            resolved_at_unix_ms: None,
        })
    }

    pub fn resolve_review_thread(
        &self,
        workspace_id: Uuid,
        thread_id: Uuid,
        expected_revision: u64,
    ) -> Result<StoredReviewThread, WorkspaceStoreError> {
        if expected_revision == 0 {
            return Err(WorkspaceStoreError::InvalidReviewThread);
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if load_projection(&transaction, &workspace_id.to_string())?.is_none() {
            return Err(WorkspaceStoreError::WorkspaceNotFound { workspace_id });
        }
        let planning = load_review_thread(&transaction, workspace_id, thread_id)?;
        let verification = load_verification_review_thread(&transaction, workspace_id, thread_id)?;
        let code = load_code_review_thread(&transaction, workspace_id, thread_id)?;
        if usize::from(planning.is_some())
            + usize::from(verification.is_some())
            + usize::from(code.is_some())
            > 1
        {
            return Err(WorkspaceStoreError::CorruptRecord(
                "workspace review thread identifier is ambiguous".into(),
            ));
        }
        let current = planning
            .or(verification)
            .or(code)
            .ok_or(WorkspaceStoreError::ReviewThreadNotFound { thread_id })?;
        if current.revision != expected_revision {
            return Err(WorkspaceStoreError::ReviewThreadConflict {
                expected: expected_revision,
                actual: current.revision,
            });
        }
        if current.state == StoredReviewThreadState::Resolved {
            transaction.commit()?;
            return Ok(current);
        }
        let revision = current
            .revision
            .checked_add(1)
            .ok_or(WorkspaceStoreError::InvalidReviewThread)?;
        let updated_at_unix_ms = unix_time_ms()?;
        let revision_storage =
            i64::try_from(revision).map_err(|_| WorkspaceStoreError::InvalidReviewThread)?;
        let expected_revision_storage = i64::try_from(expected_revision)
            .map_err(|_| WorkspaceStoreError::InvalidReviewThread)?;
        let parameters = params![
            revision_storage,
            updated_at_unix_ms,
            workspace_id.to_string(),
            thread_id.to_string(),
            expected_revision_storage,
        ];
        let changed = match &current.target {
            StoredReviewTarget::PlanningDocument { .. } => transaction.execute(
                "UPDATE workspace_review_threads
                 SET state = 'resolved', revision = ?1, updated_at_unix_ms = ?2,
                     resolved_at_unix_ms = ?2
                 WHERE workspace_id = ?3 AND thread_id = ?4 AND revision = ?5",
                parameters,
            )?,
            StoredReviewTarget::VerificationCheck { .. } => transaction.execute(
                "UPDATE workspace_verification_review_threads
                 SET state = 'resolved', revision = ?1, updated_at_unix_ms = ?2,
                     resolved_at_unix_ms = ?2
                 WHERE workspace_id = ?3 AND thread_id = ?4 AND revision = ?5",
                parameters,
            )?,
            StoredReviewTarget::CodeChange { .. } => transaction.execute(
                "UPDATE workspace_code_review_threads
                 SET state = 'resolved', revision = ?1, updated_at_unix_ms = ?2,
                     resolved_at_unix_ms = ?2
                 WHERE workspace_id = ?3 AND thread_id = ?4 AND revision = ?5",
                parameters,
            )?,
        };
        if changed != 1 {
            return Err(WorkspaceStoreError::ReviewThreadConflict {
                expected: expected_revision,
                actual: current.revision,
            });
        }
        transaction.commit()?;
        Ok(StoredReviewThread {
            state: StoredReviewThreadState::Resolved,
            revision,
            updated_at_unix_ms,
            resolved_at_unix_ms: Some(updated_at_unix_ms),
            ..current
        })
    }

    pub fn replace_observed_work_items(
        &self,
        workspace_id: Uuid,
        observations: &[ObservedWorkItem],
    ) -> Result<Vec<ObservedWorkItem>, WorkspaceStoreError> {
        validate_observed_work_items(observations)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if load_projection(&transaction, &workspace_id.to_string())?.is_none() {
            return Err(WorkspaceStoreError::WorkspaceNotFound { workspace_id });
        }
        transaction.execute(
            "DELETE FROM workspace_work_item_observations WHERE workspace_id = ?1",
            [workspace_id.to_string()],
        )?;
        for observation in observations {
            for source_file in &observation.source_files {
                transaction.execute(
                    "INSERT INTO workspace_work_item_observations (
                        workspace_id, issue_key, source_file, observed_at_unix_ms
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        workspace_id.to_string(),
                        observation.issue_key,
                        source_file,
                        observation.observed_at_unix_ms,
                    ],
                )?;
            }
        }
        transaction.commit()?;
        let connection = self.connection()?;
        load_observed_work_items(&connection, workspace_id)
    }

    pub fn repositories_observed_for_issue(
        &self,
        issue_key: &str,
    ) -> Result<Vec<String>, WorkspaceStoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT DISTINCT json_extract(repository.value, '$.repositoryId')
             FROM workspace_work_item_observations AS observation
             JOIN workspace_projection AS workspace
               ON workspace.workspace_id = observation.workspace_id
             JOIN json_each(workspace.record_json, '$.repositories') AS repository
             WHERE observation.issue_key = ?1
               AND json_extract(repository.value, '$.repositoryId') IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM workspace_tombstone_events AS tombstone
                   WHERE tombstone.workspace_id = workspace.workspace_id
               )
             ORDER BY 1",
        )?;
        statement
            .query_map([issue_key], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn rename(
        &self,
        workspace_id: Uuid,
        request: RenameWorkspaceRequest,
    ) -> Result<WorkspaceView, WorkspaceStoreError> {
        let request = request.normalize()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut decoded = load_projection(&transaction, &workspace_id.to_string())?
            .ok_or(WorkspaceStoreError::WorkspaceNotFound { workspace_id })?;
        decoded.record.workspace_leaf = workspace_leaf_from_name(&request.title, workspace_id);
        decoded.record.display_name = Some(request.title);
        decoded.record.updated_at_unix_ms = unix_time_ms()?;
        validate_record(&decoded.record)?;
        let record_json = serde_json::to_string(&decoded.record)?;
        if record_json.len() > MAX_RECORD_JSON_BYTES {
            return Err(WorkspaceStoreError::CorruptRecord(
                "serialized workspace record exceeds the store limit".into(),
            ));
        }
        transaction.execute(
            "UPDATE workspace_projection
             SET record_json = ?1, updated_at_unix_ms = ?2
             WHERE workspace_id = ?3",
            params![
                record_json,
                decoded.record.updated_at_unix_ms,
                workspace_id.to_string(),
            ],
        )?;
        transaction.commit()?;
        self.view(decoded.record, decoded.lifecycle)
    }

    pub fn add_repository(
        &self,
        workspace_id: Uuid,
        repository: WorkspaceRepositoryRequest,
    ) -> Result<WorkspaceView, WorkspaceStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut decoded = load_projection(&transaction, &workspace_id.to_string())?
            .ok_or(WorkspaceStoreError::WorkspaceNotFound { workspace_id })?;
        let request_id = Uuid::new_v4();
        decoded.record.repositories.push(WorkspaceRepositoryPlan {
            request_id,
            repository_id: repository.repository_id,
            worktree_leaf: repository_leaf(&repository.label, request_id),
            label: repository.label,
            base_ref: repository.base_ref,
        });
        decoded.record.repositories.sort_by(|left, right| {
            left.label
                .to_lowercase()
                .cmp(&right.label.to_lowercase())
                .then(left.repository_id.cmp(&right.repository_id))
                .then(left.base_ref.cmp(&right.base_ref))
        });
        decoded.record.updated_at_unix_ms = unix_time_ms()?;
        if decoded.lifecycle.materialization_state == WorkspaceMaterializationState::Materialized {
            decoded.lifecycle.worktree_count = u32::try_from(decoded.record.repositories.len())
                .map_err(|_| {
                    WorkspaceStoreError::CorruptRecord(
                        "workspace repository count exceeds the lifecycle limit".into(),
                    )
                })?;
            decoded.lifecycle.observed_at_unix_ms = Some(decoded.record.updated_at_unix_ms);
        }
        validate_record(&decoded.record)?;
        validate_lifecycle(&decoded.record, &decoded.lifecycle)?;
        let record_json = serde_json::to_string(&decoded.record)?;
        if record_json.len() > MAX_RECORD_JSON_BYTES {
            return Err(WorkspaceStoreError::CorruptRecord(
                "serialized workspace record exceeds the store limit".into(),
            ));
        }
        transaction.execute(
            "UPDATE workspace_projection
             SET record_json = ?1, updated_at_unix_ms = ?2
             WHERE workspace_id = ?3",
            params![
                record_json,
                decoded.record.updated_at_unix_ms,
                workspace_id.to_string(),
            ],
        )?;
        if decoded.lifecycle.materialization_state == WorkspaceMaterializationState::Materialized {
            transaction.execute(
                "UPDATE workspace_lifecycle_projection
                 SET worktree_count = ?1, observed_at_unix_ms = ?2
                 WHERE workspace_id = ?3",
                params![
                    i64::from(decoded.lifecycle.worktree_count),
                    decoded.lifecycle.observed_at_unix_ms,
                    workspace_id.to_string(),
                ],
            )?;
        }
        transaction.commit()?;
        self.view(decoded.record, decoded.lifecycle)
    }

    pub fn remove_repository(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<WorkspaceView, WorkspaceStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut decoded = load_projection(&transaction, &workspace_id.to_string())?
            .ok_or(WorkspaceStoreError::WorkspaceNotFound { workspace_id })?;
        let previous_len = decoded.record.repositories.len();
        decoded
            .record
            .repositories
            .retain(|repository| repository.repository_id.as_deref() != Some(repository_id));
        if decoded.record.repositories.len() == previous_len {
            return Err(WorkspaceStoreError::WorkspaceNotFound { workspace_id });
        }
        decoded.record.updated_at_unix_ms = unix_time_ms()?;
        if decoded.lifecycle.materialization_state == WorkspaceMaterializationState::Materialized {
            decoded.lifecycle.worktree_count = u32::try_from(decoded.record.repositories.len())
                .map_err(|_| {
                    WorkspaceStoreError::CorruptRecord(
                        "workspace repository count exceeds the lifecycle limit".into(),
                    )
                })?;
            decoded.lifecycle.observed_at_unix_ms = Some(decoded.record.updated_at_unix_ms);
        }
        validate_record(&decoded.record)?;
        validate_lifecycle(&decoded.record, &decoded.lifecycle)?;
        let record_json = serde_json::to_string(&decoded.record)?;
        transaction.execute(
            "UPDATE workspace_projection SET record_json = ?1, updated_at_unix_ms = ?2 WHERE workspace_id = ?3",
            params![record_json, decoded.record.updated_at_unix_ms, workspace_id.to_string()],
        )?;
        if decoded.lifecycle.materialization_state == WorkspaceMaterializationState::Materialized {
            transaction.execute(
                "UPDATE workspace_lifecycle_projection SET worktree_count = ?1, observed_at_unix_ms = ?2 WHERE workspace_id = ?3",
                params![i64::from(decoded.lifecycle.worktree_count), decoded.lifecycle.observed_at_unix_ms, workspace_id.to_string()],
            )?;
        }
        transaction.commit()?;
        self.view(decoded.record, decoded.lifecycle)
    }

    /// Returns an already-created workspace for this exact idempotent request.
    ///
    /// This read-only check lets callers replay a successful create before they
    /// repeat external validation whose inputs may have changed since the
    /// original request completed.
    pub fn create_replay(
        &self,
        idempotency_key: &str,
        request: &CreateWorkspaceRequest,
    ) -> Result<Option<CreateWorkspaceResult>, WorkspaceStoreError> {
        let idempotency_key = parse_idempotency_key(idempotency_key)?;
        let request = request.clone().normalize()?;
        let request_json = serde_json::to_vec(&request)?;
        let request_digest = hex::encode(Sha256::digest(&request_json));
        let connection = self.connection()?;
        let replay = connection
            .query_row(
                "SELECT workspace_id, request_digest
                 FROM workspace_created_events
                 WHERE idempotency_key = ?1",
                [idempotency_key.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let Some((workspace_id, existing_digest)) = replay else {
            return Ok(None);
        };
        if existing_digest != request_digest {
            return Err(WorkspaceStoreError::IdempotencyConflict { idempotency_key });
        }
        let decoded = load_projection(&connection, &workspace_id)?.ok_or_else(|| {
            WorkspaceStoreError::CorruptRecord(
                "idempotency event has no materialized workspace".into(),
            )
        })?;
        Ok(Some(CreateWorkspaceResult {
            workspace: self.view(decoded.record, decoded.lifecycle)?,
            replayed: true,
        }))
    }

    pub fn create(
        &self,
        idempotency_key: &str,
        request: CreateWorkspaceRequest,
    ) -> Result<CreateWorkspaceResult, WorkspaceStoreError> {
        let idempotency_key = parse_idempotency_key(idempotency_key)?;
        let request = request.normalize()?;
        let request_json = serde_json::to_vec(&request)?;
        let request_digest = hex::encode(Sha256::digest(&request_json));

        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let replay = transaction
            .query_row(
                "SELECT workspace_id, request_digest
                 FROM workspace_created_events
                 WHERE idempotency_key = ?1",
                [idempotency_key.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        if let Some((workspace_id, existing_digest)) = replay {
            if existing_digest != request_digest {
                return Err(WorkspaceStoreError::IdempotencyConflict { idempotency_key });
            }
            let decoded = load_projection(&transaction, &workspace_id)?.ok_or_else(|| {
                WorkspaceStoreError::CorruptRecord(
                    "idempotency event has no materialized workspace".into(),
                )
            })?;
            transaction.commit()?;
            return Ok(CreateWorkspaceResult {
                workspace: self.view(decoded.record, decoded.lifecycle)?,
                replayed: true,
            });
        }

        let workspace_id = Uuid::new_v4();
        let timestamp = unix_time_ms()?;
        let repositories = request
            .repositories
            .iter()
            .map(|repository| {
                let request_id = Uuid::new_v4();
                WorkspaceRepositoryPlan {
                    request_id,
                    repository_id: repository.repository_id.clone(),
                    label: repository.label.clone(),
                    base_ref: repository.base_ref.clone(),
                    worktree_leaf: repository_leaf(&repository.label, request_id),
                }
            })
            .collect();
        let record = WorkspaceRecord {
            schema_version: WORKSPACE_RECORD_SCHEMA_VERSION,
            workspace_id,
            record_version: WORKSPACE_RECORD_VERSION,
            workspace_leaf: workspace_leaf(&request.intent, workspace_id),
            workspace_root_id: self.inner.workspace_root.id.clone(),
            intent: request.intent,
            title: request.title,
            display_name: None,
            preferred_provider: request.preferred_provider,
            phase: WorkspacePhase::Draft,
            repositories,
            runtime: request.runtime,
            planning: request.planning,
            created_at_unix_ms: timestamp,
            updated_at_unix_ms: timestamp,
        };
        let lifecycle = WorkspaceLifecycleSummary {
            materialization_state: WorkspaceMaterializationState::NotMaterialized,
            worktree_count: 0,
            observed_at_unix_ms: Some(timestamp),
        };
        validate_record(&record)?;
        validate_lifecycle(&record, &lifecycle)?;

        let record_json = serde_json::to_string(&record)?;
        if record_json.len() > MAX_RECORD_JSON_BYTES {
            return Err(WorkspaceStoreError::CorruptRecord(
                "serialized workspace record exceeds the store limit".into(),
            ));
        }
        let event_id = Uuid::new_v4();
        let event_json = serde_json::to_string(&WorkspaceCreatedEvent {
            schema_version: WORKSPACE_RECORD_SCHEMA_VERSION,
            event_id,
            event_type: CREATE_EVENT_TYPE,
            idempotency_key,
            request_digest: &request_digest,
            workspace: &record,
        })?;

        transaction.execute(
            "INSERT INTO workspace_created_events (
                event_id, workspace_id, record_version, event_type, event_json,
                idempotency_key, request_digest, created_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event_id.to_string(),
                workspace_id.to_string(),
                i64::try_from(record.record_version).map_err(|_| {
                    WorkspaceStoreError::CorruptRecord(
                        "record version exceeds SQLite integer range".into(),
                    )
                })?,
                CREATE_EVENT_TYPE,
                event_json,
                idempotency_key.to_string(),
                request_digest,
                timestamp,
            ],
        )?;
        transaction.execute(
            "INSERT INTO workspace_projection (
                workspace_id, record_version, record_json, updated_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                workspace_id.to_string(),
                i64::try_from(record.record_version).map_err(|_| {
                    WorkspaceStoreError::CorruptRecord(
                        "record version exceeds SQLite integer range".into(),
                    )
                })?,
                record_json,
                timestamp,
            ],
        )?;
        transaction.execute(
            "INSERT INTO workspace_lifecycle_projection (
                workspace_id, workspace_record_version, materialization_state,
                worktree_count, observed_at_unix_ms
             ) VALUES (?1, ?2, 'not_materialized', 0, ?3)",
            params![
                workspace_id.to_string(),
                i64::try_from(record.record_version).map_err(|_| {
                    WorkspaceStoreError::CorruptRecord(
                        "record version exceeds SQLite integer range".into(),
                    )
                })?,
                timestamp,
            ],
        )?;
        transaction.execute(
            "INSERT INTO workspace_workflow_projection (
                workspace_id, state, workflow_revision, updated_at_unix_ms
             ) VALUES (?1, 'ready', 1, ?2)",
            params![workspace_id.to_string(), timestamp],
        )?;
        transaction.execute(
            "INSERT INTO workspace_board_placement_projection (
                workspace_id, mode, lane_rank, updated_at_unix_ms
             )
             SELECT ?1, 'automatic', COALESCE(MAX(placement.lane_rank) + 1, 0), ?2
             FROM workspace_workflow_projection AS workflow
             JOIN workspace_board_placement_projection AS placement
               ON placement.workspace_id = workflow.workspace_id
             WHERE workflow.state = 'ready'",
            params![workspace_id.to_string(), timestamp],
        )?;
        persist_jira_intent_work_item_link(&transaction, &record)?;
        transaction.commit()?;

        Ok(CreateWorkspaceResult {
            workspace: self.view(record, lifecycle)?,
            replayed: false,
        })
    }

    /// Persist a cheap, last-known lifecycle observation.
    ///
    /// `Unknown` is reserved for migrated rows that have not yet been
    /// observed. Callers cannot persist it. This projection is intentionally
    /// not authoritative for actions; materialized workspaces must still be
    /// deeply validated by the application service.
    pub fn observe_lifecycle(
        &self,
        workspace_id: Uuid,
        materialization_state: WorkspaceMaterializationState,
        worktree_count: u32,
    ) -> Result<WorkspaceLifecycleSummary, WorkspaceStoreError> {
        if materialization_state == WorkspaceMaterializationState::Unknown {
            return Err(WorkspaceStoreError::CorruptRecord(
                "an unknown lifecycle observation cannot be persisted".into(),
            ));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let decoded =
            load_projection(&transaction, &workspace_id.to_string())?.ok_or_else(|| {
                WorkspaceStoreError::CorruptRecord(
                    "lifecycle observation refers to a missing workspace".into(),
                )
            })?;
        let observed_at_unix_ms = unix_time_ms()?;
        let lifecycle = WorkspaceLifecycleSummary {
            materialization_state,
            worktree_count,
            observed_at_unix_ms: Some(observed_at_unix_ms),
        };
        validate_lifecycle(&decoded.record, &lifecycle)?;
        transaction.execute(
            "INSERT INTO workspace_lifecycle_projection (
                workspace_id, workspace_record_version, materialization_state,
                worktree_count, observed_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(workspace_id) DO UPDATE SET
                workspace_record_version = excluded.workspace_record_version,
                materialization_state = excluded.materialization_state,
                worktree_count = excluded.worktree_count,
                observed_at_unix_ms = excluded.observed_at_unix_ms",
            params![
                workspace_id.to_string(),
                i64::try_from(decoded.record.record_version).map_err(|_| {
                    WorkspaceStoreError::CorruptRecord(
                        "record version exceeds SQLite integer range".into(),
                    )
                })?,
                lifecycle_state_storage(materialization_state),
                i64::from(worktree_count),
                observed_at_unix_ms,
            ],
        )?;
        transaction.commit()?;
        Ok(lifecycle)
    }

    /// Append an immutable removal tombstone and hide the workspace from the
    /// active projections. The caller supplies the completed operation result
    /// so an idempotency replay can return the exact original receipt.
    pub fn tombstone(
        &self,
        workspace_id: Uuid,
        idempotency_key: &str,
        effect_digest: &str,
        result_json: &str,
    ) -> Result<TombstoneWorkspaceResult, WorkspaceStoreError> {
        let idempotency_key = parse_idempotency_key(idempotency_key)?;
        validate_effect_digest(effect_digest)?;
        validate_tombstone_result_json(result_json)?;

        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(existing) =
            load_tombstone_by_idempotency(&transaction, &idempotency_key.to_string())?
        {
            if existing.workspace_id != workspace_id || existing.effect_digest != effect_digest {
                return Err(WorkspaceStoreError::TombstoneIdempotencyConflict { idempotency_key });
            }
            transaction.commit()?;
            return Ok(TombstoneWorkspaceResult {
                tombstone: existing,
                replayed: true,
            });
        }
        if load_tombstone_by_workspace(&transaction, &workspace_id.to_string())?.is_some() {
            return Err(WorkspaceStoreError::WorkspaceAlreadyTombstoned { workspace_id });
        }
        if load_projection(&transaction, &workspace_id.to_string())?.is_none() {
            return Err(WorkspaceStoreError::CorruptRecord(
                "workspace tombstone refers to a missing workspace".into(),
            ));
        }

        let event_id = Uuid::new_v4();
        let removed_at_unix_ms = unix_time_ms()?;
        let event_json = serde_json::to_string(&WorkspaceTombstoneEvent {
            schema_version: WORKSPACE_RECORD_SCHEMA_VERSION,
            event_id,
            event_type: TOMBSTONE_EVENT_TYPE,
            workspace_id,
            idempotency_key,
            effect_digest,
            removed_at_unix_ms,
        })?;
        transaction.execute(
            "INSERT INTO workspace_tombstone_events (
                event_id, workspace_id, event_type, event_json,
                idempotency_key, effect_digest, result_json, removed_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event_id.to_string(),
                workspace_id.to_string(),
                TOMBSTONE_EVENT_TYPE,
                event_json,
                idempotency_key.to_string(),
                effect_digest,
                result_json,
                removed_at_unix_ms,
            ],
        )?;
        transaction.commit()?;
        Ok(TombstoneWorkspaceResult {
            tombstone: WorkspaceTombstone {
                workspace_id,
                idempotency_key,
                effect_digest: effect_digest.to_owned(),
                result_json: result_json.to_owned(),
                removed_at_unix_ms,
            },
            replayed: false,
        })
    }

    pub fn tombstone_by_idempotency(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<WorkspaceTombstone>, WorkspaceStoreError> {
        let idempotency_key = parse_idempotency_key(idempotency_key)?;
        let connection = self.connection()?;
        load_tombstone_by_idempotency(&connection, &idempotency_key.to_string())
    }

    pub fn database_path(&self) -> &Path {
        &self.inner.database_path
    }

    fn initialize(&self) -> Result<(), WorkspaceStoreError> {
        let mut connection = self.connection()?;
        set_private_file_permissions(&self.inner.database_path)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 = transaction.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        match version {
            0 => {
                transaction.execute_batch(include_str!("../migrations/0001.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0002.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0003.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0004.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0005.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0006.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0007.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0008.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0009.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0010.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0011.sql"))?;
                transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
            }
            1 => {
                transaction.execute_batch(include_str!("../migrations/0002.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0003.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0004.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0005.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0006.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0007.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0008.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0009.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0010.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0011.sql"))?;
                transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
            }
            2 => {
                transaction.execute_batch(include_str!("../migrations/0003.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0004.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0005.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0006.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0007.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0008.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0009.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0010.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0011.sql"))?;
                transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
            }
            3 => {
                transaction.execute_batch(include_str!("../migrations/0004.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0005.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0006.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0007.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0008.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0009.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0010.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0011.sql"))?;
                transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
            }
            4 => {
                transaction.execute_batch(include_str!("../migrations/0005.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0006.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0007.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0008.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0009.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0010.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0011.sql"))?;
                transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
            }
            5 => {
                transaction.execute_batch(include_str!("../migrations/0006.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0007.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0008.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0009.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0010.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0011.sql"))?;
                transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
            }
            6 => {
                transaction.execute_batch(include_str!("../migrations/0007.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0008.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0009.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0010.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0011.sql"))?;
                transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
            }
            7 => {
                transaction.execute_batch(include_str!("../migrations/0008.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0009.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0010.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0011.sql"))?;
                transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
            }
            8 => {
                transaction.execute_batch(include_str!("../migrations/0009.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0010.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0011.sql"))?;
                transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
            }
            9 => {
                transaction.execute_batch(include_str!("../migrations/0010.sql"))?;
                transaction.execute_batch(include_str!("../migrations/0011.sql"))?;
                transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
            }
            10 => {
                transaction.execute_batch(include_str!("../migrations/0011.sql"))?;
                transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
            }
            STORE_SCHEMA_VERSION => {}
            found if found > STORE_SCHEMA_VERSION => {
                return Err(WorkspaceStoreError::UnsupportedSchemaVersion { found });
            }
            found => {
                return Err(WorkspaceStoreError::CorruptRecord(format!(
                    "unsupported historical store schema {found}"
                )));
            }
        }
        transaction.commit()?;
        Ok(())
    }

    fn connection(&self) -> Result<Connection, WorkspaceStoreError> {
        let connection = Connection::open_with_flags(
            &self.inner.database_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )?;
        connection.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        let journal_mode: String =
            connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            return Err(WorkspaceStoreError::CorruptRecord(
                "workspace database did not enter WAL mode".into(),
            ));
        }
        Ok(connection)
    }

    fn view(
        &self,
        record: WorkspaceRecord,
        lifecycle: WorkspaceLifecycleSummary,
    ) -> Result<WorkspaceView, WorkspaceStoreError> {
        if record.workspace_root_id != self.inner.workspace_root.id {
            return Err(WorkspaceStoreError::UnknownWorkspaceRoot(
                record.workspace_root_id,
            ));
        }
        validate_record(&record)?;
        validate_lifecycle(&record, &lifecycle)?;
        let display_path = self.inner.workspace_root.path.join(&record.workspace_leaf);
        let workspace_display_path = display_path
            .to_str()
            .ok_or(WorkspaceStoreError::NonUtf8WorkspaceRoot)?
            .to_owned();

        debug_assert!(
            workspace_display_path.starts_with(self.inner.workspace_root.display_path.as_str())
        );
        let connection = self.connection()?;
        let observed_work_items = load_observed_work_items(&connection, record.workspace_id)?;
        let workflow = load_workflow(&connection, record.workspace_id)?;
        Ok(WorkspaceView {
            schema_version: record.schema_version,
            workspace_id: record.workspace_id,
            record_version: record.record_version,
            intent: record.intent,
            title: record.title,
            display_name: record.display_name,
            preferred_provider: record.preferred_provider,
            phase: record.phase,
            repositories: record.repositories,
            runtime: record.runtime,
            planning: record.planning,
            observed_work_items,
            workspace_root_id: record.workspace_root_id,
            workspace_leaf: record.workspace_leaf,
            workspace_display_path,
            lifecycle,
            workflow,
            created_at_unix_ms: record.created_at_unix_ms,
            updated_at_unix_ms: record.updated_at_unix_ms,
        })
    }
}

impl WorkspaceService {
    pub fn open(
        data_dir: impl AsRef<Path>,
        workspace_root_id: impl Into<String>,
        workspace_root_path: impl AsRef<Path>,
    ) -> Result<Self, WorkspaceStoreError> {
        Ok(Self {
            store: WorkspaceStore::open(data_dir, workspace_root_id, workspace_root_path)?,
        })
    }

    pub fn from_store(store: WorkspaceStore) -> Self {
        Self { store }
    }

    pub fn list(&self) -> Result<WorkspaceList, WorkspaceStoreError> {
        self.store.list()
    }

    pub fn get(&self, workspace_id: Uuid) -> Result<Option<WorkspaceView>, WorkspaceStoreError> {
        self.store.get(workspace_id)
    }

    pub fn transition_workflow(
        &self,
        workspace_id: Uuid,
        request: TransitionWorkspaceWorkflowRequest,
    ) -> Result<WorkspaceWorkflowSummary, WorkspaceStoreError> {
        self.store.transition_workflow(workspace_id, request)
    }

    pub fn place_workspace_on_board(
        &self,
        workspace_id: Uuid,
        request: PlaceWorkspaceOnBoardRequest,
    ) -> Result<WorkspaceWorkflowSummary, WorkspaceStoreError> {
        self.store.place_workspace_on_board(workspace_id, request)
    }

    pub fn follow_workspace_agent(
        &self,
        workspace_id: Uuid,
        request: FollowWorkspaceAgentRequest,
    ) -> Result<WorkspaceWorkflowSummary, WorkspaceStoreError> {
        self.store.follow_workspace_agent(workspace_id, request)
    }

    pub fn confirm_work_item_link(
        &self,
        workspace_id: Uuid,
        idempotency_key: &str,
        preview_digest: &str,
        provider: StoredWorkItemProvider,
        role: StoredWorkItemRole,
        snapshot: StoredWorkItemSnapshot,
    ) -> Result<ConfirmStoredWorkItemLinkResult, WorkspaceStoreError> {
        self.store.confirm_work_item_link(
            workspace_id,
            idempotency_key,
            preview_digest,
            provider,
            role,
            snapshot,
        )
    }

    pub fn confirmed_work_item_link_replay(
        &self,
        workspace_id: Uuid,
        idempotency_key: &str,
        preview_digest: &str,
    ) -> Result<Option<ConfirmStoredWorkItemLinkResult>, WorkspaceStoreError> {
        self.store
            .confirmed_work_item_link_replay(workspace_id, idempotency_key, preview_digest)
    }

    pub fn list_work_item_links(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<StoredWorkspaceWorkItemLink>, WorkspaceStoreError> {
        self.store.list_work_item_links(workspace_id)
    }

    pub fn unlink_work_item_link(
        &self,
        workspace_id: Uuid,
        link_id: Uuid,
        expected_revision: u64,
    ) -> Result<StoredWorkItemUnlinkResult, WorkspaceStoreError> {
        self.store
            .unlink_work_item_link(workspace_id, link_id, expected_revision)
    }

    pub fn list_review_threads(
        &self,
        workspace_id: Uuid,
    ) -> Result<Vec<StoredReviewThread>, WorkspaceStoreError> {
        self.store.list_review_threads(workspace_id)
    }

    pub fn create_review_thread(
        &self,
        workspace_id: Uuid,
        target: StoredReviewTarget,
        author: StoredReviewAuthor,
        body: &str,
    ) -> Result<StoredReviewThread, WorkspaceStoreError> {
        self.store
            .create_review_thread(workspace_id, target, author, body)
    }

    pub fn resolve_review_thread(
        &self,
        workspace_id: Uuid,
        thread_id: Uuid,
        expected_revision: u64,
    ) -> Result<StoredReviewThread, WorkspaceStoreError> {
        self.store
            .resolve_review_thread(workspace_id, thread_id, expected_revision)
    }

    pub fn replace_observed_work_items(
        &self,
        workspace_id: Uuid,
        observations: &[ObservedWorkItem],
    ) -> Result<Vec<ObservedWorkItem>, WorkspaceStoreError> {
        self.store
            .replace_observed_work_items(workspace_id, observations)
    }

    pub fn repositories_observed_for_issue(
        &self,
        issue_key: &str,
    ) -> Result<Vec<String>, WorkspaceStoreError> {
        self.store.repositories_observed_for_issue(issue_key)
    }

    pub fn rename(
        &self,
        workspace_id: Uuid,
        request: RenameWorkspaceRequest,
    ) -> Result<WorkspaceView, WorkspaceStoreError> {
        self.store.rename(workspace_id, request)
    }

    pub fn add_repository(
        &self,
        workspace_id: Uuid,
        repository: WorkspaceRepositoryRequest,
    ) -> Result<WorkspaceView, WorkspaceStoreError> {
        self.store.add_repository(workspace_id, repository)
    }

    pub fn remove_repository(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<WorkspaceView, WorkspaceStoreError> {
        self.store.remove_repository(workspace_id, repository_id)
    }

    pub fn create_replay(
        &self,
        idempotency_key: &str,
        request: &CreateWorkspaceRequest,
    ) -> Result<Option<CreateWorkspaceResult>, WorkspaceStoreError> {
        self.store.create_replay(idempotency_key, request)
    }

    pub fn create(
        &self,
        idempotency_key: &str,
        request: CreateWorkspaceRequest,
    ) -> Result<CreateWorkspaceResult, WorkspaceStoreError> {
        self.store.create(idempotency_key, request)
    }

    pub fn observe_lifecycle(
        &self,
        workspace_id: Uuid,
        materialization_state: WorkspaceMaterializationState,
        worktree_count: u32,
    ) -> Result<WorkspaceLifecycleSummary, WorkspaceStoreError> {
        self.store
            .observe_lifecycle(workspace_id, materialization_state, worktree_count)
    }

    pub fn tombstone(
        &self,
        workspace_id: Uuid,
        idempotency_key: &str,
        effect_digest: &str,
        result_json: &str,
    ) -> Result<TombstoneWorkspaceResult, WorkspaceStoreError> {
        self.store
            .tombstone(workspace_id, idempotency_key, effect_digest, result_json)
    }

    pub fn tombstone_by_idempotency(
        &self,
        idempotency_key: &str,
    ) -> Result<Option<WorkspaceTombstone>, WorkspaceStoreError> {
        self.store.tombstone_by_idempotency(idempotency_key)
    }

    pub fn store(&self) -> &WorkspaceStore {
        &self.store
    }
}

#[derive(Debug)]
struct RawProjection {
    workspace_id: String,
    record_version: i64,
    record_json: String,
    updated_at_unix_ms: i64,
    json_bytes: i64,
    lifecycle_record_version: Option<i64>,
    materialization_state: Option<String>,
    worktree_count: Option<i64>,
    observed_at_unix_ms: Option<i64>,
}

struct DecodedProjection {
    record: WorkspaceRecord,
    lifecycle: WorkspaceLifecycleSummary,
}

fn load_workflow(
    connection: &Connection,
    workspace_id: Uuid,
) -> Result<WorkspaceWorkflowSummary, WorkspaceStoreError> {
    let raw = connection
        .query_row(
            "SELECT workflow.state, workflow.workflow_revision,
                    workflow.updated_at_unix_ms, placement.mode, placement.lane_rank
             FROM workspace_workflow_projection AS workflow
             JOIN workspace_board_placement_projection AS placement
               ON placement.workspace_id = workflow.workspace_id
             WHERE workflow.workspace_id = ?1",
            [workspace_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    let (state, revision, updated_at_unix_ms, placement_mode, lane_rank) =
        raw.ok_or_else(|| {
            WorkspaceStoreError::CorruptRecord("workspace workflow projection is missing".into())
        })?;
    let revision = u64::try_from(revision).map_err(|_| {
        WorkspaceStoreError::CorruptRecord("workspace workflow revision is invalid".into())
    })?;
    let rank = u64::try_from(lane_rank).map_err(|_| {
        WorkspaceStoreError::CorruptRecord("workspace board rank is invalid".into())
    })?;
    if revision == 0 || updated_at_unix_ms < 0 {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace workflow projection is invalid".into(),
        ));
    }
    let state = workflow_state_from_storage(&state)?;
    Ok(WorkspaceWorkflowSummary {
        state,
        revision,
        updated_at_unix_ms,
        placement: WorkspaceBoardPlacementSummary {
            mode: board_placement_mode_from_storage(&placement_mode)?,
            rank,
        },
    })
}

fn load_lane_workspace_ids(
    connection: &Connection,
    state: WorkspaceWorkflowState,
    excluded_workspace_id: Option<Uuid>,
) -> Result<Vec<Uuid>, WorkspaceStoreError> {
    let mut statement = connection.prepare(
        "SELECT workflow.workspace_id
         FROM workspace_workflow_projection AS workflow
         JOIN workspace_board_placement_projection AS placement
           ON placement.workspace_id = workflow.workspace_id
         WHERE workflow.state = ?1
           AND workflow.workspace_id != COALESCE(?2, '')
           AND NOT EXISTS (
               SELECT 1 FROM workspace_tombstone_events AS tombstone
               WHERE tombstone.workspace_id = workflow.workspace_id
           )
         ORDER BY placement.lane_rank, workflow.workspace_id",
    )?;
    let rows = statement
        .query_map(
            params![
                workflow_state_storage(state),
                excluded_workspace_id.map(|workspace_id| workspace_id.to_string())
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|workspace_id| {
            Uuid::parse_str(&workspace_id).map_err(|_| {
                WorkspaceStoreError::CorruptRecord(
                    "workspace board placement contains an invalid workspace identifier".into(),
                )
            })
        })
        .collect()
}

fn apply_lane_order(
    connection: &Connection,
    workspace_ids: &[Uuid],
    updated_at_unix_ms: i64,
) -> Result<(), WorkspaceStoreError> {
    for (rank, workspace_id) in workspace_ids.iter().enumerate() {
        let rank = i64::try_from(rank).map_err(|_| {
            WorkspaceStoreError::CorruptRecord("workspace board rank overflowed".into())
        })?;
        let changed = connection.execute(
            "UPDATE workspace_board_placement_projection
             SET lane_rank = ?1, updated_at_unix_ms = ?2
             WHERE workspace_id = ?3",
            params![rank, updated_at_unix_ms, workspace_id.to_string()],
        )?;
        if changed != 1 {
            return Err(WorkspaceStoreError::CorruptRecord(
                "workspace board placement projection is missing".into(),
            ));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn persist_workflow_change(
    connection: &Connection,
    workspace_id: Uuid,
    current: &WorkspaceWorkflowSummary,
    target_state: WorkspaceWorkflowState,
    target_mode: WorkspaceBoardPlacementMode,
    target_rank: u64,
    board_event_type: &'static str,
    updated_at_unix_ms: i64,
) -> Result<WorkspaceWorkflowSummary, WorkspaceStoreError> {
    let revision = current.revision.checked_add(1).ok_or_else(|| {
        WorkspaceStoreError::CorruptRecord("workspace workflow revision overflowed".into())
    })?;
    let revision_i64 = i64::try_from(revision).map_err(|_| {
        WorkspaceStoreError::CorruptRecord(
            "workspace workflow revision exceeds SQLite integer range".into(),
        )
    })?;
    let target_rank_i64 = i64::try_from(target_rank).map_err(|_| {
        WorkspaceStoreError::CorruptRecord("workspace board rank exceeds SQLite range".into())
    })?;

    if current.state != target_state {
        let workflow_event_id = Uuid::new_v4();
        let workflow_event_json = serde_json::to_string(&WorkspaceWorkflowEvent {
            schema_version: 1,
            event_id: workflow_event_id,
            event_type: WORKFLOW_EVENT_TYPE,
            workspace_id,
            from_state: current.state,
            to_state: target_state,
            workflow_revision: revision,
            created_at_unix_ms: updated_at_unix_ms,
        })?;
        connection.execute(
            "INSERT INTO workspace_workflow_events (
                event_id, workspace_id, event_type, from_state, to_state,
                workflow_revision, event_json, created_at_unix_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                workflow_event_id.to_string(),
                workspace_id.to_string(),
                WORKFLOW_EVENT_TYPE,
                workflow_state_storage(current.state),
                workflow_state_storage(target_state),
                revision_i64,
                workflow_event_json,
                updated_at_unix_ms,
            ],
        )?;
    }

    let board_event_id = Uuid::new_v4();
    let board_event_json = serde_json::to_string(&WorkspaceBoardPlacementEvent {
        schema_version: 1,
        event_id: board_event_id,
        event_type: board_event_type,
        workspace_id,
        from_state: current.state,
        to_state: target_state,
        from_mode: current.placement.mode,
        to_mode: target_mode,
        from_rank: current.placement.rank,
        to_rank: target_rank,
        workflow_revision: revision,
        created_at_unix_ms: updated_at_unix_ms,
    })?;
    connection.execute(
        "INSERT INTO workspace_board_placement_events (
            event_id, workspace_id, event_type, from_state, to_state,
            from_mode, to_mode, from_rank, to_rank, workflow_revision,
            event_json, created_at_unix_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            board_event_id.to_string(),
            workspace_id.to_string(),
            board_event_type,
            workflow_state_storage(current.state),
            workflow_state_storage(target_state),
            board_placement_mode_storage(current.placement.mode),
            board_placement_mode_storage(target_mode),
            i64::try_from(current.placement.rank).map_err(|_| {
                WorkspaceStoreError::CorruptRecord(
                    "workspace board rank exceeds SQLite range".into(),
                )
            })?,
            target_rank_i64,
            revision_i64,
            board_event_json,
            updated_at_unix_ms,
        ],
    )?;

    let changed = connection.execute(
        "UPDATE workspace_workflow_projection
         SET state = ?1, workflow_revision = ?2, updated_at_unix_ms = ?3
         WHERE workspace_id = ?4 AND workflow_revision = ?5",
        params![
            workflow_state_storage(target_state),
            revision_i64,
            updated_at_unix_ms,
            workspace_id.to_string(),
            i64::try_from(current.revision).map_err(|_| {
                WorkspaceStoreError::CorruptRecord(
                    "workspace workflow revision exceeds SQLite integer range".into(),
                )
            })?,
        ],
    )?;
    if changed != 1 {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace workflow projection changed during its transaction".into(),
        ));
    }
    let changed = connection.execute(
        "UPDATE workspace_board_placement_projection
         SET mode = ?1, lane_rank = ?2, updated_at_unix_ms = ?3
         WHERE workspace_id = ?4",
        params![
            board_placement_mode_storage(target_mode),
            target_rank_i64,
            updated_at_unix_ms,
            workspace_id.to_string(),
        ],
    )?;
    if changed != 1 {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace board placement projection is missing".into(),
        ));
    }

    Ok(WorkspaceWorkflowSummary {
        state: target_state,
        revision,
        updated_at_unix_ms,
        placement: WorkspaceBoardPlacementSummary {
            mode: target_mode,
            rank: target_rank,
        },
    })
}

fn board_placement_mode_from_storage(
    mode: &str,
) -> Result<WorkspaceBoardPlacementMode, WorkspaceStoreError> {
    match mode {
        "automatic" => Ok(WorkspaceBoardPlacementMode::Automatic),
        "pinned" => Ok(WorkspaceBoardPlacementMode::Pinned),
        _ => Err(WorkspaceStoreError::CorruptRecord(
            "workspace board placement mode is invalid".into(),
        )),
    }
}

fn board_placement_mode_storage(mode: WorkspaceBoardPlacementMode) -> &'static str {
    match mode {
        WorkspaceBoardPlacementMode::Automatic => "automatic",
        WorkspaceBoardPlacementMode::Pinned => "pinned",
    }
}

fn workflow_state_from_storage(state: &str) -> Result<WorkspaceWorkflowState, WorkspaceStoreError> {
    match state {
        "ready" => Ok(WorkspaceWorkflowState::Ready),
        "active" => Ok(WorkspaceWorkflowState::Active),
        "review" => Ok(WorkspaceWorkflowState::Review),
        "parked" => Ok(WorkspaceWorkflowState::Parked),
        _ => Err(WorkspaceStoreError::CorruptRecord(
            "workspace workflow state is invalid".into(),
        )),
    }
}

fn workflow_state_storage(state: WorkspaceWorkflowState) -> &'static str {
    match state {
        WorkspaceWorkflowState::Ready => "ready",
        WorkspaceWorkflowState::Active => "active",
        WorkspaceWorkflowState::Review => "review",
        WorkspaceWorkflowState::Parked => "parked",
    }
}

fn load_work_item_links(
    connection: &Connection,
    workspace_id: Uuid,
) -> Result<Vec<StoredWorkspaceWorkItemLink>, WorkspaceStoreError> {
    let mut statement = connection.prepare(
        "SELECT link_id, provider, issue_key, role, summary, status, content,
                browser_url, fetched_at_unix_ms, revision, created_at_unix_ms,
                updated_at_unix_ms
         FROM workspace_work_item_links
         WHERE workspace_id = ?1
         ORDER BY CASE role
                    WHEN 'primary' THEN 0
                    WHEN 'created_from_workspace' THEN 1
                    ELSE 2
                  END,
                  created_at_unix_ms ASC, link_id ASC",
    )?;
    let rows = statement
        .query_map([workspace_id.to_string()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, i64>(10)?,
                row.get::<_, i64>(11)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(
            |(
                link_id,
                provider,
                issue_key,
                role,
                summary,
                status,
                content,
                browser_url,
                fetched_at_unix_ms,
                revision,
                created_at_unix_ms,
                updated_at_unix_ms,
            )| {
                let link = StoredWorkspaceWorkItemLink {
                    link_id: Uuid::parse_str(&link_id).map_err(|_| {
                        WorkspaceStoreError::CorruptRecord(
                            "workspace work-item link identifier is invalid".into(),
                        )
                    })?,
                    workspace_id,
                    provider: work_item_provider_from_storage(&provider)?,
                    role: work_item_role_from_storage(&role)?,
                    snapshot: StoredWorkItemSnapshot {
                        issue_key,
                        summary,
                        status,
                        content,
                        browser_url,
                        fetched_at_unix_ms,
                    },
                    revision: u64::try_from(revision).map_err(|_| {
                        WorkspaceStoreError::CorruptRecord(
                            "workspace work-item link revision is invalid".into(),
                        )
                    })?,
                    created_at_unix_ms,
                    updated_at_unix_ms,
                };
                validate_work_item_link(&link).map_err(|_| {
                    WorkspaceStoreError::CorruptRecord(
                        "workspace work-item link projection is invalid".into(),
                    )
                })?;
                Ok(link)
            },
        )
        .collect()
}

fn persist_jira_intent_work_item_link(
    connection: &Connection,
    record: &WorkspaceRecord,
) -> Result<(), WorkspaceStoreError> {
    let WorkspaceIntent::Jira { issue_key } = &record.intent else {
        return Ok(());
    };
    let link = StoredWorkspaceWorkItemLink {
        link_id: Uuid::new_v4(),
        workspace_id: record.workspace_id,
        provider: StoredWorkItemProvider::Jira,
        role: StoredWorkItemRole::Primary,
        snapshot: StoredWorkItemSnapshot {
            issue_key: issue_key.clone(),
            summary: None,
            status: None,
            content: String::new(),
            browser_url: None,
            fetched_at_unix_ms: 0,
        },
        revision: 1,
        created_at_unix_ms: record.created_at_unix_ms,
        updated_at_unix_ms: record.created_at_unix_ms,
    };
    validate_work_item_link(&link)?;
    connection.execute(
        "INSERT INTO workspace_work_item_links (
            link_id, workspace_id, provider, issue_key, role, summary, status,
            content, browser_url, fetched_at_unix_ms, revision,
            created_at_unix_ms, updated_at_unix_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, '', NULL, 0, 1, ?6, ?6)",
        params![
            link.link_id.to_string(),
            link.workspace_id.to_string(),
            work_item_provider_storage(link.provider),
            link.snapshot.issue_key,
            work_item_role_storage(link.role),
            link.created_at_unix_ms,
        ],
    )?;
    let event_id = Uuid::new_v4();
    let event_json = serde_json::to_string(&WorkspaceWorkItemLinkedEvent {
        schema_version: 1,
        event_id,
        event_type: WORK_ITEM_LINKED_EVENT_TYPE,
        link: &link,
    })?;
    connection.execute(
        "INSERT INTO workspace_work_item_link_events (
            event_id, workspace_id, link_id, event_type, link_revision,
            event_json, created_at_unix_ms
         ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
        params![
            event_id.to_string(),
            link.workspace_id.to_string(),
            link.link_id.to_string(),
            WORK_ITEM_LINKED_EVENT_TYPE,
            event_json,
            link.created_at_unix_ms,
        ],
    )?;
    Ok(())
}

fn load_work_item_link(
    connection: &Connection,
    workspace_id: Uuid,
    link_id: Uuid,
) -> Result<Option<StoredWorkspaceWorkItemLink>, WorkspaceStoreError> {
    Ok(load_work_item_links(connection, workspace_id)?
        .into_iter()
        .find(|link| link.link_id == link_id))
}

fn load_work_item_link_by_issue(
    connection: &Connection,
    workspace_id: Uuid,
    provider: StoredWorkItemProvider,
    issue_key: &str,
) -> Result<Option<StoredWorkspaceWorkItemLink>, WorkspaceStoreError> {
    Ok(load_work_item_links(connection, workspace_id)?
        .into_iter()
        .find(|link| link.provider == provider && link.snapshot.issue_key == issue_key))
}

fn validate_work_item_link(link: &StoredWorkspaceWorkItemLink) -> Result<(), WorkspaceStoreError> {
    validate_work_item_snapshot(&link.snapshot)?;
    if link.link_id.is_nil()
        || link.workspace_id.is_nil()
        || link.revision == 0
        || link.created_at_unix_ms < 0
        || link.updated_at_unix_ms < link.created_at_unix_ms
    {
        return Err(WorkspaceStoreError::InvalidWorkItemLink);
    }
    Ok(())
}

fn validate_work_item_snapshot(
    snapshot: &StoredWorkItemSnapshot,
) -> Result<(), WorkspaceStoreError> {
    if !valid_jira_issue_key(&snapshot.issue_key)
        || snapshot.issue_key.len() > MAX_WORK_ITEM_ISSUE_KEY_BYTES
        || snapshot.fetched_at_unix_ms < 0
        || snapshot.content.len() > MAX_WORK_ITEM_CONTENT_BYTES
        || snapshot.content.as_bytes().contains(&0)
        || snapshot
            .content
            .chars()
            .any(|value| value.is_control() && !matches!(value, '\n' | '\r' | '\t'))
        || !valid_bounded_optional_text(snapshot.summary.as_deref(), MAX_WORK_ITEM_SUMMARY_BYTES)
        || !valid_bounded_optional_text(snapshot.status.as_deref(), MAX_WORK_ITEM_STATUS_BYTES)
        || !valid_work_item_browser_url(snapshot.browser_url.as_deref())
    {
        return Err(WorkspaceStoreError::InvalidWorkItemLink);
    }
    Ok(())
}

fn valid_jira_issue_key(value: &str) -> bool {
    let Some((project, number)) = value.rsplit_once('-') else {
        return false;
    };
    !project.is_empty()
        && project.len() <= 32
        && !number.is_empty()
        && number.len() <= 16
        && project
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_bounded_optional_text(value: Option<&str>, max_bytes: usize) -> bool {
    value.is_none_or(|value| {
        !value.is_empty()
            && value == value.trim()
            && value.len() <= max_bytes
            && !value.as_bytes().contains(&0)
            && !value.chars().any(char::is_control)
    })
}

fn valid_work_item_browser_url(value: Option<&str>) -> bool {
    value.is_none_or(|value| {
        let Some(authority_and_path) = value.strip_prefix("https://") else {
            return false;
        };
        let authority = authority_and_path.split('/').next().unwrap_or_default();
        !authority.is_empty()
            && authority.contains('.')
            && value.len() <= MAX_WORK_ITEM_BROWSER_URL_BYTES
            && !value
                .chars()
                .any(|character| character.is_control() || character.is_whitespace())
            && !authority.contains('@')
            && !value.contains(['?', '#'])
    })
}

fn validate_sha256_digest(value: &str) -> Result<(), ()> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(());
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(());
    }
    Ok(())
}

fn work_item_provider_storage(provider: StoredWorkItemProvider) -> &'static str {
    match provider {
        StoredWorkItemProvider::Jira => "jira",
    }
}

fn work_item_provider_from_storage(
    provider: &str,
) -> Result<StoredWorkItemProvider, WorkspaceStoreError> {
    match provider {
        "jira" => Ok(StoredWorkItemProvider::Jira),
        _ => Err(WorkspaceStoreError::CorruptRecord(
            "workspace work-item provider is invalid".into(),
        )),
    }
}

fn work_item_role_storage(role: StoredWorkItemRole) -> &'static str {
    match role {
        StoredWorkItemRole::Primary => "primary",
        StoredWorkItemRole::Related => "related",
        StoredWorkItemRole::CreatedFromWorkspace => "created_from_workspace",
    }
}

fn work_item_role_from_storage(role: &str) -> Result<StoredWorkItemRole, WorkspaceStoreError> {
    match role {
        "primary" => Ok(StoredWorkItemRole::Primary),
        "related" => Ok(StoredWorkItemRole::Related),
        "created_from_workspace" => Ok(StoredWorkItemRole::CreatedFromWorkspace),
        _ => Err(WorkspaceStoreError::CorruptRecord(
            "workspace work-item role is invalid".into(),
        )),
    }
}

fn load_review_threads(
    connection: &Connection,
    workspace_id: Uuid,
) -> Result<Vec<StoredReviewThread>, WorkspaceStoreError> {
    let thread_ids = {
        let mut statement = connection.prepare(
            "SELECT thread_id
             FROM workspace_review_threads
             WHERE workspace_id = ?1
             ORDER BY updated_at_unix_ms DESC, thread_id ASC",
        )?;
        statement
            .query_map([workspace_id.to_string()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    thread_ids
        .into_iter()
        .map(|thread_id| {
            let thread_id = Uuid::parse_str(&thread_id).map_err(|_| {
                WorkspaceStoreError::CorruptRecord(
                    "workspace review thread identifier is invalid".into(),
                )
            })?;
            load_review_thread(connection, workspace_id, thread_id)?.ok_or_else(|| {
                WorkspaceStoreError::CorruptRecord(
                    "workspace review thread disappeared during a read".into(),
                )
            })
        })
        .collect()
}

fn load_review_thread(
    connection: &Connection,
    workspace_id: Uuid,
    thread_id: Uuid,
) -> Result<Option<StoredReviewThread>, WorkspaceStoreError> {
    let raw = connection
        .query_row(
            "SELECT target_document_id, target_document_sha256, target_line,
                    state, revision, created_at_unix_ms, updated_at_unix_ms,
                    resolved_at_unix_ms
             FROM workspace_review_threads
             WHERE workspace_id = ?1 AND thread_id = ?2",
            params![workspace_id.to_string(), thread_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((
        document_id,
        document_sha256,
        line,
        state,
        revision,
        created_at_unix_ms,
        updated_at_unix_ms,
        resolved_at_unix_ms,
    )) = raw
    else {
        return Ok(None);
    };
    let line = line
        .map(|value| u32::try_from(value).map_err(|_| WorkspaceStoreError::InvalidReviewThread))
        .transpose()?;
    let target = StoredReviewTarget::PlanningDocument {
        document_id,
        document_sha256,
        line,
    };
    validate_review_target(&target).map_err(|_| {
        WorkspaceStoreError::CorruptRecord("workspace review target is invalid".into())
    })?;
    let state = match state.as_str() {
        "open" => StoredReviewThreadState::Open,
        "resolved" => StoredReviewThreadState::Resolved,
        _ => {
            return Err(WorkspaceStoreError::CorruptRecord(
                "workspace review thread state is invalid".into(),
            ));
        }
    };
    let revision = u64::try_from(revision).map_err(|_| {
        WorkspaceStoreError::CorruptRecord("workspace review thread revision is invalid".into())
    })?;
    if revision == 0
        || created_at_unix_ms < 0
        || updated_at_unix_ms < created_at_unix_ms
        || resolved_at_unix_ms.is_some_and(|value| value < created_at_unix_ms)
        || (state == StoredReviewThreadState::Open && resolved_at_unix_ms.is_some())
        || (state == StoredReviewThreadState::Resolved && resolved_at_unix_ms.is_none())
    {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace review thread metadata is invalid".into(),
        ));
    }

    let comments = load_review_comments(connection, thread_id, ReviewCommentTable::Planning)?;
    if comments.is_empty() {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace review thread has no comments".into(),
        ));
    }
    Ok(Some(StoredReviewThread {
        thread_id,
        workspace_id,
        target,
        state,
        revision,
        comments,
        created_at_unix_ms,
        updated_at_unix_ms,
        resolved_at_unix_ms,
    }))
}

fn load_verification_review_threads(
    connection: &Connection,
    workspace_id: Uuid,
) -> Result<Vec<StoredReviewThread>, WorkspaceStoreError> {
    let thread_ids = {
        let mut statement = connection.prepare(
            "SELECT thread_id
             FROM workspace_verification_review_threads
             WHERE workspace_id = ?1
             ORDER BY updated_at_unix_ms DESC, thread_id ASC",
        )?;
        statement
            .query_map([workspace_id.to_string()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    thread_ids
        .into_iter()
        .map(|thread_id| {
            let thread_id = Uuid::parse_str(&thread_id).map_err(|_| {
                WorkspaceStoreError::CorruptRecord(
                    "workspace verification review thread identifier is invalid".into(),
                )
            })?;
            load_verification_review_thread(connection, workspace_id, thread_id)?.ok_or_else(|| {
                WorkspaceStoreError::CorruptRecord(
                    "workspace verification review thread disappeared during a read".into(),
                )
            })
        })
        .collect()
}

fn load_verification_review_thread(
    connection: &Connection,
    workspace_id: Uuid,
    thread_id: Uuid,
) -> Result<Option<StoredReviewThread>, WorkspaceStoreError> {
    let raw = connection
        .query_row(
            "SELECT target_plan_revision, target_completed_at_unix_ms, target_check_id,
                    state, revision, created_at_unix_ms, updated_at_unix_ms,
                    resolved_at_unix_ms
             FROM workspace_verification_review_threads
             WHERE workspace_id = ?1 AND thread_id = ?2",
            params![workspace_id.to_string(), thread_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((
        plan_revision,
        completed_at_unix_ms,
        check_id,
        state,
        revision,
        created_at_unix_ms,
        updated_at_unix_ms,
        resolved_at_unix_ms,
    )) = raw
    else {
        return Ok(None);
    };
    let target = StoredReviewTarget::VerificationCheck {
        plan_revision: u64::try_from(plan_revision).map_err(|_| {
            WorkspaceStoreError::CorruptRecord(
                "workspace verification review plan revision is invalid".into(),
            )
        })?,
        completed_at_unix_ms,
        check_id,
    };
    validate_review_target(&target).map_err(|_| {
        WorkspaceStoreError::CorruptRecord("workspace verification review target is invalid".into())
    })?;
    let (state, revision) = validate_review_thread_metadata(
        &state,
        revision,
        created_at_unix_ms,
        updated_at_unix_ms,
        resolved_at_unix_ms,
    )?;
    let comments = load_review_comments(connection, thread_id, ReviewCommentTable::Verification)?;
    if comments.is_empty() {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace verification review thread has no comments".into(),
        ));
    }
    Ok(Some(StoredReviewThread {
        thread_id,
        workspace_id,
        target,
        state,
        revision,
        comments,
        created_at_unix_ms,
        updated_at_unix_ms,
        resolved_at_unix_ms,
    }))
}

fn load_code_review_threads(
    connection: &Connection,
    workspace_id: Uuid,
) -> Result<Vec<StoredReviewThread>, WorkspaceStoreError> {
    let thread_ids = {
        let mut statement = connection.prepare(
            "SELECT thread_id
             FROM workspace_code_review_threads
             WHERE workspace_id = ?1
             ORDER BY updated_at_unix_ms DESC, thread_id ASC",
        )?;
        statement
            .query_map([workspace_id.to_string()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    thread_ids
        .into_iter()
        .map(|thread_id| {
            let thread_id = Uuid::parse_str(&thread_id).map_err(|_| {
                WorkspaceStoreError::CorruptRecord(
                    "workspace code review thread identifier is invalid".into(),
                )
            })?;
            load_code_review_thread(connection, workspace_id, thread_id)?.ok_or_else(|| {
                WorkspaceStoreError::CorruptRecord(
                    "workspace code review thread disappeared during a read".into(),
                )
            })
        })
        .collect()
}

fn load_code_review_thread(
    connection: &Connection,
    workspace_id: Uuid,
    thread_id: Uuid,
) -> Result<Option<StoredReviewThread>, WorkspaceStoreError> {
    let raw = connection
        .query_row(
            "SELECT target_repository_id, target_base_commit_oid, target_head_commit_oid,
                    target_patch_sha256, target_file_path, target_side, target_line,
                    state, revision, created_at_unix_ms, updated_at_unix_ms,
                    resolved_at_unix_ms
             FROM workspace_code_review_threads
             WHERE workspace_id = ?1 AND thread_id = ?2",
            params![workspace_id.to_string(), thread_id.to_string()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, Option<i64>>(11)?,
                ))
            },
        )
        .optional()?;
    let Some((
        repository_id,
        base_commit_oid,
        head_commit_oid,
        patch_sha256,
        file_path,
        side,
        line,
        state,
        revision,
        created_at_unix_ms,
        updated_at_unix_ms,
        resolved_at_unix_ms,
    )) = raw
    else {
        return Ok(None);
    };
    let target = StoredReviewTarget::CodeChange {
        repository_id,
        base_commit_oid,
        head_commit_oid,
        patch_sha256,
        file_path,
        side,
        line: u32::try_from(line).map_err(|_| {
            WorkspaceStoreError::CorruptRecord("workspace code review line is invalid".into())
        })?,
    };
    validate_review_target(&target).map_err(|_| {
        WorkspaceStoreError::CorruptRecord("workspace code review target is invalid".into())
    })?;
    let (state, revision) = validate_review_thread_metadata(
        &state,
        revision,
        created_at_unix_ms,
        updated_at_unix_ms,
        resolved_at_unix_ms,
    )?;
    let comments = load_review_comments(connection, thread_id, ReviewCommentTable::Code)?;
    if comments.is_empty() {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace code review thread has no comments".into(),
        ));
    }
    Ok(Some(StoredReviewThread {
        thread_id,
        workspace_id,
        target,
        state,
        revision,
        comments,
        created_at_unix_ms,
        updated_at_unix_ms,
        resolved_at_unix_ms,
    }))
}

#[derive(Clone, Copy)]
enum ReviewCommentTable {
    Planning,
    Verification,
    Code,
}

fn load_review_comments(
    connection: &Connection,
    thread_id: Uuid,
    table: ReviewCommentTable,
) -> Result<Vec<StoredReviewComment>, WorkspaceStoreError> {
    let sql = match table {
        ReviewCommentTable::Planning => {
            "SELECT comment_id, author, body, created_at_unix_ms
             FROM workspace_review_comments
             WHERE thread_id = ?1
             ORDER BY sequence ASC"
        }
        ReviewCommentTable::Verification => {
            "SELECT comment_id, author, body, created_at_unix_ms
             FROM workspace_verification_review_comments
             WHERE thread_id = ?1
             ORDER BY sequence ASC"
        }
        ReviewCommentTable::Code => {
            "SELECT comment_id, author, body, created_at_unix_ms
             FROM workspace_code_review_comments
             WHERE thread_id = ?1
             ORDER BY sequence ASC"
        }
    };
    let mut statement = connection.prepare(sql)?;
    let rows = statement
        .query_map([thread_id.to_string()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(comment_id, author, body, created_at_unix_ms)| {
            let comment_id = Uuid::parse_str(&comment_id).map_err(|_| {
                WorkspaceStoreError::CorruptRecord(
                    "workspace review comment identifier is invalid".into(),
                )
            })?;
            let author = match author.as_str() {
                "user" => StoredReviewAuthor::User,
                "agent" => StoredReviewAuthor::Agent,
                _ => {
                    return Err(WorkspaceStoreError::CorruptRecord(
                        "workspace review comment author is invalid".into(),
                    ));
                }
            };
            let body_is_canonical =
                normalize_review_body(&body).is_ok_and(|normalized| normalized == body);
            if !body_is_canonical || created_at_unix_ms < 0 {
                return Err(WorkspaceStoreError::CorruptRecord(
                    "workspace review comment is invalid".into(),
                ));
            }
            Ok(StoredReviewComment {
                comment_id,
                author,
                body,
                created_at_unix_ms,
            })
        })
        .collect()
}

fn validate_review_thread_metadata(
    state: &str,
    revision: i64,
    created_at_unix_ms: i64,
    updated_at_unix_ms: i64,
    resolved_at_unix_ms: Option<i64>,
) -> Result<(StoredReviewThreadState, u64), WorkspaceStoreError> {
    let state = match state {
        "open" => StoredReviewThreadState::Open,
        "resolved" => StoredReviewThreadState::Resolved,
        _ => {
            return Err(WorkspaceStoreError::CorruptRecord(
                "workspace review thread state is invalid".into(),
            ));
        }
    };
    let revision = u64::try_from(revision).map_err(|_| {
        WorkspaceStoreError::CorruptRecord("workspace review thread revision is invalid".into())
    })?;
    if revision == 0
        || created_at_unix_ms < 0
        || updated_at_unix_ms < created_at_unix_ms
        || resolved_at_unix_ms.is_some_and(|value| value < created_at_unix_ms)
        || (state == StoredReviewThreadState::Open && resolved_at_unix_ms.is_some())
        || (state == StoredReviewThreadState::Resolved && resolved_at_unix_ms.is_none())
    {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace review thread metadata is invalid".into(),
        ));
    }
    Ok((state, revision))
}

fn validate_review_target(target: &StoredReviewTarget) -> Result<(), WorkspaceStoreError> {
    match target {
        StoredReviewTarget::PlanningDocument {
            document_id,
            document_sha256,
            line,
        } => {
            if !matches!(
                document_id.as_str(),
                "readme" | "plan" | "findings" | "kanban" | "programBacklog"
            ) || document_sha256.len() != 71
                || !document_sha256.starts_with("sha256:")
                || !document_sha256[7..]
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || line.is_some_and(|value| value == 0 || value > 1_000_000)
            {
                return Err(WorkspaceStoreError::InvalidReviewThread);
            }
        }
        StoredReviewTarget::VerificationCheck {
            plan_revision,
            completed_at_unix_ms,
            check_id,
        } => {
            if *plan_revision == 0
                || *plan_revision > i64::MAX as u64
                || *completed_at_unix_ms < 0
                || check_id.is_empty()
                || check_id.len() > 128
                || !check_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            {
                return Err(WorkspaceStoreError::InvalidReviewThread);
            }
        }
        StoredReviewTarget::CodeChange {
            repository_id,
            base_commit_oid,
            head_commit_oid,
            patch_sha256,
            file_path,
            side,
            line,
        } => {
            let valid_oid = |value: &str| {
                matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            };
            let path = Path::new(file_path);
            if repository_id.is_empty()
                || repository_id.trim() != repository_id
                || repository_id.len() > 512
                || !valid_oid(base_commit_oid)
                || !valid_oid(head_commit_oid)
                || validate_sha256_digest(patch_sha256).is_err()
                || file_path.is_empty()
                || file_path.len() > 4096
                || file_path.as_bytes().contains(&0)
                || path.is_absolute()
                || !path
                    .components()
                    .all(|component| matches!(component, Component::Normal(_)))
                || !matches!(side.as_str(), "additions" | "deletions")
                || *line == 0
                || *line > 1_000_000
            {
                return Err(WorkspaceStoreError::InvalidReviewThread);
            }
        }
    }
    Ok(())
}

fn normalize_review_body(body: &str) -> Result<String, WorkspaceStoreError> {
    if body.len() > MAX_REVIEW_COMMENT_BYTES {
        return Err(WorkspaceStoreError::ReviewCommentTooLarge);
    }
    let body = body.trim();
    if body.is_empty()
        || body.as_bytes().contains(&0)
        || body
            .chars()
            .any(|value| value.is_control() && !matches!(value, '\n' | '\r' | '\t'))
    {
        return Err(WorkspaceStoreError::InvalidReviewThread);
    }
    Ok(body.to_owned())
}

fn review_author_storage(author: StoredReviewAuthor) -> &'static str {
    match author {
        StoredReviewAuthor::User => "user",
        StoredReviewAuthor::Agent => "agent",
    }
}

fn load_observed_work_items(
    connection: &Connection,
    workspace_id: Uuid,
) -> Result<Vec<ObservedWorkItem>, WorkspaceStoreError> {
    let mut statement = connection.prepare(
        "SELECT issue_key, source_file, observed_at_unix_ms
         FROM workspace_work_item_observations
         WHERE workspace_id = ?1
         ORDER BY issue_key,
           CASE source_file
             WHEN 'README.md' THEN 0
             WHEN 'PLAN.md' THEN 1
             WHEN 'FINDINGS.md' THEN 2
             WHEN 'KANBAN.md' THEN 3
             WHEN 'PROGRAM-BACKLOG.md' THEN 4
           END",
    )?;
    let rows = statement
        .query_map([workspace_id.to_string()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut observations: Vec<ObservedWorkItem> = Vec::new();
    for (issue_key, source_file, observed_at_unix_ms) in rows {
        if let Some(current) = observations.last_mut()
            && current.issue_key == issue_key
        {
            current.source_files.push(source_file);
            current.observed_at_unix_ms = current.observed_at_unix_ms.max(observed_at_unix_ms);
        } else {
            observations.push(ObservedWorkItem {
                issue_key,
                source_files: vec![source_file],
                observed_at_unix_ms,
            });
        }
    }
    Ok(observations)
}

fn validate_observed_work_items(
    observations: &[ObservedWorkItem],
) -> Result<(), WorkspaceStoreError> {
    const ALLOWED_FILES: [&str; 5] = [
        "README.md",
        "PLAN.md",
        "FINDINGS.md",
        "KANBAN.md",
        "PROGRAM-BACKLOG.md",
    ];
    if observations.len() > 64 {
        return Err(WorkspaceStoreError::CorruptRecord(
            "work-item observation count exceeds the store limit".into(),
        ));
    }
    for observation in observations {
        let valid_key = observation
            .issue_key
            .split_once('-')
            .is_some_and(|(project, number)| {
                project.len() >= 2
                    && project.len() <= 16
                    && project
                        .bytes()
                        .next()
                        .is_some_and(|byte| byte.is_ascii_uppercase())
                    && project
                        .bytes()
                        .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
                    && (1..=10).contains(&number.len())
                    && !number.starts_with('0')
                    && number.bytes().all(|byte| byte.is_ascii_digit())
            });
        if !valid_key
            || observation.observed_at_unix_ms < 0
            || observation.source_files.is_empty()
            || observation.source_files.len() > ALLOWED_FILES.len()
            || observation
                .source_files
                .iter()
                .any(|source| !ALLOWED_FILES.contains(&source.as_str()))
        {
            return Err(WorkspaceStoreError::CorruptRecord(
                "work-item observation is invalid".into(),
            ));
        }
    }
    Ok(())
}

fn load_projection(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Option<DecodedProjection>, WorkspaceStoreError> {
    connection
        .query_row(
            "SELECT workspace.workspace_id, workspace.record_version,
                    workspace.record_json, workspace.updated_at_unix_ms,
                    length(workspace.record_json),
                    lifecycle.workspace_record_version,
                    lifecycle.materialization_state,
                    lifecycle.worktree_count,
                    lifecycle.observed_at_unix_ms
             FROM workspace_projection AS workspace
             LEFT JOIN workspace_lifecycle_projection AS lifecycle
               ON lifecycle.workspace_id = workspace.workspace_id
             WHERE workspace.workspace_id = ?1
               AND NOT EXISTS (
                   SELECT 1 FROM workspace_tombstone_events AS tombstone
                   WHERE tombstone.workspace_id = workspace.workspace_id
               )",
            [workspace_id],
            |row| {
                Ok(RawProjection {
                    workspace_id: row.get(0)?,
                    record_version: row.get(1)?,
                    record_json: row.get(2)?,
                    updated_at_unix_ms: row.get(3)?,
                    json_bytes: row.get(4)?,
                    lifecycle_record_version: row.get(5)?,
                    materialization_state: row.get(6)?,
                    worktree_count: row.get(7)?,
                    observed_at_unix_ms: row.get(8)?,
                })
            },
        )
        .optional()?
        .map(decode_projection)
        .transpose()
}

fn load_tombstone_by_idempotency(
    connection: &Connection,
    idempotency_key: &str,
) -> Result<Option<WorkspaceTombstone>, WorkspaceStoreError> {
    connection
        .query_row(
            "SELECT workspace_id, idempotency_key, effect_digest, result_json,
                    removed_at_unix_ms
             FROM workspace_tombstone_events
             WHERE idempotency_key = ?1",
            [idempotency_key],
            decode_tombstone_row,
        )
        .optional()
        .map_err(Into::into)
}

fn load_tombstone_by_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Option<WorkspaceTombstone>, WorkspaceStoreError> {
    connection
        .query_row(
            "SELECT workspace_id, idempotency_key, effect_digest, result_json,
                    removed_at_unix_ms
             FROM workspace_tombstone_events
             WHERE workspace_id = ?1",
            [workspace_id],
            decode_tombstone_row,
        )
        .optional()
        .map_err(Into::into)
}

fn decode_tombstone_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceTombstone> {
    let workspace_id = row.get::<_, String>(0)?;
    let idempotency_key = row.get::<_, String>(1)?;
    Ok(WorkspaceTombstone {
        workspace_id: Uuid::parse_str(&workspace_id).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "invalid workspace tombstone id",
                )),
            )
        })?,
        idempotency_key: Uuid::parse_str(&idempotency_key).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "invalid workspace tombstone idempotency key",
                )),
            )
        })?,
        effect_digest: row.get(2)?,
        result_json: row.get(3)?,
        removed_at_unix_ms: row.get(4)?,
    })
}

fn decode_projection(raw: RawProjection) -> Result<DecodedProjection, WorkspaceStoreError> {
    if raw.json_bytes < 0 || raw.json_bytes as usize > MAX_RECORD_JSON_BYTES {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace JSON exceeds the store limit".into(),
        ));
    }
    let record: WorkspaceRecord = serde_json::from_str(&raw.record_json)
        .map_err(|error| WorkspaceStoreError::CorruptRecord(error.to_string()))?;
    if record.workspace_id.to_string() != raw.workspace_id
        || i64::try_from(record.record_version).ok() != Some(raw.record_version)
        || record.updated_at_unix_ms != raw.updated_at_unix_ms
    {
        return Err(WorkspaceStoreError::CorruptRecord(
            "projection metadata does not match its workspace JSON".into(),
        ));
    }
    validate_record(&record)?;
    let lifecycle = decode_lifecycle(&record, &raw)?;
    Ok(DecodedProjection { record, lifecycle })
}

fn decode_lifecycle(
    record: &WorkspaceRecord,
    raw: &RawProjection,
) -> Result<WorkspaceLifecycleSummary, WorkspaceStoreError> {
    let fields_present = [
        raw.lifecycle_record_version.is_some(),
        raw.materialization_state.is_some(),
        raw.worktree_count.is_some(),
        raw.observed_at_unix_ms.is_some(),
    ];
    if fields_present.iter().all(|present| !present) {
        return Ok(WorkspaceLifecycleSummary::unknown());
    }
    if !fields_present.iter().all(|present| *present) {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace lifecycle projection is incomplete".into(),
        ));
    }
    if raw.lifecycle_record_version != i64::try_from(record.record_version).ok() {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace lifecycle record version is stale".into(),
        ));
    }
    let materialization_state = match raw.materialization_state.as_deref() {
        Some("not_materialized") => WorkspaceMaterializationState::NotMaterialized,
        Some("materialized") => WorkspaceMaterializationState::Materialized,
        Some("needs_attention") => WorkspaceMaterializationState::NeedsAttention,
        _ => {
            return Err(WorkspaceStoreError::CorruptRecord(
                "workspace lifecycle state is invalid".into(),
            ));
        }
    };
    let worktree_count = u32::try_from(raw.worktree_count.unwrap_or_default()).map_err(|_| {
        WorkspaceStoreError::CorruptRecord("workspace lifecycle worktree count is invalid".into())
    })?;
    let lifecycle = WorkspaceLifecycleSummary {
        materialization_state,
        worktree_count,
        observed_at_unix_ms: raw.observed_at_unix_ms,
    };
    validate_lifecycle(record, &lifecycle)?;
    Ok(lifecycle)
}

fn validate_lifecycle(
    record: &WorkspaceRecord,
    lifecycle: &WorkspaceLifecycleSummary,
) -> Result<(), WorkspaceStoreError> {
    match lifecycle.materialization_state {
        WorkspaceMaterializationState::Unknown => {
            if lifecycle.worktree_count != 0 || lifecycle.observed_at_unix_ms.is_some() {
                return Err(WorkspaceStoreError::CorruptRecord(
                    "unknown workspace lifecycle contains an observation".into(),
                ));
            }
        }
        WorkspaceMaterializationState::Materialized => {
            if usize::try_from(lifecycle.worktree_count).ok() != Some(record.repositories.len()) {
                return Err(WorkspaceStoreError::CorruptRecord(
                    "materialized workspace lifecycle has the wrong worktree count".into(),
                ));
            }
            validate_lifecycle_timestamp(record, lifecycle)?;
        }
        WorkspaceMaterializationState::NotMaterialized
        | WorkspaceMaterializationState::NeedsAttention => {
            if lifecycle.worktree_count != 0 {
                return Err(WorkspaceStoreError::CorruptRecord(
                    "non-materialized workspace lifecycle has worktrees".into(),
                ));
            }
            validate_lifecycle_timestamp(record, lifecycle)?;
        }
    }
    Ok(())
}

fn validate_lifecycle_timestamp(
    record: &WorkspaceRecord,
    lifecycle: &WorkspaceLifecycleSummary,
) -> Result<(), WorkspaceStoreError> {
    if lifecycle
        .observed_at_unix_ms
        .is_none_or(|observed| observed < record.created_at_unix_ms)
    {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace lifecycle observation time is invalid".into(),
        ));
    }
    Ok(())
}

fn lifecycle_state_storage(state: WorkspaceMaterializationState) -> &'static str {
    match state {
        WorkspaceMaterializationState::Unknown => "unknown",
        WorkspaceMaterializationState::NotMaterialized => "not_materialized",
        WorkspaceMaterializationState::Materialized => "materialized",
        WorkspaceMaterializationState::NeedsAttention => "needs_attention",
    }
}

fn validate_record(record: &WorkspaceRecord) -> Result<(), WorkspaceStoreError> {
    if record.schema_version != WORKSPACE_RECORD_SCHEMA_VERSION {
        return Err(WorkspaceStoreError::CorruptRecord(format!(
            "unsupported workspace record schema {}",
            record.schema_version
        )));
    }
    if record.record_version != WORKSPACE_RECORD_VERSION {
        return Err(WorkspaceStoreError::CorruptRecord(format!(
            "unsupported workspace record version {}",
            record.record_version
        )));
    }
    if record.workspace_id.is_nil() {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace identifier is nil".into(),
        ));
    }
    if !valid_root_id(&record.workspace_root_id) {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace root identifier is invalid".into(),
        ));
    }
    let expected_workspace_leaf = record.display_name.as_ref().map_or_else(
        || workspace_leaf(&record.intent, record.workspace_id),
        |display_name| workspace_leaf_from_name(display_name, record.workspace_id),
    );
    if record.workspace_leaf != expected_workspace_leaf {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace leaf does not match its trusted identity".into(),
        ));
    }
    if record.created_at_unix_ms < 0 || record.updated_at_unix_ms < record.created_at_unix_ms {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace timestamps are invalid".into(),
        ));
    }
    if record.phase != WorkspacePhase::Draft {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace phase is unsupported".into(),
        ));
    }
    if let Some(display_name) = &record.display_name {
        let normalized = RenameWorkspaceRequest {
            title: display_name.clone(),
        }
        .normalize()
        .map_err(|error| {
            WorkspaceStoreError::CorruptRecord(format!(
                "workspace display name failed validation: {error}"
            ))
        })?;
        if normalized.title != *display_name {
            return Err(WorkspaceStoreError::CorruptRecord(
                "workspace display name is not canonical".into(),
            ));
        }
    }
    for repository in &record.repositories {
        if repository.request_id.is_nil()
            || repository.worktree_leaf != repository_leaf(&repository.label, repository.request_id)
        {
            return Err(WorkspaceStoreError::CorruptRecord(
                "repository plan has an invalid trusted identity".into(),
            ));
        }
    }

    let normalized = CreateWorkspaceRequest {
        intent: record.intent.clone(),
        title: record.title.clone(),
        preferred_provider: record.preferred_provider,
        repositories: record
            .repositories
            .iter()
            .map(|repository| WorkspaceRepositoryRequest {
                repository_id: repository.repository_id.clone(),
                label: repository.label.clone(),
                base_ref: repository.base_ref.clone(),
            })
            .collect(),
        runtime: record.runtime.clone(),
        planning: record.planning,
    }
    .normalize()
    .map_err(|error| {
        WorkspaceStoreError::CorruptRecord(format!(
            "workspace domain data failed validation: {error}"
        ))
    })?;
    let plans: Vec<_> = normalized
        .repositories
        .into_iter()
        .zip(record.repositories.iter())
        .map(|(repository, plan)| WorkspaceRepositoryPlan {
            request_id: plan.request_id,
            repository_id: repository.repository_id,
            label: repository.label,
            base_ref: repository.base_ref,
            worktree_leaf: plan.worktree_leaf.clone(),
        })
        .collect();
    if normalized.intent != record.intent
        || normalized.title != record.title
        || normalized.preferred_provider != record.preferred_provider
        || normalized.runtime != record.runtime
        || normalized.planning != record.planning
        || plans != record.repositories
    {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace domain data is not canonical".into(),
        ));
    }
    Ok(())
}

fn parse_idempotency_key(value: &str) -> Result<Uuid, WorkspaceStoreError> {
    let id =
        Uuid::parse_str(value.trim()).map_err(|_| WorkspaceStoreError::InvalidIdempotencyKey)?;
    if id.is_nil() {
        return Err(WorkspaceStoreError::InvalidIdempotencyKey);
    }
    Ok(id)
}

fn validate_effect_digest(value: &str) -> Result<(), WorkspaceStoreError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(WorkspaceStoreError::InvalidEffectDigest);
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(WorkspaceStoreError::InvalidEffectDigest);
    }
    Ok(())
}

fn validate_tombstone_result_json(value: &str) -> Result<(), WorkspaceStoreError> {
    if value.is_empty() || value.len() > MAX_TOMBSTONE_RESULT_JSON_BYTES {
        return Err(WorkspaceStoreError::CorruptRecord(
            "workspace tombstone result exceeds the store limit".into(),
        ));
    }
    let _: serde_json::Value = serde_json::from_str(value)?;
    Ok(())
}

fn workspace_leaf(intent: &WorkspaceIntent, workspace_id: Uuid) -> String {
    let source = match intent {
        WorkspaceIntent::Jira { issue_key } => issue_key.as_str(),
        WorkspaceIntent::OpenProject { display_id, .. } => display_id.as_str(),
        WorkspaceIntent::RepositorySet { label } => label.as_str(),
    };
    workspace_leaf_from_name(source, workspace_id)
}

pub fn renamed_workspace_leaf(
    title: &str,
    workspace_id: Uuid,
) -> Result<String, WorkspaceValidationError> {
    let title = RenameWorkspaceRequest {
        title: title.to_owned(),
    }
    .normalize()?
    .title;
    Ok(workspace_leaf_from_name(&title, workspace_id))
}

fn workspace_leaf_from_name(source: &str, workspace_id: Uuid) -> String {
    let slug = slug(source);
    let bounded_slug = slug.get(..slug.len().min(200)).unwrap_or(&slug);
    format!(
        "{}-{}",
        if bounded_slug.is_empty() {
            "workspace"
        } else {
            bounded_slug
        },
        workspace_id
    )
}

fn repository_leaf(label: &str, request_id: Uuid) -> String {
    let slug = slug(label);
    format!(
        "{}-{}",
        if slug.is_empty() { "repository" } else { &slug },
        request_id
    )
}

fn slug(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn valid_root_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn unix_time_ms() -> Result<i64, WorkspaceStoreError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WorkspaceStoreError::InvalidSystemClock)?;
    i64::try_from(duration.as_millis()).map_err(|_| WorkspaceStoreError::InvalidSystemClock)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), std::io::Error> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{repository_leaf, validate_record, workspace_leaf};
    use crate::{WORKSPACE_RECORD_SCHEMA_VERSION, WORKSPACE_RECORD_VERSION, WorkspaceRecord};
    use serde_json::json;
    use uuid::Uuid;
    use wts_core::workspace::WorkspaceIntent;

    #[test]
    fn v1_workspace_record_without_optional_fields_deserializes_and_validates() {
        let workspace_id = Uuid::new_v4();
        let request_id = Uuid::new_v4();
        let intent = WorkspaceIntent::Jira {
            issue_key: "PLATFORM-42".to_owned(),
        };
        let value = json!({
            "schemaVersion": WORKSPACE_RECORD_SCHEMA_VERSION,
            "workspaceId": workspace_id,
            "recordVersion": WORKSPACE_RECORD_VERSION,
            "intent": {
                "type": "jira",
                "issueKey": "PLATFORM-42",
            },
            "title": "Legacy workspace",
            "preferredProvider": "codex",
            "phase": "draft",
            "repositories": [{
                "requestId": request_id,
                "label": "checkout-api",
                "baseRef": "main",
                "worktreeLeaf": repository_leaf("checkout-api", request_id),
            }],
            "workspaceRootId": "default",
            "workspaceLeaf": workspace_leaf(&intent, workspace_id),
            "createdAtUnixMs": 1,
            "updatedAtUnixMs": 1,
        });

        let record: WorkspaceRecord =
            serde_json::from_value(value).expect("deserialize v1 workspace record");

        assert_eq!(record.repositories[0].repository_id, None);
        assert_eq!(record.runtime, None);
        assert_eq!(record.planning, None);
        validate_record(&record).expect("validate legacy workspace record");
        let serialized = serde_json::to_value(record).expect("serialize legacy workspace record");
        assert!(serialized["repositories"][0].get("repositoryId").is_none());
        assert!(serialized.get("runtime").is_none());
        assert!(serialized.get("planning").is_none());
    }
}
