mod file;
mod mutations;
mod search;
mod selected;
mod watch;

pub use search::{SearchOptions, SearchResponse};
pub use selected::{PickedFile, SelectedFileSnapshot, SelectedFileVersion};
pub use watch::WorkspaceChanges;

use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
use serde::Serialize;
use std::{
    collections::HashMap,
    io,
    path::Path,
    sync::{Mutex, MutexGuard},
};

const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkspaceError {
    Busy,
    WindowLimit,
    PermissionDenied,
    OutsideWorkspace,
    NotFound,
    NotDirectory,
    NotFile,
    InvalidEncoding,
    FileTooLarge,
    FileConflict,
    SaveRace,
    InvalidName,
    EntryChanged,
    NameTaken,
    // Only the Unix staging rollback can produce this.
    #[cfg_attr(not(unix), allow(dead_code))]
    RenameRace,
    DirectoryTooLarge,
    InvalidSearch,
    SearchCancelled,
    SearchBusy,
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

pub fn validate_save_content(content: &str) -> Result<()> {
    file::validate_content(content.as_bytes())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDescriptor {
    pub(crate) id: String,
    name: String,
    display_path: String,
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
    identity: String,
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
    /// Canonical filesystem path of the workspace root; used by git subprocess.
    canonical_path: std::path::PathBuf,
    /// Change notifications for this registration only; dropped with it.
    watch: Option<watch::Watch>,
}

impl Workspace {
    /// True when the canonical path no longer names the approved directory
    /// (moved, deleted or replaced), so path-based OS events are untrusted.
    fn root_replaced(&self) -> bool {
        use cap_fs_ext::MetadataExt;
        let Ok(current) = Dir::open_ambient_dir(&self.canonical_path, ambient_authority()) else {
            return true;
        };
        match (current.dir_metadata(), self.root.dir_metadata()) {
            (Ok(current), Ok(approved)) => {
                current.dev() != approved.dev() || current.ino() != approved.ino()
            }
            _ => true,
        }
    }
}

#[derive(Default)]
pub struct Registry {
    generation: u64,
    namespace: Option<String>,
    active: Option<Workspace>,
    search: Option<search::SearchJob>,
    selected: HashMap<String, selected::SelectedGrant>,
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

        let (canonical, root) = open_picked_directory(selected)?;

        self.generation = self
            .generation
            .checked_add(1)
            .ok_or(WorkspaceError::IoError)?;
        let descriptor = WorkspaceDescriptor {
            id: match &self.namespace {
                Some(namespace) => format!("{namespace}-{}", self.generation),
                None => self.generation.to_string(),
            },
            display_path: selected.to_string_lossy().into_owned(),
            name: canonical
                .file_name()
                .unwrap_or(canonical.as_os_str())
                .to_string_lossy()
                .into_owned(),
        };
        self.revoke_search();
        self.active = Some(Workspace {
            owner: owner.to_owned(),
            descriptor: descriptor.clone(),
            root,
            canonical_path: canonical,
            watch: None,
        });
        Ok(descriptor)
    }

    pub fn close(&mut self, owner: &str, id: &str) -> Result<()> {
        self.authorize(owner, id)?;
        self.revoke_search();
        self.active = None;
        Ok(())
    }

    fn active_mut(&mut self, owner: &str, id: &str) -> Result<&mut Workspace> {
        self.active
            .as_mut()
            .filter(|workspace| workspace.owner == owner && workspace.descriptor.id == id)
            .ok_or(WorkspaceError::PermissionDenied)
    }

    /// Binds a watcher to the registration it was started for. A watcher
    /// that finished starting after its registration was closed or replaced
    /// is refused and dropped.
    pub fn attach_watch(&mut self, owner: &str, id: &str, watch: watch::Watch) -> Result<()> {
        self.active_mut(owner, id)?.watch = Some(watch);
        Ok(())
    }

    pub fn stop_watch(&mut self) {
        if let Some(workspace) = self.active.as_mut() {
            workspace.watch = None;
        }
    }

    /// Returns coalesced changes for the caller's active registration only.
    /// Without a running watcher this reports nothing; a replaced root stops
    /// the watcher and reports one rescan.
    pub fn poll_changes(
        &mut self,
        owner: &str,
        id: &str,
        now: std::time::Instant,
    ) -> Result<WorkspaceChanges> {
        let workspace = self.active_mut(owner, id)?;
        let Some(watch) = workspace.watch.as_ref() else {
            return Ok(WorkspaceChanges::default());
        };
        if workspace.root_replaced() {
            workspace.watch = None;
            return Ok(WorkspaceChanges {
                paths: Vec::new(),
                rescan: true,
            });
        }
        let mut changes = watch.take(now);
        let root = &workspace.root;
        changes.paths.retain(|path| watch::reachable(root, path));
        Ok(changes)
    }

    pub(crate) fn authorize(&self, owner: &str, id: &str) -> Result<&Dir> {
        self.active
            .as_ref()
            .filter(|workspace| workspace.owner == owner && workspace.descriptor.id == id)
            .map(|workspace| &workspace.root)
            .ok_or(WorkspaceError::PermissionDenied)
    }

    /// Returns the canonical filesystem path of the workspace root.
    /// Used exclusively by the git adapter to pass to the git subprocess.
    pub fn workspace_path(&self, owner: &str, id: &str) -> Result<&Path> {
        self.active
            .as_ref()
            .filter(|workspace| workspace.owner == owner && workspace.descriptor.id == id)
            .map(|workspace| workspace.canonical_path.as_path())
            .ok_or(WorkspaceError::PermissionDenied)
    }

    pub fn terminal_directory(&self, owner: &str, id: &str) -> Result<Dir> {
        Ok(self.authorize(owner, id)?.try_clone()?)
    }

    pub fn list(&self, owner: &str, id: &str, relative_path: &str) -> Result<Vec<DirectoryEntry>> {
        let root = self.authorize(owner, id)?;
        let parts = relative_parts(relative_path)?;
        let directory = directory_at(root, &parts)?;
        let identity_parent = directory.dir_metadata()?;
        let mut entries = Vec::new();
        for (index, entry) in directory.entries()?.enumerate() {
            if index >= MAX_DIRECTORY_ENTRIES {
                return Err(WorkspaceError::DirectoryTooLarge);
            }
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if !valid_component(&name) || name.starts_with(".turing-save-") {
                continue;
            }
            let metadata = match directory.symlink_metadata(&name) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if is_workspace_link(&metadata) {
                continue;
            }
            let kind = if metadata.is_dir() {
                EntryKind::Directory
            } else if metadata.is_file() {
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
                identity: mutations::identity(&identity_parent, &metadata),
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
        let snapshot = file::read(root, relative_path)?;
        Ok(TextFile {
            workspace_id: id.to_owned(),
            relative_path: relative_path.to_owned(),
            content: snapshot.content,
            encoding: "utf-8",
            version: snapshot.version,
        })
    }

    pub fn language_file(&self, owner: &str, id: &str, relative_path: &str) -> Result<()> {
        let root = self.authorize(owner, id)?;
        let parts = relative_parts(relative_path)?;
        let (name, parent) = parts.split_last().ok_or(WorkspaceError::OutsideWorkspace)?;
        let dir = directory_at(root, parent)?;
        file::open_text(&dir, name, false)?;
        Ok(())
    }

    pub fn execution_snapshot(
        &self,
        owner: &str,
        id: &str,
        relative_path: &str,
    ) -> Result<(String, String, Dir)> {
        let root = self.authorize(owner, id)?;
        let snapshot = file::read(root, relative_path)?;
        Ok((snapshot.content, snapshot.version, root.try_clone()?))
    }

    pub fn write(
        &self,
        owner: &str,
        id: &str,
        relative_path: &str,
        expected_version: &str,
        content: &str,
    ) -> Result<String> {
        let root = self.authorize(owner, id)?;
        file::write(root, relative_path, expected_version, content)
    }
}

#[derive(Default)]
pub struct WorkspaceService {
    registry: Mutex<Registry>,
    picker: Mutex<()>,
}

impl WorkspaceService {
    pub fn for_window(label: &str) -> Self {
        Self {
            registry: Mutex::new(Registry {
                namespace: Some(format!("{label}-{}", uuid::Uuid::new_v4())),
                ..Registry::default()
            }),
            picker: Mutex::new(()),
        }
    }

    pub fn registry(&self) -> Result<MutexGuard<'_, Registry>> {
        self.registry.lock().map_err(|_| WorkspaceError::IoError)
    }

    pub fn shutdown(&self) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.revoke_search();
            registry.active = None;
            registry.selected.clear();
        }
    }

    /// Starts watching the caller's active registration. The OS watcher is
    /// created without the registry lock (a recursive watch can take a while)
    /// and attached only if the same registration is still active.
    pub fn watch(&self, owner: &str, id: &str) -> Result<()> {
        let root = self.registry()?.workspace_path(owner, id)?.to_path_buf();
        let watch = watch::Watch::start(&root)?;
        self.registry()?.attach_watch(owner, id, watch)
    }

    pub fn stop_watch(&self) {
        if let Ok(mut registry) = self.registry.lock() {
            registry.stop_watch();
        }
    }

    pub fn begin_picker(&self) -> Result<MutexGuard<'_, ()>> {
        self.picker.try_lock().map_err(|_| WorkspaceError::Busy)
    }
}

fn open_picked_directory(selected: &Path) -> Result<(std::path::PathBuf, Dir)> {
    let canonical = selected.canonicalize()?;
    let anchor = canonical
        .ancestors()
        .last()
        .ok_or(WorkspaceError::IoError)?;
    let mut root = Dir::open_ambient_dir(anchor, ambient_authority())?;
    // Refuse links that appeared after canonicalization and retain the opened directory.
    for component in canonical
        .strip_prefix(anchor)
        .map_err(|_| WorkspaceError::IoError)?
    {
        root = open_child_dir(&root, Path::new(component))?;
    }
    Ok((canonical, root))
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

pub(crate) fn relative_parts(path: &str) -> Result<Vec<&str>> {
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

fn is_workspace_link(metadata: &cap_std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    metadata.is_symlink()
}

fn open_child_dir(parent: &Dir, name: &Path) -> Result<Dir> {
    if is_workspace_link(&parent.symlink_metadata(name)?) {
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
            assert_eq!(
                registry.write(OWNER, &workspace.id, path, "bogus", "unauthorized"),
                Err(WorkspaceError::OutsideWorkspace),
                "{path}"
            );
        }
        assert_eq!(fs::read_to_string(outside_file).unwrap(), "private");
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
            std::os::unix::fs::symlink(&outside_file, &linked_file).unwrap();
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::{symlink_dir, symlink_file};
            for result in [
                symlink_dir(outside.path(), &linked_folder),
                symlink_file(&outside_file, &linked_file),
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
            assert_eq!(
                registry.write(OWNER, &workspace.id, path, "bogus", "unauthorized"),
                Err(WorkspaceError::OutsideWorkspace)
            );
        }
        assert_eq!(fs::read_to_string(outside_file).unwrap(), "private");
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

    /// Polls until `accept` holds or a generous deadline passes; OS
    /// watchers deliver asynchronously and CI machines can be slow.
    fn poll_until(
        registry: &mut Registry,
        id: &str,
        mut accept: impl FnMut(&WorkspaceChanges) -> bool,
    ) -> Vec<WorkspaceChanges> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut seen = Vec::new();
        while std::time::Instant::now() < deadline {
            let changes = registry
                .poll_changes(OWNER, id, std::time::Instant::now())
                .unwrap();
            if changes != WorkspaceChanges::default() {
                let done = accept(&changes);
                seen.push(changes);
                if done {
                    return seen;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("watcher did not converge; saw {seen:?}");
    }

    fn watched() -> (TempDir, Registry, WorkspaceDescriptor) {
        let (folder, mut registry, workspace) = approved();
        let root = registry
            .workspace_path(OWNER, &workspace.id)
            .unwrap()
            .to_path_buf();
        let watch = watch::Watch::start(&root).unwrap();
        registry.attach_watch(OWNER, &workspace.id, watch).unwrap();
        (folder, registry, workspace)
    }

    #[test]
    fn a_real_rename_burst_is_reported_as_relative_paths() {
        let (folder, mut registry, workspace) = watched();
        fs::create_dir(folder.path().join("src")).unwrap();
        // Give slower backends a moment to arm the new subdirectory watch.
        std::thread::sleep(std::time::Duration::from_millis(300));
        for index in 0..5 {
            fs::write(folder.path().join(format!("src/{index}.txt")), "x").unwrap();
        }
        for index in 0..5 {
            fs::rename(
                folder.path().join(format!("src/{index}.txt")),
                folder.path().join(format!("src/renamed-{index}.txt")),
            )
            .unwrap();
        }
        let mut reported = std::collections::BTreeSet::new();
        let mut rescanned = false;
        poll_until(&mut registry, &workspace.id, |changes| {
            rescanned |= changes.rescan;
            reported.extend(changes.paths.iter().cloned());
            // A path stands for its subtree, so "src" covers every rename.
            rescanned
                || reported.contains("src")
                || (0..5).all(|index| reported.contains(&format!("src/renamed-{index}.txt")))
        });
        for path in &reported {
            assert!(
                path == "src" || path.starts_with("src/"),
                "unexpected path {path}"
            );
        }
        // The listing that a view refreshes to matches disk.
        let listed: Vec<_> = registry
            .list(OWNER, &workspace.id, "src")
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(
            listed,
            (0..5)
                .map(|index| format!("renamed-{index}.txt"))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn closing_or_replacing_a_workspace_stops_its_watcher_and_never_resurrects_it() {
        let (folder, mut registry, workspace) = watched();
        let old_inbox = registry
            .active
            .as_ref()
            .unwrap()
            .watch
            .as_ref()
            .unwrap()
            .inbox();
        let replacement = registry.register(OWNER, folder.path()).unwrap();
        assert!(registry.active.as_ref().unwrap().watch.is_none());
        assert!(old_inbox.lock().unwrap().is_closed());
        fs::write(folder.path().join("after.txt"), "x").unwrap();
        assert_eq!(
            registry
                .poll_changes(OWNER, &workspace.id, std::time::Instant::now())
                .unwrap_err(),
            WorkspaceError::PermissionDenied
        );
        // A watcher started for the stale registration cannot be attached.
        let root = folder.path().canonicalize().unwrap();
        let late = watch::Watch::start(&root).unwrap();
        assert_eq!(
            registry.attach_watch(OWNER, &workspace.id, late),
            Err(WorkspaceError::PermissionDenied)
        );
        let stranger = watch::Watch::start(&root).unwrap();
        assert_eq!(
            registry.attach_watch("other", &replacement.id, stranger),
            Err(WorkspaceError::PermissionDenied)
        );
        std::thread::sleep(std::time::Duration::from_millis(400));
        assert_eq!(
            registry
                .poll_changes(OWNER, &replacement.id, std::time::Instant::now())
                .unwrap(),
            WorkspaceChanges::default(),
            "the replacement has no watcher and inherits no stale events"
        );

        let (_folder, mut registry, workspace) = watched();
        let inbox = registry
            .active
            .as_ref()
            .unwrap()
            .watch
            .as_ref()
            .unwrap()
            .inbox();
        registry.close(OWNER, &workspace.id).unwrap();
        assert!(inbox.lock().unwrap().is_closed());
        assert_eq!(
            registry
                .poll_changes(OWNER, &workspace.id, std::time::Instant::now())
                .unwrap_err(),
            WorkspaceError::PermissionDenied
        );
    }

    #[test]
    fn reload_and_shutdown_stop_the_watcher() {
        let (_folder, registry, workspace) = watched();
        let service = WorkspaceService {
            registry: Mutex::new(registry),
            picker: Mutex::new(()),
        };
        let inbox = {
            let registry = service.registry().unwrap();
            registry
                .active
                .as_ref()
                .unwrap()
                .watch
                .as_ref()
                .unwrap()
                .inbox()
        };
        service.stop_watch();
        assert!(inbox.lock().unwrap().is_closed());
        assert_eq!(
            service
                .registry()
                .unwrap()
                .poll_changes(OWNER, &workspace.id, std::time::Instant::now())
                .unwrap(),
            WorkspaceChanges::default()
        );
        service.watch(OWNER, &workspace.id).unwrap();
        let inbox = {
            let registry = service.registry().unwrap();
            registry
                .active
                .as_ref()
                .unwrap()
                .watch
                .as_ref()
                .unwrap()
                .inbox()
        };
        service.shutdown();
        assert!(inbox.lock().unwrap().is_closed());
        assert_eq!(
            service.watch(OWNER, &workspace.id),
            Err(WorkspaceError::PermissionDenied)
        );
    }

    // Windows refuses to rename a directory while its handle is retained.
    #[cfg(unix)]
    #[test]
    fn a_moved_root_reports_one_rescan_and_stops_watching() {
        let parent = tempfile::tempdir().unwrap();
        let selected = parent.path().join("selected");
        fs::create_dir(&selected).unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register(OWNER, &selected).unwrap();
        let root = registry
            .workspace_path(OWNER, &workspace.id)
            .unwrap()
            .to_path_buf();
        registry
            .attach_watch(OWNER, &workspace.id, watch::Watch::start(&root).unwrap())
            .unwrap();
        fs::rename(&selected, parent.path().join("moved")).unwrap();
        fs::create_dir(&selected).unwrap();
        fs::write(selected.join("impostor.txt"), "outside").unwrap();
        assert_eq!(
            registry
                .poll_changes(OWNER, &workspace.id, std::time::Instant::now())
                .unwrap(),
            WorkspaceChanges {
                paths: Vec::new(),
                rescan: true
            }
        );
        assert!(registry.active.as_ref().unwrap().watch.is_none());
        std::thread::sleep(std::time::Duration::from_millis(400));
        assert_eq!(
            registry
                .poll_changes(OWNER, &workspace.id, std::time::Instant::now())
                .unwrap(),
            WorkspaceChanges::default()
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

    #[test]
    fn saves_existing_text_and_rejects_a_stale_editor_version() {
        let (folder, registry, workspace) = approved();
        let path = folder.path().join("notes.txt");
        fs::write(&path, "original").unwrap();
        let original = registry.read(OWNER, &workspace.id, "notes.txt").unwrap();

        let version = registry
            .write(
                OWNER,
                &workspace.id,
                "notes.txt",
                &original.version,
                "saved ✓",
            )
            .unwrap();
        let saved = registry.read(OWNER, &workspace.id, "notes.txt").unwrap();
        assert_ne!(version, original.version);
        assert_eq!(version, saved.version);
        assert_eq!(saved.content, "saved ✓");
        assert_eq!(
            registry.write(
                OWNER,
                &workspace.id,
                "notes.txt",
                &original.version,
                "lost update"
            ),
            Err(WorkspaceError::FileConflict)
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "saved ✓");
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    }

    #[test]
    fn refuses_external_edits_replacements_and_deletions() {
        let (folder, registry, workspace) = approved();
        let path = folder.path().join("notes.txt");
        fs::write(&path, "original").unwrap();
        let original = registry.read(OWNER, &workspace.id, "notes.txt").unwrap();
        fs::write(&path, "external").unwrap();
        assert_eq!(
            registry.write(OWNER, &workspace.id, "notes.txt", &original.version, "mine"),
            Err(WorkspaceError::FileConflict)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        let edited = registry.read(OWNER, &workspace.id, "notes.txt").unwrap();
        fs::rename(&path, folder.path().join("old")).unwrap();
        fs::write(&path, "external").unwrap();
        assert_eq!(
            registry.write(OWNER, &workspace.id, "notes.txt", &edited.version, "mine"),
            Err(WorkspaceError::FileConflict)
        );
        fs::remove_file(&path).unwrap();
        assert_eq!(
            registry.write(OWNER, &workspace.id, "notes.txt", &edited.version, "mine"),
            Err(WorkspaceError::FileConflict)
        );
        assert!(!path.exists());
    }

    #[test]
    fn writes_require_the_active_workspace_and_a_supported_buffer() {
        let (folder, mut registry, workspace) = approved();
        let path = folder.path().join("notes.txt");
        fs::write(&path, "safe").unwrap();
        let original = registry.read(OWNER, &workspace.id, "notes.txt").unwrap();
        for (owner, id) in [("other", workspace.id.as_str()), (OWNER, "wrong")] {
            assert_eq!(
                registry.write(owner, id, "notes.txt", &original.version, "unauthorized"),
                Err(WorkspaceError::PermissionDenied)
            );
        }
        for (content, error) in [
            ("bad\0buffer".to_owned(), WorkspaceError::InvalidEncoding),
            (
                "x".repeat(MAX_TEXT_BYTES as usize + 1),
                WorkspaceError::FileTooLarge,
            ),
        ] {
            assert_eq!(
                registry.write(
                    OWNER,
                    &workspace.id,
                    "notes.txt",
                    &original.version,
                    &content
                ),
                Err(error)
            );
        }
        registry.close(OWNER, &workspace.id).unwrap();
        assert_eq!(
            registry.write(
                OWNER,
                &workspace.id,
                "notes.txt",
                &original.version,
                "closed"
            ),
            Err(WorkspaceError::PermissionDenied)
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "safe");
    }

    #[test]
    fn a_read_only_target_is_preserved_on_save_failure() {
        let (folder, registry, workspace) = approved();
        let path = folder.path().join("notes.txt");
        fs::write(&path, "read only").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();

        let original = registry.read(OWNER, &workspace.id, "notes.txt").unwrap();
        let write_result = registry.write(
            OWNER,
            &workspace.id,
            "notes.txt",
            &original.version,
            "replace",
        );
        #[cfg(windows)]
        {
            let mut permissions = fs::metadata(&path).unwrap().permissions();
            permissions.set_readonly(false);
            fs::set_permissions(&path, permissions).unwrap();
        }
        assert_eq!(write_result, Err(WorkspaceError::PermissionDenied));
        assert_eq!(fs::read_to_string(path).unwrap(), "read only");
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use crate::contract_fixtures as fixture;

    #[test]
    fn error_codes_match_contract() {
        use WorkspaceError::*;
        let all = [
            Busy,
            WindowLimit,
            PermissionDenied,
            OutsideWorkspace,
            NotFound,
            NotDirectory,
            NotFile,
            InvalidEncoding,
            FileTooLarge,
            FileConflict,
            SaveRace,
            InvalidName,
            EntryChanged,
            NameTaken,
            RenameRace,
            DirectoryTooLarge,
            InvalidSearch,
            SearchCancelled,
            SearchBusy,
            IoError,
        ];
        // Adding a variant breaks this match until it is listed above.
        for error in &all {
            match error {
                Busy | WindowLimit | PermissionDenied | OutsideWorkspace | NotFound
                | NotDirectory | NotFile | InvalidEncoding | FileTooLarge | FileConflict
                | SaveRace | InvalidName | EntryChanged | NameTaken | RenameRace
                | DirectoryTooLarge | InvalidSearch | SearchCancelled | SearchBusy | IoError => {}
            }
        }
        fixture::assert_error_codes("workspace", &all);
    }

    #[test]
    fn entry_kinds_match_contract() {
        let all = [EntryKind::Directory, EntryKind::File];
        for kind in &all {
            match kind {
                EntryKind::Directory | EntryKind::File => {}
            }
        }
        fixture::assert_enum_values("EntryKind", &all);
    }

    #[test]
    fn payloads_match_contract() {
        fixture::assert_payload(
            "WorkspaceDescriptor",
            0,
            &WorkspaceDescriptor {
                id: "ws-1".into(),
                name: "Turing".into(),
                display_path: "~/Projects/Turing".into(),
            },
        );
        fixture::assert_case_count("WorkspaceDescriptor", 1);

        let entry = |name: &str, path: &str, kind, identity: &str| DirectoryEntry {
            name: name.into(),
            relative_path: path.into(),
            kind,
            identity: identity.into(),
        };
        fixture::assert_payload(
            "DirectoryEntry",
            0,
            &entry("src", "src", EntryKind::Directory, "dev:1/ino:2"),
        );
        fixture::assert_payload(
            "DirectoryEntry",
            1,
            &entry("main.rs", "src/main.rs", EntryKind::File, "dev:1/ino:3"),
        );
        fixture::assert_case_count("DirectoryEntry", 2);

        fixture::assert_payload(
            "TextFile",
            0,
            &TextFile {
                workspace_id: "ws-1".into(),
                relative_path: "src/main.rs".into(),
                content: "fn main() {}\n".into(),
                encoding: "utf-8",
                version: "v1".into(),
            },
        );
        fixture::assert_case_count("TextFile", 1);

        fixture::assert_payload(
            "WorkspaceChanges",
            0,
            &WorkspaceChanges {
                paths: vec!["src/main.rs".into(), "docs/ünï".into()],
                rescan: false,
            },
        );
        fixture::assert_payload(
            "WorkspaceChanges",
            1,
            &WorkspaceChanges {
                paths: Vec::new(),
                rescan: true,
            },
        );
        fixture::assert_case_count("WorkspaceChanges", 2);
    }
}
