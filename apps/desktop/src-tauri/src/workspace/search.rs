use super::{
    directory_at, file, valid_component, Registry, Result, WorkspaceError, MAX_TEXT_BYTES,
};
use cap_std::fs::Dir;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const MAX_QUERY_BYTES: usize = 256;
const MAX_ENTRIES: usize = 50_000;
const MAX_SCAN_BYTES: u64 = 128 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
const MAX_MATCHES: usize = 500;
const MAX_DURATION: Duration = Duration::from_secs(10);
const IGNORED: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    "coverage",
    ".cache",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchOptions {
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    filename_filter: Option<String>,
}

struct Query {
    pattern: Regex,
    whole_word: bool,
    filename_filter: Option<String>,
}

impl Query {
    fn new(options: SearchOptions) -> Result<Self> {
        if options.query.trim().is_empty()
            || options.query.len() > MAX_QUERY_BYTES
            || options.query.contains(['\r', '\n', '\0'])
        {
            return Err(WorkspaceError::InvalidSearch);
        }
        let filename_filter = options.filename_filter.as_deref().map(str::trim);
        if filename_filter.is_some_and(|name| {
            !name.is_empty()
                && (!valid_component(name)
                    || name.len() > MAX_QUERY_BYTES
                    || name.chars().any(char::is_control))
        }) {
            return Err(WorkspaceError::InvalidSearch);
        }
        let pattern = RegexBuilder::new(&regex::escape(&options.query))
            .case_insensitive(!options.case_sensitive)
            .build()
            .map_err(|_| WorkspaceError::InvalidSearch)?;
        Ok(Self {
            pattern,
            whole_word: options.whole_word,
            filename_filter: filename_filter
                .filter(|name| !name.is_empty())
                .map(str::to_lowercase),
        })
    }
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    files: Vec<SearchFile>,
    truncated: bool,
    skipped_files: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchFile {
    relative_path: String,
    matches: Vec<SearchMatch>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    line: usize,
    column: usize,
    before: String,
    text: String,
    after: String,
}

pub(super) struct SearchJob {
    id: String,
    cancelled: Arc<AtomicBool>,
    query: Option<Query>,
}

pub struct SearchTask {
    root: Dir,
    query: Query,
    cancelled: Arc<AtomicBool>,
}

impl Registry {
    pub fn begin_search(
        &mut self,
        owner: &str,
        workspace_id: &str,
        options: SearchOptions,
    ) -> Result<String> {
        self.authorize(owner, workspace_id)?;
        if self.search.as_ref().is_some_and(|job| job.query.is_none()) {
            return Err(WorkspaceError::SearchBusy);
        }
        let query = Query::new(options)?;
        let id = uuid::Uuid::new_v4().to_string();
        self.search = Some(SearchJob {
            id: id.clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
            query: Some(query),
        });
        Ok(id)
    }

    pub fn claim_search(
        &mut self,
        owner: &str,
        workspace_id: &str,
        id: &str,
    ) -> Result<SearchTask> {
        let root = self.authorize(owner, workspace_id)?.try_clone()?;
        let job = self
            .search
            .as_mut()
            .filter(|job| job.id == id)
            .ok_or(WorkspaceError::SearchCancelled)?;
        let query = job.query.take().ok_or(WorkspaceError::SearchBusy)?;
        Ok(SearchTask {
            root,
            query,
            cancelled: Arc::clone(&job.cancelled),
        })
    }

    pub fn cancel_search(&mut self, owner: &str, workspace_id: &str, id: &str) -> Result<()> {
        self.authorize(owner, workspace_id)?;
        if self.search.as_ref().is_some_and(|job| job.id == id) {
            self.revoke_search();
        }
        Ok(())
    }

    pub(super) fn revoke_search(&mut self) {
        if let Some(job) = &self.search {
            if job.query.is_some() {
                self.search = None;
            } else {
                job.cancelled.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn finish_search(&mut self, owner: &str, workspace_id: &str, id: &str) -> Result<()> {
        let job = self
            .search
            .take_if(|job| job.id == id)
            .ok_or(WorkspaceError::SearchCancelled)?;
        if job.cancelled.load(Ordering::Relaxed) {
            return Err(WorkspaceError::SearchCancelled);
        }
        self.authorize(owner, workspace_id)?;
        Ok(())
    }
}

impl SearchTask {
    pub fn run(self) -> Result<SearchResponse> {
        let mut scan = Scan {
            task: &self,
            response: SearchResponse::default(),
            deadline: Instant::now() + MAX_DURATION,
            bytes: 0,
            entries: 0,
            matches: 0,
        };
        scan.visit(&mut Vec::new())?;
        scan.finished()?;
        scan.response
            .files
            .sort_unstable_by(|left, right| left.relative_path.cmp(&right.relative_path));
        Ok(scan.response)
    }
}

struct Scan<'a> {
    task: &'a SearchTask,
    response: SearchResponse,
    deadline: Instant,
    bytes: u64,
    entries: usize,
    matches: usize,
}

impl Scan<'_> {
    fn finished(&mut self) -> Result<bool> {
        if self.task.cancelled.load(Ordering::Relaxed) {
            return Err(WorkspaceError::SearchCancelled);
        }
        if self.matches >= MAX_MATCHES || Instant::now() >= self.deadline {
            self.response.truncated = true;
            return Ok(true);
        }
        Ok(false)
    }

    fn traversal_finished(&mut self) -> Result<bool> {
        if self.finished()? {
            return Ok(true);
        }
        if self.entries >= MAX_ENTRIES || self.bytes > MAX_SCAN_BYTES - MAX_TEXT_BYTES - 1 {
            self.response.truncated = true;
            return Ok(true);
        }
        Ok(false)
    }

    fn visit(&mut self, parents: &mut Vec<String>) -> Result<()> {
        if self.traversal_finished()? {
            return Ok(());
        }
        let components = parents.iter().map(String::as_str).collect::<Vec<_>>();
        let entries = directory_at(&self.task.root, &components).and_then(|dir| {
            let entries = dir.entries()?;
            Ok((dir, entries))
        });
        let (directory, entries) = match entries {
            Ok(opened) => opened,
            Err(error) if parents.is_empty() => return Err(error),
            Err(_) => {
                self.response.skipped_files += 1;
                return Ok(());
            }
        };
        for entry in entries {
            if self.traversal_finished()? {
                break;
            }
            self.entries += 1;
            let Ok(entry) = entry else {
                self.response.skipped_files += 1;
                continue;
            };
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if !valid_component(&name) || name.starts_with(".turing-save-") {
                continue;
            }
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => {
                    if IGNORED
                        .iter()
                        .any(|ignored| name.eq_ignore_ascii_case(ignored))
                    {
                        continue;
                    }
                    if parents.len() >= MAX_DEPTH {
                        self.response.truncated = true;
                        continue;
                    }
                    parents.push(name);
                    self.visit(parents)?;
                    parents.pop();
                }
                Ok(kind) if kind.is_file() => self.scan_file(&directory, parents, &name)?,
                Ok(_) => {}
                Err(_) => self.response.skipped_files += 1,
            }
        }
        Ok(())
    }

    fn scan_file(&mut self, directory: &Dir, parents: &[String], name: &str) -> Result<()> {
        if self
            .task
            .query
            .filename_filter
            .as_ref()
            .is_some_and(|filter| !name.to_lowercase().contains(filter))
        {
            return Ok(());
        }
        let components = parents.iter().map(String::as_str).collect::<Vec<_>>();
        let reachable = || -> Result<bool> {
            Ok(file::same_file(
                &directory.dir_metadata()?,
                &directory_at(&self.task.root, &components)?.dir_metadata()?,
            ))
        };
        // Re-resolve the parent from the root on both sides of the read so
        // a relocated or replaced subdirectory cannot supply results.
        if !matches!(reachable(), Ok(true)) {
            self.response.skipped_files += 1;
            return Ok(());
        }
        let snapshot = match file::read_snapshot_metered(directory, name, false, &mut self.bytes) {
            Ok(snapshot) => snapshot,
            Err(_) => {
                self.response.skipped_files += 1;
                return Ok(());
            }
        };
        if !matches!(reachable(), Ok(true)) {
            self.response.skipped_files += 1;
            return Ok(());
        }
        let content = snapshot
            .content
            .strip_prefix('\u{feff}')
            .unwrap_or(&snapshot.content);
        let lines = content
            .split('\n')
            .flat_map(|line| line.strip_suffix('\r').unwrap_or(line).split('\r'));
        let mut matches = Vec::new();
        for (index, line) in lines.enumerate() {
            if self.finished()? {
                break;
            }
            let mut offset = 0;
            let mut previous = 0;
            let mut column = 1;
            while let Some(found) = self.task.query.pattern.find_at(line, offset) {
                if self.finished()? {
                    break;
                }
                let start = found.start();
                let end = found.end();
                if self.task.query.whole_word && !word_boundaries(line, start, end) {
                    offset = start + line[start..].chars().next().map_or(1, char::len_utf8);
                    continue;
                }
                column += line[previous..start].encode_utf16().count();
                previous = start;
                offset = end;
                matches.push(SearchMatch {
                    line: index + 1,
                    column,
                    before: context(&line[..start], true),
                    text: found.as_str().to_owned(),
                    after: context(&line[end..], false),
                });
                self.matches += 1;
            }
        }
        if !matches.is_empty() {
            let mut path = parents.join("/");
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(name);
            self.response.files.push(SearchFile {
                relative_path: path,
                matches,
            });
        }
        Ok(())
    }
}

fn word_boundaries(line: &str, start: usize, end: usize) -> bool {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    !line[..start].chars().next_back().is_some_and(word)
        && !line[end..].chars().next().is_some_and(word)
}

fn context(text: &str, before: bool) -> String {
    const CONTEXT_CHARS: usize = 48;
    if before {
        text.char_indices().rev().nth(CONTEXT_CHARS).map_or_else(
            || text.to_owned(),
            |(index, ch)| format!("…{}", &text[index + ch.len_utf8()..]),
        )
    } else {
        text.char_indices().nth(CONTEXT_CHARS).map_or_else(
            || text.to_owned(),
            |(index, _)| format!("{}…", &text[..index]),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn options(query: &str) -> SearchOptions {
        SearchOptions {
            query: query.into(),
            case_sensitive: false,
            whole_word: false,
            filename_filter: None,
        }
    }

    fn approved() -> (TempDir, Registry, String) {
        let folder = tempfile::tempdir().unwrap();
        let mut registry = Registry::default();
        let id = registry.register("main", folder.path()).unwrap().id;
        (folder, registry, id)
    }

    fn search(registry: &mut Registry, id: &str, query: SearchOptions) -> SearchResponse {
        let job = registry.begin_search("main", id, query).unwrap();
        let task = registry.claim_search("main", id, &job).unwrap();
        let results = task.run().unwrap();
        registry.finish_search("main", id, &job).unwrap();
        results
    }

    #[test]
    fn requires_current_workspace_and_caller_for_begin_run_and_cancel() {
        let (folder, mut registry, id) = approved();
        assert_eq!(
            registry.begin_search("other", &id, options("needle")),
            Err(WorkspaceError::PermissionDenied)
        );
        assert_eq!(
            registry.begin_search("main", "wrong", options("needle")),
            Err(WorkspaceError::PermissionDenied)
        );
        let job = registry
            .begin_search("main", &id, options("needle"))
            .unwrap();
        assert!(matches!(
            registry.claim_search("other", &id, &job),
            Err(WorkspaceError::PermissionDenied)
        ));
        assert_eq!(
            registry.cancel_search("main", "wrong", &job),
            Err(WorkspaceError::PermissionDenied)
        );
        let task = registry.claim_search("main", &id, &job).unwrap();
        registry.register("main", folder.path()).unwrap();
        assert!(matches!(task.run(), Err(WorkspaceError::SearchCancelled)));
        assert_eq!(
            registry.finish_search("main", &id, &job),
            Err(WorkspaceError::SearchCancelled)
        );
        assert_eq!(
            registry.begin_search("main", &id, options("needle")),
            Err(WorkspaceError::PermissionDenied)
        );
    }

    #[test]
    fn rejects_path_syntax_in_filename_filter() {
        let (_, mut registry, id) = approved();
        for name in [
            "..",
            "../file",
            "/tmp/file",
            "C:\\test",
            "foo:stream",
            "./file",
        ] {
            let mut query = options("needle");
            query.filename_filter = Some(name.into());
            assert_eq!(
                registry.begin_search("main", &id, query),
                Err(WorkspaceError::InvalidSearch)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_file_or_directory_symlinks() {
        let (folder, mut registry, id) = approved();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "needle").unwrap();
        std::os::unix::fs::symlink(outside.path(), folder.path().join("other")).unwrap();
        std::os::unix::fs::symlink(secret, folder.path().join("linked.txt")).unwrap();
        assert!(search(&mut registry, &id, options("needle"))
            .files
            .is_empty());
    }

    #[test]
    fn cancellation_revokes_pending_and_running_jobs() {
        let (_, mut registry, id) = approved();
        let pending = registry
            .begin_search("main", &id, options("needle"))
            .unwrap();
        registry.cancel_search("main", &id, &pending).unwrap();
        assert!(matches!(
            registry.claim_search("main", &id, &pending),
            Err(WorkspaceError::SearchCancelled)
        ));

        let running = registry
            .begin_search("main", &id, options("needle"))
            .unwrap();
        let task = registry.claim_search("main", &id, &running).unwrap();
        assert!(matches!(
            registry.claim_search("main", &id, &running),
            Err(WorkspaceError::SearchBusy)
        ));
        registry.cancel_search("main", &id, &running).unwrap();
        assert_eq!(
            registry.begin_search("main", &id, options("needle")),
            Err(WorkspaceError::SearchBusy)
        );
        assert!(matches!(task.run(), Err(WorkspaceError::SearchCancelled)));
        assert_eq!(
            registry.finish_search("main", &id, &running),
            Err(WorkspaceError::SearchCancelled)
        );
        assert!(search(&mut registry, &id, options("needle"))
            .files
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn suppresses_a_result_if_a_parent_handle_has_been_replaced() {
        let (folder, mut registry, id) = approved();
        fs::create_dir(folder.path().join("nested")).unwrap();
        fs::write(folder.path().join("nested/a.txt"), "needle").unwrap();
        let job = registry
            .begin_search("main", &id, options("needle"))
            .unwrap();
        let task = registry.claim_search("main", &id, &job).unwrap();
        let original = directory_at(&task.root, &["nested"]).unwrap();
        fs::rename(folder.path().join("nested"), folder.path().join("old")).unwrap();
        fs::create_dir(folder.path().join("nested")).unwrap();
        let mut scan = Scan {
            task: &task,
            response: SearchResponse::default(),
            entries: 0,
            bytes: 0,
            matches: 0,
            deadline: Instant::now() + Duration::from_secs(1),
        };
        scan.scan_file(&original, &["nested".into()], "a.txt")
            .unwrap();
        assert!(scan.response.files.is_empty());
        assert_eq!(scan.response.skipped_files, 1);
    }

    #[test]
    fn matches_literals_with_unicode_columns_and_applies_options_and_exclusions() {
        let (folder, mut registry, id) = approved();
        for dir in ["src", "node_modules", ".git", "dist"] {
            fs::create_dir(folder.path().join(dir)).unwrap();
            fs::write(
                folder.path().join(dir).join("main.TS"),
                "\u{feff}🙂 Café CAFÉ café2 _café\r\nnext\rcafé cafe .*[",
            )
            .unwrap();
        }
        fs::write(folder.path().join("notes.md"), "café").unwrap();
        fs::write(folder.path().join("binary.ts"), b"caf\0").unwrap();
        let too_large = fs::File::create(folder.path().join("huge.ts")).unwrap();
        too_large.set_len(MAX_TEXT_BYTES + 1).unwrap();
        let query = SearchOptions {
            whole_word: true,
            filename_filter: Some(".ts".into()),
            ..options("café")
        };
        let results = search(&mut registry, &id, query);
        assert_eq!(results.files.len(), 1);
        assert_eq!(results.skipped_files, 2);
        let file = &results.files[0];
        assert_eq!(file.relative_path, "src/main.TS");
        assert_eq!(
            file.matches
                .iter()
                .map(|hit| (hit.line, hit.column, hit.text.as_str()))
                .collect::<Vec<_>>(),
            [(1, 4, "Café"), (1, 9, "CAFÉ"), (3, 1, "café")]
        );
        let case = search(
            &mut registry,
            &id,
            SearchOptions {
                case_sensitive: true,
                whole_word: true,
                ..options("CAFÉ")
            },
        );
        assert_eq!(case.files[0].matches.len(), 1);
        assert_eq!(
            search(&mut registry, &id, options(".*[")).files[0]
                .matches
                .len(),
            1
        );
    }

    #[test]
    fn bounds_results_snippets_and_scan_budget() {
        let (folder, mut registry, id) = approved();
        let line = format!("{}needle{}\n", "x".repeat(100), "x".repeat(100));
        fs::write(folder.path().join("many.txt"), line.repeat(MAX_MATCHES + 1)).unwrap();
        let results = search(&mut registry, &id, options("needle"));
        assert!(results.truncated);
        assert_eq!(results.files[0].matches.len(), MAX_MATCHES);
        assert_eq!(results.files[0].matches[0].before.chars().count(), 49);
        assert_eq!(results.files[0].matches[0].after.chars().count(), 49);

        let job = registry
            .begin_search("main", &id, options("needle"))
            .unwrap();
        let task = registry.claim_search("main", &id, &job).unwrap();
        let mut scan = Scan {
            task: &task,
            response: SearchResponse::default(),
            entries: MAX_ENTRIES,
            bytes: 0,
            matches: 0,
            deadline: Instant::now() + Duration::from_secs(1),
        };
        scan.visit(&mut Vec::new()).unwrap();
        assert!(scan.response.truncated);
        assert!(scan.response.files.is_empty());
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use crate::contract_fixtures as fixture;

    #[test]
    fn search_response_matches_contract() {
        fixture::assert_payload(
            "SearchResponse",
            0,
            &SearchResponse {
                files: vec![SearchFile {
                    relative_path: "src/ünï.rs".into(),
                    matches: vec![SearchMatch {
                        line: 3,
                        column: 5,
                        before: "let ".into(),
                        text: "café".into(),
                        after: " = 1;".into(),
                    }],
                }],
                truncated: false,
                skipped_files: 2,
            },
        );
        fixture::assert_payload(
            "SearchResponse",
            1,
            &SearchResponse {
                files: Vec::new(),
                truncated: true,
                skipped_files: 0,
            },
        );
        fixture::assert_case_count("SearchResponse", 2);
    }
}
