use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GeneratedFilesSnapshot {
    schema_version: u8,
    root: PathBuf,
    root_identity: SavedIdentity,
    directories: Vec<SavedDirectory>,
    files: Vec<SavedFile>,
    intents: Vec<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedIdentity {
    identity: String,
    mode: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedDirectory {
    path: PathBuf,
    identity: SavedIdentity,
    owned: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedFile {
    path: PathBuf,
    temporary_path: PathBuf,
    identity: SavedIdentity,
    size: u64,
    sha256: String,
}

#[derive(Debug, Default)]
pub(crate) struct GeneratedFilesInspection {
    pub(crate) removable_files: Vec<PathBuf>,
    pub(crate) removable_directories: Vec<PathBuf>,
    pub(crate) preserved_paths: Vec<PathBuf>,
    pub(crate) missing_paths: Vec<PathBuf>,
}

type SnapshotObserver = Box<dyn FnMut(&GeneratedFilesSnapshot) -> io::Result<()> + Send>;

/// Record files created by one setup attempt. Rollback preserves changed files.
pub(crate) struct GeneratedFiles {
    root: PathBuf,
    root_metadata: Metadata,
    directories: Vec<RecordedDirectory>,
    files: Vec<CreatedFile>,
    cleanup_incomplete: bool,
    snapshot: GeneratedFilesSnapshot,
    observer: Option<SnapshotObserver>,
    #[cfg(test)]
    before_publish: Option<PublicationHook>,
    #[cfg(test)]
    after_publish: Option<PublicationHook>,
}

#[cfg(test)]
type PublicationHook = Box<dyn FnOnce(&Path)>;

struct RecordedDirectory {
    path: PathBuf,
    metadata: Metadata,
    owned: bool,
}

struct CreatedFile {
    path: PathBuf,
    metadata: Metadata,
    bytes: Vec<u8>,
}

impl GeneratedFiles {
    pub(crate) fn new(root: &Path) -> io::Result<Self> {
        let root_metadata = fs::symlink_metadata(root)?;
        if !root_metadata.is_dir()
            || root_metadata.file_type().is_symlink()
            || root.canonicalize()? != root
        {
            return Err(io::Error::other("The workspace path changed."));
        }
        Ok(Self {
            root: root.to_owned(),
            snapshot: GeneratedFilesSnapshot {
                schema_version: 1,
                root: root.to_owned(),
                root_identity: SavedIdentity::from_metadata(&root_metadata),
                directories: Vec::new(),
                files: Vec::new(),
                intents: Vec::new(),
            },
            observer: None,
            root_metadata,
            directories: Vec::new(),
            files: Vec::new(),
            cleanup_incomplete: false,
            #[cfg(test)]
            before_publish: None,
            #[cfg(test)]
            after_publish: None,
        })
    }

    pub(crate) fn new_observed(
        root: &Path,
        observer: impl FnMut(&GeneratedFilesSnapshot) -> io::Result<()> + Send + 'static,
    ) -> io::Result<Self> {
        let mut generated = Self::new(root)?;
        generated.observer = Some(Box::new(observer));
        generated.observe()?;
        Ok(generated)
    }

    pub(crate) fn snapshot(&self) -> GeneratedFilesSnapshot {
        self.snapshot.clone()
    }

    fn observe(&mut self) -> io::Result<()> {
        let snapshot = self.snapshot();
        if let Some(observer) = self.observer.as_mut() {
            snapshot.validate()?;
            observer(&snapshot)?;
        }
        Ok(())
    }

    fn record_parents(&mut self, relative: &Path) -> io::Result<()> {
        let parent = relative
            .parent()
            .ok_or_else(|| io::Error::other("The generated path has no parent."))?;
        let mut path = PathBuf::new();
        for component in parent.components() {
            if !matches!(component, Component::Normal(_)) {
                return Err(io::Error::other("The generated path is invalid."));
            }
            path.push(component);
            if self.directories.iter().any(|entry| entry.path == path) {
                continue;
            }
            let full = self.checked_path(&path)?;
            let metadata = fs::symlink_metadata(&full)?;
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || full.canonicalize()? != full
            {
                return Err(io::Error::other("The generated directory changed."));
            }
            self.snapshot.directories.push(SavedDirectory {
                path: path.clone(),
                identity: SavedIdentity::from_metadata(&metadata),
                owned: false,
            });
            self.directories.push(RecordedDirectory {
                path: path.clone(),
                metadata,
                owned: false,
            });
            self.observe()?;
        }
        Ok(())
    }

    fn checked_path(&self, relative: &Path) -> io::Result<PathBuf> {
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(io::Error::other("The generated path is invalid."));
        }
        let current_root = fs::symlink_metadata(&self.root)?;
        if !same_file(&current_root, &self.root_metadata)
            || !current_root.is_dir()
            || current_root.file_type().is_symlink()
            || self.root.canonicalize()? != self.root
        {
            return Err(io::Error::other("The workspace path changed."));
        }
        let path = self.root.join(relative);
        let parent = path
            .parent()
            .ok_or_else(|| io::Error::other("The generated path has no parent."))?;
        if parent.canonicalize()? != parent {
            return Err(io::Error::other("The generated file parent changed."));
        }
        for recorded in &self.directories {
            let directory = self.root.join(&recorded.path);
            if parent.starts_with(&directory) {
                let current = fs::symlink_metadata(&directory)?;
                if !same_file(&current, &recorded.metadata)
                    || !current.is_dir()
                    || current.file_type().is_symlink()
                {
                    return Err(io::Error::other("The generated directory changed."));
                }
            }
        }
        Ok(path)
    }

    pub(crate) fn create_directory(&mut self, relative: &Path) -> io::Result<()> {
        self.record_parents(relative)?;
        let path = self.checked_path(relative)?;
        if let Some(recorded) = self.directories.iter().find(|entry| entry.path == relative) {
            let metadata = fs::symlink_metadata(&path)?;
            if !same_file(&metadata, &recorded.metadata)
                || !metadata.is_dir()
                || metadata.file_type().is_symlink()
            {
                return Err(io::Error::other("The generated directory changed."));
            }
            return Ok(());
        }
        // An unconfirmed path is preserved if the host stops before its identity is saved.
        self.snapshot.intents.push(relative.to_owned());
        self.observe()?;
        self.checked_path(relative)?;
        let owned = match fs::create_dir(&path) {
            Ok(()) => true,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => false,
            Err(error) => return Err(error),
        };
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || path.canonicalize()? != path {
            return Err(io::Error::other("The generated directory is unavailable."));
        }
        self.snapshot.directories.push(SavedDirectory {
            path: relative.to_owned(),
            identity: SavedIdentity::from_metadata(&metadata),
            owned,
        });
        self.snapshot.intents.retain(|path| path != relative);
        self.directories.push(RecordedDirectory {
            path: relative.to_owned(),
            metadata,
            owned,
        });
        self.observe()
    }

    pub(crate) fn write(&mut self, relative: &Path, bytes: &[u8]) -> io::Result<()> {
        self.record_parents(relative)?;
        let path = self.checked_path(relative)?;
        let parent = path.parent().expect("checked parent");
        let temporary = parent.join(format!(".wts-setup-{}.tmp", Uuid::new_v4().simple()));
        let temporary_relative = temporary
            .strip_prefix(&self.root)
            .expect("temporary in root")
            .to_owned();
        self.snapshot.intents.push(temporary_relative.clone());
        self.observe()?;
        self.checked_path(relative)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let metadata = file.metadata()?;
        let expected_file = SavedFile {
            path: relative.to_owned(),
            temporary_path: temporary_relative.clone(),
            identity: SavedIdentity::from_metadata(&metadata),
            size: bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(bytes)),
        };
        let result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            self.checked_path(relative)?;
            let written_metadata = file.metadata()?;
            #[cfg(test)]
            if let Some(hook) = self.before_publish.take() {
                hook(&temporary);
            }
            self.checked_path(relative)?;
            verify_named_file(&temporary, &written_metadata)?;
            self.snapshot.files.push(expected_file.clone());
            self.snapshot
                .intents
                .retain(|path| path != &temporary_relative);
            // This identity covers both names before the hard link can publish the file.
            self.observe()?;
            self.checked_path(relative)?;
            verify_named_file(&temporary, &written_metadata)?;
            if !matches!(
                self.snapshot
                    .file_state(&temporary_relative, &expected_file)?,
                SavedPathState::Remove
            ) {
                return Err(io::Error::other("The generated temporary file changed."));
            }
            // A hard link publishes complete bytes without replacing an existing path.
            fs::hard_link(&temporary, &path)?;
            self.files.push(CreatedFile {
                path: relative.to_owned(),
                metadata: written_metadata.clone(),
                bytes: bytes.to_owned(),
            });
            #[cfg(test)]
            if let Some(hook) = self.after_publish.take() {
                hook(&path);
            }
            self.checked_path(relative)?;
            verify_named_file(&path, &written_metadata)?;
            verify_named_file(&temporary, &written_metadata)?;
            if !matches!(
                self.snapshot.file_state(relative, &expected_file)?,
                SavedPathState::Remove
            ) {
                return Err(io::Error::other("The generated file changed."));
            }
            Ok(())
        })();
        let cleanup = (|| {
            self.checked_path(relative)?;
            match self
                .snapshot
                .file_state(&temporary_relative, &expected_file)?
            {
                SavedPathState::Missing => return Ok(()),
                SavedPathState::Remove => {}
                _ => return Err(io::Error::other("The generated temporary file changed.")),
            }
            fs::remove_file(&temporary)
        })();
        self.cleanup_incomplete |= cleanup.is_err();
        result.and(cleanup)
    }

    pub(crate) fn rollback(&self) -> bool {
        let mut complete = !self.cleanup_incomplete;
        for created in self.files.iter().rev() {
            let result = (|| {
                let path = self.checked_path(&created.path)?;
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error),
                };
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || !same_file(&metadata, &created.metadata)
                    || !same_mode(&metadata, &created.metadata)
                    || metadata.len() != created.bytes.len() as u64
                {
                    return Err(io::Error::other("The generated file changed."));
                }
                let mut file = File::open(&path)?;
                if !same_file(&file.metadata()?, &created.metadata)
                    || !same_mode(&file.metadata()?, &created.metadata)
                {
                    return Err(io::Error::other("The generated file changed."));
                }
                let mut bytes = Vec::new();
                (&mut file)
                    .take(created.bytes.len() as u64 + 1)
                    .read_to_end(&mut bytes)?;
                if bytes != created.bytes || verify_named_file(&path, &created.metadata).is_err() {
                    return Err(io::Error::other("The generated file changed."));
                }
                fs::remove_file(path)
            })();
            complete &= result.is_ok();
        }
        for recorded in self.directories.iter().rev() {
            let result = (|| {
                let path = self.checked_path(&recorded.path)?;
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error),
                };
                if !same_file(&metadata, &recorded.metadata)
                    || !metadata.is_dir()
                    || metadata.file_type().is_symlink()
                {
                    return Err(io::Error::other("The generated directory changed."));
                }
                if recorded.owned {
                    if !same_mode(&metadata, &recorded.metadata) {
                        return Err(io::Error::other("The generated directory changed."));
                    }
                    fs::remove_dir(path)
                } else {
                    Ok(())
                }
            })();
            complete &= result.is_ok();
        }
        complete
    }
}

impl SavedIdentity {
    fn from_metadata(metadata: &Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Self {
                identity: format!("unix:{}:{}", metadata.dev(), metadata.ino()),
                mode: metadata.mode(),
            }
        }
        #[cfg(not(unix))]
        {
            let created = metadata
                .created()
                .ok()
                .and_then(|created| created.duration_since(std::time::UNIX_EPOCH).ok());
            Self {
                identity: created.map_or_else(
                    || "unavailable".to_owned(),
                    |created| format!("created:{}:{}", created.as_secs(), created.subsec_nanos()),
                ),
                mode: u32::from(metadata.permissions().readonly()),
            }
        }
    }

    fn available(&self) -> bool {
        let parts = self.identity.split(':').collect::<Vec<_>>();
        parts.len() == 3
            && matches!(parts[0], "unix" | "created")
            && parts[1].parse::<u64>().is_ok()
            && parts[2].parse::<u64>().is_ok()
    }
}

impl GeneratedFilesSnapshot {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn known_paths(&self) -> Vec<PathBuf> {
        self.directories
            .iter()
            .map(|entry| entry.path.clone())
            .chain(
                self.files
                    .iter()
                    .flat_map(|entry| [entry.path.clone(), entry.temporary_path.clone()]),
            )
            .chain(self.intents.iter().cloned())
            .collect()
    }

    fn validate(&self) -> io::Result<()> {
        let paths = self.known_paths();
        if self.schema_version != 1
            || !self.root.is_absolute()
            || !self.root_identity.available()
            || self
                .directories
                .iter()
                .any(|directory| !directory.identity.available())
            || self.root.to_string_lossy().len() > 4096
            || paths.len() > 1024
            || paths.iter().any(|path| {
                path.as_os_str().is_empty()
                    || path.to_string_lossy().len() > 4096
                    || path
                        .components()
                        .any(|part| !matches!(part, Component::Normal(_)))
            })
            || paths
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != paths.len()
            || self.files.iter().any(|file| {
                !file.identity.available()
                    || file.size > 64 * 1024 * 1024
                    || file.sha256.len() != 64
                    || !file
                        .sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    || file.path.parent() != file.temporary_path.parent()
                    || !file
                        .temporary_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            name.strip_prefix(".wts-setup-")
                                .and_then(|name| name.strip_suffix(".tmp"))
                                .is_some_and(|id| Uuid::parse_str(id).is_ok())
                        })
            })
        {
            return Err(io::Error::other("The saved setup file record is invalid."));
        }
        Ok(())
    }

    fn root_exists(&self) -> io::Result<bool> {
        let metadata = match fs::symlink_metadata(&self.root) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || SavedIdentity::from_metadata(&metadata) != self.root_identity
            || self.root.canonicalize()? != self.root
        {
            return Err(io::Error::other("The workspace path changed."));
        }
        Ok(true)
    }

    fn checked_path(&self, relative: &Path) -> io::Result<Option<PathBuf>> {
        if !self.root_exists()? {
            return Ok(None);
        }
        let mut parent = PathBuf::new();
        for component in relative.parent().unwrap_or(Path::new("")).components() {
            parent.push(component);
            let Some(recorded) = self.directories.iter().find(|entry| entry.path == parent) else {
                return Err(io::Error::other("The saved setup parent is unavailable."));
            };
            let full = self.root.join(&parent);
            let metadata = match fs::symlink_metadata(&full) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error),
            };
            if !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || SavedIdentity::from_metadata(&metadata) != recorded.identity
                || full.canonicalize()? != full
            {
                return Err(io::Error::other("The generated directory changed."));
            }
        }
        Ok(Some(self.root.join(relative)))
    }

    fn file_state(&self, relative: &Path, recorded: &SavedFile) -> io::Result<SavedPathState> {
        let Some(path) = self.checked_path(relative)? else {
            return Ok(SavedPathState::Missing);
        };
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(SavedPathState::Missing);
            }
            Err(error) => return Err(error),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || SavedIdentity::from_metadata(&metadata) != recorded.identity
            || metadata.len() != recorded.size
        {
            return Ok(SavedPathState::Preserve);
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(&path)?;
        if SavedIdentity::from_metadata(&file.metadata()?) != recorded.identity
            || file.metadata()?.len() != recorded.size
        {
            return Ok(SavedPathState::Preserve);
        }
        let mut bytes = Vec::new();
        file.take(recorded.size + 1).read_to_end(&mut bytes)?;
        let after = fs::symlink_metadata(&path)?;
        if bytes.len() as u64 != recorded.size
            || hex::encode(Sha256::digest(&bytes)) != recorded.sha256
            || !after.is_file()
            || SavedIdentity::from_metadata(&after) != recorded.identity
            || self.checked_path(relative)?.as_ref() != Some(&path)
        {
            return Ok(SavedPathState::Preserve);
        }
        Ok(SavedPathState::Remove)
    }

    fn directory_state(&self, recorded: &SavedDirectory) -> io::Result<SavedPathState> {
        let Some(path) = self.checked_path(&recorded.path)? else {
            return Ok(SavedPathState::Missing);
        };
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(SavedPathState::Missing);
            }
            Err(error) => return Err(error),
        };
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || SavedIdentity::from_metadata(&metadata) != recorded.identity
        {
            return Ok(SavedPathState::Preserve);
        }
        Ok(if recorded.owned {
            SavedPathState::Remove
        } else {
            SavedPathState::Reuse
        })
    }

    pub(crate) fn inspect(&self) -> io::Result<GeneratedFilesInspection> {
        self.validate()?;
        let mut result = GeneratedFilesInspection::default();
        if !self.root_exists()? {
            result.missing_paths = self.known_paths();
            return Ok(result);
        }
        for file in &self.files {
            for path in [&file.path, &file.temporary_path] {
                match self
                    .file_state(path, file)
                    .unwrap_or(SavedPathState::Preserve)
                {
                    SavedPathState::Remove => result.removable_files.push(path.clone()),
                    SavedPathState::Missing => result.missing_paths.push(path.clone()),
                    _ => result.preserved_paths.push(path.clone()),
                }
            }
        }
        for directory in &self.directories {
            match self
                .directory_state(directory)
                .unwrap_or(SavedPathState::Preserve)
            {
                SavedPathState::Remove => result.removable_directories.push(directory.path.clone()),
                SavedPathState::Missing => result.missing_paths.push(directory.path.clone()),
                SavedPathState::Preserve => result.preserved_paths.push(directory.path.clone()),
                SavedPathState::Reuse => {}
            }
        }
        for intent in &self.intents {
            let missing = match self.checked_path(intent) {
                Ok(None) => true,
                Ok(Some(path)) => fs::symlink_metadata(path)
                    .is_err_and(|error| error.kind() == io::ErrorKind::NotFound),
                Err(_) => false,
            };
            if missing {
                result.missing_paths.push(intent.clone());
            } else {
                result.preserved_paths.push(intent.clone());
            }
        }
        Ok(result)
    }

    /// Remove confirmed unchanged entries. Unknown and unconfirmed entries remain in place.
    pub(crate) fn rollback(&self) -> io::Result<bool> {
        self.validate()?;
        if !self.root_exists()? {
            return Ok(true);
        }
        let mut complete = true;
        for file in self.files.iter().rev() {
            for relative in [&file.path, &file.temporary_path] {
                match self.file_state(relative, file) {
                    Ok(SavedPathState::Missing) => {}
                    Ok(SavedPathState::Remove) => {
                        let removed = self
                            .checked_path(relative)
                            .and_then(|path| path.map_or(Ok(()), fs::remove_file));
                        complete &= removed.is_ok();
                    }
                    _ => complete = false,
                }
            }
        }
        let mut directories = self.directories.iter().collect::<Vec<_>>();
        directories.sort_by_key(|entry| std::cmp::Reverse(entry.path.components().count()));
        for directory in directories {
            match self.directory_state(directory) {
                Ok(SavedPathState::Missing | SavedPathState::Reuse) => {}
                Ok(SavedPathState::Remove) => {
                    let removed = self
                        .checked_path(&directory.path)
                        .and_then(|path| path.map_or(Ok(()), fs::remove_dir));
                    complete &= removed.is_ok();
                }
                _ => complete = false,
            }
        }
        complete &= self.inspect()?.preserved_paths.is_empty();
        Ok(complete)
    }
}

enum SavedPathState {
    Remove,
    Preserve,
    Missing,
    Reuse,
}

fn verify_named_file(path: &Path, recorded: &Metadata) -> io::Result<()> {
    let current = fs::symlink_metadata(path)?;
    if !current.is_file()
        || current.file_type().is_symlink()
        || !same_file(&current, recorded)
        || !same_mode(&current, recorded)
        || current.len() != recorded.len()
    {
        return Err(io::Error::other("The generated file changed."));
    }
    Ok(())
}

#[cfg(unix)]
fn same_mode(left: &Metadata, right: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.mode() == right.mode()
}

#[cfg(not(unix))]
fn same_mode(left: &Metadata, right: &Metadata) -> bool {
    left.permissions().readonly() == right.permissions().readonly()
}

#[cfg(unix)]
fn same_file(left: &Metadata, right: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file(left: &Metadata, right: &Metadata) -> bool {
    matches!((left.created(), right.created()), (Ok(left), Ok(right)) if left == right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn an_observer_parent_replacement_cannot_create_directories_or_temporary_files_outside_the_root()
     {
        for write_file in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let base = directory.path().canonicalize().unwrap();
            let root = base.join("workspace");
            let outside = base.join("outside");
            fs::create_dir(&root).unwrap();
            fs::create_dir(&outside).unwrap();
            fs::create_dir(root.join("existing")).unwrap();
            let observer_root = root.clone();
            let observer_outside = outside.clone();
            let mut generated = GeneratedFiles::new_observed(&root, move |snapshot| {
                if !snapshot.intents.is_empty() {
                    fs::rename(
                        observer_root.join("existing"),
                        observer_root.join("saved-parent"),
                    )?;
                    std::os::unix::fs::symlink(&observer_outside, observer_root.join("existing"))?;
                }
                Ok(())
            })
            .unwrap();
            let result = if write_file {
                generated.write(Path::new("existing/guide.md"), b"must not leave the root")
            } else {
                generated.create_directory(Path::new("existing/plans"))
            };
            assert!(result.is_err());
            assert_eq!(
                fs::read_dir(&outside).unwrap().count(),
                0,
                "The callback replacement must cause zero external filesystem effects."
            );
        }
    }

    fn observed(root: &Path, record: &Path) -> GeneratedFiles {
        let record = record.to_owned();
        GeneratedFiles::new_observed(root, move |snapshot| {
            fs::write(&record, serde_json::to_vec(snapshot)?)
        })
        .unwrap()
    }

    fn reopen(record: &Path) -> GeneratedFilesSnapshot {
        serde_json::from_slice(&fs::read(record).expect("a durable generated-file snapshot"))
            .unwrap()
    }

    #[test]
    fn durable_snapshot_reopens_and_removes_only_confirmed_unchanged_files() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("workspace");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join(".wts")).unwrap();
        let record = directory.path().join("snapshot.json");
        let mut generated = observed(&root, &record);
        generated.create_directory(Path::new(".wts")).unwrap();
        generated.create_directory(Path::new("plans")).unwrap();
        generated
            .write(Path::new(".wts/context.json"), b"context")
            .unwrap();
        generated
            .write(Path::new("plans/PLAN.md"), b"plan")
            .unwrap();
        generated.write(Path::new("guide.md"), b"guide").unwrap();
        drop(generated);
        fs::write(root.join("guide.md"), b"user guide").unwrap();
        fs::write(root.join("unknown.txt"), b"user notes").unwrap();
        let saved = reopen(&record);
        assert_eq!(saved.root(), root);
        assert!(
            saved
                .known_paths()
                .contains(&PathBuf::from("plans/PLAN.md"))
        );
        assert!(!saved.known_paths().contains(&PathBuf::from("unknown.txt")));
        let inspection = saved.inspect().unwrap();
        assert_eq!(inspection.preserved_paths, [PathBuf::from("guide.md")]);
        assert!(
            inspection
                .removable_files
                .contains(&PathBuf::from(".wts/context.json"))
        );
        assert!(!saved.rollback().unwrap());
        assert!(!root.join("plans").exists());
        assert!(root.join(".wts").is_dir());
        assert_eq!(fs::read(root.join("guide.md")).unwrap(), b"user guide");
        assert_eq!(fs::read(root.join("unknown.txt")).unwrap(), b"user notes");
        assert!(
            saved
                .inspect()
                .unwrap()
                .missing_paths
                .contains(&PathBuf::from("plans/PLAN.md"))
        );
    }

    #[test]
    fn observer_failure_prevents_unrecorded_directory_and_file_effects() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        assert!(
            GeneratedFiles::new_observed(&root, |_| Err(io::Error::other("journal unavailable")))
                .is_err()
        );
        let mut directory_write = GeneratedFiles::new_observed(&root, |snapshot| {
            if !snapshot.intents.is_empty() {
                return Err(io::Error::other("journal unavailable"));
            }
            Ok(())
        })
        .unwrap();
        assert!(
            directory_write
                .create_directory(Path::new("plans"))
                .is_err()
        );
        assert!(!root.join("plans").exists());
        let mut file_write = GeneratedFiles::new_observed(&root, |snapshot| {
            if !snapshot.files.is_empty() {
                return Err(io::Error::other("journal unavailable"));
            }
            Ok(())
        })
        .unwrap();
        assert!(file_write.write(Path::new("guide.md"), b"guide").is_err());
        assert!(!root.join("guide.md").exists());
    }

    #[test]
    fn saved_inode_covers_a_stop_before_or_after_file_publication() {
        for after_publication in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap().join("workspace");
            fs::create_dir(&root).unwrap();
            let record = directory.path().join("snapshot.json");
            let observer_record = record.clone();
            let mut generated = GeneratedFiles::new_observed(&root, move |snapshot| {
                fs::write(&observer_record, serde_json::to_vec(snapshot)?)?;
                if !after_publication && !snapshot.files.is_empty() {
                    panic!("stop after the durable inode record and before publication");
                }
                Ok(())
            })
            .unwrap();
            if after_publication {
                generated.after_publish = Some(Box::new(|_| panic!("stop after publication")));
            }
            let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                generated
                    .write(Path::new("guide.md"), b"private generated contents")
                    .unwrap();
            }));
            assert!(stopped.is_err());
            drop(generated);
            assert_eq!(root.join("guide.md").exists(), after_publication);
            let bytes = fs::read(&record).unwrap();
            assert!(!String::from_utf8_lossy(&bytes).contains("private generated contents"));
            let saved = reopen(&record);
            assert!(saved.inspect().unwrap().preserved_paths.is_empty());
            assert_eq!(
                saved.inspect().unwrap().removable_files.len(),
                if after_publication { 2 } else { 1 }
            );
            assert!(saved.rollback().unwrap());
            assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
            assert!(saved.rollback().unwrap());
        }
    }

    #[test]
    fn an_unconfirmed_directory_or_temporary_file_stays_visible_and_is_preserved() {
        for directory_intent in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap().join("workspace");
            fs::create_dir(&root).unwrap();
            let record = directory.path().join("snapshot.json");
            let observer_record = record.clone();
            let mut generated = GeneratedFiles::new_observed(&root, move |snapshot| {
                if directory_intent && !snapshot.directories.is_empty() {
                    return Err(io::Error::other(
                        "the directory identity could not be saved",
                    ));
                }
                fs::write(&observer_record, serde_json::to_vec(snapshot)?)
            })
            .unwrap();
            if directory_intent {
                assert!(generated.create_directory(Path::new("plans")).is_err());
            } else {
                generated.before_publish =
                    Some(Box::new(|_| panic!("stop before the inode record")));
                assert!(
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        generated
                            .write(Path::new("guide.md"), b"preserve incomplete work")
                            .unwrap();
                    }))
                    .is_err()
                );
            }
            drop(generated);
            let saved = reopen(&record);
            let inspected = saved.inspect().unwrap();
            assert_eq!(inspected.preserved_paths, saved.known_paths());
            assert_eq!(inspected.preserved_paths.len(), 1);
            let preserved = root.join(&inspected.preserved_paths[0]);
            assert!(preserved.exists());
            assert!(!saved.rollback().unwrap());
            assert!(preserved.exists());
            if directory_intent {
                assert!(preserved.is_dir());
            } else {
                assert_eq!(fs::read(preserved).unwrap(), b"preserve incomplete work");
            }
        }
    }

    #[test]
    fn saved_snapshot_rejects_replaced_parents_even_with_the_original_file_inode() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("workspace");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("existing")).unwrap();
        let record = directory.path().join("snapshot.json");
        let mut generated = observed(&root, &record);
        // The caller can use an existing parent without claiming ownership of it.
        generated
            .write(Path::new("existing/guide.md"), b"guide")
            .unwrap();
        drop(generated);
        fs::rename(root.join("existing"), root.join("moved")).unwrap();
        fs::create_dir(root.join("existing")).unwrap();
        fs::hard_link(root.join("moved/guide.md"), root.join("existing/guide.md")).unwrap();
        let saved = reopen(&record);
        assert!(
            saved
                .inspect()
                .unwrap()
                .preserved_paths
                .contains(&PathBuf::from("existing/guide.md"))
        );
        assert!(!saved.rollback().unwrap());
        assert_eq!(fs::read(root.join("existing/guide.md")).unwrap(), b"guide");
        assert_eq!(fs::read(root.join("moved/guide.md")).unwrap(), b"guide");
    }

    #[test]
    fn saved_snapshot_handles_missing_roots_and_rejects_changed_roots_or_unsafe_records() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("workspace");
        fs::create_dir(&root).unwrap();
        let record = directory.path().join("snapshot.json");
        let mut generated = observed(&root, &record);
        generated.write(Path::new("guide.md"), b"guide").unwrap();
        drop(generated);
        let saved = reopen(&record);
        fs::rename(&root, directory.path().join("saved-workspace")).unwrap();
        assert_eq!(saved.inspect().unwrap().missing_paths, saved.known_paths());
        assert!(saved.rollback().unwrap());
        fs::create_dir(&root).unwrap();
        fs::write(root.join("guide.md"), b"replacement workspace").unwrap();
        assert!(saved.inspect().is_err());
        assert!(saved.rollback().is_err());
        assert_eq!(
            fs::read(root.join("guide.md")).unwrap(),
            b"replacement workspace"
        );
        let mut malformed = saved;
        malformed.files[0].path = PathBuf::from("../snapshot.json");
        assert!(malformed.rollback().is_err());
        assert!(record.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn saved_snapshot_preserves_changed_modes_after_serialization() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("workspace");
        fs::create_dir(&root).unwrap();
        let record = directory.path().join("snapshot.json");
        let mut generated = observed(&root, &record);
        generated.write(Path::new("guide.md"), b"guide").unwrap();
        drop(generated);
        let mode = fs::metadata(root.join("guide.md")).unwrap().mode() ^ 0o100;
        fs::set_permissions(root.join("guide.md"), fs::Permissions::from_mode(mode)).unwrap();
        let saved = reopen(&record);
        assert_eq!(
            saved.inspect().unwrap().preserved_paths,
            [PathBuf::from("guide.md")]
        );
        assert!(!saved.rollback().unwrap());
        assert_eq!(fs::metadata(root.join("guide.md")).unwrap().mode(), mode);
        assert_eq!(fs::read(root.join("guide.md")).unwrap(), b"guide");
    }

    #[test]
    fn saved_snapshot_rejects_unavailable_file_or_directory_creation_identity() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap().join("workspace");
        fs::create_dir(&root).unwrap();
        let record = directory.path().join("snapshot.json");
        let mut generated = observed(&root, &record);
        generated.create_directory(Path::new("plans")).unwrap();
        generated
            .write(Path::new("plans/PLAN.md"), b"keep these bytes")
            .unwrap();
        drop(generated);
        let saved = fs::read(&record).unwrap();
        for field in ["files", "directories"] {
            let mut value: serde_json::Value = serde_json::from_slice(&saved).unwrap();
            value[field][0]["identity"]["identity"] = "created:Err(Unsupported)".into();
            fs::write(&record, serde_json::to_vec(&value).unwrap()).unwrap();
            let unavailable = reopen(&record);
            assert!(unavailable.inspect().is_err());
            assert!(unavailable.rollback().is_err());
            assert_eq!(
                fs::read(root.join("plans/PLAN.md")).unwrap(),
                b"keep these bytes"
            );
        }
    }

    #[test]
    fn an_observer_edit_to_temporary_bytes_is_neither_published_nor_deleted() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let mut generated = GeneratedFiles::new_observed(&root, |snapshot| {
            if let Some(file) = snapshot.files.last() {
                fs::write(snapshot.root().join(&file.temporary_path), b"changed")?;
            }
            Ok(())
        })
        .unwrap();
        assert!(generated.write(Path::new("guide.md"), b"created").is_err());
        assert!(!root.join("guide.md").exists());
        let entries = fs::read_dir(&root)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(fs::read(entries[0].path()).unwrap(), b"changed");
        assert!(!generated.rollback());
        assert_eq!(fs::read(entries[0].path()).unwrap(), b"changed");
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, GeneratedFiles) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let generated = GeneratedFiles::new(&root).unwrap();
        (directory, root, generated)
    }

    #[test]
    fn rollback_removes_owned_files_and_keeps_reused_directories() {
        let (_fixture, root, mut generated) = fixture();
        fs::create_dir(root.join(".wts")).unwrap();
        generated.create_directory(Path::new(".wts")).unwrap();
        generated.create_directory(Path::new(".github")).unwrap();
        generated
            .write(Path::new(".wts/context.json"), b"context")
            .unwrap();
        generated
            .write(Path::new(".github/guide.md"), b"guide")
            .unwrap();
        assert!(generated.rollback());
        assert!(root.join(".wts").is_dir());
        assert!(!root.join(".wts/context.json").exists());
        assert!(!root.join(".github").exists());
    }

    #[test]
    fn exclusive_write_preserves_an_existing_destination() {
        let (_fixture, root, mut generated) = fixture();
        fs::write(root.join("guide.md"), b"user guide").unwrap();
        assert!(
            generated
                .write(Path::new("guide.md"), b"generated")
                .is_err()
        );
        assert!(generated.rollback());
        assert_eq!(fs::read(root.join("guide.md")).unwrap(), b"user guide");
        assert_eq!(fs::read_dir(root).unwrap().count(), 1);
    }

    #[test]
    fn rollback_preserves_edited_or_replaced_files() {
        for replaced in [false, true] {
            let (_fixture, root, mut generated) = fixture();
            generated
                .write(Path::new("guide.md"), b"generated")
                .unwrap();
            if replaced {
                fs::rename(root.join("guide.md"), root.join("original.md")).unwrap();
            }
            let bytes: &[u8] = if replaced { b"generated" } else { b"edited" };
            fs::write(root.join("guide.md"), bytes).unwrap();
            assert!(!generated.rollback());
            assert_eq!(fs::read(root.join("guide.md")).unwrap(), bytes);
        }
    }

    #[cfg(unix)]
    #[test]
    fn rollback_preserves_a_file_after_chmod() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let (_fixture, root, mut generated) = fixture();
        generated
            .write(Path::new("guide.md"), b"generated")
            .unwrap();
        let path = root.join("guide.md");
        let mode = fs::metadata(&path).unwrap().mode() ^ 0o100;
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        assert!(!generated.rollback());
        assert_eq!(fs::read(&path).unwrap(), b"generated");
        assert_eq!(fs::metadata(&path).unwrap().mode(), mode);
    }

    #[test]
    fn a_replaced_reused_parent_blocks_write_and_rollback() {
        let (_fixture, root, mut generated) = fixture();
        fs::create_dir(root.join(".wts")).unwrap();
        generated.create_directory(Path::new(".wts")).unwrap();
        generated
            .write(Path::new(".wts/context.json"), b"context")
            .unwrap();
        fs::rename(root.join(".wts"), root.join("original")).unwrap();
        fs::create_dir(root.join(".wts")).unwrap();
        fs::hard_link(
            root.join("original/context.json"),
            root.join(".wts/context.json"),
        )
        .unwrap();
        assert!(
            generated
                .write(Path::new(".wts/next.json"), b"next")
                .is_err()
        );
        assert!(!generated.rollback());
        assert_eq!(
            fs::read(root.join(".wts/context.json")).unwrap(),
            b"context"
        );
        assert!(!root.join(".wts/next.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_parent_blocks_write_and_rollback() {
        let (_fixture, root, mut generated) = fixture();
        generated.create_directory(Path::new(".github")).unwrap();
        generated
            .write(Path::new(".github/guide.md"), b"guide")
            .unwrap();
        fs::rename(root.join(".github"), root.join("original")).unwrap();
        std::os::unix::fs::symlink(root.join("original"), root.join(".github")).unwrap();
        assert!(
            generated
                .write(Path::new(".github/next.md"), b"next")
                .is_err()
        );
        assert!(!generated.rollback());
        assert_eq!(fs::read(root.join("original/guide.md")).unwrap(), b"guide");
    }

    #[test]
    fn a_replaced_temporary_name_is_not_published_or_removed() {
        let (_fixture, root, mut generated) = fixture();
        generated.before_publish = Some(Box::new(|path| {
            fs::rename(path, path.with_extension("saved")).unwrap();
            fs::write(path, b"unknown temporary").unwrap();
        }));
        assert!(
            generated
                .write(Path::new("guide.md"), b"generated")
                .is_err()
        );
        assert!(!root.join("guide.md").exists());
        let temporary = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.extension().is_some_and(|extension| extension == "tmp"))
            .unwrap();
        assert!(!generated.rollback());
        assert_eq!(fs::read(temporary).unwrap(), b"unknown temporary");
    }

    #[test]
    fn a_replaced_published_target_is_not_accepted_or_removed() {
        let (_fixture, root, mut generated) = fixture();
        generated.after_publish = Some(Box::new(|path| {
            fs::rename(path, path.with_extension("saved")).unwrap();
            fs::write(path, b"user replacement").unwrap();
        }));
        assert!(
            generated
                .write(Path::new("guide.md"), b"generated")
                .is_err()
        );
        assert!(!generated.rollback());
        assert_eq!(
            fs::read(root.join("guide.md")).unwrap(),
            b"user replacement"
        );
    }
}
