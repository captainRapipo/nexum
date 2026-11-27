//! Link-safe file creation for the elevated app inside user-writable folders (the cleanup audit
//! log under `%LOCALAPPDATA%`, settings under `%APPDATA%`).
//!
//! A standard-user process can plant junctions, mount points or object-manager symbolic links
//! in its own profile folders. Nexum runs as administrator, so a write there must land exactly
//! where it was meant to:
//! * every folder below a trusted base is opened with `FILE_FLAG_OPEN_REPARSE_POINT` (never
//!   followed), must not be a reparse point, and its final path as the file system reports it
//!   must equal the expected one;
//! * those folders stay open without `FILE_SHARE_DELETE` while the caller works in them, so
//!   none of them can be renamed or replaced in the meantime;
//! * new files are created with `CREATE_NEW` (never through an existing name or link) and their
//!   final path is verified the same way; a file that landed anywhere else is deleted again
//!   through its own handle.

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOLEAN, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FileDispositionInfo, GetFileInformationByHandle, SetFileInformationByHandle,
    BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_WRITE, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};

use crate::cleaner::{final_path, norm_path};
use crate::util::{to_wide, win32_code, OwnedHandle};

fn refused(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, msg.to_string())
}

fn win_io(e: windows::core::Error) -> io::Error {
    match win32_code(e.code().0) {
        Some(code) => io::Error::from_raw_os_error(code as i32),
        None => io::Error::new(io::ErrorKind::Other, e.message().trim().to_string()),
    }
}

/// Opens a folder without following a reparse point and without `FILE_SHARE_DELETE`.
fn open_dir_no_follow(path: &Path) -> io::Result<OwnedHandle> {
    let wide = to_wide(path);
    // SAFETY: `wide` is NUL-terminated and outlives the call; the handle is owned below.
    // FILE_LIST_DIRECTORY matters: a handle with attribute access only takes no part in the
    // share-mode check, so it would not stop a rename of the folder.
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            FILE_LIST_DIRECTORY.0 | FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            HANDLE::default(),
        )
    }
    .map_err(win_io)?;
    Ok(OwnedHandle(handle))
}

/// A real folder (not a reparse point).
fn check_plain_dir(h: &OwnedHandle) -> io::Result<()> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `h` is an open handle and `info` a valid out pointer.
    unsafe { GetFileInformationByHandle(h.0, &mut info) }.map_err(win_io)?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(refused("the folder is a link"));
    }
    if info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
        return Err(refused("the path is not a folder"));
    }
    Ok(())
}

/// The components of `dir` below `base`, with their original spelling. `None` unless `dir` is
/// strictly inside `base` (compared case-insensitively) through plain names only.
fn components_below(base: &Path, dir: &Path) -> Option<Vec<OsString>> {
    let b = norm_path(base);
    let d = norm_path(dir);
    if b.is_empty() || !(d.len() > b.len() + 1 && d.starts_with(&b) && d.as_bytes()[b.len()] == b'\\')
    {
        return None;
    }
    let count = d[b.len() + 1..].split('\\').count();
    let comps: Vec<Component<'_>> = dir.components().collect();
    let tail = comps.get(comps.len().checked_sub(count)?..)?;
    let mut names = Vec::with_capacity(count);
    for c in tail {
        match c {
            Component::Normal(n) => names.push(n.to_os_string()),
            _ => return None,
        }
    }
    // The tail must spell the same path as the normalized comparison above.
    let mut rebuilt = PathBuf::from(&b);
    for n in &names {
        rebuilt.push(n);
    }
    (norm_path(&rebuilt) == d).then_some(names)
}

/// A folder (and every folder between a trusted base and it) opened without following links,
/// verified, and held open so it cannot be swapped while in use.
pub struct PinnedDir {
    _chain: Vec<OwnedHandle>,
    /// Lexical path of the folder (used to build child paths).
    path: PathBuf,
    /// Normalized final path of the folder, as the file system reports it.
    final_norm: String,
}

impl PinnedDir {
    /// Opens every folder from `base` (exclusive, trusted: it must not be replaceable by a
    /// standard user) down to `dir` (inclusive), creating missing ones when `create` is set.
    /// Fails if `dir` is not strictly inside `base`, if any of those folders is a link, or if
    /// any of them resolves to somewhere other than `<canonical base>\<names>`.
    pub fn open(base: &Path, dir: &Path, create: bool) -> io::Result<PinnedDir> {
        let names = components_below(base, dir)
            .ok_or_else(|| refused("the folder is outside its expected location"))?;
        let mut expected = std::fs::canonicalize(base)?;
        let mut cur = base.to_path_buf();
        let mut chain = Vec::with_capacity(names.len());
        for name in &names {
            cur.push(name);
            expected.push(name);
            if create {
                // The parent is pinned already, so this lands in the verified parent; a link
                // that already sits at this name is caught by the checks below.
                match std::fs::create_dir(&cur) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(e),
                }
            }
            let h = open_dir_no_follow(&cur)?;
            check_plain_dir(&h)?;
            if final_path(h.0).as_deref() != Some(norm_path(&expected).as_str()) {
                return Err(refused("the folder resolves to a different location"));
            }
            chain.push(h);
        }
        Ok(PinnedDir {
            _chain: chain,
            path: cur,
            final_norm: norm_path(&expected),
        })
    }

    /// Lexical path of the pinned folder.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Creates a new file `name` in this folder (`CREATE_NEW`; `AlreadyExists` if the name is
    /// taken by anything, including a link) for writing, shared for reading only. Its final
    /// path is verified; a file that resolved elsewhere is deleted again and refused.
    pub fn create_new_file(&self, name: &str) -> io::Result<(File, PathBuf)> {
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.contains(['\\', '/', ':'])
            || name.chars().any(char::is_control)
        {
            return Err(refused("invalid file name"));
        }
        let path = self.path.join(name);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .access_mode(FILE_GENERIC_WRITE.0 | DELETE.0)
            .share_mode(FILE_SHARE_READ.0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(&path)?;
        let handle = HANDLE(file.as_raw_handle());
        let expected = norm_path(&Path::new(&self.final_norm).join(name));
        if final_path(handle).as_deref() != Some(expected.as_str()) {
            let info = FILE_DISPOSITION_INFO {
                DeleteFile: BOOLEAN(1),
            };
            // SAFETY: `handle` belongs to `file` (opened with DELETE access) and is still open;
            // `info` is a properly sized FILE_DISPOSITION_INFO.
            let _ = unsafe {
                SetFileInformationByHandle(
                    handle,
                    FileDispositionInfo,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            };
            drop(file);
            return Err(refused("the new file resolves to a different location"));
        }
        Ok((file, path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "nexum-test-safefs-{tag}-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn junction(link: &Path, target: &Path) -> bool {
        crate::util::hidden_command("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn components_below_requires_strict_containment() {
        let base = Path::new(r"C:\Users\Me");
        assert_eq!(
            components_below(base, Path::new(r"C:\Users\me\AppData\Local\Nexum")),
            Some(vec![
                OsString::from("AppData"),
                OsString::from("Local"),
                OsString::from("Nexum")
            ])
        );
        assert!(components_below(base, base).is_none());
        assert!(components_below(base, Path::new(r"C:\Users\Me2\x")).is_none());
        assert!(components_below(base, Path::new(r"C:\Users\Other\x")).is_none());
        assert!(components_below(base, Path::new(r"C:\Users\Me\..\Other")).is_none());
        assert!(components_below(base, Path::new(r"D:\Users\Me\x")).is_none());
    }

    #[test]
    fn creates_and_writes_inside_a_plain_tree() {
        let base = scratch("plain");
        let dir = base.join("Nexum").join("purge-logs");
        let pinned = PinnedDir::open(&base, &dir, true).unwrap();
        let (mut f, path) = pinned.create_new_file("a.jsonl").unwrap();
        f.write_all(b"{}\n").unwrap();
        drop(f);
        assert_eq!(std::fs::read(&path).unwrap(), b"{}\n");
        // CREATE_NEW: an existing name is never reused.
        let err = pinned.create_new_file("a.jsonl").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert!(pinned.create_new_file(r"..\x").is_err());
        // The pinned folder cannot be renamed away while held.
        assert!(std::fs::rename(&dir, base.join("Nexum").join("moved")).is_err());
        drop(pinned);
        std::fs::rename(&dir, base.join("Nexum").join("moved")).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn never_creates_or_writes_through_a_junction() {
        let base = scratch("junction");
        let outside = scratch("junction-target");
        assert!(junction(&base.join("Nexum"), &outside), "could not create junction");
        let dir = base.join("Nexum").join("purge-logs");
        assert!(PinnedDir::open(&base, &dir, true).is_err());
        // Nothing was created in the junction's target.
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
        // A junction at the last level is refused too.
        let base2 = scratch("junction2");
        std::fs::create_dir_all(base2.join("Nexum")).unwrap();
        assert!(junction(&base2.join("Nexum").join("purge-logs"), &outside));
        assert!(PinnedDir::open(&base2, &base2.join("Nexum").join("purge-logs"), true).is_err());
        // Outside the base is refused outright.
        assert!(PinnedDir::open(&base, &outside, true).is_err());
        for b in [&base, &base2] {
            let _ = std::fs::remove_dir(b.join("Nexum").join("purge-logs"));
            let _ = std::fs::remove_dir(b.join("Nexum"));
            let _ = std::fs::remove_dir_all(b);
        }
        let _ = std::fs::remove_dir_all(&outside);
    }
}
