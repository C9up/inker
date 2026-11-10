//! Where the file behind an open descriptor lives, asked of the descriptor.
//!
//! A path checked before `open` is only a name: whoever can write next to it
//! can swap it, or a directory above it, for a link between the check and the
//! open. The descriptor is what was actually opened, so its confinement is
//! decided on the path the system gives for the descriptor itself.
//!
//! Linux answers through `/proc/self/fd`, which the TypeScript side reads; here
//! are the systems without procfs. Anything this cannot answer comes back as
//! `None`, and the caller treats that as "not proven", never as "inside".

/// macOS: `fcntl(F_GETPATH)` names the vnode the descriptor holds.
#[cfg(target_os = "macos")]
pub fn path_of(fd: i32) -> Option<String> {
    if fd < 0 {
        return None;
    }
    let mut buffer = vec![0u8; libc::MAXPATHLEN as usize];
    // SAFETY: F_GETPATH writes at most MAXPATHLEN bytes, NUL included, into a
    // buffer of exactly that size. The descriptor belongs to a FileHandle the
    // caller keeps open for the duration of this synchronous call.
    let status = unsafe { libc::fcntl(fd, libc::F_GETPATH, buffer.as_mut_ptr()) };
    if status == -1 {
        return None;
    }
    let end = buffer.iter().position(|byte| *byte == 0)?;
    buffer.truncate(end);
    String::from_utf8(buffer).ok()
}

/// Windows: the descriptor is a C runtime one, owned by the runtime linked
/// into the host executable rather than by this library's, so the host's own
/// `uv_get_osfhandle` turns it into the file's HANDLE; the HANDLE's final path
/// is then read the way the host's `realpath` reads it, so both compare.
#[cfg(windows)]
pub fn path_of(fd: i32) -> Option<String> {
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    if fd < 0 {
        return None;
    }
    let to_handle = host_osfhandle()?;
    // SAFETY: the host's `uv_get_osfhandle` takes any int and answers
    // INVALID_HANDLE_VALUE for one it does not know; the descriptor stays open
    // for the duration of this synchronous call.
    let handle: HANDLE = unsafe { to_handle(fd) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
    let mut buffer: Vec<u16> = vec![0; 512];
    loop {
        let capacity = u32::try_from(buffer.len()).ok()?;
        // SAFETY: the buffer holds `capacity` u16s; the call writes at most
        // that many, or answers the size it needs without writing.
        let written =
            unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), capacity, flags) };
        if written == 0 {
            return None;
        }
        let written = usize::try_from(written).ok()?;
        if written < buffer.len() {
            buffer.truncate(written);
            break;
        }
        // Too small: `written` is the size needed, terminator included.
        buffer.resize(written, 0);
    }
    let path = String::from_utf16(&buffer).ok()?;
    host_form(&path)
}

/// The final path in the form the host's `realpath` gives it: `\\?\C:\x` as
/// `C:\x` and `\\?\UNC\server\share` as `\\server\share`. Any other shape is
/// refused, as `realpath` refuses it.
#[cfg(windows)]
fn host_form(path: &str) -> Option<String> {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return Some(format!(r"\\{rest}"));
    }
    path.strip_prefix(r"\\?\").map(str::to_owned)
}

/// The host's `uv_get_osfhandle`, resolved once from the executable the
/// N-API symbols themselves come from.
#[cfg(windows)]
fn host_osfhandle() -> Option<HostOsfhandle> {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    static RESOLVED: OnceLock<Option<HostOsfhandle>> = OnceLock::new();
    *RESOLVED.get_or_init(|| {
        // SAFETY: a null name asks for the executable's own module, which
        // lives as long as the process; the symbol name is NUL-terminated.
        let found = unsafe {
            let module = GetModuleHandleW(std::ptr::null());
            if module.is_null() {
                return None;
            }
            GetProcAddress(module, c"uv_get_osfhandle".as_ptr().cast())
        }?;
        // SAFETY: libuv declares `uv_os_fd_t uv_get_osfhandle(int fd)`, and
        // `uv_os_fd_t` is a HANDLE on Windows.
        Some(unsafe {
            std::mem::transmute::<unsafe extern "system" fn() -> isize, HostOsfhandle>(found)
        })
    })
}

#[cfg(windows)]
type HostOsfhandle = unsafe extern "C" fn(i32) -> windows_sys::Win32::Foundation::HANDLE;

/// Elsewhere there is no answer from here: Linux is asked through procfs by
/// the caller, and an unknown system stays unproven.
#[cfg(not(any(target_os = "macos", windows)))]
pub fn path_of(fd: i32) -> Option<String> {
    let _ = fd;
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_negative_descriptor_names_nothing() {
        assert_eq!(path_of(-1), None);
    }

    /// Windows is not asked here: a test executable carries no libuv, so the
    /// host lookup has nothing to find. The containment tests ask it
    /// under Node.
    #[cfg(target_os = "macos")]
    #[test]
    fn names_an_open_file_by_its_descriptor() {
        use std::os::fd::AsRawFd;

        let directory = std::env::temp_dir().join(format!("inker-opened-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("scratch directory");
        let file = directory.join("named.bin");
        std::fs::write(&file, b"x").expect("scratch file");
        let opened = std::fs::File::open(&file).expect("open");
        let expected = std::fs::canonicalize(&file).expect("canonical path");
        let located = path_of(opened.as_raw_fd());
        std::fs::remove_dir_all(&directory).ok();
        assert_eq!(
            located.as_deref(),
            Some(expected.to_string_lossy().as_ref())
        );
    }
}
