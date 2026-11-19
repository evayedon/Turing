mod process;

use crate::windows::workbench;
use crate::workspace::{Registry, WorkspaceError};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering::Relaxed},
        Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::Instant,
};
use tauri::{ipc::Channel, WebviewWindow};

const OUTPUT_LIMIT: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExecutionError {
    PermissionDenied,
    Busy,
    UnsupportedLanguage,
    SourceChanged,
    SourceUnavailable,
    PythonUnavailable,
    CompilerUnavailable,
    ProcessUnavailable,
    TimedOut,
    Internal,
}

type Result<T> = std::result::Result<T, ExecutionError>;

impl From<WorkspaceError> for ExecutionError {
    fn from(error: WorkspaceError) -> Self {
        match error {
            WorkspaceError::PermissionDenied | WorkspaceError::OutsideWorkspace => {
                Self::PermissionDenied
            }
            WorkspaceError::FileConflict | WorkspaceError::SaveRace => Self::SourceChanged,
            _ => Self::SourceUnavailable,
        }
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Source {
    Workspace {
        workspace_id: String,
        relative_path: String,
        version: String,
    },
    Selected {
        file_id: String,
        version: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Python,
    Cpp,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Preparing,
    Compiling,
    Running,
    Stopping,
    Completed,
    Failed,
}

impl Phase {
    fn finished(self) -> bool {
        matches!(self, Self::Completed | Self::Failed)
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stream {
    BuildStdout,
    BuildStderr,
    Stdout,
    Stderr,
}

#[derive(Serialize)]
pub struct Chunk {
    stream: Stream,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    phase: Phase,
    elapsed_ms: u64,
    exit_code: Option<i32>,
    error: Option<ExecutionError>,
    cancelled: bool,
    truncated: bool,
    output: Vec<Chunk>,
}

#[derive(Serialize)]
pub struct Started {
    id: String,
    name: String,
    language: Language,
}

struct Snapshot {
    name: String,
    language: Language,
    content: String,
    cwd: Dir,
}

impl Snapshot {
    fn read(registry: &Registry, owner: &str, source: Source) -> Result<Self> {
        let (name, expected, content, version, cwd) = match source {
            Source::Workspace {
                workspace_id,
                relative_path,
                version,
            } => {
                let (content, actual, cwd) =
                    registry.execution_snapshot(owner, &workspace_id, &relative_path)?;
                let name = relative_path
                    .rsplit('/')
                    .next()
                    .ok_or(ExecutionError::SourceUnavailable)?
                    .to_owned();
                (name, version, content, actual, cwd)
            }
            Source::Selected { file_id, version } => {
                let (name, content, actual, cwd) =
                    registry.selected_execution_snapshot(owner, &file_id)?;
                (name, version, content, actual, cwd)
            }
        };
        if version != expected {
            return Err(ExecutionError::SourceChanged);
        }
        let language = match Path::new(&name)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("py") => Language::Python,
            Some("cpp" | "cc" | "cxx") => Language::Cpp,
            _ => return Err(ExecutionError::UnsupportedLanguage),
        };
        Ok(Self {
            name,
            language,
            content,
            cwd,
        })
    }
}

struct State {
    phase: Phase,
    phase_before_exit: Phase,
    output: VecDeque<Chunk>,
    remaining: usize,
    truncated: bool,
    exit_code: Option<i32>,
    error: Option<ExecutionError>,
    ended: Option<Instant>,
}

struct Progress {
    state: Mutex<State>,
    stopped: AtomicBool,
    started: Instant,
    events: Mutex<Option<Channel<Phase>>>,
}

impl Progress {
    fn new(events: Option<Channel<Phase>>) -> Self {
        Self {
            state: Mutex::new(State {
                phase: Phase::Preparing,
                phase_before_exit: Phase::Preparing,
                output: VecDeque::new(),
                remaining: OUTPUT_LIMIT,
                truncated: false,
                exit_code: None,
                error: None,
                ended: None,
            }),
            stopped: AtomicBool::new(false),
            started: Instant::now(),
            events: Mutex::new(events),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn notify(&self, phase: Phase) {
        if let Ok(mut events) = self.events.lock() {
            if let Some(channel) = events.as_ref() {
                let _ = channel.send(phase);
            }
            if phase.finished() {
                events.take();
            }
        }
    }

    fn stage(&self, phase: Phase) {
        let mut state = self.state();
        if self.stopped.load(Relaxed) {
            return;
        }
        state.phase = phase;
        drop(state);
        self.notify(phase);
    }

    fn stop(&self) {
        let mut state = self.state();
        if state.phase.finished() {
            return;
        }
        self.stopped.store(true, Relaxed);
        state.phase = Phase::Stopping;
        drop(state);
        self.notify(Phase::Stopping);
    }

    fn record(&self, stream: Stream, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut state = self.state();
        let retained = bytes.len().min(state.remaining);
        state.truncated |= retained < bytes.len();
        if retained > 0 {
            state.remaining -= retained;
            state.output.push_back(Chunk {
                stream,
                bytes: bytes[..retained].to_vec(),
            });
        }
    }

    fn finish(&self, result: Result<Outcome>) {
        let mut state = self.state();
        state.ended = Some(Instant::now());
        state.phase_before_exit = state.phase;
        let phase = match result {
            Ok(Outcome::Ran(code)) => {
                state.exit_code = code;
                if code == Some(0) {
                    Phase::Completed
                } else {
                    Phase::Failed
                }
            }
            Ok(Outcome::BuildFailed(code)) => {
                state.exit_code = code;
                Phase::Failed
            }
            Ok(Outcome::Stopped) => Phase::Completed,
            Err(error) => {
                state.error = Some(error);
                Phase::Failed
            }
        };
        state.phase = phase;
        drop(state);
        self.notify(phase);
    }

    fn read(&self) -> Update {
        let mut state = self.state();
        let len = state.output.len().min(16);
        let output = state.output.drain(..len).collect();
        // Return the final state only after delivering all preceding output.
        Update {
            phase: if state.phase.finished() && !state.output.is_empty() {
                state.phase_before_exit
            } else {
                state.phase
            },
            elapsed_ms: state
                .ended
                .unwrap_or_else(Instant::now)
                .duration_since(self.started)
                .as_millis() as u64,
            exit_code: state.exit_code,
            error: if state.output.is_empty() {
                state.error
            } else {
                None
            },
            cancelled: self.stopped.load(Relaxed),
            truncated: state.truncated,
            output,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Ran(Option<i32>),
    BuildFailed(Option<i32>),
    Stopped,
}

fn tools(language: Language, path: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    let names: &[&str] = match (language, cfg!(windows)) {
        (Language::Python, true) => &["python.exe", "python3.exe"],
        (Language::Python, false) => &["python3", "python"],
        (Language::Cpp, true) => &["clang++.exe", "g++.exe"],
        (Language::Cpp, false) => &["clang++", "g++"],
    };
    path.into_iter()
        .flat_map(std::env::split_paths)
        .filter(|dir| dir.is_absolute() && !dir.ends_with("WindowsApps"))
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .filter(|candidate| is_executable(candidate))
        .collect()
}

fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    metadata.is_file()
}

fn tool(language: Language, path: Option<&std::ffi::OsStr>) -> Result<PathBuf> {
    tools(language, path)
        .into_iter()
        .next()
        .ok_or(match language {
            Language::Python => ExecutionError::PythonUnavailable,
            Language::Cpp => ExecutionError::CompilerUnavailable,
        })
}

fn execute(snapshot: Snapshot, progress: &Arc<Progress>) -> Result<Outcome> {
    if progress.stopped.load(Relaxed) {
        return Ok(Outcome::Stopped);
    }
    let path = std::env::var_os("PATH");
    let executable = tool(snapshot.language, path.as_deref())?;
    let child_path = std::env::join_paths(
        path.as_deref()
            .into_iter()
            .flat_map(std::env::split_paths)
            .filter(|dir| dir.is_absolute()),
    )
    .map_err(|_| ExecutionError::ProcessUnavailable)?;
    let scratch = tempfile::Builder::new()
        .prefix("turing-run-")
        .tempdir()
        .map_err(|_| ExecutionError::Internal)?;
    let source = scratch.path().join(&snapshot.name);
    fs::write(&source, snapshot.content).map_err(|_| ExecutionError::Internal)?;
    let mut command = match snapshot.language {
        Language::Python => {
            let mut command = Command::new(executable);
            command.args(["-I", "-B", "-u", "-X", "utf8"]).arg(&source);
            command
        }
        Language::Cpp => {
            progress.stage(Phase::Compiling);
            let binary = scratch.path().join(if cfg!(windows) {
                "program.exe"
            } else {
                "program"
            });
            let mut compiler = Command::new(executable);
            compiler
                .args(["-std=c++17", "-fdiagnostics-color=never", "-x", "c++"])
                .arg(&source);
            compiler.arg("-o").arg(&binary).env("PATH", &child_path);
            let Some(status) =
                process::run(&mut compiler, &snapshot.cwd, scratch.path(), progress, true)?
            else {
                return Ok(Outcome::Stopped);
            };
            if !status.success() {
                return Ok(Outcome::BuildFailed(status.code()));
            }
            Command::new(binary)
        }
    };
    progress.stage(Phase::Running);
    Ok(
        match process::run(&mut command, &snapshot.cwd, scratch.path(), progress, false)? {
            Some(status) => Outcome::Ran(status.code()),
            None => Outcome::Stopped,
        },
    )
}

struct Job {
    id: String,
    owner: String,
    progress: Arc<Progress>,
    worker: JoinHandle<()>,
}

#[derive(Default)]
pub struct ExecutionService {
    current: Mutex<Option<Job>>,
    closing: AtomicBool,
}

impl ExecutionService {
    fn start(
        &self,
        owner: &str,
        snapshot: Snapshot,
        events: Option<Channel<Phase>>,
    ) -> Result<Started> {
        let mut current = self.current.lock().map_err(|_| ExecutionError::Internal)?;
        if self.closing.load(Relaxed) {
            return Err(ExecutionError::PermissionDenied);
        }
        if current
            .as_ref()
            .is_some_and(|job| !job.worker.is_finished())
        {
            return Err(ExecutionError::Busy);
        }
        if let Some(job) = current.take() {
            let _ = job.worker.join();
        }
        let id = uuid::Uuid::new_v4().to_string();
        let started = Started {
            id: id.clone(),
            name: snapshot.name.clone(),
            language: snapshot.language,
        };
        let progress = Arc::new(Progress::new(events));
        let worker = thread::Builder::new()
            .name("run-build".into())
            .spawn({
                let progress = progress.clone();
                move || {
                    let result = execute(snapshot, &progress);
                    progress.finish(result);
                }
            })
            .map_err(|_| ExecutionError::Internal)?;
        *current = Some(Job {
            id,
            owner: owner.into(),
            progress,
            worker,
        });
        Ok(started)
    }

    fn progress(&self, owner: &str, id: &str) -> Result<Arc<Progress>> {
        let current = self.current.lock().map_err(|_| ExecutionError::Internal)?;
        current
            .as_ref()
            .filter(|job| job.owner == owner && job.id == id)
            .map(|job| job.progress.clone())
            .ok_or(ExecutionError::PermissionDenied)
    }

    pub fn shutdown(&self) {
        self.closing.store(true, Relaxed);
        if let Ok(mut current) = self.current.lock() {
            if let Some(job) = current.take() {
                job.progress.stop();
                let _ = job.worker.join();
            }
        }
    }
}

#[tauri::command]
pub async fn execution_start(
    window: WebviewWindow,
    source: Source,
    events: Channel<Phase>,
) -> Result<Started> {
    let resources = workbench(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = &resources.workspace;
        let registry = workspace.registry()?;
        let snapshot = Snapshot::read(&registry, window.label(), source)?;
        // Retain the registry lock through admission so a switch cannot replace
        // the authorized workspace between snapshot validation and acceptance.
        resources
            .execution
            .start(window.label(), snapshot, Some(events))
    })
    .await
    .map_err(|_| ExecutionError::Internal)?
}

#[tauri::command]
pub fn execution_read(window: WebviewWindow, id: String) -> Result<Update> {
    let resources = workbench(&window)?;
    Ok(resources.execution.progress(window.label(), &id)?.read())
}

#[tauri::command]
pub fn execution_stop(window: WebviewWindow, id: String) -> Result<()> {
    let resources = workbench(&window)?;
    resources.execution.progress(window.label(), &id)?.stop();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;
    use std::time::Duration;

    fn run_job(
        language: Language,
        content: &str,
    ) -> (tempfile::TempDir, ExecutionService, Started) {
        let workspace = tempfile::tempdir().unwrap();
        let cwd = Dir::open_ambient_dir(workspace.path(), ambient_authority()).unwrap();
        let service = ExecutionService::default();
        let file = match language {
            Language::Python => "file ü.py",
            Language::Cpp => "file ü.cpp",
        };
        let started = service
            .start(
                "main",
                Snapshot {
                    name: file.into(),
                    language,
                    content: content.into(),
                    cwd,
                },
                None,
            )
            .unwrap();
        (workspace, service, started)
    }

    fn wait(
        service: &ExecutionService,
        id: &str,
        until: impl Fn(&Update) -> bool,
    ) -> (Update, Vec<Chunk>) {
        let deadline = Instant::now() + Duration::from_secs(75);
        let progress = service.progress("main", id).unwrap();
        let mut chunks = Vec::new();
        loop {
            let mut update = progress.read();
            chunks.append(&mut update.output);
            if until(&update) {
                return (update, chunks);
            }
            assert!(Instant::now() < deadline, "execution deadline reached");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn stream(chunks: &[Chunk], wanted: Stream) -> String {
        let bytes: Vec<_> = chunks
            .iter()
            .filter(|chunk| {
                std::mem::discriminant(&chunk.stream) == std::mem::discriminant(&wanted)
            })
            .flat_map(|chunk| chunk.bytes.iter().copied())
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[test]
    fn tool_discovery_filters_relative_directories_and_reports_missing_tools() {
        let temp = tempfile::tempdir().unwrap();
        for (language, name, error) in [
            (
                Language::Python,
                if cfg!(windows) {
                    "python.exe"
                } else {
                    "python3"
                },
                ExecutionError::PythonUnavailable,
            ),
            (
                Language::Cpp,
                if cfg!(windows) { "g++.exe" } else { "g++" },
                ExecutionError::CompilerUnavailable,
            ),
        ] {
            let path = std::env::join_paths([Path::new("."), temp.path()]).unwrap();
            assert_eq!(tool(language, Some(&path)), Err(error));
            let executable = temp.path().join(name);
            fs::write(&executable, []).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
            }
            assert_eq!(tool(language, Some(&path)), Ok(executable));
        }
    }

    #[test]
    fn python_streams_stdout_and_stderr_with_utf8_and_reports_exit() {
        let (_workspace, service, started) = run_job(
            Language::Python,
            "import sys\nprint('hello ☃')\nprint('diagnostic', file=sys.stderr)\nsys.exit(7)\n",
        );
        let (result, chunks) = wait(&service, &started.id, |update| update.phase.finished());
        assert_eq!(result.exit_code, Some(7), "{:?}", result.error);
        assert!(stream(&chunks, Stream::Stdout).contains("hello ☃"));
        assert!(stream(&chunks, Stream::Stderr).contains("diagnostic"));
    }

    #[test]
    fn cpp_compiles_and_executes_only_when_build_succeeds() {
        let (_workspace, service, started) = run_job(
            Language::Cpp,
            "#include <iostream>\nint main() { std::cout << \"cpp ran\"; }",
        );
        let (result, chunks) = wait(&service, &started.id, |update| update.phase.finished());
        assert_eq!(
            result.exit_code,
            Some(0),
            "{:?} {}",
            result.error,
            stream(&chunks, Stream::BuildStderr)
        );
        assert_eq!(stream(&chunks, Stream::Stdout), "cpp ran");
        let (_workspace, service, started) =
            run_job(Language::Cpp, "#error Turing test diagnostic");
        let (result, chunks) = wait(&service, &started.id, |update| update.phase.finished());
        assert!(result.exit_code.is_some_and(|code| code != 0));
        assert!(stream(&chunks, Stream::BuildStderr).contains("Turing test diagnostic"));
        assert!(stream(&chunks, Stream::Stdout).is_empty());
    }

    #[test]
    fn stop_cancels_a_live_process_and_checks_run_ownership() {
        let (_workspace, service, started) = run_job(
            Language::Python,
            "import time\nprint('started')\ntime.sleep(15)\n",
        );
        assert!(matches!(
            service.progress("other", &started.id),
            Err(ExecutionError::PermissionDenied)
        ));
        assert!(matches!(
            service.progress("main", "stale"),
            Err(ExecutionError::PermissionDenied)
        ));
        let deadline = Instant::now() + Duration::from_secs(10);
        let progress = service.progress("main", &started.id).unwrap();
        loop {
            let update = progress.read();
            if stream(&update.output, Stream::Stdout).contains("started") {
                break;
            }
            assert!(
                !update.phase.finished() && Instant::now() < deadline,
                "{:?}",
                update.error
            );
            thread::sleep(Duration::from_millis(10));
        }
        let cwd = Dir::open_ambient_dir(_workspace.path(), ambient_authority()).unwrap();
        assert!(matches!(
            service.start(
                "main",
                Snapshot {
                    name: "second.py".into(),
                    content: String::new(),
                    cwd,
                    language: Language::Python
                },
                None
            ),
            Err(ExecutionError::Busy)
        ));
        progress.stop();
        let (result, _) = wait(&service, &started.id, |update| update.phase.finished());
        assert!(result.cancelled);
        assert!(result.elapsed_ms < 15_000);
        service.shutdown();
        assert!(matches!(
            service.progress("main", &started.id),
            Err(ExecutionError::PermissionDenied)
        ));
    }

    #[test]
    fn bounds_output_without_blocking_the_child() {
        let (_workspace, service, started) = run_job(Language::Python, "print('x' * 300000)\n");
        let (result, chunks) = wait(&service, &started.id, |update| update.phase.finished());
        assert_eq!(result.exit_code, Some(0), "{:?}", result.error);
        assert!(result.truncated);
        assert_eq!(stream(&chunks, Stream::Stdout).len(), OUTPUT_LIMIT);
    }

    #[test]
    fn snapshot_rejects_replaced_files_wrong_callers_and_unsupported_types() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("main.py");
        fs::write(&path, "print('approved')").unwrap();
        fs::write(temp.path().join("text.txt"), "hello").unwrap();
        let mut registry = Registry::default();
        registry.register("main", temp.path()).unwrap();
        let (_, version, _) = registry.execution_snapshot("main", "1", "main.py").unwrap();
        let request = || Source::Workspace {
            workspace_id: "1".into(),
            relative_path: "main.py".into(),
            version: version.clone(),
        };
        assert!(matches!(
            Snapshot::read(&registry, "other", request()),
            Err(ExecutionError::PermissionDenied)
        ));
        let approved = Snapshot::read(&registry, "main", request()).unwrap();
        fs::rename(&path, temp.path().join("previous.py")).unwrap();
        fs::write(&path, "print('replacement')").unwrap();
        assert!(matches!(
            Snapshot::read(&registry, "main", request()),
            Err(ExecutionError::SourceChanged)
        ));
        let progress = Arc::new(Progress::new(None));
        assert_eq!(execute(approved, &progress).unwrap(), Outcome::Ran(Some(0)));
        assert!(stream(&progress.read().output, Stream::Stdout).contains("approved"));
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            let external = outside.path().join("escape.py");
            fs::write(&external, "print('outside')").unwrap();
            std::os::unix::fs::symlink(&external, temp.path().join("escape.py")).unwrap();
            assert!(matches!(
                Snapshot::read(
                    &registry,
                    "main",
                    Source::Workspace {
                        workspace_id: "1".into(),
                        relative_path: "escape.py".into(),
                        version: version.clone(),
                    }
                ),
                Err(ExecutionError::PermissionDenied)
            ));
        }
        assert!(matches!(
            Snapshot::read(
                &registry,
                "main",
                Source::Workspace {
                    workspace_id: "1".into(),
                    relative_path: "../main.py".into(),
                    version: version.clone()
                }
            ),
            Err(ExecutionError::PermissionDenied)
        ));
        let (_, version, _) = registry
            .execution_snapshot("main", "1", "text.txt")
            .unwrap();
        assert!(matches!(
            Snapshot::read(
                &registry,
                "main",
                Source::Workspace {
                    workspace_id: "1".into(),
                    relative_path: "text.txt".into(),
                    version
                }
            ),
            Err(ExecutionError::UnsupportedLanguage)
        ));
        registry.close("main", "1").unwrap();
        assert!(matches!(
            Snapshot::read(&registry, "main", request()),
            Err(ExecutionError::PermissionDenied)
        ));
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use crate::contract_fixtures as fixture;

    #[test]
    fn error_codes_match_contract() {
        use ExecutionError::*;
        let all = [
            PermissionDenied,
            Busy,
            UnsupportedLanguage,
            SourceChanged,
            SourceUnavailable,
            PythonUnavailable,
            CompilerUnavailable,
            ProcessUnavailable,
            TimedOut,
            Internal,
        ];
        for error in &all {
            match error {
                PermissionDenied | Busy | UnsupportedLanguage | SourceChanged
                | SourceUnavailable | PythonUnavailable | CompilerUnavailable
                | ProcessUnavailable | TimedOut | Internal => {}
            }
        }
        fixture::assert_error_codes("execution", &all);
    }

    #[test]
    fn enums_match_contract() {
        let languages = [Language::Python, Language::Cpp];
        for language in &languages {
            match language {
                Language::Python | Language::Cpp => {}
            }
        }
        fixture::assert_enum_values("ExecutionLanguage", &languages);

        use Phase::*;
        let phases = [Preparing, Compiling, Running, Stopping, Completed, Failed];
        for phase in &phases {
            match phase {
                Preparing | Compiling | Running | Stopping | Completed | Failed => {}
            }
        }
        fixture::assert_enum_values("ExecutionPhase", &phases);

        let streams = [
            Stream::BuildStdout,
            Stream::BuildStderr,
            Stream::Stdout,
            Stream::Stderr,
        ];
        for stream in &streams {
            match stream {
                Stream::BuildStdout | Stream::BuildStderr | Stream::Stdout | Stream::Stderr => {}
            }
        }
        fixture::assert_enum_values("ExecutionStream", &streams);
    }

    #[test]
    fn payloads_match_contract() {
        fixture::assert_payload(
            "ExecutionStarted",
            0,
            &Started {
                id: "run-1".into(),
                name: "main.cpp".into(),
                language: Language::Cpp,
            },
        );
        fixture::assert_case_count("ExecutionStarted", 1);

        fixture::assert_payload(
            "ExecutionUpdate",
            0,
            &Update {
                phase: Phase::Completed,
                elapsed_ms: 1250,
                exit_code: Some(0),
                error: None,
                cancelled: false,
                truncated: false,
                output: vec![
                    Chunk {
                        stream: Stream::BuildStderr,
                        bytes: b"w".to_vec(),
                    },
                    Chunk {
                        stream: Stream::Stdout,
                        bytes: b"ok".to_vec(),
                    },
                ],
            },
        );
        fixture::assert_payload(
            "ExecutionUpdate",
            1,
            &Update {
                phase: Phase::Failed,
                elapsed_ms: 30_000,
                exit_code: None,
                error: Some(ExecutionError::TimedOut),
                cancelled: false,
                truncated: true,
                output: Vec::new(),
            },
        );
        fixture::assert_case_count("ExecutionUpdate", 2);
    }
}
