mod extract;

use super::{
    directory_at, relative_parts,
    search::{self, Walk},
    watch, Registry, Result, WorkspaceError, MAX_TEXT_BYTES,
};
use cap_std::fs::Dir;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FILES: usize = 12_000;
const MAX_SYMBOLS: usize = 30_000;
const MAX_PER_FILE: usize = 256;
const MAX_RESULTS: usize = 100;
const MAX_PATH_BYTES: usize = 4096;
const FALLBACK_RESCAN: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Class,
    Constant,
    Enum,
    Function,
    Interface,
    Macro,
    Module,
    Struct,
    Trait,
    Type,
    Variable,
}

struct Declaration {
    name: String,
    folded: String,
    kind: Kind,
    line: usize,
    character: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Symbol {
    name: String,
    kind: Kind,
    relative_path: String,
    line: usize,
    character: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolsResponse {
    generation: u64,
    complete: bool,
    truncated: bool,
    symbols: Vec<Symbol>,
}

struct IndexedFile {
    declarations: Vec<Declaration>,
    truncated: bool,
}

#[derive(Default)]
struct Files {
    by_path: BTreeMap<String, IndexedFile>,
    symbols: usize,
    limited: bool,
}

impl Files {
    fn remove(&mut self, path: &str) {
        if let Some(file) = self.by_path.remove(path) {
            self.symbols -= file.declarations.len();
        }
        let prefix = format!("{path}/");
        let descendants: Vec<_> = self
            .by_path
            .range(prefix.clone()..)
            .take_while(|(path, _)| path.starts_with(&prefix))
            .map(|(path, _)| path.clone())
            .collect();
        for path in descendants {
            if let Some(file) = self.by_path.remove(&path) {
                self.symbols -= file.declarations.len();
            }
        }
    }

    fn query(&self, generation: u64, query: &str, limit: usize) -> SymbolsResponse {
        let query = query.to_lowercase();
        let words: Vec<_> = query.split_whitespace().collect();
        let mut response = SymbolsResponse {
            generation,
            complete: true,
            truncated: self.limited || self.by_path.values().any(|file| file.truncated),
            symbols: Vec::new(),
        };
        // Prefer prefix matches. Paths and source order break ties.
        for prefix in [true, false] {
            for (path, file) in &self.by_path {
                for declaration in &file.declarations {
                    if declaration.folded.starts_with(&query) != prefix
                        || !words.iter().all(|word| declaration.folded.contains(word))
                    {
                        continue;
                    }
                    if response.symbols.len() == limit {
                        response.truncated = true;
                        return response;
                    }
                    response.symbols.push(Symbol {
                        name: declaration.name.clone(),
                        kind: declaration.kind,
                        relative_path: path.clone(),
                        line: declaration.line,
                        character: declaration.character,
                    });
                }
            }
        }
        response
    }
}

#[derive(Default)]
struct State {
    files: Mutex<Option<Files>>,
    cancelled: AtomicBool,
}

pub(super) struct Index {
    state: Arc<State>,
    worker: thread::Thread,
}

impl Index {
    fn start(root: Dir, hints: Option<watch::SymbolHints>) -> Result<Self> {
        let state = Arc::new(State::default());
        let worker_state = Arc::clone(&state);
        let worker = thread::Builder::new()
            .name("workspace-symbols".into())
            .spawn(move || maintain(&root, hints.as_ref(), &worker_state))?;
        Ok(Self {
            state,
            worker: worker.thread().clone(),
        })
    }

    fn query(&self, generation: u64, query: &str, limit: usize) -> Result<SymbolsResponse> {
        let files = self
            .state
            .files
            .lock()
            .map_err(|_| WorkspaceError::IoError)?;
        Ok(match files.as_ref() {
            Some(files) => files.query(generation, query, limit),
            None => SymbolsResponse {
                generation,
                complete: false,
                truncated: false,
                symbols: Vec::new(),
            },
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
    pub fn query_symbols(
        &mut self,
        owner: &str,
        id: &str,
        query: &str,
        limit: usize,
    ) -> Result<SymbolsResponse> {
        let generation = self.generation;
        let workspace = self.active_mut(owner, id)?;
        if workspace.symbols_revoked || workspace.root_replaced() {
            workspace.revoke_symbols();
            return Err(WorkspaceError::PermissionDenied);
        }
        if query.len() > search::MAX_QUERY_BYTES
            || query.chars().any(char::is_control)
            || !(1..=MAX_RESULTS).contains(&limit)
        {
            return Err(WorkspaceError::InvalidSearch);
        }
        if workspace.symbols.is_none() {
            workspace.symbols = Some(Index::start(
                workspace.root.try_clone()?,
                workspace.watch.as_ref().map(watch::Watch::symbol_hints),
            )?);
        }
        let response = workspace
            .symbols
            .as_ref()
            .ok_or(WorkspaceError::IoError)?
            .query(generation, query.trim(), limit)?;
        if workspace.root_replaced() {
            workspace.revoke_symbols();
            return Err(WorkspaceError::PermissionDenied);
        }
        Ok(response)
    }
}

fn maintain(root: &Dir, hints: Option<&watch::SymbolHints>, state: &State) {
    let mut changes = watch::WorkspaceChanges {
        rescan: true,
        paths: Vec::new(),
    };
    while !state.cancelled.load(Ordering::Relaxed) {
        if changes.rescan || !changes.paths.is_empty() {
            let mut files = {
                let Ok(mut published) = state.files.lock() else {
                    return;
                };
                published.take().unwrap_or_default()
            };
            if changes.rescan {
                files = Files::default();
            }
            let mut batch = Batch::new(&mut files, &state.cancelled);
            let result = if changes.rescan {
                batch.visit(root, &mut Vec::new())
            } else {
                batch.update(root, &changes.paths)
            };
            if state.cancelled.load(Ordering::Relaxed) {
                return;
            }
            if result.is_err() {
                files.limited = true;
            }
            let Ok(mut published) = state.files.lock() else {
                return;
            };
            *published = Some(files);
        }

        thread::park_timeout(if hints.is_some() {
            watch::QUIET_PERIOD
        } else {
            FALLBACK_RESCAN
        });
        changes = match hints {
            Some(hints) => hints.take(Instant::now()),
            None => watch::WorkspaceChanges {
                rescan: true,
                paths: Vec::new(),
            },
        };
    }
}

struct Batch<'a> {
    files: &'a mut Files,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    entries: usize,
    reads: usize,
    bytes: u64,
}

impl<'a> Batch<'a> {
    fn new(files: &'a mut Files, cancelled: &'a AtomicBool) -> Self {
        Self {
            files,
            cancelled,
            deadline: Instant::now() + search::MAX_DURATION,
            entries: 0,
            reads: 0,
            bytes: 0,
        }
    }

    fn update(&mut self, root: &Dir, paths: &[String]) -> Result<()> {
        for path in paths {
            self.files.remove(path);
        }
        for path in paths {
            if self.stop()? {
                break;
            }
            let Ok(parts) = relative_parts(path) else {
                continue;
            };
            let Some((name, parents)) = parts.split_last() else {
                continue;
            };
            if parents.len() > search::MAX_DEPTH || path.len() > MAX_PATH_BYTES {
                self.truncate();
                continue;
            }
            if parts
                .iter()
                .any(|name| !search::visible_component(name) || search::ignored_directory(name))
            {
                continue;
            }
            let Ok(directory) = directory_at(root, parents) else {
                continue;
            };
            let Ok(metadata) = directory.symlink_metadata(name) else {
                continue;
            };
            if super::is_workspace_link(&metadata) {
                continue;
            }
            let mut parents: Vec<_> = parents.iter().map(|part| (*part).to_owned()).collect();
            if metadata.is_dir() && parents.len() < search::MAX_DEPTH {
                parents.push((*name).to_owned());
                if self.visit(root, &mut parents).is_err() {
                    self.truncate();
                }
            } else if metadata.is_dir() {
                self.truncate();
            } else if metadata.is_file() {
                self.file(root, &directory, &parents, name)?;
            }
        }
        Ok(())
    }
}

impl Walk for Batch<'_> {
    fn stop(&mut self) -> Result<bool> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(WorkspaceError::SearchCancelled);
        }
        let stop = self.entries >= search::MAX_ENTRIES
            || self.reads >= MAX_FILES
            || self.files.by_path.len() >= MAX_FILES
            || self.files.symbols >= MAX_SYMBOLS
            || self.bytes > search::MAX_SCAN_BYTES - MAX_TEXT_BYTES - 1
            || Instant::now() >= self.deadline;
        if stop {
            self.truncate();
        }
        Ok(stop)
    }

    fn count_entry(&mut self) {
        self.entries += 1;
    }

    fn skipped(&mut self) {
        self.truncate();
    }

    fn truncate(&mut self) {
        self.files.limited = true;
    }

    fn file(&mut self, root: &Dir, directory: &Dir, parents: &[String], name: &str) -> Result<()> {
        let Some(language) = extract::Language::for_name(name) else {
            return Ok(());
        };
        let path = if parents.is_empty() {
            name.to_owned()
        } else {
            format!("{}/{name}", parents.join("/"))
        };
        if path.len() > MAX_PATH_BYTES {
            self.truncate();
            return Ok(());
        }
        self.reads += 1;
        let file = match search::read_reachable(root, directory, parents, name, &mut self.bytes) {
            Ok(snapshot) => extract::declarations(
                language,
                &snapshot.content,
                MAX_PER_FILE.min(MAX_SYMBOLS - self.files.symbols),
                self.cancelled,
                self.deadline,
            )?,
            Err(WorkspaceError::InvalidEncoding) => return Ok(()),
            Err(WorkspaceError::FileTooLarge) => IndexedFile {
                declarations: Vec::new(),
                truncated: true,
            },
            Err(_) => {
                self.truncate();
                return Ok(());
            }
        };
        if Instant::now() >= self.deadline {
            self.truncate();
        }
        self.files.symbols += file.declarations.len();
        self.files.by_path.insert(path, file);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::mpsc};

    fn query_until(
        registry: &mut Registry,
        id: &str,
        query: &str,
        expected: &[&str],
    ) -> SymbolsResponse {
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            let response = registry.query_symbols("main", id, query, 10).unwrap();
            let names: Vec<_> = response
                .symbols
                .iter()
                .map(|symbol| symbol.name.as_str())
                .collect();
            if response.complete && names == expected {
                return response;
            }
            assert!(Instant::now() < deadline, "{query}: {response:?}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn extracts_declarations_and_utf16_positions_without_comment_or_literal_matches() {
        let cases = [
            (
                "a.tsx",
                "/*\nfunction fake() {}\n*/\n/* 🌌 */ export async function café() {}\r\nexport const enum Tone {}\nlet value = `\nclass Fake {}\n`;\nexport interface Item {}",
                vec![("café", Kind::Function, 3, 31), ("Tone", Kind::Enum, 4, 18),
                     ("value", Kind::Variable, 5, 4), ("Item", Kind::Interface, 8, 17)],
            ),
            (
                "lib.rs",
                "/* /* nested */\nfn fake() {}\n*/\n#[inline] pub(crate) async fn visit() {}\npub struct Record;\nmacro_rules! rule {}\nconst TEXT: &str = r#\"\nfn fake() {}\n\"#;",
                vec![("visit", Kind::Function, 3, 30), ("Record", Kind::Struct, 4, 11),
                     ("rule", Kind::Macro, 5, 13), ("TEXT", Kind::Constant, 6, 6)],
            ),
            (
                "a.py",
                "'''\ndef fake():\n'''\nclass Board:\n    async def load(self):\n        pass\ntype Color = str",
                vec![("Board", Kind::Class, 3, 6), ("load", Kind::Function, 4, 14),
                     ("Color", Kind::Type, 6, 5)],
            ),
            (
                "a.hpp",
                "#define LIMIT 4\nnamespace nebula {\n  enum class Tone {};\n  const char* Board::title() const {\n    return get_title();\n  }\n}\nusing Size = int;\nfetch();",
                vec![("LIMIT", Kind::Macro, 0, 8), ("nebula", Kind::Module, 1, 10),
                     ("Tone", Kind::Enum, 2, 13), ("title", Kind::Function, 3, 21),
                     ("Size", Kind::Type, 7, 6)],
            ),
        ];
        for (name, source, expected) in cases {
            let file = extract::declarations(
                extract::Language::for_name(name).unwrap(),
                source,
                MAX_PER_FILE,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(3),
            )
            .unwrap();
            let actual: Vec<_> = file
                .declarations
                .iter()
                .map(|decl| (decl.name.as_str(), decl.kind, decl.line, decl.character))
                .collect();
            assert_eq!(actual, expected, "{name}");
            assert!(!file.truncated);
        }
    }

    #[test]
    fn watcher_hints_refresh_edits_removals_subtrees_and_rescans_without_explorer_polling() {
        let folder = tempfile::tempdir().unwrap();
        let original = folder.path().join("a.py");
        fs::write(&original, "def original(): pass").unwrap();
        fs::create_dir(folder.path().join("node_modules")).unwrap();
        fs::write(
            folder.path().join("node_modules/no.ts"),
            "function hidden() {}",
        )
        .unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register("main", folder.path()).unwrap();
        let root = registry
            .workspace_path("main", &workspace.id)
            .unwrap()
            .to_path_buf();
        let (hints, inbox) = watch::SymbolHints::test_inbox();
        let active = registry.active_mut("main", &workspace.id).unwrap();
        active.symbols = Some(Index::start(active.root.try_clone().unwrap(), Some(hints)).unwrap());
        let initial = query_until(&mut registry, &workspace.id, "", &["original"]);
        let hint = |path: &std::path::Path| {
            watch::deliver(
                &inbox,
                &root,
                Ok(notify::Event::new(notify::EventKind::Any)
                    .add_path(root.join(path.strip_prefix(folder.path()).unwrap()))),
            );
        };
        fs::write(&original, "def edited(): pass").unwrap();
        hint(&original);
        let edited = query_until(&mut registry, &workspace.id, "", &["edited"]);
        assert_eq!(edited.generation, initial.generation);

        let nested = folder.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::rename(&original, nested.join("renamed.py")).unwrap();
        hint(&original);
        hint(&nested);
        let moved = query_until(&mut registry, &workspace.id, "edited", &["edited"]);
        let deadline = Instant::now() + Duration::from_secs(6);
        let mut path = moved.symbols[0].relative_path.clone();
        while path != "nested/renamed.py" {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
            let result = registry
                .query_symbols("main", &workspace.id, "edited", 10)
                .unwrap();
            if let Some(symbol) = result.symbols.first() {
                path.clone_from(&symbol.relative_path);
            }
        }
        fs::remove_dir_all(&nested).unwrap();
        hint(&nested);
        query_until(&mut registry, &workspace.id, "", &[]);
        fs::write(&original, "def rebuilt(): pass").unwrap();
        watch::deliver(&inbox, folder.path(), Err(notify::Error::generic("rescan")));
        query_until(&mut registry, &workspace.id, "", &["rebuilt"]);
    }

    #[test]
    fn rejects_stale_registration_caller_and_reload() {
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        fs::write(old.path().join("a.rs"), "fn before() {}").unwrap();
        fs::write(new.path().join("b.rs"), "fn after() {}").unwrap();
        let mut registry = Registry::default();
        let first = registry.register("main", old.path()).unwrap();
        let before = query_until(&mut registry, &first.id, "", &["before"]);
        let first_worker = Arc::clone(
            &registry
                .active
                .as_ref()
                .unwrap()
                .symbols
                .as_ref()
                .unwrap()
                .state,
        );
        assert_eq!(
            registry
                .query_symbols("other", &first.id, "", 10)
                .unwrap_err(),
            WorkspaceError::PermissionDenied,
        );
        let second = registry.register("main", new.path()).unwrap();
        assert!(first_worker.cancelled.load(Ordering::Relaxed));
        assert_eq!(
            registry
                .query_symbols("main", &first.id, "", 10)
                .unwrap_err(),
            WorkspaceError::PermissionDenied,
        );
        let after = query_until(&mut registry, &second.id, "", &["after"]);
        assert!(after.generation > before.generation);
        let second_worker = Arc::clone(
            &registry
                .active
                .as_ref()
                .unwrap()
                .symbols
                .as_ref()
                .unwrap()
                .state,
        );
        registry.page_reloaded();
        assert!(second_worker.cancelled.load(Ordering::Relaxed));
        assert_eq!(
            registry
                .query_symbols("main", &second.id, "", 10)
                .unwrap_err(),
            WorkspaceError::PermissionDenied,
        );
        let third = registry.register("main", old.path()).unwrap();
        query_until(&mut registry, &third.id, "", &["before"]);
        let third_worker = Arc::clone(
            &registry
                .active
                .as_ref()
                .unwrap()
                .symbols
                .as_ref()
                .unwrap()
                .state,
        );
        registry.close("main", &third.id).unwrap();
        assert!(third_worker.cancelled.load(Ordering::Relaxed));
    }

    #[test]
    fn indexes_thousands_within_budget_and_cancels_a_worker_midway() {
        const COUNT: usize = 4_000;
        let folder = tempfile::tempdir().unwrap();
        for shard in ["first", "second"] {
            fs::create_dir(folder.path().join(shard)).unwrap();
            for i in 0..COUNT / 2 {
                fs::write(
                    folder.path().join(format!("{shard}/{i}.rs")),
                    format!("fn {shard}_{i}() {{}}"),
                )
                .unwrap();
            }
        }
        let mut registry = Registry::default();
        let first = registry.register("main", folder.path()).unwrap();
        let root = registry
            .authorize("main", &first.id)
            .unwrap()
            .try_clone()
            .unwrap();
        let state = Arc::new(State::default());
        let mut files = Files::default();
        let started = Instant::now();
        Batch::new(&mut files, &state.cancelled)
            .visit(&root, &mut Vec::new())
            .unwrap();
        assert!(started.elapsed() < search::MAX_DURATION);
        assert_eq!(files.symbols, COUNT);
        assert!(!files.limited);
        assert!(files.query(1, "", 100).truncated);
        assert_eq!(files.query(1, "second_1999", 10).symbols.len(), 1);

        let (progress, halfway) = mpsc::channel();
        let (resume, paused) = mpsc::channel();
        thread::scope(|scope| {
            let worker = scope.spawn({
                let state = Arc::clone(&state);
                move || {
                    let mut files = Files::default();
                    let mut batch = Batch::new(&mut files, &state.cancelled);
                    batch.visit(&root, &mut vec!["first".into()]).unwrap();
                    progress.send(batch.files.symbols).unwrap();
                    paused.recv_timeout(Duration::from_secs(5)).unwrap();
                    let result = batch.visit(&root, &mut vec!["second".into()]);
                    (result, files.symbols)
                }
            });
            assert_eq!(
                halfway.recv_timeout(search::MAX_DURATION).unwrap(),
                COUNT / 2
            );
            registry.active_mut("main", &first.id).unwrap().symbols = Some(Index {
                state: Arc::clone(&state),
                worker: worker.thread().clone(),
            });
            let replacement = tempfile::tempdir().unwrap();
            fs::write(replacement.path().join("main.py"), "def current(): pass").unwrap();
            let second = registry.register("main", replacement.path()).unwrap();
            assert!(state.cancelled.load(Ordering::Relaxed));
            assert_eq!(
                registry
                    .query_symbols("main", &first.id, "", 10)
                    .unwrap_err(),
                WorkspaceError::PermissionDenied,
            );
            let started = Instant::now();
            resume.send(()).unwrap();
            assert_eq!(
                worker.join().unwrap(),
                (Err(WorkspaceError::SearchCancelled), COUNT / 2)
            );
            assert!(started.elapsed() < Duration::from_secs(2));
            query_until(&mut registry, &second.id, "", &["current"]);
        });
    }

    #[test]
    fn reports_limits_for_oversized_files_and_excess_declarations() {
        let folder = tempfile::tempdir().unwrap();
        fs::write(
            folder.path().join("huge.py"),
            vec![b' '; MAX_TEXT_BYTES as usize + 1],
        )
        .unwrap();
        let crowded = (0..MAX_PER_FILE + 1)
            .map(|i| format!("fn name_{i}() {{}}\n"))
            .collect::<String>();
        fs::write(folder.path().join("crowded.rs"), crowded).unwrap();
        let (_, root) = super::super::open_picked_directory(folder.path()).unwrap();
        let mut files = Files::default();
        Batch::new(&mut files, &AtomicBool::new(false))
            .visit(&root, &mut Vec::new())
            .unwrap();
        assert_eq!(files.symbols, MAX_PER_FILE);
        assert!(files.by_path["huge.py"].truncated);
        assert!(files.by_path["crowded.rs"].truncated);
        assert!(files.query(1, "name_0", 10).truncated);
    }

    #[cfg(unix)]
    #[test]
    fn skips_links_and_denies_a_replaced_root() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::write(folder.path().join("outside.rs"), "fn outside() {}").unwrap();
        std::os::unix::fs::symlink(folder.path().join("outside.rs"), root.join("linked.rs"))
            .unwrap();
        fs::write(root.join("inside.rs"), "fn inside() {}").unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register("main", &root).unwrap();
        query_until(&mut registry, &workspace.id, "", &["inside"]);
        fs::rename(&root, folder.path().join("moved")).unwrap();
        fs::create_dir(&root).unwrap();
        assert_eq!(
            registry
                .query_symbols("main", &workspace.id, "", 10)
                .unwrap_err(),
            WorkspaceError::PermissionDenied,
        );
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use crate::contract_fixtures as fixture;

    #[test]
    fn workspace_symbol_payloads_match_the_contract() {
        use Kind::*;
        fixture::assert_enum_values(
            "WorkspaceSymbolKind",
            &[
                Class, Constant, Enum, Function, Interface, Macro, Module, Struct, Trait, Type,
                Variable,
            ],
        );
        fixture::assert_payload(
            "SymbolsResponse",
            0,
            &SymbolsResponse {
                generation: 3,
                complete: true,
                truncated: true,
                symbols: vec![Symbol {
                    name: "café".into(),
                    kind: Function,
                    relative_path: "src/ünï.rs".into(),
                    line: 2,
                    character: 7,
                }],
            },
        );
        fixture::assert_payload(
            "SymbolsResponse",
            1,
            &SymbolsResponse {
                generation: 4,
                complete: false,
                truncated: false,
                symbols: Vec::new(),
            },
        );
        fixture::assert_case_count("SymbolsResponse", 2);
    }
}
