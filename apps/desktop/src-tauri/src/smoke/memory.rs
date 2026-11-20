//! App-process resident memory. WebView helper processes are separate.

#[cfg(target_os = "linux")]
pub fn resident() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    // SAFETY: sysconf has no memory-safety preconditions.
    let page_size = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
    resident_pages(&statm)?
        .checked_mul(page_size)
        .filter(|bytes| *bytes > 0)
}

#[cfg(any(target_os = "linux", test))]
fn resident_pages(statm: &str) -> Option<u64> {
    statm.split_ascii_whitespace().nth(1)?.parse().ok()
}

#[cfg(target_os = "macos")]
pub fn resident() -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
    let written = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTASKINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    // SAFETY: the call above filled the whole struct.
    Some(unsafe { info.assume_init() }.pti_resident_size)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn resident() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_resident_pages() {
        assert_eq!(resident_pages("1000 250 30 1 0 400 0"), Some(250));
        assert_eq!(resident_pages("1000"), None);
        assert_eq!(resident_pages("1000 invalid"), None);
    }

    #[test]
    fn samples_current_process_when_supported() {
        if cfg!(any(target_os = "macos", target_os = "linux")) {
            assert!(resident().is_some_and(|bytes| bytes > 0));
        } else {
            assert_eq!(resident(), None);
        }
    }
}
