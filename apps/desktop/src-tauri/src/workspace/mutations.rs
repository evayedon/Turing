use super::{
    directory_at, file, relative_parts, valid_component, Registry, Result, TextFile, WorkspaceError,
};
use cap_fs_ext::MetadataExt;
use cap_std::fs::{Dir, Metadata, OpenOptions};
use sha2::{Digest, Sha256};
use std::io;

pub(super) fn identity(parent: &Metadata, entry: &Metadata) -> String {
    let mut digest = Sha256::new();
    for metadata in [parent, entry] {
        digest.update(metadata.dev().to_le_bytes());
        digest.update(metadata.ino().to_le_bytes());
        if let Ok(created) = metadata.created() {
            digest.update(format!("{created:?}").as_bytes());
        }
    }
    format!("{:x}", digest.finalize())
}

fn validate_name(name: &str) -> Result<()> {
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|tail| {
            matches!(
                tail,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if !valid_component(name)
        || name.len() > 255
        || reserved
        || name
            .chars()
            .any(|character| character.is_control() || "<>\"|?*".contains(character))
        || name.starts_with(".turing-save-")
    {
        return Err(WorkspaceError::InvalidName);
    }
    Ok(())
}

fn path_in(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.into()
    } else {
        format!("{parent}/{name}")
    }
}

fn mutation_error(error: io::Error) -> WorkspaceError {
    if error.kind() == io::ErrorKind::AlreadyExists {
        WorkspaceError::NameTaken
    } else {
        error.into()
    }
}

fn check_entry(metadata: &Metadata) -> Result<()> {
    if super::is_workspace_link(metadata) {
        return Err(WorkspaceError::OutsideWorkspace);
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(WorkspaceError::NotFile);
    }
    Ok(())
}

impl Registry {
    pub fn create_file(&self, owner: &str, id: &str, parent: &str, name: &str) -> Result<TextFile> {
        let root = self.authorize(owner, id)?;
        validate_name(name)?;
        let directory = directory_at(root, &relative_parts(parent)?)?;
        let mut options = OpenOptions::new();
        let created = directory
            .open_with(name, options.write(true).create_new(true))
            .map_err(mutation_error)?;
        // Get the version from the newly created handle. Reopening by name
        // could otherwise return a file swapped in immediately after creation.
        let version = file::version(&created.metadata()?, b"")?;
        Ok(TextFile {
            workspace_id: id.into(),
            relative_path: path_in(parent, name),
            content: String::new(),
            encoding: "utf-8",
            version,
        })
    }

    pub fn rename_entry(
        &self,
        owner: &str,
        id: &str,
        path: &str,
        name: &str,
        expected_identity: &str,
    ) -> Result<String> {
        let root = self.authorize(owner, id)?;
        validate_name(name)?;
        let mut parts = relative_parts(path)?;
        let old = parts.pop().ok_or(WorkspaceError::OutsideWorkspace)?;
        let parent = directory_at(root, &parts)?;
        let before = parent.symlink_metadata(old)?;
        check_entry(&before)?;
        if identity(&parent.dir_metadata()?, &before) != expected_identity {
            return Err(WorkspaceError::EntryChanged);
        }
        if old != name {
            match parent.symlink_metadata(name) {
                Ok(existing) if !file::same_file(&before, &existing) => {
                    return Err(WorkspaceError::NameTaken)
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            rename_entry(&parent, old, name, &before)?;
        }
        Ok(path_in(&parts.join("/"), name))
    }
}

#[cfg(unix)]
fn rename_entry(parent: &Dir, old: &str, name: &str, before: &Metadata) -> Result<()> {
    use super::open_child_dir;
    use rustix::fs::{mkdirat, renameat_with, Mode, RenameFlags};
    use std::path::Path;

    // Unix rename names an entry, not an open source handle. Move it into a
    // private directory first, then verify it before publishing the new name.
    let staging = format!(".turing-save-{}.rename", uuid::Uuid::new_v4());
    mkdirat(parent, &staging, Mode::RWXU).map_err(io::Error::from)?;
    let result = (|| {
        let stage = open_child_dir(parent, Path::new(&staging))?;
        let exclusive = |from: &Dir, source: &str, to: &Dir, target: &str| {
            renameat_with(from, source, to, target, RenameFlags::NOREPLACE).map_err(io::Error::from)
        };
        exclusive(parent, old, &stage, old).map_err(mutation_error)?;
        let result = (|| {
            let moved = stage.symlink_metadata(old)?;
            check_entry(&moved)?;
            if !file::same_file(before, &moved) {
                return Err(WorkspaceError::EntryChanged);
            }
            exclusive(&stage, old, parent, name).map_err(mutation_error)
        })();
        if result.is_err() && exclusive(&stage, old, parent, old).is_err() {
            return Err(WorkspaceError::RenameRace);
        }
        result
    })();
    // A contested rollback leaves the entry intact in the staging directory.
    if !matches!(result, Err(WorkspaceError::RenameRace)) {
        let _ = parent.remove_dir(&staging);
    }
    result
}

#[cfg(windows)]
fn rename_entry(parent: &Dir, old: &str, name: &str, before: &Metadata) -> Result<()> {
    use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
    use cap_std::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{
            FileRenameInfo, SetFileInformationByHandle, DELETE, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
        },
    };

    let entry = parent.open_with(
        old,
        OpenOptions::new()
            .read(true)
            .access_mode(DELETE | FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .maybe_dir(before.is_dir())
            .follow(FollowSymlinks::No),
    )?;
    let current = entry.metadata()?;
    check_entry(&current)?;
    if !file::same_file(before, &current) {
        return Err(WorkspaceError::EntryChanged);
    }

    // FILE_RENAME_INFO with storage for a variable-length UTF-16 component.
    #[repr(C)]
    struct RenameInfo {
        flags: u32,
        root: HANDLE,
        length: u32,
        filename: [u16; 256],
    }
    let mut info = RenameInfo {
        flags: 0,
        root: parent.as_raw_handle(),
        length: 0,
        filename: [0; 256],
    };
    for (slot, unit) in info.filename.iter_mut().zip(name.encode_utf16()) {
        *slot = unit;
        info.length += 2;
    }
    let size = std::mem::offset_of!(RenameInfo, filename) as u32 + info.length + 2;
    if unsafe {
        SetFileInformationByHandle(
            entry.as_raw_handle(),
            FileRenameInfo,
            (&info as *const RenameInfo).cast(),
            size,
        )
    } == 0
    {
        return Err(mutation_error(io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace() -> (tempfile::TempDir, Registry) {
        let temp = tempfile::tempdir().unwrap();
        let mut registry = Registry::default();
        registry.register("main", temp.path()).unwrap();
        (temp, registry)
    }

    fn token(registry: &Registry, parent: &str, name: &str) -> String {
        registry
            .list("main", "1", parent)
            .unwrap()
            .into_iter()
            .find(|entry| entry.name == name)
            .unwrap()
            .identity
    }

    #[test]
    fn creates_named_workspace_files_exclusively_and_validates_the_caller() {
        let (temp, registry) = workspace();
        fs::create_dir(temp.path().join("src")).unwrap();
        let created = registry
            .create_file("main", "1", "src", "hello ü.py")
            .unwrap();
        assert_eq!(created.relative_path, "src/hello ü.py");
        let version = registry
            .write(
                "main",
                "1",
                &created.relative_path,
                &created.version,
                "print(1)",
            )
            .unwrap();
        assert_ne!(version, created.version);
        assert!(matches!(
            registry.create_file("main", "1", "src", "hello ü.py"),
            Err(WorkspaceError::NameTaken)
        ));
        assert_eq!(
            fs::read_to_string(temp.path().join("src/hello ü.py")).unwrap(),
            "print(1)"
        );
        for path in ["../escape", "bad/name", "NUL.py", "bad?.cpp", "end."] {
            assert!(matches!(
                registry.create_file("main", "1", "", path),
                Err(WorkspaceError::InvalidName)
            ));
        }
        assert!(matches!(
            registry.create_file("main", "1", "..", "valid.py"),
            Err(WorkspaceError::OutsideWorkspace)
        ));
        assert!(matches!(
            registry.create_file("other", "1", "", "valid.py"),
            Err(WorkspaceError::PermissionDenied)
        ));
    }

    #[test]
    fn renames_a_file_then_its_parent_without_invalidating_the_saved_version() {
        let (temp, registry) = workspace();
        fs::create_dir(temp.path().join("src")).unwrap();
        fs::write(temp.path().join("src/main.txt"), "print(1)").unwrap();
        let tab = registry.read("main", "1", "src/main.txt").unwrap();
        let entry = token(&registry, "src", "main.txt");
        let folder = token(&registry, "", "src");
        assert_eq!(
            registry
                .rename_entry("main", "1", "src/main.txt", "main.py", &entry)
                .unwrap(),
            "src/main.py"
        );
        assert_eq!(
            registry
                .rename_entry("main", "1", "src", "code", &folder)
                .unwrap(),
            "code"
        );
        assert_eq!(
            registry.read("main", "1", "code/main.py").unwrap().version,
            tab.version
        );
        assert!(!temp.path().join("src").exists());
        assert_eq!(
            fs::read_to_string(temp.path().join("code/main.py")).unwrap(),
            "print(1)"
        );
    }

    #[test]
    fn rename_rejects_destination_conflicts_replacement_stale_tokens_and_unauthorized_callers() {
        let (temp, registry) = workspace();
        let path = temp.path().join("source.py");
        fs::write(&path, "old").unwrap();
        fs::write(temp.path().join("target.py"), "keep").unwrap();
        let entry = token(&registry, "", "source.py");
        assert_eq!(
            registry.rename_entry("other", "1", "source.py", "another.py", &entry),
            Err(WorkspaceError::PermissionDenied)
        );
        assert_eq!(
            registry.rename_entry("main", "1", "source.py", "target.py", &entry),
            Err(WorkspaceError::NameTaken)
        );
        #[cfg(unix)]
        {
            let root = registry.authorize("main", "1").unwrap();
            let expected = root.symlink_metadata("source.py").unwrap();
            assert_eq!(
                rename_entry(root, "source.py", "target.py", &expected),
                Err(WorkspaceError::NameTaken)
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        }
        fs::rename(&path, temp.path().join("old.py")).unwrap();
        fs::write(&path, "replacement").unwrap();
        assert_eq!(
            registry.rename_entry("main", "1", "source.py", "another.py", &entry),
            Err(WorkspaceError::EntryChanged)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
        assert_eq!(
            fs::read_to_string(temp.path().join("target.py")).unwrap(),
            "keep"
        );
        assert!(!temp.path().join("another.py").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_sources_and_parents_and_rolls_back_a_raced_source() {
        use std::os::unix::fs::symlink;
        let (temp, registry) = workspace();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("original.py");
        fs::write(&victim, "outside").unwrap();
        symlink(outside.path(), temp.path().join("linked")).unwrap();
        symlink(&victim, temp.path().join("link.py")).unwrap();
        assert!(matches!(
            registry.create_file("main", "1", "linked", "new.py"),
            Err(WorkspaceError::OutsideWorkspace)
        ));
        assert_eq!(
            registry.rename_entry("main", "1", "link.py", "inside.py", "any"),
            Err(WorkspaceError::OutsideWorkspace)
        );

        let path = temp.path().join("source.py");
        fs::write(&path, "approved").unwrap();
        let root = registry.authorize("main", "1").unwrap();
        let expected = root.symlink_metadata("source.py").unwrap();
        fs::rename(&path, temp.path().join("approved.py")).unwrap();
        fs::write(&path, "replacement").unwrap();
        assert_eq!(
            rename_entry(root, "source.py", "changed.py", &expected),
            Err(WorkspaceError::EntryChanged)
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
        assert_eq!(fs::read_to_string(&victim).unwrap(), "outside");
        assert!(!temp.path().join("changed.py").exists());
    }
}
