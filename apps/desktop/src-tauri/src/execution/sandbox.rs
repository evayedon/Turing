//! OS isolation for agent verification. Unsupported hosts report unavailability
//! so the caller can require a separate approval for an unsandboxed run.

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;

use std::{path::Path, process::Command};

use super::ExecutionError;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::{baseline_env, process, Progress};

pub(crate) enum Availability {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    Available(Sandbox),
    Unavailable(&'static str),
}

pub(crate) struct Sandbox {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    policy: platform::Policy,
}

impl Sandbox {
    pub(crate) fn detect(
        workspace: &Path,
        temp: &Path,
        home: Option<&Path>,
        program: &Path,
        network: bool,
    ) -> Availability {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            use cap_std::{ambient_authority, fs::Dir};
            use std::{sync::atomic::AtomicBool, time::Duration};

            let probe = |policy: platform::Policy| {
                let cwd = Dir::open_ambient_dir(workspace, ambient_authority()).ok()?;
                if !policy.matches(&cwd, workspace, temp, program, network) {
                    return None;
                }
                let mut command = policy.command(&cwd, &["--version".into()]).ok()?;
                let path = std::env::var_os("PATH").unwrap_or_default();
                baseline_env(&mut command, &path, temp);
                let status = process::supervise(
                    &mut command,
                    &cwd,
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
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let _ = (workspace, temp, home, program, network);
            Availability::Unavailable("Agent test isolation is unavailable on this platform")
        }
    }

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
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
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
            let workspace = root
                .path()
                .join(r#"workspace") (allow file-write* (subpath "#);
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
            match Sandbox::detect(
                &self.workspace,
                &self.temp,
                Some(&self.home),
                &self.node,
                network,
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
        fs::rename(&fixture.workspace, fixture.root.path().join("moved")).unwrap();
        fs::create_dir(&fixture.workspace).unwrap();

        assert!(sandbox
            .command(
                &cwd,
                &fixture.workspace,
                &fixture.temp,
                &fixture.node,
                false,
                &[],
            )
            .is_err());
    }

    #[test]
    fn network_access_requires_the_network_policy() {
        let fixture = Fixture::new();
        let Some(offline) = fixture.detect(false) else {
            return;
        };
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
        let result = fixture.run(&online, true, &script, &[]);
        assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
        assert!(listener.accept().is_ok());
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
            "const socket = require('dgram').createSocket('udp4');              socket.send('probe', {port}, '127.0.0.1', error => {{ socket.close(); process.exit(error ? 1 : 0); }});"
        );
        let result = fixture.run(&sandbox, false, &script, &[]);
        assert_eq!(result.exit_code, Some(1), "{}", result.stderr);
        assert_eq!(
            receiver.recv(&mut [0; 5]).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
        );
    }
}
