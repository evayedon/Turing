use super::{file, open_picked_directory, valid_component, Registry, Result, WorkspaceError};
use cap_std::fs::Dir;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

pub struct PickedFile {
    directory: Dir,
    name: String,
    display_path: String,
    parent_path: PathBuf,
    directory_identity: cap_std::fs::Metadata,
}

impl PickedFile {
    // Only native picker results reach this constructor from IPC.
    pub fn from_dialog(path: &Path) -> Result<Self> {
        if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
            return Err(WorkspaceError::OutsideWorkspace);
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| valid_component(name))
            .ok_or(WorkspaceError::OutsideWorkspace)?
            .to_owned();
        let parent = path.parent().ok_or(WorkspaceError::OutsideWorkspace)?;
        let (_, directory) = open_picked_directory(parent)?;
        let display_path = path.display().to_string();
        let directory_identity = directory.dir_metadata()?;
        Ok(Self {
            directory,
            name,
            display_path,
            parent_path: parent.to_path_buf(),
            directory_identity,
        })
    }

    fn check_parent_for_save(&self) -> Result<()> {
        let (_, current) =
            open_picked_directory(&self.parent_path).map_err(|error| match error {
                WorkspaceError::NotFound
                | WorkspaceError::OutsideWorkspace
                | WorkspaceError::NotDirectory => WorkspaceError::FileConflict,
                other => other,
            })?;
        if !file::same_file(&self.directory_identity, &current.dir_metadata()?) {
            return Err(WorkspaceError::FileConflict);
        }
        Ok(())
    }

    fn existing_version(&self) -> Result<Option<String>> {
        match file::read(&self.directory, &self.name) {
            Ok(snapshot) => Ok(Some(snapshot.version)),
            Err(WorkspaceError::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn approve_save(
        self,
        confirm_replace: impl FnOnce(&str) -> bool,
    ) -> Result<Option<ApprovedSave>> {
        let version = self.existing_version()?;
        if version.is_some() && !confirm_replace(&self.display_path) {
            return Ok(None);
        }
        Ok(Some(ApprovedSave {
            file: self,
            version,
        }))
    }
}

pub struct ApprovedSave {
    file: PickedFile,
    version: Option<String>,
}

pub(super) struct SelectedGrant {
    owner: String,
    file: PickedFile,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedFileVersion {
    file_id: String,
    name: String,
    display_path: String,
    version: String,
}

#[derive(Serialize)]
pub struct SelectedFileSnapshot {
    #[serde(flatten)]
    file: SelectedFileVersion,
    content: String,
}

impl Registry {
    fn selected_grant(&self, owner: &str, file_id: &str) -> Result<&PickedFile> {
        self.selected
            .get(file_id)
            .filter(|grant| grant.owner == owner)
            .map(|grant| &grant.file)
            .ok_or(WorkspaceError::PermissionDenied)
    }

    fn register_selected(
        &mut self,
        owner: &str,
        picked: PickedFile,
        version: String,
    ) -> SelectedFileVersion {
        let existing = self.selected.iter().find(|(_, grant)| {
            grant.owner == owner
                && grant.file.name == picked.name
                && file::same_file(&grant.file.directory_identity, &picked.directory_identity)
        });
        let file_id =
            existing.map_or_else(|| uuid::Uuid::new_v4().to_string(), |(id, _)| id.clone());
        let result = picked.version(file_id.clone(), version);
        self.selected.insert(
            file_id,
            SelectedGrant {
                owner: owner.to_owned(),
                file: picked,
            },
        );
        result
    }

    pub fn open_selected(
        &mut self,
        owner: &str,
        picked: PickedFile,
    ) -> Result<SelectedFileSnapshot> {
        let snapshot = file::read(&picked.directory, &picked.name)?;
        Ok(SelectedFileSnapshot {
            file: self.register_selected(owner, picked, snapshot.version),
            content: snapshot.content,
        })
    }

    pub fn selected_execution_snapshot(
        &self,
        owner: &str,
        file_id: &str,
    ) -> Result<(String, String, String, Dir)> {
        let picked = self.selected_grant(owner, file_id)?;
        let snapshot = file::read(&picked.directory, &picked.name)?;
        Ok((
            picked.name.clone(),
            snapshot.content,
            snapshot.version,
            picked.directory.try_clone()?,
        ))
    }

    pub fn read_selected(&self, owner: &str, file_id: &str) -> Result<SelectedFileSnapshot> {
        let picked = self.selected_grant(owner, file_id)?;
        let snapshot = file::read(&picked.directory, &picked.name)?;
        Ok(SelectedFileSnapshot {
            file: picked.version(file_id.to_owned(), snapshot.version),
            content: snapshot.content,
        })
    }

    pub fn write_selected(
        &self,
        owner: &str,
        file_id: &str,
        expected_version: &str,
        content: &str,
    ) -> Result<String> {
        let picked = self.selected_grant(owner, file_id)?;
        picked.check_parent_for_save()?;
        file::write(&picked.directory, &picked.name, expected_version, content)
    }

    pub fn close_selected(&mut self, owner: &str, file_id: &str) -> Result<()> {
        self.selected_grant(owner, file_id)?;
        self.selected.remove(file_id);
        Ok(())
    }

    pub fn save_selected(
        &mut self,
        owner: &str,
        approved: ApprovedSave,
        content: &str,
    ) -> Result<SelectedFileVersion> {
        let picked = approved.file;
        picked.check_parent_for_save()?;
        let version = match approved.version {
            Some(expected) => file::write(&picked.directory, &picked.name, &expected, content)?,
            None => file::create(&picked.directory, &picked.name, content)?,
        };
        Ok(self.register_selected(owner, picked, version))
    }
}

impl PickedFile {
    fn version(&self, file_id: String, version: String) -> SelectedFileVersion {
        SelectedFileVersion {
            file_id,
            name: self.name.clone(),
            display_path: self.display_path.clone(),
            version,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const OWNER: &str = "main";

    fn picked(path: &Path) -> PickedFile {
        PickedFile::from_dialog(path).unwrap()
    }

    #[test]
    fn a_selected_file_leaves_workspace_intact_and_cannot_grant_sibling_access() {
        let workspace_folder = tempfile::tempdir().unwrap();
        let file_folder = tempfile::tempdir().unwrap();
        let path = file_folder.path().join("notes.txt");
        let sibling = file_folder.path().join("private.txt");
        fs::write(&path, "selected").unwrap();
        fs::write(&sibling, "private").unwrap();

        let mut registry = Registry::default();
        let workspace = registry.register(OWNER, workspace_folder.path()).unwrap();
        let opened = registry.open_selected(OWNER, picked(&path)).unwrap();
        assert!(registry.list(OWNER, &workspace.id, "").unwrap().is_empty());
        assert!(matches!(
            registry.read(OWNER, &workspace.id, sibling.to_str().unwrap()),
            Err(WorkspaceError::OutsideWorkspace)
        ));
        assert!(matches!(
            registry.read_selected(OWNER, "../private.txt"),
            Err(WorkspaceError::PermissionDenied)
        ));
        assert!(matches!(
            registry.read_selected("other", &opened.file.file_id),
            Err(WorkspaceError::PermissionDenied)
        ));
        assert_eq!(
            registry.write_selected("other", &opened.file.file_id, &opened.file.version, "bad"),
            Err(WorkspaceError::PermissionDenied)
        );
        assert_eq!(
            registry.close_selected("other", &opened.file.file_id),
            Err(WorkspaceError::PermissionDenied)
        );

        registry.close(OWNER, &workspace.id).unwrap();
        assert_eq!(
            registry
                .read_selected(OWNER, &opened.file.file_id)
                .unwrap()
                .content,
            "selected"
        );
        assert_eq!(
            registry
                .open_selected(OWNER, picked(&path))
                .unwrap()
                .file
                .file_id,
            opened.file.file_id
        );
        registry
            .close_selected(OWNER, &opened.file.file_id)
            .unwrap();
        assert!(matches!(
            registry.read_selected(OWNER, &opened.file.file_id),
            Err(WorkspaceError::PermissionDenied)
        ));
        assert_eq!(fs::read_to_string(sibling).unwrap(), "private");
    }

    #[test]
    fn standalone_save_requires_the_read_version() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("notes.txt");
        fs::write(&path, "first").unwrap();
        let mut registry = Registry::default();
        let opened = registry.open_selected(OWNER, picked(&path)).unwrap();

        let saved = registry
            .write_selected(OWNER, &opened.file.file_id, &opened.file.version, "mine")
            .unwrap();
        assert_eq!(
            registry
                .read_selected(OWNER, &opened.file.file_id)
                .unwrap()
                .file
                .version,
            saved
        );
        fs::write(&path, "external").unwrap();
        assert_eq!(
            registry.write_selected(OWNER, &opened.file.file_id, &saved, "stale"),
            Err(WorkspaceError::FileConflict)
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "external");
    }

    #[test]
    fn save_as_creates_a_file_and_registers_only_the_destination() {
        let folder = tempfile::tempdir().unwrap();
        let original = folder.path().join("original.txt");
        let target = folder.path().join("new.txt");
        fs::write(&original, "original").unwrap();
        let approval = picked(&target)
            .approve_save(|_| panic!("vacant destination"))
            .unwrap()
            .unwrap();

        let mut registry = Registry::default();
        let saved = registry.save_selected(OWNER, approval, "").unwrap();
        assert_eq!(
            registry
                .read_selected(OWNER, &saved.file_id)
                .unwrap()
                .content,
            ""
        );
        assert_eq!(registry.selected.len(), 1);
        assert_eq!(fs::read_to_string(original).unwrap(), "original");
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 2);
    }

    #[test]
    fn existing_destination_requires_confirmation_and_revalidates_after_confirmation() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("existing.txt");
        fs::write(&path, "existing").unwrap();
        let mut registry = Registry::default();

        let canceled = picked(&path).approve_save(|_| false).unwrap();
        assert!(canceled.is_none());
        assert!(registry.selected.is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), "existing");

        let changed = picked(&path)
            .approve_save(|_| {
                fs::write(&path, "external").unwrap();
                true
            })
            .unwrap()
            .unwrap();
        assert!(matches!(
            registry.save_selected(OWNER, changed, "draft"),
            Err(WorkspaceError::FileConflict)
        ));
        assert!(registry.selected.is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");

        let approved = picked(&path).approve_save(|_| true).unwrap().unwrap();
        let saved = registry.save_selected(OWNER, approved, "approved").unwrap();
        assert_eq!(
            registry
                .read_selected(OWNER, &saved.file_id)
                .unwrap()
                .content,
            "approved"
        );
    }

    #[test]
    fn a_new_destination_that_appears_after_approval_is_never_overwritten() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("new.txt");
        let approved = picked(&path)
            .approve_save(|_| panic!("vacant destination"))
            .unwrap()
            .unwrap();
        fs::write(&path, "competing creation").unwrap();

        let mut registry = Registry::default();
        assert!(matches!(
            registry.save_selected(OWNER, approved, "mine"),
            Err(WorkspaceError::FileConflict)
        ));
        assert!(registry.selected.is_empty());
        assert_eq!(fs::read_to_string(path).unwrap(), "competing creation");
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn save_as_rejects_a_replaced_parent_after_approval() {
        let base = tempfile::tempdir().unwrap();
        let parent = base.path().join("chosen");
        fs::create_dir(&parent).unwrap();
        let target = parent.join("new.txt");
        let approved = picked(&target).approve_save(|_| false).unwrap().unwrap();

        let moved = base.path().join("moved");
        fs::rename(&parent, &moved).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), &parent).unwrap();

        let mut registry = Registry::default();
        assert!(matches!(
            registry.save_selected(OWNER, approved, "draft"),
            Err(WorkspaceError::FileConflict)
        ));
        assert!(registry.selected.is_empty());
        assert!(!moved.join("new.txt").exists());
        assert!(!outside.path().join("new.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_never_granted_or_used_as_a_save_as_destination() {
        let approved_parent = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = approved_parent.path().join("link.txt");
        let private = outside.path().join("private.txt");
        fs::write(&private, "untouched").unwrap();
        std::os::unix::fs::symlink(&private, &link).unwrap();

        let mut registry = Registry::default();
        assert!(matches!(
            registry.open_selected(OWNER, picked(&link)),
            Err(WorkspaceError::OutsideWorkspace)
        ));
        assert!(matches!(
            picked(&link).approve_save(|_| true),
            Err(WorkspaceError::OutsideWorkspace)
        ));
        assert!(registry.selected.is_empty());
        assert_eq!(fs::read_to_string(private).unwrap(), "untouched");
    }

    #[test]
    fn dialog_paths_and_standalone_text_limits_are_checked() {
        assert!(matches!(
            PickedFile::from_dialog(Path::new("../file.txt")),
            Err(WorkspaceError::OutsideWorkspace)
        ));
        let folder = tempfile::tempdir().unwrap();
        let binary = folder.path().join("binary.txt");
        fs::write(&binary, [0xff]).unwrap();
        let path = folder.path().join("new.txt");
        let approved = picked(&path).approve_save(|_| false).unwrap().unwrap();
        let mut registry = Registry::default();

        assert!(matches!(
            registry.open_selected(OWNER, picked(&binary)),
            Err(WorkspaceError::InvalidEncoding)
        ));
        assert!(matches!(
            registry.save_selected(
                OWNER,
                approved,
                &"x".repeat(super::super::MAX_TEXT_BYTES as usize + 1)
            ),
            Err(WorkspaceError::FileTooLarge)
        ));
        assert!(registry.selected.is_empty());
        assert!(!path.exists());
    }
}
