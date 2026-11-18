mod platform;

use crate::workspace::WorkspaceService;
use portable_pty::{native_pty_system, Child, MasterPty, PtySize};
use serde::Serialize;
use std::{
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};

const CHUNK: usize = 8192;
const OUTPUT_BATCH: usize = 4;
const RETRY_DELAY: Duration = Duration::from_millis(8);

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TerminalError {
    PermissionDenied,
    AlreadyRunning,
    SessionClosed,
    InvalidSize,
    InputTooLarge,
    InputBusy,
    ShellUnavailable,
    PtyUnavailable,
    IoError,
}

type Result<T> = std::result::Result<T, TerminalError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStarted {
    id: String,
    workspace_directory: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    bytes: Vec<u8>,
    finished: bool,
    exit_code: Option<u32>,
}

struct Session {
    owner: String,
    id: String,
    master: Option<Box<dyn MasterPty + Send>>,
    child: Box<dyn Child + Send + Sync>,
    platform_guard: Option<platform::ProcessGuard>,
    output: Option<Receiver<Vec<u8>>>,
    input: Option<SyncSender<Vec<u8>>>,
    stop: Arc<AtomicBool>,
    input_failed: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
    exit: Option<(u32, Instant)>,
    output_closed: Option<Instant>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.output.take();
        self.input.take();
        if self.exit.is_none() && !matches!(self.child.try_wait(), Ok(Some(_))) {
            platform::terminate(self.master.as_deref(), &mut *self.child);
        }
        self.platform_guard.take();
        self.master.take();
        let _ = self.child.wait();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

impl Session {
    fn start(
        owner: &str,
        size: PtySize,
        directory: Option<cap_std::fs::Dir>,
    ) -> Result<(Self, bool)> {
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|_| TerminalError::PtyUnavailable)?;
        let reader = platform::reader(&*pair.master)?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|_| TerminalError::PtyUnavailable)?;
        let (child, workspace_directory) = platform::spawn(&pair, directory)?;
        drop(pair.slave);

        let (tx, output) = mpsc::sync_channel(32);
        let (input, rx) = mpsc::sync_channel(16);
        let stop = Arc::new(AtomicBool::new(false));
        let input_failed = Arc::new(AtomicBool::new(false));
        let mut session = Self {
            owner: owner.into(),
            id: uuid::Uuid::new_v4().to_string(),
            master: Some(pair.master),
            child,
            platform_guard: None,
            output: Some(output),
            input: Some(input),
            stop: stop.clone(),
            input_failed: input_failed.clone(),
            workers: vec![],
            exit: None,
            output_closed: None,
        };
        session.workers.push(
            thread::Builder::new()
                .name("terminal-output".into())
                .spawn({
                    let stop = stop.clone();
                    move || read_output(reader, tx, &stop)
                })
                .map_err(|_| TerminalError::IoError)?,
        );
        session.platform_guard = Some(platform::guard(&*session.child)?);
        session.workers.push(
            thread::Builder::new()
                .name("terminal-input".into())
                .spawn(move || write_input(writer, rx, &stop, &input_failed))
                .map_err(|_| TerminalError::IoError)?,
        );
        Ok((session, workspace_directory))
    }

    fn read(&mut self) -> Result<TerminalOutput> {
        if self.exit.is_none() {
            self.exit = self
                .child
                .try_wait()
                .map_err(|_| TerminalError::IoError)?
                .map(|status| (status.exit_code(), Instant::now()));
        }

        let mut bytes = Vec::new();
        let mut drained = false;
        let output = self.output.as_ref().ok_or(TerminalError::SessionClosed)?;
        for _ in 0..OUTPUT_BATCH {
            match output.try_recv() {
                Ok(chunk) => bytes.extend(chunk),
                Err(TryRecvError::Disconnected) => {
                    drained = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        // A descendant can retain the slave after the shell exits. Drain queued
        // output and allow a short grace period for the final PTY bytes.
        let finished = self.exit.is_some_and(|(_, at)| {
            drained
                || (bytes.is_empty() && at.elapsed() >= Duration::from_millis(250))
                || at.elapsed() >= Duration::from_secs(1)
        });
        if drained {
            self.output_closed.get_or_insert_with(Instant::now);
        }
        if self.exit.is_none()
            && (self.input_failed.load(Ordering::Relaxed)
                || self
                    .output_closed
                    .is_some_and(|at| at.elapsed() >= Duration::from_millis(250)))
        {
            return Err(TerminalError::IoError);
        }
        Ok(TerminalOutput {
            bytes,
            finished,
            exit_code: self.exit.map(|(code, _)| code),
        })
    }
}

fn read_output(mut reader: impl Read, sender: SyncSender<Vec<u8>>, stop: &AtomicBool) {
    let mut buffer = [0; CHUNK];
    let mut deliver = true;
    loop {
        // ConPTY can synchronously flush output while closing. Keep draining
        // the pipe on Windows after the receiver has been dropped.
        if cfg!(unix) && stop.load(Ordering::Relaxed) {
            break;
        }
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                if deliver {
                    deliver = sender.send(buffer[..size].to_vec()).is_ok();
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(RETRY_DELAY),
            Err(_) => break,
        }
    }
}

fn write_input(
    mut writer: impl Write,
    receiver: Receiver<Vec<u8>>,
    stop: &AtomicBool,
    failed: &AtomicBool,
) {
    while let Ok(input) = receiver.recv() {
        let mut pending = input.as_slice();
        while !pending.is_empty() && !stop.load(Ordering::Relaxed) {
            match writer.write(pending) {
                Ok(n) if n > 0 => pending = &pending[n..],
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(RETRY_DELAY)
                }
                _ => {
                    failed.store(true, Ordering::Relaxed);
                    return;
                }
            }
        }
    }
}

#[derive(Default)]
pub struct TerminalService {
    session: Mutex<Option<Session>>,
    shutting_down: AtomicBool,
}

impl TerminalService {
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Relaxed);
        if let Ok(mut slot) = self.session.lock() {
            slot.take();
        }
    }

    fn start(
        &self,
        owner: &str,
        size: PtySize,
        directory: Option<cap_std::fs::Dir>,
    ) -> Result<TerminalStarted> {
        let mut slot = self.session.lock().map_err(|_| TerminalError::IoError)?;
        if self.shutting_down.load(Ordering::Relaxed) {
            return Err(TerminalError::SessionClosed);
        }
        if slot.is_some() {
            return Err(TerminalError::AlreadyRunning);
        }
        let (session, workspace_directory) = Session::start(owner, size, directory)?;
        let id = session.id.clone();
        *slot = Some(session);
        Ok(TerminalStarted {
            id,
            workspace_directory,
        })
    }

    fn with_session<T>(
        &self,
        owner: &str,
        id: &str,
        operation: impl FnOnce(&mut Option<Session>) -> Result<T>,
    ) -> Result<T> {
        let mut slot = self.session.lock().map_err(|_| TerminalError::IoError)?;
        match slot.as_ref() {
            Some(session) if session.owner != owner || session.id != id => {
                Err(TerminalError::PermissionDenied)
            }
            Some(_) => operation(&mut slot),
            None => Err(TerminalError::SessionClosed),
        }
    }
}

fn dimensions(rows: u16, cols: u16) -> Result<PtySize> {
    if !(1..=500).contains(&rows) || !(1..=500).contains(&cols) {
        return Err(TerminalError::InvalidSize);
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

async fn in_terminal<T: Send + 'static>(
    window: WebviewWindow,
    operation: impl FnOnce(WebviewWindow) -> Result<T> + Send + 'static,
) -> Result<T> {
    if window.label() != "main" {
        return Err(TerminalError::PermissionDenied);
    }
    tauri::async_runtime::spawn_blocking(move || operation(window))
        .await
        .map_err(|_| TerminalError::IoError)?
}

#[tauri::command]
pub async fn terminal_start(
    window: WebviewWindow,
    workspace_id: Option<String>,
    rows: u16,
    cols: u16,
) -> Result<TerminalStarted> {
    in_terminal(window, move |window| {
        let size = dimensions(rows, cols)?;
        let workspace = window.state::<WorkspaceService>();
        let registry = workspace.registry().map_err(|_| TerminalError::IoError)?;
        let directory = workspace_id
            .map(|id| registry.terminal_directory(window.label(), &id))
            .transpose()
            .map_err(|_| TerminalError::PermissionDenied)?;
        window
            .state::<TerminalService>()
            .start(window.label(), size, directory)
    })
    .await
}

#[tauri::command]
pub async fn terminal_read(window: WebviewWindow, id: String) -> Result<TerminalOutput> {
    in_terminal(window, move |window| {
        window
            .state::<TerminalService>()
            .with_session(window.label(), &id, |slot| {
                let result = slot.as_mut().ok_or(TerminalError::SessionClosed)?.read();
                if result.as_ref().map_or(true, |output| output.finished) {
                    slot.take();
                }
                result
            })
    })
    .await
}

#[tauri::command]
pub async fn terminal_input(window: WebviewWindow, id: String, data: Vec<u8>) -> Result<()> {
    if data.len() > CHUNK {
        return Err(TerminalError::InputTooLarge);
    }
    in_terminal(window, move |window| {
        window
            .state::<TerminalService>()
            .with_session(window.label(), &id, |slot| {
                let input = slot
                    .as_ref()
                    .and_then(|session| session.input.as_ref())
                    .ok_or(TerminalError::SessionClosed)?;
                input.try_send(data).map_err(|error| match error {
                    TrySendError::Full(_) => TerminalError::InputBusy,
                    TrySendError::Disconnected(_) => TerminalError::SessionClosed,
                })
            })
    })
    .await
}

#[tauri::command]
pub async fn terminal_resize(
    window: WebviewWindow,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<()> {
    let size = dimensions(rows, cols)?;
    in_terminal(window, move |window| {
        window
            .state::<TerminalService>()
            .with_session(window.label(), &id, |slot| {
                slot.as_ref()
                    .and_then(|session| session.master.as_ref())
                    .ok_or(TerminalError::SessionClosed)?
                    .resize(size)
                    .map_err(|_| TerminalError::IoError)
            })
    })
    .await
}

#[tauri::command]
pub async fn terminal_close(window: WebviewWindow, id: String) -> Result<()> {
    in_terminal(window, move |window| {
        window
            .state::<TerminalService>()
            .with_session(window.label(), &id, |slot| {
                slot.take();
                Ok(())
            })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output_until(
        service: &TerminalService,
        id: &str,
        accept: impl Fn(&[u8], &TerminalOutput) -> bool,
    ) -> TerminalOutput {
        let until = Instant::now() + Duration::from_secs(10);
        let mut bytes = Vec::new();
        loop {
            let output = service
                .with_session("main", id, |slot| {
                    let output = slot.as_mut().unwrap().read()?;
                    if output.finished {
                        slot.take();
                    }
                    Ok(output)
                })
                .unwrap();
            bytes.extend_from_slice(&output.bytes);
            if accept(&bytes, &output) {
                return output;
            }
            assert!(
                !output.finished && Instant::now() < until,
                "terminal output deadline"
            );
            thread::sleep(Duration::from_millis(15));
        }
    }

    fn send(service: &TerminalService, id: &str, input: &[u8]) {
        service
            .with_session("main", id, |slot| {
                slot.as_ref()
                    .unwrap()
                    .input
                    .as_ref()
                    .unwrap()
                    .try_send(input.to_vec())
                    .unwrap();
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn validates_dimensions_before_opening_a_pty() {
        assert!(matches!(dimensions(0, 80), Err(TerminalError::InvalidSize)));
        assert!(matches!(
            dimensions(24, 501),
            Err(TerminalError::InvalidSize)
        ));
        assert_eq!(dimensions(24, 80).unwrap().cols, 80);
    }

    #[test]
    fn shell_round_trips_input_and_output_and_reports_exit() {
        let service = TerminalService::default();
        let started = service
            .start("main", dimensions(24, 80).unwrap(), None)
            .unwrap();
        assert!(!started.workspace_directory);
        assert_eq!(
            service
                .start("main", dimensions(24, 80).unwrap(), None)
                .unwrap_err(),
            TerminalError::AlreadyRunning
        );
        for (owner, id) in [("other", started.id.as_str()), ("main", "stale")] {
            assert_eq!(
                service.with_session(owner, id, |_| Ok(())).unwrap_err(),
                TerminalError::PermissionDenied
            );
        }
        service
            .with_session("main", &started.id, |slot| {
                let master = slot.as_ref().unwrap().master.as_ref().unwrap();
                master.resize(dimensions(29, 91)?).unwrap();
                let size = master.get_size().unwrap();
                assert_eq!((size.rows, size.cols), (29, 91));
                Ok(())
            })
            .unwrap();

        send(&service, &started.id, b"echo TURING-PTY-HELLO\r");
        let needle = b"\nTURING-PTY-HELLO\r";
        output_until(&service, &started.id, |bytes, _| {
            bytes.windows(needle.len()).any(|window| window == needle)
        });
        send(&service, &started.id, b"exit 7\r");
        let output = output_until(&service, &started.id, |_, output| output.finished);
        assert_eq!(output.exit_code, Some(7));
        assert_eq!(
            service
                .with_session("main", &started.id, |_| Ok(()))
                .unwrap_err(),
            TerminalError::SessionClosed
        );
    }

    #[cfg(unix)]
    #[test]
    fn starts_in_the_approved_handle_even_after_path_replacement() {
        use crate::workspace::Registry;
        use std::fs;

        let temp = tempfile::tempdir().unwrap();
        let approved = temp.path().join("approved");
        fs::create_dir(&approved).unwrap();
        fs::write(approved.join("marker"), b"TURING-APPROVED\n").unwrap();
        let retained = {
            let mut registry = Registry::default();
            registry.register("main", &approved).unwrap();
            assert!(registry.terminal_directory("other", "1").is_err());
            assert!(registry.terminal_directory("main", "2").is_err());
            registry.terminal_directory("main", "1").unwrap()
        };
        let moved = temp.path().join("moved");
        fs::rename(&approved, &moved).unwrap();
        fs::create_dir(&approved).unwrap();
        fs::write(approved.join("marker"), b"TURING-REPLACEMENT\n").unwrap();

        let service = TerminalService::default();
        let started = service
            .start("main", dimensions(24, 100).unwrap(), Some(retained))
            .unwrap();
        assert!(started.workspace_directory);
        send(&service, &started.id, b"/bin/cat marker\r");
        output_until(&service, &started.id, |bytes, _| {
            assert!(!bytes
                .windows(b"TURING-REPLACEMENT".len())
                .any(|window| window == b"TURING-REPLACEMENT"));
            bytes
                .windows(b"TURING-APPROVED".len())
                .any(|window| window == b"TURING-APPROVED")
        });
    }

    #[test]
    fn shutdown_closes_workers_and_prevents_new_sessions() {
        let service = TerminalService::default();
        let started = service
            .start("main", dimensions(24, 80).unwrap(), None)
            .unwrap();
        #[cfg(unix)]
        let pid = service
            .with_session("main", &started.id, |slot| {
                Ok(slot.as_ref().unwrap().child.process_id().unwrap() as libc::pid_t)
            })
            .unwrap();
        service.shutdown();
        #[cfg(unix)]
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            service
                .with_session("main", &started.id, |_| Ok(()))
                .unwrap_err(),
            TerminalError::SessionClosed
        );
        assert_eq!(
            service
                .start("main", dimensions(24, 80).unwrap(), None)
                .unwrap_err(),
            TerminalError::SessionClosed
        );
    }

    #[cfg(unix)]
    #[test]
    fn closes_a_session_while_output_is_backpressured() {
        let service = TerminalService::default();
        let started = service
            .start("main", dimensions(24, 80).unwrap(), None)
            .unwrap();
        send(&service, &started.id, b"exec /usr/bin/yes TURING-BURST\r");
        output_until(&service, &started.id, |bytes, output| {
            assert!(output.bytes.len() <= CHUNK * OUTPUT_BATCH);
            bytes.len() > CHUNK * OUTPUT_BATCH
        });
        thread::sleep(Duration::from_millis(50));
        service
            .with_session("main", &started.id, |slot| {
                slot.take();
                Ok(())
            })
            .unwrap();
        assert_eq!(
            service
                .with_session("main", &started.id, |_| Ok(()))
                .unwrap_err(),
            TerminalError::SessionClosed
        );
    }
}
