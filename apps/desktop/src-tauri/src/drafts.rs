use crate::{
    windows::workbench,
    workspace::{relative_parts, Registry, WorkspaceError},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewWindow};
use uuid::Uuid;

const MAGIC: &[u8; 8] = b"TURNDR01";
const HEADER: usize = 48;
const MAX_RECORD: usize = 1024 * 1024;
const MAX_TOTAL: usize = 32 * MAX_RECORD;
const MAX_RECORDS: usize = 256;
const RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Source {
    Copy,
    Workspace {
        root: String,
        relative_path: String,
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        identity: Option<String>,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    id: String,
    name: String,
    title: String,
    draft: String,
    source: Source,
    timestamp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    language_override: Option<String>,
}

#[derive(Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    List,
    Migrate {
        entry: Draft,
    },
    Snapshot {
        uri: String,
        entry: Draft,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replaces: Option<String>,
    },
    Resolve {
        id: String,
    },
    Matches {
        id: String,
        workspace_id: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Reply {
    List { entries: Vec<Draft>, skipped: bool },
    Written { id: String },
    Matches { matches: bool },
    Done,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Error {
    PermissionDenied,
    InvalidDraft,
    DraftLimit,
    JournalIo,
}

impl From<io::Error> for Error {
    fn from(_: io::Error) -> Self {
        Self::JournalIo
    }
}

impl From<WorkspaceError> for Error {
    fn from(_: WorkspaceError) -> Self {
        Self::PermissionDenied
    }
}

type Result<T> = std::result::Result<T, Error>;

#[derive(Serialize, Deserialize)]
struct Record {
    owner: String,
    uri: String,
    entry: Draft,
    stored_at: u64,
    replaces: Option<String>,
}

struct Stored {
    record: Record,
    bytes: usize,
}

struct Damaged {
    bytes: u64,
    modified: Option<SystemTime>,
}

struct Journal {
    path: PathBuf,
    lock: File,
    records: HashMap<String, Stored>,
    damaged: HashMap<String, Damaged>,
    owners: HashMap<String, String>,
    claims: HashMap<String, String>,
    skipped: bool,
}

impl Drop for Journal {
    fn drop(&mut self) {
        // A concurrent fork can briefly inherit the descriptor before exec.
        let _ = self.lock.unlock();
    }
}

#[derive(Default)]
pub struct DraftJournal(Mutex<Option<Journal>>);

impl DraftJournal {
    pub fn release(&self, label: &str) {
        if let Ok(mut state) = self.0.lock() {
            if let Some(journal) = state.as_mut() {
                journal.release(label);
            }
        }
    }

    pub fn clear(&self, label: &str) -> Result<()> {
        if let Some(journal) = self.0.lock().map_err(|_| Error::JournalIo)?.as_mut() {
            if let Some(owner) = journal.owners.get(label).cloned() {
                journal.clear(&owner)?;
            }
        }
        Ok(())
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn key(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    format!("{:x}", hash.finalize())
}

fn id_valid(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate(entry: &Draft) -> Result<()> {
    if entry.draft.encode_utf16().take(128 * 1024).count() >= 128 * 1024 {
        return Err(Error::DraftLimit);
    }
    let text = |s: &str| !s.is_empty() && s.len() <= 8192 && !s.contains('\0');
    if !text(&entry.id)
        || !text(&entry.name)
        || !text(&entry.title)
        || entry.language_override.as_ref().is_some_and(|s| !text(s))
    {
        return Err(Error::InvalidDraft);
    }
    if let Source::Workspace {
        root,
        relative_path,
        version,
        identity,
    } = &entry.source
    {
        if !text(root)
            || !text(relative_path)
            || !text(version)
            || !Path::new(root).is_absolute()
            || relative_parts(relative_path).is_err()
            || identity.as_ref().is_some_and(|id| !id_valid(id))
        {
            return Err(Error::InvalidDraft);
        }
    }
    Ok(())
}

fn sync_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    match File::open(path)?.sync_all() {
        Err(error) if matches!(error.raw_os_error(), Some(libc::EINVAL | libc::ENOTSUP)) => (),
        result => result?,
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn private_dir(path: &Path) -> io::Result<()> {
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    match builder.create(path) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::other("invalid journal directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o700 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

fn decode(path: &Path, id: &str) -> Result<Stored> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.len() > MAX_RECORD as u64 {
        return Err(Error::InvalidDraft);
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take((MAX_RECORD + 1) as u64)
        .read_to_end(&mut bytes)?;
    let Some(body) = bytes.get(HEADER..) else {
        return Err(Error::InvalidDraft);
    };
    if bytes.len() > MAX_RECORD
        || &bytes[..8] != MAGIC
        || bytes[8..16] != (body.len() as u64).to_le_bytes()
        || bytes[16..HEADER] != Sha256::digest(body)[..]
    {
        return Err(Error::InvalidDraft);
    }
    let record: Record = serde_json::from_slice(body).map_err(|_| Error::InvalidDraft)?;
    if record.entry.id != id || record.replaces.as_ref().is_some_and(|id| !id_valid(id)) {
        return Err(Error::InvalidDraft);
    }
    validate(&record.entry)?;
    Ok(Stored {
        record,
        bytes: bytes.len(),
    })
}

fn atomic_write(dir: &Path, id: &str, body: &[u8]) -> io::Result<()> {
    let mut temp = tempfile::Builder::new()
        .prefix(".pending-")
        .tempfile_in(dir)?;
    temp.write_all(MAGIC)?;
    temp.write_all(&(body.len() as u64).to_le_bytes())?;
    temp.write_all(&Sha256::digest(body))?;
    temp.write_all(body)?;
    temp.as_file().sync_all()?;
    temp.persist(dir.join(format!("{id}.draft")))?;
    Ok(())
}

impl Journal {
    fn open(path: PathBuf) -> Result<Self> {
        private_dir(&path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let lock = options.open(path.join("journal.lock"))?;
        lock.try_lock().map_err(|_| Error::JournalIo)?;
        let mut journal = Self {
            path,
            lock,
            records: HashMap::new(),
            damaged: HashMap::new(),
            owners: HashMap::new(),
            claims: HashMap::new(),
            skipped: false,
        };
        for item in fs::read_dir(&journal.path)? {
            let item = item?;
            let name = item.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with(".pending-") {
                let _ = fs::remove_file(item.path());
            } else if let Some(id) = name.strip_suffix(".draft").filter(|id| id_valid(id)) {
                match decode(&item.path(), id) {
                    Ok(stored) => {
                        journal.records.insert(id.into(), stored);
                    }
                    Err(_) => {
                        journal.skipped = true;
                        if let Ok(metadata) = fs::symlink_metadata(item.path()) {
                            journal.damaged.insert(
                                id.into(),
                                Damaged {
                                    bytes: metadata.len(),
                                    modified: metadata.modified().ok(),
                                },
                            );
                        }
                    }
                }
            }
        }
        let replaced: Vec<_> = journal
            .records
            .values()
            .filter_map(|s| s.record.replaces.clone())
            .collect();
        for id in replaced {
            journal.remove(&id)?;
        }
        journal.expire()?;
        sync_dir(&journal.path)?;
        Ok(journal)
    }

    fn expire(&mut self) -> Result<()> {
        let cutoff = now().saturating_sub(RETENTION.as_millis() as u64);
        let mut expired: Vec<_> = self
            .records
            .values()
            .filter(|s| {
                s.record.stored_at < cutoff
                    && !self.owners.values().any(|owner| owner == &s.record.owner)
                    && !self.claims.contains_key(&s.record.entry.id)
            })
            .map(|s| (s.record.stored_at, s.record.entry.id.clone()))
            .collect();
        expired.extend(self.damaged.iter().filter_map(|(id, damaged)| {
            let modified = damaged.modified?.duration_since(UNIX_EPOCH).ok()?;
            let modified = modified.as_millis() as u64;
            (modified < cutoff).then(|| (modified, id.clone()))
        }));
        expired.sort_unstable();
        for (_, id) in expired {
            self.remove(&id)?;
        }
        Ok(())
    }

    fn release(&mut self, label: &str) {
        if let Some(owner) = self.owners.remove(label) {
            self.claims.retain(|_, claimant| claimant != &owner);
        }
    }

    fn clear(&mut self, owner: &str) -> Result<()> {
        let ids: Vec<_> = self
            .records
            .values()
            .filter(|stored| stored.record.owner == owner)
            .map(|stored| stored.record.entry.id.clone())
            .collect();
        for id in ids {
            self.remove(&id)?;
        }
        Ok(())
    }

    fn migrate(&mut self, mut entry: Draft) -> Result<String> {
        validate(&entry)?;
        if let Source::Workspace { identity, .. } = &mut entry.source {
            *identity = None;
        }
        let id = key(&["legacy-v1", &entry.id]);
        if !self.records.contains_key(&id) {
            entry.id.clone_from(&id);
            self.write(Record {
                owner: "legacy".into(),
                uri: id.clone(),
                entry,
                stored_at: now(),
                replaces: None,
            })?;
        }
        sync_dir(&self.path)?;
        Ok(id)
    }

    fn owner(&mut self, label: &str) -> String {
        self.owners
            .entry(label.into())
            .or_insert_with(|| Uuid::new_v4().to_string())
            .clone()
    }

    fn list(&mut self, owner: &str) -> Result<Reply> {
        self.expire()?;
        let mut entries = Vec::new();
        for (id, stored) in &self.records {
            if self
                .owners
                .values()
                .any(|active| active == &stored.record.owner)
            {
                continue;
            }
            let claimant = self
                .claims
                .entry(id.clone())
                .or_insert_with(|| owner.into());
            if claimant == owner {
                entries.push(stored.record.entry.clone());
            }
        }
        entries
            .sort_unstable_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| a.id.cmp(&b.id)));
        Ok(Reply::List {
            entries,
            skipped: self.skipped,
        })
    }

    fn remove(&mut self, id: &str) -> Result<()> {
        if !self.records.contains_key(id) && !self.damaged.contains_key(id) {
            return Ok(());
        }
        match fs::remove_file(self.path.join(format!("{id}.draft"))) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
        self.records.remove(id);
        self.damaged.remove(id);
        self.claims.remove(id);
        sync_dir(&self.path)?;
        Ok(())
    }

    fn can_resolve(&self, owner: &str, id: &str) -> bool {
        self.records
            .get(id)
            .is_some_and(|s| s.record.owner == owner)
            || self
                .claims
                .get(id)
                .is_some_and(|claimant| claimant == owner)
    }

    fn write(&mut self, record: Record) -> Result<()> {
        self.write_using(record, atomic_write)
    }

    fn write_using(
        &mut self,
        record: Record,
        write: impl FnOnce(&Path, &str, &[u8]) -> io::Result<()>,
    ) -> Result<()> {
        validate(&record.entry)?;
        self.expire()?;
        let id = record.entry.id.clone();
        let body = serde_json::to_vec(&record).map_err(|_| Error::InvalidDraft)?;
        let bytes = HEADER + body.len();
        let used = self
            .records
            .iter()
            .filter(|(old, _)| **old != id)
            .map(|(_, s)| s.bytes as u64)
            .chain(
                self.damaged
                    .iter()
                    .filter(|(old, _)| **old != id)
                    .map(|(_, s)| s.bytes),
            )
            .fold(0u64, u64::saturating_add);
        if bytes > MAX_RECORD
            || used.saturating_add(bytes as u64) > MAX_TOTAL as u64
            || (self.records.len() + self.damaged.len() >= MAX_RECORDS
                && !self.records.contains_key(&id)
                && !self.damaged.contains_key(&id))
        {
            return Err(Error::DraftLimit);
        }
        write(&self.path, &id, &body)?;
        let replaces = record.replaces.clone();
        self.damaged.remove(&id);
        self.records.insert(id.clone(), Stored { record, bytes });
        sync_dir(&self.path)?;
        if let Some(previous) = replaces.filter(|previous| previous != &id) {
            self.remove(&previous)?;
        }
        Ok(())
    }
}

fn approved(registry: &Registry, label: &str, workspace_id: &str) -> Result<(String, String)> {
    use cap_fs_ext::MetadataExt;
    let workspace = registry.authorize(label, workspace_id)?;
    let metadata = workspace.dir_metadata().map_err(|_| Error::JournalIo)?;
    let display = registry.workspace_display_path(label, workspace_id)?;
    let identity = key(&[&metadata.dev().to_string(), &metadata.ino().to_string()]);
    Ok((identity, display.into()))
}

#[tauri::command]
pub async fn draft_recovery(window: WebviewWindow, request: Request) -> Result<Reply> {
    let resources = workbench(&window)?;
    let approved = |workspace_id: &str| {
        let registry = resources.workspace.registry()?;
        approved(&registry, window.label(), workspace_id)
    };
    let state = window.state::<DraftJournal>();
    let mut state = state.0.lock().map_err(|_| Error::JournalIo)?;
    if state.is_none() {
        let local = window
            .path()
            .app_local_data_dir()
            .map_err(|_| Error::JournalIo)?;
        fs::create_dir_all(&local)?;
        let journal = Journal::open(local.join("draft-recovery-default"))?;
        sync_dir(&local)?;
        if let Some(parent) = local.parent() {
            sync_dir(parent)?;
        }
        *state = Some(journal);
    }
    let journal = state.as_mut().ok_or(Error::JournalIo)?;
    let owner = journal.owner(window.label());
    match request {
        Request::List => journal.list(&owner),
        Request::Migrate { entry } => Ok(Reply::Written {
            id: journal.migrate(entry)?,
        }),
        Request::Snapshot {
            mut uri,
            mut entry,
            workspace_id,
            replaces,
        } => {
            if uri.is_empty() || uri.len() > 8192 || uri.contains('\0') {
                return Err(Error::InvalidDraft);
            }
            let id = match (&mut entry.source, workspace_id) {
                (
                    Source::Workspace {
                        root,
                        relative_path,
                        identity,
                        ..
                    },
                    Some(workspace_id),
                ) => {
                    let (approved, display) = approved(&workspace_id)?;
                    *root = display;
                    *identity = Some(approved.clone());
                    uri = format!("turing-workspace://{approved}/{relative_path}");
                    key(&[&owner, &uri])
                }
                (Source::Copy, None) => key(&[&owner, &uri]),
                _ => return Err(Error::InvalidDraft),
            };
            let replaces = replaces.filter(|id| journal.can_resolve(&owner, id));
            entry.id.clone_from(&id);
            entry.timestamp = now();
            journal.write(Record {
                owner,
                uri,
                entry,
                stored_at: now(),
                replaces,
            })?;
            Ok(Reply::Written { id })
        }
        Request::Resolve { id } => {
            if (journal.records.contains_key(&id) || journal.damaged.contains_key(&id))
                && !journal.can_resolve(&owner, &id)
            {
                return Err(Error::PermissionDenied);
            }
            journal.remove(&id)?;
            Ok(Reply::Done)
        }
        Request::Matches { id, workspace_id } => {
            if !journal.can_resolve(&owner, &id) {
                return Ok(Reply::Matches { matches: false });
            }
            let (approved, display) = approved(&workspace_id)?;
            let matches =
                journal
                    .records
                    .get(&id)
                    .is_some_and(|stored| match &stored.record.entry.source {
                        Source::Workspace { root, identity, .. } => identity
                            .as_ref()
                            .map_or(root == &display, |id| id == &approved),
                        Source::Copy => false,
                    });
            Ok(Reply::Matches { matches })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal(dir: &tempfile::TempDir) -> Journal {
        Journal::open(dir.path().join("draft-recovery-default")).unwrap()
    }

    fn record(owner: &str, uri: &str, draft: &str) -> Record {
        Record {
            owner: owner.into(),
            uri: uri.into(),
            entry: Draft {
                id: key(&[owner, uri]),
                name: "Untitled".into(),
                title: "Untitled".into(),
                draft: draft.into(),
                source: Source::Copy,
                timestamp: now(),
                language_override: None,
            },
            stored_at: now(),
            replaces: None,
        }
    }

    fn list(journal: &mut Journal, owner: &str) -> (Vec<Draft>, bool) {
        let Reply::List { entries, skipped } = journal.list(owner).unwrap() else {
            panic!("expected draft list");
        };
        (entries, skipped)
    }

    #[test]
    fn clean_exit_removes_only_the_exiting_windows_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal = journal(&dir);
        let first = journal.owner("main");
        let second = journal.owner("workbench-2");
        journal.write(record(&first, "uri", "first")).unwrap();
        journal.write(record(&second, "uri", "second")).unwrap();
        journal.clear(&first).unwrap();
        assert_eq!(journal.records.len(), 1);
        journal.clear(&second).unwrap();
        drop(journal);
        assert!(self::journal(&dir).records.is_empty());
    }

    #[test]
    fn orphaned_documents_survive_and_are_claimed_once_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut journal = journal(&dir);
            let first = journal.owner("main");
            let second = journal.owner("workbench-2");
            journal.write(record(&first, "a", "one")).unwrap();
            journal.write(record(&first, "a", "latest")).unwrap();
            journal.write(record(&first, "b", "two")).unwrap();
            journal.write(record(&second, "a", "other window")).unwrap();
            assert!(list(&mut journal, &second).0.is_empty());
            assert!(!journal.can_resolve(&first, &key(&[&second, "a"])));
            assert!(matches!(
                Journal::open(journal.path.clone()),
                Err(Error::JournalIo)
            ));
            // Simulate termination without calling clear.
        }
        let mut journal = journal(&dir);
        let first = journal.owner("main");
        let second = journal.owner("workbench-2");
        let (entries, skipped) = list(&mut journal, &first);
        assert!(!skipped);
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().any(|entry| entry.draft == "latest"));
        assert!(list(&mut journal, &second).0.is_empty());
        journal.release("main");
        assert_eq!(list(&mut journal, &second).0.len(), 3);
    }

    #[test]
    fn corrupted_record_is_reported_and_interrupted_write_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        {
            let mut journal = journal(&dir);
            let broken = record("old", "a", "damaged");
            let path = journal.path.join(format!("{}.draft", broken.entry.id));
            journal.write(broken).unwrap();
            let mut bytes = fs::read(&path).unwrap();
            *bytes.last_mut().unwrap() ^= 1;
            fs::write(path, bytes).unwrap();
            journal.write(record("old", "b", "valid")).unwrap();
            fs::write(journal.path.join(".pending-stale"), MAGIC).unwrap();
        }
        let mut journal = journal(&dir);
        let (entries, skipped) = list(&mut journal, "new");
        assert!(skipped);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].draft, "valid");
        assert_eq!(journal.damaged.len(), 1);
        assert!(!journal.path.join(".pending-stale").exists());
    }

    #[test]
    fn insufficient_space_preserves_the_previous_durable_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal = journal(&dir);
        journal.write(record("old", "a", "previous")).unwrap();
        assert_eq!(
            journal.write_using(record("old", "a", "unsaved"), |_, _, _| {
                Err(io::Error::from(io::ErrorKind::StorageFull))
            }),
            Err(Error::JournalIo)
        );
        drop(journal);
        let mut reopened = self::journal(&dir);
        assert_eq!(list(&mut reopened, "new").0[0].draft, "previous");
    }

    #[test]
    fn interrupted_recovery_handoff_keeps_only_the_durable_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal = journal(&dir);
        let original = record("old", "a", "original");
        let mut replacement = record("new", "b", "recovered");
        replacement.replaces = Some(original.entry.id.clone());
        journal.write(original).unwrap();
        atomic_write(
            &journal.path,
            &replacement.entry.id,
            &serde_json::to_vec(&replacement).unwrap(),
        )
        .unwrap();
        drop(journal);
        let mut reopened = self::journal(&dir);
        let (entries, _) = list(&mut reopened, "next");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].draft, "recovered");
    }

    #[test]
    fn workspace_identity_survives_a_new_grant_and_requires_an_approved_root() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let mut registry = Registry::default();
        let grant = registry.register("first", first.path()).unwrap();
        let (identity, _) = approved(&registry, "first", &grant.id).unwrap();
        assert_eq!(
            approved(&registry, "second", &grant.id),
            Err(Error::PermissionDenied)
        );

        registry.close("first", &grant.id).unwrap();
        assert_eq!(
            approved(&registry, "first", &grant.id),
            Err(Error::PermissionDenied)
        );
        let other = registry.register("second", second.path()).unwrap();
        assert_ne!(
            approved(&registry, "second", &other.id).unwrap().0,
            identity
        );

        let reopened = registry.register("second", first.path()).unwrap();
        assert_ne!(reopened.id, grant.id);
        assert_eq!(
            approved(&registry, "second", &reopened.id).unwrap().0,
            identity
        );
    }

    #[test]
    fn legacy_import_is_validated_and_idempotent_through_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal = journal(&dir);
        let legacy = record("old", "a", "legacy").entry;
        let id = journal.migrate(legacy.clone()).unwrap();
        drop(journal);
        let mut reopened = self::journal(&dir);
        assert_eq!(reopened.migrate(legacy.clone()).unwrap(), id);
        let mut invalid = legacy;
        invalid.source = Source::Workspace {
            root: "/original".into(),
            relative_path: "../outside".into(),
            version: "v1".into(),
            identity: None,
        };
        assert_eq!(reopened.migrate(invalid), Err(Error::InvalidDraft));
        assert_eq!(list(&mut reopened, "next").0.len(), 1);
    }

    #[test]
    fn caps_reject_new_snapshots_without_evicting_live_drafts() {
        let dir = tempfile::tempdir().unwrap();
        let mut journal = journal(&dir);
        let current = journal.owner("main");
        let mut active = record(&current, "a", "live");
        active.stored_at = 0;
        let mut expired = record("old", "a", "expired");
        expired.stored_at = 0;
        journal.write(active).unwrap();
        journal.write(expired).unwrap();
        assert!(list(&mut journal, &current).0.is_empty());
        assert_eq!(journal.records.len(), 1);

        // NULs become six-byte JSON escapes, exercising the total cap.
        let large = "\0".repeat(128 * 1024 - 1);
        for index in 0..42 {
            journal
                .write(record(&current, &format!("large:{index}"), &large))
                .unwrap();
        }
        assert_eq!(
            journal.write(record(&current, "over-total", &large)),
            Err(Error::DraftLimit)
        );
        assert_eq!(
            journal.write(record(&current, "over-document", &(large + "x"))),
            Err(Error::DraftLimit)
        );
        assert_eq!(journal.records.len(), 43);
        assert_eq!(
            journal.records[&key(&[&current, "a"])].record.entry.draft,
            "live"
        );
    }

    #[cfg(unix)]
    #[test]
    fn journal_directory_and_records_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mut journal = journal(&dir);
        journal.write(record("old", "a", "private")).unwrap();
        assert_eq!(
            fs::metadata(&journal.path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for file in fs::read_dir(&journal.path).unwrap() {
            assert_eq!(
                file.unwrap().metadata().unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use crate::contract_fixtures::{assert_case_count, assert_error_codes, assert_payload, at};

    #[test]
    fn journal_permission_is_granted_only_to_workbench_webviews() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        for capability in config["app"]["security"]["capabilities"]
            .as_array()
            .unwrap()
        {
            let granted = capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|permission| permission == "allow-draft-recovery");
            assert_eq!(granted, capability["identifier"] == "workspace-editor");
            if granted {
                assert_eq!(
                    capability["webviews"],
                    serde_json::json!(["main", "workbench-*"])
                );
            }
        }
    }

    #[test]
    fn journal_requests_and_replies_match_shared_contract() {
        assert_error_codes(
            "recovery",
            &[
                Error::PermissionDenied,
                Error::InvalidDraft,
                Error::DraftLimit,
                Error::JournalIo,
            ],
        );
        assert_case_count("RecoveryRequest", 5);
        for index in 0..5 {
            let request: Request =
                serde_json::from_value(at(&format!("/payloads/RecoveryRequest/{index}")).clone())
                    .unwrap();
            assert_payload("RecoveryRequest", index, &request);
        }

        let entry = Draft {
            id: "snapshot".into(),
            name: "main.ts".into(),
            title: "src/main.ts".into(),
            draft: "example".into(),
            timestamp: 100,
            language_override: Some("typescript".into()),
            source: Source::Workspace {
                root: "/project".into(),
                relative_path: "src/main.ts".into(),
                version: "base".into(),
                identity: Some("a".repeat(64)),
            },
        };
        assert_case_count("RecoveryReply", 4);
        for (index, reply) in [
            Reply::List {
                entries: vec![entry],
                skipped: true,
            },
            Reply::Written {
                id: "snapshot".into(),
            },
            Reply::Matches { matches: true },
            Reply::Done,
        ]
        .into_iter()
        .enumerate()
        {
            assert_payload("RecoveryReply", index, &reply);
        }
    }
}
