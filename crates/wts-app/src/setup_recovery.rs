use super::*;
use crate::WorkspaceSetupRecovery;
use crate::generated_files::GeneratedFilesSnapshot;
use std::fs::{File, Metadata};
use std::io;
use wts_git::{CreatedWorktree, WorktreeMaterializationProgress, WorktreeReceipt};

const MAX_ATTEMPT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_RECOVERY_PATHS: usize = 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RootIdentity {
    device: u64,
    inode: u64,
    mode: u32,
}

impl RootIdentity {
    fn read(path: &Path) -> io::Result<Self> {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || path.canonicalize()? != path {
            return Err(io::Error::other("The workspace root changed."));
        }
        Self::from_metadata(&metadata)
    }

    #[cfg(unix)]
    fn from_metadata(metadata: &Metadata) -> io::Result<Self> {
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            mode: metadata.mode(),
        })
    }

    #[cfg(not(unix))]
    fn from_metadata(metadata: &Metadata) -> io::Result<Self> {
        let created = metadata
            .created()?
            .duration_since(UNIX_EPOCH)
            .map_err(|_| io::Error::other("The setup file identity is unavailable."))?;
        Ok(Self {
            device: created.as_secs(),
            inode: u64::from(created.subsec_nanos()),
            mode: u32::from(metadata.permissions().readonly()),
        })
    }

    fn matches(&self, path: &Path) -> bool {
        Self::read(path).is_ok_and(|found| {
            found.device == self.device && found.inode == self.inode && found.mode == self.mode
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupAttempt {
    schema_version: u32,
    attempt_id: Uuid,
    workspace_id: Uuid,
    record_version: u64,
    workspace_path: PathBuf,
    branch_name: String,
    effect_digest: String,
    plan_digest: String,
    planned: Vec<PreflightRepository>,
    confirmed: Vec<String>,
    unconfirmed: Option<String>,
    root_identity: Option<RootIdentity>,
    root_created: bool,
    generated: Option<GeneratedFilesSnapshot>,
}

pub(super) struct SetupLease {
    file: File,
}

impl Drop for SetupLease {
    fn drop(&mut self) {
        // Normal completion does not transfer setup ownership to inherited descriptors.
        let _ = self.file.unlock();
    }
}

#[derive(Clone)]
pub(super) struct SetupAttemptStore {
    directory: PathBuf,
    identity: RootIdentity,
}

impl SetupAttemptStore {
    pub(super) fn open(data: &Path) -> io::Result<Self> {
        let directory = data.join("setup-attempts");
        fs::create_dir_all(&directory)?;
        let metadata = fs::symlink_metadata(&directory)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(io::Error::other("The setup recovery store is unavailable."));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
        let directory = directory.canonicalize()?;
        Ok(Self {
            identity: RootIdentity::read(&directory)?,
            directory,
        })
    }

    pub(super) fn lease(&self, id: Uuid) -> Result<SetupLease, LocalWtsError> {
        if !self.identity.matches(&self.directory) {
            return Err(LocalWtsError::InvalidMaterializationManifest);
        }
        let path = self.directory.join(format!("{id}.lock"));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(&path)
            .map_err(|_| LocalWtsError::InvalidMaterializationManifest)?;
        if !file.metadata().is_ok_and(|metadata| metadata.is_file())
            || fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(LocalWtsError::InvalidMaterializationManifest);
        }
        file.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => LocalWtsError::RepositorySyncBusy,
            fs::TryLockError::Error(_) => LocalWtsError::InvalidMaterializationManifest,
        })?;
        Ok(SetupLease { file })
    }

    fn path(&self, id: Uuid) -> PathBuf {
        self.directory.join(format!("{id}.json"))
    }

    fn read(&self, id: Uuid) -> io::Result<Option<SetupAttempt>> {
        if !self.identity.matches(&self.directory) {
            return Err(io::Error::other("The setup recovery store changed."));
        }
        let path = self.path(id);
        let metadata = match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            value => value?,
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_ATTEMPT_BYTES
        {
            return Err(io::Error::other("The setup recovery record is invalid."));
        }
        let mut bytes = Vec::new();
        File::open(path)?
            .take(MAX_ATTEMPT_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_ATTEMPT_BYTES {
            return Err(io::Error::other("The setup recovery record is too large."));
        }
        let attempt: SetupAttempt = serde_json::from_slice(&bytes)?;
        if attempt.schema_version != 1 || attempt.workspace_id != id || attempt.planned.len() > 128
        {
            return Err(io::Error::other("The setup recovery record is invalid."));
        }
        Ok(Some(attempt))
    }

    fn save(&self, attempt: &SetupAttempt, create: bool) -> io::Result<()> {
        if !self.identity.matches(&self.directory) {
            return Err(io::Error::other("The setup recovery store changed."));
        }
        let previous = self.read(attempt.workspace_id)?;
        if (create && previous.is_some())
            || (!create
                && previous
                    .as_ref()
                    .is_none_or(|saved| saved.attempt_id != attempt.attempt_id))
        {
            return Err(io::Error::other("The setup recovery record changed."));
        }
        let bytes = serde_json::to_vec_pretty(attempt)?;
        if bytes.len() as u64 > MAX_ATTEMPT_BYTES {
            return Err(io::Error::other("The setup recovery record is too large."));
        }
        let temporary = self.directory.join(format!(".{}.tmp", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| {
            let mut file = options.open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            if create {
                fs::hard_link(&temporary, self.path(attempt.workspace_id))?;
            } else {
                fs::rename(&temporary, self.path(attempt.workspace_id))?;
            }
            File::open(&self.directory)?.sync_all()
        })();
        let _ = fs::remove_file(temporary);
        result
    }

    fn clear(&self, attempt: &SetupAttempt) -> io::Result<()> {
        if let Some(saved) = self.read(attempt.workspace_id)? {
            if saved.attempt_id != attempt.attempt_id {
                return Err(io::Error::other("The setup recovery record changed."));
            }
            fs::remove_file(self.path(attempt.workspace_id))?;
            File::open(&self.directory)?.sync_all()?;
        }
        Ok(())
    }
}

pub(super) struct SetupAttemptWriter {
    store: SetupAttemptStore,
    attempt: Arc<Mutex<SetupAttempt>>,
}

impl SetupAttemptWriter {
    pub(super) fn start(
        store: &SetupAttemptStore,
        prepared: &PreparedPreflight,
    ) -> io::Result<Self> {
        let attempt = SetupAttempt {
            schema_version: 1,
            attempt_id: Uuid::new_v4(),
            workspace_id: prepared.view.workspace_id,
            record_version: prepared.view.record_version,
            workspace_path: PathBuf::from(&prepared.public.workspace_display_path),
            branch_name: prepared.public.branch_name.clone(),
            effect_digest: prepared.public.effect_digest.clone(),
            plan_digest: setup_plan_digest(&prepared.view)?,
            planned: prepared.public.repositories.clone(),
            confirmed: Vec::new(),
            unconfirmed: None,
            root_identity: None,
            root_created: false,
            generated: None,
        };
        store.save(&attempt, true)?;
        Ok(Self {
            store: store.clone(),
            attempt: Arc::new(Mutex::new(attempt)),
        })
    }

    pub(super) fn observe(
        &self,
        progress: &WorktreeMaterializationProgress<'_>,
    ) -> Result<(), GitError> {
        let update = || -> io::Result<()> {
            let mut attempt = self
                .attempt
                .lock()
                .map_err(|_| io::Error::other("The setup recovery record is unavailable."))?;
            match progress {
                WorktreeMaterializationProgress::Starting { .. } => {}
                WorktreeMaterializationProgress::RootPrepared { receipt }
                | WorktreeMaterializationProgress::WorktreeCreated { receipt }
                | WorktreeMaterializationProgress::Completed { receipt } => {
                    attempt.root_identity = Some(RootIdentity::read(&receipt.workspace_root)?);
                    attempt.root_created = receipt.workspace_root_created;
                    attempt.confirmed = receipt
                        .worktrees
                        .iter()
                        .map(|entry| entry.repository_id.as_str().to_owned())
                        .collect();
                    attempt.unconfirmed = None;
                }
                WorktreeMaterializationProgress::WorktreeStarting { planned, .. } => {
                    attempt.unconfirmed = Some(planned.repository.id.as_str().to_owned());
                }
                WorktreeMaterializationProgress::RolledBack {
                    receipt,
                    unconfirmed_worktree,
                    ..
                } => {
                    attempt.confirmed = receipt
                        .worktrees
                        .iter()
                        .map(|entry| entry.repository_id.as_str().to_owned())
                        .collect();
                    attempt.unconfirmed =
                        unconfirmed_worktree.map(|entry| entry.repository.id.as_str().to_owned());
                }
            }
            self.store.save(&attempt, false)
        };
        update().map_err(|_| GitError::MaterializationObserverFailed)
    }

    pub(super) fn generated(&self, root: &Path) -> io::Result<GeneratedFiles> {
        let store = self.store.clone();
        let attempt = Arc::clone(&self.attempt);
        GeneratedFiles::new_observed(root, move |snapshot| {
            let mut attempt = attempt
                .lock()
                .map_err(|_| io::Error::other("The setup recovery record is unavailable."))?;
            attempt.generated = Some(snapshot.clone());
            store.save(&attempt, false)
        })
    }

    pub(super) fn clear_after_failure(&self, git: &GitWorktreeService) -> io::Result<bool> {
        let attempt = self
            .attempt
            .lock()
            .map_err(|_| io::Error::other("The setup recovery record is unavailable."))?;
        for planned in &attempt.planned {
            match fs::symlink_metadata(&planned.target_display_path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                _ => return Ok(false),
            }
            let source = git
                .inspect_repository(Path::new(&planned.source_display_path))
                .map_err(|_| io::Error::other("The setup source repository is unavailable."))?;
            if source
                .available_branches
                .iter()
                .any(|branch| !branch.remote && branch.name == attempt.branch_name)
            {
                return Ok(false);
            }
        }
        match fs::read_dir(&attempt.workspace_path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Ok(mut entries) => {
                if attempt.root_created || entries.next().is_some() {
                    return Ok(false);
                }
            }
            _ => return Ok(false),
        }
        self.store.clear(&attempt)?;
        Ok(true)
    }

    pub(super) fn clear(&self) -> io::Result<()> {
        self.store.clear(
            &*self
                .attempt
                .lock()
                .map_err(|_| io::Error::other("The setup recovery record is unavailable."))?,
        )
    }
}

struct PreparedSetupRecovery {
    public: WorkspaceSetupRecovery,
    attempt: SetupAttempt,
    receipt: WorktreeReceipt,
}

impl LocalWtsService {
    pub(super) fn setup_recovery_review(
        &self,
        view: &WorkspaceView,
    ) -> Option<WorkspaceSetupRecovery> {
        match self.prepare_setup_recovery(view) {
            Ok(prepared) => prepared.map(|prepared| {
                let mut public = prepared.public;
                if self.inner.setup_attempts.lease(view.workspace_id).is_err() {
                    public.ready = false;
                    public.blockers.truncate(MAX_RECOVERY_PATHS - 1);
                    public.blockers.insert(0, "Another WTS window is creating or cleaning this workspace. Wait for it to finish, then check again.".to_owned());
                    public.effect_digest = format!("sha256:{}", hex::encode(Sha256::digest(format!("{}:busy", public.effect_digest))));
                }
                public
            }),
            Err(_) => Some(WorkspaceSetupRecovery {
                effect_digest: format!("sha256:{}", hex::encode(Sha256::digest(view.workspace_id.as_bytes()))),
                ready: false,
                paths: vec![view.workspace_display_path.clone(), self.inner.setup_attempts.path(view.workspace_id).display().to_string()],
                blockers: vec!["WTS cannot read the saved setup record. Preserve the workspace files and inspect the recovery record.".to_owned()],
            }),
        }
    }

    fn prepare_setup_recovery(
        &self,
        view: &WorkspaceView,
    ) -> Result<Option<PreparedSetupRecovery>, LocalWtsError> {
        let Some(attempt) = self
            .inner
            .setup_attempts
            .read(view.workspace_id)
            .map_err(|_| LocalWtsError::InvalidMaterializationManifest)?
        else {
            return Ok(None);
        };
        let root = Path::new(&view.workspace_display_path);
        let mut blockers = Vec::new();
        let mut paths = BTreeSet::new();
        let mut observations = Vec::new();
        let mut worktrees = Vec::new();
        if attempt.plan_digest
            != setup_plan_digest(view).map_err(|_| LocalWtsError::InvalidMaterializationManifest)?
            || attempt.record_version != view.record_version
            || attempt.workspace_path != root
            || attempt.branch_name != workspace_branch_name(view)
        {
            blockers.push("The saved setup no longer matches this workspace. Preserve its files before another setup attempt.".to_owned());
        }
        if root
            .join(MATERIALIZATION_MANIFEST_FILE)
            .symlink_metadata()
            .is_ok()
        {
            if self.read_materialization_receipt(view.workspace_id).is_ok() {
                return Ok(None);
            }
            blockers.push("The workspace has a success receipt that WTS cannot verify. Preserve its files and inspect that receipt.".to_owned());
        }
        let root_exists = match root.symlink_metadata() {
            Ok(_) => true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(_) => {
                blockers.push(
                    "WTS cannot inspect the workspace root. Check access to that path.".to_owned(),
                );
                true
            }
        };
        if root_exists
            && attempt
                .root_identity
                .as_ref()
                .is_none_or(|identity| !identity.matches(root))
        {
            blockers.push("WTS cannot confirm the workspace root from this setup attempt. Move its files to a safe path before retry.".to_owned());
        }
        let catalog = self.repository_catalog()?;
        let mut known = BTreeSet::new();
        for planned in &attempt.planned {
            let target = Path::new(&planned.target_display_path);
            paths.insert(target.to_owned());
            let matched_plan = view.repositories.iter().any(|entry| {
                entry.repository_id.as_deref().map_or_else(
                    || entry.label.eq_ignore_ascii_case(&planned.label),
                    |id| id == planned.repository_id,
                )
            });
            let source = catalog.repositories.iter().find(|entry| {
                entry.id == planned.repository_id
                    && entry.display_path == planned.source_display_path
            });
            if !matched_plan || target.parent() != Some(root) || source.is_none() {
                blockers.push(format!("The setup repository no longer matches its saved path: {}. Preserve this path.", target.display()));
                continue;
            }
            let inspection = self
                .inner
                .git
                .inspect_repository(Path::new(&planned.source_display_path))
                .map_err(|_| LocalWtsError::RepositoryCatalogUnavailable)?;
            if target != root.join(inspection.worktree_leaf()) {
                blockers.push(format!(
                    "The repository path changed: {}. Preserve this path.",
                    target.display()
                ));
                continue;
            }
            let branch = inspection
                .available_branches
                .iter()
                .find(|entry| !entry.remote && entry.name == attempt.branch_name);
            let present = target.symlink_metadata().is_ok();
            observations
                .push(serde_json::json!({ "path": target, "branch": branch, "present": present }));
            if !present && branch.is_none() {
                continue;
            }
            known.insert(target.to_owned());
            if !attempt.confirmed.contains(&planned.repository_id)
                || attempt.unconfirmed.as_deref() == Some(&planned.repository_id)
            {
                blockers.push(format!("Setup stopped before WTS confirmed {}. Preserve this worktree and branch before retry.", target.display()));
                continue;
            }
            let request = WorktreeRemovalRequest::new(
                &planned.source_display_path,
                root,
                target,
                &planned.repository_id,
                &attempt.branch_name,
            );
            match self.inner.git.inspect_worktree_removal(&request) {
                Ok(current) => {
                    observations.push(
                        serde_json::to_value(&current)
                            .map_err(|_| LocalWtsError::InvalidMaterializationManifest)?,
                    );
                    if current.has_changes {
                        blockers.push(format!("{} contains changed files. Save them outside this setup before cleanup.", target.display()));
                    }
                    if current.has_ignored_files {
                        blockers.push(format!("{} contains ignored files. Move them outside this setup before cleanup.", target.display()));
                    }
                    if current.head_commit_oid != planned.base_commit_oid {
                        blockers.push(format!("{} contains new commits. Preserve its branch and worktree before retry.", target.display()));
                    }
                    if !current.present {
                        blockers.push(format!("The worktree is absent but its branch remains: {}. Preserve that branch and inspect the source repository.", attempt.branch_name));
                    }
                    if current.present {
                        worktrees.push(CreatedWorktree {
                            repository_id: inspection.id,
                            repository_label: planned.label.clone(),
                            source_repository: PathBuf::from(&planned.source_display_path),
                            target_path: target.to_owned(),
                            branch_name: attempt.branch_name.clone(),
                            base_commit_oid: planned.base_commit_oid.clone(),
                        });
                    }
                }
                Err(_) => blockers.push(format!(
                    "The worktree or branch changed: {}. Preserve this path before retry.",
                    target.display()
                )),
            }
        }
        if root_exists
            && attempt
                .root_identity
                .as_ref()
                .is_some_and(|identity| identity.matches(root))
        {
            if let Some(generated) = &attempt.generated {
                if generated.root() != root {
                    blockers.push("The generated-file record has a different workspace path. Preserve the files.".to_owned());
                } else {
                    known.extend(
                        generated
                            .known_paths()
                            .into_iter()
                            .map(|path| root.join(path)),
                    );
                    match generated.inspect() {
                        Ok(inspection) => {
                            for path in inspection.preserved_paths {
                                blockers.push(format!("{} changed or has no confirmed setup receipt. Move it to a safe path before cleanup.", root.join(&path).display()));
                            }
                        }
                        Err(_) => blockers.push("WTS cannot verify the generated files. Preserve the workspace files before retry.".to_owned()),
                    }
                }
            }
            let mut pending = vec![root.to_owned()];
            let mut count = 0;
            while let Some(directory) = pending.pop() {
                let entries = match fs::read_dir(&directory) {
                    Ok(entries) => entries,
                    Err(_) => {
                        blockers.push(format!(
                            "WTS cannot inspect {}. Check access to this path.",
                            directory.display()
                        ));
                        break;
                    }
                };
                for entry in entries {
                    count += 1;
                    if count > MAX_RECOVERY_PATHS {
                        blockers.push("The workspace has too many paths for safe cleanup. Move user files outside this setup first.".to_owned());
                        pending.clear();
                        break;
                    }
                    let entry = entry.map_err(|_| LocalWtsError::InvalidMaterializationManifest)?;
                    let path = entry.path();
                    paths.insert(path.clone());
                    if !known.contains(&path) {
                        blockers.push(format!(
                            "WTS does not own {}. Move it to a safe path before cleanup.",
                            path.display()
                        ));
                        continue;
                    }
                    if worktrees.iter().any(|entry| entry.target_path == path) {
                        continue;
                    }
                    let metadata = fs::symlink_metadata(&path)
                        .map_err(|_| LocalWtsError::InvalidMaterializationManifest)?;
                    if metadata.is_dir() && !metadata.file_type().is_symlink() {
                        pending.push(path);
                    }
                }
            }
        }
        if root_exists {
            paths.insert(root.to_owned());
        }
        blockers.sort();
        blockers.dedup();
        if blockers.len() > MAX_RECOVERY_PATHS {
            blockers.truncate(MAX_RECOVERY_PATHS - 1);
            blockers.push(
                "More paths need inspection. Move user files outside this setup, then check again."
                    .to_owned(),
            );
        }
        for blocker in &mut blockers {
            if blocker.len() > 4096 {
                let mut end = 4000;
                while !blocker.is_char_boundary(end) {
                    end -= 1;
                }
                blocker.truncate(end);
                blocker.push_str("… Check the complete path in the path list.");
            }
        }
        let path_strings = paths
            .iter()
            .take(MAX_RECOVERY_PATHS)
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>();
        let bytes = serde_json::to_vec(&(&attempt, &path_strings, &blockers, observations))
            .map_err(|_| LocalWtsError::InvalidMaterializationManifest)?;
        let effect_digest = format!("sha256:{}", Sha256::digest(bytes).encode_hex::<String>());
        let public = WorkspaceSetupRecovery {
            effect_digest,
            ready: blockers.is_empty(),
            paths: path_strings,
            blockers,
        };
        let receipt = WorktreeReceipt {
            workspace_root: root.to_owned(),
            workspace_root_created: false,
            branch_name: attempt.branch_name.clone(),
            worktrees,
        };
        Ok(Some(PreparedSetupRecovery {
            public,
            attempt,
            receipt,
        }))
    }

    pub fn recover_workspace_setup(
        &self,
        workspace_id: Uuid,
        expected_effect_digest: &str,
    ) -> Result<WorkspacePreflight, LocalWtsError> {
        let _operation = self.lease_workspace_removal_operation(workspace_id)?;
        self.ensure_repository_operation_idle(workspace_id)?;
        let _setup = self.inner.setup_attempts.lease(workspace_id)?;
        let _guard = self
            .inner
            .materialization_lock
            .lock()
            .map_err(|_| LocalWtsError::RemovalFailed)?;
        let view = self
            .inner
            .registry
            .get(workspace_id)?
            .ok_or(LocalWtsError::WorkspaceNotFound)?;
        if self.read_materialization_receipt(workspace_id).is_ok() {
            return Err(LocalWtsError::StalePreflight);
        }
        let Some(prepared) = self.prepare_setup_recovery(&view)? else {
            return self.preflight_workspace(workspace_id);
        };
        if prepared.public.effect_digest != expected_effect_digest {
            return Err(LocalWtsError::StalePreflight);
        }
        if !prepared.public.ready {
            return Err(LocalWtsError::PreflightBlocked {
                blockers: vec![setup_recovery_blocker()],
            });
        }
        if let Some(generated) = &prepared.attempt.generated
            && !generated.rollback().unwrap_or(false)
        {
            return Err(LocalWtsError::GeneratedFileFailed {
                cleanup_complete: false,
            });
        }
        let rollback = self.inner.git.rollback(&prepared.receipt);
        if !rollback.failures.is_empty() || rollback.workspace_root_removal_error.is_some() {
            return Err(LocalWtsError::MaterializationFailed {
                cleanup_complete: false,
            });
        }
        let root = &prepared.attempt.workspace_path;
        if prepared.attempt.root_created
            && prepared
                .attempt
                .root_identity
                .as_ref()
                .is_some_and(|identity| identity.matches(root))
            && fs::read_dir(root).is_ok_and(|mut entries| entries.next().is_none())
        {
            fs::remove_dir(root).map_err(|_| LocalWtsError::GeneratedFileFailed {
                cleanup_complete: false,
            })?;
        }
        self.inner
            .setup_attempts
            .clear(&prepared.attempt)
            .map_err(|_| LocalWtsError::GeneratedFileFailed {
                cleanup_complete: false,
            })?;
        self.preflight_workspace(workspace_id)
    }
}

fn setup_plan_digest(view: &WorkspaceView) -> io::Result<String> {
    let bytes = serde_json::to_vec(&(
        view.workspace_id,
        &view.intent,
        &view.repositories,
        &view.runtime,
        &view.planning,
        &view.workspace_display_path,
        workspace_branch_name(view),
    ))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub(super) fn setup_recovery_blocker() -> PreflightBlocker {
    PreflightBlocker {
        code: PreflightBlockerCode::TargetConflict,
        message:
            "An earlier setup did not finish. Review its saved paths before another setup attempt."
                .to_owned(),
        repository_label: None,
        repository_id: None,
        requested_base_ref: None,
    }
}

#[cfg(test)]
mod completion_boundary_tests {
    use super::*;
    use std::process::Command;
    use wts_core::workspace::WorkspaceProvider;

    #[test]
    fn a_completed_setup_releases_its_lock_even_while_a_duplicate_descriptor_remains_open() {
        let temporary = tempfile::tempdir().unwrap();
        let store = SetupAttemptStore::open(temporary.path()).unwrap();
        let workspace_id = Uuid::new_v4();
        let lease = store.lease(workspace_id).unwrap();
        let inherited = lease.file.try_clone().unwrap();
        assert!(matches!(
            store.lease(workspace_id),
            Err(LocalWtsError::RepositorySyncBusy)
        ));
        drop(lease);
        let next = store.lease(workspace_id);
        assert!(
            next.is_ok(),
            "A completed setup must release its lock before another call: {:?}",
            next.err()
        );
        assert!(inherited.metadata().unwrap().is_file());
    }

    struct Fixture {
        _temporary: tempfile::TempDir,
        service: LocalWtsService,
        workspace_id: Uuid,
    }

    fn fixture() -> Fixture {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let repositories = root.join("repositories");
        let repository = repositories.join("fixture");
        fs::create_dir_all(&repository).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.name", "WTS fixture"],
            vec!["config", "user.email", "fixture@example.test"],
        ] {
            git(&repository, &args);
        }
        fs::write(repository.join("README.md"), b"Fixture\n").unwrap();
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "Fixture"]);
        let service = LocalWtsService::open(
            root.join("data"),
            "fixture",
            root.join("workspaces"),
            &repositories,
        )
        .unwrap();
        let workspace_id = service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::RepositorySet {
                        label: "Recovery boundary".to_owned(),
                    },
                    title: "Recovery boundary".to_owned(),
                    preferred_provider: WorkspaceProvider::Codex,
                    repositories: vec![WorkspaceRepositoryRequest {
                        repository_id: None,
                        label: "fixture".to_owned(),
                        base_ref: "main".to_owned(),
                    }],
                    runtime: None,
                    planning: Some(WorkspacePlanningSelection {
                        folder: WorkspacePlanningFolder::Plans,
                        format: WorkspacePlanningFormat::Notes,
                    }),
                },
            )
            .unwrap()
            .workspace
            .workspace_id;
        Fixture {
            _temporary: temporary,
            service,
            workspace_id,
        }
    }

    fn git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn saved_setup_review_rejects_same_root_plan_selection_changes() {
        let fixture = fixture();
        let prepared = fixture
            .service
            .prepare_preflight(fixture.workspace_id)
            .unwrap();
        assert!(prepared.public.ready);
        let _writer =
            SetupAttemptWriter::start(&fixture.service.inner.setup_attempts, &prepared).unwrap();
        assert!(
            fixture
                .service
                .prepare_setup_recovery(&prepared.view)
                .unwrap()
                .unwrap()
                .public
                .ready
        );
        for change in ["base", "planning", "repositories"] {
            let mut changed = prepared.view.clone();
            match change {
                "base" => changed.repositories[0].base_ref = "another-branch".to_owned(),
                "planning" => changed.planning = None,
                _ => changed.repositories.push(changed.repositories[0].clone()),
            }
            assert_eq!(
                changed.workspace_display_path,
                prepared.view.workspace_display_path
            );
            assert_eq!(changed.record_version, prepared.view.record_version);
            let review = fixture
                .service
                .prepare_setup_recovery(&changed)
                .unwrap()
                .unwrap()
                .public;
            assert!(
                !review.ready,
                "The saved attempt cannot authorize a changed {change} selection."
            );
            assert!(
                review
                    .blockers
                    .iter()
                    .any(|message| message.contains("no longer matches")),
                "{:?}",
                review.blockers
            );
        }
        assert!(
            fixture
                .service
                .inner
                .setup_attempts
                .read(fixture.workspace_id)
                .unwrap()
                .is_some()
        );
        assert!(!Path::new(&prepared.view.workspace_display_path).exists());
    }

    #[test]
    fn failure_on_a_reused_root_retains_unconfirmed_target_intent() {
        let fixture = fixture();
        let view = fixture
            .service
            .inner
            .registry
            .get(fixture.workspace_id)
            .unwrap()
            .unwrap();
        let root = Path::new(&view.workspace_display_path);
        fs::create_dir_all(root).unwrap();
        let prepared = fixture
            .service
            .prepare_preflight(fixture.workspace_id)
            .unwrap();
        assert!(prepared.public.ready);
        let writer =
            SetupAttemptWriter::start(&fixture.service.inner.setup_attempts, &prepared).unwrap();
        let receipt = WorktreeReceipt {
            workspace_root: root.to_owned(),
            workspace_root_created: false,
            branch_name: prepared.public.branch_name.clone(),
            worktrees: Vec::new(),
        };
        let planned = &prepared.plan.as_ref().unwrap().repositories()[0];
        writer
            .observe(&WorktreeMaterializationProgress::RootPrepared { receipt: &receipt })
            .unwrap();
        writer
            .observe(&WorktreeMaterializationProgress::WorktreeStarting {
                receipt: &receipt,
                planned,
            })
            .unwrap();
        fs::create_dir(&planned.target_path).unwrap();
        fs::write(
            planned.target_path.join("unknown.txt"),
            b"Unconfirmed user work\n",
        )
        .unwrap();
        writer
            .observe(&WorktreeMaterializationProgress::RolledBack {
                receipt: &receipt,
                cause: &GitError::RollbackProvenanceMismatch,
                rollback: &wts_git::RollbackReceipt::default(),
                unconfirmed_worktree: Some(planned),
            })
            .unwrap();
        assert!(
            !writer
                .clear_after_failure(&fixture.service.inner.git)
                .unwrap()
        );
        drop(writer);
        let saved = fixture
            .service
            .inner
            .setup_attempts
            .read(fixture.workspace_id)
            .unwrap()
            .expect("The unconfirmed effect must retain its saved intent.");
        assert_eq!(
            saved.unconfirmed.as_deref(),
            Some(planned.repository.id.as_str())
        );
        let review = fixture
            .service
            .prepare_setup_recovery(&view)
            .unwrap()
            .unwrap()
            .public;
        assert!(!review.ready);
        assert!(
            review
                .paths
                .contains(&planned.target_path.display().to_string())
        );
        assert!(
            review
                .blockers
                .iter()
                .any(|message| message.contains("before WTS confirmed"))
        );
        assert!(
            fixture
                .service
                .recover_workspace_setup(fixture.workspace_id, &review.effect_digest)
                .is_err()
        );
        assert_eq!(
            fs::read(planned.target_path.join("unknown.txt")).unwrap(),
            b"Unconfirmed user work\n"
        );
    }
}
