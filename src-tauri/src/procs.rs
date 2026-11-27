//! Cheap process queries via Toolhelp32 and the process/token APIs (no `sysinfo`, no WMI):
//! the process list, a process's owner, CPU times and working set.
//!
//! Used by the cleaner (running-app check, CONTRACT §3 rule 8) and the self-usage readout
//! (CONTRACT §2.5). Everything fails soft.

use windows::Win32::Foundation::{BOOL, FILETIME, HANDLE};
use windows::Win32::Security::{GetLengthSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows::Win32::System::Threading::{
    GetActiveProcessorCount, GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken,
    ALL_PROCESSOR_GROUPS, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::util::OwnedHandle;

/// One row of a Toolhelp32 process snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    /// Executable file name as reported by the snapshot (e.g. `chrome.exe`).
    pub name: String,
}

/// All processes (empty on failure).
pub fn snapshot() -> Vec<ProcEntry> {
    let mut out = Vec::new();
    // SAFETY: plain snapshot call; the handle is closed by OwnedHandle.
    let snap = match unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        Ok(h) => OwnedHandle(h),
        Err(_) => return out,
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: `entry` is a correctly sized PROCESSENTRY32W; the snapshot handle is valid.
    let mut ok = unsafe { Process32FirstW(snap.0, &mut entry) }.is_ok();
    while ok {
        let len = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        out.push(ProcEntry {
            pid: entry.th32ProcessID,
            ppid: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&entry.szExeFile[..len]),
        });
        // SAFETY: same buffer and handle as above.
        ok = unsafe { Process32NextW(snap.0, &mut entry) }.is_ok();
    }
    out
}

fn open_limited(pid: u32) -> Option<OwnedHandle> {
    // SAFETY: OpenProcess with a query-only right; the handle is closed by OwnedHandle.
    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, BOOL(0), pid) }
        .ok()
        .map(OwnedHandle)
}

/// Raw bytes of the user SID in a process token.
fn token_user_sid(process: HANDLE) -> Option<Vec<u8>> {
    let mut token = HANDLE::default();
    // SAFETY: `process` is a valid process handle; `token` receives a new handle we close.
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
    let token = OwnedHandle(token);
    let mut needed: u32 = 0;
    // SAFETY: size query; fails with ERROR_INSUFFICIENT_BUFFER and sets `needed`.
    let _ = unsafe { GetTokenInformation(token.0, TokenUser, None, 0, &mut needed) };
    if needed == 0 || needed > 4096 {
        return None;
    }
    // u64 storage keeps the TOKEN_USER (which holds a pointer) properly aligned.
    let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: `buf` is at least `needed` bytes long and 8-byte aligned.
    unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
            (buf.len() * 8) as u32,
            &mut needed,
        )
    }
    .ok()?;
    // SAFETY: the buffer now holds a TOKEN_USER whose SID points into the same buffer.
    unsafe {
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        let sid = tu.User.Sid;
        if sid.0.is_null() {
            return None;
        }
        let len = GetLengthSid(sid) as usize;
        if len == 0 || len > 256 {
            return None;
        }
        Some(std::slice::from_raw_parts(sid.0 as *const u8, len).to_vec())
    }
}

/// SID of the user running this process.
pub fn current_user_sid() -> Option<Vec<u8>> {
    // SAFETY: GetCurrentProcess returns a pseudo handle that needs no closing.
    token_user_sid(unsafe { GetCurrentProcess() })
}

/// `Some(true)` when `pid` runs as the user `sid`, `Some(false)` when it runs as someone
/// else, `None` when that cannot be determined (no access, process gone).
pub fn runs_as(pid: u32, sid: &[u8]) -> Option<bool> {
    let h = open_limited(pid)?;
    token_user_sid(h.0).map(|s| s == sid)
}

fn filetime_u64(ft: &FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

/// CPU and memory counters of one process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcTimes {
    /// Creation time (FILETIME, 100 ns since 1601).
    pub creation: u64,
    /// Kernel + user time, 100 ns units.
    pub cpu: u64,
    /// Working set, bytes.
    pub working_set: u64,
}

/// CPU time and working set of `pid`, or `None` if the process cannot be opened.
pub fn process_times(pid: u32) -> Option<ProcTimes> {
    let h = open_limited(pid)?;
    let (mut c, mut e, mut k, mut u) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    // SAFETY: valid handle and four writable FILETIMEs.
    unsafe { GetProcessTimes(h.0, &mut c, &mut e, &mut k, &mut u) }.ok()?;
    let mut mem = PROCESS_MEMORY_COUNTERS {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };
    let cb = mem.cb;
    // SAFETY: valid handle; `mem` is a correctly sized PROCESS_MEMORY_COUNTERS.
    let ws = if unsafe { K32GetProcessMemoryInfo(h.0, &mut mem, cb) }.as_bool() {
        mem.WorkingSetSize as u64
    } else {
        0
    };
    Some(ProcTimes {
        creation: filetime_u64(&c),
        cpu: filetime_u64(&k).saturating_add(filetime_u64(&u)),
        working_set: ws,
    })
}

/// Logical processors across all processor groups (at least 1).
pub fn logical_processors() -> u32 {
    // SAFETY: no pointers involved.
    let n = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) };
    if n > 0 {
        n
    } else {
        std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1)
    }
}

/// Current time as a FILETIME value (100 ns since 1601-01-01).
pub fn now_filetime() -> u64 {
    const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000;
    let since_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() / 100)
        .unwrap_or(0) as u64;
    since_unix + EPOCH_DIFF_100NS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_contains_this_process() {
        let me = std::process::id();
        let procs = snapshot();
        assert!(procs.iter().any(|p| p.pid == me), "own pid missing from snapshot");
    }

    #[test]
    fn own_process_counters_are_readable() {
        let t = process_times(std::process::id()).expect("own process times");
        assert!(t.working_set > 0);
        assert!(t.creation > 0 && t.creation <= now_filetime());
        assert!(logical_processors() >= 1);
    }

    #[test]
    fn own_process_runs_as_current_user() {
        let sid = current_user_sid().expect("current user SID");
        assert_eq!(runs_as(std::process::id(), &sid), Some(true));
    }
}
