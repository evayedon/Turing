use super::{ExecutionError, Progress, Result, Stream};
use cap_std::fs::Dir;
use std::{
    io::{self, Read},
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicBool, Ordering::Relaxed},
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
fn prepare(command: &mut Command, cwd: &Dir, _: &Path) {
    use std::os::{fd::AsRawFd, unix::process::CommandExt};
    let fd = cwd.as_raw_fd();
    command.process_group(0);
    // The authorized directory handle remains live until spawn returns.
    unsafe {
        command.pre_exec(move || {
            if libc::fchdir(fd) < 0 {
                return Err(io::Error::last_os_error());
            }
            let core = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            if libc::setrlimit(libc::RLIMIT_CORE, &core) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
fn prepare(command: &mut Command, _: &Dir, staging: &Path) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    command
        .current_dir(staging)
        .creation_flags(CREATE_NO_WINDOW);
}

#[cfg(unix)]
fn configure(pipe: &impl std::os::fd::AsRawFd) -> io::Result<()> {
    let fd = pipe.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn configure(_: &impl Read) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn available(pipe: &mut impl Read, buffer: &mut [u8]) -> io::Result<usize> {
    match pipe.read(buffer) {
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ) =>
        {
            Ok(0)
        }
        result => result,
    }
}

#[cfg(windows)]
fn available(
    pipe: &mut (impl Read + std::os::windows::io::AsRawHandle),
    buffer: &mut [u8],
) -> io::Result<usize> {
    use std::ptr::null_mut;
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;
    let mut bytes = 0;
    if unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle(),
            null_mut(),
            0,
            null_mut(),
            &mut bytes,
            null_mut(),
        )
    } == 0
    {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::BrokenPipe {
            Ok(0)
        } else {
            Err(error)
        };
    }
    // A zero-byte ReadFile on a pipe blocks until data arrives, which would
    // stall the loop on an idle stream while the other one fills up.
    if bytes == 0 {
        return Ok(0);
    }
    let len = buffer.len().min(bytes as usize);
    pipe.read(&mut buffer[..len])
}

fn terminate(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

pub(super) fn run(
    command: &mut Command,
    cwd: &Dir,
    staging: &Path,
    progress: &Progress,
    building: bool,
) -> Result<Option<ExitStatus>> {
    // Allow for cold compiles on shared CI hosts.
    let slack = if cfg!(test) { 4 } else { 1 };
    let timeout = Duration::from_secs(if building { 60 } else { 30 } * slack);
    supervise(
        command,
        cwd,
        staging,
        progress,
        &progress.stopped,
        building,
        timeout,
    )
}

pub(super) fn probe(
    command: &mut Command,
    cwd: &Dir,
    staging: &Path,
    progress: &Progress,
) -> Option<String> {
    let captured = Progress::new(None);
    let status = supervise(
        command,
        cwd,
        staging,
        &captured,
        &progress.stopped,
        false,
        Duration::from_secs(5),
    )
    .ok()??;
    if !status.success() {
        return None;
    }
    let state = captured.state();
    if state.truncated {
        return None;
    }
    let output: Vec<_> = state
        .output
        .iter()
        .flat_map(|chunk| chunk.bytes.iter().copied())
        .collect();
    Some(String::from_utf8_lossy(&output).into_owned())
}

fn supervise(
    command: &mut Command,
    cwd: &Dir,
    staging: &Path,
    progress: &Progress,
    stopped: &AtomicBool,
    building: bool,
    timeout: Duration,
) -> Result<Option<ExitStatus>> {
    if stopped.load(Relaxed) {
        return Ok(None);
    }
    prepare(command, cwd, staging);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| ExecutionError::ProcessUnavailable)?;
    #[cfg(windows)]
    let guard = match crate::terminal::platform::guard(&child) {
        Ok(guard) => Some(guard),
        Err(_) if matches!(child.try_wait(), Ok(Some(_))) => None,
        Err(_) => {
            terminate(&mut child);
            return Err(ExecutionError::ProcessUnavailable);
        }
    };
    let result = collect(&mut child, progress, stopped, building, timeout);
    #[cfg(windows)]
    drop(guard);
    if !matches!(result, Ok(Some(_))) {
        terminate(&mut child);
    }
    result
}

fn collect(
    child: &mut Child,
    progress: &Progress,
    stopped: &AtomicBool,
    building: bool,
    timeout: Duration,
) -> Result<Option<ExitStatus>> {
    let mut stdout = child.stdout.take().ok_or(ExecutionError::Internal)?;
    let mut stderr = child.stderr.take().ok_or(ExecutionError::Internal)?;
    configure(&stdout)
        .and_then(|_| configure(&stderr))
        .map_err(|_| ExecutionError::Internal)?;
    let (out, err) = if building {
        (Stream::BuildStdout, Stream::BuildStderr)
    } else {
        (Stream::Stdout, Stream::Stderr)
    };
    let started = Instant::now();
    let mut buffer = [0; 4096];
    let mut exit = None;
    loop {
        if stopped.load(Relaxed) {
            return Ok(None);
        }
        if started.elapsed() >= timeout {
            return Err(ExecutionError::TimedOut);
        }
        let written = available(&mut stdout, &mut buffer).map_err(|_| ExecutionError::Internal)?;
        progress.record(out, &buffer[..written]);
        let errors = available(&mut stderr, &mut buffer).map_err(|_| ExecutionError::Internal)?;
        progress.record(err, &buffer[..errors]);
        if let Some((status, at)) = exit {
            // An escaped descendant may keep the pipe open or continue writing.
            if written + errors == 0
                || Instant::now().duration_since(at) > Duration::from_millis(100)
            {
                return Ok(Some(status));
            }
        } else {
            exit = child
                .try_wait()
                .map_err(|_| ExecutionError::Internal)?
                .map(|status| (status, Instant::now()));
        }
        if written + errors == 0 && exit.is_none() {
            thread::sleep(Duration::from_millis(12));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{toolchain, Language};
    use super::*;

    #[test]
    fn timeout_terminates_a_live_process() {
        let path = std::env::var_os("PATH");
        let Ok(python) = toolchain::tool(Language::Python, path.as_deref()) else {
            eprintln!("skipping process timeout test: Python is unavailable");
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        let cwd = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
        let progress = Progress::new(None);
        let mut command = Command::new(python);
        command.args(["-I", "-c", "import time; time.sleep(20)"]);
        let start = Instant::now();
        assert_eq!(
            supervise(
                &mut command,
                &cwd,
                temp.path(),
                &progress,
                &progress.stopped,
                false,
                Duration::from_millis(100),
            ),
            Err(ExecutionError::TimedOut)
        );
        assert!(start.elapsed() < Duration::from_secs(10));
    }
}
