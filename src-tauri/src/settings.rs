//! User settings: JSON persistence under the app config dir, plus side effects
//! (Task Scheduler autostart, sidecar poll interval).

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::util::{hidden_command, lock, system32_exe};

pub const MIN_POLL_MS: u64 = 250;
pub const MAX_POLL_MS: u64 = 10_000;
/// Poll interval used while the window is hidden in the tray.
pub const TRAY_POLL_MS: u64 = 5_000;

const TASK_NAME: &str = "Nexum";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub launch_on_startup: bool,
    pub minimize_to_tray: bool,
    #[serde(deserialize_with = "de_ms")]
    pub poll_interval_ms: u64,
    pub include_browser_caches: bool,
    pub confirm_before_purge: bool,
    pub flush_standby_on_purge: bool,
    pub temp_unit: String,
    pub start_minimized: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            launch_on_startup: false,
            minimize_to_tray: true,
            poll_interval_ms: 1000,
            include_browser_caches: false,
            confirm_before_purge: true,
            flush_standby_on_purge: false,
            temp_unit: "C".to_string(),
            start_minimized: false,
        }
    }
}

impl Settings {
    /// Clamps/normalizes values coming from disk or the frontend.
    pub fn sanitized(mut self) -> Self {
        self.poll_interval_ms = clamp_poll(self.poll_interval_ms);
        self.temp_unit = if self.temp_unit.trim().eq_ignore_ascii_case("F") {
            "F".to_string()
        } else {
            "C".to_string()
        };
        self
    }
}

pub fn clamp_poll(ms: u64) -> u64 {
    ms.clamp(MIN_POLL_MS, MAX_POLL_MS)
}

/// Accepts integers, floats (`1000.0`) and numeric strings for the poll interval.
fn de_ms<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    let ms = match &v {
        serde_json::Value::Number(n) => n.as_u64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite() && *f >= 0.0)
                .map(|f| f.round() as u64)
        }),
        serde_json::Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .map(|f| f.max(0.0).round() as u64),
        _ => None,
    };
    Ok(ms.unwrap_or(1000))
}

/// Reads settings from disk (defaults when missing or unreadable).
pub fn load_from(path: &Path) -> Settings {
    match std::fs::read(path) {
        Ok(bytes) => {
            let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
            match serde_json::from_slice::<Settings>(bytes) {
                Ok(s) => s.sanitized(),
                Err(e) => {
                    eprintln!("[nexum] settings.json is invalid ({e}); using defaults");
                    // Keep the broken file for inspection instead of silently overwriting it.
                    let _ = std::fs::rename(path, path.with_extension("json.bad"));
                    Settings::default()
                }
            }
        }
        Err(_) => Settings::default(),
    }
}

/// Writes settings atomically (tmp file + rename).
pub fn write_to(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("Could not write settings: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not save settings: {e}")
    })
}

/// Resolves `<app_config_dir>/settings.json`.
pub fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

/// Loads settings into state during `setup`.
pub fn init(app: &AppHandle) -> Settings {
    let state = app.state::<AppState>();
    let path = settings_path(app);
    let settings = path.as_deref().map(load_from).unwrap_or_default();
    *lock(&state.settings_path) = path;
    *lock(&state.settings) = settings.clone();
    settings
}

/// Persists the current in-memory settings (best effort, used by `set_poll_interval`).
pub fn persist_current(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let path = lock(&state.settings_path).clone();
    let settings = lock(&state.settings).clone();
    match path {
        Some(p) => write_to(&p, &settings),
        None => Err("Settings location is unavailable".to_string()),
    }
}

/// Effective sidecar interval: the user's poll interval, throttled to >= 5 s while in the tray.
pub fn effective_poll_ms(app: &AppHandle) -> u64 {
    let state = app.state::<AppState>();
    let poll = clamp_poll(lock(&state.settings).poll_interval_ms);
    if state.in_tray.load(Ordering::SeqCst) {
        poll.max(TRAY_POLL_MS).min(MAX_POLL_MS)
    } else {
        poll
    }
}

// ---------------------------------------------------------------------------------------------
// Autostart (Task Scheduler, "Run with highest privileges" so no UAC prompt at logon)
// ---------------------------------------------------------------------------------------------

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn current_user_id() -> Option<String> {
    let user = std::env::var("USERNAME")
        .ok()
        .filter(|s| !s.trim().is_empty())?;
    match std::env::var("USERDOMAIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        Some(domain) => Some(format!("{domain}\\{user}")),
        None => Some(user),
    }
}

fn task_xml(exe: &Path) -> String {
    let user = current_user_id();
    let user_trigger = user
        .as_deref()
        .map(|u| format!("<UserId>{}</UserId>", xml_escape(u)))
        .unwrap_or_default();
    let user_principal = user_trigger.clone();
    let exe = xml_escape(&exe.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Nexum</Author>
    <Description>Starts Nexum minimized to the tray at logon.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      {user_trigger}
      <Delay>PT5S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      {user_principal}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>--minimized</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

fn run_schtasks(args: &[&str]) -> Result<String, String> {
    let out = hidden_command(system32_exe("schtasks.exe"))
        .args(args)
        .output()
        .map_err(|e| format!("Could not run schtasks: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .trim()
    .to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(if text.is_empty() {
            format!("schtasks failed ({})", out.status)
        } else {
            text
        })
    }
}

fn task_exists() -> bool {
    run_schtasks(&["/Query", "/TN", TASK_NAME]).is_ok()
}

/// Creates (or replaces) / deletes the logon task.
pub fn apply_autostart(enable: bool) -> Result<(), String> {
    if !enable {
        if !task_exists() {
            return Ok(());
        }
        return run_schtasks(&["/Delete", "/F", "/TN", TASK_NAME]).map(|_| ());
    }

    let exe = std::env::current_exe().map_err(|e| format!("Cannot resolve Nexum.exe path: {e}"))?;
    let exe = exe.canonicalize().map(strip_verbatim).unwrap_or(exe);
    if !is_in_program_files(&exe) {
        return Err(format!(
            "Launch on startup needs the installed copy of Nexum (Program Files). This copy runs from \
             {}, a folder other programs could modify, and the startup task runs with administrator rights.",
            exe.parent().map(|p| p.display().to_string()).unwrap_or_default()
        ));
    }

    // Preferred: XML definition (no 72h execution limit, runs on battery).
    //
    // The XML decides what runs with highest privileges at every logon, so it must not be
    // writable by non-elevated code between writing it and schtasks reading it. It therefore
    // goes to `<Windows>\Temp` (resolved via API, not %WINDIR%): files an elevated process
    // creates there are owned by Administrators and cannot be modified, deleted or renamed by
    // standard users. The name is unpredictable and `create_new` refuses pre-planted files/links.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let xml_path = crate::util::windows_dir()
        .join("Temp")
        .join(format!("nexum-task-{}-{nanos:x}.xml", std::process::id()));
    let mut created = false;
    let xml_result = (|| -> Result<(), String> {
        use std::io::Write;
        let xml = task_xml(&exe);
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE]; // UTF-16LE BOM
        for unit in xml.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&xml_path)
            .map_err(|e| e.to_string())?;
        created = true;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        let xml_arg = xml_path.to_string_lossy().to_string();
        run_schtasks(&["/Create", "/F", "/TN", TASK_NAME, "/XML", &xml_arg]).map(|_| ())
    })();
    if created {
        let _ = std::fs::remove_file(&xml_path);
    }

    match xml_result {
        Ok(()) => Ok(()),
        Err(xml_err) => {
            // Fallback: classic one-liner.
            let tr = format!("\"{}\" --minimized", exe.to_string_lossy());
            run_schtasks(&[
                "/Create", "/F", "/TN", TASK_NAME, "/SC", "ONLOGON", "/RL", "HIGHEST", "/TR", &tr,
            ])
            .map(|_| ())
            .map_err(|e| format!("Could not register startup task: {e} (XML attempt: {xml_err})"))
        }
    }
}

/// True when `exe` lives under `Program Files` / `Program Files (x86)` (admin-only writable),
/// resolved through the known-folder API rather than environment variables.
fn is_in_program_files(exe: &Path) -> bool {
    use windows::Win32::UI::Shell::{FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86};
    let exe_l = exe.to_string_lossy().to_lowercase();
    [&FOLDERID_ProgramFiles, &FOLDERID_ProgramFilesX86]
        .into_iter()
        .filter_map(crate::util::known_folder)
        .any(|pf| is_under_dir(&exe_l, &pf.to_string_lossy().to_lowercase()))
}

/// `path` and `dir` lower-cased, `\`-separated; true when `path` is strictly inside `dir`.
fn is_under_dir(path: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches('\\');
    !dir.is_empty()
        && path.len() > dir.len() + 1
        && path.starts_with(dir)
        && path.as_bytes()[dir.len()] == b'\\'
        && !path.split('\\').any(|c| c == "..")
}

fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// Re-registers the logon task at startup when enabled, so the task follows the current
/// executable path after an update/reinstall. Runs on a background thread.
pub fn refresh_autostart_in_background(app: &AppHandle) {
    let enabled = lock(&app.state::<AppState>().settings).launch_on_startup;
    if enabled {
        std::thread::spawn(|| {
            if let Err(e) = apply_autostart(true) {
                eprintln!("[nexum] autostart refresh failed: {e}");
            }
        });
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
    Ok(lock(&app.state::<AppState>().settings).clone())
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let worker = app.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || -> Result<Settings, String> {
        let app = worker;
        let state = app.state::<AppState>();
        let new = settings.sanitized();
        let old = lock(&state.settings).clone();

        if new.launch_on_startup != old.launch_on_startup {
            apply_autostart(new.launch_on_startup)?;
        }

        let path = lock(&state.settings_path).clone();
        if let Some(p) = path {
            if let Err(e) = write_to(&p, &new) {
                // Roll back the autostart side effect so state stays consistent.
                if new.launch_on_startup != old.launch_on_startup {
                    let _ = apply_autostart(old.launch_on_startup);
                }
                return Err(e);
            }
        }
        *lock(&state.settings) = new.clone();
        Ok(new)
    })
    .await
    .map_err(|e| format!("Settings worker failed: {e}"))??;

    crate::agent::apply_interval(&app);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_contract() {
        let s = Settings::default();
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["launchOnStartup"], false);
        assert_eq!(v["minimizeToTray"], true);
        assert_eq!(v["pollIntervalMs"], 1000);
        assert_eq!(v["includeBrowserCaches"], false);
        assert_eq!(v["confirmBeforePurge"], true);
        assert_eq!(v["flushStandbyOnPurge"], false);
        assert_eq!(v["tempUnit"], "C");
        assert_eq!(v["startMinimized"], false);
    }

    #[test]
    fn partial_and_odd_input_is_sanitized() {
        let s: Settings =
            serde_json::from_str(r#"{"pollIntervalMs": 50.4, "tempUnit": "f"}"#).unwrap();
        let s = s.sanitized();
        assert_eq!(s.poll_interval_ms, MIN_POLL_MS);
        assert_eq!(s.temp_unit, "F");
        assert!(s.minimize_to_tray);
        let s: Settings = serde_json::from_str(r#"{"pollIntervalMs": 999999}"#).unwrap();
        assert_eq!(s.sanitized().poll_interval_ms, MAX_POLL_MS);
    }

    #[test]
    fn program_files_check() {
        assert!(is_under_dir(
            r"c:\program files\nexum\nexum.exe",
            r"c:\program files"
        ));
        assert!(is_under_dir(
            r"c:\program files\nexum\nexum.exe",
            r"c:\program files\"
        ));
        assert!(!is_under_dir(
            r"c:\program files evil\nexum.exe",
            r"c:\program files"
        ));
        assert!(!is_under_dir(
            r"c:\program files\..\users\me\nexum.exe",
            r"c:\program files"
        ));
        assert!(!is_under_dir(r"c:\users\me\nexum.exe", r"c:\program files"));
        assert!(!is_under_dir(r"c:\program files", r"c:\program files"));
        assert!(!is_in_program_files(Path::new(
            r"C:\Users\me\Downloads\Nexum.exe"
        )));
    }

    #[test]
    fn xml_is_escaped() {
        let xml = task_xml(Path::new(r"C:\Apps & Tools\Nexum.exe"));
        assert!(xml.contains(r"C:\Apps &amp; Tools\Nexum.exe"));
        assert!(xml.contains("<Arguments>--minimized</Arguments>"));
    }
}
