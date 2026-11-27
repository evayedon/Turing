use super::{ExecutionError, Progress, Result, State, Stream};
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
fn prepare(command: &mut Command, _: &Dir, cwd_path: &Path) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    command
        .current_dir(cwd_path)
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
    loop {
        match pipe.read(buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(0),
            result => return result,
        }
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
) -> Result<Option<String>> {
    let captured = Progress::new(None);
    let status = supervise(
        command,
        cwd,
        staging,
        &captured,
        &progress.stopped,
        false,
        // Cold compiler starts on a busy machine (CI runners, antivirus scans)
        // can exceed 5 s; Stop still interrupts the probe immediately.
        Duration::from_secs(20),
    )?;
    if !status.is_some_and(|status| status.success()) {
        return Ok(None);
    }
    let state = captured.state();
    Ok(version_output(&state))
}

fn version_output(state: &State) -> Option<String> {
    if state.truncated {
        return None;
    }
    // Keep warnings on stderr from corrupting a version printed on stdout.
    // Some tools (including Java 8) print the version to stderr instead.
    let stdout: Vec<_> = state
        .output
        .iter()
        .filter(|chunk| matches!(chunk.stream, Stream::Stdout))
        .flat_map(|chunk| chunk.bytes.iter().copied())
        .collect();
    let output = if stdout.iter().all(u8::is_ascii_whitespace) {
        state
            .output
            .iter()
            .filter(|chunk| matches!(chunk.stream, Stream::Stderr))
            .flat_map(|chunk| chunk.bytes.iter().copied())
            .collect()
    } else {
        stdout
    };
    Some(String::from_utf8_lossy(&output).into_owned())
}

pub(super) fn supervise(
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
        Err(_) if exited_during_job_assignment(&child) => None,
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

#[cfg(windows)]
fn exited_during_job_assignment(child: &Child) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject};

    // Assignment can lose a race to a short-lived child that has begun
    // exiting but whose process handle is not yet signalled. Do not continue
    // with a live process outside the job.
    unsafe { WaitForSingleObject(child.as_raw_handle(), 50) == WAIT_OBJECT_0 }
}

#[cfg(unix)]
trait OutputPipe: Read + std::os::fd::AsRawFd {}
#[cfg(unix)]
impl<T: Read + std::os::fd::AsRawFd> OutputPipe for T {}
#[cfg(windows)]
trait OutputPipe: Read + std::os::windows::io::AsRawHandle {}
#[cfg(windows)]
impl<T: Read + std::os::windows::io::AsRawHandle> OutputPipe for T {}

fn collect(
    child: &mut Child,
    progress: &Progress,
    stopped: &AtomicBool,
    building: bool,
    timeout: Duration,
) -> Result<Option<ExitStatus>> {
    let stdout = child.stdout.take().ok_or(ExecutionError::Internal)?;
    let stderr = child.stderr.take().ok_or(ExecutionError::Internal)?;
    collect_output(
        stdout,
        stderr,
        || child.try_wait(),
        progress,
        stopped,
        building,
        timeout,
    )
}

#[cfg(windows)]
pub(super) fn supervise_container(
    child: super::sandbox::windows::ContainerChild,
    progress: &Progress,
    stopped: &AtomicBool,
    timeout: Duration,
) -> Result<Option<ExitStatus>> {
    let super::sandbox::windows::ContainerChild {
        process,
        stdout,
        stderr,
        job: _job,
    } = child;
    collect_output(
        stdout,
        stderr,
        || super::sandbox::windows::try_wait(&process),
        progress,
        stopped,
        false,
        timeout,
    )
}

fn collect_output(
    mut stdout: impl OutputPipe,
    mut stderr: impl OutputPipe,
    mut try_wait: impl FnMut() -> io::Result<Option<ExitStatus>>,
    progress: &Progress,
    stopped: &AtomicBool,
    building: bool,
    timeout: Duration,
) -> Result<Option<ExitStatus>> {
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
            exit = try_wait()
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
    fn version_probe_keeps_stdout_and_stderr_separate() {
        let captured = Progress::new(None);
        captured.record(Stream::Stderr, b"warning\n");
        captured.record(Stream::Stdout, b"ver");
        captured.record(Stream::Stderr, b"another warning\n");
        captured.record(Stream::Stdout, b"sion\n");
        assert_eq!(
            version_output(&captured.state()).as_deref(),
            Some("version\n")
        );

        let captured = Progress::new(None);
        captured.record(Stream::Stdout, b" \r\n");
        captured.record(Stream::Stderr, b"version\n");
        assert_eq!(
            version_output(&captured.state()).as_deref(),
            Some("version\n")
        );
    }

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
