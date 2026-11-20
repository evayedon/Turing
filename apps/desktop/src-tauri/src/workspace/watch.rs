//! Native change notifications for the active approved workspace.
//!
//! The OS watcher only produces hints: workspace-relative paths that may have
//! changed, or a single `rescan` signal when individual paths cannot be
//! trusted. Hints never carry file contents or grant access; the frontend
//! re-lists and re-reads through the ordinary authorized commands. Each
//! watcher belongs to one registration, so dropping the registration (close,
//! replace, reload, window destruction) closes its inbox and later OS
//! callbacks are discarded.

use super::{is_workspace_link, relative_parts, valid_component, Result, WorkspaceError};
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    io,
    path::{Component, Path},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

/// More distinct pending paths than this collapse into one rescan signal.
pub(crate) const MAX_PENDING_PATHS: usize = 256;
/// A burst is delivered once no event has arrived for this long…
pub(crate) const QUIET_PERIOD: Duration = Duration::from_millis(150);
/// …or once its first event is this old, so a continuous stream still flows.
pub(crate) const MAX_DELAY: Duration = Duration::from_secs(1);

const STAGING_PREFIX: &str = ".turing-save-";

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChanges {
    /// Sorted workspace-relative paths. A path stands for itself and
    /// everything below it; no path is listed together with an ancestor.
    pub(crate) paths: Vec<String>,
    /// Individual paths were lost: every loaded view must be revalidated.
    pub(crate) rescan: bool,
}

/// Pending changes accumulated between polls.
#[derive(Debug, Default)]
pub(crate) struct Coalescer {
    paths: BTreeSet<String>,
    rescan: bool,
    first: Option<Instant>,
    last: Option<Instant>,
}

impl Coalescer {
    fn touch(&mut self, now: Instant) {
        self.first.get_or_insert(now);
        self.last = Some(now);
    }

    pub(crate) fn path(&mut self, path: String, now: Instant) {
        if path.is_empty() {
            // The root itself changed; nothing narrower is meaningful.
            return self.rescan(now);
        }
        self.touch(now);
        if self.rescan
            || path
                .match_indices('/')
                .any(|(index, _)| self.paths.contains(&path[..index]))
            || self.paths.contains(&path)
        {
            return;
        }
        // '0' follows '/' in byte order, so this range holds exactly the
        // descendants of `path`.
        let descendants: Vec<_> = self
            .paths
            .range(format!("{path}/")..format!("{path}0"))
            .cloned()
            .collect();
        for descendant in descendants {
            self.paths.remove(&descendant);
        }
        self.paths.insert(path);
        if self.paths.len() > MAX_PENDING_PATHS {
            self.rescan(now);
        }
    }

    pub(crate) fn rescan(&mut self, now: Instant) {
        self.touch(now);
        self.rescan = true;
        self.paths.clear();
    }

    /// Returns the burst once it is quiet or old enough, otherwise nothing.
    pub(crate) fn take(&mut self, now: Instant) -> WorkspaceChanges {
        let (Some(first), Some(last)) = (self.first, self.last) else {
            return WorkspaceChanges::default();
        };
        if now.saturating_duration_since(last) < QUIET_PERIOD
            && now.saturating_duration_since(first) < MAX_DELAY
        {
            return WorkspaceChanges::default();
        }
        let taken = std::mem::take(self);
        WorkspaceChanges {
            paths: taken.paths.into_iter().collect(),
            rescan: taken.rescan,
        }
    }
}

/// Converts an absolute OS event path under `root` into a slash-separated
/// workspace-relative path. Paths outside the root, with non-normal or
/// unrepresentable components, or inside Turing save staging are dropped.
pub(crate) fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.strip_prefix(root).ok()?.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        let part = part.to_str()?;
        if !valid_component(part) || part.starts_with(STAGING_PREFIX) {
            return None;
        }
        parts.push(part);
    }
    Some(parts.join("/"))
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Signal<'a> {
    Ignore,
    Rescan,
    Paths(&'a [std::path::PathBuf]),
}

pub(crate) fn classify(event: &notify::Result<Event>) -> Signal<'_> {
    match event {
        // Watcher errors (queue overflow, lost watches) can hide changes.
        Err(_) => Signal::Rescan,
        Ok(event) if event.need_rescan() => Signal::Rescan,
        // Reads and opens do not change what the views show.
        Ok(Event {
            kind: EventKind::Access(_),
            ..
        }) => Signal::Ignore,
        Ok(event) if event.paths.is_empty() => Signal::Rescan,
        Ok(event) => Signal::Paths(&event.paths),
    }
}

#[derive(Debug, Default)]
pub(crate) struct Inbox {
    pending: Coalescer,
    symbols: Coalescer,
    closed: bool,
}

#[cfg(test)]
impl Inbox {
    pub(crate) fn is_closed(&self) -> bool {
        self.closed
    }
}

fn lock(inbox: &Mutex<Inbox>) -> MutexGuard<'_, Inbox> {
    // The inbox holds only plain data, so a poisoned lock is still usable.
    inbox
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Records one OS callback. A closed inbox belongs to a revoked registration
/// and drops everything.
pub(crate) fn deliver(inbox: &Mutex<Inbox>, root: &Path, event: notify::Result<Event>) {
    let mut inbox = lock(inbox);
    if inbox.closed {
        return;
    }
    let now = Instant::now();
    match classify(&event) {
        Signal::Ignore => {}
        Signal::Rescan => {
            inbox.pending.rescan(now);
            inbox.symbols.rescan(now);
        }
        Signal::Paths(paths) => {
            for path in paths {
                if let Some(relative) = relative_path(root, path) {
                    if !relative.split('/').any(super::search::ignored_directory) {
                        inbox.symbols.path(relative.clone(), now);
                    }
                    inbox.pending.path(relative, now);
                }
            }
        }
    }
}

/// A recursive OS watcher bound to one registration's canonical root.
pub(crate) struct Watch {
    inbox: Arc<Mutex<Inbox>>,
    _watcher: RecommendedWatcher,
}

impl Watch {
    pub(crate) fn start(root: &Path) -> Result<Self> {
        let inbox = Arc::new(Mutex::new(Inbox::default()));
        let sink = Arc::clone(&inbox);
        let base = root.to_path_buf();
        let mut watcher = RecommendedWatcher::new(
            move |event| deliver(&sink, &base, event),
            Config::default().with_follow_symlinks(false),
        )
        .map_err(|_| WorkspaceError::IoError)?;
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|_| WorkspaceError::IoError)?;
        Ok(Self {
            inbox,
            _watcher: watcher,
        })
    }

    pub(crate) fn take(&self, now: Instant) -> WorkspaceChanges {
        lock(&self.inbox).pending.take(now)
    }

    pub(super) fn symbol_hints(&self) -> SymbolHints {
        SymbolHints(Arc::clone(&self.inbox))
    }

    #[cfg(test)]
    pub(crate) fn inbox(&self) -> Arc<Mutex<Inbox>> {
        Arc::clone(&self.inbox)
    }
}

/// Independent consumer so Explorer polling cannot drain the index's hints.
pub(super) struct SymbolHints(Arc<Mutex<Inbox>>);

impl SymbolHints {
    #[cfg(test)]
    pub(super) fn test_inbox() -> (Self, Arc<Mutex<Inbox>>) {
        let inbox = Arc::new(Mutex::new(Inbox::default()));
        (Self(Arc::clone(&inbox)), inbox)
    }

    pub(super) fn take(&self, now: Instant) -> WorkspaceChanges {
        let mut inbox = lock(&self.0);
        inbox.symbols.take(now)
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        // Close before the OS watcher stops so in-flight callbacks are dropped.
        lock(&self.inbox).closed = true;
    }
}

/// Keeps a path only if no existing ancestor under the approved handle is a
/// link or reparse point. Missing ancestors are kept: the path was removed
/// and views must forget it.
pub(crate) fn reachable(root: &Dir, path: &str) -> bool {
    let Ok(parts) = relative_parts(path) else {
        return false;
    };
    let Some((_, ancestors)) = parts.split_last() else {
        return true;
    };
    let Ok(mut directory) = root.try_clone() else {
        return false;
    };
    for part in ancestors {
        let metadata = match directory.symlink_metadata(part) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        };
        if is_workspace_link(&metadata) {
            return false;
        }
        if !metadata.is_dir() {
            return true;
        }
        directory = match directory.open_dir_nofollow(part) {
            Ok(child) => child,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        };
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, Flag, ModifyKind, RenameMode};
    use std::path::PathBuf;

    fn contains(ancestor: &str, path: &str) -> bool {
        path.strip_prefix(ancestor)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    }

    fn later(start: Instant, millis: u64) -> Instant {
        start + Duration::from_millis(millis)
    }

    fn paths(changes: &WorkspaceChanges) -> Vec<&str> {
        changes.paths.iter().map(String::as_str).collect()
    }

    #[test]
    fn bursts_wait_for_a_quiet_period_and_deliver_once() {
        let start = Instant::now();
        let mut pending = Coalescer::default();
        assert_eq!(pending.take(start), WorkspaceChanges::default());
        pending.path("src/a.rs".into(), start);
        pending.path("src/a.rs".into(), later(start, 50));
        pending.path("README.md".into(), later(start, 100));
        assert_eq!(pending.take(later(start, 200)), WorkspaceChanges::default());
        let changes = pending.take(later(start, 260));
        assert_eq!(paths(&changes), ["README.md", "src/a.rs"]);
        assert!(!changes.rescan);
        assert_eq!(
            pending.take(later(start, 5_000)),
            WorkspaceChanges::default()
        );
    }

    #[test]
    fn a_continuous_stream_is_still_delivered_after_the_maximum_delay() {
        let start = Instant::now();
        let mut pending = Coalescer::default();
        for step in 0..=10 {
            pending.path(format!("file-{step}"), later(start, step * 100));
        }
        assert_eq!(pending.take(later(start, 999)), WorkspaceChanges::default());
        assert_eq!(pending.take(later(start, 1_000)).paths.len(), 11);
    }

    #[test]
    fn ancestors_subsume_descendants_in_either_order() {
        let start = Instant::now();
        let mut pending = Coalescer::default();
        pending.path("src/deep/a.rs".into(), start);
        pending.path("src/deep/b.rs".into(), start);
        pending.path("src-other/x".into(), start);
        pending.path("src".into(), start);
        pending.path("src/deep/c.rs".into(), start);
        let changes = pending.take(later(start, 1_000));
        assert_eq!(paths(&changes), ["src", "src-other/x"]);
        assert!(contains("src", "src/a") && !contains("src", "src-other"));
    }

    #[test]
    fn overflow_and_root_changes_collapse_into_one_rescan() {
        let start = Instant::now();
        let mut pending = Coalescer::default();
        for index in 0..=MAX_PENDING_PATHS {
            pending.path(format!("generated/{index}.o"), start);
        }
        let changes = pending.take(later(start, 1_000));
        assert_eq!(
            changes,
            WorkspaceChanges {
                paths: vec![],
                rescan: true
            }
        );

        pending.path("a".into(), start);
        pending.path(String::new(), start);
        pending.path("b".into(), start);
        let changes = pending.take(later(start, 1_000));
        assert!(changes.rescan && changes.paths.is_empty());
    }

    #[test]
    fn event_paths_must_be_normal_components_under_the_root() {
        let root = Path::new("/approved/root");
        let cases: [(&str, Option<&str>); 9] = [
            ("/approved/root", Some("")),
            ("/approved/root/src/main.rs", Some("src/main.rs")),
            ("/approved/root/docs/ünï.md", Some("docs/ünï.md")),
            ("/approved/rooted/file", None),
            ("/approved/other/file", None),
            ("/elsewhere/root/file", None),
            ("relative/file", None),
            ("/approved/root/.turing-save-1.tmp", None),
            ("/approved/root/src/.turing-save-2.rename/old", None),
        ];
        for (path, expected) in cases {
            assert_eq!(
                relative_path(root, Path::new(path)).as_deref(),
                expected,
                "{path}"
            );
        }
    }

    #[test]
    fn errors_overflow_and_pathless_events_request_a_rescan() {
        let error: notify::Result<Event> = Err(notify::Error::generic("queue overflow"));
        assert_eq!(classify(&error), Signal::Rescan);
        let overflow = Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan));
        assert_eq!(classify(&overflow), Signal::Rescan);
        assert_eq!(
            classify(&Ok(Event::new(EventKind::Any))),
            Signal::Rescan,
            "an event without paths cannot be narrowed"
        );
        let read = Ok(Event::new(EventKind::Access(AccessKind::Any)).add_path("/r/a".into()));
        assert_eq!(classify(&read), Signal::Ignore);
        let created =
            Ok(Event::new(EventKind::Create(CreateKind::File)).add_path(PathBuf::from("/r/a")));
        assert_eq!(classify(&created), Signal::Paths(&[PathBuf::from("/r/a")]));
    }

    #[test]
    fn renames_report_both_sides_and_drop_outside_or_staging_paths() {
        let inbox = Mutex::new(Inbox::default());
        let root = Path::new("/r");
        let rename = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path("/r/old.txt".into())
            .add_path("/r/new.txt".into());
        deliver(&inbox, root, Ok(rename));
        let staged = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path("/r/.turing-save-1.tmp".into())
            .add_path("/outside/secret".into());
        deliver(&inbox, root, Ok(staged));
        let changes = lock(&inbox)
            .pending
            .take(Instant::now() + Duration::from_secs(2));
        assert_eq!(paths(&changes), ["new.txt", "old.txt"]);
    }

    #[test]
    fn a_closed_inbox_never_accumulates_late_callbacks() {
        let inbox = Mutex::new(Inbox::default());
        lock(&inbox).closed = true;
        let late = Event::new(EventKind::Create(CreateKind::File)).add_path("/r/a".into());
        deliver(&inbox, Path::new("/r"), Ok(late));
        deliver(&inbox, Path::new("/r"), Err(notify::Error::generic("x")));
        let changes = lock(&inbox)
            .pending
            .take(Instant::now() + Duration::from_secs(2));
        assert_eq!(changes, WorkspaceChanges::default());
    }

    #[test]
    fn dropping_a_watch_closes_its_inbox() {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path().canonicalize().unwrap();
        let watch = Watch::start(&root).unwrap();
        let inbox = watch.inbox();
        drop(watch);
        assert!(lock(&inbox).closed);
        let late = Event::new(EventKind::Create(CreateKind::File)).add_path(root.join("late"));
        deliver(&inbox, &root, Ok(late));
        let changes = lock(&inbox)
            .pending
            .take(Instant::now() + Duration::from_secs(2));
        assert_eq!(changes, WorkspaceChanges::default());
    }

    #[cfg(unix)]
    #[test]
    fn paths_below_a_link_are_not_reachable() {
        let folder = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(folder.path().join("src")).unwrap();
        std::os::unix::fs::symlink(outside.path(), folder.path().join("link")).unwrap();
        let root = Dir::open_ambient_dir(folder.path(), cap_std::ambient_authority()).unwrap();
        assert!(reachable(&root, "src/main.rs"));
        assert!(reachable(&root, "link"), "the link entry itself may change");
        assert!(!reachable(&root, "link/secret.txt"));
        assert!(reachable(&root, "removed/child.txt"));
        assert!(!reachable(&root, "../escape"));
    }
}
