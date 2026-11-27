use cap_std::fs::Dir;
use std::{
    ffi::{c_void, OsStr, OsString},
    fs::{self, File, OpenOptions},
    io,
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::ExitStatusExt,
    },
    path::{Path, PathBuf},
    process::{Command, ExitStatus},
    ptr::{null, null_mut},
};
use uuid::Uuid;
use windows_sys::Win32::{
    Foundation::{
        LocalFree, SetHandleInformation, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, HANDLE,
        HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Security::{
        Authorization::{
            GetSecurityInfo, SetEntriesInAclW, SetSecurityInfo, EXPLICIT_ACCESS_W, GRANT_ACCESS,
            REVOKE_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
        },
        CreateWellKnownSid, FreeSid,
        Isolation::{
            CreateAppContainerProfile, DeleteAppContainerProfile,
            DeriveAppContainerSidFromAppContainerName,
        },
        WinCapabilityInternetClientSid, DACL_SECURITY_INFORMATION, PSID, SECURITY_ATTRIBUTES,
        SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    },
    Storage::FileSystem::{
        GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION, DELETE,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
        FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        READ_CONTROL, WRITE_DAC,
    },
    System::{
        Pipes::CreatePipe,
        Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
            InitializeProcThreadAttributeList, ResumeThread, TerminateProcess,
            UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
            CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
            LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
        },
    },
};

use crate::terminal::platform::{guard_handle, ProcessGuard};

const READ: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
const WRITE: u32 = READ | FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD;
const TOOLCHAINS: &[&str] = &[
    ".cargo/bin",
    ".cargo/git",
    ".cargo/registry",
    ".rustup/toolchains",
    ".rustup/settings.toml",
    ".nvm/versions",
    "go/pkg/mod",
];

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain([0]).collect()
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "invalid AppContainer path or argument",
    )
}

fn profile_name(task: Uuid) -> Vec<u16> {
    wide(OsStr::new(&format!("Turing.Agent.{task}")))
}

fn win32(code: u32) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32))
    }
}

fn hresult(code: i32) -> io::Result<()> {
    if code >= 0 {
        Ok(())
    } else if code as u32 & 0xffff_0000 == 0x8007_0000 {
        win32(code as u32 & 0xffff)
    } else {
        Err(io::Error::from_raw_os_error(code))
    }
}

struct Sid(PSID);

// The Win32 allocation has a single owner, is immutable after construction,
// and FreeSid is independent of the thread that allocated it.
unsafe impl Send for Sid {}

impl Drop for Sid {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { FreeSid(self.0) };
        }
    }
}

struct LocalBuffer(*mut c_void);

impl Drop for LocalBuffer {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { LocalFree(self.0) };
        }
    }
}

fn file_info(handle: HANDLE) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(invalid());
    }
    Ok(info)
}

fn file_id(handle: HANDLE) -> io::Result<(u32, u32, u32)> {
    let info = file_info(handle)?;
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

fn grant_handle(path: &Path) -> io::Result<File> {
    if path.canonicalize()? != path {
        return Err(invalid());
    }
    let file = OpenOptions::new()
        .access_mode(FILE_READ_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC)
        // Keep the granted root from being renamed while a live sandbox uses it.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    file_info(file.as_raw_handle())?;
    if final_path(file.as_raw_handle())? != path {
        return Err(invalid());
    }
    Ok(file)
}

fn final_path(handle: HANDLE) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;

    let length = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, 0) };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut units = vec![0; length as usize];
    let written = unsafe { GetFinalPathNameByHandleW(handle, units.as_mut_ptr(), length, 0) };
    if written == 0 || written >= length {
        return Err(io::Error::last_os_error());
    }
    Ok(PathBuf::from(OsString::from_wide(
        &units[..written as usize],
    )))
}

fn check_inheritance_scope(root: &Path) -> io::Result<()> {
    // Inheritable DACL changes can affect existing children. Reject links
    // rather than granting access to an object with a name outside the scope.
    let mut directories = vec![root.to_path_buf()];
    while let Some(path) = directories.pop() {
        for entry in fs::read_dir(path)? {
            let path = entry?.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(invalid());
            }
            if metadata.is_dir() {
                directories.push(path);
            } else {
                let file = OpenOptions::new()
                    .access_mode(0)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
                    .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&path)?;
                if file_info(file.as_raw_handle())?.nNumberOfLinks != 1 {
                    return Err(invalid());
                }
            }
        }
    }
    Ok(())
}

fn acl(file: &File, sid: PSID, rights: Option<u32>) -> io::Result<()> {
    let mut descriptor = LocalBuffer(null_mut());
    let mut old = null_mut();
    let handle = file.as_raw_handle();
    unsafe {
        win32(GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old,
            null_mut(),
            &mut descriptor.0,
        ))?;
    }
    // Null DACLs are unrestricted. Never replace one with a new ACL here.
    if old.is_null() {
        return if rights.is_none() {
            Ok(())
        } else {
            Err(invalid())
        };
    }
    let mut entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: rights.unwrap_or(0),
        grfAccessMode: if rights.is_some() {
            GRANT_ACCESS
        } else {
            REVOKE_ACCESS
        },
        grfInheritance: if file.metadata()?.is_dir() {
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        } else {
            0
        },
        ..Default::default()
    };
    entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
    entry.Trustee.ptstrName = sid.cast();
    let mut updated = null_mut();
    unsafe {
        win32(SetEntriesInAclW(1, &entry, old, &mut updated))?;
    }
    let _updated = LocalBuffer(updated.cast());
    unsafe {
        win32(SetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            updated,
            null_mut(),
        ))
    }
}

pub(super) fn revoke(task: Uuid, grants: &[String]) -> io::Result<()> {
    let name = profile_name(task);
    let mut sid = Sid(null_mut());
    hresult(unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid.0) })?;
    let mut failure = None;
    for path in grants.iter().rev().map(Path::new) {
        match grant_handle(path).and_then(|file| acl(&file, sid.0, None)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    match hresult(unsafe { DeleteAppContainerProfile(name.as_ptr()) }) {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) => {}
        Err(error) => {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

pub(super) struct Policy {
    task: Uuid,
    sid: Sid,
    grants: Vec<File>,
    workspace: PathBuf,
    temp: PathBuf,
    program: PathBuf,
    network: bool,
}

impl Drop for Policy {
    fn drop(&mut self) {
        // Use the held handles for cleanup, even if path lookup would fail.
        // The durable list is retained by the checkpoint for another attempt.
        for file in self.grants.iter().rev() {
            let _ = acl(file, self.sid.0, None);
        }
        unsafe { DeleteAppContainerProfile(profile_name(self.task).as_ptr()) };
    }
}

impl Policy {
    pub(super) fn new(
        task: Uuid,
        cwd: &Dir,
        workspace: &Path,
        temp: &Path,
        home: Option<&Path>,
        program: &Path,
        network: bool,
        record: &mut dyn FnMut(&Path) -> io::Result<()>,
    ) -> io::Result<Self> {
        let workspace = workspace.canonicalize()?;
        let temp = temp.canonicalize()?;
        let home = home.ok_or_else(invalid)?.canonicalize()?;
        if workspace.starts_with(&temp)
            || temp.starts_with(&workspace)
            || home.starts_with(&workspace)
            || home.starts_with(&temp)
        {
            return Err(invalid());
        }
        let program = program.canonicalize()?;
        let root = grant_handle(&workspace)?;
        if file_id(root.as_raw_handle())? != file_id(cwd.as_raw_handle())? {
            return Err(invalid());
        }
        let name = profile_name(task);
        let mut sid = Sid(null_mut());
        // The caller creates the task checkpoint before calling this method.
        let created = unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                name.as_ptr(),
                name.as_ptr(),
                null(),
                0,
                &mut sid.0,
            )
        };
        match hresult(created) {
            Err(e) if e.raw_os_error() == Some(ERROR_ALREADY_EXISTS as i32) => return Err(e),
            result => result?,
        }
        let mut policy = Self {
            task,
            sid,
            grants: Vec::new(),
            workspace: workspace.clone(),
            temp: temp.clone(),
            program: program.clone(),
            network,
        };
        policy.grant(&workspace, root, WRITE, record)?;
        policy.grant(&temp, grant_handle(&temp)?, WRITE, record)?;

        let mut reads = TOOLCHAINS
            .iter()
            .map(|path| home.join(path))
            .collect::<Vec<_>>();
        reads.extend([
            home.join("AppData/Roaming/npm"),
            home.join("AppData/Local/pnpm"),
            home.join("AppData/Local/npm-cache/_cacache"),
        ]);
        for path in reads {
            if path.starts_with(&workspace) || path.starts_with(&temp) {
                continue;
            }
            if path.canonicalize().is_ok_and(|canonical| canonical == path) {
                policy.grant(&path, grant_handle(&path)?, READ, record)?;
            }
        }
        // The program may live in a CI tool cache or a standalone installation.
        // Grant the exact file when outside the workspace and scratch scope.
        if !program.starts_with(&workspace) && !program.starts_with(&temp) {
            policy.grant(&program, grant_handle(&program)?, READ, record)?;
        }
        Ok(policy)
    }

    fn grant(
        &mut self,
        path: &Path,
        file: File,
        rights: u32,
        record: &mut dyn FnMut(&Path) -> io::Result<()>,
    ) -> io::Result<()> {
        path.to_str().ok_or_else(invalid)?;
        if file.metadata()?.is_dir() {
            check_inheritance_scope(path)?;
        }
        record(path)?;
        self.grants.push(file);
        acl(
            self.grants.last().ok_or_else(invalid)?,
            self.sid.0,
            Some(rights),
        )
    }

    pub(super) fn matches(
        &self,
        cwd: &Dir,
        workspace: &Path,
        temp: &Path,
        program: &Path,
        network: bool,
    ) -> bool {
        self.network == network
            && file_id(cwd.as_raw_handle())
                .ok()
                .zip(file_id(self.grants[0].as_raw_handle()).ok())
                .is_some_and(|(actual, expected)| actual == expected)
            && [workspace, temp, program]
                .into_iter()
                .zip([&self.workspace, &self.temp, &self.program])
                .all(|(actual, expected)| {
                    actual
                        .canonicalize()
                        .is_ok_and(|actual| actual == *expected)
                })
    }

    pub(super) fn spawn(&self, command: &Command) -> io::Result<ContainerChild> {
        let (program, mut line) = command_line(&self.program, command)?;
        let cwd = wide(self.workspace.as_os_str());
        let environment = environment_block(command)?;
        let (stdin, stdin_writer) = pipe()?;
        drop(stdin_writer);
        let (stdout, stdout_writer) = pipe()?;
        let (stderr, stderr_writer) = pipe()?;
        let mut handles = [
            stdin.as_raw_handle(),
            stdout_writer.as_raw_handle(),
            stderr_writer.as_raw_handle(),
        ];
        for handle in handles {
            if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
        }

        // SID buffers are DWORD aligned and must stay live through CreateProcessW.
        let mut internet_sid = [0u32; 17];
        let mut length = size_of_val(&internet_sid) as u32;
        let mut internet = SID_AND_ATTRIBUTES::default();
        if self.network {
            internet.Sid = internet_sid.as_mut_ptr().cast();
            internet.Attributes = 4; // SE_GROUP_ENABLED
            if unsafe {
                CreateWellKnownSid(
                    WinCapabilityInternetClientSid,
                    null_mut(),
                    internet.Sid,
                    &mut length,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        let mut security = SECURITY_CAPABILITIES {
            AppContainerSid: self.sid.0,
            Capabilities: if self.network {
                &mut internet
            } else {
                null_mut()
            },
            CapabilityCount: u32::from(self.network),
            Reserved: 0,
        };
        let attributes = Attributes::new()?;
        attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &mut security)?;
        attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &mut handles)?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        [
            startup.StartupInfo.hStdInput,
            startup.StartupInfo.hStdOutput,
            startup.StartupInfo.hStdError,
        ] = handles;
        startup.lpAttributeList = attributes.raw();
        let mut info = PROCESS_INFORMATION::default();
        let flags = CREATE_SUSPENDED
            | CREATE_NO_WINDOW
            | CREATE_UNICODE_ENVIRONMENT
            | EXTENDED_STARTUPINFO_PRESENT;
        if unsafe {
            CreateProcessW(
                program.as_ptr(),
                line.as_mut_ptr(),
                null(),
                null(),
                1,
                flags,
                environment.as_ptr().cast(),
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let process = unsafe { OwnedHandle::from_raw_handle(info.hProcess) };
        let thread = unsafe { OwnedHandle::from_raw_handle(info.hThread) };
        let job = guard_handle(process.as_raw_handle()).map_err(|_| {
            unsafe {
                TerminateProcess(process.as_raw_handle(), 1);
                WaitForSingleObject(process.as_raw_handle(), INFINITE);
            }
            io::Error::other("could not attach AppContainer process to the job")
        })?;
        if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
            return Err(io::Error::last_os_error());
        }
        Ok(ContainerChild {
            process,
            stdout,
            stderr,
            job,
        })
    }
}

struct Attributes(Vec<usize>);

impl Attributes {
    fn new() -> io::Result<Self> {
        let mut bytes = 0;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes) };
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        if unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 2, 0, &mut bytes)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(storage))
    }

    fn raw(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.0.as_ptr().cast_mut().cast()
    }

    fn set<T>(&self, attribute: u32, value: &mut T) -> io::Result<()> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.raw(),
                0,
                attribute as usize,
                (value as *mut T).cast(),
                size_of::<T>(),
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.raw()) };
    }
}

pub(crate) struct ContainerChild {
    pub(crate) process: OwnedHandle,
    pub(crate) stdout: File,
    pub(crate) stderr: File,
    pub(crate) job: ProcessGuard,
}

pub(crate) fn try_wait(process: &OwnedHandle) -> io::Result<Option<ExitStatus>> {
    match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
        WAIT_TIMEOUT => Ok(None),
        WAIT_OBJECT_0 => {
            let mut code = 0;
            if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Some(ExitStatus::from_raw(code)))
        }
        _ => Err(io::Error::last_os_error()),
    }
}

fn pipe() -> io::Result<(File, File)> {
    let (mut read, mut write) = (null_mut(), null_mut());
    let attrs = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 0,
    };
    if unsafe { CreatePipe(&mut read, &mut write, &attrs, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (File::from_raw_handle(read), File::from_raw_handle(write)) })
}

fn environment_block(command: &Command) -> io::Result<Vec<u16>> {
    let mut entries: Vec<(OsString, &OsStr)> = command
        .get_envs()
        .filter_map(|(key, value)| value.map(|value| (key.to_ascii_uppercase(), value)))
        .collect();
    entries.sort_by(|(left, _), (right, _)| left.cmp(right));
    entries.dedup_by(|(left, _), (right, _)| left == right);
    let mut result = Vec::new();
    for (key, value) in entries {
        let entry: Vec<_> = key
            .encode_wide()
            .chain([b'=' as u16])
            .chain(value.encode_wide())
            .collect();
        if entry.contains(&0) {
            return Err(invalid());
        }
        result.extend(entry);
        result.push(0);
    }
    if result.is_empty() {
        result.push(0);
    }
    result.push(0);
    Ok(result)
}

fn quote_windows_arg(argument: &OsStr, output: &mut Vec<u16>) -> io::Result<()> {
    const BACKSLASH: u16 = b'\\' as u16;
    const QUOTE: u16 = b'"' as u16;
    output.push(QUOTE);
    let mut slashes = 0;
    for unit in argument.encode_wide() {
        match unit {
            0 => return Err(invalid()),
            BACKSLASH => {
                slashes += 1;
                continue;
            }
            QUOTE => output.extend(std::iter::repeat_n(BACKSLASH, slashes + 1)),
            _ => {}
        }
        output.extend(std::iter::repeat_n(BACKSLASH, slashes));
        output.push(unit);
        slashes = 0;
    }
    output.extend(std::iter::repeat_n(BACKSLASH, slashes * 2));
    output.push(QUOTE);
    Ok(())
}

fn command_line(program: &Path, command: &Command) -> io::Result<(Vec<u16>, Vec<u16>)> {
    let is_batch = program
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
    let mut line = Vec::new();
    if is_batch {
        let system_root = std::env::var_os("SystemRoot").ok_or_else(invalid)?;
        let shell = PathBuf::from(system_root).join("System32/cmd.exe");
        quote_windows_arg(shell.as_os_str(), &mut line)?;
        line.extend(" /d /s /c \"".encode_utf16());
        for (index, arg) in std::iter::once(program.as_os_str())
            .chain(command.get_args())
            .enumerate()
        {
            let units: Vec<_> = arg.encode_wide().collect();
            if units
                .iter()
                .any(|ch| *ch == 0 || "%^&|<>!\"\r\n".encode_utf16().any(|bad| *ch == bad))
            {
                return Err(invalid());
            }
            if index > 0 {
                line.push(b' ' as u16);
            }
            line.push(b'"' as u16);
            line.extend(units);
            line.push(b'"' as u16);
        }
        line.push(b'"' as u16);
        line.push(0);
        return Ok((wide(shell.as_os_str()), line));
    }
    quote_windows_arg(program.as_os_str(), &mut line)?;
    for argument in command.get_args() {
        line.push(b' ' as u16);
        quote_windows_arg(argument, &mut line)?;
    }
    line.push(0);
    Ok((wide(program.as_os_str()), line))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;
    use windows_sys::Win32::{
        Security::{EqualSid, GetAce, ACCESS_ALLOWED_ACE},
        UI::Shell::CommandLineToArgvW,
    };

    #[test]
    fn windows_argv_round_trips() {
        for arg in ["a b", "a\"b", "a\\\"b", "a\\", "", "日本語"] {
            let mut line = vec![b'x' as u16, b' ' as u16];
            quote_windows_arg(OsStr::new(arg), &mut line).unwrap();
            line.push(0);
            let mut count = 0;
            unsafe {
                let argv = CommandLineToArgvW(line.as_ptr(), &mut count);
                assert!(!argv.is_null());
                let _allocation = LocalBuffer(argv.cast());
                assert_eq!(count, 2);
                let value = *argv.add(1);
                for (index, expected) in arg.encode_utf16().chain([0]).enumerate() {
                    assert_eq!(*value.add(index), expected);
                }
            }
        }
    }

    #[test]
    fn rejects_batch_metacharacters_before_spawning() {
        let program = Path::new(r"C:\test\pnpm.cmd");
        for argument in ["a&b", "a\nb", "%PATH%", "\"quoted\""] {
            assert!(command_line(program, Command::new(program).arg(argument)).is_err());
        }
        assert!(command_line(program, Command::new(program).arg("a")).is_ok());
    }

    fn has_allow_ace(path: &Path, sid: PSID) -> bool {
        let file = grant_handle(path).unwrap();
        let mut descriptor = LocalBuffer(null_mut());
        let mut acl = null_mut();
        unsafe {
            win32(GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut acl,
                null_mut(),
                &mut descriptor.0,
            ))
            .unwrap();
            (0..u32::from((*acl).AceCount)).any(|index| {
                let mut entry = null_mut();
                assert_ne!(GetAce(acl, index, &mut entry), 0);
                let ace = entry.cast::<ACCESS_ALLOWED_ACE>();
                (*ace).Header.AceType == 0 && EqualSid((&raw mut (*ace).SidStart).cast(), sid) != 0
            })
        }
    }

    struct Fixture {
        _root: tempfile::TempDir,
        workspace: PathBuf,
        temp: PathBuf,
        home: PathBuf,
        program: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let [workspace, temp, home, program] =
                ["workspace", "scratch", "home", "test.exe"].map(|name| root.path().join(name));
            for dir in [&workspace, &temp, &home] {
                fs::create_dir(dir).unwrap();
            }
            fs::write(&program, "").unwrap();
            Self {
                _root: root,
                workspace: workspace.canonicalize().unwrap(),
                temp: temp.canonicalize().unwrap(),
                home: home.canonicalize().unwrap(),
                program: program.canonicalize().unwrap(),
            }
        }

        fn policy(
            &self,
            task: Uuid,
            record: &mut dyn FnMut(&Path) -> io::Result<()>,
        ) -> io::Result<Policy> {
            let cwd = Dir::open_ambient_dir(&self.workspace, ambient_authority()).unwrap();
            Policy::new(
                task,
                &cwd,
                &self.workspace,
                &self.temp,
                Some(&self.home),
                &self.program,
                false,
                record,
            )
        }
    }

    #[test]
    fn recorder_failure_leaves_no_container_acl() {
        let fixture = Fixture::new();
        let task = Uuid::new_v4();
        let mut sid = Sid(null_mut());
        hresult(unsafe {
            DeriveAppContainerSidFromAppContainerName(profile_name(task).as_ptr(), &mut sid.0)
        })
        .unwrap();
        let result = fixture.policy(task, &mut |path| {
            assert_eq!(path, fixture.workspace);
            assert!(!has_allow_ace(path, sid.0));
            Err(io::Error::other("journal is unavailable"))
        });
        assert!(result.is_err());
        assert!(!has_allow_ace(&fixture.workspace, sid.0));
    }

    #[test]
    fn refuses_workspace_with_a_hard_link_before_recording_grants() {
        let fixture = Fixture::new();
        fs::hard_link(&fixture.program, fixture.workspace.join("linked.exe")).unwrap();
        let mut calls = 0;
        let result = fixture.policy(Uuid::new_v4(), &mut |_| {
            calls += 1;
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(calls, 0);
    }

    #[test]
    fn crash_cleanup_removes_grants_from_roots_and_inheriting_children() {
        let fixture = Fixture::new();
        let task = Uuid::new_v4();
        let child = fixture.workspace.join("inheriting-child");
        fs::write(&child, "").unwrap();
        let toolchain = fixture.home.join(".cargo/bin");
        fs::create_dir_all(&toolchain).unwrap();
        let mut recorded = Vec::new();
        let mut policy = std::mem::ManuallyDrop::new(
            fixture
                .policy(task, &mut |path| {
                    recorded.push(path.to_str().unwrap().to_owned());
                    Ok(())
                })
                .unwrap(),
        );
        assert!(has_allow_ace(&child, policy.sid.0));
        assert!(has_allow_ace(&toolchain, policy.sid.0));
        for path in &recorded {
            assert!(has_allow_ace(Path::new(path), policy.sid.0));
        }
        // Simulate host exit by closing its handles without running policy cleanup.
        policy.grants.clear();
        revoke(task, &recorded).unwrap();
        for path in &recorded {
            assert!(!has_allow_ace(Path::new(path), policy.sid.0));
        }
        assert!(!has_allow_ace(&child, policy.sid.0));
        let name = profile_name(task);
        let mut recreated = Sid(null_mut());
        hresult(unsafe {
            CreateAppContainerProfile(
                name.as_ptr(),
                name.as_ptr(),
                name.as_ptr(),
                null(),
                0,
                &mut recreated.0,
            )
        })
        .expect("cleanup should leave the profile name free");
        unsafe { std::mem::ManuallyDrop::drop(&mut policy) };
    }
}
