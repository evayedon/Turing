use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use serde::Serialize;
use std::{
    hash::{DefaultHasher, Hash, Hasher},
    io::{self, Read},
    path::Path,
    sync::{Mutex, MutexGuard},
};

const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkspaceError {
    Busy,
    PermissionDenied,
    OutsideWorkspace,
    NotFound,
    NotDirectory,
    NotFile,
    InvalidEncoding,
    FileTooLarge,
    DirectoryTooLarge,
    IoError,
}

impl From<io::Error> for WorkspaceError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::NotFound,
            io::ErrorKind::PermissionDenied => Self::PermissionDenied,
            io::ErrorKind::NotADirectory => Self::NotDirectory,
            _ => Self::IoError,
        }
    }
}

type Result<T> = std::result::Result<T, WorkspaceError>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDescriptor {
    id: String,
    name: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    Directory,
    File,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    name: String,
    relative_path: String,
    kind: EntryKind,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    workspace_id: String,
    relative_path: String,
    content: String,
    encoding: &'static str,
    version: String,
}

struct Workspace {
    owner: String,
    descriptor: WorkspaceDescriptor,
    root: Dir,
}

#[derive(Default)]
pub struct Registry {
    generation: u64,
    active: Option<Workspace>,
}

impl Registry {
    pub fn register(&mut self, owner: &str, selected: &Path) -> Result<WorkspaceDescriptor> {
        if self
            .active
            .as_ref()
            .is_some_and(|workspace| workspace.owner != owner)
        {
            return Err(WorkspaceError::PermissionDenied);
        }

        let canonical = selected.canonicalize()?;
        let anchor = canonical
            .ancestors()
            .last()
            .ok_or(WorkspaceError::IoError)?;
        let mut root = Dir::open_ambient_dir(anchor, ambient_authority())?;
        // Walk the canonical path without following links that may have appeared
        // after canonicalization. Retain the resulting directory handle.
        for component in canonical
            .strip_prefix(anchor)
            .map_err(|_| WorkspaceError::IoError)?
        {
            root = open_child_dir(&root, Path::new(component))?;
        }

        self.generation = self
            .generation
            .checked_add(1)
            .ok_or(WorkspaceError::IoError)?;
        let descriptor = WorkspaceDescriptor {
            id: self.generation.to_string(),
            name: canonical
                .file_name()
                .unwrap_or(canonical.as_os_str())
                .to_string_lossy()
                .into_owned(),
        };
        self.active = Some(Workspace {
            owner: owner.to_owned(),
            descriptor: descriptor.clone(),
            root,
        });
        Ok(descriptor)
    }

    pub fn close(&mut self, owner: &str, id: &str) -> Result<()> {
        self.authorize(owner, id)?;
        self.active = None;
        Ok(())
    }

    fn authorize(&self, owner: &str, id: &str) -> Result<&Dir> {
        self.active
            .as_ref()
            .filter(|workspace| workspace.owner == owner && workspace.descriptor.id == id)
            .map(|workspace| &workspace.root)
            .ok_or(WorkspaceError::PermissionDenied)
    }

    pub fn list(&self, owner: &str, id: &str, relative_path: &str) -> Result<Vec<DirectoryEntry>> {
        let root = self.authorize(owner, id)?;
        let parts = relative_parts(relative_path)?;
        let directory = directory_at(root, &parts)?;
        let mut entries = Vec::new();
        for (index, entry) in directory.entries()?.enumerate() {
            if index >= MAX_DIRECTORY_ENTRIES {
                return Err(WorkspaceError::DirectoryTooLarge);
            }
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if !valid_component(&name) {
                continue;
            }
            let file_type = entry.file_type()?;
            let kind = if file_type.is_dir() {
                EntryKind::Directory
            } else if file_type.is_file() {
                EntryKind::File
            } else {
                continue;
            };
            let path = if relative_path.is_empty() {
                name.clone()
            } else {
                format!("{relative_path}/{name}")
            };
            entries.push(DirectoryEntry {
                name,
                relative_path: path,
                kind,
            });
        }
        entries.sort_unstable_by(|left, right| {
            (left.kind == EntryKind::File, &left.name)
                .cmp(&(right.kind == EntryKind::File, &right.name))
        });
        Ok(entries)
    }

    pub fn read(&self, owner: &str, id: &str, relative_path: &str) -> Result<TextFile> {
        let root = self.authorize(owner, id)?;
        let parts = relative_parts(relative_path)?;
        let (name, parents) = parts.split_last().ok_or(WorkspaceError::NotFile)?;
        let directory = directory_at(root, parents)?;
        let metadata = directory.symlink_metadata(name)?;
        if metadata.is_symlink() {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        if !metadata.is_file() {
            return Err(WorkspaceError::NotFile);
        }
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No).nonblock(true);
        let file = directory.open_with(name, &options)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(WorkspaceError::NotFile);
        }
        if metadata.len() > MAX_TEXT_BYTES {
            return Err(WorkspaceError::FileTooLarge);
        }
        let mut bytes = Vec::new();
        file.take(MAX_TEXT_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_TEXT_BYTES {
            return Err(WorkspaceError::FileTooLarge);
        }
        let content = String::from_utf8(bytes).map_err(|_| WorkspaceError::InvalidEncoding)?;
        if content.contains('\0') {
            return Err(WorkspaceError::InvalidEncoding);
        }
        let mut version = DefaultHasher::new();
        content.hash(&mut version);
        Ok(TextFile {
            workspace_id: id.to_owned(),
            relative_path: relative_path.to_owned(),
            content,
            encoding: "utf-8",
            version: format!("{:016x}", version.finish()),
        })
    }
}

#[derive(Default)]
pub struct WorkspaceService {
    registry: Mutex<Registry>,
    picker: Mutex<()>,
}

impl WorkspaceService {
    pub fn registry(&self) -> Result<MutexGuard<'_, Registry>> {
        self.registry.lock().map_err(|_| WorkspaceError::IoError)
    }

    pub fn begin_picker(&self) -> Result<MutexGuard<'_, ()>> {
        self.picker.try_lock().map_err(|_| WorkspaceError::Busy)
    }
}

fn valid_component(name: &str) -> bool {
    !name.is_empty()
        && !matches!(name, "." | "..")
        && !name.ends_with(['.', ' '])
        && !name.contains(['/', '\\', ':', '\0'])
        && Path::new(name)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
}

fn relative_parts(path: &str) -> Result<Vec<&str>> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    let parts: Vec<_> = path.split('/').collect();
    if parts.iter().all(|part| valid_component(part)) {
        Ok(parts)
    } else {
        Err(WorkspaceError::OutsideWorkspace)
    }
}

fn open_child_dir(parent: &Dir, name: &Path) -> Result<Dir> {
    if parent.symlink_metadata(name)?.is_symlink() {
        return Err(WorkspaceError::OutsideWorkspace);
    }
    Ok(parent.open_dir_nofollow(name)?)
}

fn directory_at(root: &Dir, components: &[&str]) -> Result<Dir> {
    let mut directory = root.try_clone()?;
    for component in components {
        directory = open_child_dir(&directory, Path::new(component))?;
    }
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    const OWNER: &str = "main";

    fn approved() -> (TempDir, Registry, WorkspaceDescriptor) {
        let folder = tempfile::tempdir().unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register(OWNER, folder.path()).unwrap();
        (folder, registry, workspace)
    }

    #[test]
    fn caller_and_active_registration_are_required_for_every_operation() {
        let (folder, mut registry, workspace) = approved();
        for (owner, id) in [("other", workspace.id.as_str()), (OWNER, "unregistered")] {
            assert_eq!(
                registry.list(owner, id, "").unwrap_err(),
                WorkspaceError::PermissionDenied
            );
            assert_eq!(
                registry.read(owner, id, "notes.txt").unwrap_err(),
                WorkspaceError::PermissionDenied
            );
            assert_eq!(
                registry.close(owner, id),
                Err(WorkspaceError::PermissionDenied)
            );
        }
        assert!(matches!(
            registry.register("other", folder.path()),
            Err(WorkspaceError::PermissionDenied)
        ));

        let replacement = registry.register(OWNER, folder.path()).unwrap();
        assert_ne!(workspace.id, replacement.id);
        assert_eq!(
            registry.list(OWNER, &workspace.id, "").unwrap_err(),
            WorkspaceError::PermissionDenied
        );
        registry.close(OWNER, &replacement.id).unwrap();
        assert_eq!(
            registry
                .read(OWNER, &replacement.id, "notes.txt")
                .unwrap_err(),
            WorkspaceError::PermissionDenied
        );
    }

    #[test]
    fn lists_real_entries_and_reads_utf8_under_the_approved_root() {
        let (folder, registry, workspace) = approved();
        fs::create_dir(folder.path().join("src")).unwrap();
        fs::write(folder.path().join("README.md"), "read me").unwrap();
        fs::write(folder.path().join("src/notes.txt"), "Turing ✓").unwrap();
        let root = registry.list(OWNER, &workspace.id, "").unwrap();
        assert_eq!(root[0].name, "src");
        assert_eq!(root[0].kind, EntryKind::Directory);
        assert_eq!(root[1].name, "README.md");
        let nested = registry.list(OWNER, &workspace.id, "src").unwrap();
        assert_eq!(nested[0].relative_path, "src/notes.txt");
        let file = registry
            .read(OWNER, &workspace.id, "src/notes.txt")
            .unwrap();
        assert_eq!(file.content, "Turing ✓");
        assert_eq!(file.encoding, "utf-8");
    }

    #[test]
    fn rejects_traversal_absolute_paths_and_windows_path_aliases() {
        let (_folder, registry, workspace) = approved();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("private.txt");
        fs::write(&outside_file, "private").unwrap();
        let absolute_path = outside_file.to_str().unwrap();
        for path in [
            "../private.txt",
            "src/../../private.txt",
            "src/../private.txt",
            "src/./notes.txt",
            "src//notes.txt",
            "/etc/passwd",
            "C:/Windows",
            r"C:\Windows",
            r"\server\share",
            "src/.. /private.txt",
            "file.txt:stream",
            absolute_path,
        ] {
            assert_eq!(
                registry.list(OWNER, &workspace.id, path).unwrap_err(),
                WorkspaceError::OutsideWorkspace,
                "{path}"
            );
            assert_eq!(
                registry.read(OWNER, &workspace.id, path).unwrap_err(),
                WorkspaceError::OutsideWorkspace,
                "{path}"
            );
        }
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn rejects_outside_links_for_both_leaf_files_and_intermediate_folders() {
        let (folder, registry, workspace) = approved();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("private.txt");
        fs::write(&outside_file, "private").unwrap();
        let linked_folder = folder.path().join("linked-folder");
        let linked_file = folder.path().join("linked-file");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), &linked_folder).unwrap();
            std::os::unix::fs::symlink(outside_file, &linked_file).unwrap();
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::{symlink_dir, symlink_file};
            for result in [
                symlink_dir(outside.path(), &linked_folder),
                symlink_file(outside_file, &linked_file),
            ] {
                if let Err(error) = result {
                    // Windows can require Developer Mode or SeCreateSymbolicLinkPrivilege.
                    if error.raw_os_error() == Some(1314) {
                        eprintln!("Windows runner lacks permission to create symbolic links");
                        return;
                    }
                    panic!("could not create symbolic link: {error}");
                }
            }
        }

        assert!(registry.list(OWNER, &workspace.id, "").unwrap().is_empty());
        assert_eq!(
            registry
                .list(OWNER, &workspace.id, "linked-folder")
                .unwrap_err(),
            WorkspaceError::OutsideWorkspace
        );
        for path in ["linked-file", "linked-folder/private.txt"] {
            assert_eq!(
                registry.read(OWNER, &workspace.id, path).unwrap_err(),
                WorkspaceError::OutsideWorkspace
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn approved_handle_does_not_follow_a_replacement_at_the_original_path() {
        let parent = tempfile::tempdir().unwrap();
        let selected = parent.path().join("selected");
        fs::create_dir(&selected).unwrap();
        fs::write(selected.join("notes.txt"), "approved").unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register(OWNER, &selected).unwrap();

        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("notes.txt"), "private").unwrap();
        fs::rename(&selected, parent.path().join("moved")).unwrap();
        std::os::unix::fs::symlink(outside.path(), &selected).unwrap();

        assert_eq!(
            registry
                .read(OWNER, &workspace.id, "notes.txt")
                .unwrap()
                .content,
            "approved"
        );
    }

    #[test]
    fn text_reads_reject_invalid_encoding_and_oversized_files() {
        let (folder, registry, workspace) = approved();
        fs::write(folder.path().join("binary"), [0xff]).unwrap();
        fs::File::create(folder.path().join("large"))
            .unwrap()
            .set_len(MAX_TEXT_BYTES + 1)
            .unwrap();
        assert_eq!(
            registry.read(OWNER, &workspace.id, "binary").unwrap_err(),
            WorkspaceError::InvalidEncoding
        );
        assert_eq!(
            registry.read(OWNER, &workspace.id, "large").unwrap_err(),
            WorkspaceError::FileTooLarge
        );
        assert_eq!(
            registry.read(OWNER, &workspace.id, "").unwrap_err(),
            WorkspaceError::NotFile
        );
    }
}
