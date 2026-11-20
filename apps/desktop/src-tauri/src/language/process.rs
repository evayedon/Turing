use super::{
    framing,
    server::{Executable, Kind},
    Error, Result,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{BufReader, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

/// Budget for the server to answer `shutdown`, then separately to exit
/// after `exit`. Revocation and window destruction skip this and kill.
const SHUTDOWN_REPLY: Duration = Duration::from_millis(750);
// A real clangd joins its worker threads on exit, which can take seconds
// while a preamble is still building (seen with clangd 18 on Linux CI).
const SHUTDOWN_EXIT: Duration = Duration::from_secs(3);
const SHUTDOWN_ID: u64 = 2;

/// How an explicit stop ended. Anything but `Graceful` falls back to the
/// forced cleanup in `Drop`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shutdown {
    /// The server answered `shutdown` and closed its output after `exit`.
    Graceful,
    /// The server had already exited or could not accept `shutdown`.
    AlreadyExited,
    /// No `shutdown` reply arrived within the budget.
    NoReply,
    /// The server replied but did not exit within the budget.
    NoExit,
}

pub struct Process {
    child: Option<Child>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    send: SyncSender<Vec<Value>>,
    pub receive: Receiver<Value>,
    #[cfg(windows)]
    _job: Option<crate::terminal::platform::ProcessGuard>,
}

impl Process {
    fn command(executable: &Executable, directory: &Path, kind: Kind, probe: bool) -> Command {
        let entry = if probe {
            &executable.version_entry
        } else {
            &executable.entry
        };
        let mut command = Command::new(executable.node.as_ref().unwrap_or(entry));
        if executable.node.is_some() {
            command.arg(entry);
        }
        command
            .current_dir(directory)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if probe {
            command
                .arg("--version")
                .stdin(Stdio::null())
                .stderr(Stdio::null());
        } else {
            command.args(kind.args());
            if kind == Kind::Clangd {
                command.arg("--compile-commands-dir").arg(directory);
            }
        }
        if kind != Kind::Clangd {
            // Node launchers use /usr/bin/env, and rust-analyzer invokes Cargo.
            let path = std::env::var_os("PATH").unwrap_or_default();
            let rust_bin = entry.parent().filter(|directory| {
                kind == Kind::RustAnalyzer
                    && directory
                        .join(if cfg!(windows) { "cargo.exe" } else { "cargo" })
                        .is_file()
            });
            let directories = rust_bin
                .into_iter()
                .map(Path::to_path_buf)
                .chain(entry.ancestors().filter_map(|path| {
                    let bin = path.join("bin");
                    bin.join(if cfg!(windows) { "node.exe" } else { "node" })
                        .is_file()
                        .then_some(bin)
                }))
                .chain(std::env::split_paths(&path).filter(|path| path.is_absolute()));
            if let Some(toolchain) = rust_bin.and_then(Path::parent).filter(|path| {
                path.parent()
                    .is_some_and(|parent| parent.ends_with("toolchains"))
            }) {
                command.env("RUSTUP_TOOLCHAIN", toolchain);
            }
            if let Ok(path) = std::env::join_paths(directories) {
                command.env("PATH", path);
            }
            for key in ["HOME", "USERPROFILE", "CARGO_HOME", "RUSTUP_HOME"] {
                if let Some(value) = std::env::var_os(key) {
                    command.env(key, value);
                }
            }
        }
        if kind == Kind::RustAnalyzer {
            command.env("CARGO_NET_OFFLINE", "true");
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
                if let Some(value) = std::env::var_os(key) {
                    command.env(key, value);
                }
            }
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        command
    }

    pub fn probe(executable: &Executable, directory: &Path, kind: Kind) -> Result<String> {
        let mut child = Self::command(executable, directory, kind, true)
            .spawn()
            .map_err(|_| Error::StartFailed)?;
        #[cfg(windows)]
        let _job = crate::terminal::platform::guard(&child).map_err(|_| terminate(&mut child))?;
        let stdout = child.stdout.take().ok_or_else(|| terminate(&mut child))?;
        let (send, receive) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("lsp-version".into())
            .spawn(move || {
                let mut bytes = Vec::new();
                if stdout.take(4096).read_to_end(&mut bytes).is_ok() {
                    let _ = send.send(bytes);
                }
            })
            .map_err(|_| terminate(&mut child))?;
        // On timeout the leader has not been reaped, so group cleanup is safe.
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.try_wait().map_err(|_| terminate(&mut child))? {
                if !status.success() {
                    return Err(Error::Incompatible);
                }
                let output = receive
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .map_err(|_| Error::Incompatible)?;
                return String::from_utf8_lossy(&output)
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty() && line.bytes().any(|byte| byte.is_ascii_digit()))
                    .map(|line| redact(line).chars().take(160).collect())
                    .ok_or(Error::Incompatible);
            }
            if Instant::now() >= deadline {
                terminate(&mut child);
                return Err(Error::Incompatible);
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn start(executable: &Executable, directory: &Path, kind: Kind) -> Result<Self> {
        let mut command = Self::command(executable, directory, kind, false);
        let child = command.spawn().map_err(|_| Error::StartFailed)?;
        #[cfg(windows)]
        let (child, job) = {
            let mut child = child;
            let job = crate::terminal::platform::guard(&child).map_err(|_| {
                let _ = child.kill();
                let _ = child.wait();
                Error::StartFailed
            })?;
            (child, job)
        };
        let mut child = child;
        let abandon = |mut child: Child| {
            let _ = child.kill();
            let _ = child.wait();
            Error::StartFailed
        };
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err(abandon(child));
        };
        let mut process = match Self::connect(stdin, stdout) {
            Ok(process) => process,
            Err(_) => return Err(abandon(child)),
        };
        if let Some(stderr) = child.stderr.take() {
            let logs = process.stderr.clone();
            if thread::Builder::new()
                .name("lsp-stderr".into())
                .spawn(move || capture_stderr(stderr, &logs))
                .is_err()
            {
                process.child = Some(child);
                return Err(Error::StartFailed);
            }
        }
        process.child = Some(child);
        #[cfg(windows)]
        {
            process._job = Some(job);
        }
        Ok(process)
    }

    /// Runs the framed JSON-RPC transport over any byte streams. `start`
    /// uses the child's pipes; tests use in-memory pipes and a scripted
    /// server.
    pub fn connect(
        mut input: impl Write + Send + 'static,
        output: impl Read + Send + 'static,
    ) -> Result<Self> {
        let (send, outbound) = mpsc::sync_channel::<Vec<Value>>(8);
        let (inbound, receive) = mpsc::sync_channel(16);
        thread::Builder::new()
            .name("lsp-input".into())
            .spawn(move || {
                while let Ok(messages) = outbound.recv() {
                    for message in messages {
                        if framing::write(&mut input, &message).is_err() {
                            return;
                        }
                    }
                }
            })
            .map_err(|_| Error::StartFailed)?;
        thread::Builder::new()
            .name("lsp-output".into())
            .spawn(move || {
                let mut output = BufReader::new(output);
                // A full queue blocks this thread, which in turn makes the
                // server wait on its pipe: bounded backpressure, not loss.
                while let Ok(message) = framing::read(&mut output) {
                    if inbound.send(message).is_err() {
                        break;
                    }
                }
            })
            .map_err(|_| Error::StartFailed)?;
        Ok(Self {
            child: None,
            stderr: Arc::default(),
            send,
            receive,
            #[cfg(windows)]
            _job: None,
        })
    }

    pub fn record_version(&self, version: String) {
        if let Ok(mut lines) = self.stderr.lock() {
            if lines.len() >= 100 {
                lines.pop_front();
            }
            lines.push_back(format!("Version: {version}"));
        }
    }

    pub fn logs(&self) -> Vec<String> {
        self.stderr
            .lock()
            .map(|mut lines| lines.drain(..).collect())
            .unwrap_or_default()
    }

    pub fn send(&self, message: Value) -> Result<()> {
        self.batch(vec![message])
    }

    pub fn batch(&self, messages: Vec<Value>) -> Result<()> {
        self.send.try_send(messages).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => Error::Busy,
            mpsc::TrySendError::Disconnected(_) => Error::ServerExited,
        })
    }

    pub fn next(&self) -> Result<Option<Value>> {
        match self.receive.try_recv() {
            Ok(value) => Ok(Some(value)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(Error::ServerExited),
        }
    }

    /// Requests `shutdown`, then `exit`, within bounded budgets. The child
    /// is never reaped here, so the Unix process group cannot be recycled
    /// before `Drop` signals it.
    pub fn shutdown(&mut self) -> Shutdown {
        if self
            .send(json!({"jsonrpc":"2.0","id":SHUTDOWN_ID,"method":"shutdown"}))
            .is_err()
        {
            return Shutdown::AlreadyExited;
        }
        let deadline = Instant::now() + SHUTDOWN_REPLY;
        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Shutdown::NoReply;
            };
            match self.receive.recv_timeout(remaining) {
                Ok(message)
                    if message.get("id").and_then(Value::as_u64) == Some(SHUTDOWN_ID)
                        && message.get("method").is_none() =>
                {
                    break
                }
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => return Shutdown::NoReply,
                Err(RecvTimeoutError::Disconnected) => return Shutdown::AlreadyExited,
            }
        }
        if self.send(json!({"jsonrpc":"2.0","method":"exit"})).is_err() {
            return Shutdown::Graceful;
        }
        // The server closing its output is the exit signal; draining keeps
        // a blocked output thread from holding the pipe open.
        let deadline = Instant::now() + SHUTDOWN_EXIT;
        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Shutdown::NoExit;
            };
            match self.receive.recv_timeout(remaining) {
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => return Shutdown::NoExit,
                Err(RecvTimeoutError::Disconnected) => return Shutdown::Graceful,
            }
        }
    }
}

fn redact(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if [
        "authorization",
        "bearer",
        "token",
        "password",
        "secret",
        "api_key",
        "apikey",
        "credential",
        "private key",
        "cookie",
        "passwd",
        "api-key",
        "github_pat_",
        "eyj",
        "xoxb-",
        "xoxp-",
        "akia",
        "ghp_",
        "sk-",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return "[redacted]".into();
    }
    line.chars()
        .filter(|ch| !ch.is_control() || *ch == '\t')
        .collect()
}

fn capture_stderr(mut stderr: impl Read, logs: &Mutex<VecDeque<String>>) {
    let mut buffer = [0; 4096];
    let mut line = Vec::new();
    let mut truncated = false;
    let store_line = |line: &[u8], truncated| {
        if let Ok(mut logs) = logs.lock() {
            if logs.len() >= 100 {
                logs.pop_front();
            }
            logs.push_back(if truncated {
                "[overlong stderr line omitted]".into()
            } else {
                redact(&String::from_utf8_lossy(line))
            });
        }
    };
    while let Ok(count) = stderr.read(&mut buffer) {
        if count == 0 {
            break;
        }
        for &byte in &buffer[..count] {
            if byte == b'\n' {
                store_line(&line, truncated);
                line.clear();
                truncated = false;
            } else if line.len() < 2048 {
                line.push(byte);
            } else {
                truncated = true;
            }
        }
    }
    if !line.is_empty() {
        store_line(&line, truncated);
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        terminate(child);
    }
}

fn terminate(child: &mut Child) -> Error {
    // The unreaped leader keeps the group ID reserved.
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    Error::StartFailed
}

#[cfg(test)]
mod stderr_tests {
    use super::*;

    #[test]
    fn redacts_secrets_and_bounds_stderr_lines() {
        let logs = Mutex::default();
        let source = format!(
            "server ready\nAuthorization: Bearer credential-value\nTOKEN=value\n{}\nlast line\n",
            "x".repeat(3000)
        );
        capture_stderr(source.as_bytes(), &logs);
        assert_eq!(
            logs.into_inner().unwrap(),
            [
                "server ready",
                "[redacted]",
                "[redacted]",
                "[overlong stderr line omitted]",
                "last line",
            ]
        );
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn malformed_server_output_is_reported_and_drop_reaps_the_child() {
        let fixture = tempfile::tempdir().unwrap();
        let script = fixture.path().join("server");
        std::fs::write(
            &script,
            "#!/bin/sh\nprintf 'Content-Length: 1048577\\r\\n\\r\\n'\nwhile read -r line; do :; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let process = Process::start(
            &Executable::new(&script, Kind::Clangd).unwrap(),
            fixture.path(),
            Kind::Clangd,
        )
        .unwrap();
        let pid = process.child.as_ref().unwrap().id() as libc::pid_t;
        assert_eq!(
            process.receive.recv_timeout(Duration::from_secs(3)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
        assert!(matches!(process.next(), Err(Error::ServerExited)));
        drop(process);
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
}
