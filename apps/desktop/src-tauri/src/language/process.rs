use super::{framing, Error, Result};
use serde_json::{json, Value};
use std::{
    io::{BufReader, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError},
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
    send: SyncSender<Vec<Value>>,
    pub receive: Receiver<Value>,
    #[cfg(windows)]
    _job: Option<crate::terminal::platform::ProcessGuard>,
}

impl Process {
    pub fn start(executable: &Path, directory: &Path) -> Result<Self> {
        let mut command = Command::new(executable);
        command
            .args([
                "--background-index=false",
                "--enable-config=false",
                "--clang-tidy=false",
                "--pch-storage=memory",
                "-j=1",
            ])
            .arg("--compile-commands-dir")
            .arg(directory)
            .current_dir(directory)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
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
            .name("clangd-input".into())
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
            .name("clangd-output".into())
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
            send,
            receive,
            #[cfg(windows)]
            _job: None,
        })
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

impl Drop for Process {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        // The unreaped leader keeps the group ID reserved, so this signal
        // cannot reach an unrelated process group.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
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
        let process = Process::start(&script, fixture.path()).unwrap();
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
