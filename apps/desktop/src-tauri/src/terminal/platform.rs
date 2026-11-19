use super::{Profile, Result, TerminalError};
use cap_std::fs::Dir;
use portable_pty::{Child, MasterPty, PtyPair};
use std::io::Read;

pub struct StartedShell {
    pub child: Box<dyn Child + Send + Sync>,
    pub in_workspace: bool,
    pub name: String,
    pub startup: Option<tempfile::TempDir>,
}

#[cfg(unix)]
pub struct ProcessGuard;

#[cfg(unix)]
pub fn guard(_: &dyn Child) -> Result<ProcessGuard> {
    Ok(ProcessGuard)
}

#[cfg(unix)]
pub fn reader(master: &dyn MasterPty) -> Result<Box<dyn Read + Send>> {
    use std::os::fd::FromRawFd;

    let fd = master.as_raw_fd().ok_or(TerminalError::PtyUnavailable)?;
    // Both PTY streams share these file status flags. A nonblocking write
    // can be canceled even if the shell stops reading.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(TerminalError::PtyUnavailable);
    }
    let fd = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if fd < 0 {
        return Err(TerminalError::PtyUnavailable);
    }
    Ok(Box::new(UnixReader(unsafe {
        std::fs::File::from_raw_fd(fd)
    })))
}

#[cfg(unix)]
struct UnixReader(std::fs::File);

#[cfg(unix)]
impl Read for UnixReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        use std::{io, os::fd::AsRawFd};

        // Poll with a deadline so an idle PTY wakes promptly on output or
        // allows its reader to stop even when a descendant holds the slave.
        let mut ready = libc::pollfd {
            fd: self.0.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        match unsafe { libc::poll(&mut ready, 1, 100) } {
            -1 => Err(io::Error::last_os_error()),
            0 => Err(io::ErrorKind::WouldBlock.into()),
            _ => match self.0.read(buffer) {
                Err(error) if error.raw_os_error() == Some(libc::EIO) => Ok(0),
                result => result,
            },
        }
    }
}

#[cfg(unix)]
pub fn spawn(pair: &PtyPair, directory: Option<Dir>, profile: Profile) -> Result<StartedShell> {
    use std::{
        fs::OpenOptions,
        io,
        os::{
            fd::AsRawFd,
            unix::{
                fs::{FileTypeExt, OpenOptionsExt},
                process::CommandExt,
            },
        },
        path::{Path, PathBuf},
        process::Command,
    };

    let tty = pair
        .master
        .tty_name()
        .ok_or(TerminalError::PtyUnavailable)?;
    let slave = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOCTTY | libc::O_NOFOLLOW)
        .open(tty)
        .map_err(|_| TerminalError::PtyUnavailable)?;
    if !slave
        .metadata()
        .map_err(|_| TerminalError::PtyUnavailable)?
        .file_type()
        .is_char_device()
    {
        return Err(TerminalError::PtyUnavailable);
    }

    let workspace_directory = directory.is_some();
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
        .unwrap_or_else(|| PathBuf::from("/"));
    let configured = std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file());
    let fallback = if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    };
    let candidates: Vec<&Path> = match profile {
        Profile::System => configured
            .iter()
            .map(PathBuf::as_path)
            .chain([Path::new(fallback), Path::new("/bin/sh")])
            .collect(),
        Profile::Bash => vec![Path::new("/bin/bash")],
        Profile::Zsh => vec![Path::new("/bin/zsh")],
        Profile::Sh => vec![Path::new("/bin/sh")],
        _ => return Err(TerminalError::ShellUnavailable),
    };

    for executable in candidates {
        let mut command = Command::new(executable);
        command
            .arg("-i")
            .current_dir(&home)
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .env_remove("PWD")
            .env_remove("OLDPWD")
            .stdin(
                slave
                    .try_clone()
                    .map_err(|_| TerminalError::PtyUnavailable)?,
            )
            .stdout(
                slave
                    .try_clone()
                    .map_err(|_| TerminalError::PtyUnavailable)?,
            )
            .stderr(
                slave
                    .try_clone()
                    .map_err(|_| TerminalError::PtyUnavailable)?,
            );

        let startup = if executable.file_name() == Some(std::ffi::OsStr::new("zsh")) {
            prepare_zsh_integration(&mut command, std::env::var_os("ZDOTDIR").as_deref()).ok()
        } else {
            None
        };
        let cwd = directory.as_ref().map(AsRawFd::as_raw_fd);
        // The directory descriptor stays alive through spawn and is close-on-exec.
        // The child uses only async-signal-safe operations before exec.
        unsafe {
            command.pre_exec(move || {
                if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                if let Some(fd) = cwd {
                    if libc::fchdir(fd) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        if let Ok(child) = command.spawn() {
            return Ok(StartedShell {
                child: Box::new(child),
                in_workspace: workspace_directory,
                name: executable
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Shell")
                    .to_owned(),
                startup,
            });
        }
    }
    Err(TerminalError::ShellUnavailable)
}

#[cfg(unix)]
fn prepare_zsh_integration(
    command: &mut std::process::Command,
    user_zdotdir: Option<&std::ffi::OsStr>,
) -> std::io::Result<tempfile::TempDir> {
    let startup = tempfile::Builder::new().prefix("turing-zsh-").tempdir()?;
    std::fs::write(
        startup.path().join(".zshenv"),
        include_bytes!("zsh-startup.zsh"),
    )?;
    std::fs::write(
        startup.path().join(".zshrc"),
        include_bytes!("shell-integration.zsh"),
    )?;
    command
        .env("ZDOTDIR", startup.path())
        .env_remove("TURING_ZSH_USER_ZDOTDIR");
    if let Some(original) = user_zdotdir {
        command.env("TURING_ZSH_USER_ZDOTDIR", original);
    }
    Ok(startup)
}

#[cfg(all(test, target_os = "macos"))]
#[test]
fn zsh_integration_survives_a_profile_that_replaces_hook_arrays() {
    let user_config = tempfile::tempdir().unwrap();
    std::fs::write(user_config.path().join(".zshenv"), "from_zshenv=loaded\n").unwrap();
    std::fs::write(
        user_config.path().join(".zshrc"),
        "precmd_functions=()\npreexec_functions=()\nfrom_zshrc=loaded\n",
    )
    .unwrap();
    let mut command = std::process::Command::new("/bin/zsh");
    let _startup =
        prepare_zsh_integration(&mut command, Some(user_config.path().as_os_str())).unwrap();
    let output = command
        .args([
            "-i",
            "-c",
            r#"[[ $from_zshenv == loaded && $from_zshrc == loaded &&
        ${precmd_functions[1]} == _turing_precmd &&
        ${preexec_functions[1]} == _turing_preexec &&
        -r "$ZDOTDIR/.zshrc" ]]"#,
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "zsh skipped its user configuration or integration hooks"
    );
}

#[cfg(unix)]
pub fn terminate(master: Option<&(dyn MasterPty + Send)>, child: &mut dyn Child) {
    if let Some(pid) = child.process_id() {
        // Only signal while the shell PID is still reserved by the unreaped child.
        if let Some(foreground) = master.and_then(MasterPty::process_group_leader) {
            unsafe { libc::kill(-foreground, libc::SIGKILL) };
        }
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
pub struct ProcessGuard(std::os::windows::io::OwnedHandle);

#[cfg(windows)]
impl Drop for ProcessGuard {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) };
    }
}

#[cfg(windows)]
pub fn guard(child: &dyn Child) -> Result<ProcessGuard> {
    use std::{
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if handle.is_null() {
        return Err(TerminalError::PtyUnavailable);
    }
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let shell = child.as_raw_handle().ok_or(TerminalError::PtyUnavailable)?;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        ) == 0
            || AssignProcessToJobObject(job.as_raw_handle(), shell) == 0
    } {
        return Err(TerminalError::PtyUnavailable);
    }
    Ok(ProcessGuard(job))
}

#[cfg(windows)]
pub fn reader(master: &dyn MasterPty) -> Result<Box<dyn Read + Send>> {
    master
        .try_clone_reader()
        .map_err(|_| TerminalError::PtyUnavailable)
}

#[cfg(windows)]
pub fn spawn(pair: &PtyPair, _: Option<Dir>, profile: Profile) -> Result<StartedShell> {
    use portable_pty::CommandBuilder;
    use std::path::PathBuf;

    let system = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
        .ok_or(TerminalError::ShellUnavailable)?;
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
        .unwrap_or_else(|| system.clone());
    let system32 = system.join("System32");
    let candidates: [(_, &[_]); 2] = [
        (
            system32.join("WindowsPowerShell/v1.0/powershell.exe"),
            &["-NoLogo", "-NoProfile"],
        ),
        (system32.join("cmd.exe"), &["/D"]),
    ];
    let candidates = match profile {
        Profile::System => &candidates[..],
        Profile::PowerShell => &candidates[..1],
        Profile::Cmd => &candidates[1..],
        _ => return Err(TerminalError::ShellUnavailable),
    };
    for (exe, args) in candidates {
        if !exe.is_file() {
            continue;
        }
        let mut command = CommandBuilder::new(exe);
        command.args(args.iter().copied());
        command.cwd(&home);
        command.env("TERM", "xterm-256color");
        if let Ok(child) = pair.slave.spawn_command(command) {
            return Ok(StartedShell {
                child,
                in_workspace: false,
                name: if exe.ends_with("cmd.exe") {
                    "Command Prompt"
                } else {
                    "PowerShell"
                }
                .into(),
                startup: None,
            });
        }
    }
    Err(TerminalError::ShellUnavailable)
}

#[cfg(windows)]
pub fn terminate(_: Option<&(dyn MasterPty + Send)>, child: &mut dyn Child) {
    let _ = child.clone_killer().kill();
}
