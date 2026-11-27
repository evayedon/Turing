//! Runs agent commands as structured argv: no shell, a stripped environment,
//! the workspace as working directory, a timeout and capped output.

use super::{baseline_env, is_executable, process, toolchain, ExecutionError, Progress, Stream};
use cap_std::fs::Dir;
use serde::Serialize;
use std::{
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::AtomicBool,
    time::Duration,
};

pub(crate) const COMMAND_TIMEOUT: Duration = Duration::from_secs(300);

/// Toolchain locations (beyond `baseline_env`) that test commands need.
const EXTRA_ENV: [&str; 11] = [
    "CARGO_HOME",
    "GOPATH",
    "GOCACHE",
    "GOMODCACHE",
    "NVM_DIR",
    "VOLTA_HOME",
    "PNPM_HOME",
    "npm_config_cache",
    "VIRTUAL_ENV",
    "PYENV_ROOT",
    "UV_CACHE_DIR",
];

const OFFLINE_ENV: [(&str, &str); 5] = [
    ("CARGO_NET_OFFLINE", "true"),
    ("npm_config_offline", "true"),
    ("GOPROXY", "off"),
    ("GOFLAGS", "-mod=mod"),
    ("PIP_NO_INDEX", "1"),
];

pub(crate) struct ArgvRun<'a> {
    pub argv: &'a [String],
    pub cwd: &'a Dir,
    pub cwd_path: &'a Path,
    pub temp: &'a Path,
    pub timeout: Duration,
    pub network: bool,
    pub sandbox: Option<&'a super::sandbox::Sandbox>,
    pub stopped: &'a AtomicBool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArgvOutcome {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub truncated: bool,
    pub stdout: String,
    pub stderr: String,
    pub sandboxed: bool,
}

pub(crate) fn secret_env_name(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_CREDENTIALS"]
        .iter()
        .any(|suffix| name.ends_with(suffix))
        || name.contains("CREDENTIAL")
}

/// Resolves a bare program name through the absolute directories on `path`.
pub(crate) fn resolve_program(name: &str, path: Option<&OsStr>) -> Result<PathBuf, ExecutionError> {
    if name.is_empty() || name.contains(['/', '\\']) || (cfg!(windows) && name.contains(':')) {
        return Err(ExecutionError::ProcessUnavailable);
    }
    // shortcut: Windows only tries .exe and .cmd (npm, pnpm, yarn shims), not all of PATHEXT.
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd")]
    } else {
        vec![name.to_owned()]
    };
    toolchain::directories(path)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| is_executable(candidate))
        .ok_or(ExecutionError::ProcessUnavailable)
}

pub(crate) fn run_argv(run: ArgvRun<'_>) -> Result<ArgvOutcome, ExecutionError> {
    let (program, args) = run
        .argv
        .split_first()
        .ok_or(ExecutionError::ProcessUnavailable)?;
    let inherited = std::env::var_os("PATH");
    let executable = resolve_program(program, inherited.as_deref())?;
    let path = std::env::join_paths(toolchain::directories(inherited.as_deref()))
        .map_err(|_| ExecutionError::ProcessUnavailable)?;
    let mut command = match run.sandbox {
        Some(sandbox) => sandbox.command(
            run.cwd,
            run.cwd_path,
            run.temp,
            &executable,
            run.network,
            args,
        )?,
        None => {
            let mut command = Command::new(executable);
            command.args(args);
            command
        }
    };
    baseline_env(&mut command, &path, run.temp);
    for key in EXTRA_ENV {
        if let Some(value) = std::env::var_os(key).filter(|_| !secret_env_name(key)) {
            command.env(key, value);
        }
    }
    if !run.network {
        command.envs(OFFLINE_ENV);
    }
    let progress = Progress::new(None);
    let (exit_code, timed_out, cancelled) = match process::supervise(
        &mut command,
        run.cwd,
        run.cwd_path,
        &progress,
        run.stopped,
        false,
        run.timeout,
    ) {
        Ok(Some(status)) => (status.code(), false, false),
        Ok(None) => (None, false, true),
        Err(ExecutionError::TimedOut) => (None, true, false),
        Err(error) => return Err(error),
    };
    let state = progress.state();
    let text = |stream: Stream| {
        let bytes: Vec<u8> = state
            .output
            .iter()
            .filter(|chunk| chunk.stream == stream)
            .flat_map(|chunk| chunk.bytes.iter().copied())
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(ArgvOutcome {
        exit_code,
        timed_out,
        cancelled,
        truncated: state.truncated,
        stdout: text(Stream::Stdout),
        stderr: text(Stream::Stderr),
        sandboxed: run.sandbox.is_some(),
    })
}

fn is_file(root: &Dir, name: &str) -> bool {
    root.metadata(name).is_ok_and(|metadata| metadata.is_file())
}

fn package_json(root: &Dir) -> Option<serde_json::Value> {
    if !is_file(root, "package.json") {
        return None;
    }
    let mut text = String::new();
    root.open("package.json")
        .ok()?
        .take(1024 * 1024)
        .read_to_string(&mut text)
        .ok()?;
    serde_json::from_str(&text).ok()
}

pub(crate) fn detect_test_command(root: &Dir) -> Option<Vec<String>> {
    let argv = |parts: &[&str]| Some(parts.iter().map(|part| part.to_string()).collect());
    if let Some(package) = package_json(root) {
        // npm init writes a test script that only fails; treat it as absent.
        let real = package["scripts"]["test"]
            .as_str()
            .is_some_and(|script| !script.contains("Error: no test specified"));
        if real {
            let manager = package["packageManager"].as_str().unwrap_or_default();
            let tool = if manager.starts_with("pnpm@") || is_file(root, "pnpm-lock.yaml") {
                "pnpm"
            } else if manager.starts_with("yarn@") || is_file(root, "yarn.lock") {
                "yarn"
            } else {
                "npm"
            };
            return argv(&[tool, "test"]);
        }
    }
    if is_file(root, "Cargo.toml") {
        argv(&["cargo", "test"])
    } else if is_file(root, "pyproject.toml") || is_file(root, "pytest.ini") {
        argv(&["pytest"])
    } else if is_file(root, "go.mod") {
        argv(&["go", "test", "./..."])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;
    use std::{
        fs,
        sync::atomic::{AtomicBool, Ordering::Relaxed},
        thread,
        time::{Duration, Instant},
    };

    fn workspace() -> (tempfile::TempDir, Dir, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let dir = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        (root, dir, tempfile::tempdir().unwrap())
    }

    fn node(script: &str) -> Vec<String> {
        vec!["node".into(), "-e".into(), script.into()]
    }

    fn run(argv: &[String], network: bool, timeout: Duration) -> (ArgvOutcome, tempfile::TempDir) {
        let (root, dir, temp) = workspace();
        let stopped = AtomicBool::new(false);
        let outcome = run_argv(ArgvRun {
            argv,
            cwd: &dir,
            cwd_path: root.path(),
            temp: temp.path(),
            timeout,
            network,
            sandbox: None,
            stopped: &stopped,
        })
        .unwrap();
        (outcome, root)
    }

    fn env_of(network: bool) -> serde_json::Map<String, serde_json::Value> {
        let (outcome, _) = run(
            &node("process.stdout.write(JSON.stringify(process.env))"),
            network,
            COMMAND_TIMEOUT,
        );
        serde_json::from_str(&outcome.stdout).unwrap()
    }

    #[test]
    fn runs_structured_argv_in_the_workspace_and_reports_exit_code() {
        let (outcome, root) = run(
            &node("process.stdout.write(process.cwd()); process.exit(3)"),
            true,
            COMMAND_TIMEOUT,
        );
        assert_eq!(outcome.exit_code, Some(3));
        assert!(!outcome.timed_out && !outcome.cancelled && !outcome.sandboxed);
        assert_eq!(
            fs::canonicalize(&outcome.stdout).unwrap(),
            fs::canonicalize(root.path()).unwrap()
        );
    }

    #[test]
    fn metacharacters_are_passed_literally() {
        let mut argv = node("console.log(process.argv[1])");
        argv.push("a;b && c | $(x)".into());
        let (outcome, _) = run(&argv, true, COMMAND_TIMEOUT);
        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(outcome.stdout, "a;b && c | $(x)\n");
    }

    #[test]
    fn strips_secret_looking_environment() {
        let cargo_home = std::env::var_os("CARGO_HOME").unwrap_or_else(|| "/cargo-home".into());
        for (key, value) in [
            ("OPENROUTER_API_KEY", "sk-test".into()),
            ("GITHUB_TOKEN", "ghp-test".into()),
            ("AWS_SECRET_ACCESS_KEY", "aws-test".into()),
            ("CARGO_HOME", cargo_home.clone()),
        ] {
            std::env::set_var(key, value);
        }
        let (root, dir, temp) = workspace();
        let stopped = AtomicBool::new(false);
        let outcome = run_argv(ArgvRun {
            argv: &node("process.stdout.write(JSON.stringify(process.env))"),
            cwd: &dir,
            cwd_path: root.path(),
            temp: temp.path(),
            timeout: COMMAND_TIMEOUT,
            network: true,
            sandbox: None,
            stopped: &stopped,
        })
        .unwrap();
        let env: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&outcome.stdout).unwrap();
        // Windows environment names are case-insensitive.
        let get = |name: &str| {
            env.iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .and_then(|(_, value)| value.as_str())
        };
        for secret in [
            "OPENROUTER_API_KEY",
            "GITHUB_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert_eq!(get(secret), None, "{secret} leaked");
        }
        assert_eq!(get("CARGO_HOME"), cargo_home.to_str());
        let temp_var = if cfg!(windows) { "TEMP" } else { "TMPDIR" };
        assert_eq!(get(temp_var), temp.path().to_str());
    }

    #[test]
    fn network_off_sets_offline_variables() {
        let env = env_of(false);
        assert_eq!(
            env.get("CARGO_NET_OFFLINE").and_then(|v| v.as_str()),
            Some("true")
        );
        assert_eq!(env.get("PIP_NO_INDEX").and_then(|v| v.as_str()), Some("1"));
        let env = env_of(true);
        assert!(!env.contains_key("CARGO_NET_OFFLINE"));
        assert!(!env.contains_key("PIP_NO_INDEX"));
    }

    #[test]
    fn times_out_and_kills_the_process_tree() {
        let script = "const c = require('child_process').spawn(process.execPath, \
                      ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); \
                      process.stdout.write(String(c.pid)); setInterval(() => {}, 1000);";
        let start = Instant::now();
        let (outcome, _) = run(&node(script), true, Duration::from_secs(1));
        assert!(outcome.timed_out);
        assert_eq!(outcome.exit_code, None);
        assert!(start.elapsed() < Duration::from_secs(20));
        #[cfg(unix)]
        {
            let pid: libc::pid_t = outcome.stdout.trim().parse().unwrap();
            // The orphaned grandchild is reaped by init shortly after the kill.
            let deadline = Instant::now() + Duration::from_secs(5);
            while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(50));
            }
            assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "grandchild survived");
        }
    }

    #[test]
    fn caps_output_and_marks_truncation() {
        let (outcome, _) = run(
            &node("process.stdout.write('x'.repeat(1024 * 1024))"),
            true,
            COMMAND_TIMEOUT,
        );
        assert!(outcome.truncated);
        assert!(outcome.stdout.len() <= 256 * 1024);
    }

    #[test]
    fn stop_flag_cancels() {
        let (root, dir, temp) = workspace();
        let stopped = AtomicBool::new(false);
        let start = Instant::now();
        let outcome = thread::scope(|scope| {
            scope.spawn(|| {
                thread::sleep(Duration::from_millis(300));
                stopped.store(true, Relaxed);
            });
            run_argv(ArgvRun {
                argv: &node("setTimeout(() => {}, 20000)"),
                cwd: &dir,
                cwd_path: root.path(),
                temp: temp.path(),
                timeout: COMMAND_TIMEOUT,
                network: true,
                sandbox: None,
                stopped: &stopped,
            })
            .unwrap()
        });
        assert!(outcome.cancelled);
        assert!(!outcome.timed_out);
        assert_eq!(outcome.exit_code, None);
        assert!(start.elapsed() < Duration::from_secs(15));
    }

    #[test]
    fn detects_the_test_command_from_workspace_markers() {
        let vitest = r#"{"scripts":{"test":"vitest"}}"#;
        let yarn = r#"{"packageManager":"yarn@4","scripts":{"test":"vitest"}}"#;
        let npm_default = r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#;
        type Case<'a> = (&'a [(&'a str, &'a str)], Option<&'a [&'a str]>);
        let cases: &[Case] = &[
            (
                &[("package.json", vitest), ("pnpm-lock.yaml", "")],
                Some(&["pnpm", "test"]),
            ),
            (&[("package.json", yarn)], Some(&["yarn", "test"])),
            (&[("package.json", vitest)], Some(&["npm", "test"])),
            (
                &[("package.json", npm_default), ("Cargo.toml", "")],
                Some(&["cargo", "test"]),
            ),
            (
                &[("package.json", vitest), ("Cargo.toml", "")],
                Some(&["npm", "test"]),
            ),
            (&[("pyproject.toml", "")], Some(&["pytest"])),
            (&[("pytest.ini", "")], Some(&["pytest"])),
            (&[("go.mod", "")], Some(&["go", "test", "./..."])),
            (&[], None),
        ];
        for (markers, expected) in cases {
            let (root, dir, _) = workspace();
            for (name, content) in *markers {
                fs::write(root.path().join(name), content).unwrap();
            }
            let expected = expected.map(|argv| argv.iter().map(|s| s.to_string()).collect());
            assert_eq!(detect_test_command(&dir), expected, "{markers:?}");
        }
    }

    #[test]
    fn secret_env_names() {
        for name in ["OPENAI_API_KEY", "gh_token", "MY_CREDENTIALS"] {
            assert!(secret_env_name(name), "{name}");
        }
        for name in ["CARGO_HOME", "PATH"] {
            assert!(!secret_env_name(name), "{name}");
        }
    }

    #[test]
    fn rejects_path_like_program_names() {
        let path = std::env::var_os("PATH");
        for name in ["./x", "a/b", "..\\x", ""] {
            assert_eq!(
                resolve_program(name, path.as_deref()),
                Err(ExecutionError::ProcessUnavailable),
                "{name}"
            );
        }
    }
}
