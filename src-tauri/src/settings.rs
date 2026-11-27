//! User settings: JSON persistence under the app config dir, plus side effects
//! (Task Scheduler autostart, sidecar poll interval).

use std::collections::BTreeMap;
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

/// Re-match data stored with each user label (CONTRACT §2.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensorLabelMeta {
    pub default_name: String,
    pub hardware_name: String,
}

pub const MAX_LABEL_CHARS: usize = 64;
pub const MAX_LABELS: usize = 2000;
pub const MAX_HIDDEN: usize = 2000;
pub const MAX_PINNED: usize = 12;
pub const MAX_DISMISSED: usize = 200;
/// Sensor ids are LHM identifiers ("/lpc/it8688e/0/temperature/4"); anything longer is junk.
const MAX_ID_CHARS: usize = 512;
const MAX_META_CHARS: usize = 256;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub launch_on_startup: bool,
    pub minimize_to_tray: bool,
    #[serde(deserialize_with = "de_ms")]
    pub poll_interval_ms: u64,
    pub include_browser_caches: bool,
    pub confirm_before_purge: bool,
    // `flushStandbyOnPurge` (0.x) is gone: unknown fields in old files are ignored.
    pub temp_unit: String,
    pub start_minimized: bool,
    #[serde(deserialize_with = "de_labels")]
    pub sensor_labels: BTreeMap<String, String>,
    #[serde(deserialize_with = "de_label_meta")]
    pub sensor_label_meta: BTreeMap<String, SensorLabelMeta>,
    #[serde(deserialize_with = "de_string_list")]
    pub hidden_sensors: Vec<String>,
    #[serde(deserialize_with = "de_opt_string_list")]
    pub pinned_sensors: Option<Vec<String>>,
    pub hide_unused_sensors: bool,
    #[serde(deserialize_with = "de_string_list")]
    pub dismissed_alerts: Vec<String>,
    #[serde(deserialize_with = "de_choice")]
    pub sensor_driver_choice: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            launch_on_startup: false,
            minimize_to_tray: true,
            poll_interval_ms: 1000,
            include_browser_caches: false,
            confirm_before_purge: true,
            temp_unit: "C".to_string(),
            start_minimized: false,
            sensor_labels: BTreeMap::new(),
            sensor_label_meta: BTreeMap::new(),
            hidden_sensors: Vec::new(),
            pinned_sensors: None,
            hide_unused_sensors: true,
            dismissed_alerts: Vec::new(),
            sensor_driver_choice: "undecided".to_string(),
        }
    }
}

impl Settings {
    /// Clamps/normalizes values coming from disk or the frontend (CONTRACT §2.2).
    pub fn sanitized(mut self) -> Self {
        self.poll_interval_ms = clamp_poll(self.poll_interval_ms);
        self.temp_unit = if self.temp_unit.trim().eq_ignore_ascii_case("F") {
            "F".to_string()
        } else {
            "C".to_string()
        };

        // Labels: trimmed, non-empty, at most 64 characters, at most 2000 entries.
        let mut labels = BTreeMap::new();
        for (id, label) in std::mem::take(&mut self.sensor_labels) {
            let id = id.trim().to_string();
            let label = truncate_chars(label.trim(), MAX_LABEL_CHARS);
            if id.is_empty() || id.chars().count() > MAX_ID_CHARS || label.is_empty() {
                continue;
            }
            if labels.len() >= MAX_LABELS && !labels.contains_key(&id) {
                continue;
            }
            labels.insert(id, label);
        }
        self.sensor_labels = labels;

        // Meta only for labelled ids.
        let meta = std::mem::take(&mut self.sensor_label_meta);
        let mut kept = BTreeMap::new();
        for (id, m) in meta {
            let id = id.trim().to_string();
            if self.sensor_labels.contains_key(&id) {
                kept.insert(
                    id,
                    SensorLabelMeta {
                        default_name: truncate_chars(&m.default_name, MAX_META_CHARS),
                        hardware_name: truncate_chars(&m.hardware_name, MAX_META_CHARS),
                    },
                );
            }
        }
        self.sensor_label_meta = kept;

        self.hidden_sensors =
            dedupe_ids(std::mem::take(&mut self.hidden_sensors), MAX_HIDDEN, false);
        self.pinned_sensors = self
            .pinned_sensors
            .take()
            .map(|p| dedupe_ids(p, MAX_PINNED, false));
        self.dismissed_alerts =
            dedupe_ids(std::mem::take(&mut self.dismissed_alerts), MAX_DISMISSED, true);

        if !matches!(
            self.sensor_driver_choice.as_str(),
            "undecided" | "pawnio" | "none"
        ) {
            self.sensor_driver_choice = "undecided".to_string();
        }
        self
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Trims, drops empty/oversized entries and duplicates, then caps the list at `max` entries:
/// the first `max` (first occurrence wins), or the most recent `max` when `keep_last` (the
/// last occurrence of a duplicate counts as its position).
fn dedupe_ids(items: Vec<String>, max: usize, keep_last: bool) -> Vec<String> {
    let cleaned: Vec<String> = items
        .into_iter()
        .map(|i| i.trim().to_string())
        .filter(|t| !t.is_empty() && t.chars().count() <= MAX_ID_CHARS)
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    if keep_last {
        for t in cleaned.into_iter().rev() {
            if seen.insert(t.clone()) {
                out.push(t);
            }
        }
        out.truncate(max);
        out.reverse();
    } else {
        for t in cleaned {
            if seen.insert(t.clone()) {
                out.push(t);
            }
        }
        out.truncate(max);
    }
    out
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

/// `Record<string,string>`; non-string values and non-object input are dropped.
fn de_labels<'de, D: Deserializer<'de>>(d: D) -> Result<BTreeMap<String, String>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    let mut out = BTreeMap::new();
    if let serde_json::Value::Object(map) = v {
        for (k, v) in map {
            if let serde_json::Value::String(s) = v {
                out.insert(k, s);
            }
        }
    }
    Ok(out)
}

/// `Record<string,{defaultName,hardwareName}>`; malformed entries are dropped.
fn de_label_meta<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<BTreeMap<String, SensorLabelMeta>, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    let mut out = BTreeMap::new();
    if let serde_json::Value::Object(map) = v {
        for (k, v) in map {
            if let Ok(m) = serde_json::from_value::<SensorLabelMeta>(v) {
                out.insert(k, m);
            }
        }
    }
    Ok(out)
}

fn string_list(v: serde_json::Value) -> Option<Vec<String>> {
    match v {
        serde_json::Value::Array(items) => Some(
            items
                .into_iter()
                .filter_map(|i| match i {
                    serde_json::Value::String(s) => Some(s),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    }
}

/// `string[]`; anything else becomes `[]`.
fn de_string_list<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(string_list(serde_json::Value::deserialize(d)?).unwrap_or_default())
}

/// `string[] | null`; anything that is not an array becomes `null` (= default pin rule).
fn de_opt_string_list<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<String>>, D::Error> {
    Ok(string_list(serde_json::Value::deserialize(d)?))
}

/// `"undecided" | "pawnio" | "none"`; anything else becomes `"undecided"` (via `sanitized`).
fn de_choice<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::String(s) => s,
        _ => "undecided".to_string(),
    })
}

/// True when `p` exists and is a reparse point (junction, symbolic link, mount point).
fn is_reparse_point(p: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    std::fs::symlink_metadata(p)
        .map(|m| m.file_attributes() & 0x400 != 0)
        .unwrap_or(false)
}

/// Reads settings from disk (defaults when missing or unreadable). The settings folder is
/// writable by non-elevated code, so neither the file nor its folder may be a link: the
/// elevated app would otherwise read (and, for an invalid file, rename) whatever it points at.
pub fn load_from(path: &Path) -> Settings {
    if is_reparse_point(path) || path.parent().is_some_and(is_reparse_point) {
        eprintln!("[nexum] settings.json or its folder is a link; using defaults");
        return Settings::default();
    }
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
///
/// The settings folder (`%APPDATA%\<app id>`) is writable by non-elevated code, which could
/// plant a junction or an object-manager symbolic link there to redirect this elevated write.
/// The folder is therefore opened without following links and held (see
/// [`crate::safe_fs::PinnedDir`]), the temporary file is created new and verified, and the final
/// rename replaces the `settings.json` name itself (a rename never follows a link at the
/// destination).
pub fn write_to(path: &Path, settings: &Settings) -> Result<(), String> {
    use std::io::Write;
    let (dir, name) = match (path.parent(), path.file_name()) {
        (Some(d), Some(n)) => (d, n.to_string_lossy().to_string()),
        _ => return Err("Invalid settings path".to_string()),
    };
    let base = dir
        .parent()
        .ok_or_else(|| "Invalid settings path".to_string())?;
    std::fs::create_dir_all(base)
        .map_err(|e| format!("Could not create {}: {e}", base.display()))?;
    let pinned = crate::safe_fs::PinnedDir::open(base, dir, true)
        .map_err(|e| format!("Could not open {}: {e}", dir.display()))?;
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let tmp_name = format!("{name}.tmp");
    let tmp = pinned.path().join(&tmp_name);
    // A leftover from an interrupted save (or a planted link): removing a name never follows it.
    let _ = std::fs::remove_file(&tmp);
    let (mut file, tmp) = pinned
        .create_new_file(&tmp_name)
        .map_err(|e| format!("Could not write settings: {e}"))?;
    let written = file.write_all(&json).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Could not write settings: {e}"));
    }
    let result = std::fs::rename(&tmp, pinned.path().join(&name)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not save settings: {e}")
    });
    drop(pinned);
    result
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
        assert!(v.get("flushStandbyOnPurge").is_none());
        assert_eq!(v["tempUnit"], "C");
        assert_eq!(v["startMinimized"], false);
        assert_eq!(v["sensorLabels"], serde_json::json!({}));
        assert_eq!(v["sensorLabelMeta"], serde_json::json!({}));
        assert_eq!(v["hiddenSensors"], serde_json::json!([]));
        assert!(v["pinnedSensors"].is_null());
        assert_eq!(v["hideUnusedSensors"], true);
        assert_eq!(v["dismissedAlerts"], serde_json::json!([]));
        assert_eq!(v["sensorDriverChoice"], "undecided");
    }

    #[test]
    fn old_settings_files_migrate() {
        // A 0.x file: has flushStandbyOnPurge, lacks every new field.
        let old = r#"{"launchOnStartup":true,"minimizeToTray":false,"pollIntervalMs":2000,
            "includeBrowserCaches":true,"confirmBeforePurge":false,"flushStandbyOnPurge":true,
            "tempUnit":"F","startMinimized":true}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        let s = s.sanitized();
        assert!(s.launch_on_startup);
        assert!(!s.minimize_to_tray);
        assert_eq!(s.poll_interval_ms, 2000);
        assert_eq!(s.temp_unit, "F");
        assert!(s.sensor_labels.is_empty());
        assert_eq!(s.pinned_sensors, None);
        assert!(s.hide_unused_sensors);
        assert_eq!(s.sensor_driver_choice, "undecided");
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("flushStandbyOnPurge").is_none(), "removed field is not written back");
    }

    #[test]
    fn wrongly_typed_new_fields_do_not_reset_the_file() {
        let s: Settings = serde_json::from_str(
            r#"{"pollIntervalMs":500,"sensorLabels":["x"],"hiddenSensors":"a",
                "pinnedSensors":5,"dismissedAlerts":{"a":1},"sensorDriverChoice":7,
                "sensorLabelMeta":{"/a":{"defaultName":1}}}"#,
        )
        .unwrap();
        let s = s.sanitized();
        assert_eq!(s.poll_interval_ms, 500);
        assert!(s.sensor_labels.is_empty());
        assert!(s.hidden_sensors.is_empty());
        assert_eq!(s.pinned_sensors, None);
        assert!(s.dismissed_alerts.is_empty());
        assert_eq!(s.sensor_driver_choice, "undecided");
        assert!(s.sensor_label_meta.is_empty());
    }

    #[test]
    fn sensor_settings_are_sanitized() {
        let long = "x".repeat(100);
        let json = serde_json::json!({
            "sensorLabels": {
                "/lpc/it8688e/0/fan/1": "  CPU cooler  ",
                "/lpc/it8688e/0/fan/2": "   ",
                "": "nameless",
                "/lpc/it8688e/0/fan/3": long,
            },
            "sensorLabelMeta": {
                "/lpc/it8688e/0/fan/1": { "defaultName": "Fan #2", "hardwareName": "ITE IT8688E" },
                "/lpc/it8688e/0/fan/9": { "defaultName": "Fan #9", "hardwareName": "ITE IT8688E" },
            },
            "hiddenSensors": ["/a", " /a ", "", "/b"],
            "pinnedSensors": ["/1","/2","/3","/4","/5","/6","/7","/8","/9","/10","/11","/12","/13","/1"],
            "dismissedAlerts": ["k1", "k2", "k1"],
            "sensorDriverChoice": "pawnio",
            "hideUnusedSensors": false,
        });
        let s: Settings = serde_json::from_value(json).unwrap();
        let s = s.sanitized();
        assert_eq!(s.sensor_labels.len(), 2);
        assert_eq!(s.sensor_labels["/lpc/it8688e/0/fan/1"], "CPU cooler");
        assert_eq!(s.sensor_labels["/lpc/it8688e/0/fan/3"].chars().count(), MAX_LABEL_CHARS);
        assert_eq!(s.sensor_label_meta.len(), 1, "meta without a label is dropped");
        assert_eq!(s.hidden_sensors, vec!["/a", "/b"]);
        let pinned = s.pinned_sensors.clone().unwrap();
        assert_eq!(pinned.len(), MAX_PINNED);
        assert_eq!(pinned[0], "/1");
        assert_eq!(s.dismissed_alerts, vec!["k2", "k1"], "most recent occurrence wins");
        assert_eq!(s.sensor_driver_choice, "pawnio");
        assert!(!s.hide_unused_sensors);

        let mut many = Vec::new();
        for i in 0..250 {
            many.push(format!("alert-{i}"));
        }
        let s = Settings {
            dismissed_alerts: many,
            sensor_driver_choice: "bogus".into(),
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(s.dismissed_alerts.len(), MAX_DISMISSED);
        assert_eq!(s.dismissed_alerts[0], "alert-50");
        assert_eq!(s.dismissed_alerts[199], "alert-249");
        assert_eq!(s.sensor_driver_choice, "undecided");
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

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "nexum-test-settings-{tag}-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn junction(link: &Path, target: &Path) -> bool {
        hidden_command("cmd")
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
    fn settings_round_trip_and_overwrite() {
        let base = scratch("rt");
        let path = base.join("com.nexum.app").join("settings.json");
        let mut s = Settings::default();
        s.poll_interval_ms = 2000;
        write_to(&path, &s).unwrap();
        // Saving again replaces the file (and tolerates a stale temp file).
        std::fs::write(path.with_extension("json.tmp"), b"stale").unwrap();
        s.poll_interval_ms = 3000;
        write_to(&path, &s).unwrap();
        assert_eq!(load_from(&path).poll_interval_ms, 3000);
        assert!(!path.with_extension("json.tmp").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn settings_never_follow_a_planted_junction() {
        let base = scratch("junction");
        let target = scratch("junction-target");
        std::fs::write(target.join("settings.json"), br#"{"pollIntervalMs":4000}"#).unwrap();
        assert!(junction(&base.join("com.nexum.app"), &target));
        let path = base.join("com.nexum.app").join("settings.json");
        assert!(write_to(&path, &Settings::default()).is_err());
        // Neither written nor read (nor renamed to .bad) through the junction.
        assert_eq!(
            std::fs::read(target.join("settings.json")).unwrap(),
            br#"{"pollIntervalMs":4000}"#
        );
        assert!(!target.join("settings.json.tmp").exists());
        assert_eq!(load_from(&path).poll_interval_ms, Settings::default().poll_interval_ms);
        let _ = std::fs::remove_dir(base.join("com.nexum.app"));
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&target);
    }
}
