use std::path::Path;

use serde::Serialize;

use crate::{GitError, GitWorktreeService};

pub const MAX_WORKTREE_SOURCE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSource {
    pub file_path: String,
    pub content: String,
    pub revision: String,
}

impl GitWorktreeService {
    #[allow(
        clippy::too_many_arguments,
        reason = "The file and root expectations are separate trust checks."
    )]
    pub fn restore_worktree_bytes_checked(
        &self,
        root: &Path,
        file_path: &str,
        content: Option<&[u8]>,
        mode: Option<u32>,
        expected_sha256: Option<&str>,
        expected_mode: Option<u32>,
        expected_root_identity: &str,
    ) -> Result<(), GitError> {
        source::restore_raw_checked(
            root,
            file_path,
            content,
            mode,
            expected_sha256,
            expected_mode,
            Some(expected_root_identity),
        )
    }
    pub(crate) fn checkpoint_source_bytes(
        &self,
        root: &Path,
        file_path: &str,
    ) -> Result<Option<(Vec<u8>, u32)>, GitError> {
        source::checkpoint_bytes(root, file_path)
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "The file and root expectations are separate trust checks."
    )]
    pub fn restore_worktree_source_checked(
        &self,
        root: &Path,
        file_path: &str,
        content: Option<&str>,
        mode: Option<u32>,
        expected_sha256: Option<&str>,
        expected_mode: Option<u32>,
        expected_root_identity: &str,
    ) -> Result<(), GitError> {
        source::restore_checked(
            root,
            file_path,
            content,
            mode,
            expected_sha256,
            expected_mode,
            Some(expected_root_identity),
        )
    }
    pub fn prepare_worktree_source_parent_checked(
        &self,
        root: &Path,
        file_path: &str,
        expected_root_identity: &str,
    ) -> Result<(), GitError> {
        source::prepare_parent_checked(root, file_path, Some(expected_root_identity))
    }
    /// Create missing parents inside a host-owned checkout without following links.
    pub fn prepare_worktree_source_parent(
        &self,
        root: &Path,
        file_path: &str,
    ) -> Result<(), GitError> {
        source::prepare_parent(root, file_path)
    }
    pub fn read_worktree_source(
        &self,
        root: impl AsRef<Path>,
        file_path: &str,
    ) -> Result<WorktreeSource, GitError> {
        source::read(root.as_ref(), file_path)
    }

    /// Restore captured text only while the current bytes and mode still match.
    pub fn restore_worktree_source(
        &self,
        root: &Path,
        file_path: &str,
        content: Option<&str>,
        mode: Option<u32>,
        expected_sha256: Option<&str>,
        expected_mode: Option<u32>,
    ) -> Result<(), GitError> {
        source::restore(
            root,
            file_path,
            content,
            mode,
            expected_sha256,
            expected_mode,
        )
    }

    pub fn save_worktree_source(
        &self,
        root: impl AsRef<Path>,
        file_path: &str,
        content: &str,
        expected_revision: &str,
    ) -> Result<WorktreeSource, GitError> {
        source::save(root.as_ref(), file_path, content, expected_revision)
    }
}

#[cfg(unix)]
mod source {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        ffi::CString,
        fs::{File, Metadata, OpenOptions},
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
        sync::{
            Mutex,
            atomic::{AtomicU64, Ordering},
        },
    };

    static SAVES: Mutex<()> = Mutex::new(());
    static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[cfg(test)]
    thread_local! { static BEFORE_PUBLISH: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None); }

    fn components(file_path: &str) -> Result<Vec<CString>, GitError> {
        if file_path.is_empty()
            || file_path.len() > 4096
            || file_path.contains('\\')
            || file_path.chars().any(char::is_control)
        {
            return Err(GitError::InvalidWorktreeFilePath);
        }
        let parts = file_path.split('/').collect::<Vec<_>>();
        if parts.len() > 64
            || parts.iter().any(|part| {
                part.is_empty()
                    || *part == "."
                    || *part == ".."
                    || part.eq_ignore_ascii_case(".git")
            })
        {
            return Err(GitError::InvalidWorktreeFilePath);
        }
        parts
            .into_iter()
            .map(|part| CString::new(part).map_err(|_| GitError::InvalidWorktreeFilePath))
            .collect()
    }

    fn open_at(
        parent: &File,
        name: &CString,
        flags: i32,
        mode: libc::c_uint,
    ) -> Result<File, GitError> {
        // The directory descriptor confines each lookup. O_NOFOLLOW rejects links.
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                mode,
            )
        };
        if fd < 0 {
            return Err(GitError::WorktreeFileUnavailable);
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn open_root(root: &Path, expected_identity: Option<&str>) -> Result<File, GitError> {
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)
            .map_err(|_| GitError::WorktreeFileUnavailable)?;
        if let Some(expected) = expected_identity {
            let metadata = directory.metadata().map_err(|_| GitError::Filesystem)?;
            let observed = format!(
                "sha256:{:x}",
                Sha256::digest(
                    format!("{}:{}:{}", root.display(), metadata.dev(), metadata.ino()).as_bytes()
                )
            );
            if observed != expected {
                return Err(GitError::WorktreeFileConflict);
            }
        }
        Ok(directory)
    }
    fn parent(root: &Path, parts: &[CString]) -> Result<File, GitError> {
        parent_checked(root, parts, None)
    }
    fn parent_checked(
        root: &Path,
        parts: &[CString],
        expected_identity: Option<&str>,
    ) -> Result<File, GitError> {
        let mut directory = open_root(root, expected_identity)?;
        for component in &parts[..parts.len() - 1] {
            directory = open_at(&directory, component, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        }
        Ok(directory)
    }
    pub fn prepare_parent(root: &Path, file_path: &str) -> Result<(), GitError> {
        prepare_parent_checked(root, file_path, None)
    }
    pub fn prepare_parent_checked(
        root: &Path,
        file_path: &str,
        expected_identity: Option<&str>,
    ) -> Result<(), GitError> {
        let parts = components(file_path)?;
        let mut directory = open_root(root, expected_identity)?;
        for component in &parts[..parts.len() - 1] {
            if unsafe { libc::mkdirat(directory.as_raw_fd(), component.as_ptr(), 0o755) } != 0
                && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
            {
                return Err(GitError::WorktreeFileUnavailable);
            }
            directory = open_at(&directory, component, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        }
        Ok(())
    }

    fn revision(metadata: &Metadata, bytes: &[u8]) -> String {
        let mut digest = Sha256::new();
        for value in [
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime() as u64,
            metadata.mtime_nsec() as u64,
            metadata.ctime() as u64,
            metadata.ctime_nsec() as u64,
            u64::from(metadata.mode()),
        ] {
            digest.update(value.to_le_bytes());
        }
        digest.update(bytes);
        format!("sha256:{:x}", digest.finalize())
    }

    struct RawSource {
        content: Vec<u8>,
        revision: String,
    }
    fn text_source(source: RawSource, file_path: &str) -> Result<WorktreeSource, GitError> {
        if source.content.contains(&0) {
            return Err(GitError::WorktreeFileNotUtf8);
        }
        Ok(WorktreeSource {
            file_path: file_path.to_owned(),
            content: String::from_utf8(source.content)
                .map_err(|_| GitError::WorktreeFileNotUtf8)?,
            revision: source.revision,
        })
    }
    fn read_at(
        parent: &File,
        leaf: &CString,
        file_path: &str,
    ) -> Result<(WorktreeSource, Metadata), GitError> {
        let (source, metadata) = read_at_raw(parent, leaf, file_path)?;
        Ok((text_source(source, file_path)?, metadata))
    }
    fn read_at_raw(
        parent: &File,
        leaf: &CString,
        _file_path: &str,
    ) -> Result<(RawSource, Metadata), GitError> {
        let file = open_at(parent, leaf, libc::O_RDONLY | libc::O_NONBLOCK, 0)?;
        let before = file.metadata().map_err(|_| GitError::Filesystem)?;
        if !before.is_file() {
            return Err(GitError::WorktreeFileUnavailable);
        }
        if before.len() > MAX_WORKTREE_SOURCE_BYTES as u64 {
            return Err(GitError::WorktreeFileTooLarge);
        }
        let mut bytes = Vec::new();
        (&file)
            .take((MAX_WORKTREE_SOURCE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| GitError::Filesystem)?;
        if bytes.len() > MAX_WORKTREE_SOURCE_BYTES {
            return Err(GitError::WorktreeFileTooLarge);
        }
        let after = file.metadata().map_err(|_| GitError::Filesystem)?;
        if revision(&before, &bytes) != revision(&after, &bytes) {
            return Err(GitError::WorktreeFileConflict);
        }
        let revision = revision(&after, &bytes);
        let content = bytes;
        Ok((RawSource { content, revision }, after))
    }

    pub(super) fn read(root: &Path, file_path: &str) -> Result<WorktreeSource, GitError> {
        let parts = components(file_path)?;
        let directory = parent(root, &parts)?;
        read_at(&directory, parts.last().expect("validated path"), file_path)
            .map(|(source, _)| source)
    }

    pub(super) fn checkpoint_bytes(
        root: &Path,
        file_path: &str,
    ) -> Result<Option<(Vec<u8>, u32)>, GitError> {
        Ok(checkpoint_raw_checked(root, file_path, None)?
            .map(|(source, mode)| (source.content, mode)))
    }
    fn checkpoint_raw_checked(
        root: &Path,
        file_path: &str,
        expected_identity: Option<&str>,
    ) -> Result<Option<(RawSource, u32)>, GitError> {
        let parts = components(file_path)?;
        let mut directory = open_root(root, expected_identity)?;
        for component in &parts[..parts.len() - 1] {
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    component.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                    Ok(None)
                } else {
                    Err(GitError::WorktreeFileUnavailable)
                };
            }
            directory = unsafe { File::from_raw_fd(fd) };
        }
        let leaf = parts.last().expect("validated path");
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                directory.as_raw_fd(),
                leaf.as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } < 0
        {
            return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(GitError::WorktreeFileUnavailable)
            };
        }
        let (source, metadata) = read_at_raw(&directory, leaf, file_path)?;
        Ok(Some((source, metadata.mode() & 0o777)))
    }

    pub(super) fn save(
        root: &Path,
        file_path: &str,
        content: &str,
        expected_revision: &str,
    ) -> Result<WorktreeSource, GitError> {
        save_with_mode(root, file_path, content, expected_revision, None, None)
    }

    fn save_with_mode(
        root: &Path,
        file_path: &str,
        content: &str,
        expected_revision: &str,
        mode: Option<u32>,
        expected_identity: Option<&str>,
    ) -> Result<WorktreeSource, GitError> {
        if content.contains('\0') {
            return Err(GitError::WorktreeFileNotUtf8);
        }
        text_source(
            save_raw_with_mode(
                root,
                file_path,
                content.as_bytes(),
                expected_revision,
                mode,
                expected_identity,
            )?,
            file_path,
        )
    }
    fn save_raw_with_mode(
        root: &Path,
        file_path: &str,
        content: &[u8],
        expected_revision: &str,
        mode: Option<u32>,
        expected_identity: Option<&str>,
    ) -> Result<RawSource, GitError> {
        let parts = components(file_path)?;
        let hash = expected_revision
            .strip_prefix("sha256:")
            .ok_or(GitError::InvalidWorktreeFileRevision)?;
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(GitError::InvalidWorktreeFileRevision);
        }
        if content.len() > MAX_WORKTREE_SOURCE_BYTES {
            return Err(GitError::WorktreeFileTooLarge);
        }
        let _guard = SAVES.lock().map_err(|_| GitError::Filesystem)?;
        let directory = parent_checked(root, &parts, expected_identity)?;
        let leaf = parts.last().expect("validated path");
        let (current, metadata) = read_at_raw(&directory, leaf, file_path)?;
        if current.revision != expected_revision {
            return Err(GitError::WorktreeFileConflict);
        }
        let name = CString::new(format!(
            ".wts-edit-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
        .expect("temporary name");
        let mut temporary = open_at(
            &directory,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        let result = (|| {
            // mode_t has different widths on Unix hosts.
            #[allow(clippy::unnecessary_cast)]
            let permissions = mode.unwrap_or(metadata.mode() & 0o777) as libc::mode_t;
            if unsafe { libc::fchmod(temporary.as_raw_fd(), permissions) } != 0 {
                return Err(GitError::Filesystem);
            }
            temporary
                .write_all(content)
                .map_err(|_| GitError::Filesystem)?;
            temporary.sync_all().map_err(|_| GitError::Filesystem)?;
            #[cfg(test)]
            BEFORE_PUBLISH.with(|hook| {
                if let Some(hook) = hook.borrow_mut().take() {
                    hook();
                }
            });
            let confirmed_parent = parent_checked(root, &parts, expected_identity)?;
            let confirmed_metadata = confirmed_parent
                .metadata()
                .map_err(|_| GitError::Filesystem)?;
            let parent_metadata = directory.metadata().map_err(|_| GitError::Filesystem)?;
            if confirmed_metadata.dev() != parent_metadata.dev()
                || confirmed_metadata.ino() != parent_metadata.ino()
            {
                return Err(GitError::WorktreeFileConflict);
            }
            if read_at_raw(&directory, leaf, file_path)?.0.revision != expected_revision {
                return Err(GitError::WorktreeFileConflict);
            }
            if unsafe {
                libc::renameat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    directory.as_raw_fd(),
                    leaf.as_ptr(),
                )
            } != 0
            {
                return Err(GitError::Filesystem);
            }
            let saved = read_at_raw(&directory, leaf, file_path)?.0;
            if saved.content != content {
                return Err(GitError::WorktreeFileConflict);
            }
            Ok(saved)
        })();
        // A failed save removes only its own temporary file.
        unsafe {
            libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0);
        }
        result
    }

    fn same_parent(
        root: &Path,
        parts: &[CString],
        directory: &File,
        expected_identity: Option<&str>,
    ) -> Result<(), GitError> {
        let expected = directory.metadata().map_err(|_| GitError::Filesystem)?;
        let current = parent_checked(root, parts, expected_identity)?
            .metadata()
            .map_err(|_| GitError::Filesystem)?;
        if expected.dev() != current.dev() || expected.ino() != current.ino() {
            return Err(GitError::WorktreeFileConflict);
        }
        Ok(())
    }

    pub(super) fn restore(
        root: &Path,
        file_path: &str,
        content: Option<&str>,
        mode: Option<u32>,
        expected_sha256: Option<&str>,
        expected_mode: Option<u32>,
    ) -> Result<(), GitError> {
        restore_checked(
            root,
            file_path,
            content,
            mode,
            expected_sha256,
            expected_mode,
            None,
        )
    }
    pub(super) fn restore_checked(
        root: &Path,
        file_path: &str,
        content: Option<&str>,
        mode: Option<u32>,
        expected_sha256: Option<&str>,
        expected_mode: Option<u32>,
        expected_identity: Option<&str>,
    ) -> Result<(), GitError> {
        if content.is_some_and(|content| content.contains('\0')) {
            return Err(GitError::WorktreeFileNotUtf8);
        }
        restore_raw_checked(
            root,
            file_path,
            content.map(str::as_bytes),
            mode,
            expected_sha256,
            expected_mode,
            expected_identity,
        )
    }
    pub(super) fn restore_raw_checked(
        root: &Path,
        file_path: &str,
        content: Option<&[u8]>,
        mode: Option<u32>,
        expected_sha256: Option<&str>,
        expected_mode: Option<u32>,
        expected_identity: Option<&str>,
    ) -> Result<(), GitError> {
        let parts = components(file_path)?;
        if content.is_some_and(|text| text.len() > MAX_WORKTREE_SOURCE_BYTES)
            || mode.is_some_and(|mode| mode > 0o777)
            || content.is_some() != mode.is_some()
        {
            return Err(GitError::WorktreeFileUnavailable);
        }
        let current = checkpoint_raw_checked(root, file_path, expected_identity)?;
        let current_hash = current
            .as_ref()
            .map(|(source, _)| format!("sha256:{:x}", Sha256::digest(&source.content)));
        if current_hash.as_deref() != expected_sha256
            || current.as_ref().map(|(_, mode)| *mode) != expected_mode
        {
            return Err(GitError::WorktreeFileConflict);
        }
        if let (Some((current, _)), Some(content)) = (&current, content) {
            return save_raw_with_mode(
                root,
                file_path,
                content,
                &current.revision,
                mode,
                expected_identity,
            )
            .map(|_| ());
        }
        let _guard = SAVES.lock().map_err(|_| GitError::Filesystem)?;
        let directory = parent_checked(root, &parts, expected_identity)?;
        let leaf = parts.last().expect("validated path");
        if let Some((current, _)) = current {
            #[cfg(test)]
            BEFORE_PUBLISH.with(|hook| {
                if let Some(hook) = hook.borrow_mut().take() {
                    hook();
                }
            });
            same_parent(root, &parts, &directory, expected_identity)?;
            if read_at_raw(&directory, leaf, file_path)?.0.revision != current.revision {
                return Err(GitError::WorktreeFileConflict);
            }
            if unsafe { libc::unlinkat(directory.as_raw_fd(), leaf.as_ptr(), 0) } != 0 {
                return Err(GitError::Filesystem);
            }
            return directory.sync_all().map_err(|_| GitError::Filesystem);
        }
        let Some(content) = content else {
            return Ok(());
        };
        let name = CString::new(format!(
            ".wts-restore-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
        .expect("temporary name");
        let mut temporary = open_at(
            &directory,
            &name,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        let result = (|| {
            #[allow(clippy::unnecessary_cast)]
            let permissions = mode.unwrap_or(0o644) as libc::mode_t;
            if unsafe { libc::fchmod(temporary.as_raw_fd(), permissions) } != 0 {
                return Err(GitError::Filesystem);
            }
            temporary
                .write_all(content)
                .and_then(|_| temporary.sync_all())
                .map_err(|_| GitError::Filesystem)?;
            #[cfg(test)]
            BEFORE_PUBLISH.with(|hook| {
                if let Some(hook) = hook.borrow_mut().take() {
                    hook();
                }
            });
            same_parent(root, &parts, &directory, expected_identity)?;
            // linkat creates the destination only if it is still absent.
            if unsafe {
                libc::linkat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    directory.as_raw_fd(),
                    leaf.as_ptr(),
                    0,
                )
            } != 0
            {
                return Err(GitError::WorktreeFileConflict);
            }
            directory.sync_all().map_err(|_| GitError::Filesystem)
        })();
        unsafe {
            libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0);
        }
        result
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            os::unix::fs::{PermissionsExt, symlink},
        };

        #[test]
        fn checked_restore_rejects_replaced_root_before_modify_delete_create_or_mkdir() {
            let fixture = tempfile::tempdir().unwrap();
            let root = fixture.path().join("target");
            fs::create_dir(&root).unwrap();
            fs::write(root.join("file.txt"), "after").unwrap();
            let metadata = fs::metadata(&root).unwrap();
            let identity = format!(
                "sha256:{:x}",
                Sha256::digest(
                    format!("{}:{}:{}", root.display(), metadata.dev(), metadata.ino()).as_bytes()
                )
            );
            fs::rename(&root, fixture.path().join("original")).unwrap();
            fs::create_dir(&root).unwrap();
            fs::write(root.join("file.txt"), "after").unwrap();
            let mode = fs::metadata(root.join("file.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let hash = format!("sha256:{:x}", Sha256::digest(b"after"));
            assert!(
                GitWorktreeService
                    .restore_worktree_source_checked(
                        &root,
                        "file.txt",
                        Some("before"),
                        Some(mode),
                        Some(&hash),
                        Some(mode),
                        &identity
                    )
                    .is_err()
            );
            assert!(
                GitWorktreeService
                    .restore_worktree_source_checked(
                        &root,
                        "file.txt",
                        None,
                        None,
                        Some(&hash),
                        Some(mode),
                        &identity
                    )
                    .is_err()
            );
            assert!(
                GitWorktreeService
                    .restore_worktree_source_checked(
                        &root,
                        "new.txt",
                        Some("before"),
                        Some(mode),
                        None,
                        None,
                        &identity
                    )
                    .is_err()
            );
            assert!(
                GitWorktreeService
                    .prepare_worktree_source_parent_checked(&root, "nested/new.txt", &identity)
                    .is_err()
            );
            assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "after");
            assert_eq!(
                fs::read_to_string(fixture.path().join("original/file.txt")).unwrap(),
                "after"
            );
            assert!(!root.join("new.txt").exists());
            assert!(!root.join("nested").exists());
        }

        #[test]
        fn checkpoint_restore_rechecks_concurrent_delete_create_and_parent_changes() {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("file.txt");
            fs::write(&path, "after task").unwrap();
            let hash = format!("sha256:{:x}", Sha256::digest(b"after task"));
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            let changed = path.clone();
            BEFORE_PUBLISH.with(|hook| {
                hook.borrow_mut()
                    .replace(Box::new(move || fs::write(changed, "later edit").unwrap()));
            });
            assert_eq!(
                restore(root.path(), "file.txt", None, None, Some(&hash), Some(mode)),
                Err(GitError::WorktreeFileConflict)
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), "later edit");
            let created = root.path().join("new.txt");
            let concurrent = created.clone();
            BEFORE_PUBLISH.with(|hook| {
                hook.borrow_mut().replace(Box::new(move || {
                    fs::write(concurrent, "new user file").unwrap()
                }));
            });
            assert_eq!(
                restore(
                    root.path(),
                    "new.txt",
                    Some("captured before"),
                    Some(0o644),
                    None,
                    None
                ),
                Err(GitError::WorktreeFileConflict)
            );
            assert_eq!(fs::read_to_string(created).unwrap(), "new user file");
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("secret"), "outside").unwrap();
            symlink(outside.path(), root.path().join("linked")).unwrap();
            assert!(
                restore(
                    root.path(),
                    "linked/secret",
                    None,
                    None,
                    Some(&hash),
                    Some(mode)
                )
                .is_err()
            );
            assert_eq!(
                fs::read_to_string(outside.path().join("secret")).unwrap(),
                "outside"
            );
        }

        #[test]
        fn source_save_preserves_mode_and_rejects_a_stale_agent_edit() {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("source.sh");
            fs::write(&path, "first\n").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            let initial = read(root.path(), "source.sh").unwrap();
            let saved = save(root.path(), "source.sh", "second\n", &initial.revision).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), "second\n");
            assert_ne!(saved.revision, initial.revision);
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o755
            );
            fs::write(&path, "agent change\n").unwrap();
            assert_eq!(
                save(root.path(), "source.sh", "stale editor\n", &saved.revision),
                Err(GitError::WorktreeFileConflict)
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), "agent change\n");
            assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        }

        #[test]
        fn source_save_rechecks_agent_changes_before_publication() {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("source.rs");
            fs::write(&path, "first").unwrap();
            let source = read(root.path(), "source.rs").unwrap();
            let agent_path = path.clone();
            BEFORE_PUBLISH.with(|hook| {
                hook.borrow_mut().replace(Box::new(move || {
                    fs::write(agent_path, "agent change").unwrap()
                }))
            });
            assert_eq!(
                save(root.path(), "source.rs", "editor change", &source.revision),
                Err(GitError::WorktreeFileConflict)
            );
            assert_eq!(fs::read_to_string(path).unwrap(), "agent change");
        }

        #[test]
        fn source_access_rejects_metadata_links_binary_and_large_files() {
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("secret"), "outside").unwrap();
            symlink(outside.path(), root.path().join("linked")).unwrap();
            for path in [
                "../secret",
                ".git/config",
                "nested/.GiT/config",
                "/secret",
                "linked/secret",
            ] {
                assert!(read(root.path(), path).is_err());
            }
            fs::write(root.path().join("binary"), [0, 1]).unwrap();
            assert_eq!(
                read(root.path(), "binary"),
                Err(GitError::WorktreeFileNotUtf8)
            );
            fs::write(
                root.path().join("large"),
                vec![b'x'; MAX_WORKTREE_SOURCE_BYTES + 1],
            )
            .unwrap();
            assert_eq!(
                read(root.path(), "large"),
                Err(GitError::WorktreeFileTooLarge)
            );
            assert!(read(root.path(), "missing").is_err());
            assert_eq!(
                fs::read_to_string(outside.path().join("secret")).unwrap(),
                "outside"
            );
        }

        #[test]
        fn source_save_does_not_follow_a_parent_link_inserted_during_save() {
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            fs::create_dir(root.path().join("src")).unwrap();
            fs::write(root.path().join("src/file"), "inside").unwrap();
            fs::write(outside.path().join("file"), "outside").unwrap();
            let source = read(root.path(), "src/file").unwrap();
            let root_path = root.path().to_owned();
            let outside_path = outside.path().to_owned();
            BEFORE_PUBLISH.with(|hook| {
                hook.borrow_mut().replace(Box::new(move || {
                    fs::rename(root_path.join("src"), root_path.join("old-src")).unwrap();
                    symlink(outside_path, root_path.join("src")).unwrap();
                }))
            });
            assert!(save(root.path(), "src/file", "edit", &source.revision).is_err());
            assert_eq!(
                fs::read_to_string(outside.path().join("file")).unwrap(),
                "outside"
            );
            assert_eq!(
                fs::read_to_string(root.path().join("old-src/file")).unwrap(),
                "inside"
            );
            assert_eq!(
                fs::read_dir(root.path().join("old-src")).unwrap().count(),
                1
            );
        }
    }
}

#[cfg(not(unix))]
mod source {
    use super::*;
    pub(super) fn checkpoint_bytes(_: &Path, _: &str) -> Result<Option<(Vec<u8>, u32)>, GitError> {
        Err(GitError::WorktreeFileUnavailable)
    }
    pub(super) fn restore_raw_checked(
        _: &Path,
        _: &str,
        _: Option<&[u8]>,
        _: Option<u32>,
        _: Option<&str>,
        _: Option<u32>,
        _: Option<&str>,
    ) -> Result<(), GitError> {
        Err(GitError::WorktreeFileUnavailable)
    }
    pub fn prepare_parent_checked(_: &Path, _: &str, _: Option<&str>) -> Result<(), GitError> {
        Err(GitError::WorktreeFileUnavailable)
    }
    pub(super) fn restore_checked(
        _: &Path,
        _: &str,
        _: Option<&str>,
        _: Option<u32>,
        _: Option<&str>,
        _: Option<u32>,
        _: Option<&str>,
    ) -> Result<(), GitError> {
        Err(GitError::WorktreeFileUnavailable)
    }
    pub fn prepare_parent(_: &Path, _: &str) -> Result<(), GitError> {
        Err(GitError::WorktreeFileUnavailable)
    }

    pub(super) fn restore(
        _: &Path,
        _: &str,
        _: Option<&str>,
        _: Option<u32>,
        _: Option<&str>,
        _: Option<u32>,
    ) -> Result<(), GitError> {
        Err(GitError::WorktreeFileUnavailable)
    }
    pub(super) fn read(_: &Path, _: &str) -> Result<WorktreeSource, GitError> {
        Err(GitError::WorktreeFileUnavailable)
    }
    pub(super) fn save(_: &Path, _: &str, _: &str, _: &str) -> Result<WorktreeSource, GitError> {
        Err(GitError::WorktreeFileUnavailable)
    }
}
