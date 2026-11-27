use cap_std::fs::{Dir, MetadataExt as _};
use std::{
    ffi::OsString,
    fs,
    os::unix::fs::MetadataExt as _,
    path::{Path, PathBuf},
    process::Command,
};

const PROFILE: &str = r#"
(version 1)
(deny default)
(allow process-exec process-fork sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger"))
(allow file-read-metadata)
(allow file-read*
    (literal "/")
    (subpath "/System/Library") (subpath "/usr") (subpath "/bin") (subpath "/sbin")
    (subpath "/Library/Developer") (subpath "/Library/Java/JavaVirtualMachines")
    (subpath "/Applications/Xcode.app/Contents/Developer")
    (regex #"^/Applications/Xcode_[0-9]+(\.[0-9]+)*\.app/Contents/Developer(/|$)")
    (subpath "/opt/homebrew") (subpath "/opt/local")
    (literal "/private/etc/localtime") (literal "/private/etc/hosts")
    (literal "/private/etc/resolv.conf") (literal "/private/etc/passwd")
    (subpath "/private/etc/ssl")
    (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")
    (literal (param "PROGRAM"))
    (subpath (param "WORKSPACE")) (subpath (param "TASK_TMP"))
    (subpath (string-append (param "HOME") "/.cargo/bin"))
    (subpath (string-append (param "HOME") "/.cargo/registry"))
    (subpath (string-append (param "HOME") "/.cargo/git"))
    (subpath (string-append (param "HOME") "/.rustup/toolchains"))
    (literal (string-append (param "HOME") "/.rustup/settings.toml"))
    (subpath (string-append (param "HOME") "/.nvm/versions"))
    (subpath (string-append (param "HOME") "/.npm/_cacache"))
    (subpath (string-append (param "HOME") "/Library/pnpm"))
    (subpath (string-append (param "HOME") "/Library/Caches/pnpm"))
    (subpath (string-append (param "HOME") "/Library/Caches/pip"))
    (subpath (string-append (param "HOME") "/go/pkg/mod")))
(allow file-write*
    (literal "/dev/null") (subpath (param "WORKSPACE")) (subpath (param "TASK_TMP")))
"#;

const NETWORK: &str = r#"
(allow network-outbound network-inbound (remote ip))
(allow network-bind (local ip))
(allow mach-lookup (global-name "com.apple.mDNSResponder"))
(allow file-write*
    (subpath (string-append (param "HOME") "/.cargo/registry"))
    (subpath (string-append (param "HOME") "/.cargo/git"))
    (subpath (string-append (param "HOME") "/.npm/_cacache"))
    (subpath (string-append (param "HOME") "/Library/pnpm/store"))
    (subpath (string-append (param "HOME") "/Library/Caches/pnpm"))
    (subpath (string-append (param "HOME") "/Library/Caches/pip"))
    (subpath (string-append (param "HOME") "/go/pkg/mod")))
"#;

const PREFIX: &str = r#"
(allow file-read* (subpath (param "PREFIX")))
"#;

// Last, so it overrides the workspace write rule. A `.git` entry at any depth, in any case,
// stays read-only: hooks or config planted there would run unsandboxed later.
const GIT: &str = r##"
(deny file-write* (require-all
    (subpath (param "WORKSPACE")) (regex #"/\.[gG][iI][tT](/|$)")))
"##;

fn directory_id(path: &Path) -> Option<(u64, u64)> {
    let metadata = fs::metadata(path).ok()?;
    metadata.is_dir().then(|| (metadata.dev(), metadata.ino()))
}

pub(super) const UNAVAILABLE: &str = "macOS sandbox-exec self-check failed";

pub(super) fn policies(
    workspace: &Path,
    temp: &Path,
    home: Option<&Path>,
    program: &Path,
    network: bool,
) -> impl Iterator<Item = Policy> {
    Policy::new(workspace, temp, home, program, network).into_iter()
}

pub(super) struct Policy {
    workspace: PathBuf,
    temp: PathBuf,
    workspace_id: (u64, u64),
    temp_id: (u64, u64),
    home: PathBuf,
    program: PathBuf,
    invocation: PathBuf,
    prefix: Option<PathBuf>,
    network: bool,
}

impl Policy {
    fn new(
        workspace: &Path,
        temp: &Path,
        home: Option<&Path>,
        program: &Path,
        network: bool,
    ) -> Option<Self> {
        let workspace = workspace.canonicalize().ok()?;
        let temp = temp.canonicalize().ok()?;
        let home = home?.canonicalize().ok()?;
        // Refuse overly broad scopes and keep the scratch directory separate.
        if home.starts_with(&workspace)
            || home.starts_with(&temp)
            || workspace.starts_with(&temp)
            || temp.starts_with(&workspace)
        {
            return None;
        }
        Some(Self {
            workspace_id: directory_id(&workspace)?,
            temp_id: directory_id(&temp)?,
            workspace,
            temp,
            prefix: super::install_prefix(program, &home),
            home,
            program: program.canonicalize().ok()?,
            invocation: program.to_path_buf(),
            network,
        })
    }

    pub(super) fn matches(
        &self,
        cwd: &Dir,
        workspace: &Path,
        temp: &Path,
        program: &Path,
        network: bool,
    ) -> bool {
        let handle_id = cwd
            .dir_metadata()
            .ok()
            .map(|metadata| (metadata.dev(), metadata.ino()));
        self.network == network
            && handle_id == Some(self.workspace_id)
            && directory_id(workspace) == Some(self.workspace_id)
            && directory_id(temp) == Some(self.temp_id)
            && self.invocation == program
            && [workspace, temp, program]
                .into_iter()
                .zip([&self.workspace, &self.temp, &self.program])
                .all(|(path, expected)| path.canonicalize().is_ok_and(|path| path == *expected))
    }

    pub(super) fn command(&self, _cwd: &Dir, args: &[String]) -> std::io::Result<Command> {
        let scan = super::scan(&self.workspace, &self.temp)?;
        let mut command = Command::new("/usr/bin/sandbox-exec");
        let mut profile = PROFILE.to_owned();
        if self.network {
            profile.push_str(NETWORK);
        }
        if self.prefix.is_some() {
            profile.push_str(PREFIX);
        }
        profile.push_str(GIT);
        // Paths reach the profile only as parameters, never as profile text.
        let mut parameters = vec![
            ("WORKSPACE".to_owned(), &self.workspace),
            ("TASK_TMP".to_owned(), &self.temp),
            ("HOME".to_owned(), &self.home),
            ("PROGRAM".to_owned(), &self.program),
        ];
        parameters.extend(self.prefix.iter().map(|path| ("PREFIX".to_owned(), path)));
        if !scan.shared.is_empty() {
            profile.push_str("(deny file-write*");
            for (index, path) in scan.shared.iter().enumerate() {
                profile.push_str(&format!(" (literal (param \"SHARED{index}\"))"));
                parameters.push((format!("SHARED{index}"), path));
            }
            profile.push_str(")\n");
        }
        command.args(["-p", &profile]);
        for (name, path) in parameters {
            let mut parameter = OsString::from(name);
            parameter.push("=");
            parameter.push(path);
            command.arg("-D").arg(parameter);
        }
        command.arg(&self.invocation).args(args);
        Ok(command)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_text_carries_no_paths() {
        let root = tempfile::tempdir().unwrap();
        let [workspace, temp, home] = ["w\")(allow default)", "t", "h"].map(|name| {
            let path = root.path().join(name);
            fs::create_dir(&path).unwrap();
            path
        });
        let shared = root.path().join("store");
        fs::write(&shared, "").unwrap();
        fs::hard_link(&shared, workspace.join("linked")).unwrap();
        let policy = Policy::new(&workspace, &temp, Some(&home), Path::new("/bin/sh"), true)
            .expect("policy");
        let command = policy
            .command(
                &Dir::open_ambient_dir(&workspace, cap_std::ambient_authority()).unwrap(),
                &[],
            )
            .unwrap();
        let args: Vec<_> = command.get_args().collect();
        let profile = args[1].to_str().unwrap();
        assert!(!profile.contains("allow default"));
        assert!(profile.contains("SHARED0"));
        assert!(args
            .iter()
            .any(|arg| arg.to_str().unwrap().ends_with("/linked")));
    }
}
