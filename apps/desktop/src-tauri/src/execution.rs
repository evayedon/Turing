#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod argv;
mod process;
pub(crate) mod sandbox;
mod toolchain;

use crate::windows::workbench;
use crate::workspace::{Registry, WorkspaceError};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    ffi::OsStr,
    fs,
    path::Path,
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
    CCompilerUnavailable,
    RustUnavailable,
    GoUnavailable,
    JavaUnavailable,
    NodeUnavailable,
    TypescriptUnavailable,
    DotnetUnavailable,
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
    C,
    Rust,
    Go,
    Java,
    JavaScript,
    TypeScript,
    CSharp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
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

#[derive(Clone, Copy, PartialEq, Serialize)]
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
            Some("c") if name.ends_with(".C") => Language::Cpp,
            Some("c") => Language::C,
            Some("rs") => Language::Rust,
            Some("go") => Language::Go,
            Some("java") => Language::Java,
            Some("js" | "mjs" | "cjs") => Language::JavaScript,
            Some("ts" | "mts" | "cts") => Language::TypeScript,
            Some("cs") => Language::CSharp,
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

/// The environment allowlist shared by Run & Build and agent commands.
pub(crate) fn baseline_env(command: &mut Command, path: &OsStr, temp: &Path) {
    command.env_clear();
    // Keep platform and installed toolchain discovery available without
    // passing application credentials or tool-specific startup options.
    for key in [
        "HOME",
        "USERPROFILE",
        "SystemRoot",
        "WINDIR",
        "LOCALAPPDATA",
        "APPDATA",
        "SDKROOT",
        "INCLUDE",
        "LIB",
        "LIBPATH",
        "DEVELOPER_DIR",
        "JAVA_HOME",
        "RUSTUP_HOME",
        "DOTNET_ROOT",
        "DOTNET_ROOT_X64",
        "DOTNET_ROOT_ARM64",
        // Windows toolchains (rustc/MSVC, vswhere, the Windows SDK)
        // locate their installations through these; without them rustc
        // falls back to whatever `link.exe` is first on PATH.
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
        "CommonProgramFiles",
        "CommonProgramFiles(x86)",
        "PROCESSOR_ARCHITECTURE",
        "NUMBER_OF_PROCESSORS",
        "ComSpec",
        "VSINSTALLDIR",
        "VCINSTALLDIR",
        "VCToolsInstallDir",
        "WindowsSdkDir",
        "WindowsSDKVersion",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("PATH", path)
        .env("TMPDIR", temp)
        .env("TMP", temp)
        .env("TEMP", temp)
        .env("LC_MESSAGES", "C")
        .env(
            "LC_CTYPE",
            if cfg!(target_os = "macos") {
                "en_US.UTF-8"
            } else {
                "C.UTF-8"
            },
        );
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

/// GCC 11+ reports diagnostic columns in display cells (tabs as 8, wide
/// characters as 2); ask it for UTF-8 byte columns, which Clang and older
/// GCC already use. Both of those reject the flag, so only a version string
/// that is GCC's own (FSF copyright, no clang) at 11 or later gets it.
fn column_unit_flag(version_output: &str) -> Option<&'static str> {
    if !version_output.contains("Free Software Foundation") {
        return None;
    }
    let first = version_output.lines().next()?;
    if first.to_ascii_lowercase().contains("clang") {
        return None;
    }
    let major: u32 = first
        .rsplit_once(')')?
        .1
        .split_whitespace()
        .next()?
        .split('.')
        .next()?
        .parse()
        .ok()?;
    (major >= 11).then_some("-fdiagnostics-column-unit=byte")
}

fn execute(snapshot: Snapshot, progress: &Arc<Progress>) -> Result<Outcome> {
    if progress.stopped.load(Relaxed) {
        return Ok(Outcome::Stopped);
    }
    let scratch = tempfile::Builder::new()
        .prefix("turing-run-")
        .tempdir()
        .map_err(|_| ExecutionError::Internal)?;
    let mut source = scratch.path().join(&snapshot.name);
    if let Some(extension) = source.extension().and_then(std::ffi::OsStr::to_str) {
        let extension = extension.to_ascii_lowercase();
        source.set_extension(extension);
    }
    fs::write(&source, snapshot.content).map_err(|_| ExecutionError::Internal)?;
    toolchain::execute(snapshot.language, &source, &snapshot.cwd, progress)
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

    #[test]
    fn only_gcc_11_and_later_are_asked_for_byte_columns() {
        const FSF: &str = "\nCopyright (C) 2023 Free Software Foundation, Inc.\n";
        let byte = Some("-fdiagnostics-column-unit=byte");
        for (version, expected) in [
            ("g++ (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0", byte),
            ("g++ (GCC) 13.2.1 20230801", byte),
            ("g++.exe (Rev2, Built by MSYS2 project) 13.2.0", byte),
            // GCC 10 already reports bytes and rejects the flag.
            ("g++ (Debian 10.2.1-6) 10.2.1 20210110", None),
        ] {
            assert_eq!(
                column_unit_flag(&format!("{version}{FSF}")),
                expected,
                "{version}"
            );
        }
        // Clang reports bytes and rejects the flag, even when installed as g++.
        for clang in [
            "Apple clang version 17.0.0 (clang-1700.0.13.3)\nTarget: arm64-apple-darwin24.0.0\n",
            "clang version 18.1.3 (1ubuntu1)\nTarget: x86_64-pc-linux-gnu\n",
            "",
            "g++ (GCC) 13.2.1",
        ] {
            assert_eq!(column_unit_flag(clang), None, "{clang}");
        }
    }

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
            Language::C => "file ü.c",
            Language::Rust => "file ü.rs",
            Language::Go => "file ü.go",
            Language::Java => "Main.java",
            Language::JavaScript => "file ü.mjs",
            Language::TypeScript => "file ü.mts",
            Language::CSharp => "file ü.cs",
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
        let deadline = Instant::now() + Duration::from_secs(300);
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
            assert_eq!(toolchain::tool(language, Some(&path)), Err(error));
            let executable = temp.path().join(name);
            fs::write(&executable, []).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
            }
            assert_eq!(toolchain::tool(language, Some(&path)), Ok(executable));
        }
    }

    fn run_installed(language: Language, content: &str, unavailable: ExecutionError) {
        let (_workspace, service, started) = run_job(language, content);
        let (result, chunks) = wait(&service, &started.id, |update| update.phase.finished());
        let required = matches!(language, Language::Rust | Language::CSharp)
            && std::env::var("TURING_CI_REQUIRE_WINDOWS_TOOLCHAINS").as_deref() == Ok("1");
        if result.error == Some(unavailable) && !required {
            eprintln!("skipping {language:?}: {unavailable:?} (no usable installed toolchain)");
            return;
        }
        let progress = service.progress("main", &started.id).unwrap();
        let phase = progress.state().phase_before_exit;
        assert_eq!(
            result.exit_code,
            Some(0),
            "{language:?}: {:?} in {phase:?} after {} ms\n{}\n{}\n{}",
            result.error,
            result.elapsed_ms,
            stream(&chunks, Stream::BuildStdout),
            stream(&chunks, Stream::BuildStderr),
            stream(&chunks, Stream::Stderr)
        );
        assert_eq!(stream(&chunks, Stream::Stdout).trim(), "ran");
    }

    #[test]
    fn c_runs_single_file() {
        run_installed(
            Language::C,
            "#include <stdio.h>\nint main(void) { puts(\"ran\"); }",
            ExecutionError::CCompilerUnavailable,
        );
    }

    #[test]
    fn rust_runs_without_cargo() {
        run_installed(
            Language::Rust,
            "fn main() { println!(\"ran\"); }",
            ExecutionError::RustUnavailable,
        );
    }

    #[test]
    fn go_runs_single_file_offline() {
        run_installed(
            Language::Go,
            "package main\nimport \"fmt\"\nfunc main() { fmt.Println(\"ran\") }",
            ExecutionError::GoUnavailable,
        );
    }

    #[test]
    fn java_compiles_packaged_single_file() {
        run_installed(Language::Java, "package demos; public class Main { public static void main(String[] args) { System.out.println(\"ran\"); } }", ExecutionError::JavaUnavailable);
    }

    #[test]
    fn javascript_runs_with_node() {
        run_installed(
            Language::JavaScript,
            "console.log('ran');",
            ExecutionError::NodeUnavailable,
        );
    }

    #[test]
    fn typescript_uses_nodes_strip_types_loader() {
        run_installed(
            Language::TypeScript,
            "const text: string = 'ran'; console.log(text);",
            ExecutionError::TypescriptUnavailable,
        );
    }

    #[test]
    fn csharp_uses_only_local_sdk() {
        run_installed(
            Language::CSharp,
            "System.Console.WriteLine(\"ran\");",
            ExecutionError::DotnetUnavailable,
        );
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
            CCompilerUnavailable,
            RustUnavailable,
            GoUnavailable,
            JavaUnavailable,
            NodeUnavailable,
            TypescriptUnavailable,
            DotnetUnavailable,
            ProcessUnavailable,
            TimedOut,
            Internal,
        ];
        for error in &all {
            match error {
                PermissionDenied
                | Busy
                | UnsupportedLanguage
                | SourceChanged
                | SourceUnavailable
                | PythonUnavailable
                | CompilerUnavailable
                | CCompilerUnavailable
                | RustUnavailable
                | GoUnavailable
                | JavaUnavailable
                | NodeUnavailable
                | TypescriptUnavailable
                | DotnetUnavailable
                | ProcessUnavailable
                | TimedOut
                | Internal => {}
            }
        }
        fixture::assert_error_codes("execution", &all);
    }

    #[test]
    fn enums_match_contract() {
        use Language::*;
        let languages = [
            Python, Cpp, C, Rust, Go, Java, JavaScript, TypeScript, CSharp,
        ];
        for language in &languages {
            match language {
                Python | Cpp | C | Rust | Go | Java | JavaScript | TypeScript | CSharp => {}
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

#[cfg(test)]
mod agent_e2e;
