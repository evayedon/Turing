//! Durable per-task checkpoints of the original state of every path the agent touches, with
//! rollback that never silently overwrites the developer's later changes.
//!
//! Layout: `<app data>/agent-checkpoints/<task id>/manifest.json` plus `blobs/<sha256>`. Each
//! blob is fsynced before the manifest that references it, and each manifest write is atomic.

use crate::{
    drafts::{private_dir, sync_dir},
    workspace::{relative_parts, validate_save_content, Registry, WorkspaceError, MAX_TEXT_BYTES},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const DIR: &str = "agent-checkpoints";
const MANIFEST: &str = "manifest.json";
const VERSION: u32 = 1;
const MAX_MANIFEST: u64 = 16 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ChangeKind {
    Modified,
    Created,
    Deleted,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangedFile {
    pub relative_path: String,
    pub change: ChangeKind,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CheckpointState {
    Active,
    Review,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    task_id: Uuid,
    workspace_identity: String,
    display_root: String,
    state: CheckpointState,
    entries: Vec<Entry>,
    created_dirs: Vec<String>,
    #[serde(default)]
    acl_grants: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    path: String,
    original: Original,
    /// The version the agent last left behind; `None` once it deleted the file (or, for an
    /// absent original, before it created it). Starts at the original version.
    last_agent_version: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Original {
    Absent,
    File { blob: String, version: String },
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RestoreOutcome {
    Restored,
    Removed,
    Skipped,
    Failed,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileOutcome {
    pub relative_path: String,
    pub outcome: RestoreOutcome,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RollbackReport {
    pub files: Vec<FileOutcome>,
    pub complete: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoverySummary {
    pub task_id: Uuid,
    pub files: Vec<ChangedFile>,
}

/// One leftover checkpoint for the startup Roll back / Keep offer.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Recovery {
    Unfinished(RecoverySummary),
    /// Cannot be opened (damaged manifest or blob); kept on disk so the developer is told.
    Corrupt {
        task_id: Uuid,
        reason: String,
    },
}

pub(crate) struct Checkpoint {
    dir: PathBuf,
    manifest: Manifest,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn valid_path(path: &str) -> bool {
    relative_parts(path).is_ok_and(|parts| !parts.is_empty())
}

/// Case-folded where the default file systems are case-insensitive (macOS, Windows). Used only to
/// detect a second spelling, which is refused: on a case-sensitive volume it is another file.
fn key(path: &str) -> String {
    if cfg!(any(target_os = "macos", windows)) {
        path.to_lowercase()
    } else {
        path.to_owned()
    }
}

fn valid_blob(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn task_dir(app_data: &Path, task_id: Uuid) -> PathBuf {
    app_data.join(DIR).join(task_id.to_string())
}

/// Reads a regular, non-symlinked file of at most `limit` bytes.
fn read_limited(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(invalid("invalid checkpoint file"));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("invalid checkpoint file"));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("invalid checkpoint file"));
    }
    Ok(bytes)
}

/// Writes `bytes` to `dir/name` atomically and durably.
fn atomic_write(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let mut temp = tempfile::Builder::new()
        .prefix(".pending-")
        .tempfile_in(dir)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(dir.join(name)).map_err(|error| error.error)?;
    sync_dir(dir)
}

impl Checkpoint {
    /// Stores at `<app_data>/agent-checkpoints/<task_id>/`.
    pub(crate) fn create(
        app_data: &Path,
        task_id: Uuid,
        workspace_identity: String,
        display_root: String,
    ) -> io::Result<Self> {
        fs::create_dir_all(app_data)?;
        let root = app_data.join(DIR);
        private_dir(&root)?;
        let dir = task_dir(app_data, task_id);
        private_dir(&dir)?;
        private_dir(&dir.join("blobs"))?;
        sync_dir(&dir)?;
        sync_dir(&root)?;
        if fs::symlink_metadata(dir.join(MANIFEST)).is_ok() {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        let checkpoint = Self {
            dir,
            manifest: Manifest {
                version: VERSION,
                task_id,
                workspace_identity,
                display_root,
                state: CheckpointState::Active,
                entries: Vec::new(),
                created_dirs: Vec::new(),
                acl_grants: Vec::new(),
            },
        };
        checkpoint.save(&checkpoint.manifest)?;
        Ok(checkpoint)
    }

    /// Opens a stored checkpoint, validating the manifest, its paths and every blob hash.
    pub(crate) fn open(app_data: &Path, task_id: Uuid) -> io::Result<Self> {
        let dir = task_dir(app_data, task_id);
        for path in [&app_data.join(DIR), &dir, &dir.join("blobs")] {
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(invalid("invalid checkpoint directory"));
            }
        }
        let manifest: Manifest =
            serde_json::from_slice(&read_limited(&dir.join(MANIFEST), MAX_MANIFEST)?)
                .map_err(|_| invalid("invalid checkpoint manifest"))?;
        if manifest.version != VERSION
            || manifest.task_id != task_id
            || !manifest.created_dirs.iter().all(|dir| valid_path(dir))
        {
            return Err(invalid("invalid checkpoint manifest"));
        }
        let checkpoint = Self { dir, manifest };
        for (index, entry) in checkpoint.manifest.entries.iter().enumerate() {
            let duplicate = checkpoint.manifest.entries[..index]
                .iter()
                .any(|other| key(&other.path) == key(&entry.path));
            if !valid_path(&entry.path) || duplicate {
                return Err(invalid("invalid checkpoint entry"));
            }
            if let Original::File { blob, .. } = &entry.original {
                checkpoint.blob(blob)?;
            }
        }
        Ok(checkpoint)
    }

    /// Durably records the original bytes of `path` before its first write; no-op if already
    /// recorded. Refuses an original that rollback could not write back (too large, not UTF-8 or
    /// containing NUL), so the caller must refuse the agent's write instead.
    pub(crate) fn record(&mut self, path: &str, original: Option<(&[u8], &str)>) -> io::Result<()> {
        if !valid_path(path) {
            return Err(invalid("path outside the workspace"));
        }
        if let Some((bytes, _)) = original {
            if std::str::from_utf8(bytes)
                .map_err(drop)
                .and_then(|text| validate_save_content(text).map_err(drop))
                .is_err()
            {
                return Err(invalid("original cannot be restored by rollback"));
            }
        }
        if let Some(entry) = self
            .manifest
            .entries
            .iter()
            .find(|entry| key(&entry.path) == key(path))
        {
            if entry.path == path {
                return Ok(());
            }
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path differs only in case from a recorded path",
            ));
        }
        let (original, last_agent_version) = match original {
            None => (Original::Absent, None),
            Some((bytes, version)) => {
                let blob = format!("{:x}", Sha256::digest(bytes));
                atomic_write(&self.dir.join("blobs"), &blob, bytes)?;
                let version = version.to_owned();
                (
                    Original::File {
                        blob,
                        version: version.clone(),
                    },
                    Some(version),
                )
            }
        };
        self.update(|manifest| {
            manifest.entries.push(Entry {
                path: path.to_owned(),
                original,
                last_agent_version,
            })
        })
    }

    /// Notes the version the agent's write left behind; `None` means it deleted the file.
    pub(crate) fn note_write(&mut self, path: &str, version: Option<&str>) -> io::Result<()> {
        let index = self
            .manifest
            .entries
            .iter()
            .position(|entry| entry.path == path)
            .ok_or_else(|| invalid("path was not recorded before the write"))?;
        self.update(|manifest| {
            manifest.entries[index].last_agent_version = version.map(str::to_owned)
        })
    }

    pub(crate) fn note_created_dirs(&mut self, dirs: &[String]) -> io::Result<()> {
        if !dirs.iter().all(|dir| valid_path(dir)) {
            return Err(invalid("path outside the workspace"));
        }
        self.update(|manifest| {
            for dir in dirs {
                if !manifest.created_dirs.contains(dir) {
                    manifest.created_dirs.push(dir.clone());
                }
            }
        })
    }

    /// Durably logs an ACL grant before it is applied (Windows sandbox, Task 8).
    pub(crate) fn note_acl_grant(&mut self, path: &Path) -> io::Result<()> {
        let path = path.to_string_lossy().into_owned();
        self.update(|manifest| manifest.acl_grants.push(path))
    }

    pub(crate) fn acl_grants(&self) -> &[String] {
        &self.manifest.acl_grants
    }

    pub(crate) fn task_id(&self) -> Uuid {
        self.manifest.task_id
    }

    pub(crate) fn set_state(&mut self, state: CheckpointState) -> io::Result<()> {
        self.update(|manifest| manifest.state = state)
    }

    pub(crate) fn changed_paths(&self) -> Vec<ChangedFile> {
        self.manifest
            .entries
            .iter()
            .map(|entry| ChangedFile {
                relative_path: entry.path.clone(),
                change: match (&entry.original, &entry.last_agent_version) {
                    (Original::Absent, _) => ChangeKind::Created,
                    (Original::File { .. }, None) => ChangeKind::Deleted,
                    (Original::File { .. }, Some(_)) => ChangeKind::Modified,
                },
            })
            .collect()
    }

    /// The original bytes of a recorded path; `None` if it did not exist.
    pub(crate) fn original(&self, path: &str) -> io::Result<Option<Vec<u8>>> {
        match &self.entry(path).ok_or(io::ErrorKind::NotFound)?.original {
            Original::Absent => Ok(None),
            Original::File { blob, .. } => self.blob(blob).map(Some),
        }
    }

    /// Restores every recorded path, newest first. A file that is not as the agent left it and
    /// differs from the original is only overwritten or removed when `confirm_overwrite` agrees.
    /// Every write is version-checked, so a change racing the rollback fails instead of being
    /// lost. Unfinished entries stay in the manifest for a later attempt.
    pub(crate) fn rollback(
        &mut self,
        registry: &Registry,
        owner: &str,
        id: &str,
        confirm_overwrite: &mut dyn FnMut(&str) -> bool,
    ) -> RollbackReport {
        let mut files = Vec::new();
        let mut remaining = Vec::new();
        for entry in self.manifest.entries.iter().rev() {
            let outcome = self.restore(entry, registry, owner, id, confirm_overwrite);
            if matches!(outcome, RestoreOutcome::Skipped | RestoreOutcome::Failed) {
                remaining.push(entry.clone());
            }
            files.push(FileOutcome {
                relative_path: entry.path.clone(),
                outcome,
            });
        }
        let mut dirs = Vec::new();
        for dir in self.manifest.created_dirs.iter().rev() {
            match registry.agent_remove_empty_dir(owner, id, dir) {
                Ok(()) | Err(WorkspaceError::NotFound) => (),
                // Not empty (the developer's files), a link or a non-directory: leave it.
                Err(_) => dirs.push(dir.clone()),
            }
        }
        remaining.reverse();
        dirs.reverse();
        let complete = remaining.is_empty();
        if complete {
            // Every path is restored; a leftover directory would only re-offer no-op work.
            if let Err(error) = fs::remove_dir_all(&self.dir) {
                eprintln!(
                    "turing agent checkpoint: cannot remove a rolled-back checkpoint: {error}"
                );
            }
            self.manifest.entries.clear();
            self.manifest.created_dirs.clear();
        } else {
            // On failure the stored manifest still lists every entry; rerunning is a no-op for
            // the restored ones.
            if let Err(error) = self.update(|manifest| {
                manifest.entries = remaining;
                manifest.created_dirs = dirs;
            }) {
                eprintln!("turing agent checkpoint: cannot record rollback progress: {error}");
            }
        }
        RollbackReport { files, complete }
    }

    /// Keep: drops the checkpoint and leaves the agent's changes in place.
    pub(crate) fn discard(self) -> io::Result<()> {
        // Use the same journal for normal completion and recovery after a crash.
        // Retain the checkpoint if cleanup fails so it can be retried.
        crate::execution::sandbox::revoke_grants(self.task_id(), self.acl_grants())?;
        fs::remove_dir_all(&self.dir)
    }

    fn restore(
        &self,
        entry: &Entry,
        registry: &Registry,
        owner: &str,
        id: &str,
        confirm_overwrite: &mut dyn FnMut(&str) -> bool,
    ) -> RestoreOutcome {
        let path = entry.path.as_str();
        let current = match registry.read(owner, id, path) {
            Ok(file) => Some(file),
            Err(WorkspaceError::NotFound) => None,
            Err(_) => return RestoreOutcome::Failed,
        };
        let original = match &entry.original {
            Original::Absent => None,
            Original::File { blob, .. } => match self.blob(blob).map(String::from_utf8) {
                Ok(Ok(text)) => Some(text),
                _ => return RestoreOutcome::Failed,
            },
        };
        let current_content = current.as_ref().map(|file| file.content.as_str());
        if current_content == original.as_deref() {
            return if original.is_some() {
                RestoreOutcome::Restored
            } else {
                RestoreOutcome::Removed
            };
        }
        let agent_owned = current.as_ref().map(|file| file.version.as_str())
            == entry.last_agent_version.as_deref();
        if !agent_owned && !confirm_overwrite(path) {
            return RestoreOutcome::Skipped;
        }
        let result = match (original, current) {
            (Some(text), Some(current)) => registry
                .write(owner, id, path, &current.version, &text)
                .map(|_| RestoreOutcome::Restored),
            // agent_create also recreates parents the developer or agent removed since.
            (Some(text), None) => registry
                .agent_create(owner, id, path, &text)
                .map(|_| RestoreOutcome::Restored),
            (None, Some(current)) => registry
                .agent_delete(owner, id, path, &current.version)
                .map(|()| RestoreOutcome::Removed),
            (None, None) => Ok(RestoreOutcome::Removed),
        };
        result.unwrap_or(RestoreOutcome::Failed)
    }

    fn entry(&self, path: &str) -> Option<&Entry> {
        self.manifest
            .entries
            .iter()
            .find(|entry| entry.path == path)
    }

    /// Reads a blob and verifies its hash.
    fn blob(&self, name: &str) -> io::Result<Vec<u8>> {
        if !valid_blob(name) {
            return Err(invalid("invalid checkpoint blob"));
        }
        let bytes = read_limited(&self.dir.join("blobs").join(name), MAX_TEXT_BYTES)?;
        if format!("{:x}", Sha256::digest(&bytes)) != name {
            return Err(invalid("checkpoint blob does not match its hash"));
        }
        Ok(bytes)
    }

    /// Persists a changed copy of the manifest, then adopts it, so memory never runs ahead of
    /// disk.
    fn update(&mut self, change: impl FnOnce(&mut Manifest)) -> io::Result<()> {
        let mut manifest = self.manifest.clone();
        change(&mut manifest);
        self.save(&manifest)?;
        self.manifest = manifest;
        Ok(())
    }

    fn save(&self, manifest: &Manifest) -> io::Result<()> {
        let bytes = serde_json::to_vec(manifest).map_err(io::Error::other)?;
        atomic_write(&self.dir, MANIFEST, &bytes)
    }
}

/// Checkpoints left behind for `workspace_identity` (crashed or unresolved tasks). A checkpoint
/// that cannot be opened is reported as `Corrupt` unless its manifest names another workspace;
/// nothing is deleted.
pub(crate) fn unfinished(app_data: &Path, workspace_identity: &str) -> Vec<Recovery> {
    let Ok(entries) = fs::read_dir(app_data.join(DIR)) else {
        return Vec::new();
    };
    let mut found: Vec<Recovery> = entries
        .filter_map(|entry| Uuid::parse_str(entry.ok()?.file_name().to_str()?).ok())
        .filter_map(|task_id| match Checkpoint::open(app_data, task_id) {
            Ok(checkpoint) => {
                (checkpoint.manifest.workspace_identity == workspace_identity).then(|| {
                    Recovery::Unfinished(RecoverySummary {
                        task_id,
                        files: checkpoint.changed_paths(),
                    })
                })
            }
            Err(error) => corrupt(app_data, task_id, workspace_identity, error),
        })
        .collect();
    found.sort_by_key(|recovery| match recovery {
        Recovery::Unfinished(summary) => summary.task_id,
        Recovery::Corrupt { task_id, .. } => *task_id,
    });
    found
}

fn corrupt(
    app_data: &Path,
    task_id: Uuid,
    workspace_identity: &str,
    error: io::Error,
) -> Option<Recovery> {
    let dir = task_dir(app_data, task_id);
    let manifest = match read_limited(&dir.join(MANIFEST), MAX_MANIFEST) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes).ok(),
        // A crash before the first manifest save: blobs are only written after it, so an empty
        // `blobs/` means nothing was recorded and nothing needs rolling back.
        Err(missing)
            if missing.kind() == io::ErrorKind::NotFound
                && fs::read_dir(dir.join("blobs"))
                    .map_or(true, |mut blobs| blobs.next().is_none()) =>
        {
            return None
        }
        Err(_) => None,
    };
    let owner = manifest
        .as_ref()
        .and_then(|manifest| manifest.get("workspaceIdentity")?.as_str());
    if owner.is_some_and(|owner| owner != workspace_identity) {
        return None;
    }
    Some(Recovery::Corrupt {
        task_id,
        reason: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Registry;
    use sha2::{Digest, Sha256};
    use std::fs;

    const OWNER: &str = "main";

    struct Fixture {
        folder: tempfile::TempDir,
        app_data: tempfile::TempDir,
        registry: Registry,
        id: String,
    }

    fn fixture() -> Fixture {
        let folder = tempfile::tempdir().unwrap();
        let app_data = tempfile::tempdir().unwrap();
        let mut registry = Registry::default();
        let id = registry.register(OWNER, folder.path()).unwrap().id;
        Fixture {
            folder,
            app_data,
            registry,
            id,
        }
    }

    impl Fixture {
        fn checkpoint(&self, identity: &str) -> Checkpoint {
            Checkpoint::create(
                self.app_data.path(),
                Uuid::new_v4(),
                identity.to_owned(),
                "/display".to_owned(),
            )
            .unwrap()
        }

        fn version(&self, path: &str) -> String {
            self.registry.read(OWNER, &self.id, path).unwrap().version
        }

        /// Records the current file, then writes `content` and notes the agent's version.
        fn agent_write(&self, checkpoint: &mut Checkpoint, path: &str, content: &str) {
            let current = self.registry.read(OWNER, &self.id, path).unwrap();
            checkpoint
                .record(path, Some((current.content.as_bytes(), &current.version)))
                .unwrap();
            let version = self
                .registry
                .write(OWNER, &self.id, path, &current.version, content)
                .unwrap();
            checkpoint.note_write(path, Some(&version)).unwrap();
        }

        fn agent_create(&self, checkpoint: &mut Checkpoint, path: &str, content: &str) {
            checkpoint.record(path, None).unwrap();
            let (version, dirs) = self
                .registry
                .agent_create(OWNER, &self.id, path, content)
                .unwrap();
            checkpoint.note_created_dirs(&dirs).unwrap();
            checkpoint.note_write(path, Some(&version)).unwrap();
        }

        fn agent_delete(&self, checkpoint: &mut Checkpoint, path: &str) {
            let current = self.registry.read(OWNER, &self.id, path).unwrap();
            checkpoint
                .record(path, Some((current.content.as_bytes(), &current.version)))
                .unwrap();
            self.registry
                .agent_delete(OWNER, &self.id, path, &current.version)
                .unwrap();
            checkpoint.note_write(path, None).unwrap();
        }

        fn rollback(
            &self,
            checkpoint: &mut Checkpoint,
            confirm: &mut dyn FnMut(&str) -> bool,
        ) -> RollbackReport {
            checkpoint.rollback(&self.registry, OWNER, &self.id, confirm)
        }

        fn text(&self, path: &str) -> String {
            fs::read_to_string(self.folder.path().join(path)).unwrap()
        }
    }

    fn changed(path: &str, change: ChangeKind) -> ChangedFile {
        ChangedFile {
            relative_path: path.to_owned(),
            change,
        }
    }

    fn outcomes(report: &RollbackReport) -> Vec<(&str, RestoreOutcome)> {
        report
            .files
            .iter()
            .map(|file| (file.relative_path.as_str(), file.outcome))
            .collect()
    }

    fn task_dir(app_data: &Path, task_id: Uuid) -> PathBuf {
        app_data.join("agent-checkpoints").join(task_id.to_string())
    }

    #[test]
    fn record_is_durable_before_the_write_and_idempotent() {
        let f = fixture();
        fs::write(f.folder.path().join("a.txt"), "original").unwrap();
        let version = f.version("a.txt");
        let mut checkpoint = f.checkpoint("A");
        checkpoint
            .record("a.txt", Some((b"original", &version)))
            .unwrap();
        checkpoint
            .record("a.txt", Some((b"changed", "other")))
            .unwrap();
        assert_eq!(
            checkpoint.changed_paths(),
            vec![changed("a.txt", ChangeKind::Modified)]
        );
        let blob = format!("{:x}", Sha256::digest(b"original"));
        let dir = task_dir(f.app_data.path(), checkpoint.task_id());
        assert!(dir.join("blobs").join(&blob).is_file());
        assert!(!dir
            .join("blobs")
            .join(format!("{:x}", Sha256::digest(b"changed")))
            .exists());

        let reopened = Checkpoint::open(f.app_data.path(), checkpoint.task_id()).unwrap();
        assert_eq!(reopened.changed_paths(), checkpoint.changed_paths());
        assert_eq!(
            reopened.original("a.txt").unwrap(),
            Some(b"original".to_vec())
        );
        assert!(Checkpoint::open(f.app_data.path(), Uuid::new_v4()).is_err());
    }

    #[test]
    fn record_rejects_paths_outside_the_workspace() {
        let f = fixture();
        let mut checkpoint = f.checkpoint("A");
        for path in ["", "../x", "/etc/x", "a/../../x"] {
            assert!(checkpoint.record(path, None).is_err(), "{path}");
        }
        assert!(checkpoint.note_write("never-recorded", None).is_err());
        assert!(checkpoint.changed_paths().is_empty());
    }

    #[test]
    fn rollback_restores_modified_created_deleted_and_renamed_files() {
        let f = fixture();
        for (name, text) in [("a.txt", "a0"), ("c.txt", "c0"), ("d.txt", "d0")] {
            fs::write(f.folder.path().join(name), text).unwrap();
        }
        let mut checkpoint = f.checkpoint("A");
        f.agent_write(&mut checkpoint, "a.txt", "a1");
        f.agent_create(&mut checkpoint, "new/b.txt", "b1");
        f.agent_delete(&mut checkpoint, "c.txt");
        // A rename is a delete of `from` plus a create of `to`.
        f.agent_delete(&mut checkpoint, "d.txt");
        f.agent_create(&mut checkpoint, "e.txt", "d0");
        assert_eq!(
            checkpoint.changed_paths(),
            vec![
                changed("a.txt", ChangeKind::Modified),
                changed("new/b.txt", ChangeKind::Created),
                changed("c.txt", ChangeKind::Deleted),
                changed("d.txt", ChangeKind::Deleted),
                changed("e.txt", ChangeKind::Created),
            ]
        );

        let task = checkpoint.task_id();
        let report = f.rollback(&mut checkpoint, &mut |_| panic!("nothing to confirm"));
        assert_eq!(
            outcomes(&report),
            vec![
                ("e.txt", RestoreOutcome::Removed),
                ("d.txt", RestoreOutcome::Restored),
                ("c.txt", RestoreOutcome::Restored),
                ("new/b.txt", RestoreOutcome::Removed),
                ("a.txt", RestoreOutcome::Restored),
            ]
        );
        assert!(report.complete);
        assert_eq!(f.text("a.txt"), "a0");
        assert_eq!(f.text("c.txt"), "c0");
        assert_eq!(f.text("d.txt"), "d0");
        // Restored files are readable through the versioned path again.
        for name in ["a.txt", "c.txt", "d.txt"] {
            f.version(name);
        }
        assert!(!f.folder.path().join("new").exists());
        assert!(!f.folder.path().join("e.txt").exists());
        assert!(!task_dir(f.app_data.path(), task).exists());
    }

    #[test]
    fn rollback_asks_before_overwriting_a_file_changed_after_the_agent() {
        let f = fixture();
        fs::write(f.folder.path().join("a.txt"), "original").unwrap();
        let mut checkpoint = f.checkpoint("A");
        f.agent_write(&mut checkpoint, "a.txt", "agent");
        let agent_version = f.version("a.txt");
        f.registry
            .write(OWNER, &f.id, "a.txt", &agent_version, "developer, later")
            .unwrap();

        let mut asked = Vec::new();
        let report = f.rollback(&mut checkpoint, &mut |path| {
            asked.push(path.to_owned());
            false
        });
        assert_eq!(asked, ["a.txt"]);
        assert_eq!(outcomes(&report), vec![("a.txt", RestoreOutcome::Skipped)]);
        assert!(!report.complete);
        assert_eq!(f.text("a.txt"), "developer, later");
        let mut reopened = Checkpoint::open(f.app_data.path(), checkpoint.task_id()).unwrap();
        assert_eq!(
            reopened.changed_paths(),
            vec![changed("a.txt", ChangeKind::Modified)]
        );

        let report = f.rollback(&mut reopened, &mut |_| true);
        assert_eq!(outcomes(&report), vec![("a.txt", RestoreOutcome::Restored)]);
        assert!(report.complete);
        assert_eq!(f.text("a.txt"), "original");
    }

    #[test]
    fn rollback_never_deletes_a_file_the_developer_put_in_place_of_a_deleted_one() {
        let f = fixture();
        fs::write(f.folder.path().join("c.txt"), "original").unwrap();
        let mut checkpoint = f.checkpoint("A");
        f.agent_delete(&mut checkpoint, "c.txt");
        fs::write(f.folder.path().join("c.txt"), "developer").unwrap();
        let report = f.rollback(&mut checkpoint, &mut |_| false);
        assert_eq!(outcomes(&report), vec![("c.txt", RestoreOutcome::Skipped)]);
        assert_eq!(f.text("c.txt"), "developer");
    }

    #[cfg(unix)]
    #[test]
    fn rollback_never_follows_a_symlink_swapped_in_for_a_created_dir() {
        let f = fixture();
        let mut checkpoint = f.checkpoint("A");
        f.agent_create(&mut checkpoint, "new/b.txt", "agent");
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("b.txt"), "agent").unwrap();
        fs::remove_dir_all(f.folder.path().join("new")).unwrap();
        std::os::unix::fs::symlink(outside.path(), f.folder.path().join("new")).unwrap();

        let report = f.rollback(&mut checkpoint, &mut |_| true);
        assert_eq!(
            outcomes(&report),
            vec![("new/b.txt", RestoreOutcome::Failed)]
        );
        assert!(!report.complete);
        assert!(outside.path().join("b.txt").exists());
        assert!(f.folder.path().join("new").exists());
        assert!(Checkpoint::open(f.app_data.path(), checkpoint.task_id()).is_ok());
    }

    #[test]
    fn recovery_after_crash_between_checkpoint_and_write_restores_original() {
        let f = fixture();
        fs::write(f.folder.path().join("a.txt"), "original").unwrap();
        let version = f.version("a.txt");
        let task = {
            let mut checkpoint = f.checkpoint("A");
            checkpoint
                .record("a.txt", Some((b"original", &version)))
                .unwrap();
            checkpoint.task_id()
        };
        assert_eq!(unfinished_ids(f.app_data.path(), "A"), [task]);
        let mut checkpoint = Checkpoint::open(f.app_data.path(), task).unwrap();
        let report = f.rollback(&mut checkpoint, &mut |_| panic!("unchanged file"));
        assert!(report.complete);
        assert_eq!(f.text("a.txt"), "original");
        assert_eq!(f.version("a.txt"), version);

        // Crash after the write but before `note_write`.
        let task = {
            let mut checkpoint = f.checkpoint("A");
            checkpoint.record("new.txt", None).unwrap();
            f.registry
                .agent_create(OWNER, &f.id, "new.txt", "agent")
                .unwrap();
            checkpoint.task_id()
        };
        let mut checkpoint = Checkpoint::open(f.app_data.path(), task).unwrap();
        let mut calls = 0;
        let report = f.rollback(&mut checkpoint, &mut |_| {
            calls += 1;
            true
        });
        assert_eq!(calls, 1);
        assert_eq!(
            outcomes(&report),
            vec![("new.txt", RestoreOutcome::Removed)]
        );
        assert!(report.complete);
        assert!(!f.folder.path().join("new.txt").exists());
    }

    fn unfinished_ids(app_data: &Path, identity: &str) -> Vec<Uuid> {
        unfinished(app_data, identity)
            .iter()
            .map(|recovery| match recovery {
                Recovery::Unfinished(summary) => summary.task_id,
                Recovery::Corrupt { .. } => panic!("unexpected corrupt checkpoint"),
            })
            .collect()
    }

    #[test]
    fn unfinished_lists_matching_workspace_and_surfaces_corrupt_checkpoints() {
        let f = fixture();
        let mut a = f.checkpoint("A");
        a.record("a.txt", Some((b"a", "v"))).unwrap();
        let mut b = f.checkpoint("B");
        b.record("a.txt", Some((b"b", "v"))).unwrap();
        let tamper = |checkpoint: &Checkpoint, bytes: &[u8]| {
            let blob = task_dir(f.app_data.path(), checkpoint.task_id())
                .join("blobs")
                .join(format!("{:x}", Sha256::digest(bytes)));
            fs::write(blob, "tampered").unwrap();
        };
        let mut corrupt = f.checkpoint("A");
        corrupt.record("c.txt", Some((b"c", "v"))).unwrap();
        tamper(&corrupt, b"c");
        // Another workspace's damaged checkpoint is not ours to report.
        let mut other_corrupt = f.checkpoint("B");
        other_corrupt.record("c.txt", Some((b"c", "v"))).unwrap();
        tamper(&other_corrupt, b"c");
        // An unreadable manifest cannot be attributed, so every workspace hears about it.
        let unreadable = f.checkpoint("B");
        fs::write(
            task_dir(f.app_data.path(), unreadable.task_id()).join("manifest.json"),
            "{not json",
        )
        .unwrap();
        // A crash before the first manifest save leaves nothing to roll back.
        let empty = Uuid::new_v4();
        fs::create_dir_all(task_dir(f.app_data.path(), empty).join("blobs")).unwrap();
        // A lost manifest with blobs present is damage, not an empty crash.
        let lost = f.checkpoint("A");
        fs::write(
            task_dir(f.app_data.path(), lost.task_id()).join("blobs/orphan"),
            "x",
        )
        .unwrap();
        fs::remove_file(task_dir(f.app_data.path(), lost.task_id()).join("manifest.json")).unwrap();
        fs::create_dir_all(f.app_data.path().join("agent-checkpoints/not-a-uuid")).unwrap();

        let found = unfinished(f.app_data.path(), "A");
        let mut corrupt_ids = Vec::new();
        let mut unfinished_ids = Vec::new();
        for recovery in &found {
            match recovery {
                Recovery::Unfinished(summary) => {
                    assert_eq!(summary.files, vec![changed("a.txt", ChangeKind::Modified)]);
                    unfinished_ids.push(summary.task_id);
                }
                Recovery::Corrupt { task_id, reason } => {
                    assert!(!reason.is_empty());
                    corrupt_ids.push(*task_id);
                }
            }
        }
        assert_eq!(unfinished_ids, [a.task_id()]);
        let mut expected = vec![corrupt.task_id(), unreadable.task_id(), lost.task_id()];
        expected.sort();
        assert_eq!(corrupt_ids, expected);
        // Never deleted automatically.
        assert!(task_dir(f.app_data.path(), corrupt.task_id()).exists());
        assert!(task_dir(f.app_data.path(), unreadable.task_id()).exists());
        assert!(unfinished(tempfile::tempdir().unwrap().path(), "A").is_empty());
    }

    #[test]
    fn record_refuses_what_rollback_cannot_restore_before_the_write() {
        let f = fixture();
        let mut checkpoint = f.checkpoint("A");
        let oversize = vec![b'a'; MAX_TEXT_BYTES as usize + 1];
        for bytes in [&oversize[..], b"\xff\xfe binary", b"nul\0byte"] {
            assert!(checkpoint.record("big.bin", Some((bytes, "v"))).is_err());
        }
        assert!(checkpoint.changed_paths().is_empty());
        let blobs = task_dir(f.app_data.path(), checkpoint.task_id()).join("blobs");
        assert_eq!(fs::read_dir(&blobs).unwrap().count(), 0);

        // The largest accepted original still opens and is offered for recovery.
        let largest = vec![b'a'; MAX_TEXT_BYTES as usize];
        checkpoint
            .record("large.txt", Some((&largest, "v")))
            .unwrap();
        assert_eq!(
            unfinished_ids(f.app_data.path(), "A"),
            [checkpoint.task_id()]
        );
    }

    #[test]
    fn non_ascii_original_round_trips_through_crash_recovery() {
        let f = fixture();
        let original = "caf\u{e9} \u{1f600}\r\nline two\r\n";
        fs::write(f.folder.path().join("u.txt"), original).unwrap();
        let task = {
            let mut checkpoint = f.checkpoint("A");
            f.agent_write(&mut checkpoint, "u.txt", "agent");
            checkpoint.task_id()
        };
        assert_eq!(unfinished_ids(f.app_data.path(), "A"), [task]);
        let mut checkpoint = Checkpoint::open(f.app_data.path(), task).unwrap();
        assert_eq!(
            checkpoint.original("u.txt").unwrap(),
            Some(original.as_bytes().to_vec())
        );
        let report = f.rollback(&mut checkpoint, &mut |_| panic!("agent-owned"));
        assert!(report.complete);
        assert_eq!(
            fs::read(f.folder.path().join("u.txt")).unwrap(),
            original.as_bytes()
        );
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn a_second_spelling_is_refused_before_the_write_on_case_insensitive_targets() {
        let f = fixture();
        fs::write(f.folder.path().join("a.txt"), "original").unwrap();
        let mut checkpoint = f.checkpoint("A");
        let version = f.version("a.txt");
        checkpoint
            .record("a.txt", Some((b"original", &version)))
            .unwrap();
        // On a case-sensitive volume `A.TXT` is another file; merging would lose its original.
        for spelling in ["A.TXT", "A.txt"] {
            let error = checkpoint
                .record(spelling, Some((b"agent", "v2")))
                .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{spelling}");
            assert!(checkpoint.note_write(spelling, Some("v2")).is_err());
        }
        checkpoint.record("a.txt", Some((b"agent", "v2"))).unwrap();
        assert_eq!(
            checkpoint.changed_paths(),
            vec![changed("a.txt", ChangeKind::Modified)]
        );
        assert_eq!(
            checkpoint.original("a.txt").unwrap(),
            Some(b"original".to_vec())
        );
        let reopened = Checkpoint::open(f.app_data.path(), checkpoint.task_id()).unwrap();
        assert_eq!(reopened.changed_paths().len(), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn spellings_stay_distinct_on_case_sensitive_targets() {
        let f = fixture();
        let mut checkpoint = f.checkpoint("A");
        checkpoint.record("a.txt", None).unwrap();
        checkpoint.record("A.txt", None).unwrap();
        assert_eq!(checkpoint.changed_paths().len(), 2);
    }

    #[test]
    fn open_rejects_unknown_versions_and_paths() {
        let f = fixture();
        let checkpoint = f.checkpoint("A");
        let manifest = task_dir(f.app_data.path(), checkpoint.task_id()).join("manifest.json");
        let original: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        let mut bad = original.clone();
        bad["version"] = 2.into();
        fs::write(&manifest, bad.to_string()).unwrap();
        assert!(Checkpoint::open(f.app_data.path(), checkpoint.task_id()).is_err());
        let mut bad = original.clone();
        bad["createdDirs"] = serde_json::json!(["../outside"]);
        fs::write(&manifest, bad.to_string()).unwrap();
        assert!(Checkpoint::open(f.app_data.path(), checkpoint.task_id()).is_err());
        let mut bad = original;
        bad["taskId"] = Uuid::new_v4().to_string().into();
        fs::write(&manifest, bad.to_string()).unwrap();
        assert!(Checkpoint::open(f.app_data.path(), checkpoint.task_id()).is_err());
    }

    #[test]
    fn acl_grants_are_logged_durably_and_old_manifests_still_open() {
        let f = fixture();
        let mut checkpoint = f.checkpoint("A");
        checkpoint.note_acl_grant(Path::new("/x")).unwrap();
        let reopened = Checkpoint::open(f.app_data.path(), checkpoint.task_id()).unwrap();
        assert_eq!(reopened.acl_grants(), ["/x"]);

        let manifest = task_dir(f.app_data.path(), checkpoint.task_id()).join("manifest.json");
        let mut json: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        json.as_object_mut().unwrap().remove("aclGrants");
        fs::write(&manifest, json.to_string()).unwrap();
        let reopened = Checkpoint::open(f.app_data.path(), checkpoint.task_id()).unwrap();
        assert!(reopened.acl_grants().is_empty());
    }

    #[test]
    fn set_state_persists() {
        let f = fixture();
        let mut checkpoint = f.checkpoint("A");
        checkpoint.set_state(CheckpointState::Review).unwrap();
        let reopened = Checkpoint::open(f.app_data.path(), checkpoint.task_id()).unwrap();
        assert!(reopened.manifest.state == CheckpointState::Review);
    }

    #[test]
    fn discard_removes_the_checkpoint_directory() {
        let f = fixture();
        let mut checkpoint = f.checkpoint("A");
        checkpoint.record("a.txt", Some((b"a", "v"))).unwrap();
        let dir = task_dir(f.app_data.path(), checkpoint.task_id());
        assert!(dir.is_dir());
        checkpoint.discard().unwrap();
        assert!(!dir.exists());
    }
}
