use super::{
    column_unit_flag, is_executable, process, ExecutionError, Language, Outcome, Progress, Result,
};
use cap_std::{ambient_authority, fs::Dir};
use std::{
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::Ordering::Relaxed,
};

fn candidates(language: Language) -> (&'static [&'static str], ExecutionError) {
    use ExecutionError::*;
    match language {
        Language::Python if cfg!(windows) => (&["python", "python3"], PythonUnavailable),
        Language::Python => (&["python3", "python"], PythonUnavailable),
        Language::Cpp => (&["clang++", "g++"], CompilerUnavailable),
        Language::C => (&["clang", "gcc"], CCompilerUnavailable),
        Language::Rust => (&["rustc"], RustUnavailable),
        Language::Go => (&["go"], GoUnavailable),
        Language::Java => (&["java"], JavaUnavailable),
        Language::JavaScript => (&["node"], NodeUnavailable),
        Language::TypeScript => (&["node"], TypescriptUnavailable),
        Language::CSharp => (&["dotnet"], DotnetUnavailable),
    }
}

fn directories(path: Option<&OsStr>) -> impl Iterator<Item = PathBuf> + '_ {
    path.into_iter()
        .flat_map(std::env::split_paths)
        .filter(|dir| {
            dir.is_absolute()
                && !dir
                    .file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("WindowsApps"))
        })
}

fn find(names: &[&str], path: Option<&OsStr>) -> Option<PathBuf> {
    directories(path)
        .flat_map(|dir| {
            names.iter().map(move |name| {
                dir.join(if cfg!(windows) {
                    format!("{name}.exe")
                } else {
                    (*name).to_owned()
                })
            })
        })
        .find(|candidate| is_executable(candidate))
}

pub(super) fn tool(language: Language, path: Option<&OsStr>) -> Result<PathBuf> {
    let (names, error) = candidates(language);
    find(names, path).ok_or(error)
}

struct Job<'a> {
    source: &'a Path,
    staging: &'a Path,
    scratch: Dir,
    cwd: &'a Dir,
    path: OsString,
    progress: &'a Progress,
}

impl Job<'_> {
    fn command(&self, executable: impl AsRef<OsStr>) -> Command {
        let mut command = Command::new(executable);
        command.env_clear();
        // Keep platform and installed toolchain discovery available without
        // passing application credentials or tool-specific startup options.
        for key in [
            "HOME",
            "USERPROFILE",
            "SystemRoot",
            "WINDIR",
            "LOCALAPPDATA",
            "APPDATA",
            "SDKROOT",
            "INCLUDE",
            "LIB",
            "LIBPATH",
            "DEVELOPER_DIR",
            "JAVA_HOME",
            "RUSTUP_HOME",
            "DOTNET_ROOT",
            "DOTNET_ROOT_X64",
            "DOTNET_ROOT_ARM64",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .env("PATH", &self.path)
            .env("TMPDIR", self.staging)
            .env("TMP", self.staging)
            .env("TEMP", self.staging)
            .env("LC_MESSAGES", "C")
            .env(
                "LC_CTYPE",
                if cfg!(target_os = "macos") {
                    "en_US.UTF-8"
                } else {
                    "C.UTF-8"
                },
            );
        command
    }

    fn probe(&self, command: &mut Command, unavailable: ExecutionError) -> Result<String> {
        let output = process::probe(command, &self.scratch, self.staging, self.progress);
        output.ok_or(unavailable)
    }

    fn build(&self, command: &mut Command) -> Result<Option<Outcome>> {
        self.progress.stage(super::Phase::Compiling);
        Ok(
            match process::run(command, &self.scratch, self.staging, self.progress, true)? {
                Some(status) if status.success() => None,
                Some(status) => Some(Outcome::BuildFailed(status.code())),
                None => Some(Outcome::Stopped),
            },
        )
    }

    fn run(&self, command: &mut Command, staged: bool) -> Result<Outcome> {
        self.progress.stage(super::Phase::Running);
        let cwd = if staged { &self.scratch } else { self.cwd };
        Ok(
            match process::run(command, cwd, self.staging, self.progress, false)? {
                Some(status) => Outcome::Ran(status.code()),
                None => Outcome::Stopped,
            },
        )
    }
}

pub(super) fn execute(
    language: Language,
    source: &Path,
    cwd: &Dir,
    progress: &Progress,
) -> Result<Outcome> {
    if !source.is_absolute() {
        return Err(ExecutionError::Internal);
    }
    let staging = source.parent().ok_or(ExecutionError::Internal)?;
    let scratch = Dir::open_ambient_dir(staging, ambient_authority())
        .map_err(|_| ExecutionError::Internal)?;
    let path = std::env::var_os("PATH");
    let executable = tool(language, path.as_deref())?;
    let path = std::env::join_paths(directories(path.as_deref()))
        .map_err(|_| ExecutionError::ProcessUnavailable)?;
    let job = Job {
        source,
        staging,
        scratch,
        cwd,
        path,
        progress,
    };
    let result = dispatch(&job, language, &executable);
    if progress.stopped.load(Relaxed) {
        return Ok(Outcome::Stopped);
    }
    result
}

fn dispatch(job: &Job<'_>, language: Language, executable: &Path) -> Result<Outcome> {
    let mut command = job.command(executable);
    match language {
        Language::Python => {
            let unavailable = ExecutionError::PythonUnavailable;
            let version = job.probe(job.command(executable).arg("--version"), unavailable)?;
            let minor = version
                .trim()
                .strip_prefix("Python 3.")
                .and_then(|rest| rest.split('.').next())
                .and_then(|part| part.parse::<u32>().ok());
            if !minor.is_some_and(|minor| minor >= 7) {
                return Err(unavailable);
            }
            job.run(
                command
                    .args(["-I", "-B", "-u", "-X", "utf8"])
                    .arg(job.source),
                false,
            )
        }
        Language::C | Language::Cpp | Language::Rust => compile_native(job, language, command),
        Language::Go => go(job, command),
        Language::Java => java(job, command, executable),
        Language::JavaScript | Language::TypeScript => node(job, language, command, executable),
        Language::CSharp => dotnet(job, executable),
    }
}

fn binary(staging: &Path) -> PathBuf {
    staging.join(if cfg!(windows) {
        "program.exe"
    } else {
        "program"
    })
}

fn native_args(
    command: &mut Command,
    language: Language,
    source: &Path,
    output: &Path,
    version: &str,
) {
    match language {
        Language::Rust => {
            command.args([
                "--edition=2021",
                "--crate-name",
                "turing_run",
                "--color=never",
            ]);
        }
        Language::C | Language::Cpp => {
            let (standard, mode) = if language == Language::C {
                ("-std=c17", "c")
            } else {
                ("-std=c++17", "c++")
            };
            command
                .args([standard, "-fdiagnostics-color=never"])
                .args(column_unit_flag(version))
                .args(["-x", mode]);
        }
        _ => unreachable!("native compiler language"),
    }
    command.arg(source).arg("-o").arg(output);
}

fn compile_native(job: &Job<'_>, language: Language, mut command: Command) -> Result<Outcome> {
    let unavailable = candidates(language).1;
    let version = job.probe(
        job.command(command.get_program()).arg("--version"),
        unavailable,
    )?;
    let output = binary(job.staging);
    native_args(&mut command, language, job.source, &output, &version);
    if let Some(outcome) = job.build(&mut command)? {
        return Ok(outcome);
    }
    job.run(&mut job.command(output), false)
}

fn go_command(job: &Job<'_>, executable: &OsStr) -> Command {
    let mut command = job.command(executable);
    command.envs([
        ("GOFLAGS", ""),
        ("GOENV", "off"),
        ("GOTOOLCHAIN", "local"),
        ("GOWORK", "off"),
        ("GO111MODULE", "off"),
        ("GOPROXY", "off"),
        ("GOSUMDB", "off"),
        ("CGO_ENABLED", "0"),
    ]);
    for (key, name) in [
        ("GOCACHE", "cache"),
        ("GOPATH", "gopath"),
        ("GOMODCACHE", "modules"),
        ("GOTMPDIR", "tmp"),
    ] {
        command.env(key, job.staging.join(name));
    }
    command
}

fn go(job: &Job<'_>, command: Command) -> Result<Outcome> {
    let executable = command.get_program();
    fs::create_dir(job.staging.join("tmp")).map_err(|_| ExecutionError::Internal)?;
    job.probe(
        go_command(job, executable).arg("version"),
        ExecutionError::GoUnavailable,
    )?;
    // Build first so compiler output gets build streams. go run reuses the scratch build cache.
    if let Some(outcome) = job.build(
        go_command(job, executable)
            .arg("build")
            .arg("-o")
            .arg(binary(job.staging))
            .arg(job.source),
    )? {
        return Ok(outcome);
    }
    job.run(go_command(job, executable).arg("run").arg(job.source), true)
}

fn node(
    job: &Job<'_>,
    language: Language,
    mut command: Command,
    executable: &Path,
) -> Result<Outcome> {
    let unavailable = candidates(language).1;
    let flags: &[&str] = if language == Language::TypeScript {
        &["--experimental-strip-types"]
    } else {
        &[]
    };
    job.probe(
        job.command(executable).args(flags).arg("--version"),
        unavailable,
    )?;
    if language == Language::TypeScript {
        // Syntax checking with --check bypasses Node's TypeScript loader on
        // supported versions. Probe that loader with a scratch-only file.
        let probe = job.staging.join("node-probe");
        fs::create_dir(&probe).map_err(|_| ExecutionError::Internal)?;
        let file = probe.join("probe.mts");
        fs::write(&file, "const value: number = 42;").map_err(|_| ExecutionError::Internal)?;
        job.probe(job.command(executable).args(flags).arg(file), unavailable)?;
    } else if let Some(outcome) =
        job.build(job.command(executable).arg("--check").arg(job.source))?
    {
        return Ok(outcome);
    }
    job.run(command.args(flags).arg(job.source), false)
}

fn java_major(version: &str) -> Option<u32> {
    let quoted = version.split('"').nth(1)?;
    quoted
        .strip_prefix("1.")
        .unwrap_or(quoted)
        .split(['.', '-', '+'])
        .next()?
        .parse()
        .ok()
}

// javac derives this directory structure from the package declaration.
fn java_class(dir: &Path, filename: &OsStr) -> Option<String> {
    if dir.join(filename).is_file() {
        return Some(Path::new(filename).file_stem()?.to_str()?.to_owned());
    }
    for entry in fs::read_dir(dir).ok()?.flatten() {
        if entry.file_type().ok()?.is_dir() {
            if let Some(class) = java_class(&entry.path(), filename) {
                return Some(format!("{}.{class}", entry.file_name().to_str()?));
            }
        }
    }
    None
}

fn java(job: &Job<'_>, mut command: Command, executable: &Path) -> Result<Outcome> {
    let unavailable = ExecutionError::JavaUnavailable;
    let version = job.probe(job.command(executable).arg("-version"), unavailable)?;
    let supports_source = java_major(&version).is_some_and(|major| major >= 11);
    let sibling = executable.with_file_name(if cfg!(windows) { "javac.exe" } else { "javac" });
    let compiler = is_executable(&sibling)
        .then_some(sibling)
        .or_else(|| find(&["javac"], Some(&job.path)));
    if let Some(compiler) = compiler {
        if job
            .probe(job.command(&compiler).arg("-version"), unavailable)
            .is_ok()
        {
            let classes = job.staging.join("classes");
            fs::create_dir(&classes).map_err(|_| ExecutionError::Internal)?;
            if let Some(outcome) = job.build(
                job.command(compiler)
                    .args(["-encoding", "UTF-8", "-proc:none", "-classpath"])
                    .arg(&classes)
                    .arg("-d")
                    .arg(&classes)
                    .arg(job.source),
            )? {
                return Ok(outcome);
            }
            if !supports_source {
                let filename = job.source.with_extension("class");
                if let Some(class) = filename
                    .file_name()
                    .and_then(|name| java_class(&classes, name))
                {
                    return job.run(command.arg("-cp").arg(classes).arg(class), false);
                }
                job.progress.record(super::Stream::BuildStderr,
                    b"Use a main class named after the source file, or install JDK 11+ for source-file launch.\n");
                return Ok(Outcome::BuildFailed(None));
            }
        }
    }
    if supports_source {
        return job.run(command.arg(job.source), true);
    }
    Err(unavailable)
}

fn dotnet_command(job: &Job<'_>, executable: &Path) -> Command {
    let mut command = job.command(executable);
    command
        .env("DOTNET_CLI_HOME", job.staging)
        .env("NUGET_PACKAGES", job.staging.join("packages"))
        .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
        .env("DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "1")
        .env("DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE", "true")
        .env("MSBuildEnableWorkloadResolver", "false")
        .env("DOTNET_NOLOGO", "1");
    command
}

fn dotnet(job: &Job<'_>, executable: &Path) -> Result<Outcome> {
    let unavailable = ExecutionError::DotnetUnavailable;
    let version = job.probe(
        dotnet_command(job, executable).arg("--version"),
        unavailable,
    )?;
    let major: u32 = version
        .trim()
        .split('.')
        .next()
        .and_then(|part| part.parse().ok())
        .filter(|major| *major >= 6)
        .ok_or(unavailable)?;
    let tfm = format!("net{major}.0");
    let project = job.staging.join("TuringRun.csproj");
    fs::write(
        &project,
        format!(
            r#"<Project Sdk="Microsoft.NET.Sdk">
<PropertyGroup>
  <TargetFramework>{tfm}</TargetFramework>
  <OutputType>Exe</OutputType>
  <NuGetAudit>false</NuGetAudit>
  <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>
</PropertyGroup>
</Project>"#
        ),
    )
    .map_err(|_| ExecutionError::Internal)?;
    fs::write(
        job.staging.join("NuGet.Config"),
        "<configuration><packageSources><clear /></packageSources></configuration>",
    )
    .map_err(|_| ExecutionError::Internal)?;
    if let Some(outcome) = job.build(
        dotnet_command(job, executable)
            .arg("build")
            .arg(project)
            .args([
                "--nologo",
                "--verbosity",
                "quiet",
                "-p:RestoreConfigFile=NuGet.Config",
                "-p:UseSharedCompilation=false",
                "-p:ImportDirectoryBuildProps=false",
                "-p:ImportDirectoryBuildTargets=false",
                "-p:ImportDirectoryPackagesProps=false",
                "-nodeReuse:false",
            ]),
    )? {
        return Ok(outcome);
    }
    let assembly = job
        .staging
        .join("bin")
        .join("Debug")
        .join(tfm)
        .join("TuringRun.dll");
    job.run(dotnet_command(job, executable).arg(assembly), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_compilers_receive_source_and_output_as_single_arguments() {
        let scratch = tempfile::Builder::new()
            .prefix("run ü & ")
            .tempdir()
            .unwrap();
        let output = binary(scratch.path());
        for (language, suffix) in [
            (Language::C, "c"),
            (Language::Cpp, "cpp"),
            (Language::Rust, "rs"),
        ] {
            let source = scratch.path().join(format!("file ü & name.{suffix}"));
            let executable = scratch.path().join("test compiler");
            let mut command = Command::new(&executable);
            native_args(&mut command, language, &source, &output, "");
            assert_eq!(command.get_program(), executable);
            let args: Vec<_> = command.get_args().collect();
            assert_eq!(
                args[args.len() - 3..],
                [source.as_os_str(), OsStr::new("-o"), output.as_os_str()]
            );
        }
    }

    #[test]
    fn path_filter_rejects_relative_and_windows_app_aliases() {
        let scratch = tempfile::tempdir().unwrap();
        let aliases = scratch.path().join("WindowsApps");
        let path = std::env::join_paths([Path::new("relative"), &aliases, scratch.path()]).unwrap();
        assert_eq!(
            directories(Some(&path)).collect::<Vec<_>>(),
            [scratch.path()]
        );
    }

    #[test]
    fn go_build_and_run_use_offline_scratch_configuration() {
        let scratch = tempfile::Builder::new()
            .prefix("go ü & ")
            .tempdir()
            .unwrap();
        let staging = scratch.path();
        let source = staging.join("file ü & name.go");
        let cwd = Dir::open_ambient_dir(staging, ambient_authority()).unwrap();
        let progress = Progress::new(None);
        let job = Job {
            source: &source,
            staging,
            scratch: cwd.try_clone().unwrap(),
            cwd: &cwd,
            path: OsString::new(),
            progress: &progress,
        };
        let executable = staging.join("go");
        let mut command = go_command(&job, executable.as_os_str());
        command.arg("run").arg(&source);
        assert_eq!(command.get_program(), executable);
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [OsStr::new("run"), source.as_os_str()]
        );
        let env: std::collections::HashMap<_, _> = command.get_envs().collect();
        assert_eq!(env[OsStr::new("GOFLAGS")], Some(OsStr::new("")));
        assert_eq!(
            env[OsStr::new("GOCACHE")],
            Some(staging.join("cache").as_os_str())
        );
        assert_eq!(env[OsStr::new("GOTOOLCHAIN")], Some(OsStr::new("local")));
        assert_eq!(env[OsStr::new("GOPROXY")], Some(OsStr::new("off")));
    }

    #[test]
    fn java_version_distinguishes_legacy_and_source_launcher_releases() {
        assert_eq!(java_major("java version \"1.8.0_472\""), Some(8));
        assert_eq!(java_major("openjdk version \"11.0.29\""), Some(11));
        assert_eq!(java_major("openjdk version \"26-ea\""), Some(26));
        assert_eq!(java_major("Unable to locate a Java Runtime"), None);
    }
}
