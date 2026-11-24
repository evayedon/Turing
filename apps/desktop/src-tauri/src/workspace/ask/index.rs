use super::{
    eligible, eligible_directory, excluded_content, make_scan, AskSymbol, Retrieval, FILE_BYTES,
};
use crate::workspace::{
    directory_at, is_workspace_link, relative_parts,
    search::{self, Walk},
    watch, Registry, Result, WorkspaceError,
};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Instant,
};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_FILES: usize = 4096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexAction {
    Status,
    Pause,
    Resume,
    Rebuild,
    Disable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    phase: &'static str,
    files: usize,
    partial: bool,
}

struct Document {
    content: String,
    version: String,
}

#[derive(Default)]
struct Files {
    documents: BTreeMap<String, Arc<Document>>,
    bytes: usize,
    partial: bool,
}

#[derive(Default)]
pub(crate) struct State {
    published: Mutex<Option<Files>>,
    files: AtomicUsize,
    cancelled: AtomicBool,
    paused: AtomicBool,
}

pub(in crate::workspace) struct Index {
    state: Arc<State>,
    worker: thread::Thread,
}

impl Index {
    fn start(root: Dir, hints: watch::AskHints) -> Result<Self> {
        let state = Arc::new(State::default());
        let work = state.clone();
        let worker = thread::Builder::new()
            .name("workspace-ask-index".into())
            .spawn(move || maintain(&root, &hints, &work))?;
        Ok(Self {
            state,
            worker: worker.thread().clone(),
        })
    }
}

impl Drop for Index {
    fn drop(&mut self) {
        self.state.cancelled.store(true, Ordering::Relaxed);
        self.worker.unpark();
    }
}

impl Registry {
    pub(crate) fn ask_index_state(&mut self, owner: &str, id: &str) -> Result<Option<Arc<State>>> {
        let workspace = self.active_mut(owner, id)?;
        if workspace.root_replaced() {
            workspace.ask_index = None;
            return Err(WorkspaceError::PermissionDenied);
        }
        if let Some(watch) = &workspace.watch {
            if !workspace.ask_index_disabled && workspace.ask_index.is_none() {
                workspace.ask_index = Some(Index::start(
                    workspace.root.try_clone()?,
                    watch.ask_hints(),
                )?);
            }
        }
        Ok(workspace
            .ask_index
            .as_ref()
            .map(|index| index.state.clone()))
    }

    pub(crate) fn manage_ask_index(
        &mut self,
        owner: &str,
        id: &str,
        action: IndexAction,
    ) -> Result<IndexStatus> {
        let workspace = self.active_mut(owner, id)?;
        if workspace.root_replaced() {
            workspace.ask_index = None;
            return Err(WorkspaceError::PermissionDenied);
        }
        match action {
            IndexAction::Disable => {
                workspace.ask_index_disabled = true;
                workspace.ask_index = None;
            }
            IndexAction::Rebuild => {
                workspace.ask_index_disabled = false;
                workspace.ask_index = None;
            }
            IndexAction::Resume => workspace.ask_index_disabled = false,
            IndexAction::Pause | IndexAction::Status => {}
        }
        let disabled = workspace.ask_index_disabled;
        let index = self.ask_index_state(owner, id)?;
        let Some(index) = index else {
            return Ok(IndexStatus {
                phase: if disabled { "disabled" } else { "unavailable" },
                files: 0,
                partial: false,
            });
        };
        match action {
            IndexAction::Pause => index.paused.store(true, Ordering::Relaxed),
            IndexAction::Resume => index.paused.store(false, Ordering::Relaxed),
            _ => {}
        }
        let published = index
            .published
            .lock()
            .map_err(|_| WorkspaceError::IoError)?;
        Ok(IndexStatus {
            phase: if index.paused.load(Ordering::Relaxed) {
                "paused"
            } else if published.is_some() {
                "ready"
            } else {
                "indexing"
            },
            files: index.files.load(Ordering::Relaxed),
            partial: published.as_ref().is_some_and(|files| files.partial),
        })
    }
}

impl State {
    pub(crate) fn retrieve(
        &self,
        root: &Dir,
        question: &str,
        symbols: &[AskSymbol],
        cancelled: &AtomicBool,
    ) -> Result<Option<Retrieval>> {
        if self.paused.load(Ordering::Relaxed) || self.cancelled.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let snapshot = {
            let published = self.published.lock().map_err(|_| WorkspaceError::IoError)?;
            let Some(files) = published.as_ref() else {
                return Ok(None);
            };
            let documents = files
                .documents
                .iter()
                .map(|(path, document)| (path.clone(), document.clone()))
                .collect::<Vec<_>>();
            (documents, files.partial)
        };
        let mut scan = make_scan(question, symbols, cancelled)?;
        scan.retrieval.partial = snapshot.1;
        for (path, document) in snapshot.0 {
            if scan.stop()? {
                break;
            }
            scan.rank(&path, &document.content, &document.version)?;
        }
        let result = scan.finish();
        // Watch events are hints. Before any model receives bytes, verify that
        // every selected file is still reachable and has the indexed revision.
        let verified = result.passages.iter().all(|passage| {
            let source = &passage.source;
            let Ok(parts) = relative_parts(&source.relative_path) else {
                return false;
            };
            let Some((name, parents)) = parts.split_last() else {
                return false;
            };
            let Ok(directory) = directory_at(root, parents) else {
                return false;
            };
            let parents: Vec<_> = parents.iter().map(|part| (*part).to_owned()).collect();
            search::read_reachable(root, &directory, &parents, name, FILE_BYTES, &mut 0)
                .is_ok_and(|snapshot| snapshot.version == source.version)
        });
        if !verified
            || self.cancelled.load(Ordering::Relaxed)
            || self.paused.load(Ordering::Relaxed)
        {
            return Ok(None);
        }
        Ok(Some(result))
    }
}

fn maintain(root: &Dir, hints: &watch::AskHints, state: &State) {
    let mut changes = watch::WorkspaceChanges {
        rescan: true,
        paths: Vec::new(),
    };
    while !state.cancelled.load(Ordering::Relaxed) {
        if !state.paused.load(Ordering::Relaxed) {
            if changes.rescan || !changes.paths.is_empty() {
                let Ok(mut published) = state.published.lock() else {
                    return;
                };
                let mut files = published.take().unwrap_or_default();
                drop(published);
                if changes.rescan {
                    files = Files::default();
                }
                state.files.store(files.documents.len(), Ordering::Relaxed);
                let mut batch = Batch {
                    files: &mut files,
                    state,
                    bytes: 0,
                    entries: 0,
                    deadline: Instant::now() + search::MAX_DURATION,
                };
                let result = if changes.rescan {
                    batch.visit(root, &mut Vec::new())
                } else {
                    batch.update(root, &changes.paths)
                };
                if state.cancelled.load(Ordering::Relaxed) {
                    return;
                }
                if matches!(result, Err(WorkspaceError::SearchCancelled))
                    || state.paused.load(Ordering::Relaxed)
                {
                    changes = watch::WorkspaceChanges {
                        rescan: true,
                        paths: Vec::new(),
                    };
                    continue;
                }
                files.partial |= result.is_err();
                let Ok(mut published) = state.published.lock() else {
                    return;
                };
                *published = Some(files);
            }
            changes = hints.take();
            if changes.rescan || !changes.paths.is_empty() {
                continue;
            }
        }
        thread::park_timeout(watch::QUIET_PERIOD);
    }
}

struct Batch<'a> {
    files: &'a mut Files,
    state: &'a State,
    bytes: u64,
    entries: usize,
    deadline: Instant,
}

impl Batch<'_> {
    fn update(&mut self, root: &Dir, paths: &[String]) -> Result<()> {
        for path in paths {
            let prefix = format!("{path}/");
            self.files.documents.retain(|candidate, doc| {
                if candidate == path || candidate.starts_with(&prefix) {
                    self.files.bytes -= doc.content.len();
                    false
                } else {
                    true
                }
            });
        }
        self.state
            .files
            .store(self.files.documents.len(), Ordering::Relaxed);
        for path in paths {
            if self.stop()? {
                break;
            }
            self.count_entry();
            let Ok(parts) = relative_parts(path) else {
                continue;
            };
            let Some((&name, parents)) = parts.split_last() else {
                continue;
            };
            if parents.len() >= search::MAX_DEPTH
                || parents
                    .iter()
                    .any(|part| !eligible_directory(part) || search::ignored_directory(part))
            {
                continue;
            }
            let Ok(directory) = directory_at(root, parents) else {
                continue;
            };
            let Ok(metadata) = directory.symlink_metadata(name) else {
                continue;
            };
            if is_workspace_link(&metadata) {
                continue;
            }
            let mut parents: Vec<_> = parents.iter().map(|part| (*part).to_owned()).collect();
            if metadata.is_dir() && eligible_directory(name) && !search::ignored_directory(name) {
                parents.push(name.into());
                if self.visit(root, &mut parents).is_err() {
                    self.truncate();
                }
            } else if metadata.is_file() {
                self.file(root, &directory, &parents, name)?;
            }
        }
        Ok(())
    }
}

impl Walk for Batch<'_> {
    fn stop(&mut self) -> Result<bool> {
        if self.state.cancelled.load(Ordering::Relaxed) || self.state.paused.load(Ordering::Relaxed)
        {
            return Err(WorkspaceError::SearchCancelled);
        }
        let stop = Instant::now() >= self.deadline
            || self.entries >= search::MAX_ENTRIES
            || self.bytes >= search::MAX_SCAN_BYTES - FILE_BYTES - 1
            || self.files.documents.len() >= MAX_FILES
            || self.files.bytes >= MAX_BYTES;
        self.files.partial |= stop;
        Ok(stop)
    }

    fn count_entry(&mut self) {
        self.entries += 1;
    }
    fn skipped(&mut self) {
        self.files.partial = true;
    }
    fn truncate(&mut self) {
        self.files.partial = true;
    }
    fn descend(&self, name: &str) -> bool {
        eligible_directory(name)
    }

    fn file(&mut self, root: &Dir, directory: &Dir, parents: &[String], name: &str) -> Result<()> {
        if name.starts_with('.') || !eligible(name) {
            return Ok(());
        }
        let Ok(snapshot) =
            search::read_reachable(root, directory, parents, name, FILE_BYTES, &mut self.bytes)
        else {
            self.skipped();
            return Ok(());
        };
        if excluded_content(&snapshot.content)
            || self.files.bytes + snapshot.content.len() > MAX_BYTES
        {
            self.skipped();
            return Ok(());
        }
        let path = parents
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(name))
            .collect::<Vec<_>>()
            .join("/");
        self.files.bytes += snapshot.content.len();
        self.files.documents.insert(
            path,
            Arc::new(Document {
                content: snapshot.content,
                version: snapshot.version,
            }),
        );
        self.state
            .files
            .store(self.files.documents.len(), Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::Duration};

    fn wait_until(mut check: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if check() {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        panic!("workspace index did not converge");
    }

    #[test]
    fn refreshes_changed_subtrees_and_discards_revoked_workspace_index() {
        let fixture = tempfile::TempDir::new().unwrap();
        let folder = fixture.path().join("src");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("first.rs"), "fn original() {}").unwrap();
        fs::write(fixture.path().join("secret.rs"), "fn excluded() {}").unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register("main", fixture.path()).unwrap();
        let root = registry.ask_root("main", &workspace.id).unwrap();
        let watch = watch::Watch::start(fixture.path()).unwrap();
        let inbox = watch.inbox();
        registry.attach_watch("main", &workspace.id, watch).unwrap();
        assert!(registry.ask_index_state("other", &workspace.id).is_err());
        let index = registry
            .ask_index_state("main", &workspace.id)
            .unwrap()
            .unwrap();
        let cancelled = AtomicBool::new(false);
        wait_until(|| {
            index
                .retrieve(&root, "original", &[], &cancelled)
                .unwrap()
                .is_some_and(|result| {
                    result.passages.len() == 1 && result.passages[0].text.contains("original")
                })
        });
        registry
            .manage_ask_index("main", &workspace.id, IndexAction::Pause)
            .unwrap();
        assert!(index
            .retrieve(&root, "original", &[], &cancelled)
            .unwrap()
            .is_none());
        fs::remove_file(folder.join("first.rs")).unwrap();
        fs::write(folder.join("second.rs"), "fn revised() {}").unwrap();
        watch::deliver(
            &inbox,
            fixture.path(),
            Ok(notify::Event::new(notify::EventKind::Any).add_path(folder)),
        );
        registry
            .manage_ask_index("main", &workspace.id, IndexAction::Resume)
            .unwrap();
        wait_until(|| {
            index
                .retrieve(&root, "revised", &[], &cancelled)
                .unwrap()
                .is_some_and(|result| {
                    result.passages.len() == 1
                        && result.passages[0].source.relative_path == "src/second.rs"
                        && result.passages[0].text.contains("revised")
                })
        });
        registry
            .manage_ask_index("main", &workspace.id, IndexAction::Disable)
            .unwrap();
        assert!(registry
            .ask_index_state("main", &workspace.id)
            .unwrap()
            .is_none());
        assert!(index
            .retrieve(&root, "revised", &[], &cancelled)
            .unwrap()
            .is_none());
        registry.close("main", &workspace.id).unwrap();
        assert!(registry.ask_index_state("main", &workspace.id).is_err());
    }
}
