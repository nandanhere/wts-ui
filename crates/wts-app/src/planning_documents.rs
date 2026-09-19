use super::*;

const MAX_PLANNING_DIRECTORY_DEPTH: usize = 8;
const MAX_PLANNING_ENTRIES: usize = 4096;
const MAX_PLANNING_RELATIVE_PATH_BYTES: usize = 4096;

fn generated_planning_document_id(relative_path: &str) -> WorkspacePlanningDocumentId {
    let mut hasher = Sha256::new();
    hasher.update(b"wts-planning-document-v1\0");
    hasher.update(relative_path.as_bytes());
    WorkspacePlanningDocumentId::Generated(format!(
        "generated-{}",
        hasher.finalize().encode_hex::<String>()
    ))
}

fn supported_generated_planning_file(file_name: &str) -> bool {
    Path::new(file_name)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "md" | "csv" | "txt" | "mmd" | "mermaid"
            )
        })
}

fn relative_components(relative_path: &str) -> Result<Vec<&str>, LocalWtsError> {
    let components: Vec<_> = relative_path.split('/').collect();
    if relative_path.len() > MAX_PLANNING_RELATIVE_PATH_BYTES
        || relative_path.contains('\\')
        || relative_path.chars().any(char::is_control)
        || components.len() > MAX_PLANNING_DIRECTORY_DEPTH + 1
        || components
            .iter()
            .any(|part| part.is_empty() || matches!(*part, "." | ".."))
    {
        return Err(LocalWtsError::InvalidPlanningDocument);
    }
    Ok(components)
}

fn trusted_path(planning_home: &Path, relative_path: &str) -> Result<PathBuf, LocalWtsError> {
    let components = relative_components(relative_path)?;
    let mut path = planning_home.to_path_buf();
    for component in components {
        path.push(component);
        let metadata =
            fs::symlink_metadata(&path).map_err(|_| LocalWtsError::PlanningDocumentUnavailable)?;
        if metadata.file_type().is_symlink()
            || path.canonicalize().ok().as_deref() != Some(path.as_path())
        {
            return Err(LocalWtsError::InvalidPlanningDocument);
        }
    }
    Ok(path)
}

pub(super) fn discover_generated_planning_documents(
    planning_home: &Path,
    format: WorkspacePlanningFormat,
) -> Result<Vec<WorkspacePlanningDocumentDescriptor>, LocalWtsError> {
    let fixed_file_names: BTreeSet<_> = planning_document_ids(format)
        .iter()
        .filter_map(fixed_planning_document_file_name)
        .collect();
    let mut pending = vec![(PathBuf::new(), 0)];
    let mut budget = MAX_PLANNING_ENTRIES;
    let mut documents = Vec::new();
    while let Some((relative_directory, depth)) = pending.pop() {
        if budget == 0 {
            break;
        }
        let directory = planning_home.join(&relative_directory);
        if !relative_directory.as_os_str().is_empty()
            && trusted_path(
                planning_home,
                &relative_directory
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/"),
            )
            .is_err()
        {
            continue;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) if depth == 0 => return Err(LocalWtsError::InvalidPlanningDocument),
            Err(_) => continue,
        };
        let mut entries: Vec<_> = entries.take(budget).collect();
        budget -= entries.len();
        entries.sort_by_key(|entry| entry.as_ref().ok().map(fs::DirEntry::file_name));
        let mut children = Vec::new();
        for entry in entries.into_iter().flatten() {
            let leaf = entry.file_name();
            let Some(leaf) = leaf.to_str() else { continue };
            let relative = relative_directory.join(leaf);
            let Some(relative) = relative.to_str() else {
                continue;
            };
            // The wire name uses the same separator on every host.
            let relative = relative.replace(std::path::MAIN_SEPARATOR, "/");
            if relative_components(&relative).is_err() {
                continue;
            }
            let Ok(path) = trusted_path(planning_home, &relative) else {
                continue;
            };
            let Ok(metadata) = path.symlink_metadata() else {
                continue;
            };
            if metadata.is_dir() {
                if depth < MAX_PLANNING_DIRECTORY_DEPTH {
                    children.push((PathBuf::from(relative), depth + 1));
                }
                continue;
            }
            if fixed_file_names.contains(relative.as_str())
                || !supported_generated_planning_file(leaf)
                || !metadata.is_file()
                || metadata.len() > MAX_PLANNING_DOCUMENT_BYTES as u64
            {
                continue;
            }
            documents.push(WorkspacePlanningDocumentDescriptor {
                document_id: generated_planning_document_id(&relative),
                file_name: relative,
            });
        }
        pending.extend(children.into_iter().rev());
    }
    documents.sort_by(|left, right| {
        left.file_name
            .to_ascii_lowercase()
            .cmp(&right.file_name.to_ascii_lowercase())
            .then_with(|| left.file_name.cmp(&right.file_name))
    });
    documents.truncate(MAX_DISCOVERED_PLANNING_DOCUMENTS);
    Ok(documents)
}

pub(super) fn resolve_planning_document_file_name(
    planning_home: &Path,
    format: WorkspacePlanningFormat,
    document_id: &WorkspacePlanningDocumentId,
) -> Result<String, LocalWtsError> {
    if let Some(file_name) = fixed_planning_document_file_name(document_id) {
        return planning_document_ids(format)
            .contains(document_id)
            .then(|| file_name.to_owned())
            .ok_or(LocalWtsError::PlanningDocumentUnavailable);
    }
    discover_generated_planning_documents(planning_home, format)?
        .into_iter()
        .find(|document| &document.document_id == document_id)
        .map(|document| document.file_name)
        .ok_or(LocalWtsError::PlanningDocumentUnavailable)
}

pub(super) fn read_planning_document(
    workspace_id: Uuid,
    planning_home: &Path,
    document_id: WorkspacePlanningDocumentId,
    file_name: &str,
) -> Result<WorkspacePlanningDocument, LocalWtsError> {
    let bytes = open_parent(planning_home, file_name)?.read_file()?;
    let sha256 = sha256_bytes(&bytes);
    let contents = String::from_utf8(bytes).map_err(|_| LocalWtsError::InvalidPlanningDocument)?;
    Ok(WorkspacePlanningDocument {
        workspace_id,
        document_id,
        file_name: file_name.to_owned(),
        contents,
        sha256,
    })
}

pub(super) fn replace_planning_document(
    planning_home: &Path,
    file_name: &str,
    expected_sha256: &str,
    contents: &[u8],
) -> Result<(), LocalWtsError> {
    replace_with_hook(planning_home, file_name, expected_sha256, contents, || {})
}

fn replace_with_hook(
    planning_home: &Path,
    file_name: &str,
    expected_sha256: &str,
    contents: &[u8],
    before_publish: impl FnOnce(),
) -> Result<(), LocalWtsError> {
    if contents.len() > MAX_PLANNING_DOCUMENT_BYTES {
        return Err(LocalWtsError::PlanningDocumentTooLarge);
    }
    let parent = open_parent(planning_home, file_name)?;
    if sha256_bytes(&parent.read_file()?) != expected_sha256 {
        return Err(LocalWtsError::PlanningDocumentConflict);
    }
    parent.replace(contents, expected_sha256, || {
        before_publish();
        let current = open_parent(planning_home, file_name)?;
        parent.same_directory(&current)
    })
}

#[cfg(unix)]
struct PlanningParent {
    directory: fs::File,
    leaf: std::ffi::CString,
}

#[cfg(unix)]
fn open_parent(planning_home: &Path, file_name: &str) -> Result<PlanningParent, LocalWtsError> {
    use std::os::unix::ffi::OsStrExt;
    let components = relative_components(file_name)?;
    if !planning_home.is_absolute() {
        return Err(LocalWtsError::InvalidPlanningDocument);
    }
    let mut directory = fs::File::open("/").map_err(|_| LocalWtsError::InvalidPlanningDocument)?;
    for component in planning_home.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(leaf) => {
                let leaf = std::ffi::CString::new(leaf.as_bytes())
                    .map_err(|_| LocalWtsError::InvalidPlanningDocument)?;
                directory = open_at(&directory, &leaf, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
            }
            _ => return Err(LocalWtsError::InvalidPlanningDocument),
        }
    }
    for component in &components[..components.len() - 1] {
        let leaf = std::ffi::CString::new(*component)
            .map_err(|_| LocalWtsError::InvalidPlanningDocument)?;
        directory = open_at(&directory, &leaf, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    }
    Ok(PlanningParent {
        directory,
        leaf: std::ffi::CString::new(*components.last().expect("a relative path has a leaf"))
            .map_err(|_| LocalWtsError::InvalidPlanningDocument)?,
    })
}

#[cfg(unix)]
fn open_at(
    directory: &fs::File,
    leaf: &std::ffi::CStr,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> Result<fs::File, LocalWtsError> {
    use std::os::fd::{AsRawFd, FromRawFd};
    // The returned descriptor has one owner. Each component rejects symbolic links.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            leaf.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                LocalWtsError::PlanningDocumentUnavailable
            } else {
                LocalWtsError::InvalidPlanningDocument
            },
        );
    }
    Ok(unsafe { fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
impl PlanningParent {
    fn read_file(&self) -> Result<Vec<u8>, LocalWtsError> {
        bounded_contents(open_at(&self.directory, &self.leaf, libc::O_RDONLY, 0)?)
    }

    fn same_directory(&self, other: &Self) -> Result<(), LocalWtsError> {
        use std::os::unix::fs::MetadataExt;
        let original = self
            .directory
            .metadata()
            .map_err(|_| LocalWtsError::InvalidPlanningDocument)?;
        let current = other
            .directory
            .metadata()
            .map_err(|_| LocalWtsError::InvalidPlanningDocument)?;
        if original.dev() != current.dev() || original.ino() != current.ino() {
            return Err(LocalWtsError::InvalidPlanningDocument);
        }
        Ok(())
    }

    fn owns_temporary(&self, name: &std::ffi::CStr, created: &fs::File, contents: &[u8]) -> bool {
        use std::os::unix::fs::MetadataExt;
        let Ok(current) = open_at(&self.directory, name, libc::O_RDONLY, 0) else {
            return false;
        };
        let (Ok(current_metadata), Ok(created_metadata)) = (current.metadata(), created.metadata())
        else {
            return false;
        };
        current_metadata.dev() == created_metadata.dev()
            && current_metadata.ino() == created_metadata.ino()
            && bounded_contents(current).ok().as_deref() == Some(contents)
    }

    fn replace(
        &self,
        contents: &[u8],
        expected_sha256: &str,
        validate: impl FnOnce() -> Result<(), LocalWtsError>,
    ) -> Result<(), LocalWtsError> {
        use std::os::fd::AsRawFd;
        let temporary =
            std::ffi::CString::new(format!(".wts-planning-{}.tmp", Uuid::new_v4().simple()))
                .expect("a generated name has no NUL");
        let mut file = open_at(
            &self.directory,
            &temporary,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?;
        let result = (|| {
            let permissions = open_at(&self.directory, &self.leaf, libc::O_RDONLY, 0)?
                .metadata()
                .map_err(|_| LocalWtsError::InvalidPlanningDocument)?
                .permissions();
            file.set_permissions(permissions)
                .and_then(|()| file.write_all(contents))
                .and_then(|()| file.sync_all())
                .map_err(|_| LocalWtsError::InvalidPlanningDocument)?;
            validate()?;
            if sha256_bytes(&self.read_file()?) != expected_sha256 {
                return Err(LocalWtsError::PlanningDocumentConflict);
            }
            if !self.owns_temporary(&temporary, &file, contents) {
                return Err(LocalWtsError::InvalidPlanningDocument);
            }
            // Both names are relative to the validated directory descriptor.
            if unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    temporary.as_ptr(),
                    self.directory.as_raw_fd(),
                    self.leaf.as_ptr(),
                )
            } != 0
            {
                return Err(LocalWtsError::InvalidPlanningDocument);
            }
            self.directory
                .sync_all()
                .map_err(|_| LocalWtsError::InvalidPlanningDocument)
        })();
        if result.is_err() && self.owns_temporary(&temporary, &file, contents) {
            // Only the temporary file created by this request can be removed.
            unsafe {
                libc::unlinkat(self.directory.as_raw_fd(), temporary.as_ptr(), 0);
            }
        }
        result
    }
}

fn bounded_contents(file: fs::File) -> Result<Vec<u8>, LocalWtsError> {
    let metadata = file
        .metadata()
        .map_err(|_| LocalWtsError::InvalidPlanningDocument)?;
    if !metadata.is_file() {
        return Err(LocalWtsError::InvalidPlanningDocument);
    }
    if metadata.len() > MAX_PLANNING_DOCUMENT_BYTES as u64 {
        return Err(LocalWtsError::PlanningDocumentTooLarge);
    }
    let mut bytes = Vec::new();
    file.take(MAX_PLANNING_DOCUMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| LocalWtsError::InvalidPlanningDocument)?;
    if bytes.len() > MAX_PLANNING_DOCUMENT_BYTES {
        return Err(LocalWtsError::PlanningDocumentTooLarge);
    }
    Ok(bytes)
}

#[cfg(not(unix))]
struct PlanningParent {
    directory: PathBuf,
    leaf: String,
}

#[cfg(not(unix))]
fn open_parent(planning_home: &Path, file_name: &str) -> Result<PlanningParent, LocalWtsError> {
    let path = trusted_path(planning_home, file_name)?;
    Ok(PlanningParent {
        directory: path
            .parent()
            .ok_or(LocalWtsError::InvalidPlanningDocument)?
            .to_path_buf(),
        leaf: path
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or(LocalWtsError::InvalidPlanningDocument)?
            .to_owned(),
    })
}

#[cfg(not(unix))]
impl PlanningParent {
    fn read_file(&self) -> Result<Vec<u8>, LocalWtsError> {
        let path = self.directory.join(&self.leaf);
        if path
            .symlink_metadata()
            .map_err(|_| LocalWtsError::InvalidPlanningDocument)?
            .file_type()
            .is_symlink()
        {
            return Err(LocalWtsError::InvalidPlanningDocument);
        }
        bounded_contents(fs::File::open(path).map_err(|_| LocalWtsError::InvalidPlanningDocument)?)
    }
    fn same_directory(&self, other: &Self) -> Result<(), LocalWtsError> {
        if self.directory != other.directory {
            return Err(LocalWtsError::InvalidPlanningDocument);
        }
        Ok(())
    }
    fn replace(
        &self,
        contents: &[u8],
        expected_sha256: &str,
        validate: impl FnOnce() -> Result<(), LocalWtsError>,
    ) -> Result<(), LocalWtsError> {
        validate()?;
        if sha256_bytes(&self.read_file()?) != expected_sha256 {
            return Err(LocalWtsError::PlanningDocumentConflict);
        }
        atomic_replace_bytes(&self.directory.join(&self.leaf), contents)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_home() -> (TempDir, PathBuf) {
        let temporary = TempDir::new().expect("temporary planning home");
        let root = temporary
            .path()
            .canonicalize()
            .expect("canonical planning home");
        (temporary, root)
    }

    #[test]
    fn nested_documents_keep_distinct_ids_and_fixed_names() {
        let (_temporary, home) = test_home();
        fs::create_dir_all(home.join("epics/payments")).unwrap();
        fs::create_dir_all(home.join("epics/refunds")).unwrap();
        fs::write(home.join("PLAN.md"), "root plan").unwrap();
        for name in [
            "epics/payments/PLAN.md",
            "epics/refunds/PLAN.md",
            "epics/flow.mermaid",
        ] {
            fs::write(home.join(name), name).unwrap();
        }
        let listed =
            discover_generated_planning_documents(&home, WorkspacePlanningFormat::Kanban).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|item| item.file_name.as_str())
                .collect::<Vec<_>>(),
            vec![
                "epics/flow.mermaid",
                "epics/payments/PLAN.md",
                "epics/refunds/PLAN.md"
            ]
        );
        assert_ne!(listed[1].document_id, listed[2].document_id);
        for item in &listed {
            let document = read_planning_document(
                Uuid::new_v4(),
                &home,
                item.document_id.clone(),
                &item.file_name,
            )
            .unwrap();
            assert_eq!(document.contents, item.file_name);
            assert_eq!(
                resolve_planning_document_file_name(
                    &home,
                    WorkspacePlanningFormat::Kanban,
                    &item.document_id
                )
                .unwrap(),
                item.file_name
            );
        }
        assert_eq!(
            resolve_planning_document_file_name(
                &home,
                WorkspacePlanningFormat::Kanban,
                &WorkspacePlanningDocumentId::Plan
            )
            .unwrap(),
            "PLAN.md"
        );
        assert_eq!(
            generated_planning_document_id("epics/payments/PLAN.md"),
            listed[1].document_id
        );
    }

    #[test]
    fn nested_writes_check_content_and_preserve_other_documents() {
        let (_temporary, home) = test_home();
        fs::create_dir_all(home.join("sprint")).unwrap();
        fs::write(home.join("sprint/KANBAN.md"), "original").unwrap();
        fs::write(home.join("KANBAN.md"), "root board").unwrap();
        replace_planning_document(
            &home,
            "sprint/KANBAN.md",
            &sha256_bytes(b"original"),
            b"updated",
        )
        .unwrap();
        assert_eq!(fs::read(home.join("sprint/KANBAN.md")).unwrap(), b"updated");
        assert_eq!(fs::read(home.join("KANBAN.md")).unwrap(), b"root board");
        assert!(matches!(
            replace_planning_document(
                &home,
                "sprint/KANBAN.md",
                &sha256_bytes(b"original"),
                b"stale"
            ),
            Err(LocalWtsError::PlanningDocumentConflict)
        ));
        assert_eq!(fs::read_dir(home.join("sprint")).unwrap().count(), 1);
    }

    #[test]
    fn discovery_and_reads_obey_depth_size_and_format_limits() {
        let (_temporary, home) = test_home();
        let deepest = (0..MAX_PLANNING_DIRECTORY_DEPTH)
            .map(|index| format!("level-{index}"))
            .collect::<Vec<_>>()
            .join("/");
        fs::create_dir_all(home.join(&deepest).join("too-deep")).unwrap();
        fs::write(home.join(&deepest).join("edge.MD"), "edge").unwrap();
        fs::write(home.join(&deepest).join("too-deep/hidden.md"), "too deep").unwrap();
        fs::write(
            home.join("too-large.md"),
            vec![b'x'; MAX_PLANNING_DOCUMENT_BYTES + 1],
        )
        .unwrap();
        fs::write(home.join("unsupported.json"), "{}").unwrap();
        fs::write(home.join("invalid.md"), [0xff, 0xfe]).unwrap();
        let listed =
            discover_generated_planning_documents(&home, WorkspacePlanningFormat::Notes).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(
            listed
                .iter()
                .any(|item| item.file_name == format!("{deepest}/edge.MD"))
        );
        assert!(matches!(
            read_planning_document(
                Uuid::new_v4(),
                &home,
                WorkspacePlanningDocumentId::Plan,
                "too-large.md"
            ),
            Err(LocalWtsError::PlanningDocumentTooLarge)
        ));
        assert!(matches!(
            read_planning_document(
                Uuid::new_v4(),
                &home,
                WorkspacePlanningDocumentId::Plan,
                "invalid.md"
            ),
            Err(LocalWtsError::InvalidPlanningDocument)
        ));
        assert!(
            read_planning_document(
                Uuid::new_v4(),
                &home,
                WorkspacePlanningDocumentId::Plan,
                &format!("{deepest}/too-deep/hidden.md")
            )
            .is_err()
        );
    }

    #[test]
    fn discovery_caps_document_count_without_changing_root_ids() {
        let (_temporary, home) = test_home();
        fs::create_dir(home.join("notes")).unwrap();
        for index in 0..110 {
            fs::write(home.join(format!("notes/{index:03}.md")), "note").unwrap();
        }
        let first =
            discover_generated_planning_documents(&home, WorkspacePlanningFormat::Notes).unwrap();
        let second =
            discover_generated_planning_documents(&home, WorkspacePlanningFormat::Notes).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), MAX_DISCOVERED_PLANNING_DOCUMENTS);
        assert_eq!(first.last().unwrap().file_name, "notes/099.md");
        let expected = format!(
            "generated-{}",
            Sha256::digest(b"wts-planning-document-v1\0legacy.md").encode_hex::<String>()
        );
        assert_eq!(
            generated_planning_document_id("legacy.md").wire_id(),
            expected
        );
    }

    #[test]
    fn read_and_write_reject_non_normal_relative_names() {
        let (_temporary, home) = test_home();
        fs::write(home.join("PLAN.md"), "original").unwrap();
        for path in [
            "../PLAN.md",
            "/PLAN.md",
            "a/../PLAN.md",
            "./PLAN.md",
            "a//PLAN.md",
            "a\\PLAN.md",
            "a/\nPLAN.md",
            "",
        ] {
            assert!(
                read_planning_document(
                    Uuid::new_v4(),
                    &home,
                    WorkspacePlanningDocumentId::Plan,
                    path
                )
                .is_err(),
                "read {path:?}"
            );
            assert!(
                replace_planning_document(&home, path, &sha256_bytes(b"original"), b"changed")
                    .is_err(),
                "write {path:?}"
            );
        }
        assert_eq!(fs::read(home.join("PLAN.md")).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn nested_symlinks_never_leave_the_planning_home() {
        use std::os::unix::fs::symlink;
        let (_temporary, home) = test_home();
        let (_outside_temporary, outside) = test_home();
        fs::write(outside.join("secret.md"), "outside").unwrap();
        fs::create_dir(home.join("notes")).unwrap();
        fs::write(home.join("notes/safe.md"), "inside").unwrap();
        symlink(&outside, home.join("linked-directory")).unwrap();
        symlink(outside.join("secret.md"), home.join("notes/linked-file.md")).unwrap();
        let listed =
            discover_generated_planning_documents(&home, WorkspacePlanningFormat::Notes).unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|item| item.file_name.as_str())
                .collect::<Vec<_>>(),
            vec!["notes/safe.md"]
        );
        for path in ["linked-directory/secret.md", "notes/linked-file.md"] {
            assert!(
                read_planning_document(
                    Uuid::new_v4(),
                    &home,
                    WorkspacePlanningDocumentId::Plan,
                    path
                )
                .is_err()
            );
            assert!(
                replace_planning_document(&home, path, &sha256_bytes(b"outside"), b"changed")
                    .is_err()
            );
        }
        assert_eq!(fs::read(outside.join("secret.md")).unwrap(), b"outside");
    }

    #[cfg(unix)]
    #[test]
    fn ancestor_replacement_before_publish_preserves_both_files() {
        use std::os::unix::fs::symlink;
        let (_temporary, home) = test_home();
        let (_outside_temporary, outside) = test_home();
        fs::create_dir(home.join("notes")).unwrap();
        fs::write(home.join("notes/PLAN.md"), "original").unwrap();
        fs::write(outside.join("PLAN.md"), "outside").unwrap();
        let result = replace_with_hook(
            &home,
            "notes/PLAN.md",
            &sha256_bytes(b"original"),
            b"changed",
            || {
                fs::rename(home.join("notes"), home.join("moved-notes")).unwrap();
                symlink(&outside, home.join("notes")).unwrap();
            },
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read(home.join("moved-notes/PLAN.md")).unwrap(),
            b"original"
        );
        assert_eq!(fs::read(outside.join("PLAN.md")).unwrap(), b"outside");
        assert_eq!(fs::read_dir(home.join("moved-notes")).unwrap().count(), 1);
    }

    #[test]
    fn an_external_edit_before_publish_is_not_overwritten() {
        let (_temporary, home) = test_home();
        fs::create_dir(home.join("notes")).unwrap();
        fs::write(home.join("notes/PLAN.md"), "original").unwrap();
        let result = replace_with_hook(
            &home,
            "notes/PLAN.md",
            &sha256_bytes(b"original"),
            b"changed",
            || {
                fs::write(home.join("notes/PLAN.md"), "external edit").unwrap();
            },
        );
        assert!(matches!(
            result,
            Err(LocalWtsError::PlanningDocumentConflict)
        ));
        assert_eq!(
            fs::read(home.join("notes/PLAN.md")).unwrap(),
            b"external edit"
        );
        assert_eq!(fs::read_dir(home.join("notes")).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_temporary_file_is_not_published_or_deleted() {
        use std::os::unix::fs::symlink;
        let (_temporary, home) = test_home();
        let (_outside_temporary, outside) = test_home();
        fs::write(home.join("PLAN.md"), "original").unwrap();
        fs::write(outside.join("outside.md"), "outside").unwrap();
        let mut replacement = None;
        let result = replace_with_hook(
            &home,
            "PLAN.md",
            &sha256_bytes(b"original"),
            b"changed",
            || {
                let temporary = fs::read_dir(&home)
                    .unwrap()
                    .flatten()
                    .find(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .starts_with(".wts-planning-")
                    })
                    .unwrap()
                    .path();
                fs::remove_file(&temporary).unwrap();
                symlink(outside.join("outside.md"), &temporary).unwrap();
                replacement = Some(temporary);
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read(home.join("PLAN.md")).unwrap(), b"original");
        assert_eq!(fs::read(outside.join("outside.md")).unwrap(), b"outside");
        assert!(
            replacement
                .unwrap()
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[test]
    fn discovery_stops_after_the_entry_budget() {
        let (_temporary, home) = test_home();
        for index in 0..MAX_PLANNING_ENTRIES {
            fs::create_dir(home.join(format!("folder-{index:04}"))).unwrap();
        }
        fs::write(
            home.join("folder-0000/hidden.md"),
            "outside the scan budget",
        )
        .unwrap();
        assert!(
            discover_generated_planning_documents(&home, WorkspacePlanningFormat::Notes)
                .unwrap()
                .is_empty()
        );
    }
}
