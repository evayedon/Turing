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

/// Node resolves the real path of every script and module by stat'ing each ancestor
/// directory, and an AppContainer cannot stat the drive root or the user profile. Node-family
/// programs therefore run unsandboxed on Windows, after the per-run unsandboxed approval.
pub(crate) const WINDOWS_NODE_UNSANDBOXED: &str = "Node cannot run in the Windows sandbox";

const NODE_FAMILY: &[&str] = &[
    "node", "npm", "npx", "pnpm", "pnpx", "yarn", "corepack", "bun", "bunx", "deno",
];

/// Matches the program's basename, case-insensitively, with or without a Windows shim suffix.
fn node_family(program: &Path) -> bool {
    let Some(name) = program
        .to_str()
        .and_then(|path| path.rsplit(['/', '\\']).next())
    else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    let name = [".exe", ".cmd", ".ps1"]
        .iter()
        .find_map(|suffix| name.strip_suffix(suffix))
        .unwrap_or(&name);
    NODE_FAMILY.contains(&name)
}

/// The one decision on whether a verification `program` runs sandboxed on this machine.
pub(crate) fn detect_for_program(
    cwd: &cap_std::fs::Dir,
    workspace: &Path,
    temp: &Path,
    home: Option<&Path>,
    program: &Path,
    network: bool,
    grants: TaskGrants<'_>,
) -> Availability {
    if cfg!(windows) && node_family(program) {
        return Availability::Unavailable(WINDOWS_NODE_UNSANDBOXED);
    }
    Sandbox::detect(cwd, workspace, temp, home, program, network, grants)
}

use super::ExecutionError;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::{baseline_env, process, Progress};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::path::PathBuf;

/// A path-based sandbox cannot protect more shared files than this without slowing every run.
#[cfg(any(target_os = "macos", target_os = "linux"))]
const MAX_SHARED_FILES: usize = 1000;

/// Entries in the writable roots that path rules alone would leave writable.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Debug, Default)]
struct Scan {
    /// Regular files with a hard link outside the scanned roots, such as a pnpm store file.
    /// Writing through the workspace name would change the shared file.
    shared: Vec<PathBuf>,
    /// Every workspace entry named `.git` (any case), which must stay read-only.
    git: Vec<PathBuf>,
}

/// Walks the workspace and task directory without following links. Fails closed if a
/// directory cannot be read or too many shared files would need their own rule.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn scan(workspace: &Path, temp: &Path) -> io::Result<Scan> {
    use std::{collections::HashMap, os::unix::fs::MetadataExt};

    let mut result = Scan::default();
    let mut links: HashMap<(u64, u64), (u64, Vec<PathBuf>)> = HashMap::new();
    let mut directories = vec![(workspace.to_path_buf(), true), (temp.to_path_buf(), false)];
    while let Some((directory, in_workspace)) = directories.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if in_workspace && entry.file_name().eq_ignore_ascii_case(".git") {
                // Read-only as a whole, so nothing beneath needs its own rule.
                result.git.push(entry.path());
            } else if kind.is_dir() {
                directories.push((entry.path(), in_workspace));
            } else if kind.is_file() {
                let metadata = entry.metadata()?;
                if metadata.nlink() > 1 {
                    links
                        .entry((metadata.dev(), metadata.ino()))
                        .or_insert_with(|| (metadata.nlink(), Vec::new()))
                        .1
                        .push(entry.path());
                }
            }
        }
    }
    // A file whose every name is inside the roots (Cargo's `target` links) changes nothing else.
    result.shared = links
        .into_values()
        .filter(|(count, names)| (names.len() as u64) < *count)
        .flat_map(|(_, names)| names)
        .collect();
    if result.shared.len() > MAX_SHARED_FILES {
        return Err(io::Error::other("too many hard-linked files to protect"));
    }
    Ok(result)
}

/// The installation prefix of a program found in a `bin` directory (for example a Node or
/// Python install that also holds the program's libraries), readable inside the sandbox. A
/// prefix at, above or directly below home (`~/.cargo`, `~/.local`) would expose unrelated
/// configuration and credentials, so it is never granted.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn install_prefix(invocation: &Path, home: &Path) -> Option<PathBuf> {
    let bin = invocation.parent()?;
    if bin.file_name()? != "bin" {
        return None;
    }
    let prefix = bin.parent()?.canonicalize().ok()?;
    let too_broad = home.starts_with(&prefix)
        || prefix
            .strip_prefix(home)
            .is_ok_and(|rest| rest.components().count() < 2);
    (!too_broad).then_some(prefix)
}

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
                    Duration::from_secs(20),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_node_family_programs_by_basename() {
        for program in [
            "node",
            "/usr/local/bin/npm",
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Users\dev\AppData\Roaming\npm\pnpm.cmd",
            "Yarn.PS1",
            "NPX.CMD",
            "corepack",
            "bunx.exe",
            "deno",
            "pnpx",
            "bun",
        ] {
            assert!(node_family(Path::new(program)), "{program}");
        }
        for program in [
            "cargo",
            "cargo.exe",
            "python.exe",
            "nodemon",
            "node.js",
            "my-node.exe",
            "go",
        ] {
            assert!(!node_family(Path::new(program)), "{program}");
        }
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux", windows)))]
mod conformance {
    use super::*;
    use crate::execution::argv::{self, resolve_program, run_argv, ArgvOutcome, ArgvRun};
    use cap_std::{ambient_authority, fs::Dir};
    use std::{fs, net::TcpListener, sync::atomic::AtomicBool, time::Duration};

    struct Fixture {
        root: tempfile::TempDir,
        workspace: std::path::PathBuf,
        temp: std::path::PathBuf,
        home: std::path::PathBuf,
        node: std::path::PathBuf,
        #[cfg(windows)]
        _path: PathGuard,
    }

    /// Windows grants no ACE outside the profile, workspace and task directory, so the test
    /// runs a copy of Node from the fixture's home, found first on `PATH`. The Windows CI step
    /// runs `execution::` tests one at a time.
    #[cfg(windows)]
    struct PathGuard(Option<std::ffi::OsString>);

    #[cfg(windows)]
    impl Drop for PathGuard {
        fn drop(&mut self) {
            match self.0.take() {
                Some(path) => std::env::set_var("PATH", path),
                None => std::env::remove_var("PATH"),
            }
        }
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
            #[cfg(windows)]
            let (node, _path) = {
                let bin = home.join("bin");
                fs::create_dir(&bin).unwrap();
                fs::copy(&node, bin.join("node.exe")).unwrap();
                let old = std::env::var_os("PATH");
                let mut path = vec![bin.clone()];
                path.extend(old.iter().flat_map(std::env::split_paths));
                std::env::set_var("PATH", std::env::join_paths(path).unwrap());
                (bin.join("node.exe"), PathGuard(old))
            };
            Self {
                root,
                workspace,
                temp,
                home,
                node,
                #[cfg(windows)]
                _path,
            }
        }

        fn detect(&self, network: bool) -> Option<Sandbox> {
            self.detect_program(&self.node, &self.home, network)
        }

        fn detect_program(&self, program: &Path, home: &Path, network: bool) -> Option<Sandbox> {
            self.detect_with_requirement(program, home, network, true)
        }

        fn detect_with_requirement(
            &self,
            program: &Path,
            home: &Path,
            network: bool,
            required: bool,
        ) -> Option<Sandbox> {
            let cwd = Dir::open_ambient_dir(&self.workspace, ambient_authority()).unwrap();
            match Sandbox::detect(
                &cwd,
                &self.workspace,
                &self.temp,
                Some(home),
                program,
                network,
                TaskGrants {
                    task_id: Uuid::new_v4(),
                    record: &mut |_| Ok(()),
                },
            ) {
                Availability::Available(sandbox) => Some(sandbox),
                Availability::Unavailable(reason) => {
                    assert!(
                        !required
                            || std::env::var_os("TURING_CI_REQUIRE_SANDBOX").as_deref()
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
            self.run_argv(sandbox, network, &argv, Duration::from_secs(30))
        }

        fn run_argv(
            &self,
            sandbox: &Sandbox,
            network: bool,
            argv: &[String],
            timeout: Duration,
        ) -> ArgvOutcome {
            run_argv(ArgvRun {
                argv,
                cwd: &Dir::open_ambient_dir(&self.workspace, ambient_authority()).unwrap(),
                cwd_path: &self.workspace,
                temp: &self.temp,
                timeout,
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

    fn detect_for_program(fixture: &Fixture, program: &Path) -> Availability {
        let cwd = Dir::open_ambient_dir(&fixture.workspace, ambient_authority()).unwrap();
        super::detect_for_program(
            &cwd,
            &fixture.workspace,
            &fixture.temp,
            Some(&fixture.home),
            program,
            false,
            TaskGrants {
                task_id: Uuid::new_v4(),
                record: &mut |_| Ok(()),
            },
        )
    }

    /// Test runners load script files, and Node resolves the real path of each
    /// module by checking every ancestor directory, unlike `node -e`.
    #[test]
    fn runs_a_script_file_that_requires_a_workspace_module() {
        let fixture = Fixture::new();
        if cfg!(windows) {
            // The AppContainer cannot stat the workspace's ancestors (EPERM on `C:\`).
            assert!(matches!(
                detect_for_program(&fixture, &fixture.node),
                Availability::Unavailable(WINDOWS_NODE_UNSANDBOXED)
            ));
            return;
        }
        let Some(sandbox) = fixture.detect(false) else {
            return;
        };
        fs::create_dir(fixture.workspace.join("src")).unwrap();
        fs::write(
            fixture.workspace.join("src/lib.js"),
            "module.exports = 5;\n",
        )
        .unwrap();
        fs::write(
            fixture.workspace.join("main.js"),
            "console.log('loaded', require('./src/lib'));\n",
        )
        .unwrap();
        let result = fixture.run(
            &sandbox,
            false,
            "require(require('path').resolve(process.argv[1]))",
            &[Path::new("main.js")],
        );
        assert_eq!(result.exit_code, Some(0), "stderr: {}", result.stderr);
        assert!(result.stdout.contains("loaded 5"), "{}", result.stdout);
    }

    #[cfg(windows)]
    #[test]
    fn windows_runs_node_unsandboxed_and_other_programs_in_the_container() {
        let fixture = Fixture::new();
        assert!(matches!(
            detect_for_program(&fixture, &fixture.node),
            Availability::Unavailable(WINDOWS_NODE_UNSANDBOXED)
        ));
        // A program outside the Node family keeps the AppContainer. A renamed copy of
        // node.exe is a portable executable that answers the `--version` self-check.
        // It lives in the profile tree: no ACE is ever added outside it (or the workspace).
        let runner = fixture.home.join("bin/runner.exe");
        fs::copy(&fixture.node, &runner).unwrap();
        assert!(matches!(
            detect_for_program(&fixture, &runner),
            Availability::Available(_)
        ));
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

    const WRITE: &str = "require('fs').writeFileSync(process.argv[1], 'probe')";

    #[cfg(not(windows))]
    #[test]
    fn git_metadata_is_read_only_at_any_depth_and_case() {
        let fixture = Fixture::new();
        for dir in [".git/hooks", "nested/.GIT"] {
            fs::create_dir_all(fixture.workspace.join(dir)).unwrap();
        }
        let Some(sandbox) = fixture.detect(false) else {
            return;
        };
        for path in [".git/hooks/pre-commit", ".git/config", "nested/.GIT/config"] {
            let path = fixture.workspace.join(path);
            let result = fixture.run(&sandbox, false, WRITE, &[&path]);
            assert!(result.exit_code.is_some_and(|code| code != 0), "{path:?}");
            assert!(!path.exists(), "{path:?}");
        }
        let rename = "require('fs').renameSync(process.argv[1], process.argv[2])";
        let moved = fixture.workspace.join("moved");
        let result = fixture.run(
            &sandbox,
            false,
            rename,
            &[&fixture.workspace.join(".git"), &moved],
        );
        assert!(result.exit_code.is_some_and(|code| code != 0));
        assert!(fixture.workspace.join(".git/hooks").is_dir() && !moved.exists());
        let ordinary = fixture.workspace.join("src.txt");
        let result = fixture.run(&sandbox, false, WRITE, &[&ordinary]);
        assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
    }

    #[test]
    fn writing_through_a_hard_link_never_changes_the_outside_file() {
        let fixture = Fixture::new();
        let store = fixture.root.path().join("store-file");
        fs::write(&store, "store").unwrap();
        let linked = fixture.workspace.join("node_modules/.pnpm/pkg/index.js");
        fs::create_dir_all(linked.parent().unwrap()).unwrap();
        fs::hard_link(&store, &linked).unwrap();
        // Both names inside the workspace, like Cargo's `target` links, stay writable.
        let inner = fixture.workspace.join("target-a");
        fs::write(&inner, "inner").unwrap();
        fs::hard_link(&inner, fixture.workspace.join("target-b")).unwrap();
        if cfg!(windows) {
            // Windows refuses a workspace with hard links before granting anything.
            let cwd = Dir::open_ambient_dir(&fixture.workspace, ambient_authority()).unwrap();
            assert!(matches!(
                Sandbox::detect(
                    &cwd,
                    &fixture.workspace,
                    &fixture.temp,
                    Some(&fixture.home),
                    &fixture.node,
                    false,
                    TaskGrants {
                        task_id: Uuid::new_v4(),
                        record: &mut |_| Ok(()),
                    },
                ),
                Availability::Unavailable(_)
            ));
            return;
        }
        let Some(sandbox) = fixture.detect(false) else {
            return;
        };
        let result = fixture.run(&sandbox, false, WRITE, &[&linked]);
        assert!(result.exit_code.is_some_and(|code| code != 0));
        assert_eq!(fs::read_to_string(&store).unwrap(), "store");
        let result = fixture.run(&sandbox, false, WRITE, &[&inner]);
        assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
    }

    #[test]
    fn toolchain_caches_are_writable_only_with_network_on() {
        let fixture = Fixture::new();
        let registry = fixture.home.join(".cargo/registry");
        fs::create_dir_all(&registry).unwrap();
        let entry = registry.join("downloaded.crate");
        let Some(offline) = fixture.detect(false) else {
            return;
        };
        let result = fixture.run(&offline, false, WRITE, &[&entry]);
        assert!(result.exit_code.is_some_and(|code| code != 0));
        assert!(!entry.exists());
        // Revoke the offline grants first, as one task holds one sandbox at a time.
        drop(offline);
        let online = fixture.detect(true).expect("online sandbox self-check");
        let result = fixture.run(&online, true, WRITE, &[&entry]);
        assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
        assert!(entry.is_file());
    }

    fn real_home() -> std::path::PathBuf {
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .expect("home directory")
            .into()
    }

    /// A real toolchain: `cargo test` builds and runs a dependency-free crate offline.
    #[test]
    fn runs_cargo_test_on_a_temp_crate_offline() {
        let fixture = Fixture::new();
        let Ok(cargo) = resolve_program("cargo", std::env::var_os("PATH").as_deref()) else {
            eprintln!("Sandbox conformance skipped: cargo is not installed");
            return;
        };
        fs::create_dir(fixture.workspace.join("src")).unwrap();
        fs::write(
            fixture.workspace.join("Cargo.toml"),
            "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        fs::write(
            fixture.workspace.join("src/lib.rs"),
            "#[test]\nfn adds() { assert_eq!(2 + 3, 5); }\n",
        )
        .unwrap();
        // On Windows the installed rustup shim may fail the AppContainer
        // self-check. The agent then requires individual unsandboxed approval.
        let Some(sandbox) =
            fixture.detect_with_requirement(&cargo, &real_home(), false, !cfg!(windows))
        else {
            return;
        };
        let argv = ["cargo", "test", "--offline"].map(String::from);
        let result = fixture.run_argv(&sandbox, false, &argv, argv::COMMAND_TIMEOUT);
        assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
        assert!(result.sandboxed);
        assert!(
            result.stdout.contains("test adds ... ok"),
            "{}",
            result.stdout
        );
    }

    /// A real Node toolchain: `npm test` runs a dependency-free package. Node-family programs
    /// run unsandboxed on Windows by design.
    #[test]
    fn runs_npm_test_on_a_temp_package() {
        let fixture = Fixture::new();
        let npm = resolve_program("npm", std::env::var_os("PATH").as_deref()).unwrap();
        if cfg!(windows) {
            assert!(matches!(
                detect_for_program(&fixture, &npm),
                Availability::Unavailable(WINDOWS_NODE_UNSANDBOXED)
            ));
            return;
        }
        fs::write(
            fixture.workspace.join("package.json"),
            r#"{"name":"probe","version":"1.0.0","scripts":{"test":"node test.js"}}"#,
        )
        .unwrap();
        fs::write(
            fixture.workspace.join("test.js"),
            "require('assert').strictEqual(2 + 3, 5); console.log('probe passed');\n",
        )
        .unwrap();
        let Some(sandbox) = fixture.detect_program(&npm, &real_home(), false) else {
            return;
        };
        let argv = ["npm", "test"].map(String::from);
        let result = fixture.run_argv(&sandbox, false, &argv, argv::COMMAND_TIMEOUT);
        assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
        assert!(result.stdout.contains("probe passed"), "{}", result.stdout);
    }

    /// CI installs bubblewrap, so both Linux mechanisms run here, not just the preferred one.
    #[cfg(target_os = "linux")]
    #[test]
    fn every_linux_mechanism_confines_writes() {
        let fixture = Fixture::new();
        let outside = fixture.root.path().join("outside");
        let labels: Vec<_> = platform::policies(
            &fixture.workspace,
            &fixture.temp,
            Some(&fixture.home),
            &fixture.node,
            false,
        )
        .map(|policy| Sandbox { policy })
        .filter(|sandbox| {
            let inside = fixture.workspace.join("inside");
            let result = fixture.run(sandbox, false, WRITE, &[&inside]);
            eprintln!(
                "{}: {:?} {}",
                sandbox.label(),
                result.exit_code,
                result.stderr
            );
            result.exit_code == Some(0)
        })
        .map(|sandbox| {
            let result = fixture.run(&sandbox, false, WRITE, &[&outside]);
            assert!(result.exit_code.is_some_and(|code| code != 0));
            assert!(!outside.exists());
            sandbox.label()
        })
        .collect();
        if std::env::var_os("TURING_CI_REQUIRE_SANDBOX").is_some() {
            assert_eq!(labels, ["bubblewrap", "Landlock (network: TCP only)"]);
        }
    }
}
