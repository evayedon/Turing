use super::{framing, Error, Result};
use serde_json::{json, Value};
use std::{
    io::BufReader,
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, SyncSender, TryRecvError},
    thread,
    time::{Duration, Instant},
};

pub struct Process {
    child: Child,
    send: SyncSender<Vec<Value>>,
    pub receive: Receiver<Value>,
    #[cfg(windows)]
    _job: crate::terminal::platform::ProcessGuard,
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
        let (send, outbound) = mpsc::sync_channel::<Vec<Value>>(8);
        let (inbound, receive) = mpsc::sync_channel(16);
        let mut process = Self {
            child,
            send,
            receive,
            #[cfg(windows)]
            _job: job,
        };
        let mut stdin = process.child.stdin.take().ok_or(Error::StartFailed)?;
        let stdout = process.child.stdout.take().ok_or(Error::StartFailed)?;
        thread::Builder::new()
            .name("clangd-input".into())
            .spawn(move || {
                while let Ok(messages) = outbound.recv() {
                    for message in messages {
                        if framing::write(&mut stdin, &message).is_err() {
                            return;
                        }
                    }
                }
            })
            .map_err(|_| Error::StartFailed)?;
        thread::Builder::new()
            .name("clangd-output".into())
            .spawn(move || {
                let mut stdout = BufReader::new(stdout);
                while let Ok(message) = framing::read(&mut stdout) {
                    if inbound.try_send(message).is_err() {
                        break;
                    }
                }
            })
            .map_err(|_| Error::StartFailed)?;
        Ok(process)
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

    pub fn shutdown(&mut self) {
        if self
            .send(json!({"jsonrpc":"2.0","id":2,"method":"shutdown"}))
            .is_err()
        {
            return;
        }
        let deadline = Instant::now() + Duration::from_millis(160);
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match self.receive.recv_timeout(remaining) {
                Ok(message) if message.get("id").and_then(Value::as_u64) == Some(2) => {
                    let _ = self.send(json!({"jsonrpc":"2.0","method":"exit"}));
                    while Instant::now() < deadline {
                        if matches!(self.child.try_wait(), Ok(Some(_))) {
                            return;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    return;
                }
                Ok(_) => {}
                Err(_) => return,
            }
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as libc::pid_t), libc::SIGKILL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
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
        let pid = process.child.id() as libc::pid_t;
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
