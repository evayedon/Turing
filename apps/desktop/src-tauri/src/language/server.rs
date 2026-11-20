use super::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    #[default]
    Clangd,
    Typescript,
    Pyright,
    RustAnalyzer,
}

impl Kind {
    pub fn names(self) -> &'static [&'static str] {
        match self {
            Self::Clangd => &["clangd"],
            Self::Typescript => &["typescript-language-server"],
            Self::Pyright => &["pyright-langserver", "basedpyright-langserver"],
            Self::RustAnalyzer => &["rust-analyzer"],
        }
    }

    pub fn language(self, path: &str) -> Option<&'static str> {
        let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
        match (self, extension.as_str()) {
            (Self::Clangd, "c") => Some("c"),
            (Self::Clangd, "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx") => Some("cpp"),
            (Self::Typescript, "ts" | "mts" | "cts") => Some("typescript"),
            (Self::Typescript, "tsx") => Some("typescriptreact"),
            (Self::Typescript, "js" | "mjs" | "cjs") => Some("javascript"),
            (Self::Typescript, "jsx") => Some("javascriptreact"),
            (Self::Pyright, "py" | "pyi") => Some("python"),
            (Self::RustAnalyzer, "rs") => Some("rust"),
            _ => None,
        }
    }

    pub fn args(self) -> &'static [&'static str] {
        match self {
            Self::Clangd => &[
                "--background-index=false",
                "--enable-config=false",
                "--clang-tidy=false",
                "--pch-storage=memory",
                "-j=1",
            ],
            Self::Typescript | Self::Pyright => &["--stdio"],
            Self::RustAnalyzer => &[],
        }
    }

    pub fn initialization(self) -> Value {
        match self {
            Self::RustAnalyzer => json!({
                "cargo":{"buildScripts":{"enable":false}},
                "procMacro":{"enable":false},
                "checkOnSave":false
            }),
            Self::Typescript => json!({"disableAutomaticTypingAcquisition":true}),
            _ => json!({}),
        }
    }

    pub fn settings(self, root: &Path, private: Option<&Path>, initialization: &Value) -> Value {
        match self {
            Self::Pyright => {
                // Pyright runs pythonPath to inspect sys.path. Use our private
                // directory as a non-executable sentinel and provide venv
                // package directories through configuration instead.
                let mut packages = Vec::new();
                for environment in [".venv", "venv"] {
                    let venv = root.join(environment);
                    let windows_packages = venv.join("Lib/site-packages");
                    packages.extend(authorized_directory(root, &windows_packages));
                    for lib in ["lib", "lib64"] {
                        let entries = std::fs::read_dir(venv.join(lib));
                        for entry in entries.into_iter().flatten().take(64).flatten() {
                            if entry.file_name().to_string_lossy().starts_with("python") {
                                packages.extend(authorized_directory(
                                    root,
                                    &entry.path().join("site-packages"),
                                ));
                            }
                        }
                    }
                    if !packages.is_empty() {
                        break;
                    }
                }
                packages.sort_unstable();
                packages.dedup();
                json!({"python":{"pythonPath":private,"analysis":{"extraPaths":packages}}})
            }
            Self::RustAnalyzer => json!({"rust-analyzer":initialization}),
            _ => json!({}),
        }
    }

    pub fn discover(self) -> Result<PathBuf> {
        if self == Self::Clangd {
            return super::executable();
        }
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut directories: Vec<_> = std::env::split_paths(&path)
            .filter(|path| path.is_absolute())
            .collect();
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
        if let Some(home) = home.map(PathBuf::from).filter(|path| path.is_absolute()) {
            directories.push(home.join(".cargo/bin"));
            let mut node_versions: Vec<_> = std::fs::read_dir(home.join(".nvm/versions/node"))
                .into_iter()
                .flatten()
                .take(128)
                .flatten()
                .map(|entry| entry.path().join("bin"))
                .collect();
            node_versions.sort_unstable_by(|left, right| right.cmp(left));
            directories.extend(node_versions);
        }
        if self == Self::RustAnalyzer {
            directories.extend(
                std::env::var_os("CARGO_HOME")
                    .map(PathBuf::from)
                    .filter(|home| home.is_absolute())
                    .map(|home| home.join("bin")),
            );
            let rustup = std::env::var_os("RUSTUP_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                        .map(|home| PathBuf::from(home).join(".rustup"))
                });
            if let Some(rustup) = rustup.filter(|path| path.is_absolute()) {
                let mut toolchains: Vec<_> = std::fs::read_dir(rustup.join("toolchains"))
                    .into_iter()
                    .flatten()
                    .take(64)
                    .flatten()
                    .map(|entry| entry.path())
                    .collect();
                toolchains.sort_unstable_by_key(|path| {
                    let name = path.file_name().unwrap_or_default().to_string_lossy();
                    (!name.starts_with("stable-"), name.into_owned())
                });
                directories.extend(toolchains.into_iter().map(|path| path.join("bin")));
            }
        }
        for name in self.names() {
            for directory in &directories {
                let filename = if cfg!(windows) {
                    format!("{name}.exe")
                } else {
                    (*name).into()
                };
                if let Some(path) = executable_file(&directory.join(filename)) {
                    // Running a canonicalized rustup proxy as rustup can
                    // select or install a toolchain. Launch a component instead.
                    if self != Self::RustAnalyzer || !is_rustup_proxy(&path) {
                        return Ok(path);
                    }
                }
                if cfg!(windows) {
                    let module = match *name {
                        "typescript-language-server" => "typescript-language-server/lib/cli.mjs",
                        "pyright-langserver" => "pyright/langserver.index.js",
                        "basedpyright-langserver" => "basedpyright/langserver.index.js",
                        _ => continue,
                    };
                    if let Ok(path) = directory.join("node_modules").join(module).canonicalize() {
                        if path.is_file() {
                            return Ok(path);
                        }
                    }
                }
            }
        }
        Err(Error::Unavailable)
    }
}

fn authorized_directory(root: &Path, path: &Path) -> Option<PathBuf> {
    let path = path.canonicalize().ok()?;
    (path.starts_with(root) && path.is_dir()).then_some(path)
}

fn is_rustup_proxy(path: &Path) -> bool {
    if path.file_stem().and_then(|name| name.to_str()) == Some("rustup") {
        return true;
    }
    // rustup also installs hard-linked proxies, which retain their names
    // when canonicalized.
    let sibling = path.with_file_name(if cfg!(windows) {
        "rustup.exe"
    } else {
        "rustup"
    });
    let (Ok(candidate), Ok(manager)) = (path.metadata(), sibling.metadata()) else {
        return false;
    };
    candidate.len() == manager.len()
        && super::fingerprint(&sibling)
            .is_ok_and(|identity| super::fingerprint(path) == Ok(identity))
}

fn executable_file(path: &Path) -> Option<PathBuf> {
    let path = path.canonicalize().ok()?;
    let metadata = path.metadata().ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    metadata.is_file().then_some(path)
}

/// Paths named in the approval prompt and verified before every launch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Executable {
    pub entry: PathBuf,
    pub node: Option<PathBuf>,
    pub version_entry: PathBuf,
    pub tsserver: Option<PathBuf>,
}

impl Executable {
    pub fn new(path: &Path, kind: Kind) -> Result<Self> {
        let entry = path.canonicalize().map_err(|_| Error::Unavailable)?;
        let is_script = matches!(
            entry.extension().and_then(|extension| extension.to_str()),
            Some("js" | "mjs")
        );
        let node = if is_script {
            let path = std::env::var_os("PATH").unwrap_or_default();
            let filename = if cfg!(windows) { "node.exe" } else { "node" };
            let node = entry
                .ancestors()
                .skip(1)
                .take(8)
                .flat_map(|parent| [parent.join(filename), parent.join("bin").join(filename)])
                .chain(
                    std::env::split_paths(&path)
                        .filter(|directory| directory.is_absolute())
                        .map(|directory| directory.join(filename)),
                )
                .find_map(|candidate| executable_file(&candidate))
                .ok_or(Error::Unavailable)?;
            Some(node)
        } else {
            None
        };
        let version_entry = if kind == Kind::Pyright && is_script {
            // Pyright's language-server entry has no --version; the
            // bundled CLI is the version probe for the same package.
            let cli = entry.with_file_name("index.js");
            cli.canonicalize().map_err(|_| Error::Unavailable)?
        } else if kind == Kind::Pyright {
            // Some standalone packages expose two native entry points.
            let name = entry
                .file_stem()
                .and_then(|stem| stem.to_str())
                .and_then(|stem| stem.strip_suffix("-langserver"));
            name.and_then(|name| {
                executable_file(&entry.with_file_name(if cfg!(windows) {
                    format!("{name}.exe")
                } else {
                    name.to_owned()
                }))
            })
            .unwrap_or_else(|| entry.clone())
        } else {
            entry.clone()
        };
        let tsserver = if kind == Kind::Typescript && is_script {
            let development = std::env::current_exe()
                .ok()
                .into_iter()
                .flat_map(|executable| {
                    executable
                        .ancestors()
                        .take(12)
                        .map(Path::to_path_buf)
                        .collect::<Vec<_>>()
                })
                .filter(|_| cfg!(debug_assertions));
            let path = std::env::var_os("PATH").unwrap_or_default();
            let installed = std::env::split_paths(&path)
                .filter(|directory| directory.is_absolute())
                .flat_map(|directory| {
                    [
                        directory.join("../lib/node_modules"),
                        directory.join("node_modules"),
                    ]
                });
            entry
                .ancestors()
                .skip(1)
                .take(5)
                .map(Path::to_path_buf)
                .chain(installed)
                .chain(development)
                .flat_map(|directory| {
                    [
                        directory.join("typescript/lib/tsserver.js"),
                        directory.join("node_modules/typescript/lib/tsserver.js"),
                    ]
                })
                .filter_map(|candidate| candidate.canonicalize().ok())
                .find(|candidate| candidate.is_file())
                .ok_or(Error::Incompatible)
                .map(Some)?
        } else {
            None
        };
        Ok(Self {
            entry,
            node,
            version_entry,
            tsserver,
        })
    }

    pub fn identity(&self) -> Result<[[u8; 32]; 4]> {
        let entry = super::fingerprint(&self.entry)?;
        let other = |path: Option<&Path>| match path {
            Some(path) if path != self.entry => super::fingerprint(path),
            _ => Ok(entry),
        };
        Ok([
            entry,
            other(self.node.as_deref())?,
            other(Some(&self.version_entry))?,
            other(self.tsserver.as_deref())?,
        ])
    }

    pub fn description(&self) -> String {
        let mut lines = vec![self.entry.display().to_string()];
        if let Some(node) = &self.node {
            lines.push(format!("Node runtime: {}", node.display()));
        }
        if self.version_entry != self.entry {
            lines.push(format!("Version probe: {}", self.version_entry.display()));
        }
        if let Some(path) = &self.tsserver {
            lines.push(format!("TypeScript runtime: {}", path.display()));
        }
        lines.join("\n")
    }
}
