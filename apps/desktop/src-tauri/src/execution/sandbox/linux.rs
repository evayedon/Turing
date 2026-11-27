use cap_std::fs::{Dir, MetadataExt as _};
use std::{
    fs::{self, File},
    io::{self, Write as _},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{fs::MetadataExt as _, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::Command,
};

pub(super) const UNAVAILABLE: &str =
    "Linux sandbox needs bubblewrap (or Landlock ABI 4+ for a folder without .git or shared hard links)";

// Restrict host reads to system toolchains and named caches. In particular,
// /run, /proc, /sys and a mirror of the host root would expose unrelated data.
const SYSTEM_READS: &[&str] = &[
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/nix/store",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
    "/etc/ssl/certs",
    // Node can report its version without loading this file, but scripts need it.
    "/etc/ssl/openssl.cnf",
    "/etc/pki/tls/certs",
    "/etc/hosts",
    "/etc/host.conf",
    "/etc/nsswitch.conf",
    "/etc/resolv.conf",
    "/etc/localtime",
    "/etc/passwd",
    "/etc/group",
];
const HOME_READS: &[&str] = &[
    ".cargo/bin",
    ".cargo/git",
    ".cargo/registry",
    ".rustup/toolchains",
    ".rustup/settings.toml",
    ".nvm/versions",
    ".npm/_cacache",
    ".local/share/pnpm/store",
    ".cache/pnpm",
    ".cache/pip",
    "go/pkg/mod",
];
/// Download caches, writable only when the plan allows network access.
const CACHE_WRITES: &[&str] = &[
    ".cargo/git",
    ".cargo/registry",
    ".npm/_cacache",
    ".local/share/pnpm/store",
    ".cache/pnpm",
    ".cache/pip",
    "go/pkg/mod",
];
const DEVICES: &[&str] = &["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"];

const EXECUTE: u64 = 1;
const WRITE_FILE: u64 = 1 << 1;
const READ_FILE: u64 = 1 << 2;
const READ_DIR: u64 = 1 << 3;
const TRUNCATE: u64 = 1 << 14;
const FS_ABI_3: u64 = (1 << 15) - 1;
const DEVICE_IOCTL: u64 = 1 << 15;
const TCP_BIND_CONNECT: u64 = 3;

#[repr(C)]
struct RulesetAttr {
    fs: u64,
    net: u64,
}

#[repr(C, packed)]
struct PathBeneathAttr {
    access: u64,
    parent_fd: i32,
}

#[derive(Clone, Copy)]
enum Kind {
    Landlock(i32),
    Bubblewrap,
}

fn landlock_abi() -> i32 {
    // LANDLOCK_CREATE_RULESET_VERSION
    unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, 0, 0, 1) as i32 }
}

/// bubblewrap first: its network namespace and read-only binds cover what Landlock cannot.
fn candidates(abi: i32, network: bool, bubblewrap: bool) -> impl Iterator<Item = Kind> {
    [
        bubblewrap.then_some(Kind::Bubblewrap),
        (abi >= if network { 3 } else { 4 }).then_some(Kind::Landlock(abi)),
    ]
    .into_iter()
    .flatten()
}

pub(super) fn policies<'a>(
    workspace: &'a Path,
    temp: &'a Path,
    home: Option<&'a Path>,
    program: &'a Path,
    network: bool,
) -> impl Iterator<Item = Policy> + 'a {
    candidates(
        landlock_abi(),
        network,
        Path::new("/usr/bin/bwrap").is_file(),
    )
    .filter_map(move |kind| Policy::new(kind, workspace, temp, home, program, network))
}

fn identity(path: &Path) -> io::Result<(u64, u64)> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a directory",
        ));
    }
    Ok((metadata.dev(), metadata.ino()))
}

pub(super) struct Policy {
    kind: Kind,
    workspace: PathBuf,
    temp: PathBuf,
    workspace_id: (u64, u64),
    temp_id: (u64, u64),
    invocation: PathBuf,
    program: PathBuf,
    reads: Vec<PathBuf>,
    /// Existing download caches, writable because the network is on.
    writes: Vec<PathBuf>,
    network: bool,
}

impl Policy {
    pub(super) fn label(&self) -> &'static str {
        match self.kind {
            Kind::Landlock(_) => "Landlock (network: TCP only)",
            Kind::Bubblewrap => "bubblewrap",
        }
    }

    fn new(
        kind: Kind,
        workspace: &Path,
        temp: &Path,
        home: Option<&Path>,
        program: &Path,
        network: bool,
    ) -> Option<Self> {
        let workspace = workspace.canonicalize().ok()?;
        let temp = temp.canonicalize().ok()?;
        let home = home?.canonicalize().ok()?;
        if home.starts_with(&workspace)
            || home.starts_with(&temp)
            || workspace.starts_with(&temp)
            || temp.starts_with(&workspace)
        {
            return None;
        }
        let named = |suffixes: &'static [&'static str]| {
            suffixes.iter().filter_map(|suffix| {
                let path = home.join(suffix);
                let resolved = path.canonicalize().ok()?;
                // A home cache symlink must not grant new access outside its named subtree.
                (resolved == path).then_some(path)
            })
        };
        let mut reads: Vec<PathBuf> = SYSTEM_READS.iter().map(PathBuf::from).collect();
        reads.extend(named(HOME_READS));
        reads.extend(super::install_prefix(program, &home));
        let writes = if network {
            named(CACHE_WRITES).collect()
        } else {
            Vec::new()
        };
        Some(Self {
            kind,
            workspace_id: identity(&workspace).ok()?,
            temp_id: identity(&temp).ok()?,
            workspace,
            temp,
            invocation: program.to_owned(),
            program: program.canonicalize().ok()?,
            reads,
            writes,
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
        let handle = cwd.dir_metadata().ok().map(|m| (m.dev(), m.ino()));
        self.network == network
            && self.invocation == program
            && handle == Some(self.workspace_id)
            && identity(workspace).ok() == Some(self.workspace_id)
            && identity(temp).ok() == Some(self.temp_id)
            && [workspace, temp, program]
                .into_iter()
                .zip([&self.workspace, &self.temp, &self.program])
                .all(|(path, expected)| path.canonicalize().is_ok_and(|path| path == *expected))
    }

    pub(super) fn command(&self, cwd: &Dir, args: &[String]) -> io::Result<Command> {
        let scan = super::scan(&self.workspace, &self.temp)?;
        let filter = socket_filter(self.network)?;
        match self.kind {
            Kind::Landlock(abi) => {
                // Landlock only adds access beneath a path and cannot carve out `.git` or a
                // shared file below the writable workspace, so it refuses such a workspace.
                if !scan.git.is_empty() || !scan.shared.is_empty() {
                    return Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        "Landlock cannot keep .git or shared hard links read-only",
                    ));
                }
                let mut command = self.landlock(cwd, abi, args)?;
                restrict_sockets(&mut command, filter);
                Ok(command)
            }
            Kind::Bubblewrap => self.bubblewrap(args, &scan, &filter),
        }
    }

    fn landlock(&self, cwd: &Dir, abi: i32, args: &[String]) -> io::Result<Command> {
        let attr = RulesetAttr {
            fs: FS_ABI_3 | if abi >= 5 { DEVICE_IOCTL } else { 0 },
            net: if abi >= 4 && !self.network {
                TCP_BIND_CONNECT
            } else {
                0
            },
        };
        let size = if abi >= 4 {
            size_of::<RulesetAttr>()
        } else {
            size_of::<u64>()
        };
        let fd = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, &attr, size, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        for path in self
            .reads
            .iter()
            .map(PathBuf::as_path)
            .chain([self.program.as_path()])
        {
            if path.exists() {
                add_path(&fd, path, EXECUTE | READ_FILE | READ_DIR)?;
            }
        }
        for path in &self.writes {
            add_path(&fd, path, FS_ABI_3)?;
        }
        for path in DEVICES {
            add_path(&fd, Path::new(path), READ_FILE | WRITE_FILE)?;
        }
        let temp = open_path(&self.temp)?;
        let metadata = temp.metadata()?;
        if (metadata.dev(), metadata.ino()) != self.temp_id {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "task directory was replaced",
            ));
        }
        add_rule(&fd, cwd.as_raw_fd(), FS_ABI_3)?;
        add_rule(&fd, temp.as_raw_fd(), FS_ABI_3)?;

        let mut command = Command::new(&self.invocation);
        command.args(args);
        // The fd is built and populated in the parent, and stays live through spawn.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0
                    || libc::syscall(libc::SYS_landlock_restrict_self, fd.as_raw_fd(), 0) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Ok(command)
    }

    fn bubblewrap(
        &self,
        args: &[String],
        scan: &super::Scan,
        filter: &[libc::sock_filter],
    ) -> io::Result<Command> {
        let mut command = Command::new("/usr/bin/bwrap");
        command.args([
            "--die-with-parent",
            "--new-session",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--cap-drop",
            "ALL",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
        ]);
        if !self.network {
            command.arg("--unshare-net");
        }
        // bwrap creates an empty mount tree and adds only the listed paths.
        for path in self
            .reads
            .iter()
            .map(PathBuf::as_path)
            .chain([self.program.as_path()])
        {
            if path.exists() {
                let bind = if self.writes.iter().any(|write| write == path) {
                    "--bind"
                } else {
                    "--ro-bind"
                };
                command.arg(bind).arg(path).arg(path);
            }
        }
        if self.invocation != self.program
            && !self
                .reads
                .iter()
                .any(|root| self.invocation.starts_with(root))
        {
            command
                .arg("--ro-bind")
                .arg(&self.program)
                .arg(&self.invocation);
        }
        for path in [&self.workspace, &self.temp] {
            command.arg("--bind").arg(path).arg(path);
        }
        // Later mounts cover earlier ones. Directory links named `.git` are skipped: binding
        // one would mount its target, which may lie outside the workspace.
        for path in scan.git.iter().chain(&scan.shared) {
            if !fs::symlink_metadata(path)?.file_type().is_symlink() {
                command.arg("--ro-bind").arg(path).arg(path);
            }
        }
        // bwrap applies the filter to the program only, after its own namespace setup (which
        // needs a netlink socket), and sets no_new_privs itself.
        let program = seccomp_program(filter)?;
        command
            .arg("--seccomp")
            .arg(program.as_raw_fd().to_string())
            .arg("--chdir")
            .arg(&self.workspace)
            .arg("--")
            .arg(&self.invocation)
            .args(args);
        unsafe {
            command.pre_exec(move || {
                // Inherit the filter descriptor into bwrap only.
                if libc::fcntl(program.as_raw_fd(), libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Ok(command)
    }
}

/// A pipe holding the compiled filter, for `bwrap --seccomp`.
fn seccomp_program(filter: &[libc::sock_filter]) -> io::Result<OwnedFd> {
    let mut fds = [0; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let (read, mut write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) };
    let bytes =
        unsafe { std::slice::from_raw_parts(filter.as_ptr().cast::<u8>(), size_of_val(filter)) };
    // A few hundred bytes, well within the pipe buffer.
    write.write_all(bytes)?;
    Ok(read)
}

fn open_path(path: &Path) -> io::Result<File> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn add_path(ruleset: &OwnedFd, path: &Path, access: u64) -> io::Result<()> {
    let file = open_path(path)?;
    let access = if file.metadata()?.is_dir() {
        access
    } else {
        access & (EXECUTE | READ_FILE | WRITE_FILE | TRUNCATE)
    };
    add_rule(ruleset, file.as_raw_fd(), access)
}

fn add_rule(ruleset: &OwnedFd, parent_fd: i32, access: u64) -> io::Result<()> {
    let rule = PathBeneathAttr { access, parent_fd };
    // LANDLOCK_RULE_PATH_BENEATH
    if unsafe {
        libc::syscall(
            libc::SYS_landlock_add_rule,
            ruleset.as_raw_fd(),
            1,
            &rule,
            0,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

// Landlock mediates TCP, but does not block UDP or abstract Unix sockets.
// seccomp also blocks io_uring setup, which can issue socket operations.
fn socket_filter(network: bool) -> io::Result<Vec<libc::sock_filter>> {
    let arch = if cfg!(target_arch = "x86_64") {
        0xc000_003e
    } else if cfg!(target_arch = "aarch64") {
        0xc000_00b7
    } else {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "unsupported seccomp architecture",
        ));
    };
    const LOAD_WORD: u16 = 0x20;
    const EQUAL: u16 = 0x15;
    const AT_LEAST: u16 = 0x35;
    const RETURN: u16 = 0x06;
    const DENY: u32 = 0x0005_0000 | libc::EPERM as u32;
    const ALLOW: u32 = 0x7fff_0000;
    let op = |code, jt, jf, k| libc::sock_filter { code, jt, jf, k };
    let mut filter = vec![
        op(LOAD_WORD, 0, 0, 4), // seccomp_data.arch
        op(EQUAL, 1, 0, arch),
        op(RETURN, 0, 0, 0x8000_0000),   // SECCOMP_RET_KILL_PROCESS
        op(LOAD_WORD, 0, 0, 0),          // seccomp_data.nr
        op(AT_LEAST, 0, 1, 0x4000_0000), // x32 syscall numbers
        op(RETURN, 0, 0, DENY),
        op(EQUAL, 0, 1, libc::SYS_io_uring_setup as u32),
        op(RETURN, 0, 0, DENY),
        op(EQUAL, 1, 0, libc::SYS_socket as u32),
        op(RETURN, 0, 0, ALLOW),
    ];
    if network {
        filter.extend([
            op(LOAD_WORD, 0, 0, 16), // seccomp_data.args[0], address family
            op(EQUAL, 2, 0, libc::AF_INET as u32),
            op(EQUAL, 1, 0, libc::AF_INET6 as u32),
            op(RETURN, 0, 0, DENY),
            op(RETURN, 0, 0, ALLOW),
        ]);
    } else {
        filter.push(op(RETURN, 0, 0, DENY));
    }
    Ok(filter)
}

fn restrict_sockets(command: &mut Command, filter: Vec<libc::sock_filter>) {
    unsafe {
        command.pre_exec(move || {
            let program = libc::sock_fprog {
                len: filter.len() as u16,
                filter: filter.as_ptr().cast_mut(),
            };
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0
                || libc::prctl(libc::PR_SET_SECCOMP, 2, &program) < 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_bubblewrap_and_selects_landlock_only_with_the_required_abi() {
        for (abi, online, bwrap, expected) in [
            (4, false, false, "landlock"),
            (4, false, true, "bwrap"),
            (3, false, false, "none"),
            (3, false, true, "bwrap"),
            (3, true, false, "landlock"),
            (0, false, true, "bwrap"),
            (0, false, false, "none"),
        ] {
            let actual = match candidates(abi, online, bwrap).next() {
                Some(Kind::Landlock(_)) => "landlock",
                Some(Kind::Bubblewrap) => "bwrap",
                None => "none",
            };
            assert_eq!(actual, expected);
        }
        assert_eq!(candidates(4, false, true).count(), 2);
    }
}
