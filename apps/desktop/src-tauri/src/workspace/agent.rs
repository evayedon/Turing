use super::{
    directory_at, file, is_workspace_link, open_child_dir, relative_parts, Registry, Result,
    Workspace, WorkspaceError,
};
use cap_std::fs::Dir;
use std::{io, path::Path};

impl Registry {
    /// Creates `relative_path` with `content`, creating missing parents one component at a time
    /// through handle-relative `create_dir`. Returns (version, created_dirs).
    /// `FileConflict` if the file exists; rejects symlinked components and a replaced root.
    pub(crate) fn agent_create(
        &self,
        owner: &str,
        id: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<(String, Vec<String>)> {
        let workspace = self.agent_workspace(owner, id)?;
        let parts = relative_parts(relative_path)?;
        let (_, parents) = parts.split_last().ok_or(WorkspaceError::OutsideWorkspace)?;
        file::validate_content(content.as_bytes())?;

        let mut created: Vec<(Dir, usize)> = Vec::new();
        let result = create_parents(&workspace.root, parents, &mut created).and_then(|()| {
            // Re-checks the root and verifies the parent chain after staging.
            file::recreate(&workspace.root, relative_path, content, || {
                !workspace.root_replaced()
            })
        });
        match result {
            Ok(version) => Ok((
                version,
                created
                    .iter()
                    .map(|(_, index)| parents[..=*index].join("/"))
                    .collect(),
            )),
            Err(error) => {
                // Best-effort cleanup: remove_dir only succeeds on an empty directory.
                for (parent, index) in created.iter().rev() {
                    let _ = parent.remove_dir(parents[*index]);
                }
                Err(error)
            }
        }
    }

    /// Removes a regular text file only if its current version equals `expected_version`.
    pub(crate) fn agent_delete(
        &self,
        owner: &str,
        id: &str,
        relative_path: &str,
        expected_version: &str,
    ) -> Result<()> {
        let workspace = self.agent_workspace(owner, id)?;
        let parts = relative_parts(relative_path)?;
        let (name, parents) = parts.split_last().ok_or(WorkspaceError::OutsideWorkspace)?;
        let directory = directory_at(&workspace.root, parents)?;
        if file::read_snapshot(&directory, name, true)?.version != expected_version {
            return Err(WorkspaceError::FileConflict);
        }
        parent_current(workspace, parents, &directory)?;

        // Move the entry aside first so a file swapped in after the check is never deleted.
        let staging = format!(".turing-save-{}.delete", uuid::Uuid::new_v4());
        directory.rename(name, &directory, &staging)?;
        if file::read_snapshot(&directory, &staging, false)
            .is_ok_and(|snapshot| snapshot.version == expected_version)
        {
            let Err(error) = directory.remove_file(&staging) else {
                return Ok(());
            };
            restore(&directory, &staging, name)?;
            return Err(error.into());
        }
        restore(&directory, &staging, name)?;
        Err(WorkspaceError::SaveRace)
    }

    /// Removes an empty directory (used by rollback for directories the agent created); never
    /// follows links. It does not itself know which directories the agent created.
    pub(crate) fn agent_remove_empty_dir(
        &self,
        owner: &str,
        id: &str,
        relative_path: &str,
    ) -> Result<()> {
        let workspace = self.agent_workspace(owner, id)?;
        let parts = relative_parts(relative_path)?;
        let (name, parents) = parts.split_last().ok_or(WorkspaceError::OutsideWorkspace)?;
        let directory = directory_at(&workspace.root, parents)?;
        let metadata = directory.symlink_metadata(name)?;
        if is_workspace_link(&metadata) {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        if !metadata.is_dir() {
            return Err(WorkspaceError::NotDirectory);
        }
        parent_current(workspace, parents, &directory)?;
        directory.remove_dir(name).map_err(|error| {
            if error.kind() == io::ErrorKind::DirectoryNotEmpty {
                WorkspaceError::FileConflict
            } else {
                error.into()
            }
        })
    }

    /// The caller's active workspace, refused once its root path no longer names the approved
    /// directory.
    fn agent_workspace(&self, owner: &str, id: &str) -> Result<&Workspace> {
        let workspace = self
            .active
            .as_ref()
            .filter(|workspace| workspace.owner == owner && workspace.descriptor.id == id)
            .ok_or(WorkspaceError::PermissionDenied)?;
        if workspace.root_replaced() {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        Ok(workspace)
    }
}

/// Opens each parent, creating only the missing ones. Each new directory is recorded with its
/// parent handle and index so a failed create can remove it again.
fn create_parents(root: &Dir, parents: &[&str], created: &mut Vec<(Dir, usize)>) -> Result<()> {
    let mut directory = root.try_clone()?;
    for (index, component) in parents.iter().enumerate() {
        let name = Path::new(component);
        directory = match open_child_dir(&directory, name) {
            Err(WorkspaceError::NotFound) => {
                directory.create_dir(name)?;
                // Record before opening so a directory swapped for a link is still cleaned up.
                created.push((directory, index));
                let (parent, _) = created.last().ok_or(WorkspaceError::IoError)?;
                open_child_dir(parent, name)?
            }
            other => other?,
        };
    }
    Ok(())
}

/// Puts a staged entry back under `name` only if that name is still free. An exclusive hard link
/// never replaces a third writer's entry; on failure the original stays under `staging` and the
/// caller gets `SaveRace` (whose message points at the `.turing-save-*` recovery file).
fn restore(directory: &Dir, staging: &str, name: &str) -> Result<()> {
    directory
        .hard_link(staging, directory, name)
        .map_err(|_| WorkspaceError::SaveRace)?;
    // Both names now hold the same inode, so a failed unlink loses nothing.
    directory.remove_file(staging)?;
    Ok(())
}

/// Refuses a parent that was moved or replaced after it was opened, or a replaced root.
fn parent_current(workspace: &Workspace, parents: &[&str], directory: &Dir) -> Result<()> {
    if workspace.root_replaced() {
        return Err(WorkspaceError::OutsideWorkspace);
    }
    let current = directory_at(&workspace.root, parents)?;
    if !file::same_file(&current.dir_metadata()?, &directory.dir_metadata()?) {
        return Err(WorkspaceError::FileConflict);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{Registry, WorkspaceError};
    use std::fs;

    const OWNER: &str = "main";

    fn approved() -> (tempfile::TempDir, Registry, String) {
        let folder = tempfile::tempdir().unwrap();
        let mut registry = Registry::default();
        let id = registry.register(OWNER, folder.path()).unwrap().id;
        (folder, registry, id)
    }

    #[test]
    fn agent_create_makes_missing_parents_and_reports_them() {
        let (folder, registry, id) = approved();
        fs::create_dir(folder.path().join("src")).unwrap();
        let (version, created) = registry
            .agent_create(OWNER, &id, "src/new/mod.rs", "pub fn f() {}\n")
            .unwrap();
        assert_eq!(
            fs::read_to_string(folder.path().join("src/new/mod.rs")).unwrap(),
            "pub fn f() {}\n"
        );
        assert_eq!(created, vec!["src/new".to_owned()]);
        assert_eq!(
            registry.read(OWNER, &id, "src/new/mod.rs").unwrap().version,
            version
        );
        let (_, created) = registry.agent_create(OWNER, &id, "a/b/c.txt", "x").unwrap();
        assert_eq!(created, vec!["a".to_owned(), "a/b".to_owned()]);
    }

    #[test]
    fn agent_create_rejects_traversal_absolute_and_existing_files() {
        let (folder, registry, id) = approved();
        for path in ["../x", "/etc/x", "a/../../x", "C:\\x", ""] {
            assert_eq!(
                registry.agent_create(OWNER, &id, path, "x"),
                Err(WorkspaceError::OutsideWorkspace),
                "{path}"
            );
        }
        assert!(!folder.path().join("a").exists());
        fs::write(folder.path().join("kept.txt"), "user").unwrap();
        assert_eq!(
            registry.agent_create(OWNER, &id, "kept.txt", "agent"),
            Err(WorkspaceError::FileConflict)
        );
        assert_eq!(
            fs::read_to_string(folder.path().join("kept.txt")).unwrap(),
            "user"
        );
    }

    #[test]
    fn agent_create_removes_its_new_parents_when_the_file_is_refused() {
        let (folder, registry, id) = approved();
        assert_eq!(
            registry.agent_create(OWNER, &id, "new/deep/x.bin", "a\0b"),
            Err(WorkspaceError::InvalidEncoding)
        );
        assert!(!folder.path().join("new").exists());
    }

    #[cfg(unix)]
    #[test]
    fn agent_create_refuses_a_symlinked_parent() {
        let (folder, registry, id) = approved();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), folder.path().join("link")).unwrap();
        for path in ["link/x", "link/deeper/x"] {
            assert_eq!(
                registry.agent_create(OWNER, &id, path, "x"),
                Err(WorkspaceError::OutsideWorkspace)
            );
        }
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    // Windows refuses to rename an open workspace root, so the race is Unix-only.
    #[cfg(unix)]
    #[test]
    fn agent_create_detects_root_replacement() {
        let container = tempfile::tempdir().unwrap();
        let root = container.path().join("approved");
        fs::create_dir(&root).unwrap();
        let mut registry = Registry::default();
        let id = registry.register(OWNER, &root).unwrap().id;
        fs::rename(&root, container.path().join("moved")).unwrap();
        fs::create_dir(&root).unwrap();
        assert_eq!(
            registry.agent_create(OWNER, &id, "dir/new.txt", "x"),
            Err(WorkspaceError::OutsideWorkspace)
        );
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        assert!(fs::read_dir(container.path().join("moved"))
            .unwrap()
            .next()
            .is_none());
        fs::write(container.path().join("moved/old.txt"), "x").unwrap();
        assert_eq!(
            registry.agent_remove_empty_dir(OWNER, &id, "dir"),
            Err(WorkspaceError::OutsideWorkspace)
        );
    }

    #[test]
    fn agent_delete_requires_the_current_version_and_a_regular_file() {
        let (folder, registry, id) = approved();
        let path = folder.path().join("old.txt");
        fs::write(&path, "first").unwrap();
        let stale = registry.read(OWNER, &id, "old.txt").unwrap().version;
        fs::write(&path, "second, longer").unwrap();
        assert_eq!(
            registry.agent_delete(OWNER, &id, "old.txt", &stale),
            Err(WorkspaceError::FileConflict)
        );
        assert!(path.exists());
        fs::create_dir(folder.path().join("dir")).unwrap();
        assert_eq!(
            registry.agent_delete(OWNER, &id, "dir", &stale),
            Err(WorkspaceError::NotFile)
        );
        assert_eq!(
            registry.agent_delete(OWNER, &id, "../old.txt", &stale),
            Err(WorkspaceError::OutsideWorkspace)
        );
        let current = registry.read(OWNER, &id, "old.txt").unwrap().version;
        registry
            .agent_delete(OWNER, &id, "old.txt", &current)
            .unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn agent_delete_refuses_links() {
        let (folder, registry, id) = approved();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("target.txt"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), folder.path().join("link")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("target.txt"),
            folder.path().join("file-link"),
        )
        .unwrap();
        for path in ["link/target.txt", "file-link"] {
            assert_eq!(
                registry.agent_delete(OWNER, &id, path, "any"),
                Err(WorkspaceError::OutsideWorkspace)
            );
        }
        assert!(outside.path().join("target.txt").exists());
        assert!(folder.path().join("file-link").exists());
    }

    #[test]
    fn agent_remove_empty_dir_refuses_non_empty_and_links() {
        let (folder, registry, id) = approved();
        fs::create_dir_all(folder.path().join("full")).unwrap();
        fs::write(folder.path().join("full/keep.txt"), "x").unwrap();
        assert_eq!(
            registry.agent_remove_empty_dir(OWNER, &id, "full"),
            Err(WorkspaceError::FileConflict)
        );
        assert!(folder.path().join("full/keep.txt").exists());
        assert_eq!(
            registry.agent_remove_empty_dir(OWNER, &id, "full/keep.txt"),
            Err(WorkspaceError::NotDirectory)
        );
        fs::create_dir(folder.path().join("empty")).unwrap();
        registry
            .agent_remove_empty_dir(OWNER, &id, "empty")
            .unwrap();
        assert!(!folder.path().join("empty").exists());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(), folder.path().join("link")).unwrap();
            assert_eq!(
                registry.agent_remove_empty_dir(OWNER, &id, "link"),
                Err(WorkspaceError::OutsideWorkspace)
            );
            assert!(outside.path().exists());
            assert!(folder.path().join("link").exists());
        }
    }

    #[test]
    fn restore_never_overwrites_an_entry_that_took_the_name() {
        let folder = tempfile::tempdir().unwrap();
        let directory =
            cap_std::fs::Dir::open_ambient_dir(folder.path(), cap_std::ambient_authority())
                .unwrap();
        fs::write(folder.path().join(".staged"), "original").unwrap();
        fs::write(folder.path().join("name"), "third writer").unwrap();
        assert_eq!(
            super::restore(&directory, ".staged", "name"),
            Err(WorkspaceError::SaveRace)
        );
        assert_eq!(
            fs::read_to_string(folder.path().join("name")).unwrap(),
            "third writer"
        );
        assert_eq!(
            fs::read_to_string(folder.path().join(".staged")).unwrap(),
            "original"
        );

        fs::remove_file(folder.path().join("name")).unwrap();
        super::restore(&directory, ".staged", "name").unwrap();
        assert_eq!(
            fs::read_to_string(folder.path().join("name")).unwrap(),
            "original"
        );
        assert!(!folder.path().join(".staged").exists());
    }

    #[test]
    fn agent_writes_are_scoped_to_the_owner() {
        let (folder, registry, id) = approved();
        fs::write(folder.path().join("a.txt"), "x").unwrap();
        fs::create_dir(folder.path().join("d")).unwrap();
        let version = registry.read(OWNER, &id, "a.txt").unwrap().version;
        for (owner, workspace) in [("other", id.as_str()), (OWNER, "unregistered")] {
            assert_eq!(
                registry.agent_create(owner, workspace, "b.txt", "x"),
                Err(WorkspaceError::PermissionDenied)
            );
            assert_eq!(
                registry.agent_delete(owner, workspace, "a.txt", &version),
                Err(WorkspaceError::PermissionDenied)
            );
            assert_eq!(
                registry.agent_remove_empty_dir(owner, workspace, "d"),
                Err(WorkspaceError::PermissionDenied)
            );
        }
        assert!(!folder.path().join("b.txt").exists());
        assert!(folder.path().join("a.txt").exists());
        assert!(folder.path().join("d").exists());
    }
}
