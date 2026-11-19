use super::{directory_at, relative_parts, Result, WorkspaceError, MAX_TEXT_BYTES};
use cap_fs_ext::{FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::fs::{Dir, File, Metadata, OpenOptions};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub(super) struct Snapshot {
    pub content: String,
    pub version: String,
    metadata: Metadata,
}

pub(super) fn open_text(directory: &Dir, name: &str, writable: bool) -> Result<File> {
    let metadata = directory.symlink_metadata(name)?;
    if metadata.is_symlink() {
        return Err(WorkspaceError::OutsideWorkspace);
    }
    if !metadata.is_file() {
        return Err(WorkspaceError::NotFile);
    }
    if writable && metadata.permissions().readonly() {
        return Err(WorkspaceError::PermissionDenied);
    }

    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(writable)
        .follow(FollowSymlinks::No)
        .nonblock(true);
    let file = directory.open_with(name, &options)?;
    if !same_file(&metadata, &file.metadata()?) {
        return Err(WorkspaceError::FileConflict);
    }
    Ok(file)
}

pub(super) fn same_file(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

pub(super) fn version(metadata: &Metadata, bytes: &[u8]) -> Result<String> {
    let modified = metadata.modified()?.into_std();
    let mut digest = Sha256::new();
    digest.update(metadata.dev().to_le_bytes());
    digest.update(metadata.ino().to_le_bytes());
    // Include metadata identity and time so an identical replacement still
    // invalidates the prior snapshot.
    digest.update(format!("{modified:?}").as_bytes());
    digest.update(bytes);
    Ok(format!("{:x}", digest.finalize()))
}

pub(super) fn validate_content(bytes: &[u8]) -> Result<()> {
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err(WorkspaceError::FileTooLarge);
    }
    if bytes.contains(&0) {
        return Err(WorkspaceError::InvalidEncoding);
    }
    Ok(())
}

fn read_snapshot(directory: &Dir, name: &str, writable: bool) -> Result<Snapshot> {
    read_snapshot_metered(directory, name, writable, &mut 0)
}

pub(super) fn read_snapshot_metered(
    directory: &Dir,
    name: &str,
    writable: bool,
    bytes_read: &mut u64,
) -> Result<Snapshot> {
    let mut file = open_text(directory, name, writable)?;
    let before = file.metadata()?;
    if !before.is_file() {
        return Err(WorkspaceError::NotFile);
    }
    if before.len() > MAX_TEXT_BYTES {
        return Err(WorkspaceError::FileTooLarge);
    }

    let mut bytes = Vec::new();
    let read = (&mut file).take(MAX_TEXT_BYTES + 1).read_to_end(&mut bytes);
    *bytes_read += bytes.len() as u64;
    read?;
    validate_content(&bytes)?;
    let metadata = file.metadata()?;
    if before.len() != metadata.len()
        || metadata.len() != bytes.len() as u64
        || before.modified()? != metadata.modified()?
        || !same_file(&metadata, &directory.symlink_metadata(name)?)
    {
        return Err(WorkspaceError::FileConflict);
    }
    let version = version(&metadata, &bytes)?;
    let content = String::from_utf8(bytes).map_err(|_| WorkspaceError::InvalidEncoding)?;
    Ok(Snapshot {
        content,
        version,
        metadata,
    })
}

pub(super) fn read(root: &Dir, relative_path: &str) -> Result<Snapshot> {
    let parts = relative_parts(relative_path)?;
    let (name, parents) = parts.split_last().ok_or(WorkspaceError::NotFile)?;
    read_snapshot(&directory_at(root, parents)?, name, false)
}

fn require_version(directory: &Dir, name: &str, expected: &str) -> Result<Snapshot> {
    let snapshot = read_snapshot(directory, name, true).map_err(|error| match error {
        WorkspaceError::NotFound
        | WorkspaceError::NotFile
        | WorkspaceError::InvalidEncoding
        | WorkspaceError::FileTooLarge => WorkspaceError::FileConflict,
        other => other,
    })?;
    if snapshot.version != expected {
        return Err(WorkspaceError::FileConflict);
    }
    Ok(snapshot)
}

pub(super) fn write(
    root: &Dir,
    relative_path: &str,
    expected: &str,
    content: &str,
) -> Result<String> {
    let parts = relative_parts(relative_path)?;
    let (name, parents) = parts.split_last().ok_or(WorkspaceError::NotFile)?;
    validate_content(content.as_bytes())?;
    let directory = directory_at(root, parents)?;
    let original = require_version(&directory, name, expected)?;

    let (staging, prepared) = stage(&directory, content, Some(&original.metadata))?;

    let current_directory = directory_at(root, parents)?;
    if !same_file(
        &directory.dir_metadata()?,
        &current_directory.dir_metadata()?,
    ) {
        return Err(WorkspaceError::FileConflict);
    }
    let current = require_version(&current_directory, name, expected)?;
    if current.metadata.permissions() != original.metadata.permissions() {
        return Err(WorkspaceError::FileConflict);
    }

    if !same_file(
        &prepared.metadata,
        &directory.symlink_metadata(&staging.name)?,
    ) {
        return Err(WorkspaceError::FileConflict);
    }
    staging.commit(&current_directory, name, expected, &prepared.version)?;
    Ok(prepared.version)
}

pub(super) fn create(directory: &Dir, name: &str, content: &str) -> Result<String> {
    validate_content(content.as_bytes())?;
    let (mut staging, prepared) = stage(directory, content, None)?;
    if !same_file(
        &prepared.metadata,
        &directory.symlink_metadata(&staging.name)?,
    ) {
        return Err(WorkspaceError::FileConflict);
    }

    // Atomically publish the synced file only if the destination name is vacant.
    directory
        .hard_link(&staging.name, directory, name)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                WorkspaceError::FileConflict
            } else {
                error.into()
            }
        })?;
    if !matches_version(directory, name, &prepared.version) {
        staging.preserve = true;
        return Err(WorkspaceError::SaveRace);
    }
    Ok(prepared.version)
}

fn stage<'a>(
    directory: &'a Dir,
    content: &str,
    original: Option<&Metadata>,
) -> Result<(StagedFile<'a>, Snapshot)> {
    #[cfg(not(unix))]
    let _ = original;
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let temporary_name = format!(".turing-save-{}.tmp", uuid::Uuid::new_v4());
    let mut output = directory.open_with(&temporary_name, &options)?;
    let staging = StagedFile {
        directory,
        name: temporary_name,
        preserve: false,
    };
    output.write_all(content.as_bytes())?;
    #[cfg(unix)]
    if let Some(original) = original {
        use cap_std::fs::{MetadataExt as _, PermissionsExt};
        let staged = output.metadata()?;
        if (staged.uid(), staged.gid()) != (original.uid(), original.gid()) {
            return Err(WorkspaceError::PermissionDenied);
        }
        let mode = original.permissions().mode() & 0o777;
        output.set_permissions(cap_std::fs::Permissions::from_mode(mode))?;
    }
    output.sync_all()?;
    let output_metadata = output.metadata()?;
    drop(output);
    let prepared = read_snapshot(directory, &staging.name, false)?;
    if !same_file(&output_metadata, &prepared.metadata) || prepared.content != content {
        return Err(WorkspaceError::FileConflict);
    }

    Ok((staging, prepared))
}

fn matches_version(directory: &Dir, name: &str, expected: &str) -> bool {
    read_snapshot(directory, name, false).is_ok_and(|snapshot| snapshot.version == expected)
}

struct StagedFile<'a> {
    directory: &'a Dir,
    name: String,
    preserve: bool,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl StagedFile<'_> {
    fn exchange(&self, destination: &Dir, name: &str) -> Result<()> {
        use rustix::fs::{renameat_with, RenameFlags};

        match renameat_with(
            self.directory,
            self.name.as_str(),
            destination,
            name,
            RenameFlags::EXCHANGE,
        ) {
            Ok(()) => Ok(()),
            Err(rustix::io::Errno::NOENT) => Err(WorkspaceError::FileConflict),
            Err(error) => Err(std::io::Error::from(error).into()),
        }
    }

    fn commit(
        mut self,
        destination: &Dir,
        name: &str,
        expected: &str,
        prepared: &str,
    ) -> Result<()> {
        // A handle-relative exchange keeps the exact displaced entry available.
        self.exchange(destination, name)?;
        if matches_version(self.directory, &self.name, expected)
            && matches_version(destination, name, prepared)
        {
            return Ok(());
        }

        // A second exchange can preserve both entries even if it races again.
        // Keep the recovery file in either case.
        self.preserve = true;
        if matches_version(destination, name, prepared) {
            let _ = self.exchange(destination, name);
        }
        Err(WorkspaceError::SaveRace)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
impl StagedFile<'_> {
    fn commit(self, destination: &Dir, name: &str, expected: &str, prepared: &str) -> Result<()> {
        self.commit_with_links(destination, name, expected, prepared)
    }
}

#[cfg(any(test, not(any(target_os = "macos", target_os = "linux"))))]
impl StagedFile<'_> {
    fn commit_with_links(
        mut self,
        destination: &Dir,
        name: &str,
        expected: &str,
        prepared: &str,
    ) -> Result<()> {
        let original = format!("{}.original", self.name);
        // Verify hard-link support before moving the original. A hard link
        // publishes the staged inode only if the destination is still absent.
        self.directory
            .hard_link(&self.name, self.directory, &original)?;
        self.directory.remove_file(&original)?;
        destination.rename(name, self.directory, &original)?;
        self.preserve = true;

        if matches_version(self.directory, &original, expected)
            && self
                .directory
                .hard_link(&self.name, destination, name)
                .is_ok()
            && matches_version(destination, name, prepared)
        {
            self.directory.remove_file(&original)?;
            self.preserve = false;
            return Ok(());
        }

        // Restore only if the name is free. Never replace another writer's
        // entry, and leave the displaced file available for recovery.
        let _ = self.directory.hard_link(&original, destination, name);
        Err(WorkspaceError::SaveRace)
    }
}

impl Drop for StagedFile<'_> {
    fn drop(&mut self) {
        if !self.preserve {
            let _ = self.directory.remove_file(&self.name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;
    use std::fs;

    #[test]
    fn preserves_an_edit_made_after_preflight() {
        assert_late_edit_is_preserved(|file, destination, name, expected, prepared| {
            file.commit(destination, name, expected, prepared)
        });
    }

    #[test]
    fn link_based_replacement_preserves_a_competing_edit() {
        assert_late_edit_is_preserved(|file, destination, name, expected, prepared| {
            file.commit_with_links(destination, name, expected, prepared)
        });
    }

    fn assert_late_edit_is_preserved(
        commit: fn(StagedFile<'_>, &Dir, &str, &str, &str) -> Result<()>,
    ) {
        let folder = tempfile::tempdir().unwrap();
        let directory = Dir::open_ambient_dir(folder.path(), ambient_authority()).unwrap();
        fs::write(folder.path().join("document"), "approved").unwrap();
        fs::write(folder.path().join(".stage"), "my draft").unwrap();
        let expected = read_snapshot(&directory, "document", false)
            .unwrap()
            .version;
        let prepared = read_snapshot(&directory, ".stage", false).unwrap().version;
        fs::write(folder.path().join("document"), "external").unwrap();

        let staging = StagedFile {
            directory: &directory,
            name: ".stage".into(),
            preserve: false,
        };
        assert_eq!(
            commit(staging, &directory, "document", &expected, &prepared),
            Err(WorkspaceError::SaveRace)
        );
        assert_eq!(
            fs::read_to_string(folder.path().join("document")).unwrap(),
            "external"
        );
        assert_eq!(
            fs::read_to_string(folder.path().join(".stage")).unwrap(),
            "my draft"
        );
    }
}
