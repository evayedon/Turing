//! OS isolation for agent verification. Unsupported hosts report unavailability
//! so the caller can require a separate approval for an unsandboxed run.

// Sandbox detection is wired into the production task loop in Task 10.
#![cfg_attr(not(test), allow(dead_code))]

#[cfg(target_os = "macos")]
mod macos;

#[cfg(windows)]
pub(super) mod windows;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;

use std::{io, path::Path, process::Command};
use uuid::Uuid;

pub(crate) struct TaskGrants<'a> {
    pub task_id: Uuid,
    pub record: &'a mut dyn FnMut(&Path) -> io::Result<()>,
}

pub(crate) fn revoke_grants(task: Uuid, grants: &[String]) -> io::Result<()> {
    #[cfg(windows)]
    return windows::revoke(task, grants);
    #[cfg(not(windows))]
    {
        let _ = (task, grants);
        Ok(())
    }
}

use super::ExecutionError;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::{baseline_env, process, Progress};

pub(crate) enum Availability {
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    Available(Sandbox),
    Unavailable(&'static str),
}

pub(crate) struct Sandbox {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    policy: platform::Policy,
    #[cfg(windows)]
    policy: windows::Policy,
}

impl Sandbox {
    pub(crate) fn label(&self) -> &'static str {
        #[cfg(target_os = "macos")]
        return "macOS sandbox-exec";
        #[cfg(target_os = "linux")]
        return self.policy.label();
        #[cfg(windows)]
        return "Windows AppContainer";
        #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
        return "Unavailable";
    }

    pub(crate) fn detect(
        cwd: &cap_std::fs::Dir,
        workspace: &Path,
        temp: &Path,
        home: Option<&Path>,
        program: &Path,
        network: bool,
        grants: TaskGrants<'_>,
    ) -> Availability {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let _ = (grants.task_id, grants.record);
            use std::{sync::atomic::AtomicBool, time::Duration};

            let probe = |policy: platform::Policy| {
                if !policy.matches(cwd, workspace, temp, program, network) {
                    return None;
                }
                let mut command = policy.command(cwd, &["--version".into()]).ok()?;
                let path = std::env::var_os("PATH").unwrap_or_default();
                baseline_env(&mut command, &path, temp);
                let status = process::supervise(
                    &mut command,
                    cwd,
                    workspace,
                    &Progress::new(None),
                    &AtomicBool::new(false),
                    false,
                    Duration::from_secs(5),
                )
                .ok()??;
                status.success().then_some(Self { policy })
            };
            match platform::policies(workspace, temp, home, program, network).find_map(probe) {
                Some(sandbox) => Availability::Available(sandbox),
                None => Availability::Unavailable(platform::UNAVAILABLE),
            }
        }
        #[cfg(windows)]
        {
            use std::{sync::atomic::AtomicBool, time::Duration};

            let mut probe = || -> io::Result<Self> {
                let policy = windows::Policy::new(
                    grants.task_id,
                    cwd,
                    workspace,
                    temp,
                    home,
                    program,
                    network,
                    grants.record,
                )?;
                let mut command = Command::new(program);
                command.arg("--version");
                let path = std::env::var_os("PATH").unwrap_or_default();
                super::baseline_env(&mut command, &path, temp);
                let child = policy.spawn(&command)?;
                let status = super::process::supervise_container(
                    child,
                    &super::Progress::new(None),
                    &AtomicBool::new(false),
                    Duration::from_secs(20),
                )
                .map_err(|error| io::Error::other(format!("{error:?}")))?;
                if status.is_some_and(|status| status.success()) {
                    Ok(Self { policy })
                } else {
                    Err(io::Error::other(format!(
                        "version probe returned {status:?}"
                    )))
                }
            };
            match probe() {
                Ok(sandbox) => Availability::Available(sandbox),
                Err(error) => {
                    #[cfg(test)]
                    eprintln!("AppContainer self-check: {error}");
                    #[cfg(not(test))]
                    let _ = error;
                    Availability::Unavailable("AppContainer could not run the verification program")
                }
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
        {
            let _ = (cwd, workspace, temp, home, program, network, grants);
            Availability::Unavailable("Agent test isolation is unavailable on this platform")
        }
    }

    #[cfg(not(windows))]
    pub(super) fn command(
        &self,
        cwd: &cap_std::fs::Dir,
        workspace: &Path,
        temp: &Path,
        program: &Path,
        network: bool,
        args: &[String],
    ) -> Result<Command, ExecutionError> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if self.policy.matches(cwd, workspace, temp, program, network) {
            return self
                .policy
                .command(cwd, args)
                .map_err(|_| ExecutionError::ProcessUnavailable);
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let _ = (cwd, workspace, temp, program, network, args);
        Err(ExecutionError::ProcessUnavailable)
    }
    #[cfg(windows)]
    pub(super) fn run_windows(
        &self,
        run: &super::argv::ArgvRun<'_>,
        command: &Command,
        progress: &super::Progress,
    ) -> Result<Option<std::process::ExitStatus>, ExecutionError> {
        if run.stopped.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(None);
        }
        if !self.policy.matches(
            run.cwd,
            run.cwd_path,
            run.temp,
            Path::new(command.get_program()),
            run.network,
        ) {
            return Err(ExecutionError::ProcessUnavailable);
        }
        let child = self
            .policy
            .spawn(command)
            .map_err(|_| ExecutionError::ProcessUnavailable)?;
        super::process::supervise_container(child, progress, run.stopped, run.timeout)
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux", windows)))]
mod conformance {
    use super::*;
    use crate::execution::argv::{resolve_program, run_argv, ArgvOutcome, ArgvRun};
    use cap_std::{ambient_authority, fs::Dir};
    use std::{fs, net::TcpListener, sync::atomic::AtomicBool, time::Duration};

    struct Fixture {
        root: tempfile::TempDir,
        workspace: std::path::PathBuf,
        temp: std::path::PathBuf,
        home: std::path::PathBuf,
        node: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            #[cfg(not(windows))]
            let workspace = root
                .path()
                .join(r#"workspace") (allow file-write* (subpath "#);
            #[cfg(windows)]
            let workspace = root.path().join("workspace with spaces");
            let temp = root.path().join("scratch");
            let home = root.path().join("home");
            for path in [&workspace, &temp, &home] {
                fs::create_dir(path).unwrap();
            }
            let node = resolve_program("node", std::env::var_os("PATH").as_deref()).unwrap();
            Self {
                root,
                workspace,
                temp,
                home,
                node,
            }
        }

        fn detect(&self, network: bool) -> Option<Sandbox> {
            let cwd = Dir::open_ambient_dir(&self.workspace, ambient_authority()).unwrap();
            match Sandbox::detect(
                &cwd,
                &self.workspace,
                &self.temp,
                Some(&self.home),
                &self.node,
                network,
                TaskGrants {
                    task_id: Uuid::new_v4(),
                    record: &mut |_| Ok(()),
                },
            ) {
                Availability::Available(sandbox) => Some(sandbox),
                Availability::Unavailable(reason) => {
                    assert!(
                        std::env::var_os("TURING_CI_REQUIRE_SANDBOX").as_deref()
                            != Some(std::ffi::OsStr::new("1")),
                        "{reason}"
                    );
                    eprintln!("Sandbox conformance skipped: {reason}");
                    None
                }
            }
        }

        fn run(
            &self,
            sandbox: &Sandbox,
            network: bool,
            script: &str,
            args: &[&Path],
        ) -> ArgvOutcome {
            let mut argv = vec!["node".into(), "-e".into(), script.into()];
            argv.extend(args.iter().map(|path| path.to_str().unwrap().to_owned()));
            run_argv(ArgvRun {
                argv: &argv,
                cwd: &Dir::open_ambient_dir(&self.workspace, ambient_authority()).unwrap(),
                cwd_path: &self.workspace,
                temp: &self.temp,
                timeout: Duration::from_secs(5),
                network,
                sandbox: Some(sandbox),
                stopped: &AtomicBool::new(false),
            })
            .unwrap()
        }
    }

    #[test]
    fn confines_writes_and_reads_with_parameterized_paths() {
        let fixture = Fixture::new();
        let Some(sandbox) = fixture.detect(false) else {
            return;
        };
        let outside = fixture.root.path().join("outside");
        let credential = fixture.home.join(".ssh/key");
        fs::create_dir(credential.parent().unwrap()).unwrap();
        fs::write(&credential, "test fixture").unwrap();

        let write = "require('fs').writeFileSync(process.argv[1], 'probe')";
        let inside = fixture.workspace.join("inside");
        let result = fixture.run(&sandbox, false, write, &[&inside]);
        assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
        assert!(result.sandboxed);
        assert!(inside.is_file());

        let result = fixture.run(&sandbox, false, write, &[&outside]);
        assert!(result.exit_code.is_some_and(|code| code != 0));
        assert!(!outside.exists());
        for path in [&credential, &fixture.root.path().join("outside-secret")] {
            fs::write(path, "test fixture").unwrap();
            let result = fixture.run(
                &sandbox,
                false,
                "require('fs').readFileSync(process.argv[1])",
                &[path],
            );
            assert!(result.exit_code.is_some_and(|code| code != 0));
            assert!(result.stderr.contains("EPERM") || result.stderr.contains("EACCES"));
        }
    }

    #[test]
    fn refuses_a_replaced_workspace_before_launch() {
        let fixture = Fixture::new();
        let Some(sandbox) = fixture.detect(false) else {
            return;
        };
        let cwd = Dir::open_ambient_dir(&fixture.workspace, ambient_authority()).unwrap();
        let moved = fixture.root.path().join("moved");
        #[cfg(windows)]
        {
            assert!(fs::rename(&fixture.workspace, moved).is_err());
            drop(sandbox);
            drop(cwd);
            fs::rename(&fixture.workspace, fixture.root.path().join("moved")).unwrap();
        }
        #[cfg(not(windows))]
        {
            fs::rename(&fixture.workspace, moved).unwrap();
            fs::create_dir(&fixture.workspace).unwrap();
            assert!(sandbox
                .command(
                    &cwd,
                    &fixture.workspace,
                    &fixture.temp,
                    &fixture.node,
                    false,
                    &[]
                )
                .is_err());
        }
    }

    #[test]
    fn network_access_requires_the_network_policy() {
        let fixture = Fixture::new();
        let Some(offline) = fixture.detect(false) else {
            return;
        };
        #[cfg(not(windows))]
        let online = fixture.detect(true).expect("online sandbox self-check");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let script = format!(
            "require('net').connect({port}, '127.0.0.1').on('connect', () => process.exit(0))"
        );
        let result = fixture.run(&offline, false, &script, &[]);
        assert!(result.exit_code.is_some_and(|code| code != 0));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        // AppContainer's internetClient capability does not exempt loopback.
        #[cfg(not(windows))]
        {
            let result = fixture.run(&online, true, &script, &[]);
            assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
            assert!(listener.accept().is_ok());
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn offline_linux_policy_blocks_datagrams() {
        use std::net::UdpSocket;

        let fixture = Fixture::new();
        let Some(sandbox) = fixture.detect(false) else {
            return;
        };
        let receiver = UdpSocket::bind("127.0.0.1:0").unwrap();
        receiver.set_nonblocking(true).unwrap();
        let port = receiver.local_addr().unwrap().port();
        let script = format!(
            r#"
            const socket = require('dgram').createSocket('udp4');
            function finish(error) {{
                if (error) console.error('UDP probe:', error.code);
                process.exit(error ? 1 : 0);
            }}
            socket.on('error', finish);
            socket.send('probe', {port}, '127.0.0.1', finish);
            "#
        );
        let result = fixture.run(&sandbox, false, &script, &[]);
        assert_eq!(result.exit_code, Some(1), "{}", result.stderr);
        assert!(
            result.stderr.contains("UDP probe: EPERM")
                || result.stderr.contains("UDP probe: EACCES"),
            "{}",
            result.stderr
        );
        assert_eq!(
            receiver.recv(&mut [0; 5]).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
        );
    }
}
