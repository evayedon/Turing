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
    /// The server accepted `shutdown` and exited successfully after `exit`.
    Graceful,
    /// The server had already exited or could not accept `shutdown`.
    AlreadyExited,
    /// No `shutdown` reply arrived within the budget.
    NoReply,
    /// The server returned an error or an invalid shutdown result.
    Rejected,
    /// The server replied but did not exit within the budget.
    NoExit,
    /// The server exited with a failure status.
    FailedExit,
}

pub struct Process {
    child: Option<Child>,
    send: Option<SyncSender<Vec<Value>>>,
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
            send: Some(send),
            receive,
            #[cfg(windows)]
            _job: None,
        })
    }

    pub fn send(&self, message: Value) -> Result<()> {
        self.batch(vec![message])
    }

    pub fn batch(&self, messages: Vec<Value>) -> Result<()> {
        self.send
            .as_ref()
            .ok_or(Error::ServerExited)?
            .try_send(messages)
            .map_err(|error| match error {
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

    /// Requests `shutdown`, then sends `exit` and closes the input pipe.
    pub fn shutdown(&mut self) -> Shutdown {
        let deadline = Instant::now() + SHUTDOWN_REPLY;
        let request = json!({"jsonrpc":"2.0","id":SHUTDOWN_ID,"method":"shutdown"});
        loop {
            match self.send(request.clone()) {
                Ok(()) => break,
                Err(Error::Busy) if Instant::now() < deadline => {
                    // A full inbound queue can block the server while the
                    // writer is still flushing queued document changes.
                    let _ = self.receive.recv_timeout(Duration::from_millis(5));
                }
                Err(Error::Busy) => return Shutdown::NoReply,
                Err(_) => return Shutdown::AlreadyExited,
            }
        }
        loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Shutdown::NoReply;
            };
            match self.receive.recv_timeout(remaining) {
                Ok(message)
                    if message.get("id").and_then(Value::as_u64) == Some(SHUTDOWN_ID)
                        && message.get("method").is_none() =>
                {
                    if message.get("result") != Some(&Value::Null) || message.get("error").is_some()
                    {
                        return Shutdown::Rejected;
                    }
                    break;
                }
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout) => return Shutdown::NoReply,
                Err(RecvTimeoutError::Disconnected) => return Shutdown::AlreadyExited,
            }
        }
        if self.send(json!({"jsonrpc":"2.0","method":"exit"})).is_err() {
            return Shutdown::AlreadyExited;
        }
        // The writer drains the queued exit frame before dropping stdin.
        self.send.take();
        let deadline = Instant::now() + SHUTDOWN_EXIT;
        loop {
            if let Some(mut child) = self.child.take_if(has_exited) {
                // Clean up remaining descendants before reaping the exited
                // Unix group leader and releasing its group ID.
                kill_group(&child);
                return match child.wait() {
                    Ok(status) if status.success() => Shutdown::Graceful,
                    _ => Shutdown::FailedExit,
                };
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Shutdown::NoExit;
            };
            // Drain output to avoid backpressure, but require actual child
            // termination even if the reader has already stopped.
            if let Err(RecvTimeoutError::Disconnected) = self
                .receive
                .recv_timeout(remaining.min(Duration::from_millis(10)))
            {
                if self.child.is_none() {
                    return Shutdown::Graceful;
                }
                thread::sleep(remaining.min(Duration::from_millis(10)));
            }
        }
    }
}

#[cfg(unix)]
fn has_exited(child: &mut Child) -> bool {
    let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
    unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        ) == 0
            && info.si_pid() != 0
    }
}

#[cfg(windows)]
fn has_exited(child: &mut Child) -> bool {
    matches!(child.try_wait(), Ok(Some(_)))
}

fn kill_group(_child: &Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(_child.id() as libc::pid_t), libc::SIGKILL);
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        kill_group(child);
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn shutdown_flushes_exit_closes_stdin_and_reaps_the_child() {
        let fixture = tempfile::tempdir().unwrap();
        let script = fixture.path().join("server");
        // The fixture exits successfully only if it receives both requests
        // in order and stdin then reaches EOF. Close stdout before the last
        // step so EOF on that pipe alone cannot count as graceful shutdown.
        std::fs::write(
            &script,
            r#"#!/bin/bash
ready='{"jsonrpc":"2.0","method":"ready"}'
printf 'Content-Length: %s\r\n\r\n%s' "${#ready}" "$ready"
read_frame() {
    IFS= read -r header && IFS= read -r separator || exit 2
    length=${header#Content-Length: }
    length=${length%?}
    IFS= read -r -n "$length" body || exit 2
    printf '%s' "$body"
}
case "$(read_frame)" in *'"method":"shutdown"'*) ;; *) exit 3 ;; esac
reply='{"jsonrpc":"2.0","id":2,"result":null}'
printf 'Content-Length: %s\r\n\r\n%s' "${#reply}" "$reply"
case "$(read_frame)" in *'"method":"exit"'*) ;; *) exit 4 ;; esac
exec 1>&-
if IFS= read -r unexpected; then exit 5; fi
exit 0
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut process = Process::start(&script, fixture.path()).unwrap();
        assert_eq!(
            process
                .receive
                .recv_timeout(Duration::from_secs(3))
                .unwrap()["method"],
            "ready"
        );
        assert_eq!(process.shutdown(), Shutdown::Graceful);
        assert!(
            process.child.is_none(),
            "graceful shutdown must reap the child"
        );
    }

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
