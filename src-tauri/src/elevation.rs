//! `restart_as_admin` (CONTRACT §2): relaunch Nexum elevated through the UAC prompt.
//!
//! The relaunched process gets `--relaunch-after=<pid>` and waits (in `run`, before the
//! single-instance plugin starts) for this process to exit; otherwise the single-instance
//! plugin would hand the new elevated launch back to the old, non-elevated instance.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOL, HWND};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};

use crate::state::AppState;
use crate::system_info::is_admin;
use crate::util::{to_wide, win32_code, OwnedHandle};

const RELAUNCH_ARG: &str = "--relaunch-after=";
/// How long a relaunched instance waits for the previous one to exit.
const RELAUNCH_WAIT_MS: u32 = 15_000;
const ERROR_CANCELLED: u32 = 1223;
const SW_SHOWNORMAL: i32 = 1;

/// Quotes one argument for a Windows command line (CommandLineToArgvW rules).
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{0B}', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

/// Command line for the elevated instance: the current arguments (minus an old relaunch
/// marker) plus `--relaunch-after=<pid>`.
pub fn relaunch_params(args: &[String], pid: u32) -> String {
    let mut parts: Vec<String> = args
        .iter()
        .filter(|a| !a.starts_with(RELAUNCH_ARG))
        .map(|a| quote_arg(a))
        .collect();
    parts.push(format!("{RELAUNCH_ARG}{pid}"));
    parts.join(" ")
}

/// The pid in `--relaunch-after=<pid>`, if present.
pub fn relaunch_pid<I: IntoIterator<Item = String>>(args: I) -> Option<u32> {
    args.into_iter()
        .find_map(|a| a.strip_prefix(RELAUNCH_ARG).and_then(|p| p.parse().ok()))
}

/// Called first thing in `run`: if this instance was started by `restart_as_admin`, wait for
/// the previous instance to exit (bounded).
pub fn wait_for_previous_instance() {
    let Some(pid) = relaunch_pid(std::env::args().skip(1)) else {
        return;
    };
    if pid == 0 || pid == std::process::id() {
        return;
    }
    // SAFETY: SYNCHRONIZE-only handle, closed by OwnedHandle; the wait is bounded.
    unsafe {
        if let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, BOOL(0), pid) {
            let h = OwnedHandle(h);
            let _ = WaitForSingleObject(h.0, RELAUNCH_WAIT_MS);
        }
    }
}

/// `ShellExecuteExW(verb "runas")` on a fresh STA thread (what the shell expects).
fn shell_runas(exe: std::path::PathBuf, params: String) -> Result<(), String> {
    let worker = std::thread::Builder::new()
        .name("nexum-runas".into())
        .spawn(move || -> Result<(), String> {
            // SAFETY: balanced CoInitializeEx/CoUninitialize; every pointer in `info` refers to
            // NUL-terminated buffers that outlive the call.
            unsafe {
                let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let verb = to_wide("runas");
                let file = to_wide(exe.as_os_str());
                let args = to_wide(&params);
                let mut info = SHELLEXECUTEINFOW {
                    cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                    fMask: SEE_MASK_NOASYNC,
                    hwnd: HWND::default(),
                    lpVerb: PCWSTR(verb.as_ptr()),
                    lpFile: PCWSTR(file.as_ptr()),
                    lpParameters: PCWSTR(args.as_ptr()),
                    nShow: SW_SHOWNORMAL,
                    ..Default::default()
                };
                let result = ShellExecuteExW(&mut info);
                if hr.is_ok() {
                    CoUninitialize();
                }
                result.map_err(|e| {
                    if win32_code(e.code().0) == Some(ERROR_CANCELLED) {
                        "Administrator rights were not granted.".to_string()
                    } else {
                        format!("Could not restart as administrator: {}", e.message())
                    }
                })
            }
        })
        .map_err(|e| format!("Could not restart as administrator: {e}"))?;
    worker
        .join()
        .map_err(|_| "Could not restart as administrator".to_string())?
}

#[tauri::command]
pub async fn restart_as_admin(app: AppHandle) -> Result<(), String> {
    if is_admin() {
        return Err("Nexum is already running as administrator.".to_string());
    }
    let exe = std::env::current_exe()
        .map_err(|e| format!("Could not locate Nexum.exe: {e}"))?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let params = relaunch_params(&args, std::process::id());
    tauri::async_runtime::spawn_blocking(move || shell_runas(exe, params))
        .await
        .map_err(|e| format!("Could not restart as administrator: {e}"))??;
    // The elevated instance is starting and waits for this one to exit.
    app.state::<AppState>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argument_quoting() {
        assert_eq!(quote_arg("--minimized"), "--minimized");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("a b"), "\"a b\"");
        assert_eq!(quote_arg(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_arg(r"C:\dir with space\"), r#""C:\dir with space\\""#);
    }

    #[test]
    fn relaunch_marker_round_trip() {
        let args = vec!["--minimized".to_string(), "--relaunch-after=7".to_string()];
        let p = relaunch_params(&args, 1234);
        assert_eq!(p, "--minimized --relaunch-after=1234");
        assert_eq!(
            relaunch_pid(vec!["x".to_string(), "--relaunch-after=1234".to_string()]),
            Some(1234)
        );
        assert_eq!(relaunch_pid(vec!["--relaunch-after=abc".to_string()]), None);
        assert_eq!(relaunch_pid(Vec::<String>::new()), None);
    }
}
