//! Git adapter for Turing Core.
//!
//! Every git invocation uses `Command::new("git")` with a structured argument
//! array. Shell-string interpolation is never used (TDS §10). Frontend-supplied
//! refs and paths are validated before they reach git, and every pathspec is
//! placed after `--` so it can never be parsed as an option.
//!
//! Remote operations (fetch, pull, push) are out of scope for v0.1.

use std::{
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use serde::Serialize;
use tauri::{Manager, WebviewWindow};

use crate::workspace::WorkspaceService;

const MAX_LOG_ENTRIES: u32 = 200;
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
const MAX_COMMIT_MESSAGE_BYTES: usize = 64 * 1024;

// ── Errors ───────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GitError {
    /// The `git` executable is not installed or not on PATH.
    NoGit,
    /// The workspace root is not inside a git repository.
    NotARepository,
    /// No workspace is open, or the caller is not authorised for it.
    WorkspaceNotOpen,
    /// A branch name failed validation.
    InvalidRef,
    /// A file path failed validation.
    InvalidPath,
    /// The commit message is empty or too long.
    InvalidMessage,
    /// Commit requested with nothing staged.
    NothingToCommit,
    /// git has no user.name / user.email configured.
    IdentityMissing,
    /// Checkout blocked by local changes that would be overwritten.
    UncommittedChanges,
    /// git rejected the operation for another reason.
    OperationFailed,
    /// Subprocess or I/O failure.
    IoError,
}

type Result<T> = std::result::Result<T, GitError>;

// ── Domain types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileState {
    Untracked,
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Unmerged,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub staged: bool,
    pub state: FileState,
    pub original_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Current branch, or `None` when HEAD is detached.
    pub branch: Option<String>,
    pub entries: Vec<StatusEntry>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub date: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub text: String,
    /// True when the diff exceeded the size limit and was cut short.
    pub truncated: bool,
}

// ── Validation ───────────────────────────────────────────────────────────────

/// Strict allowlist for branch names. Arguments are passed as an array, but a
/// malformed ref can still be read as an option or a revision expression.
fn validate_git_ref(name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && name.len() <= 255
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && name != "@"
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
    if valid {
        Ok(())
    } else {
        Err(GitError::InvalidRef)
    }
}

/// Workspace-relative paths only: no traversal, no absolute paths, no empty
/// segments. `"."` (the whole workspace) is accepted separately by callers.
fn validate_git_path(path: &str) -> Result<()> {
    let valid = !path.is_empty()
        && path.len() <= 4096
        && !path.contains(['\0', '\\', ':'])
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if valid {
        Ok(())
    } else {
        Err(GitError::InvalidPath)
    }
}

fn validate_pathspec(path: &str) -> Result<()> {
    if path == "." {
        Ok(())
    } else {
        validate_git_path(path)
    }
}

// ── Subprocess ───────────────────────────────────────────────────────────────

fn run_git(root: &Path, args: &[&str]) -> Result<Output> {
    Command::new("git")
        .arg("-C")
        .arg(root)
        // Never colourise, never quote non-ASCII paths, never take optional locks
        // that would contend with the user's own git commands.
        .args(["-c", "color.ui=never", "-c", "core.quotepath=false"])
        .arg("--no-optional-locks")
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => GitError::NoGit,
            _ => GitError::IoError,
        })
}

fn run_ok(root: &Path, args: &[&str]) -> Result<Output> {
    let output = run_git(root, args)?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(GitError::OperationFailed)
    }
}

fn ensure_repo(root: &Path) -> Result<()> {
    let output = run_git(root, &["rev-parse", "--is-inside-work-tree"])?;
    if output.status.success() && output.stdout.starts_with(b"true") {
        Ok(())
    } else {
        Err(GitError::NotARepository)
    }
}

// ── Authorisation ────────────────────────────────────────────────────────────

/// Authorises the caller, then runs `operation` on a blocking thread with the
/// workspace root. The registry lock is released before git starts, so file
/// operations are never blocked behind a slow git command.
async fn in_repository<T, F>(window: WebviewWindow, workspace_id: String, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Path) -> Result<T> + Send + 'static,
{
    if window.label() != "main" {
        return Err(GitError::WorkspaceNotOpen);
    }
    let root: PathBuf = {
        let service = window.state::<WorkspaceService>();
        let registry = service.registry().map_err(|_| GitError::IoError)?;
        registry
            .workspace_path(window.label(), &workspace_id)
            .map_err(|_| GitError::WorkspaceNotOpen)?
            .to_path_buf()
    };
    tauri::async_runtime::spawn_blocking(move || {
        ensure_repo(&root)?;
        operation(&root)
    })
    .await
    .map_err(|_| GitError::IoError)?
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/// Parses `git status --porcelain=v1 -z` output.
///
/// Records are NUL-terminated `XY<space>path`. For renames and copies the
/// record is followed by one more NUL-terminated field: the original path.
/// A file changed in both index and work tree produces two entries (one staged,
/// one unstaged) so the panel can show it in both groups.
fn parse_status(raw: &[u8]) -> Vec<StatusEntry> {
    let mut entries = Vec::new();
    let mut fields = raw.split(|&byte| byte == 0).filter(|f| !f.is_empty());
    while let Some(field) = fields.next() {
        if field.len() < 4 || field[2] != b' ' {
            continue;
        }
        let (x, y) = (field[0], field[1]);
        let path = String::from_utf8_lossy(&field[3..]).into_owned();
        let original_path = if matches!(x, b'R' | b'C') {
            fields
                .next()
                .map(|orig| String::from_utf8_lossy(orig).into_owned())
        } else {
            None
        };

        let conflicted = matches!((x, y), (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D'));
        if conflicted {
            entries.push(StatusEntry {
                path,
                staged: false,
                state: FileState::Unmerged,
                original_path: None,
            });
            continue;
        }
        if (x, y) == (b'?', b'?') {
            entries.push(StatusEntry {
                path,
                staged: false,
                state: FileState::Untracked,
                original_path: None,
            });
            continue;
        }
        if let Some(state) = state_for(x) {
            entries.push(StatusEntry {
                path: path.clone(),
                staged: true,
                state,
                original_path: original_path.clone(),
            });
        }
        if let Some(state) = state_for(y) {
            entries.push(StatusEntry {
                path,
                staged: false,
                state,
                original_path: None,
            });
        }
    }
    entries
}

fn state_for(code: u8) -> Option<FileState> {
    match code {
        b'M' | b'T' => Some(FileState::Modified),
        b'A' => Some(FileState::Added),
        b'D' => Some(FileState::Deleted),
        b'R' => Some(FileState::Renamed),
        b'C' => Some(FileState::Copied),
        _ => None,
    }
}

/// Parses `git rev-list --count --left-right HEAD...@{u}` (`ahead\tbehind`).
fn parse_ahead_behind(output: &str) -> (u32, u32) {
    let mut parts = output.split_whitespace();
    let ahead = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
    (ahead, behind)
}

fn parse_branches(output: &str) -> Vec<BranchInfo> {
    output
        .lines()
        .filter_map(|line| {
            let (head, rest) = line.split_once('\x1f')?;
            let (kind, name) = rest.split_once('\x1f')?;
            // Skip symbolic refs such as `origin/HEAD`.
            if name.is_empty() || name.ends_with("/HEAD") {
                return None;
            }
            Some(BranchInfo {
                name: name.to_owned(),
                is_head: head == "*",
                is_remote: kind.starts_with("refs/remotes/"),
            })
        })
        .collect()
}

fn parse_log(output: &str) -> Vec<LogEntry> {
    output
        .split('\x1e')
        .filter_map(|record| {
            let record = record.trim_start_matches('\n');
            if record.is_empty() {
                return None;
            }
            let mut parts = record.splitn(6, '\x1f');
            Some(LogEntry {
                hash: parts.next()?.to_owned(),
                short_hash: parts.next()?.to_owned(),
                subject: parts.next()?.to_owned(),
                author_name: parts.next()?.to_owned(),
                author_email: parts.next()?.to_owned(),
                date: parts.next()?.trim_end().to_owned(),
            })
        })
        .collect()
}

// ── Operations (testable without Tauri) ──────────────────────────────────────

fn status_at(root: &Path) -> Result<GitStatus> {
    let branch = run_git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let branch = branch
        .status
        .success()
        .then(|| String::from_utf8_lossy(&branch.stdout).trim().to_owned())
        .filter(|name| !name.is_empty());

    let status = run_ok(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let entries = parse_status(&status.stdout);

    let (ahead, behind) = run_git(
        root,
        &["rev-list", "--count", "--left-right", "HEAD...@{u}"],
    )
    .ok()
    .filter(|output| output.status.success())
    .map(|output| parse_ahead_behind(&String::from_utf8_lossy(&output.stdout)))
    .unwrap_or((0, 0));

    Ok(GitStatus {
        branch,
        entries,
        ahead,
        behind,
    })
}

fn diff_at(root: &Path, relative_path: &str, staged: bool) -> Result<GitDiff> {
    validate_git_path(relative_path)?;
    let mut args = vec!["diff", "--no-ext-diff"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", relative_path]);
    let output = run_ok(root, &args)?;
    let truncated = output.stdout.len() > MAX_DIFF_BYTES;
    let bytes = &output.stdout[..output.stdout.len().min(MAX_DIFF_BYTES)];
    Ok(GitDiff {
        text: String::from_utf8_lossy(bytes).into_owned(),
        truncated,
    })
}

fn stage_at(root: &Path, relative_path: &str) -> Result<()> {
    validate_pathspec(relative_path)?;
    run_ok(root, &["add", "--all", "--", relative_path]).map(drop)
}

fn unstage_at(root: &Path, relative_path: &str) -> Result<()> {
    validate_pathspec(relative_path)?;
    // `restore --staged` needs HEAD; in a repo with no commits yet, fall back
    // to removing the path from the index while keeping the work-tree file.
    let has_head = run_git(root, &["rev-parse", "--verify", "--quiet", "HEAD"])?
        .status
        .success();
    if has_head {
        run_ok(root, &["restore", "--staged", "--", relative_path]).map(drop)
    } else {
        run_ok(
            root,
            &["rm", "--cached", "-r", "--quiet", "--", relative_path],
        )
        .map(drop)
    }
}

fn commit_at(root: &Path, message: &str) -> Result<String> {
    if message.trim().is_empty()
        || message.len() > MAX_COMMIT_MESSAGE_BYTES
        || message.contains('\0')
    {
        return Err(GitError::InvalidMessage);
    }
    let staged = run_git(root, &["diff", "--cached", "--quiet"])?;
    if staged.status.success() {
        return Err(GitError::NothingToCommit);
    }
    // The message travels as its own argument and is never interpreted by a shell.
    let output = run_git(root, &["commit", "--quiet", "-m", message])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(
            if stderr.contains("Please tell me who you are") || stderr.contains("empty ident") {
                GitError::IdentityMissing
            } else {
                GitError::OperationFailed
            },
        );
    }
    let hash = run_ok(root, &["rev-parse", "--short", "HEAD"])?;
    Ok(String::from_utf8_lossy(&hash.stdout).trim().to_owned())
}

fn branches_at(root: &Path) -> Result<Vec<BranchInfo>> {
    let output = run_ok(
        root,
        &[
            "for-each-ref",
            "--format=%(HEAD)\x1f%(refname)\x1f%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    Ok(parse_branches(&String::from_utf8_lossy(&output.stdout)))
}

fn checkout_at(root: &Path, branch_name: &str, create: bool) -> Result<()> {
    validate_git_ref(branch_name)?;
    let args: [&str; 3] = if create {
        ["switch", "-c", branch_name]
    } else {
        ["switch", "--no-guess", branch_name]
    };
    let output = run_git(root, &args)?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(
        if stderr.contains("would be overwritten") || stderr.contains("commit your changes") {
            GitError::UncommittedChanges
        } else if stderr.contains("invalid reference") || stderr.contains("not a valid branch name")
        {
            GitError::InvalidRef
        } else {
            GitError::OperationFailed
        },
    )
}

fn log_at(root: &Path, limit: u32) -> Result<Vec<LogEntry>> {
    let count = format!("--max-count={}", limit.clamp(1, MAX_LOG_ENTRIES));
    let output = run_git(
        root,
        &[
            "log",
            &count,
            "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%ar%x1e",
        ],
    )?;
    // A repository without commits has no log; that is not an error.
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(parse_log(&String::from_utf8_lossy(&output.stdout)))
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_status(window: WebviewWindow, workspace_id: String) -> Result<GitStatus> {
    in_repository(window, workspace_id, status_at).await
}

#[tauri::command]
pub async fn git_diff(
    window: WebviewWindow,
    workspace_id: String,
    relative_path: String,
    staged: bool,
) -> Result<GitDiff> {
    in_repository(window, workspace_id, move |root| {
        diff_at(root, &relative_path, staged)
    })
    .await
}

#[tauri::command]
pub async fn git_stage(
    window: WebviewWindow,
    workspace_id: String,
    relative_path: String,
) -> Result<()> {
    in_repository(window, workspace_id, move |root| {
        stage_at(root, &relative_path)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(
    window: WebviewWindow,
    workspace_id: String,
    relative_path: String,
) -> Result<()> {
    in_repository(window, workspace_id, move |root| {
        unstage_at(root, &relative_path)
    })
    .await
}

#[tauri::command]
pub async fn git_commit(
    window: WebviewWindow,
    workspace_id: String,
    message: String,
) -> Result<String> {
    in_repository(window, workspace_id, move |root| commit_at(root, &message)).await
}

#[tauri::command]
pub async fn git_branches(window: WebviewWindow, workspace_id: String) -> Result<Vec<BranchInfo>> {
    in_repository(window, workspace_id, branches_at).await
}

#[tauri::command]
pub async fn git_checkout(
    window: WebviewWindow,
    workspace_id: String,
    branch_name: String,
    create: bool,
) -> Result<()> {
    in_repository(window, workspace_id, move |root| {
        checkout_at(root, &branch_name, create)
    })
    .await
}

#[tauri::command]
pub async fn git_log(
    window: WebviewWindow,
    workspace_id: String,
    limit: u32,
) -> Result<Vec<LogEntry>> {
    in_repository(window, workspace_id, move |root| log_at(root, limit)).await
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn git(root: &Path, args: &[&str]) {
        let output = run_git(root, args).expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repository() -> TempDir {
        let folder = tempfile::tempdir().unwrap();
        let root = folder.path();
        git(root, &["init", "--quiet", "--initial-branch=main"]);
        git(root, &["config", "user.name", "Turing Test"]);
        git(root, &["config", "user.email", "test@turing.invalid"]);
        git(root, &["config", "commit.gpgsign", "false"]);
        folder
    }

    #[test]
    fn accepts_ordinary_branch_names() {
        for name in [
            "main",
            "feature/git-panel",
            "release-0.1",
            "fix_typo",
            "v1.0.0",
        ] {
            assert_eq!(validate_git_ref(name), Ok(()), "{name}");
        }
    }

    #[test]
    fn rejects_option_like_and_revision_expressions() {
        for name in [
            "", "-b", "--force", "a..b", "a b", "x.lock", "//x", "x/", "/x", ".x", "@", "HEAD@{1}",
            "HEAD~1", "main^", "a:b", "a\0b", "naïve",
        ] {
            assert_eq!(
                validate_git_ref(name),
                Err(GitError::InvalidRef),
                "{name:?}"
            );
        }
    }

    #[test]
    fn rejects_paths_outside_the_workspace() {
        for path in [
            "",
            "../x",
            "a/../b",
            "a//b",
            "/etc/passwd",
            "./a",
            "C:/x",
            r"a\b",
            "a\0b",
        ] {
            assert_eq!(
                validate_git_path(path),
                Err(GitError::InvalidPath),
                "{path:?}"
            );
        }
        assert_eq!(validate_pathspec("."), Ok(()));
        assert_eq!(validate_git_path("src/main.rs"), Ok(()));
    }

    #[test]
    fn parses_porcelain_records_including_renames_and_split_changes() {
        let raw = b"?? new file.txt\0 M src/lib.rs\0MM both.rs\0R  renamed.rs\0original.rs\0UU conflict.rs\0";
        let entries = parse_status(raw);
        assert_eq!(
            entries,
            vec![
                StatusEntry {
                    path: "new file.txt".into(),
                    staged: false,
                    state: FileState::Untracked,
                    original_path: None
                },
                StatusEntry {
                    path: "src/lib.rs".into(),
                    staged: false,
                    state: FileState::Modified,
                    original_path: None
                },
                StatusEntry {
                    path: "both.rs".into(),
                    staged: true,
                    state: FileState::Modified,
                    original_path: None
                },
                StatusEntry {
                    path: "both.rs".into(),
                    staged: false,
                    state: FileState::Modified,
                    original_path: None
                },
                StatusEntry {
                    path: "renamed.rs".into(),
                    staged: true,
                    state: FileState::Renamed,
                    original_path: Some("original.rs".into())
                },
                StatusEntry {
                    path: "conflict.rs".into(),
                    staged: false,
                    state: FileState::Unmerged,
                    original_path: None
                },
            ]
        );
    }

    #[test]
    fn parses_ahead_behind_counts() {
        assert_eq!(parse_ahead_behind("3\t1\n"), (3, 1));
        assert_eq!(parse_ahead_behind(""), (0, 0));
    }

    #[test]
    fn reports_a_plain_folder_as_not_a_repository() {
        let folder = tempfile::tempdir().unwrap();
        assert_eq!(ensure_repo(folder.path()), Err(GitError::NotARepository));
    }

    #[test]
    fn stages_commits_and_logs_in_a_fresh_repository() {
        let folder = repository();
        let root = folder.path();
        fs::write(root.join("notes.txt"), "hello\n").unwrap();

        let status = status_at(root).unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.entries[0].state, FileState::Untracked);
        assert!(log_at(root, 10).unwrap().is_empty());
        assert_eq!(commit_at(root, "empty"), Err(GitError::NothingToCommit));

        stage_at(root, "notes.txt").unwrap();
        assert!(status_at(root).unwrap().entries[0].staged);
        unstage_at(root, "notes.txt").unwrap();
        assert!(!status_at(root).unwrap().entries[0].staged);

        stage_at(root, ".").unwrap();
        let hash = commit_at(root, "Add notes; $(touch pwned) `whoami`").unwrap();
        assert!(!hash.is_empty());
        assert!(!root.join("pwned").exists());

        let log = log_at(root, 10).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "Add notes; $(touch pwned) `whoami`");
        assert!(status_at(root).unwrap().entries.is_empty());
    }

    #[test]
    fn diffs_switches_and_lists_branches() {
        let folder = repository();
        let root = folder.path();
        fs::write(root.join("a.txt"), "one\n").unwrap();
        stage_at(root, ".").unwrap();
        commit_at(root, "init").unwrap();

        fs::write(root.join("a.txt"), "two\n").unwrap();
        let diff = diff_at(root, "a.txt", false).unwrap();
        assert!(diff.text.contains("+two"));
        assert!(diff_at(root, "a.txt", true).unwrap().text.is_empty());

        checkout_at(root, "feature/x", true).unwrap();
        let branches = branches_at(root).unwrap();
        assert!(branches.iter().any(|b| b.name == "feature/x" && b.is_head));
        assert!(branches.iter().any(|b| b.name == "main" && !b.is_head));

        assert_eq!(
            checkout_at(root, "--orphan", false),
            Err(GitError::InvalidRef)
        );
        assert_eq!(
            checkout_at(root, "missing", false),
            Err(GitError::InvalidRef)
        );
        checkout_at(root, "main", false).unwrap();
        assert_eq!(status_at(root).unwrap().branch.as_deref(), Some("main"));
    }

    #[test]
    fn refuses_a_switch_that_would_overwrite_local_changes() {
        let folder = repository();
        let root = folder.path();
        fs::write(root.join("a.txt"), "one\n").unwrap();
        stage_at(root, ".").unwrap();
        commit_at(root, "init").unwrap();
        checkout_at(root, "other", true).unwrap();
        fs::write(root.join("a.txt"), "other\n").unwrap();
        stage_at(root, ".").unwrap();
        commit_at(root, "diverge").unwrap();
        fs::write(root.join("a.txt"), "dirty\n").unwrap();
        assert_eq!(
            checkout_at(root, "main", false),
            Err(GitError::UncommittedChanges)
        );
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "dirty\n");
    }
}
